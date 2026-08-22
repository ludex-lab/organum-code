import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allocateActorRuntime } from "./actor-runtime.js";
import {
  prepareClaudeCodeLaunch,
  type PreparedClaudeCodeLaunch,
} from "./claude-launcher.js";
import {
  prepareDeepCodeLaunch,
  type PreparedDeepCodeLaunch,
} from "./deepcode-launcher.js";
import {
  normalizeGrokChatCompletionsSseEvent,
  prepareGrokBuildLaunch,
  type PreparedGrokBuildLaunch,
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
  NativeSoftwareBenchmarkBackendDriver,
  type NativeBenchmarkAdapterContract,
  type PreparedNativeBenchmarkLaunch,
} from "./native-benchmark-backend.js";
import {
  finalizeNativeInteractiveLaunch,
  planNativeInteractiveLaunch,
  type NativeInteractiveLaunchPlan,
} from "./native-interactive-lifecycle.js";
import {
  inspectNativeAdapter,
  NATIVE_CLAUDE_ADVERTISED_MODEL,
} from "./native-adapter-fixture.js";
import { normalizeDeepCodeChatCompletionsRequest } from "./deepcode-launcher.js";
import { loadProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkCompletion,
} from "./software-benchmark.js";

const FIRST_PROMPT = [
  "ORGANUM_S11_FIRST_NATIVE_TURN",
  "Do not use tools. Return only ORGANUM_S11_FIRST_HISTORY_VALUE.",
].join("\n");
const SECOND_PROMPT = [
  "ORGANUM_S11_RESUME_NATIVE_TURN",
  "Use the native resumed history. Return only ORGANUM_S11_RESUME_OK.",
].join("\n");
const FIRST_RESPONSE = "ORGANUM_S11_FIRST_HISTORY_VALUE";
const SECOND_RESPONSE = "ORGANUM_S11_RESUME_OK";
const DUMMY_UPSTREAM_KEY = "s11-upstream-key-never-persisted";
const HOST_SECRET = "s11-host-secret-never-persisted";
const REQUEST_TIMEOUT_MS = 60_000;

const CONTRACTS: Record<
  NativeBenchmarkBackendID,
  NativeBenchmarkAdapterContract
> = {
  claude: {
    schemaVersion: 1,
    backendID: "claude",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    // NativeBenchmarkAdapterContract v1 is frozen to the historical benchmark
    // runner's ephemeral literal. S11 deliberately versions the runtime claim
    // outside that frozen runner while SoftwareBenchmarkAdapterEvidence can
    // represent the new persistent projection.
    persistentState:
      "isolated-persistent" as NativeBenchmarkAdapterContract["persistentState"],
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "process-exit",
    protocolMediation: [
      "anthropic-messages-to-chat-completions",
      "supervisor-owned-native-session-resume",
    ],
    nativeDifferences: [
      "Claude Code print mode persists and resumes its native UUID history",
    ],
  },
  grok: {
    schemaVersion: 1,
    backendID: "grok",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    persistentState:
      "isolated-persistent" as NativeBenchmarkAdapterContract["persistentState"],
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "process-exit",
    protocolMediation: [
      "empty-tool-name-sse-delta-normalization",
      "supervisor-owned-native-session-resume",
    ],
    nativeDifferences: [
      "Grok Build single-turn mode persists and resumes its native UUID history",
    ],
  },
  deepcode: {
    schemaVersion: 1,
    backendID: "deepcode",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    persistentState:
      "isolated-persistent" as NativeBenchmarkAdapterContract["persistentState"],
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "notify-then-process-exit",
    protocolMediation: [
      "drop-nonstandard-thinking-and-extra_body",
      "supervisor-binds-discovered-native-session-resume",
    ],
    nativeDifferences: [
      "Deep Code allocates the first UUID internally and exposes completion through notify",
      "PTY is required for both native turns",
    ],
  },
};

