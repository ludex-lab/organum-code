import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeDeepCodeChatCompletionsRequest,
} from "./deepcode-launcher.js";
import {
  normalizeGrokChatCompletionsSseEvent,
} from "./grok-launcher.js";
import {
  InferenceBroker,
  brokerModeForProvider,
  buildBrokerLaunchEnvironment,
  createBrokeredProviderProfile,
  type JsonObject,
} from "./inference-broker.js";
import type { NativeBenchmarkBackendID } from "./native-adapter-conformance.js";
import {
  createNativeAdapterFixtureDriver,
  inspectNativeAdapter,
  NATIVE_CLAUDE_ADVERTISED_MODEL,
} from "./native-adapter-fixture.js";
import { loadProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkExecution,
} from "./software-benchmark.js";

const PROMPT = [
  "Deterministic Organum Code S7 cancellation qualification.",
  "Do not use tools or modify the workspace.",
  "Wait for the provider response until the supervisor interrupts this turn.",
].join("\n");
const LATE_CANARY_FILE = "s7-late-tool-canary.txt";
const DUMMY_UPSTREAM_KEY = "lifecycle-upstream-key-never-exposed";
const ACTOR_CLOSE_BOUND_MS = 5_000;
const MAIN_REQUEST_TIMEOUT_MS = 60_000;

export interface NativeAdapterLifecycleReceipt {
  schema: "organum-code/native-adapter-lifecycle/v1";
  gate: "pass";
  backend: NativeBenchmarkBackendID;
  binary: { command: string; version: string };
  providerCalls: 0;
  fakeUpstreamRequests: number;
  auxiliaryFakeRequests: number;
  cancellation: {
    interruptIssued: true;
    actorClosed: true;
    actorCloseBoundMs: 5_000;
    actorCloseLatencyMs: number;
    terminalReason: "aborted";
    terminalSource: "benchmark-supervisor";
    providerTransportAborted: true;
    openProviderStreamsAtInterrupt: number;
    providerAbortsAfterInterrupt: number;
    brokerCancelledRequests: number;
  };
  lateAdmission: {
    attemptedKind: "tool-call";
    upstreamWriteAttempted: true;
    upstreamWriteRejected: true;
    postCancelUpstreamRequests: 0;
    workspaceCanaryCreated: false;
  };
  brokerSettlement: {
    idle: true;
    activeRequests: 0;
    forcedAbortRequests: 0;
  };
}

export interface QualifyNativeAdapterLifecycleOptions {
  backend: NativeBenchmarkBackendID;
  env?: NodeJS.ProcessEnv;
}

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
  return argument === undefined ? null : { name: tool.name, argument };
}

