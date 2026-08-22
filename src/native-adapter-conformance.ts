import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectClaudeCode,
} from "./claude-launcher.js";
import {
  inspectDeepCode,
  normalizeDeepCodeChatCompletionsRequest,
} from "./deepcode-launcher.js";
import {
  inspectGrokBuild,
  normalizeGrokChatCompletionsSseEvent,
} from "./grok-launcher.js";
import {
  InferenceBroker,
  brokerModeForProvider,
  buildBrokerLaunchEnvironment,
  createBrokeredProviderProfile,
  type JsonObject,
} from "./inference-broker.js";
import {
  createClaudeSoftwareBenchmarkDriver,
  createDeepCodeSoftwareBenchmarkDriver,
  createGrokSoftwareBenchmarkDriver,
} from "./native-benchmark-backend.js";
import {
  buildTerminalObservation,
  emitOrganumCodeObservation,
  type ObservationEmissionResult,
} from "./observation-emitter.js";
import { loadProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkAdapterEvidence,
  SoftwareBenchmarkCompletion,
} from "./software-benchmark.js";

export type NativeBenchmarkBackendID = "claude" | "grok" | "deepcode";

export interface NativeAdapterQualificationReceipt {
  schema: "organum-code/native-adapter-qualification/v1";
  gate: "pass" | "pass-with-warning";
  backend: NativeBenchmarkBackendID;
  binary: { command: string; version: string };
  providerCalls: 0;
  fakeUpstreamRequests: number;
  auxiliaryFakeRequests: number;
  brokerSettlement: {
    idle: true;
    activeRequests: 0;
    forcedAbortRequests: number;
  };
  promptVisibleToModelRequest: true;
  shellTool: string;
  toolResultObserved: true;
  workspaceMutationObserved: true;
  cleanExit: true;
  adapterEvidence: SoftwareBenchmarkAdapterEvidence;
  adapterViolations: readonly [];
  adapterWarnings: readonly string[];
  observation?: {
    runID: string;
    nativeSessionID: string | null;
    emission: ObservationEmissionResult;
  };
}

export interface QualifyNativeAdapterOptions {
  backend: NativeBenchmarkBackendID;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  observation?: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  };
}

const PROMPT = [
  "Deterministic Organum Code adapter qualification.",
  "Use the shell tool exactly once to create adapter-canary.txt containing adapter-canary-ok followed by a newline.",
  "Then stop. Preserve this canary text byte-for-byte: apostrophe ' and Markdown `backtick` and 한국어.",
].join("\n");
const CANARY_FILE = "adapter-canary.txt";
const CANARY_CONTENT = "adapter-canary-ok\n";
const DUMMY_UPSTREAM_KEY = "qualification-upstream-key-never-exposed";
const CLAUDE_ADVERTISED_MODEL = "claude-sonnet-4-5";

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const part = record(item);
    return typeof part?.text === "string" ? part.text : "";
  }).join("");
}

function promptInMessages(body: JsonObject): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((item) => {
    const message = record(item);
    return message?.role === "user" && messageText(message.content).includes(PROMPT);
  });
}

function hasToolResult(body: JsonObject): boolean {
  return Array.isArray(body.messages) && body.messages.some((item) => {
    const message = record(item);
    return message?.role === "tool";
  });
}

function shellTool(body: JsonObject): { name: string; argument: string } | null {
  if (!Array.isArray(body.tools)) return null;
  const tools = body.tools.flatMap((item) => {
    const tool = record(item);
    const fn = record(tool?.function);
    return fn === null || typeof fn.name !== "string"
      ? []
      : [{ name: fn.name, parameters: record(fn.parameters) }];
  });
  const tool = tools.find((candidate) => /(?:bash|shell|command)/i.test(candidate.name));
  if (tool === undefined) return null;
  const properties = record(tool.parameters?.properties);
  const argument = ["command", "cmd", "script"].find(
    (candidate) => properties !== null && candidate in properties,
  );
  if (argument === undefined) {
    throw new Error(`shell tool ${tool.name} has no admitted command argument`);
  }
  return { name: tool.name, argument };
}