export interface NativeInteractiveAdmissionReceipt {
  schema: "organum-code/native-interactive-admission/v1";
  gate: "pass";
  backend: NativeBenchmarkBackendID;
  binary: { command: string; version: string };
  providerCalls: 0;
  fakeUpstreamRequests: number;
  auxiliaryFakeRequests: number;
  root: {
    supervisorOwned: true;
    stableAcrossProcesses: true;
    id: string;
    backendProcesses: 2;
  };
  nativeSession: {
    exactID: string;
    firstMode: "new";
    secondMode: "resume";
    sameID: true;
    historyObservedByProvider: true;
    firstCleanExit: true;
    secondCleanExit: true;
  };
  persistentRuntime: {
    private: true;
    workspaceDisjoint: true;
    singleOwner: true;
    registryContainsPrompt: false;
    upstreamCredentialPersisted: false;
    brokerCapabilityPersisted: false;
    hostSecretPersisted: false;
  };
  brokerSettlement: {
    idle: true;
    activeRequests: 0;
    forcedAbortRequests: 0;
  };
}

export interface QualifyNativeInteractiveAdmissionOptions {
  backend: NativeBenchmarkBackendID;
  env?: NodeJS.ProcessEnv;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = record(part);
    return typeof item?.text === "string" ? item.text : "";
  }).join("");
}

function requestText(body: JsonObject): string {
  if (!Array.isArray(body.messages)) return "";
  return body.messages.map((entry) => {
    const message = record(entry);
    return message === null ? "" : messageText(message.content);
  }).join("\n");
}

function systemText(body: JsonObject): string {
  if (!Array.isArray(body.messages)) return "";
  const message = body.messages
    .map(record)
    .find((entry) => entry?.role === "system");
  return message === undefined || message === null
    ? ""
    : messageText(message.content);
}

function usage(): JsonObject {
  return { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 };
}

function completionResponse(
  body: JsonObject,
  content: string,
  id: string,
): Response {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  if (body.stream === true) {
    const first = {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{
        index: 0,
        delta: { role: "assistant", content },
        finish_reason: null,
      }],
    };
    const last = {
      id,
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
    id,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: usage(),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function runGit(cwd: string): void {
  const init = spawnSync("git", ["-C", cwd, "init", "--quiet"], {
    encoding: "utf8",
  });
  if (init.error !== undefined || init.status !== 0) {
    throw new Error(
      `S11 fixture git init failed: ${init.error?.message ?? init.stderr.trim()}`,
    );
  }
  const add = spawnSync("git", ["-C", cwd, "add", "--all"], {
    encoding: "utf8",
  });
  if (add.error !== undefined || add.status !== 0) {
    throw new Error(
      `S11 fixture git add failed: ${add.error?.message ?? add.stderr.trim()}`,
    );
  }
  const commit = spawnSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Organum Code S11",
      "-c",
      "user.email=s11@invalid",
      "commit",
      "--quiet",
      "-m",
      "S11 baseline",
    ],
    { encoding: "utf8" },
  );
  if (commit.error !== undefined || commit.status !== 0) {
    throw new Error(
      `S11 fixture git commit failed: ${commit.error?.message ?? commit.stderr.trim()}`,
    );
  }
}

function projectClaude(
  launch: PreparedClaudeCodeLaunch,
  nativeSessionID: string | null,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId: nativeSessionID,
    diagnosticRuntimeDirectory: launch.runtimeDirectory,
    close: () => launch.close(),
  };
}

function projectGrok(
  launch: PreparedGrokBuildLaunch,
  nativeSessionID: string | null,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId: nativeSessionID,
    diagnosticRuntimeDirectory: launch.runtimeDirectory,
    close: () => launch.close(),
  };
}

function projectDeepCode(
  launch: PreparedDeepCodeLaunch,
  nativeSessionID: string | null,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: true,
    nativeSessionId: nativeSessionID,
    ...(launch.completionReceiptPath === undefined
      ? {}
      : { completionReceiptPath: launch.completionReceiptPath }),
    diagnosticRuntimeDirectory: launch.diagnosticRuntimeDirectory,
    diagnosticStateDirectory: launch.diagnosticStateDirectory,
    close: () => launch.close(),
  };
}

function baseArgs(
  backend: NativeBenchmarkBackendID,
  prompt: string,
): readonly string[] {
  if (backend === "claude") {
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--prompt-suggestions",
      "false",
      prompt,
    ];
  }
  if (backend === "grok") {
    return [
      "--no-leader",
      "--always-approve",
      "--disable-web-search",
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--output-format",
      "json",
      "--single",
      prompt,
    ];
  }
  return ["-p", prompt];
}

async function waitForCompletion(
  completion: Promise<SoftwareBenchmarkCompletion>,
): Promise<SoftwareBenchmarkCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `native interactive admission did not complete within ${REQUEST_TIMEOUT_MS}ms`,
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