function usage(): JsonObject {
  return { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
}

function completedResponse(body: JsonObject): Response {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  const first = {
    id: "lifecycle-auxiliary",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "S7 auxiliary request complete" },
      finish_reason: null,
    }],
  };
  const last = {
    id: "lifecycle-auxiliary",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: usage(),
  };
  if (body.stream === true) {
    return new Response(
      `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(JSON.stringify({
    id: "lifecycle-auxiliary",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "S7 auxiliary request complete" },
      finish_reason: "stop",
    }],
    usage: usage(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function lateToolPayload(
  body: JsonObject,
  tool: { name: string; argument: string },
): Uint8Array {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  const command = `printf 'late-admission-violation\\n' > ${LATE_CANARY_FILE}`;
  const first = {
    id: "lifecycle-late-tool",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call_lifecycle_late_tool",
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify({
              [tool.argument]: command,
              description: "This late tool call must never be admitted",
            }),
          },
        }],
      },
      finish_reason: null,
    }],
  };
  const last = {
    id: "lifecycle-late-tool",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: usage(),
  };
  return new TextEncoder().encode(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
  );
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `lifecycle qualification git ${args[0] ?? "command"} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

async function waitForMainRequest(
  started: Promise<void>,
  completion: Promise<unknown>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      completion.then(() => {
        throw new Error("native adapter exited before opening the S7 provider request");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `native adapter did not open the S7 provider request within ${MAIN_REQUEST_TIMEOUT_MS}ms`,
            ),
          ),
          MAIN_REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function qualifyNativeAdapterLifecycle(
  options: QualifyNativeAdapterLifecycleOptions,
): Promise<NativeAdapterLifecycleReceipt> {
  const env = options.env ?? process.env;
  const installation = inspectNativeAdapter(options.backend, env);
  const workspace = await mkdtemp(join(tmpdir(), "organum-code-lifecycle-"));
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "S7 lifecycle fixture\n", "utf8");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "--all"]);
  git(workspace, [
    "-c",
    "user.name=Organum Code Lifecycle",
    "-c",
    "user.email=lifecycle@invalid",
    "commit",
    "--quiet",
    "-m",
    "lifecycle baseline",
  ]);

  const upstreamProfile = loadProviderProfile({
    ORGANUM_CODE_PROVIDER_ID: "lifecycle",
    ORGANUM_CODE_PROVIDER_NAME: "Lifecycle fake upstream",
    ORGANUM_CODE_BASE_URL: "https://lifecycle.invalid/v1",
    ORGANUM_CODE_MODEL: "solar-open2",
    ORGANUM_CODE_MODEL_NAME: "Solar Open 2 lifecycle alias",
    ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_LIFECYCLE_KEY",
    ORGANUM_CODE_PROTOCOL: "chat-completions",
  }, { requireApiKey: false });
  let fakeUpstreamRequests = 0;
  let auxiliaryFakeRequests = 0;
  let postCancelUpstreamRequests = 0;
  let interruptIssued = false;
  let providerAbortObserved = false;
  let openProviderStreams = 0;
  let openProviderStreamsAtInterrupt = 0;
  let providerAbortsAfterInterrupt = 0;
  let lateWriteAttempted = false;
  let lateWriteRejected = false;
  let resolveMainRequest!: () => void;
  const mainRequestStarted = new Promise<void>((resolve) => {
    resolveMainRequest = resolve;
  });
  const broker = new InferenceBroker({
    upstreamBaseURL: upstreamProfile.baseURL,
    upstreamApiKey: DUMMY_UPSTREAM_KEY,
    upstreamModel: upstreamProfile.modelID,
    mode: options.backend === "claude"
      ? "messages-to-chat-completions"
      : brokerModeForProvider(upstreamProfile),
    advertisedModel:
      options.backend === "claude"
        ? NATIVE_CLAUDE_ADVERTISED_MODEL
        : undefined,
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
      if (interruptIssued) postCancelUpstreamRequests += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${DUMMY_UPSTREAM_KEY}`);
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.model, "solar-open2");
      if (!promptInMessages(body)) {
        auxiliaryFakeRequests += 1;
        return completedResponse(body);
      }

      assert.equal(body.stream, true, "S7 qualification requires an open provider stream");
      const tool = shellTool(body);
      assert.ok(tool, "S7 qualification could not identify the backend shell tool");
      const signal = init?.signal;
      assert.ok(signal, "S7 qualification requires a provider AbortSignal");
      const payload = lateToolPayload(body, tool);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          openProviderStreams += 1;
          signal.addEventListener("abort", () => {
            openProviderStreams = Math.max(0, openProviderStreams - 1);
            controller.error(
              signal.reason ?? new Error("S7 provider transport aborted"),
            );
            if (!interruptIssued) return;
            providerAbortObserved = true;
            providerAbortsAfterInterrupt += 1;
            lateWriteAttempted = true;
            try {
              controller.enqueue(payload);
            } catch {
              lateWriteRejected = true;
            }
          }, { once: true });
        },
      });
      resolveMainRequest();
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  let execution: SoftwareBenchmarkExecution | null = null;
  let cancellationCompleted = false;
  try {
    const session = await broker.start();
    const brokeredProfile = createBrokeredProviderProfile(upstreamProfile, session);
    const launchEnvironment = buildBrokerLaunchEnvironment(
      env,
      upstreamProfile.apiKeyEnv,
      session,
    );
    const driver = createNativeAdapterFixtureDriver({
      backend: options.backend,
      profile: brokeredProfile,
      env: launchEnvironment,
      session,
      usageSnapshot: () => broker.snapshot(),
      diagnosticRedactions: [session.token, DUMMY_UPSTREAM_KEY],
    });
    const brain: BenchmarkBrainIdentity = {
      provider: upstreamProfile.providerID,
      model: upstreamProfile.modelID,
      protocol: upstreamProfile.protocol,
      reasoningEffort: null,
    };
    execution = await driver.start({
      taskID: "qualification/native-lifecycle",
      workspace,
      prompt: PROMPT,
      sessionLabel: "native-lifecycle-qualification",
    }, brain);
    const completionPromise = execution.wait();
    await waitForMainRequest(mainRequestStarted, completionPromise);

    openProviderStreamsAtInterrupt = openProviderStreams;
    interruptIssued = true;
    const cancelStartedAt = Date.now();
    await execution.cancel("abort");
    const actorCloseLatencyMs = Date.now() - cancelStartedAt;
    const completion = await completionPromise;
    cancellationCompleted = true;
    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    const snapshot = settlement.snapshot;
    const workspaceCanaryCreated = await fileExists(
      join(workspace, LATE_CANARY_FILE),
    );

    assert.ok(
      actorCloseLatencyMs <= ACTOR_CLOSE_BOUND_MS,
      `native actor took ${actorCloseLatencyMs}ms to close after interrupt`,
    );
    assert.equal(completion.cleanExit, false);
    assert.equal(completion.terminalOutcome.reason, "aborted");
    assert.equal(completion.terminalOutcome.source, "benchmark-supervisor");
    assert.ok(openProviderStreamsAtInterrupt >= 1);
    assert.equal(providerAbortObserved, true);
    assert.ok(providerAbortsAfterInterrupt >= 1);
    assert.equal(openProviderStreams, 0);
    assert.equal(lateWriteAttempted, true);
    assert.equal(lateWriteRejected, true);
    assert.equal(postCancelUpstreamRequests, 0);
    assert.equal(workspaceCanaryCreated, false);
    assert.deepEqual(completion.containmentViolations, []);
    assert.equal(settlement.idle, true);
    assert.equal(snapshot.activeRequests, 0);
    assert.equal(settlement.forcedAbortRequests, 0);
    assert.ok(snapshot.cancelledRequests >= 1);

    return {
      schema: "organum-code/native-adapter-lifecycle/v1",
      gate: "pass",
      backend: options.backend,
      binary: {
        command: installation.binary,
        version: installation.version,
      },
      providerCalls: 0,
      fakeUpstreamRequests,
      auxiliaryFakeRequests,
      cancellation: {
        interruptIssued: true,
        actorClosed: true,
        actorCloseBoundMs: 5_000,
        actorCloseLatencyMs,
        terminalReason: "aborted",
        terminalSource: "benchmark-supervisor",
        providerTransportAborted: true,
        openProviderStreamsAtInterrupt,
        providerAbortsAfterInterrupt,
        brokerCancelledRequests: snapshot.cancelledRequests,
      },
      lateAdmission: {
        attemptedKind: "tool-call",
        upstreamWriteAttempted: true,
        upstreamWriteRejected: true,
        postCancelUpstreamRequests: 0,
        workspaceCanaryCreated: false,
      },
      brokerSettlement: {
        idle: true,
        activeRequests: 0,
        forcedAbortRequests: 0,
      },
    };
  } finally {
    if (execution !== null && !cancellationCompleted) {
      await execution.cancel("backend-error").catch(() => undefined);
    }
    await broker.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}
