import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORGANUM_PUBLICATION_INPUT_SCHEMA,
  parseAcpPublicationArguments,
} from "./acp-coordination.js";
import {
  classifyStickyGoal,
  type SessionCoordinationState,
} from "./coordination-bootstrap.js";
import { SessionPublicationStateMachine } from "./coordination-publish.js";
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
import {
  ReplayProbePublicationClient,
} from "./native-adapter-closure.js";
import type { NativeBenchmarkBackendID } from "./native-adapter-conformance.js";
import {
  inspectNativeAdapter,
  NATIVE_CLAUDE_ADVERTISED_MODEL,
} from "./native-adapter-fixture.js";
import {
  createNativeProductFixtureDriver,
} from "./native-product-fixture.js";
import {
  BoundedOrganumMcpEndpoint,
  ORGANUM_MCP_SERVER_NAME,
  type BoundedMcpTool,
} from "./organum-mcp.js";
import {
  buildOrganumCliEnvironment,
  OrganumCli,
} from "./organum-cli.js";
import { deriveNativeCellIdentity } from "./organum-identity.js";
import { loadProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  SoftwareBenchmarkCompletion,
  SoftwareBenchmarkExecution,
} from "./software-benchmark.js";

const REQUEST_MARKER = "ORGANUM_S10_TYPED_PRODUCT_HANDOFF";
const HANDOFF_BODY =
  "ORGANUM_S10_TYPED_PRODUCT_RESULT exact supervisor-owned closure evidence";
const FINAL_TEXT = "ORGANUM_S10_TYPED_HANDOFF_OK";
const TURN_ID = "s10-native-product-turn";
const DUMMY_UPSTREAM_KEY = "s10-product-upstream-key-never-persisted";
const HOST_SECRET = "s10-product-host-secret-never-persisted";
const EXPECTED_ORGANUM_VERSION = "organum 0.1.3";
const REQUEST_TIMEOUT_MS = 60_000;

type JsonRecord = Record<string, unknown>;

export interface NativeProductClosureReceipt {
  schema: "organum-code/native-product-closure/v1";
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
  productPath: {
    transport: "authenticated-http" | "immutable-stdio-http-bridge";
    supervisorOwned: true;
    rawOrganumAccess: false;
    outputMarkerAccepted: false;
    qualifiedHandoffObservedByProvider: true;
    nativeCleanExit: true;
  };
  mcp: {
    server: typeof ORGANUM_MCP_SERVER_NAME;
    tools: ["organum_publish", "organum_handoff"];
    initialized: number;
    listRequests: number;
    toolCalls: 1;
    toolErrors: 0;
    rejectedRequests: 0;
    calledTools: ["organum_handoff"];
  };
  publication: {
    phase: "shipped";
    turnID: typeof TURN_ID;
    file: string;
    fromID: string;
    idemKey: string;
    bodyBytes: number;
    bodySha256: string;
    publishAttempts: 2;
    uniqueDurableReceipts: 1;
    endCalls: 1;
    terminalReplayIssuedNoSecondWrite: true;
  };
  credentialBoundary: {
    separateMcpCapability: true;
    upstreamCredentialExposed: false;
    hostSecretExposed: false;
    capabilityPersistedInWorkspace: false;
    capabilityPersistedInReceipt: false;
    ephemeralProjectionRemoved: true;
  };
  brokerSettlement: {
    idle: true;
    activeRequests: 0;
    forcedAbortRequests: 0;
  };
}

export interface QualifyNativeProductClosureOptions {
  backend: NativeBenchmarkBackendID;
  env?: NodeJS.ProcessEnv;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
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

function messages(body: JsonObject): JsonRecord[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((item) => {
    const message = record(item);
    return message === null ? [] : [message];
  });
}

function requestText(body: JsonObject): string {
  return messages(body).map((message) => messageText(message.content)).join("\n");
}

function systemText(body: JsonObject): string {
  const first = messages(body).find((message) => message.role === "system");
  return first === undefined ? "" : messageText(first.content);
}

function toolNames(body: JsonObject): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((entry) => {
    const fn = record(record(entry)?.function);
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}

function toolMessageText(body: JsonObject): string {
  return messages(body)
    .filter((message) => message.role === "tool")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? null)
    )
    .join("\n");
}

