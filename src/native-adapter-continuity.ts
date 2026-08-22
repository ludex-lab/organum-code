import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { actorWorkspaceFingerprint } from "./actor-runtime.js";
import {
  FileCoordinationContinuityStore,
  type CoordinationContinuityBinding,
} from "./coordination-continuity.js";
import {
  buildCoordinationContextDocument,
  buildPersistedCoordinationSystemPacket,
  type CoordinationContextDocument,
} from "./coordination-context.js";
import type { SessionCoordinationState } from "./coordination-bootstrap.js";
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
import { deriveNativeCellIdentity } from "./organum-identity.js";
import { loadProviderProfile, type ProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkCompletion,
  SoftwareBenchmarkExecution,
} from "./software-benchmark.js";

const FIRST_STAGE_MARKER = "ORGANUM_S8_INTERRUPTED_STAGE";
const RESUMED_STAGE_MARKER = "ORGANUM_S8_RESUMED_AFTER_COMPACTION";
const GOAL_FILE = "20260725-chief-to-field-s8-goal.md";
const GOAL_THREAD = "s8-continuity";
const GOAL_BODY =
  "Preserve this exact canonical goal across resume, interruption, and compaction.";
const OBLIGATION_TURN = "s8-substantive-turn-before-interrupt";
const DUMMY_UPSTREAM_KEY = "continuity-upstream-key-never-exposed";
const HOST_SECRET = "continuity-host-secret-never-persisted";
const REQUEST_TIMEOUT_MS = 60_000;
const ACTOR_CLOSE_BOUND_MS = 5_000;

export interface NativeAdapterContinuityReceipt {
  schema: "organum-code/native-adapter-continuity/v1";
  gate: "pass";
  backend: NativeBenchmarkBackendID;
  binary: { command: string; version: string };
  providerCalls: 0;
  fakeUpstreamRequests: number;
  auxiliaryFakeRequests: number;
  checkpoint: {
    schema: "organum-code/coordination-continuity/v1";
    revision: 1;
    private: true;
    workspaceDisjoint: true;
    credentialMaterialPersisted: false;
    contextSha256: string;
  };
  root: {
    stable: true;
    identity: string;
    backendProcesses: 2;
  };
  currentGoal: {
    status: "canonical";
    file: typeof GOAL_FILE;
    thread: typeof GOAL_THREAD;
    bodySha256: string;
    observedBeforeInterrupt: true;
    observedAfterResume: true;
  };
  publicationObligation: {
    phase: "output_pending";
    turnID: typeof OBLIGATION_TURN;
    observedBeforeInterrupt: true;
    observedAfterResume: true;
  };
  interruption: {
    actorClosed: true;
    actorCloseBoundMs: 5_000;
    actorCloseLatencyMs: number;
    terminalReason: "aborted";
    providerTransportAborted: true;
    brokerSettlement: {
      idle: true;
      activeRequests: 0;
      forcedAbortRequests: 0;
    };
  };
  resume: {
    newBackendProcess: true;
    sameSupervisorRoot: true;
    priorTranscriptPresent: false;
    restoredPacketSha256Matches: true;
    cleanExit: true;
    brokerSettlement: {
      idle: true;
      activeRequests: 0;
      forcedAbortRequests: 0;
    };
  };
  compaction: {
    simulation: "empty-transcript-plus-restored-authoritative-packet";
    priorStageMarkerAbsent: true;
  };
}