async function scanRuntimeFor(
  root: string,
  forbidden: readonly string[],
): Promise<void> {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > 2_000) {
        throw new Error("S11 persistent runtime file bound exceeded");
      }
      const content = await readFile(path);
      bytes += content.byteLength;
      if (bytes > 32 * 1024 * 1024) {
        throw new Error("S11 persistent runtime byte bound exceeded");
      }
      for (const secret of forbidden) {
        assert.equal(
          content.includes(Buffer.from(secret)),
          false,
          `S11 runtime persisted forbidden material in ${entry.name}`,
        );
      }
    }
  }
}

export async function qualifyNativeInteractiveAdmission(
  options: QualifyNativeInteractiveAdmissionOptions,
): Promise<NativeInteractiveAdmissionReceipt> {
  const env = options.env ?? process.env;
  const installation = inspectNativeAdapter(options.backend, env);
  const root = await mkdtemp(join(tmpdir(), "organum-code-s11-"));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  let broker: InferenceBroker | null = null;
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(workspace, "README.md"),
      "S11 native interactive lifecycle fixture\n",
      "utf8",
    );
    runGit(workspace);

    const actorRuntime = await allocateActorRuntime({
      actor: "s11-operator",
      profile: "qualification",
      backend: options.backend,
      workspace,
      env: { ...env, ORGANUM_CODE_STATE_DIR: stateDirectory },
    });
    const profile = loadProviderProfile({
      ORGANUM_CODE_PROVIDER_ID: "s11-interactive",
      ORGANUM_CODE_PROVIDER_NAME: "S11 fake provider",
      ORGANUM_CODE_BASE_URL: "https://s11.invalid/v1",
      ORGANUM_CODE_MODEL: "solar-open2",
      ORGANUM_CODE_MODEL_NAME: "Solar Open 2 S11 alias",
      ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_S11_KEY",
      ORGANUM_CODE_PROTOCOL: "chat-completions",
    }, { requireApiKey: false });
    const brain: BenchmarkBrainIdentity = {
      provider: profile.providerID,
      model: profile.modelID,
      protocol: profile.protocol,
      reasoningEffort: null,
    };

    let fakeUpstreamRequests = 0;
    let auxiliaryFakeRequests = 0;
    let firstRequests = 0;
    let secondRequests = 0;
    let historyObserved = false;
    const fakeFetch: typeof fetch = async (_url, init) => {
      fakeUpstreamRequests += 1;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      const text = requestText(body);
      const system = systemText(body);
      const id = `s11-${options.backend}-${fakeUpstreamRequests}`;
      if (
        system.startsWith("You are tasked with generating the session title.") ||
        (!text.includes(FIRST_PROMPT) && !text.includes(SECOND_PROMPT))
      ) {
        auxiliaryFakeRequests += 1;
        return completionResponse(body, "S11 native resume", id);
      }
      if (text.includes(SECOND_PROMPT)) {
        secondRequests += 1;
        historyObserved =
          text.includes(FIRST_PROMPT) && text.includes(FIRST_RESPONSE);
        return completionResponse(body, SECOND_RESPONSE, id);
      }
      firstRequests += 1;
      return completionResponse(body, FIRST_RESPONSE, id);
    };

    broker = new InferenceBroker({
      upstreamBaseURL: profile.baseURL,
      upstreamApiKey: DUMMY_UPSTREAM_KEY,
      upstreamModel: profile.modelID,
      mode:
        options.backend === "claude"
          ? "messages-to-chat-completions"
          : brokerModeForProvider(profile),
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
      fetch: fakeFetch,
    });
    const brokerSession = await broker.start();
    const brokered = createBrokeredProviderProfile(profile, brokerSession);
    const launchEnvironment = buildBrokerLaunchEnvironment(
      { ...env, ORGANUM_CODE_S11_HOST_SECRET: HOST_SECRET },
      profile.apiKeyEnv,
      brokerSession,
    );

    const runTurn = async (
      plan: NativeInteractiveLaunchPlan,
      prompt: string,
    ): Promise<SoftwareBenchmarkCompletion> => {
      const driver = new NativeSoftwareBenchmarkBackendDriver({
        backendID: options.backend,
        profile: brokered,
        adapterContract: CONTRACTS[options.backend],
        usageSnapshot: () => broker!.snapshot(),
        captureActorDiagnostic: true,
        diagnosticRedactions: [
          brokerSession.token,
          DUMMY_UPSTREAM_KEY,
          HOST_SECRET,
        ],
        async prepare() {
          if (options.backend === "claude") {
            return projectClaude(
              await prepareClaudeCodeLaunch(
                plan.args,
                brokerSession,
                NATIVE_CLAUDE_ADVERTISED_MODEL,
                launchEnvironment,
                workspace,
                { runtimeDirectory: actorRuntime.runtimeDirectory },
              ),
              plan.nativeSessionID,
            );
          }
          if (options.backend === "grok") {
            return projectGrok(
              await prepareGrokBuildLaunch(
                plan.args,
                brokered,
                launchEnvironment,
                workspace,
                { runtimeDirectory: actorRuntime.runtimeDirectory },
              ),
              plan.nativeSessionID,
            );
          }
          return projectDeepCode(
            await prepareDeepCodeLaunch(
              plan.args,
              brokered,
              launchEnvironment,
              workspace,
              {
                completionSignal: true,
                permissionMode: "contained-unattended",
                runtimeDirectory: actorRuntime.runtimeDirectory,
              },
            ),
            plan.nativeSessionID,
          );
        },
      });
      const execution = await driver.start({
        taskID: `qualification/native-interactive-${plan.mode}`,
        workspace,
        prompt,
        sessionLabel: `native-interactive-${plan.mode}`,
      }, brain);
      const completion = await waitForCompletion(execution.wait());
      assert.equal(completion.cleanExit, true);
      assert.deepEqual(completion.adapterViolations, []);
      assert.deepEqual(completion.adapterWarnings, []);
      return completion;
    };

    const firstPlan = await planNativeInteractiveLaunch(
      actorRuntime,
      baseArgs(options.backend, FIRST_PROMPT),
    );
    assert.equal(firstPlan.mode, "new");
    const first = await runTurn(firstPlan, FIRST_PROMPT);
    const firstState = await finalizeNativeInteractiveLaunch(
      actorRuntime,
      firstPlan,
    );
    assert.ok(firstState.native_session_id);

    const secondPlan = await planNativeInteractiveLaunch(
      actorRuntime,
      baseArgs(options.backend, SECOND_PROMPT),
    );
    assert.equal(secondPlan.mode, "resume");
    assert.equal(secondPlan.nativeSessionID, firstState.native_session_id);
    const second = await runTurn(secondPlan, SECOND_PROMPT);
    const secondState = await finalizeNativeInteractiveLaunch(
      actorRuntime,
      secondPlan,
    );

    assert.equal(secondState.native_session_id, firstState.native_session_id);
    assert.ok(firstRequests >= 1);
    assert.ok(secondRequests >= 1);
    assert.equal(historyObserved, true);
    const registry = await readFile(secondPlan.statePath, "utf8");
    assert.equal(registry.includes(FIRST_PROMPT), false);
    assert.equal(registry.includes(SECOND_PROMPT), false);
    await scanRuntimeFor(actorRuntime.runtimeDirectory, [
      DUMMY_UPSTREAM_KEY,
      brokerSession.token,
      HOST_SECRET,
    ]);

    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    assert.equal(settlement.idle, true);
    assert.equal(settlement.snapshot.activeRequests, 0);
    assert.equal(settlement.forcedAbortRequests, 0);
    await broker.close();

    return {
      schema: "organum-code/native-interactive-admission/v1",
      gate: "pass",
      backend: options.backend,
      binary: {
        command: installation.binary,
        version: installation.version,
      },
      providerCalls: 0,
      fakeUpstreamRequests,
      auxiliaryFakeRequests,
      root: {
        supervisorOwned: true,
        stableAcrossProcesses: true,
        id: firstPlan.rootSessionID,
        backendProcesses: 2,
      },
      nativeSession: {
        exactID: firstState.native_session_id,
        firstMode: "new",
        secondMode: "resume",
        sameID: true,
        historyObservedByProvider: true,
        firstCleanExit: true,
        secondCleanExit: true,
      },
      persistentRuntime: {
        private: true,
        workspaceDisjoint: true,
        singleOwner: true,
        registryContainsPrompt: false,
        upstreamCredentialPersisted: false,
        brokerCapabilityPersisted: false,
        hostSecretPersisted: false,
      },
      brokerSettlement: {
        idle: true,
        activeRequests: 0,
        forcedAbortRequests: 0,
      },
    };
  } finally {
    await broker?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