function shippedToolResult(body: JsonObject): boolean {
  const text = toolMessageText(body);
  return (
    /["\\]phase[\\"]*\s*[:=]\s*[\\"]*shipped/i.test(text) ||
    /phase.{0,32}shipped/i.test(text)
  );
}

function qualifiedHandoffFromToolResult(body: JsonObject): string | null {
  const match =
    /([A-Za-z0-9_.-]+__organum_handoff)\b/.exec(toolMessageText(body));
  return match?.[1] ?? null;
}

function usage(): JsonObject {
  return { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
}

function eventStream(events: readonly JsonObject[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function completionChunk(
  body: JsonObject,
  delta: JsonObject,
  finishReason: "stop" | "tool_calls" | null,
  id: string,
): JsonObject {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: typeof body.model === "string" ? body.model : "solar-open2",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
    ...(finishReason === null ? {} : { usage: usage() }),
  };
}

function textResponse(
  body: JsonObject,
  content: string,
  id: string,
): Response {
  const model = typeof body.model === "string" ? body.model : "solar-open2";
  if (body.stream === true) {
    return eventStream([
      completionChunk(body, { role: "assistant", content }, null, id),
      completionChunk(body, {}, "stop", id),
    ]);
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

function toolCallResponse(
  body: JsonObject,
  name: string,
  arguments_: JsonRecord,
  id: string,
): Response {
  const call = {
    index: 0,
    id: `call-${id}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(arguments_),
    },
  };
  if (body.stream === true) {
    return eventStream([
      completionChunk(
        body,
        { role: "assistant", tool_calls: [call] },
        null,
        id,
      ),
      completionChunk(body, {}, "tool_calls", id),
    ]);
  }
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created: 1,
    model: typeof body.model === "string" ? body.model : "solar-open2",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [call],
      },
      finish_reason: "tool_calls",
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
      `S10 ${command} ${args[0] ?? ""} failed: ${
        result.error?.message ?? result.stderr.trim()
      }`,
    );
  }
  return result.stdout.trim();
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
              `native product path did not complete S10 within ${REQUEST_TIMEOUT_MS}ms`,
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

async function waitForMcpDiscovery(
  endpoint: BoundedOrganumMcpEndpoint,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (endpoint.snapshot().listRequests < 1) {
    if (Date.now() >= deadline) {
      throw new Error("Deep Code MCP discovery did not complete before readiness turn");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  // tools/list is answered before Deep Code copies the definitions into the
  // next provider request. Yield one bounded application window.
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}

function createBroker(
  backend: NativeBenchmarkBackendID,
  profile: ReturnType<typeof loadProviderProfile>,
  fetch: typeof globalThis.fetch,
  endpoint: BoundedOrganumMcpEndpoint,
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
    auxiliaryHandler: endpoint.handler,
    fetch,
  });
}

export async function qualifyNativeProductClosure(
  options: QualifyNativeProductClosureOptions,
): Promise<NativeProductClosureReceipt> {
  const env = options.env ?? process.env;
  const mcpToken = randomBytes(32).toString("base64url");
  const installation = inspectNativeAdapter(options.backend, env);
  const root = await mkdtemp(join(tmpdir(), "organum-code-product-live-"));
  const workspace = join(root, "workspace");
  const organumProject = join(root, "organum-project");
  let broker: InferenceBroker | null = null;
  let execution: SoftwareBenchmarkExecution | null = null;
  let completed = false;

  try {
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(organumProject, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(workspace, "README.md"),
      "S10 typed native product closure fixture\n",
      "utf8",
    );
    const commandEnvironment = buildOrganumCliEnvironment(env);
    run("git", ["init", "--quiet"], workspace, commandEnvironment);
    run("git", ["add", "--all"], workspace, commandEnvironment);
    run(
      "git",
      [
        "-c",
        "user.name=Organum Code Product",
        "-c",
        "user.email=product@invalid",
        "commit",
        "--quiet",
        "-m",
        "product baseline",
      ],
      workspace,
      commandEnvironment,
    );
    run("git", ["init", "--quiet"], organumProject, commandEnvironment);

    const organumCommand =
      env.ORGANUM_CODE_ORGANUM_BIN?.trim() || "organum";
    const organumVersion = run(
      organumCommand,
      ["--version"],
      organumProject,
      commandEnvironment,
    );
    assert.equal(organumVersion, EXPECTED_ORGANUM_VERSION);
    run(
      organumCommand,
      ["init", "--agent", `organum-code-s10-${options.backend}`],
      organumProject,
      commandEnvironment,
    );

    const rootSessionID = `organum-s10-${options.backend}-root-v1`;
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
      intent: "S10 typed native product closure qualification",
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
          : ["No canonical goal in the isolated S10 product fixture"],
    };
    const publicationClient = new ReplayProbePublicationClient(
      cli,
      join(organumProject, ".organum", "agora"),
    );
    const machine = new SessionPublicationStateMachine(publicationClient);
    const obligation = await machine.beginTurn(state, workspace, TURN_ID);
    assert.equal(obligation.phase, "output_pending");

    const calledTools: string[] = [];
    const publicationTool = (handoff: boolean): BoundedMcpTool => ({
      name: handoff ? "organum_handoff" : "organum_publish",
      description: handoff
        ? "Terminal close-out. Publish the exact team-facing result, verify its durable receipt, and close the Organum session with shipped evidence."
        : "Publish one bounded team-facing contribution without closing the Organum session.",
      inputSchema: { ...ORGANUM_PUBLICATION_INPUT_SCHEMA },
      call: async (arguments_) => {
        const input = parseAcpPublicationArguments(arguments_);
        calledTools.push(handoff ? "organum_handoff" : "organum_publish");
        return await machine.publish(state, workspace, {
          messageID: TURN_ID,
          body: input.body,
          to: input.to,
          topic: "review",
          thread: input.thread,
          replyTo: input.replyTo,
          displayFrom: input.displayFrom,
          escalate: input.escalate,
          handoff,
        });
      },
    });
    const endpoint = new BoundedOrganumMcpEndpoint(
      [publicationTool(false), publicationTool(true)],
      mcpToken,
    );

    const upstreamProfile = loadProviderProfile({
      ORGANUM_CODE_PROVIDER_ID: "s10-product",
      ORGANUM_CODE_PROVIDER_NAME: "S10 product fake upstream",
      ORGANUM_CODE_BASE_URL: "https://s10-product.invalid/v1",
      ORGANUM_CODE_MODEL: "solar-open2",
      ORGANUM_CODE_MODEL_NAME: "Solar Open 2 product alias",
      ORGANUM_CODE_API_KEY_ENV: "ORGANUM_CODE_S10_PRODUCT_KEY",
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
    let mainRequests = 0;
    let qualifiedHandoffObservedByProvider = false;
    let deepCodeReadinessTurnIssued = false;
    const observedMainToolSets: string[][] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      fakeUpstreamRequests += 1;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.model, "solar-open2");
      const id = `s10-product-${options.backend}-${fakeUpstreamRequests}`;
      const names = toolNames(body);
      const system = systemText(body);
      if (
        system.startsWith("You are tasked with generating the session title.") ||
        (!requestText(body).includes(REQUEST_MARKER) &&
          !shippedToolResult(body))
      ) {
        auxiliaryFakeRequests += 1;
        return textResponse(body, "S10 typed product closure", id);
      }
      mainRequests += 1;
      observedMainToolSets.push(names);
      if (shippedToolResult(body)) {
        return textResponse(body, FINAL_TEXT, id);
      }

      const direct = names.find((name) =>
        name !== "use_tool" &&
        name !== "search_tool" &&
        name.endsWith("organum_handoff")
      );
      if (direct !== undefined) {
        qualifiedHandoffObservedByProvider = true;
        return toolCallResponse(
          body,
          direct,
          { body: HANDOFF_BODY, topic: "review" },
          id,
        );
      }
      if (names.includes("search_tool") && names.includes("use_tool")) {
        const qualified = qualifiedHandoffFromToolResult(body);
        if (qualified === null) {
          return toolCallResponse(
            body,
            "search_tool",
            { query: "organum_handoff", limit: 10 },
            id,
          );
        }
        qualifiedHandoffObservedByProvider = true;
        return toolCallResponse(
          body,
          "use_tool",
          {
            tool_name: qualified,
            tool_input: { body: HANDOFF_BODY, topic: "review" },
          },
          id,
        );
      }
      if (
        options.backend === "deepcode" &&
        !deepCodeReadinessTurnIssued &&
        names.includes("read")
      ) {
        deepCodeReadinessTurnIssued = true;
        await waitForMcpDiscovery(endpoint);
        return toolCallResponse(
          body,
          "read",
          { file_path: "README.md", offset: 1, limit: 20 },
          id,
        );
      }
      return textResponse(
        body,
        `ORGANUM_S10_MISSING_HANDOFF_TOOL ${names.join(",")}`,
        id,
      );
    };

    broker = createBroker(
      options.backend,
      upstreamProfile,
      fakeFetch,
      endpoint,
    );
    const brokerSession = await broker.start();
    const mcpServer = endpoint.descriptor(brokerSession.origin);
    const brokeredProfile = createBrokeredProviderProfile(
      upstreamProfile,
      brokerSession,
    );
    const launchEnvironment = buildBrokerLaunchEnvironment(
      {
        ...env,
        ORGANUM_CODE_S10_HOST_SECRET: HOST_SECRET,
      },
      upstreamProfile.apiKeyEnv,
      brokerSession,
    );
    const driver = createNativeProductFixtureDriver({
      backend: options.backend,
      profile: brokeredProfile,
      env: launchEnvironment,
      session: brokerSession,
      advertisedClaudeModel: NATIVE_CLAUDE_ADVERTISED_MODEL,
      usageSnapshot: () => broker!.snapshot(),
      diagnosticRedactions: [
        brokerSession.token,
        mcpToken,
        DUMMY_UPSTREAM_KEY,
        HOST_SECRET,
      ],
      mcpServer,
    });
    execution = await driver.start({
      taskID: "qualification/native-product-closure",
      workspace,
      prompt: [
        REQUEST_MARKER,
        "Call the exact bounded Organum handoff tool with the final result.",
        "Do not print or encode a handoff marker.",
        "After the tool returns phase=shipped, return only the short acknowledgement.",
      ].join("\n\n"),
      sessionLabel: "native-product-closure",
    }, brain);
    const completion = await waitForCompletion(execution);
    completed = true;
    assert.equal(completion.cleanExit, true);
    assert.equal(completion.terminalOutcome.reason, "clean-exit");
    assert.deepEqual(completion.containmentViolations, []);
    assert.deepEqual(completion.adapterViolations, []);
    assert.deepEqual(completion.adapterWarnings, []);
    assert.ok(mainRequests >= 2);
    assert.equal(
      qualifiedHandoffObservedByProvider,
      true,
      `${options.backend} omitted a qualified handoff from product requests: ${JSON.stringify({
        toolSets: observedMainToolSets,
        mcp: endpoint.snapshot(),
      })}`,
    );

    const diagnostic = driver.actorDiagnostic();
    assert.ok(diagnostic);
    const nativeOutput = [
      diagnostic.stdout.text,
      diagnostic.stderr.text,
      diagnostic.deepCodeState?.text ?? "",
    ].join("\n");
    assert.ok(nativeOutput.includes(FINAL_TEXT));
    assert.equal(nativeOutput.includes("ORGANUM_S9_HANDOFF"), false);

    const mcp = endpoint.snapshot();
    assert.ok(mcp.initialized >= 1);
    assert.ok(mcp.listRequests >= 1);
    assert.equal(mcp.toolCalls, 1);
    assert.equal(mcp.toolErrors, 0);
    assert.equal(mcp.rejectedRequests, 0);
    assert.deepEqual(calledTools, ["organum_handoff"]);

    const snapshot = machine.snapshot(state, workspace);
    assert.equal(snapshot.phase, "shipped");
    assert.ok(snapshot.receipt);
    assert.equal(publicationClient.publishAttempts, 2);
    assert.equal(publicationClient.uniqueFiles.size, 1);
    assert.equal(publicationClient.endCalls, 1);
    assert.deepEqual(
      publicationClient.endedFiles,
      [snapshot.receipt.file],
    );
    assert.equal(await cli.sessionStatus(identity), null);

    const replay = await machine.publish(state, workspace, {
      messageID: TURN_ID,
      body: HANDOFF_BODY,
      topic: "review",
      handoff: true,
    });
    assert.equal(replay.phase, "shipped");
    assert.equal(publicationClient.publishAttempts, 2);
    assert.equal(publicationClient.endCalls, 1);

    const durableEnvelope = await readFile(
      join(
        organumProject,
        ".organum",
        "agora",
        snapshot.receipt.file,
      ),
      "utf8",
    );
    assert.ok(durableEnvelope.includes(HANDOFF_BODY));
    assert.ok(durableEnvelope.includes(snapshot.receipt.idem_key));
    assert.equal(durableEnvelope.includes(mcpToken), false);
    assert.equal(durableEnvelope.includes(DUMMY_UPSTREAM_KEY), false);
    assert.equal(durableEnvelope.includes(HOST_SECRET), false);
    const workspaceFiles = await readdir(workspace);
    for (const file of workspaceFiles.filter((name) => name !== ".git")) {
      const bytes = await readFile(join(workspace, file));
      assert.equal(bytes.includes(Buffer.from(mcpToken)), false);
      assert.equal(bytes.includes(Buffer.from(DUMMY_UPSTREAM_KEY)), false);
      assert.equal(bytes.includes(Buffer.from(HOST_SECRET)), false);
    }

    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    assert.equal(settlement.idle, true);
    assert.equal(settlement.snapshot.activeRequests, 0);
    assert.equal(settlement.forcedAbortRequests, 0);
    await broker.close();

    return {
      schema: "organum-code/native-product-closure/v1",
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
      productPath: {
        transport:
          options.backend === "deepcode"
            ? "immutable-stdio-http-bridge"
            : "authenticated-http",
        supervisorOwned: true,
        rawOrganumAccess: false,
        outputMarkerAccepted: false,
        qualifiedHandoffObservedByProvider: true,
        nativeCleanExit: true,
      },
      mcp: {
        server: ORGANUM_MCP_SERVER_NAME,
        tools: ["organum_publish", "organum_handoff"],
        initialized: mcp.initialized,
        listRequests: mcp.listRequests,
        toolCalls: 1,
        toolErrors: 0,
        rejectedRequests: 0,
        calledTools: ["organum_handoff"],
      },
      publication: {
        phase: "shipped",
        turnID: TURN_ID,
        file: snapshot.receipt.file,
        fromID: snapshot.receipt.from_id,
        idemKey: snapshot.receipt.idem_key,
        bodyBytes: snapshot.receipt.body_bytes,
        bodySha256: createHash("sha256")
          .update(HANDOFF_BODY)
          .digest("hex"),
        publishAttempts: 2,
        uniqueDurableReceipts: 1,
        endCalls: 1,
        terminalReplayIssuedNoSecondWrite: true,
      },
      credentialBoundary: {
        separateMcpCapability: true,
        upstreamCredentialExposed: false,
        hostSecretExposed: false,
        capabilityPersistedInWorkspace: false,
        capabilityPersistedInReceipt: false,
        ephemeralProjectionRemoved: true,
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
