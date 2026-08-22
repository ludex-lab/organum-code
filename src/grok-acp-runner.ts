import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve } from "node:path";

import {
  spawnAcpProcess,
  type AcpInitializeResult,
  type AcpSession,
  type AcpSessionUpdate,
} from "./acp-client.js";
import {
  AcpCoordinationHarness,
  type AcpCoordinatedPromptResult,
  type AcpCoordinationHarnessOptions,
  type AcpNativeExecutionGateSnapshot,
} from "./acp-coordination.js";
import {
  AcpPermissionRouter,
  BoundedAcpNativePermissionBroker,
  BoundedAcpPermissionBroker,
  BoundedAcpReadOnlyIntegrationPermissionBroker,
  TerminalAcpNativePermissionPresenter,
  TerminalAcpPermissionPresenter,
  type AcpNativePermissionPresenter,
  type AcpNativePermissionSnapshot,
  type AcpPermissionPresenter,
  type AcpPermissionSnapshot,
  type AcpReadOnlyIntegrationPermissionSnapshot,
} from "./acp-permission.js";
import {
  actorWorkspaceFingerprint,
  type AllocatedActorRuntime,
} from "./actor-runtime.js";
import {
  createGrokAdaptiveExecutionBudget,
  type ExecutionBudgetMode,
} from "./execution-budget.js";
import {
  buildGrokAcpToolAccess,
  discoverGrokPythonUserSite,
  normalizeGrokChatCompletionsSseEvent,
  prepareGrokBuildAcpLaunch,
} from "./grok-launcher.js";
import type { GrokRuntimeHealthObserver } from "./grok-runtime-health.js";
import { FileHubAdmissionLedger } from "./hub-admission-ledger.js";
import {
  brokerModeForProvider,
  buildBrokerLaunchEnvironment,
  createBrokeredProviderProfile,
  InferenceBroker,
  type InferenceBrokerLimits,
  type InferenceBrokerSettlement,
} from "./inference-broker.js";
import {
  BoundedOrganumMcpEndpoint,
  type OrganumMcpSnapshot,
} from "./organum-mcp.js";
import { isValidCellIdentity } from "./organum-identity.js";
import { parseCellIdentity } from "./organum-identity.js";
import { OrganumCli } from "./organum-cli.js";
import {
  ORGANUM_CODE_HUB_DIRECTORY_ENV,
  ORGANUM_CODE_INTENT_ENV,
  ORGANUM_CODE_ORGANUM_BIN_ENV,
  ORGANUM_CODE_PERSONA_ENV,
  ORGANUM_CODE_WORKSPACE_ENV,
} from "./plugin-protocol.js";
import {
  loadProjectEnvironment,
  type ProjectEnvironmentPacket,
} from "./project-contract.js";
import {
  ConfigurationError,
  type ProviderProfile,
} from "./provider-profile.js";
import {
  assertCodingModelCapabilities,
  providerBrokerPolicy,
} from "./provider-policy.js";
import {
  GRAPHIFY_READ_ONLY_TOOLS,
  type GraphifyLoadoutConfig,
} from "./graphify-loadout.js";
import {
  GrokAcpSignedHubLifecycle,
  type GrokAcpSignedHubSnapshot,
  type GrokAcpSignedHubTurn,
} from "./grok-acp-signed-hub.js";

export const GROK_ACP_RUNNER_PROTOCOL = 1;
export const DEFAULT_GROK_ACP_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_GROK_ACP_PROMPT_BYTES = 64 * 1024;

type CoordinationClient = AcpCoordinationHarnessOptions["organum"];

export type GrokAcpCommand =
  | { kind: "prompt"; prompt: string }
  | { kind: "signed-hub" };

export interface GrokAcpCoordinationEnvironment {
  role: string;
  intent: string;
  persona?: string;
  workspace?: string;
  hubDirectory?: string;
  organumBinary: string;
  loadout?: string;
  problemType?: string;
}

