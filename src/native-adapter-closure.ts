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
  classifyStickyGoal,
  type SessionCoordinationState,
} from "./coordination-bootstrap.js";
import {
  FileCoordinationContinuityStore,
  type CoordinationContinuityBinding,
} from "./coordination-continuity.js";
import {
  buildCoordinationContextDocument,
  buildPersistedCoordinationSystemPacket,
} from "./coordination-context.js";
import {
  SessionPublicationStateMachine,
  type PublicationClient,
} from "./coordination-publish.js";
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
import {
  buildOrganumCliEnvironment,
  OrganumCli,
  type AgoraPublishRequest,
  type PublishReceipt,
  type RelaySendRequest,
  type SessionStatus,
} from "./organum-cli.js";
import {
  deriveNativeCellIdentity,
  type CellIdentity,
} from "./organum-identity.js";
import { loadProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkCompletion,
  SoftwareBenchmarkExecution,
} from "./software-benchmark.js";

const REQUEST_MARKER = "ORGANUM_S9_NATIVE_SUBSTANTIVE_TURN";
const SUBSTANTIVE_BODY =
  "ORGANUM_S9_SUBSTANTIVE_RESULT exact durable closure evidence";
const HANDOFF_MARKER = "ORGANUM_S9_HANDOFF";
const HANDOFF_OUTPUT = `${HANDOFF_MARKER} ${JSON.stringify({
  protocol: 1,
  operation: "handoff",
  body: SUBSTANTIVE_BODY,
  topic: "review",
})}`;
const PUBLICATION_TURN = "s9-native-substantive-turn";
const DUMMY_UPSTREAM_KEY = "closure-upstream-key-never-persisted";
const HOST_SECRET = "closure-host-secret-never-persisted";
const REQUEST_TIMEOUT_MS = 60_000;
const EXPECTED_ORGANUM_VERSION = "organum 0.1.3";

export interface NativeAdapterClosureReceipt {
  schema: "organum-code/native-adapter-closure/v1";
  gate: "pass";
  backend: NativeBenchmarkBackendID;
  binary: { command: string; version: string };
  organum: {
    command: string;
    version: typeof EXPECTED_ORGANUM_VERSION;
    actualCli: true;
  };
  providerCalls: 0;
  fakeUpstreamRequests: number;
  auxiliaryFakeRequests: number;
  substantiveOutput: {
    observedInNativeOutput: true;
    explicitHandoffIntent: true;
    automaticPublication: false;
    bodyBytes: number;
    bodySha256: string;
    nativeCleanExit: true;
  };
  publication: {
    phase: "shipped";
    terminalRequired: true;
    turnID: typeof PUBLICATION_TURN;
    channel: "agora";
    file: string;
    fromID: string;
    idemKey: string;
    publishAttempts: 2;
    uniqueDurableReceipts: 1;
    exactReplayConverged: true;
  };
  handoff: {
    statusBeforeEndOpen: true;
    endCalls: 1;
    statusAfterClosure: null;
    shippedFileMatchesReceipt: true;
    terminalReplayIssuedNoSecondEnd: true;
  };
  checkpoint: {
    schema: "organum-code/coordination-continuity/v1";
    revision: 1;
    private: true;
    workspaceDisjoint: true;
    organumStateDisjoint: true;
    phase: "shipped";
    receiptMatches: true;
    credentialMaterialPersisted: false;
    modelOutputPersisted: false;
    contextSha256: string;
  };
  brokerSettlement: {
    idle: true;
    activeRequests: 0;
    forcedAbortRequests: 0;
  };
}

export interface QualifyNativeAdapterClosureOptions {
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

interface NativeHandoffIntent {
  protocol: 1;
  operation: "handoff";
  body: string;
  topic: "review";
}

function firstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function handoffIntentFromString(value: string): NativeHandoffIntent | null {
  const marker = value.indexOf(HANDOFF_MARKER);
  if (marker < 0) return null;
  const candidates = [value.slice(marker + HANDOFF_MARKER.length)];
  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push(
      candidates[candidates.length - 1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\"),
    );
  }
  for (const candidate of candidates) {
    const encoded = firstJsonObject(candidate);
    if (encoded === null) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      continue;
    }
    const intent = record(decoded);
    if (
      intent !== null &&
      Object.keys(intent).sort().join(",") ===
        "body,operation,protocol,topic" &&
      intent.protocol === 1 &&
      intent.operation === "handoff" &&
      intent.body === SUBSTANTIVE_BODY &&
      intent.topic === "review"
    ) {
      return {
        protocol: 1,
        operation: "handoff",
        body: SUBSTANTIVE_BODY,
        topic: "review",
      };
    }
  }
  return null;
}

