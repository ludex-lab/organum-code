import { spawn } from "node:child_process";
import { close, read } from "node:fs";

import { BROKER_TOKEN_ENV } from "./inference-broker.js";
import {
  GROK_NATIVE_TOOL_CONSUME_CAPABILITY_FD,
  GROK_NATIVE_TOOL_CONSUME_PATH,
  GROK_NATIVE_TOOL_CONSUME_SCHEMA,
  GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV,
  GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV,
  GROK_NATIVE_TOOL_WRAPPER_TURN_ENV,
  grokNativeToolExecutionSchema,
} from "./grok-native-tool-supervisor.js";

const MAX_RESPONSE_BYTES = 131_072;
const MAX_CONSUME_CAPABILITY_BYTES = 128;
const CONSUME_CAPABILITY_PATTERN = /^occonsume-[0-9a-f]{64}$/;

export type GrokNativeToolWrapperFailureKind =
  | "binding_mismatch"
  | "capability_invalid"
  | "capability_unavailable"
  | "endpoint_invalid"
  | "environment_invalid"
  | "response_invalid"
  | "response_oversized"
  | "supervisor_status"
  | "transport_failed";

export interface GrokNativeToolWrapperExecution {
  exitCode: number;
  failureKind: GrokNativeToolWrapperFailureKind | null;
}

export interface GrokNativeToolWrapperOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetcher?: typeof fetch;
  spawnCommand?: typeof spawn;
  readConsumeCapability?: () => Promise<string>;
  timeoutMs?: number;
}

function fail(kind: GrokNativeToolWrapperFailureKind): never {
  throw new Error(`organum_grok_wrapper:${kind}`);
}

function endpointFromEnvironment(env: NodeJS.ProcessEnv): URL {
  const raw = env[GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV];
  if (raw === undefined) fail("environment_invalid");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    fail("endpoint_invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    endpoint.pathname !== GROK_NATIVE_TOOL_CONSUME_PATH ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    fail("endpoint_invalid");
  }
  return endpoint;
}

function boundedIdentity(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    fail("environment_invalid");
  }
  return value;
}

function readConsumeCapabilityFromFd(timeoutMs: number): Promise<string> {
  return new Promise((resolveCapability, rejectCapability) => {
    const buffer = Buffer.alloc(MAX_CONSUME_CAPABILITY_BYTES);
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error: Error | null, capability?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      buffer.fill(0);
      // The approved command must never inherit the consume channel.
      close(GROK_NATIVE_TOOL_CONSUME_CAPABILITY_FD, () => {
        if (error !== null) rejectCapability(error);
        else resolveCapability(capability ?? "");
      });
    };
    const readNext = (): void => {
      read(
        GROK_NATIVE_TOOL_CONSUME_CAPABILITY_FD,
        buffer,
        bytes,
        MAX_CONSUME_CAPABILITY_BYTES - bytes,
        null,
        (error, count) => {
          if (settled) return;
          if (error !== null || count === 0) {
            finish(new Error("consume_capability_unavailable"));
            return;
          }
          bytes += count;
          if (buffer[bytes - 1] === 0x0a) {
            finish(null, buffer.subarray(0, bytes - 1).toString("utf8"));
            return;
          }
          if (bytes >= MAX_CONSUME_CAPABILITY_BYTES) {
            finish(new Error("consume_capability_invalid"));
            return;
          }
          readNext();
        },
      );
    };
    timer = setTimeout(() => {
      finish(new Error("consume_capability_unavailable"));
    }, timeoutMs);
    readNext();
  });
}

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) fail("response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("response_oversized");
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    fail("response_invalid");
  }
}

function scrubbedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  delete result[BROKER_TOKEN_ENV];
  delete result[GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV];
  delete result[GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV];
  delete result[GROK_NATIVE_TOOL_WRAPPER_TURN_ENV];
  return result;
}

function failureKind(error: unknown): GrokNativeToolWrapperFailureKind {
  const match = /^organum_grok_wrapper:([a-z_]+)$/.exec(
    error instanceof Error ? error.message : "",
  );
  const value = match?.[1];
  return value === "binding_mismatch" ||
      value === "capability_invalid" ||
      value === "capability_unavailable" ||
      value === "endpoint_invalid" ||
      value === "environment_invalid" ||
      value === "response_invalid" ||
      value === "response_oversized" ||
      value === "supervisor_status" ||
      value === "transport_failed"
    ? value
    : "response_invalid";
}

export async function runGrokNativeToolWrapper(
  options: GrokNativeToolWrapperOptions = {},
): Promise<GrokNativeToolWrapperExecution> {
  const env = options.env ?? process.env;
  try {
    const endpoint = endpointFromEnvironment(env);
    const sessionId = boundedIdentity(
      env,
      GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV,
    );
    const turnId = boundedIdentity(env, GROK_NATIVE_TOOL_WRAPPER_TURN_ENV);
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
      fail("environment_invalid");
    }
    let consumeCapability: string;
    try {
      consumeCapability = await (
        options.readConsumeCapability ??
          (() => readConsumeCapabilityFromFd(timeoutMs))
      )();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "consume_capability_invalid"
      ) {
        fail("capability_invalid");
      }
      fail("capability_unavailable");
    }
    if (!CONSUME_CAPABILITY_PATTERN.test(consumeCapability)) {
      fail("capability_invalid");
    }
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: GROK_NATIVE_TOOL_CONSUME_SCHEMA,
          sessionId,
          turnId,
          consumeCapability,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      fail("transport_failed");
    }
    if (response.status !== 200) fail("supervisor_status");
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      fail("response_invalid");
    }
    let execution;
    try {
      execution = grokNativeToolExecutionSchema.parse(
        JSON.parse(await boundedText(response)),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("organum_grok_wrapper:")
      ) {
        throw error;
      }
      fail("response_invalid");
    }
    if (
      execution.sessionId !== sessionId ||
      execution.turnId !== turnId
    ) {
      fail("binding_mismatch");
    }
    const child = (options.spawnCommand ?? spawn)(
      process.platform === "win32"
        ? env.ComSpec ?? "cmd.exe"
        : "/bin/sh",
      process.platform === "win32"
        ? ["/d", "/s", "/c", execution.command]
        : ["-c", execution.command],
      {
        cwd: options.cwd ?? process.cwd(),
        env: scrubbedEnvironment(env),
        stdio: "inherit",
      },
    );
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => {
        if (code !== null) resolveExit(code);
        else resolveExit(signal === null ? 1 : 128);
      });
    });
    return { exitCode, failureKind: null };
  } catch (error) {
    const kind = failureKind(error);
    return { exitCode: 74, failureKind: kind };
  }
}