export interface GrokAcpRunnerDependencies {
  organum?: CoordinationClient;
  project?: ProjectEnvironmentPacket;
  presenter?: AcpPermissionPresenter;
  nativePresenter?: AcpNativePermissionPresenter;
  fetch?: typeof fetch;
  brokerLimits?: Partial<InferenceBrokerLimits>;
  brokerToken?: string;
  mcpToken?: string;
  graphifyLoadout?: GraphifyLoadoutConfig;
}

export interface GrokAcpRunnerOptions {
  profile: ProviderProfile;
  upstreamApiKey: string;
  environment?: NodeJS.ProcessEnv;
  directory?: string;
  actorRuntime?: AllocatedActorRuntime | null;
  prompt?: string;
  signedHubTurn?: GrokAcpSignedHubTurn;
  turnID?: string;
  timeoutMs?: number;
  executionBudgetMode?: ExecutionBudgetMode;
  signal?: AbortSignal;
  onUpdate?: (update: AcpSessionUpdate) => void | Promise<void>;
  onBrokerSettlement?: (
    settlement: InferenceBrokerSettlement,
  ) => void | Promise<void>;
  onRuntimeHealth?: GrokRuntimeHealthObserver;
  dependencies?: GrokAcpRunnerDependencies;
}

export interface GrokAcpRunnerResult {
  protocol: typeof GROK_ACP_RUNNER_PROTOCOL;
  initialized: AcpInitializeResult;
  sessionID: string;
  result: AcpCoordinatedPromptResult;
  permissions: AcpPermissionSnapshot;
  nativePermissions: AcpNativePermissionSnapshot;
  readOnlyIntegrationPermissions:
    AcpReadOnlyIntegrationPermissionSnapshot | null;
  nativeExecutionGate: AcpNativeExecutionGateSnapshot;
  mcp: OrganumMcpSnapshot;
  broker: InferenceBrokerSettlement;
  acpStderr: string;
  graphifyMcpStderr: string;
  persistentRuntime: boolean;
  signedHub: GrokAcpSignedHubSnapshot | null;
  successful: boolean;
}