function handoffIntentFromValue(
  value: unknown,
  depth = 0,
): NativeHandoffIntent | null {
  if (depth > 12) return null;
  if (typeof value === "string") return handoffIntentFromString(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const intent = handoffIntentFromValue(item, depth + 1);
      if (intent !== null) return intent;
    }
    return null;
  }
  const objectValue = record(value);
  if (objectValue === null) return null;
  for (const item of Object.values(objectValue)) {
    const intent = handoffIntentFromValue(item, depth + 1);
    if (intent !== null) return intent;
  }
  return null;
}

function parseNativeHandoffIntent(output: string): NativeHandoffIntent {
  for (const line of output.split(/\r?\n/)) {
    try {
      const intent = handoffIntentFromValue(JSON.parse(line));
      if (intent !== null) return intent;
    } catch {
      const intent = handoffIntentFromString(line);
      if (intent !== null) return intent;
    }
  }
  const fallback = handoffIntentFromString(output);
  assert.ok(fallback, "native output omitted the exact S9 handoff intent");
  return fallback;
}

function usage(): JsonObject {
  return { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
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

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `S9 ${command} ${args[0] ?? ""} failed: ${
        result.error?.message ?? result.stderr.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

function initializeGit(cwd: string, env: NodeJS.ProcessEnv): void {
  run("git", ["init", "--quiet"], cwd, env);
}

function inspectOrganum(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const version = run(command, ["--version"], cwd, env);
  assert.equal(
    version,
    EXPECTED_ORGANUM_VERSION,
    "S9 requires the exact admitted Organum CLI version",
  );
  return version;
}

function createBroker(
  backend: NativeBenchmarkBackendID,
  profile: ReturnType<typeof loadProviderProfile>,
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

async function waitForCompletion(
  execution: SoftwareBenchmarkExecution,
): Promise<SoftwareBenchmarkCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution.wait(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `native adapter did not complete S9 within ${REQUEST_TIMEOUT_MS}ms`,
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

export class ReplayProbePublicationClient implements PublicationClient {
  publishAttempts = 0;
  endCalls = 0;
  statusCalls = 0;
  statusBeforeEndOpen = false;
  exactReplayConverged = false;
  durableReceiptVerified = false;
  readonly uniqueFiles = new Set<string>();
  readonly endedFiles: string[] = [];

  constructor(
    private readonly cli: OrganumCli,
    private readonly agoraDirectory: string,
  ) {}

  async publishAgora(request: AgoraPublishRequest): Promise<PublishReceipt> {
    const first = await this.cli.publishAgora(request);
    const replay = await this.cli.publishAgora(request);
    this.publishAttempts += 2;
    this.uniqueFiles.add(first.file);
    this.uniqueFiles.add(replay.file);
    assert.deepEqual(replay, first);
    const durableFiles = (await readdir(this.agoraDirectory)).filter(
      (file) => file === replay.file,
    );
    assert.equal(durableFiles.length, 1);
    const durableEnvelope = await readFile(
      join(this.agoraDirectory, replay.file),
      "utf8",
    );
    assert.ok(durableEnvelope.includes(request.body));
    assert.ok(durableEnvelope.includes(replay.idempotencyKey));
    assert.ok(durableEnvelope.includes(request.identity));
    this.durableReceiptVerified = true;
    this.exactReplayConverged = true;
    return replay;
  }

  async sendRelay(request: RelaySendRequest): Promise<PublishReceipt> {
    return await this.cli.sendRelay(request);
  }

  async sessionStatus(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<SessionStatus | null> {
    this.statusCalls += 1;
    const status = await this.cli.sessionStatus(identity, signal);
    if (this.endCalls === 0 && status !== null) {
      this.statusBeforeEndOpen = true;
    }
    return status;
  }

  async note(
    identity: CellIdentity,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.cli.note(identity, text, signal);
  }

  async end(
    identity: CellIdentity,
    shippedFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.endCalls += 1;
    this.endedFiles.push(shippedFile);
    await this.cli.end(identity, shippedFile, signal);
  }
}

export async function qualifyNativeAdapterClosure(
  options: QualifyNativeAdapterClosureOptions,
): Promise<NativeAdapterClosureReceipt> {
  const env = options.env ?? process.env;
  const installation = inspectNativeAdapter(options.backend, env);
  const root = await mkdtemp(join(tmpdir(), "organum-code-closure-live-"));
  const workspace = join(root, "workspace");
  const organumProject = join(root, "organum-project");
  const stateDirectory = join(root, "state");
  let broker: InferenceBroker | null = null;
  let execution: SoftwareBenchmarkExecution | null = null;
  let completed = false;

  try {
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(organumProject, { recursive: true, mode: 0o700 }),
      mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(workspace, "README.md"),
      "S9 durable closure fixture\n",
      "utf8",
    );
    const commandEnvironment = buildOrganumCliEnvironment(env);
    initializeGit(workspace, commandEnvironment);
    run("git", ["add", "--all"], workspace, commandEnvironment);
    run(
      "git",
      [
        "-c",
        "user.name=Organum Code Closure",
        "-c",
        "user.email=closure@invalid",
        "commit",
        "--quiet",
        "-m",
        "closure baseline",
      ],
      workspace,
      commandEnvironment,
    );
    initializeGit(organumProject, commandEnvironment);

    const organumCommand =
      env.ORGANUM_CODE_ORGANUM_BIN?.trim() || "organum";
    const organumVersion = inspectOrganum(
      organumCommand,
      organumProject,
      commandEnvironment,
    );
    run(
      organumCommand,
      ["init", "--agent", `organum-code-s9-${options.backend}`],
      organumProject,
      commandEnvironment,
    );

    const canonicalWorkspace = await realpath(workspace);
    const rootSessionID = `organum-s9-${options.backend}-root-v1`;
    const identity = deriveNativeCellIdentity(
      options.backend,
      rootSessionID,
    );
    const cli = new OrganumCli({
      binary: organumCommand,
      cwd: organumProject,
      env,
    });
    const joined = await cli.join({
      identity,
      role: "reviewer",
      intent: "S9 native durable closure qualification",
    });
    const goal = classifyStickyGoal(joined.goal);
    const state: SessionCoordinationState = {
      rootSessionID,
      lineage: [rootSessionID],
      identity,
      role: "reviewer",
      persona: null,
      workspaceKey: null,
      registrationEpoch: null,
      phase: goal.status === "canonical" ? "ready" : "degraded",
      attempts: 1,
      join: joined,
      goal,
      warnings:
        goal.status === "canonical"
          ? []
          : ["No canonical goal in the isolated S9 publication fixture"],
    };

    const upstreamProfile = loadProviderProfile({
      ORGANUM_CODE_PROVIDER_ID: "closure",
      ORGANUM_CODE_PROVIDER_NAME: "Closure fake upstream",
      ORGANUM_CODE_BASE_URL: "https://closure.invalid/v1",
      ORGANUM_CODE_MODEL: "solar-open2",
      ORGANUM_CODE_MODEL_NAME: "Solar Open 2 closure alias",
      ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_CLOSURE_KEY",
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
    let substantiveResponseRequests = 0;
    broker = createBroker(
      options.backend,
      upstreamProfile,
      async (_url, init) => {
        fakeUpstreamRequests += 1;
        const body = JSON.parse(String(init?.body)) as JsonObject;
        assert.equal(body.model, "solar-open2");
        if (requestText(body).includes(REQUEST_MARKER)) {
          substantiveResponseRequests += 1;
          return completionResponse(
            body,
            HANDOFF_OUTPUT,
            "closure-substantive",
          );
        }
        auxiliaryFakeRequests += 1;
        return completionResponse(body, "S9 auxiliary", "closure-auxiliary");
      },
    );
    const brokerSession = await broker.start();
    const brokeredProfile = createBrokeredProviderProfile(
      upstreamProfile,
      brokerSession,
    );
    const launchEnvironment = buildBrokerLaunchEnvironment(
      {
        ...env,
        ORGANUM_CODE_S9_HOST_SECRET: HOST_SECRET,
      },
      upstreamProfile.apiKeyEnv,
      brokerSession,
    );
    const driver = createNativeAdapterFixtureDriver({
      backend: options.backend,
      profile: brokeredProfile,
      env: launchEnvironment,
      session: brokerSession,
      usageSnapshot: () => broker!.snapshot(),
      diagnosticRedactions: [
        brokerSession.token,
        DUMMY_UPSTREAM_KEY,
        HOST_SECRET,
      ],
    });
    execution = await driver.start({
      taskID: "qualification/native-durable-closure",
      workspace,
      prompt: [
        REQUEST_MARKER,
        "Return the provider result as the substantive final output.",
        "Do not use tools.",
      ].join("\n\n"),
      sessionLabel: "native-durable-closure",
    }, brain);
    const completion = await waitForCompletion(execution);
    completed = true;
    assert.equal(completion.cleanExit, true);
    assert.equal(completion.terminalOutcome.reason, "clean-exit");
    assert.deepEqual(completion.containmentViolations, []);
    assert.deepEqual(completion.adapterViolations, []);
    assert.deepEqual(completion.adapterWarnings, []);
    assert.ok(substantiveResponseRequests >= 1);
    const diagnostic = driver.actorDiagnostic();
    assert.ok(diagnostic);
    const nativeOutput = [
      diagnostic.stdout.text,
      diagnostic.stderr.text,
      diagnostic.deepCodeState?.text ?? "",
    ].join("\n");
    const handoffIntent = parseNativeHandoffIntent(nativeOutput);
    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    assert.equal(settlement.idle, true);
    assert.equal(settlement.snapshot.activeRequests, 0);
    assert.equal(settlement.forcedAbortRequests, 0);
    await broker.close();

    const publicationClient = new ReplayProbePublicationClient(
      cli,
      join(organumProject, ".organum", "agora"),
    );
    const machine = new SessionPublicationStateMachine(publicationClient);
    const pending = await machine.observeOutput(
      state,
      canonicalWorkspace,
      PUBLICATION_TURN,
      handoffIntent.body,
    );
    assert.equal(pending.phase, "output_pending");
    assert.equal(pending.receipt, null);
    const request = {
      messageID: PUBLICATION_TURN,
      body: handoffIntent.body,
      topic: handoffIntent.topic,
      handoff: true,
    } as const;
    const published = await machine.publish(
      state,
      canonicalWorkspace,
      request,
    );
    assert.equal(published.phase, "shipped");
    assert.equal(published.shipped, true);
    assert.equal(published.channel, "agora");
    assert.equal(published.from_id, identity);
    assert.equal(publicationClient.publishAttempts, 2);
    assert.equal(publicationClient.uniqueFiles.size, 1);
    assert.equal(publicationClient.exactReplayConverged, true);
    assert.equal(publicationClient.durableReceiptVerified, true);
    assert.equal(publicationClient.statusBeforeEndOpen, true);
    assert.equal(publicationClient.endCalls, 1);
    assert.deepEqual(publicationClient.endedFiles, [published.file]);
    assert.equal(await cli.sessionStatus(identity), null);

    const terminalReplay = await machine.publish(
      state,
      canonicalWorkspace,
      request,
    );
    assert.deepEqual(terminalReplay, published);
    assert.equal(publicationClient.publishAttempts, 2);
    assert.equal(publicationClient.endCalls, 1);
    assert.ok(publicationClient.statusCalls >= 2);

    const durableFiles = (await readdir(
      join(organumProject, ".organum", "agora"),
    )).filter((file) => file === published.file);
    assert.equal(durableFiles.length, 1);
    const durableEnvelope = await readFile(
      join(organumProject, ".organum", "agora", published.file),
      "utf8",
    );
    assert.ok(durableEnvelope.includes(SUBSTANTIVE_BODY));
    assert.ok(durableEnvelope.includes(published.idem_key));
    assert.ok(durableEnvelope.includes(identity));

    const snapshot = machine.snapshot(state, canonicalWorkspace);
    assert.equal(snapshot.phase, "shipped");
    assert.equal(snapshot.receipt?.file, published.file);
    assert.equal(snapshot.receipt?.idem_key, published.idem_key);
    const binding: CoordinationContinuityBinding = {
      backend: options.backend,
      workspaceFingerprint: actorWorkspaceFingerprint(canonicalWorkspace),
      rootSessionID,
      role: state.role,
    };
    const finalContext = buildCoordinationContextDocument(
      state,
      null,
      snapshot,
    );
    const saved = await new FileCoordinationContinuityStore(
      stateDirectory,
      () => new Date("2026-07-25T00:00:00.000Z"),
    ).save(binding, finalContext);
    const restored = await new FileCoordinationContinuityStore(
      stateDirectory,
    ).load(binding);
    assert.ok(restored);
    assert.equal(restored.revision, 1);
    assert.equal(restored.context.publication?.phase, "shipped");
    assert.equal(
      restored.context.publication?.receipt?.file,
      published.file,
    );
    assert.equal(
      restored.context.publication?.receipt?.idem_key,
      published.idem_key,
    );
    const restoredPacket = buildPersistedCoordinationSystemPacket(
      restored.context,
    );
    assert.ok(restoredPacket.text.includes('"phase": "shipped"'));
    assert.ok(restoredPacket.text.includes(published.file));

    const path = await checkpointFile(stateDirectory);
    const checkpointMetadata = await lstat(path);
    const checkpointBytes = await readFile(path);
    for (const forbidden of [
      DUMMY_UPSTREAM_KEY,
      HOST_SECRET,
      brokerSession.token,
    ]) {
      assert.equal(checkpointBytes.includes(Buffer.from(forbidden)), false);
    }
    assert.equal(
      checkpointBytes.includes(Buffer.from(SUBSTANTIVE_BODY)),
      false,
    );
    if (process.platform !== "win32") {
      assert.equal(checkpointMetadata.mode & 0o077, 0);
    }
    const canonicalStateDirectory = await realpath(stateDirectory);
    assert.equal(
      canonicalStateDirectory.startsWith(`${canonicalWorkspace}/`),
      false,
    );
    assert.equal(
      canonicalStateDirectory.startsWith(
        `${await realpath(organumProject)}/`,
      ),
      false,
    );

    return {
      schema: "organum-code/native-adapter-closure/v1",
      gate: "pass",
      backend: options.backend,
      binary: {
        command: installation.binary,
        version: installation.version,
      },
      organum: {
        command: organumCommand,
        version: organumVersion as typeof EXPECTED_ORGANUM_VERSION,
        actualCli: true,
      },
      providerCalls: 0,
      fakeUpstreamRequests,
      auxiliaryFakeRequests,
      substantiveOutput: {
        observedInNativeOutput: true,
        explicitHandoffIntent: true,
        automaticPublication: false,
        bodyBytes: Buffer.byteLength(SUBSTANTIVE_BODY, "utf8"),
        bodySha256: createHash("sha256")
          .update(SUBSTANTIVE_BODY)
          .digest("hex"),
        nativeCleanExit: true,
      },
      publication: {
        phase: "shipped",
        terminalRequired: true,
        turnID: PUBLICATION_TURN,
        channel: "agora",
        file: published.file,
        fromID: published.from_id,
        idemKey: published.idem_key,
        publishAttempts: 2,
        uniqueDurableReceipts: 1,
        exactReplayConverged: true,
      },
      handoff: {
        statusBeforeEndOpen: true,
        endCalls: 1,
        statusAfterClosure: null,
        shippedFileMatchesReceipt: true,
        terminalReplayIssuedNoSecondEnd: true,
      },
      checkpoint: {
        schema: "organum-code/coordination-continuity/v1",
        revision: 1,
        private: true,
        workspaceDisjoint: true,
        organumStateDisjoint: true,
        phase: "shipped",
        receiptMatches: true,
        credentialMaterialPersisted: false,
        modelOutputPersisted: false,
        contextSha256: saved.context_sha256,
      },
      brokerSettlement: {
        idle: true,
        activeRequests: 0,
        forcedAbortRequests: 0,
      },
    };
  } finally {
    if (execution !== null && !completed) {
      await execution.cancel("backend-error").catch(() => undefined);
    }
    await broker?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