export interface QualifyNativeAdapterContinuityOptions {
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

function requestText(body: JsonObject): string {
  if (!Array.isArray(body.messages)) return "";
  return body.messages.map((item) => {
    const message = record(item);
    return message === null ? "" : messageText(message.content);
  }).join("\n");
}

function usage(): JsonObject {
  return { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
}

function completionResponse(body: JsonObject): Response {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  if (body.stream === true) {
    const first = {
      id: "continuity-resumed",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content: "S8 continuity context restored",
        },
        finish_reason: null,
      }],
    };
    const last = {
      id: "continuity-resumed",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usage(),
    };
    return new Response(
      `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(JSON.stringify({
    id: "continuity-resumed",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "S8 continuity context restored",
      },
      finish_reason: "stop",
    }],
    usage: usage(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `continuity qualification git ${args[0] ?? "command"} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

function fixtureContext(
  binding: CoordinationContinuityBinding,
): CoordinationContextDocument {
  const identity = deriveNativeCellIdentity(
    binding.backend,
    binding.rootSessionID,
  );
  const goal = {
    file: GOAL_FILE,
    from: "chief",
    from_id: "chief",
    topic: "goal",
    ts: "2026-07-25T00:00:00.000Z",
    thread: GOAL_THREAD,
    body: GOAL_BODY,
  };
  const state: SessionCoordinationState = {
    rootSessionID: binding.rootSessionID,
    lineage: [binding.rootSessionID],
    identity,
    role: binding.role,
    persona: null,
    workspaceKey: null,
    registrationEpoch: null,
    phase: "ready",
    attempts: 1,
    join: {
      cell: identity,
      role: binding.role,
      started: false,
      persona: null,
      workspace: null,
      registration: null,
      charter: "S8 continuity qualification charter",
      goal: [goal],
      inbox: [],
      alarms: [],
    },
    goal: { status: "canonical", items: [goal] },
    warnings: [],
  };
  return buildCoordinationContextDocument(state, null, {
    protocol: 1,
    phase: "output_pending",
    turn_id: OBLIGATION_TURN,
    reminders: 0,
    receipt: null,
    last_error: null,
    note_error: null,
    terminal_required: true,
  });
}

function assertContextVisible(text: string, identity: string): void {
  assert.ok(text.includes("<organum-coordination>"));
  assert.ok(text.includes(identity));
  assert.ok(text.includes(GOAL_FILE));
  assert.ok(text.includes(GOAL_THREAD));
  assert.ok(text.includes(GOAL_BODY));
  assert.ok(text.includes('"phase": "output_pending"'));
  assert.ok(text.includes(OBLIGATION_TURN));
}

function createBroker(
  backend: NativeBenchmarkBackendID,
  profile: ProviderProfile,
  fetch: typeof globalThis.fetch,
): InferenceBroker {
  return new InferenceBroker({
    upstreamBaseURL: profile.baseURL,
    upstreamApiKey: DUMMY_UPSTREAM_KEY,
    upstreamModel: profile.modelID,
    mode:
      backend === "claude"
        ? "messages-to-chat-completions"
        : brokerModeForProvider(profile),
    advertisedModel:
      backend === "claude"
        ? NATIVE_CLAUDE_ADVERTISED_MODEL
        : undefined,
    requestTransform:
      backend === "deepcode"
        ? normalizeDeepCodeChatCompletionsRequest
        : undefined,
    sseTransform:
      backend === "grok"
        ? normalizeGrokChatCompletionsSseEvent
        : undefined,
    fetch,
  });
}

async function waitForRequest(
  started: Promise<void>,
  completion: Promise<SoftwareBenchmarkCompletion>,
  context: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      completion.then(() => {
        throw new Error(`native adapter exited before ${context}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `native adapter did not reach ${context} within ${REQUEST_TIMEOUT_MS}ms`,
            ),
          ),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForCompletion(
  execution: SoftwareBenchmarkExecution,
  context: string,
): Promise<SoftwareBenchmarkCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution.wait(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `native adapter did not complete ${context} within ${REQUEST_TIMEOUT_MS}ms`,
            ),
          ),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    await execution.cancel("timeout");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function checkpointFile(stateDirectory: string): Promise<string> {
  const root = join(stateDirectory, "coordination-continuity-v1");
  const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  return join(root, files[0]);
}

export async function qualifyNativeAdapterContinuity(
  options: QualifyNativeAdapterContinuityOptions,
): Promise<NativeAdapterContinuityReceipt> {
  const env = options.env ?? process.env;
  const installation = inspectNativeAdapter(options.backend, env);
  const root = await mkdtemp(join(tmpdir(), "organum-code-continuity-live-"));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, "README.md"), "S8 continuity fixture\n", "utf8");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["add", "--all"]);
  git(workspace, [
    "-c",
    "user.name=Organum Code Continuity",
    "-c",
    "user.email=continuity@invalid",
    "commit",
    "--quiet",
    "-m",
    "continuity baseline",
  ]);

  const canonicalWorkspace = await realpath(workspace);
  const binding: CoordinationContinuityBinding = {
    backend: options.backend,
    workspaceFingerprint: actorWorkspaceFingerprint(canonicalWorkspace),
    rootSessionID: `organum-s8-${options.backend}-root-v1`,
    role: "reviewer",
  };
  const identity = deriveNativeCellIdentity(
    options.backend,
    binding.rootSessionID,
  );
  const initialContext = fixtureContext(binding);
  const checkpointStore = new FileCoordinationContinuityStore(
    stateDirectory,
    () => new Date("2026-07-25T00:00:00.000Z"),
  );
  const saved = await checkpointStore.save(binding, initialContext);
  const initialPacket = buildPersistedCoordinationSystemPacket(
    saved.context,
  );
  const upstreamProfile = loadProviderProfile({
    ORGANUM_CODE_PROVIDER_ID: "continuity",
    ORGANUM_CODE_PROVIDER_NAME: "Continuity fake upstream",
    ORGANUM_CODE_BASE_URL: "https://continuity.invalid/v1",
    ORGANUM_CODE_MODEL: "solar-open2",
    ORGANUM_CODE_MODEL_NAME: "Solar Open 2 continuity alias",
    ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_CONTINUITY_KEY",
    ORGANUM_CODE_PROTOCOL: "chat-completions",
  }, { requireApiKey: false });
  const brain: BenchmarkBrainIdentity = {
    provider: upstreamProfile.providerID,
    model: upstreamProfile.modelID,
    protocol: upstreamProfile.protocol,
    reasoningEffort: null,
  };

  let fakeUpstreamRequests = 0;
  let auxiliaryFakeRequests = 0;
  let observedBeforeInterrupt = false;
  let observedAfterResume = false;
  let providerTransportAborted = false;
  let interruptIssued = false;
  let priorStageMarkerAbsent = false;
  let resolveFirstRequest!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const firstBroker = createBroker(
    options.backend,
    upstreamProfile,
    async (_url, init) => {
      fakeUpstreamRequests += 1;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.model, "solar-open2");
      const text = requestText(body);
      if (!text.includes(FIRST_STAGE_MARKER)) {
        auxiliaryFakeRequests += 1;
        return completionResponse(body);
      }
      assertContextVisible(text, identity);
      assert.ok(text.includes(initialPacket.text));
      observedBeforeInterrupt = true;
      assert.equal(body.stream, true);
      const signal = init?.signal;
      assert.ok(signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => {
            controller.error(
              signal.reason ?? new Error("S8 provider transport aborted"),
            );
            if (interruptIssued) providerTransportAborted = true;
          }, { once: true });
        },
      });
      resolveFirstRequest();
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  let firstExecution: SoftwareBenchmarkExecution | null = null;
  let firstCancelled = false;
  let firstSettlement:
    | Awaited<ReturnType<InferenceBroker["settle"]>>
    | null = null;
  let firstCompletion: SoftwareBenchmarkCompletion | null = null;
  let actorCloseLatencyMs = 0;

  const secondBroker = createBroker(
    options.backend,
    upstreamProfile,
    async (_url, init) => {
      fakeUpstreamRequests += 1;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.model, "solar-open2");
      const text = requestText(body);
      if (!text.includes(RESUMED_STAGE_MARKER)) {
        auxiliaryFakeRequests += 1;
        return completionResponse(body);
      }
      assertContextVisible(text, identity);
      assert.ok(text.includes(initialPacket.text));
      priorStageMarkerAbsent = !text.includes(FIRST_STAGE_MARKER);
      observedAfterResume = true;
      return completionResponse(body);
    },
  );
  let secondExecution: SoftwareBenchmarkExecution | null = null;
  let secondCompleted = false;
  try {
    const firstSession = await firstBroker.start();
    const firstProfile = createBrokeredProviderProfile(
      upstreamProfile,
      firstSession,
    );
    const firstEnvironment = buildBrokerLaunchEnvironment(
      {
        ...env,
        ORGANUM_CODE_S8_HOST_SECRET: HOST_SECRET,
      },
      upstreamProfile.apiKeyEnv,
      firstSession,
    );
    const firstDriver = createNativeAdapterFixtureDriver({
      backend: options.backend,
      profile: firstProfile,
      env: firstEnvironment,
      session: firstSession,
      usageSnapshot: () => firstBroker.snapshot(),
      diagnosticRedactions: [
        firstSession.token,
        DUMMY_UPSTREAM_KEY,
        HOST_SECRET,
      ],
    });
    firstExecution = await firstDriver.start({
      taskID: "qualification/native-continuity-interrupt",
      workspace,
      prompt: [
        FIRST_STAGE_MARKER,
        "The following supervisor packet is authoritative.",
        initialPacket.text,
        "Wait for the provider response. Do not use tools.",
      ].join("\n\n"),
      sessionLabel: "native-continuity-interrupt",
    }, brain);
    const firstCompletionPromise = firstExecution.wait();
    await waitForRequest(
      firstRequestStarted,
      firstCompletionPromise,
      "the interrupted S8 provider request",
    );
    interruptIssued = true;
    const cancelStartedAt = Date.now();
    await firstExecution.cancel("abort");
    actorCloseLatencyMs = Date.now() - cancelStartedAt;
    firstCompletion = await firstCompletionPromise;
    firstCancelled = true;
    firstSettlement = await firstBroker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    assert.equal(firstCompletion.terminalOutcome.reason, "aborted");
    assert.ok(actorCloseLatencyMs <= ACTOR_CLOSE_BOUND_MS);
    assert.equal(providerTransportAborted, true);
    assert.equal(firstSettlement.idle, true);
    assert.equal(firstSettlement.snapshot.activeRequests, 0);
    assert.equal(firstSettlement.forcedAbortRequests, 0);
    await firstBroker.close();

    const restored = await new FileCoordinationContinuityStore(
      stateDirectory,
    ).load(binding);
    assert.ok(restored);
    assert.equal(restored.revision, 1);
    assert.equal(restored.identity, identity);
    assert.deepEqual(restored.context.goal, initialContext.goal);
    assert.deepEqual(
      restored.context.publication,
      initialContext.publication,
    );
    const restoredPacket = buildPersistedCoordinationSystemPacket(
      restored.context,
    );
    assert.equal(restoredPacket.text, initialPacket.text);

    const secondSession = await secondBroker.start();
    const secondProfile = createBrokeredProviderProfile(
      upstreamProfile,
      secondSession,
    );
    const secondEnvironment = buildBrokerLaunchEnvironment(
      {
        ...env,
        ORGANUM_CODE_S8_HOST_SECRET: HOST_SECRET,
      },
      upstreamProfile.apiKeyEnv,
      secondSession,
    );
    const secondDriver = createNativeAdapterFixtureDriver({
      backend: options.backend,
      profile: secondProfile,
      env: secondEnvironment,
      session: secondSession,
      usageSnapshot: () => secondBroker.snapshot(),
      diagnosticRedactions: [
        secondSession.token,
        DUMMY_UPSTREAM_KEY,
        HOST_SECRET,
      ],
    });
    secondExecution = await secondDriver.start({
      taskID: "qualification/native-continuity-resume",
      workspace,
      prompt: [
        RESUMED_STAGE_MARKER,
        "The prior transcript is unavailable after compaction.",
        "Use only this restored supervisor packet.",
        restoredPacket.text,
        "Confirm restoration without using tools.",
      ].join("\n\n"),
      sessionLabel: "native-continuity-resume",
    }, brain);
    const secondCompletion = await waitForCompletion(
      secondExecution,
      "the resumed S8 turn",
    );
    secondCompleted = true;
    const secondSettlement = await secondBroker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    assert.equal(secondCompletion.cleanExit, true);
    assert.equal(secondCompletion.terminalOutcome.reason, "clean-exit");
    assert.deepEqual(secondCompletion.containmentViolations, []);
    assert.deepEqual(secondCompletion.adapterViolations, []);
    assert.deepEqual(secondCompletion.adapterWarnings, []);
    assert.equal(observedBeforeInterrupt, true);
    assert.equal(observedAfterResume, true);
    assert.equal(priorStageMarkerAbsent, true);
    assert.equal(secondSettlement.idle, true);
    assert.equal(secondSettlement.snapshot.activeRequests, 0);
    assert.equal(secondSettlement.forcedAbortRequests, 0);

    const path = await checkpointFile(stateDirectory);
    const checkpointMetadata = await lstat(path);
    const checkpointBytes = await readFile(path);
    assert.equal(
      checkpointBytes.includes(Buffer.from(DUMMY_UPSTREAM_KEY)),
      false,
    );
    assert.equal(
      checkpointBytes.includes(Buffer.from(firstSession.token)),
      false,
    );
    assert.equal(
      checkpointBytes.includes(Buffer.from(secondSession.token)),
      false,
    );
    assert.equal(checkpointBytes.includes(Buffer.from(HOST_SECRET)), false);
    if (process.platform !== "win32") {
      assert.equal(checkpointMetadata.mode & 0o077, 0);
    }
    assert.equal(
      (await realpath(stateDirectory)).startsWith(
        `${await realpath(workspace)}/`,
      ),
      false,
    );

    return {
      schema: "organum-code/native-adapter-continuity/v1",
      gate: "pass",
      backend: options.backend,
      binary: {
        command: installation.binary,
        version: installation.version,
      },
      providerCalls: 0,
      fakeUpstreamRequests,
      auxiliaryFakeRequests,
      checkpoint: {
        schema: "organum-code/coordination-continuity/v1",
        revision: 1,
        private: true,
        workspaceDisjoint: true,
        credentialMaterialPersisted: false,
        contextSha256: saved.context_sha256,
      },
      root: {
        stable: true,
        identity,
        backendProcesses: 2,
      },
      currentGoal: {
        status: "canonical",
        file: GOAL_FILE,
        thread: GOAL_THREAD,
        bodySha256: createHash("sha256")
          .update(GOAL_BODY)
          .digest("hex"),
        observedBeforeInterrupt: true,
        observedAfterResume: true,
      },
      publicationObligation: {
        phase: "output_pending",
        turnID: OBLIGATION_TURN,
        observedBeforeInterrupt: true,
        observedAfterResume: true,
      },
      interruption: {
        actorClosed: true,
        actorCloseBoundMs: 5_000,
        actorCloseLatencyMs,
        terminalReason: "aborted",
        providerTransportAborted: true,
        brokerSettlement: {
          idle: true,
          activeRequests: 0,
          forcedAbortRequests: 0,
        },
      },
      resume: {
        newBackendProcess: true,
        sameSupervisorRoot: true,
        priorTranscriptPresent: false,
        restoredPacketSha256Matches: true,
        cleanExit: true,
        brokerSettlement: {
          idle: true,
          activeRequests: 0,
          forcedAbortRequests: 0,
        },
      },
      compaction: {
        simulation: "empty-transcript-plus-restored-authoritative-packet",
        priorStageMarkerAbsent: true,
      },
    };
  } finally {
    if (firstExecution !== null && !firstCancelled) {
      await firstExecution.cancel("backend-error").catch(() => undefined);
    }
    if (secondExecution !== null && !secondCompleted) {
      await secondExecution.cancel("backend-error").catch(() => undefined);
    }
    await firstBroker.close().catch(() => undefined);
    await secondBroker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
