import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { isAbsolute } from "node:path";

import { PUBLICATION_MAX_BODY_BYTES } from "./coordination-publish.js";
import {
  acquireNativeRuntimeOwner,
  validateNativePersistentRuntimeDirectory,
} from "./native-interactive-lifecycle.js";
import { ConfigurationError } from "./provider-profile.js";

const CURSOR_OUTPUT_MAX_BYTES = 256 * 1024;
const CURSOR_PROMPT_MAX_BYTES = 1024 * 1024;
const CURSOR_IDENTIFIER_MAX_BYTES = 256;
const CURSOR_MODEL_MAX_BYTES = 256;
const CURSOR_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+,:=\[\]-]{0,255}$/;

const CURSOR_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

export interface CursorInstallation {
  binary: string;
  version: string;
}

export interface CursorSignedHubResult {
  exitCode: number;
  successful: boolean;
  output: string | null;
  sessionID: string | null;
  requestID: string | null;
  vendorDurationMs: number | null;
  failure:
    | "none"
    | "process_exit"
    | "output_too_large"
    | "malformed_result"
    | "vendor_error"
    | "stdin_error";
}

export interface LaunchCursorSignedHubOptions {
  beforeSpawn?: () => Promise<void>;
  runtimeDirectory?: string;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
): string | null {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return null;
  }
  return value;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may already have exited.
  }
}

export function resolveCursorBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_CURSOR_BIN?.trim() || "cursor-agent";
}

export function cursorModelID(env: NodeJS.ProcessEnv): string {
  const model = env.ORGANUM_CODE_CURSOR_MODEL?.trim();
  if (
    model === undefined ||
    !CURSOR_MODEL_PATTERN.test(model) ||
    Buffer.byteLength(model, "utf8") > CURSOR_MODEL_MAX_BYTES
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_CURSOR_MODEL must be an explicit bounded Cursor model selector",
    );
  }
  return model;
}

/**
 * Native subscription authority stays inside Cursor. The child receives the
 * exact environment allowlist accepted by the Cursor seam probe; API keys,
 * SCM credentials, Hub paths, and Organum signing material are not inherited.
 */
export function buildCursorChildEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of CURSOR_ENVIRONMENT_ALLOWLIST) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  if (!result.PATH?.trim() || !result.HOME?.trim()) {
    throw new ConfigurationError(
      "Cursor native subscription requires bounded PATH and HOME values",
    );
  }
  return result;
}

export function inspectCursor(env: NodeJS.ProcessEnv): CursorInstallation {
  const binary = resolveCursorBinary(env);
  const childEnvironment = buildCursorChildEnvironment(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: childEnvironment,
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Cursor binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Cursor version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: version.split(/\r?\n/, 1)[0] };
}

export function buildCursorSignedHubArgs(
  modelID: string,
  workspace: string,
): string[] {
  if (
    !CURSOR_MODEL_PATTERN.test(modelID) ||
    Buffer.byteLength(modelID, "utf8") > CURSOR_MODEL_MAX_BYTES
  ) {
    throw new ConfigurationError("Cursor model selector is invalid");
  }
  if (
    !isAbsolute(workspace) ||
    workspace.includes("\0") ||
    Buffer.byteLength(workspace, "utf8") > 4096
  ) {
    throw new ConfigurationError("Cursor workspace must be a bounded absolute path");
  }
  return [
    "--print",
    "--trust",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--model",
    modelID,
    "--workspace",
    workspace,
  ];
}

export function parseCursorSignedHubResult(
  bytes: Uint8Array,
  exitCode: number,
  outputTooLarge = false,
  stdinError = false,
): CursorSignedHubResult {
  const failed = (
    failure: CursorSignedHubResult["failure"],
  ): CursorSignedHubResult => ({
    exitCode,
    successful: false,
    output: null,
    sessionID: null,
    requestID: null,
    vendorDurationMs: null,
    failure,
  });
  if (stdinError) return failed("stdin_error");
  if (outputTooLarge) return failed("output_too_large");
  if (exitCode !== 0) return failed("process_exit");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return failed("malformed_result");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failed("malformed_result");
  }
  const record = value as Record<string, unknown>;
  if (
    record.type !== "result" ||
    record.subtype !== "success" ||
    record.is_error !== false
  ) {
    return failed("vendor_error");
  }
  const output = boundedString(record.result, PUBLICATION_MAX_BODY_BYTES);
  const sessionID = boundedString(
    record.session_id,
    CURSOR_IDENTIFIER_MAX_BYTES,
  );
  const requestID = record.request_id === undefined
    ? null
    : boundedString(record.request_id, CURSOR_IDENTIFIER_MAX_BYTES);
  const duration = record.duration_ms;
  if (
    output === null ||
    output.trim().length === 0 ||
    sessionID === null ||
    sessionID.trim().length === 0 ||
    (record.request_id !== undefined && requestID === null) ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    return failed("malformed_result");
  }
  return {
    exitCode,
    successful: true,
    output,
    sessionID,
    requestID,
    vendorDurationMs: duration,
    failure: "none",
  };
}

export async function launchCursorSignedHub(
  prompt: string,
  modelID: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: LaunchCursorSignedHubOptions = {},
): Promise<CursorSignedHubResult> {
  if (
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") > CURSOR_PROMPT_MAX_BYTES
  ) {
    throw new ConfigurationError(
      "Cursor Signed Hub prompt must be nonempty and at most 1 MiB",
    );
  }
  const childEnvironment = buildCursorChildEnvironment(env);
  const binary = resolveCursorBinary(env);
  const args = buildCursorSignedHubArgs(modelID, cwd);
  const runtime = options.runtimeDirectory === undefined
    ? null
    : await validateNativePersistentRuntimeDirectory(
        options.runtimeDirectory,
        cwd,
        "Cursor",
      );
  const owner = runtime === null
    ? null
    : await acquireNativeRuntimeOwner(runtime, "cursor");
  try {
    await options.beforeSpawn?.();
    return await new Promise<CursorSignedHubResult>((resolveRun, rejectRun) => {
      const child = spawn(binary, args, {
        cwd,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let outputTooLarge = false;
      let stdinError = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > CURSOR_OUTPUT_MAX_BYTES) {
          outputTooLarge = true;
          signalTree(child.pid, "SIGTERM");
          return;
        }
        stdout.push(chunk);
      });
      // Cursor failures can contain vendor or account details. The signed-Hub
      // surface deliberately retains no raw stderr and reports only a typed
      // failure class.
      child.stderr.resume();
      child.stdin.once("error", () => {
        stdinError = true;
      });
      child.stdin.end(prompt, "utf8");

      const forwardInterrupt = (): void => signalTree(child.pid, "SIGINT");
      const forwardTermination = (): void => signalTree(child.pid, "SIGTERM");
      const cleanup = (): void => {
        process.off("SIGINT", forwardInterrupt);
        process.off("SIGTERM", forwardTermination);
      };
      process.once("SIGINT", forwardInterrupt);
      process.once("SIGTERM", forwardTermination);
      child.once("error", (error) => {
        cleanup();
        rejectRun(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        resolveRun(
          parseCursorSignedHubResult(
            Buffer.concat(stdout),
            code ?? signalExitCode(signal),
            outputTooLarge,
            stdinError,
          ),
        );
      });
    });
  } finally {
    await owner?.close().catch(() => undefined);
  }
}