function usage(): JsonObject {
  return { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
}

function streamResponse(
  model: string,
  message: JsonObject,
  finishReason: "tool_calls" | "stop",
): Response {
  const first = {
    id: `qualification-${finishReason}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: message, finish_reason: null }],
  };
  const last = {
    id: `qualification-${finishReason}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usage(),
  };
  return new Response(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function jsonResponse(
  model: string,
  message: JsonObject,
  finishReason: "tool_calls" | "stop",
): Response {
  return new Response(JSON.stringify({
    id: `qualification-${finishReason}`,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeResponse(
  body: JsonObject,
  message: JsonObject,
  finishReason: "tool_calls" | "stop",
): Response {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  return body.stream === true
    ? streamResponse(model, message, finishReason)
    : jsonResponse(model, message, finishReason);
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `qualification git ${args[0] ?? "command"} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

async function waitWithDeadline(
  wait: Promise<SoftwareBenchmarkCompletion>,
  cancel: () => Promise<void>,
  timeoutMs: number,
): Promise<SoftwareBenchmarkCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      wait,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native adapter qualification timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function qualifyNativeBenchmarkAdapter(
  options: QualifyNativeAdapterOptions,
): Promise<NativeAdapterQualificationReceipt> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const installation = options.backend === "claude"
    ? inspectClaudeCode(env)
    : options.backend === "grok"
      ? inspectGrokBuild(env)
      : inspectDeepCode(env);
  const workspace = await mkdtemp(join(tmpdir(), "organum-code-adapter-qualification-"));
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "adapter qualification fixture\n", "utf8");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "--all"]);
  git(workspace, [
    "-c",
    "user.name=Organum Code Qualification",
    "-c",
    "user.email=qualification@invalid",
    "commit",
    "--quiet",
    "-m",
    "qualification baseline",
  ]);

  let promptVisible = false;
  let observedToolName = "";
  let toolResultObserved = false;
  let fakeUpstreamRequests = 0;
  let auxiliaryFakeRequests = 0;
  const fakeFailures: string[] = [];
  const upstreamProfile = loadProviderProfile({
    ORGANUM_CODE_PROVIDER_ID: "qualification",
    ORGANUM_CODE_PROVIDER_NAME: "Qualification fake upstream",
    ORGANUM_CODE_BASE_URL: "https://qualification.invalid/v1",
    ORGANUM_CODE_MODEL: "solar-open2",
    ORGANUM_CODE_MODEL_NAME: "Solar Open 2 qualification alias",
    ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_QUALIFICATION_KEY",
    ORGANUM_CODE_PROTOCOL: "chat-completions",
  }, { requireApiKey: false });
  const broker = new InferenceBroker({
    upstreamBaseURL: upstreamProfile.baseURL,
    upstreamApiKey: DUMMY_UPSTREAM_KEY,
    upstreamModel: upstreamProfile.modelID,
    mode: options.backend === "claude"
      ? "messages-to-chat-completions"
      : brokerModeForProvider(upstreamProfile),
    advertisedModel:
      options.backend === "claude" ? CLAUDE_ADVERTISED_MODEL : undefined,
    requestTransform:
      options.backend === "deepcode"
        ? normalizeDeepCodeChatCompletionsRequest
        : undefined,
    sseTransform:
      options.backend === "grok"
        ? normalizeGrokChatCompletionsSseEvent
        : undefined,
    fetch: async (_url, init) => {
      fakeUpstreamRequests += 1;
      try {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${DUMMY_UPSTREAM_KEY}`);
        const body = JSON.parse(String(init?.body)) as JsonObject;
        assert.equal(body.model, "solar-open2");
        promptVisible ||= promptInMessages(body);
        if (hasToolResult(body)) {
          toolResultObserved = true;
          return fakeResponse(
            body,
            { role: "assistant", content: "adapter qualification complete" },
            "stop",
          );
        }
        if (!promptInMessages(body)) {
          auxiliaryFakeRequests += 1;
          return fakeResponse(
            body,
            { role: "assistant", content: "qualification preflight acknowledged" },
            "stop",
          );
        }
        if (toolResultObserved) {
          auxiliaryFakeRequests += 1;
          return fakeResponse(
            body,
            { role: "assistant", content: "qualification auxiliary request complete" },
            "stop",
          );
        }
        const selectedTool = shellTool(body);
        if (selectedTool === null) {
          auxiliaryFakeRequests += 1;
          return fakeResponse(
            body,
            { role: "assistant", content: "qualification auxiliary request complete" },
            "stop",
          );
        }
        observedToolName = selectedTool.name;
        return fakeResponse(
          body,
          {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_adapter_qualification",
              type: "function",
              function: {
                name: selectedTool.name,
                arguments: JSON.stringify({
                  [selectedTool.argument]: `printf 'adapter-canary-ok\\n' > ${CANARY_FILE}`,
                  description: "Create the deterministic adapter qualification canary",
                }),
              },
            }],
          },
          "tool_calls",
        );
      } catch (error) {
        fakeFailures.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });

  try {
    const session = await broker.start();
    const brokeredProfile = createBrokeredProviderProfile(upstreamProfile, session);
    const launchEnvironment = buildBrokerLaunchEnvironment(
      env,
      upstreamProfile.apiKeyEnv,
      session,
    );
    const driver = options.backend === "claude"
      ? createClaudeSoftwareBenchmarkDriver({
          profile: brokeredProfile,
          env: launchEnvironment,
          session,
          advertisedModel: CLAUDE_ADVERTISED_MODEL,
          usageSnapshot: () => broker.snapshot(),
          captureActorDiagnostic: true,
          diagnosticRedactions: [session.token, DUMMY_UPSTREAM_KEY],
        })
      : options.backend === "grok"
        ? createGrokSoftwareBenchmarkDriver({
            profile: brokeredProfile,
            env: launchEnvironment,
            usageSnapshot: () => broker.snapshot(),
            captureActorDiagnostic: true,
            diagnosticRedactions: [session.token, DUMMY_UPSTREAM_KEY],
          })
        : createDeepCodeSoftwareBenchmarkDriver({
            profile: brokeredProfile,
            env: launchEnvironment,
            usageSnapshot: () => broker.snapshot(),
            captureActorDiagnostic: true,
            diagnosticRedactions: [session.token, DUMMY_UPSTREAM_KEY],
          });
    const brain: BenchmarkBrainIdentity = {
      provider: upstreamProfile.providerID,
      model: upstreamProfile.modelID,
      protocol: upstreamProfile.protocol,
      reasoningEffort: null,
    };
    const startedAt = new Date().toISOString();
    const execution = await driver.start({
      taskID: "qualification/native-adapter",
      workspace,
      prompt: PROMPT,
      sessionLabel: "native-adapter-qualification",
    }, brain);
    let completion: SoftwareBenchmarkCompletion;
    try {
      completion = await waitWithDeadline(
        execution.wait(),
        () => execution.cancel("timeout"),
        timeoutMs,
      );
    } catch (error) {
      const diagnostic = driver.actorDiagnostic();
      const detail = diagnostic === null
        ? ""
        : ` stdout=${JSON.stringify(diagnostic.stdout.text.slice(-2_048))} stderr=${JSON.stringify(diagnostic.stderr.text.slice(-2_048))}`;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; fake_requests=${fakeUpstreamRequests}; prompt_visible=${promptVisible}; shell_tool=${observedToolName || "none"}; tool_result=${toolResultObserved}.${detail}`,
        { cause: error },
      );
    }
    const finishedAt = new Date().toISOString();
    const canary = await readFile(join(workspace, CANARY_FILE), "utf8");
    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    const snapshot = settlement.snapshot;
    assert.equal(promptVisible, true, "official prompt was not visible in a model request");
    if (observedToolName.length === 0) throw new Error("no shell tool was selected");
    assert.equal(toolResultObserved, true, "tool result did not return to the model loop");
    assert.equal(canary, CANARY_CONTENT, "shell tool did not create the exact canary");
    assert.equal(completion.cleanExit, true, "qualified adapter did not exit cleanly");
    assert.deepEqual(
      completion.adapterViolations,
      [],
      JSON.stringify({ snapshot, fakeFailures, actor: driver.actorDiagnostic() }),
    );
    assert.equal(settlement.idle, true);
    assert.equal(snapshot.activeRequests, 0);
    let observation:
      | NonNullable<NativeAdapterQualificationReceipt["observation"]>
      | undefined;
    if (options.observation !== undefined) {
      const record = buildTerminalObservation({
        backend: options.backend,
        backendVersion: installation.version,
        backendProtocol:
          options.backend === "claude"
            ? "anthropic-messages"
            : "native-tui",
        nativeSessionId: completion.nativeSessionId ?? null,
        profile: upstreamProfile,
        exitCode: completion.exitCode,
        failed: !completion.cleanExit,
        startedAt,
        finishedAt,
        settlement,
      });
      observation = {
        runID: record.run.id,
        nativeSessionID: completion.nativeSessionId ?? null,
        emission: await emitOrganumCodeObservation(record, {
          cwd: options.observation.cwd,
          env: options.observation.env ?? env,
        }),
      };
    }
    return {
      schema: "organum-code/native-adapter-qualification/v1",
      gate: completion.adapterWarnings.length === 0 ? "pass" : "pass-with-warning",
      backend: options.backend,
      binary: { command: installation.binary, version: installation.version },
      providerCalls: 0,
      fakeUpstreamRequests,
      auxiliaryFakeRequests,
      brokerSettlement: {
        idle: true,
        activeRequests: 0,
        forcedAbortRequests: settlement.forcedAbortRequests,
      },
      promptVisibleToModelRequest: true,
      shellTool: observedToolName,
      toolResultObserved: true,
      workspaceMutationObserved: true,
      cleanExit: true,
      adapterEvidence: execution.adapterEvidence,
      adapterViolations: [],
      adapterWarnings: completion.adapterWarnings,
      ...(observation === undefined ? {} : { observation }),
    };
  } finally {
    await broker.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}