function boundedPrompt(value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_GROK_ACP_PROMPT_BYTES
  ) {
    throw new ConfigurationError(
      `Grok ACP prompt must be nonempty, contain no NUL, and fit within ${MAX_GROK_ACP_PROMPT_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function parseGrokAcpCommand(
  args: readonly string[],
): GrokAcpCommand | null {
  if (args[0] !== "acp") return null;
  if (args.length === 2 && args[1] === "--signed-hub") {
    return { kind: "signed-hub" };
  }
  const promptArguments = args[1] === "--" ? args.slice(2) : args.slice(1);
  if (promptArguments.length !== 1) {
    throw new ConfigurationError(
      "Grok ACP requires one quoted prompt or the exact --signed-hub mode",
    );
  }
  return { kind: "prompt", prompt: boundedPrompt(promptArguments[0]) };
}

export function parseGrokAcpTimeout(
  value: string | undefined,
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_GROK_ACP_TIMEOUT_MS;
  }
  if (!/^[1-9][0-9]*$/.test(value.trim())) {
    throw new ConfigurationError(
      "ORGANUM_CODE_ACP_TIMEOUT_MS must be a positive integer",
    );
  }
  const timeout = Number(value.trim());
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > 4 * 60 * 60 * 1_000
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_ACP_TIMEOUT_MS must be between 1000 and 14400000",
    );
  }
  return timeout;
}

function canonicalHubDimension(
  value: string,
  variable: string,
): string {
  if (!isValidCellIdentity(value)) {
    throw new ConfigurationError(
      `${variable} must use the canonical Organum identity grammar`,
    );
  }
  return value.toLowerCase();
}

function absoluteDirectory(
  value: string,
  variable: string,
): string {
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new ConfigurationError(
      `${variable} must be a nonempty absolute path`,
    );
  }
  return resolve(value);
}

export function readGrokAcpCoordinationEnvironment(
  profile: ProviderProfile,
  environment: NodeJS.ProcessEnv,
): GrokAcpCoordinationEnvironment {
  const intent =
    environment[ORGANUM_CODE_INTENT_ENV]?.trim() ||
    `${profile.role} Grok ACP session`;
  if (
    intent.includes("\0") ||
    Buffer.byteLength(intent, "utf8") > 512
  ) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_INTENT_ENV} must be at most 512 UTF-8 bytes without NUL`,
    );
  }

  const rawPersona = environment[ORGANUM_CODE_PERSONA_ENV]?.trim();
  const rawWorkspace = environment[ORGANUM_CODE_WORKSPACE_ENV]?.trim();
  if ((rawPersona === undefined) !== (rawWorkspace === undefined)) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must be set together`,
    );
  }
  const persona =
    rawPersona === undefined
      ? undefined
      : canonicalHubDimension(rawPersona, ORGANUM_CODE_PERSONA_ENV);
  const workspace =
    rawWorkspace === undefined
      ? undefined
      : canonicalHubDimension(rawWorkspace, ORGANUM_CODE_WORKSPACE_ENV);

  const rawHubDirectory =
    environment[ORGANUM_CODE_HUB_DIRECTORY_ENV]?.trim();
  const hubDirectory =
    rawHubDirectory === undefined
      ? undefined
      : absoluteDirectory(
          rawHubDirectory,
          ORGANUM_CODE_HUB_DIRECTORY_ENV,
        );
  const organumBinary =
    environment[ORGANUM_CODE_ORGANUM_BIN_ENV]?.trim() || "organum";
  if (
    organumBinary.includes("\0") ||
    Buffer.byteLength(organumBinary, "utf8") > 1_024
  ) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_ORGANUM_BIN_ENV} must be a bounded executable name without NUL`,
    );
  }
  const coordinationRole = environment.ORGANUM_CODE_COORDINATION_ROLE?.trim() || profile.role;
  if (!isValidCellIdentity(coordinationRole)) {
    throw new ConfigurationError("ORGANUM_CODE_COORDINATION_ROLE must use the canonical Organum identity grammar");
  }
  return {
    role: coordinationRole,
    intent,
    ...(persona === undefined ? {} : { persona }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(hubDirectory === undefined ? {} : { hubDirectory }),
    organumBinary,
    ...(environment.ORGANUM_CODE_LOADOUT?.trim() ? { loadout: environment.ORGANUM_CODE_LOADOUT.trim() } : {}),
    ...(environment.ORGANUM_CODE_PROBLEM_TYPE?.trim() ? { problemType: environment.ORGANUM_CODE_PROBLEM_TYPE.trim() } : {}),
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hubLedgerFor(
  declaration: GrokAcpCoordinationEnvironment,
  actorRuntime: AllocatedActorRuntime | null,
  directory: string,
): FileHubAdmissionLedger | undefined {
  if (declaration.persona === undefined) return undefined;
  if (actorRuntime === null) {
    throw new ConfigurationError(
      "Grok ACP hub participation requires --actor so semantic ACK state survives process restart",
    );
  }
  const supervisorState = dirname(actorRuntime.bindingPath);
  if (
    inside(directory, supervisorState) ||
    inside(supervisorState, directory)
  ) {
    throw new ConfigurationError(
      "Grok ACP supervisor state must be disjoint from the workspace",
    );
  }
  if (
    declaration.hubDirectory !== undefined &&
    (inside(declaration.hubDirectory, supervisorState) ||
      inside(supervisorState, declaration.hubDirectory))
  ) {
    throw new ConfigurationError(
      "Grok ACP supervisor state must be disjoint from the Organum hub directory",
    );
  }
  return new FileHubAdmissionLedger(supervisorState);
}

export function textFromAcpAgentUpdate(update: AcpSessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  const content =
    update.content !== null &&
    typeof update.content === "object" &&
    !Array.isArray(update.content)
      ? update.content as Record<string, unknown>
      : null;
  return typeof content?.text === "string" ? content.text : "";
}

export async function runGrokAcp(
  options: GrokAcpRunnerOptions,
): Promise<GrokAcpRunnerResult> {
  const environment = options.environment ?? process.env;
  const directory = await realpath(resolve(options.directory ?? process.cwd()));
  const actorRuntime = options.actorRuntime ?? null;
  const dependencies = options.dependencies ?? {};
  const hasPrompt = options.prompt !== undefined;
  const hasSignedHubTurn = options.signedHubTurn !== undefined;
  if (hasPrompt === hasSignedHubTurn) {
    throw new ConfigurationError(
      "Grok ACP requires exactly one of prompt or signedHubTurn",
    );
  }
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_GROK_ACP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 4 * 60 * 60 * 1_000
  ) {
    throw new ConfigurationError(
      "Grok ACP timeout must be between 1000 and 14400000 milliseconds",
    );
  }
  if (options.signal?.aborted) {
    throw new DOMException("Grok ACP run aborted before start", "AbortError");
  }
  if (
    options.executionBudgetMode === "adaptive" &&
    options.profile.protocol !== "chat-completions"
  ) {
    throw new ConfigurationError(
      "Adaptive execution budget requires Grok ACP with chat-completions",
    );
  }
  if (
    actorRuntime !== null &&
    (actorRuntime.backend !== "grok" ||
      actorRuntime.workspaceFingerprint !==
        actorWorkspaceFingerprint(directory))
  ) {
    throw new ConfigurationError(
      "Grok ACP actor runtime does not match this backend and canonical workspace",
    );
  }
  if (
    hasSignedHubTurn &&
    (actorRuntime === null ||
      (options.profile.role !== "critic" && options.profile.role !== "reviewer"))
  ) {
    throw new ConfigurationError(
      "Signed Hub Grok ACP requires a persistent critic or reviewer actor",
    );
  }
  const signedHubLifecycle = options.signedHubTurn === undefined
    ? null
    : new GrokAcpSignedHubLifecycle(options.signedHubTurn);
  const prompt = signedHubLifecycle === null
    ? boundedPrompt(options.prompt as string)
    : await signedHubLifecycle.prepare();
  const declaration = readGrokAcpCoordinationEnvironment(
    options.profile,
    environment,
  );
  const hubLedger = hubLedgerFor(declaration, actorRuntime, directory);
  const project =
    dependencies.project ??
    await loadProjectEnvironment(directory, environment);
  const organum =
    dependencies.organum ??
    new OrganumCli({
      binary: declaration.organumBinary,
      cwd: directory,
      env: environment,
      hubDirectory: declaration.hubDirectory,
      redactions: [options.upstreamApiKey],
    });
  let terminalSession: AcpSession | undefined;
  const harness = new AcpCoordinationHarness({
    organum,
    directory,
    role: declaration.role,
    intent: declaration.intent,
    persona: declaration.persona,
    workspace: declaration.workspace,
    loadout: declaration.loadout,
    problemType: declaration.problemType,
    ...(environment.ORGANUM_CODE_CELL?.trim()
      ? { cellIdentity: parseCellIdentity(environment.ORGANUM_CODE_CELL.trim()) }
      : {}),
    project,
    hubLedger,
    onTerminalPublication: async () =>
      await terminalSession?.cancel() ?? false,
  });
  const permissionBroker = new BoundedAcpPermissionBroker({
    presenter:
      dependencies.presenter ?? new TerminalAcpPermissionPresenter(),
    isSessionActive: (sessionID) =>
      harness.isPermissionActive(sessionID),
    admissionIssue: (_operation, arguments_) =>
      harness.publicationAdmissionIssue(arguments_),
  });
  const nativePermissionBroker = new BoundedAcpNativePermissionBroker({
    presenter:
      dependencies.nativePresenter ??
      new TerminalAcpNativePermissionPresenter(),
    isSessionActive: (sessionID) =>
      harness.isPermissionActive(sessionID),
    admissionIssue: (request) =>
      harness.nativePermissionAdmissionIssue(request.arguments),
    onGrant: (request) =>
      harness.observeNativePermissionGrant(request.arguments),
  });
  const readOnlyIntegrationPermissionBroker =
    dependencies.graphifyLoadout?.loadout === "graphify"
      ? new BoundedAcpReadOnlyIntegrationPermissionBroker({
          allowedTools: GRAPHIFY_READ_ONLY_TOOLS,
          isSessionActive: (sessionID) =>
            harness.isPermissionActive(sessionID),
        })
      : undefined;
  const permissionRouter = new AcpPermissionRouter(
    permissionBroker,
    nativePermissionBroker,
    undefined,
    readOnlyIntegrationPermissionBroker,
  );
  const permissionGuardedTools = harness.tools().map((tool) => {
    const operation =
      tool.name === "organum_publish"
        ? "organum_publish"
        : tool.name === "organum_handoff"
          ? "organum_handoff"
          : null;
    if (operation === null) {
      throw new Error(
        "Grok ACP harness exposed a tool outside its permission surface",
      );
    }
    return {
      ...tool,
      async call(arguments_: Record<string, unknown>) {
        permissionBroker.consumeOneShotGrant(operation, arguments_);
        return await tool.call(arguments_);
      },
    };
  });
  const mcp = new BoundedOrganumMcpEndpoint(
    permissionGuardedTools,
    dependencies.mcpToken,
  );
  assertCodingModelCapabilities(options.profile);
  const mode = brokerModeForProvider(options.profile);
  const providerPolicy = providerBrokerPolicy(options.profile, mode);
  const broker = new InferenceBroker({
    upstreamBaseURL: options.profile.baseURL,
    upstreamApiKey: options.upstreamApiKey,
    upstreamModel: options.profile.modelID,
    mode,
    upstreamHeaders: providerPolicy.upstreamHeaders,
    sseTransform:
      options.profile.protocol === "chat-completions"
        ? normalizeGrokChatCompletionsSseEvent
        : undefined,
    executionBudget:
      options.executionBudgetMode === "adaptive"
        ? createGrokAdaptiveExecutionBudget(options.profile.modelID)
        : undefined,
    requestTransform: (body) => harness.applyNativeExecutionToolGate(body),
    finalRequestTransform: providerPolicy.requestTransform,
    auxiliaryHandler: mcp.handler,
    fetch: dependencies.fetch,
    limits: dependencies.brokerLimits,
    token: dependencies.brokerToken,
  });

  const lifecycle = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => {
    lifecycle.abort(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    lifecycle.abort(
      new Error(`Grok ACP timed out after ${timeoutMs} milliseconds`),
    );
  }, timeoutMs);
  let launch:
    | Awaited<ReturnType<typeof prepareGrokBuildAcpLaunch>>
    | undefined;
  let connection: ReturnType<typeof spawnAcpProcess> | undefined;
  let removePermissionHandler: (() => void) | undefined;
  let settlement: InferenceBrokerSettlement | undefined;
  try {
    const brokerSession = await broker.start();
    const brokeredProfile = createBrokeredProviderProfile(
      options.profile,
      brokerSession,
    );
    const launchEnvironment = buildBrokerLaunchEnvironment(
      environment,
      options.profile.apiKeyEnv,
      brokerSession,
    );
    const toolAccess = buildGrokAcpToolAccess(
      project,
      discoverGrokPythonUserSite(project.commands[0], environment),
    );
    const graphifyReadablePaths = (dependencies.graphifyLoadout?.mcpServers ?? [])
      .map((server) => resolve(dirname(server.command), ".."));
    launch = await prepareGrokBuildAcpLaunch(
      brokeredProfile,
      launchEnvironment,
      directory,
      {
        ...(actorRuntime === null
          ? {}
          : { runtimeDirectory: actorRuntime.runtimeDirectory }),
        toolEnvironment: toolAccess.environment,
        readablePaths: [...toolAccess.readablePaths, ...graphifyReadablePaths],
        onRuntimeHealth: options.onRuntimeHealth,
      },
    );
    const prepared = launch.containment;
    connection = spawnAcpProcess({
      executable: prepared.spawn.executable,
      args: prepared.spawn.args,
      cwd: prepared.cwd,
      env: prepared.spawn.env,
    });
    removePermissionHandler = connection.client.onRequest(
      "session/request_permission",
      permissionRouter.handle,
    );
    const initialized = await connection.client.initialize(
      {},
      { signal: lifecycle.signal, timeoutMs: Math.min(timeoutMs, 30_000) },
    );
    const graphifyMcp = dependencies.graphifyLoadout?.mcpServers ?? [];
    const session = await connection.client.newSession(
      directory,
      [
        mcp.descriptor(brokerSession.origin),
        ...graphifyMcp.map((server) => ({
          name: server.name,
          command: server.command,
          args: [...server.args],
          env: [],
        })),
      ],
      { signal: lifecycle.signal, timeoutMs: Math.min(timeoutMs, 30_000) },
    );
    terminalSession = session;
    permissionRouter.bindSession(session.sessionID);
    const result = await harness.prompt(
      session,
      [{ type: "text", text: prompt }],
      {
        turnID: options.turnID ?? randomUUID(),
        timeoutMs: timeoutMs + 1_000,
        signal: lifecycle.signal,
        onUpdate: options.onUpdate,
        ...(signedHubLifecycle === null
          ? {}
          : {
              beforePrompt: async () =>
                await signedHubLifecycle.beginExposure(),
            }),
      },
    );
    const successful =
      result.coordinationConformant &&
      (
        result.stopReason === "end_turn" ||
        result.terminalPublicationEnforced
      );
    const signedHub = signedHubLifecycle === null
      ? null
      : await signedHubLifecycle.complete(successful);
    const permissionSnapshot = permissionBroker.snapshot();
    const nativePermissionSnapshot = nativePermissionBroker.snapshot();
    const nativeExecutionGate = harness.nativeExecutionGateSnapshot();

    removePermissionHandler();
    removePermissionHandler = undefined;
    await connection.close();
    const acpStderr = connection.stderr();
    connection = undefined;
    const graphifyMcpStderr = await readFile(
      resolve(launch.runtimeDirectory, "logs", "mcp", "graphify.stderr.log"),
      "utf8",
    ).catch(() => "");
    await launch.close();
    launch = undefined;
    settlement = await broker.settle();
    return {
      protocol: GROK_ACP_RUNNER_PROTOCOL,
      initialized,
      sessionID: session.sessionID,
      result,
      permissions: permissionSnapshot,
      nativePermissions: nativePermissionSnapshot,
      readOnlyIntegrationPermissions:
        readOnlyIntegrationPermissionBroker?.snapshot() ?? null,
      nativeExecutionGate,
      mcp: mcp.snapshot(),
      broker: settlement,
      acpStderr,
      graphifyMcpStderr,
      persistentRuntime: actorRuntime !== null,
      signedHub,
      successful,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Grok ACP timed out after ${timeoutMs} milliseconds`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", forwardAbort);
    removePermissionHandler?.();
    await connection?.close().catch(() => undefined);
    await launch?.close().catch(() => undefined);
    if (settlement === undefined) {
      settlement = await broker.settle().catch(() => undefined);
    }
    try {
      if (settlement !== undefined) {
        await options.onBrokerSettlement?.(settlement);
      }
    } finally {
      await broker.close().catch(() => undefined);
    }
  }
}
