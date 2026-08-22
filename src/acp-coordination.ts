import type {
  AcpPromptOptions,
  AcpPromptResult,
  AcpSession,
  AcpSessionUpdate,
} from "./acp-client.js";
import { DirectRootSessionResolver } from "./backend-session.js";
import {
  SessionCoordinationBootstrapper,
  type BootstrapSessionRequest,
  type OrganumJoinClient,
  type SessionCoordinationState,
} from "./coordination-bootstrap.js";
import { buildCoordinationSystemPacket } from "./coordination-context.js";
import {
  SessionCoordinationPoller,
  type OrganumPollingClient,
  type TurnCoordinationState,
} from "./coordination-polling.js";
import {
  PUBLICATION_MAX_BODY_BYTES,
  SessionPublicationStateMachine,
  type PublicationClient,
  type PublicationEvidence,
  type PublicationSnapshot,
} from "./coordination-publish.js";
import type { HubAdmissionLedger } from "./hub-admission-ledger.js";
import {
  deriveGrokAcpCellIdentity,
  type CellIdentity,
} from "./organum-identity.js";
import {
  ORGANUM_MCP_SERVER_NAME,
  type BoundedMcpTool,
} from "./organum-mcp.js";
import type { ProjectEnvironmentPacket } from "./project-contract.js";

export const ACP_COORDINATION_PROTOCOL = 1;

type CoordinationClient =
  & OrganumJoinClient
  & OrganumPollingClient
  & PublicationClient;

export interface AcpCoordinationHarnessOptions {
  organum: CoordinationClient;
  directory: string;
  role: string;
  intent?: string;
  persona?: string;
  workspace?: string;
  loadout?: string;
  problemType?: string;
  cellIdentity?: CellIdentity;
  project?: ProjectEnvironmentPacket | null;
  hubLedger?: HubAdmissionLedger;
  onTerminalPublication?: () => boolean | Promise<boolean>;
}

export interface AcpCoordinatedPromptOptions extends AcpPromptOptions {
  turnID: string;
  beforePrompt?: () => void | Promise<void>;
}

export interface AcpCoordinatedPromptResult extends AcpPromptResult {
  protocol: typeof ACP_COORDINATION_PROTOCOL;
  outputText: string;
  cell: CellIdentity;
  coordinationAdmitted: boolean;
  publication: PublicationSnapshot;
  coordinationConformant: boolean;
  terminalPublicationEnforced: boolean;
}

export interface AcpNativeExecutionGateSnapshot {
  protocol: typeof ACP_COORDINATION_PROTOCOL;
  executeGranted: boolean;
  requestRewrites: number;
  toolsRemoved: number;
  executeToolsRemoved: number;
  outOfRoleToolsRemoved: number;
  blockedExecuteRequests: number;
  blockedWriteRequests: number;
  lastBlockedExecuteClass:
    | "already_consumed"
    | "missing_declaration"
    | "missing_command"
    | "argument_suffix"
    | "different_command"
    | null;
  parallelRequestsConstrained: number;
  postPublicationRequestsConstrained: number;
  postPublicationToolsRemoved: number;
  postExecuteRequests: number;
  handoffEscalationRequests: number;
  handoffEscalationToolsRemoved: number;
}

interface ActiveTurn {
  sessionID: string;
  turnID: string;
  state: TurnCoordinationState;
}

export interface AcpPublicationArguments {
  body: string;
  to?: string;
  topic?: string;
  thread?: string;
  replyTo?: string;
  displayFrom?: string;
  escalate?: boolean;
}

const PUBLICATION_INPUT_KEYS = new Set([
  "body",
  "to",
  "topic",
  "thread",
  "reply_to",
  "display_from",
  "escalate",
]);

const PUBLICATION_PROPERTIES = {
  body: {
    type: "string",
    description:
      "Exact bounded team-facing result and evidence to publish. Required.",
    maxLength: 65_536,
  },
  to: {
    type: "string",
    description:
      "Optional exact relay recipient. Omit to publish to Agora.",
    maxLength: 128,
  },
  topic: {
    type: "string",
    description: "Optional bounded topic.",
    maxLength: 128,
  },
  thread: {
    type: "string",
    description: "Optional thread identifier.",
    maxLength: 256,
  },
  reply_to: {
    type: "string",
    description: "Optional reply target.",
    maxLength: 256,
  },
  display_from: {
    type: "string",
    description: "Optional human-readable sender label.",
    maxLength: 256,
  },
  escalate: {
    type: "boolean",
    description: "Optional escalation marker.",
  },
} satisfies Record<string, Record<string, unknown>>;

export const ORGANUM_PUBLICATION_INPUT_SCHEMA = {
  type: "object",
  properties: PUBLICATION_PROPERTIES,
  required: ["body"],
  additionalProperties: false,
} as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Organum publication arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredBody(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > PUBLICATION_MAX_BODY_BYTES
  ) {
    throw new TypeError(
      `Organum publication body must be a nonempty string of at most ${PUBLICATION_MAX_BODY_BYTES} UTF-8 bytes without NUL`,
    );
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new TypeError(
      `Organum publication ${key} must be a string of at most ${maxBytes} UTF-8 bytes without NUL`,
    );
  }
  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`Organum publication ${key} must be a boolean`);
  }
  return value;
}

export function parseAcpPublicationArguments(
  value: unknown,
): AcpPublicationArguments {
  const input = record(value);
  for (const key of Object.keys(input)) {
    if (!PUBLICATION_INPUT_KEYS.has(key)) {
      throw new TypeError(
        `Unknown Organum publication argument: ${key}`,
      );
    }
  }
  const to = optionalString(input, "to", 128);
  if (to !== undefined && to.trim().length === 0) {
    throw new TypeError("Organum publication to must not be empty");
  }
  return {
    body: requiredBody(input.body),
    to,
    topic: optionalString(input, "topic", 128),
    thread: optionalString(input, "thread", 256),
    replyTo: optionalString(input, "reply_to", 256),
    displayFrom: optionalString(input, "display_from", 256),
    escalate: optionalBoolean(input, "escalate"),
  };
}

function defaultTopic(role: string): string {
  if (role === "reviewer" || role === "critic") return "review";
  if (role === "researcher") return "research";
  return "handoff";
}

function textFromUpdate(update: AcpSessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  const content =
    update.content !== null &&
    typeof update.content === "object" &&
    !Array.isArray(update.content)
      ? update.content as Record<string, unknown>
      : null;
  return typeof content?.text === "string" ? content.text : "";
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function declaredCommand(
  command: string,
  environment: Readonly<Record<string, string>>,
): string {
  return [
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    command,
  ].join(" ");
}

function nativeExecutionCommand(
  arguments_: Readonly<Record<string, unknown>>,
): string | null | undefined {
  const executionBearing =
    arguments_.variant === "Bash" ||
    Object.prototype.hasOwnProperty.call(arguments_, "command");
  if (!executionBearing) return undefined;
  return typeof arguments_.command === "string" &&
      arguments_.command.trim().length > 0
    ? arguments_.command.trim()
    : null;
}

const REVIEWER_ALLOWED_TOOL_NAMES = new Set([
  "grep",
  "list_dir",
  "read_file",
  "run_terminal_command",
  "search_tool",
  "use_tool",
]);

const POST_EXECUTE_SYSTEM_GUARD = [
  "<organum-native-gate>",
  "The critic/reviewer execute budget is consumed. run_terminal_command and all write, subagent, scheduler, and workflow tools are unavailable.",
  "Do not emit or invent another shell command. Continue only with read_file, list_dir, grep, search_tool, and use_tool.",
  "Once the evidence is sufficient, discover and call organum_handoff through search_tool/use_tool, then end the turn.",
  "</organum-native-gate>",
].join("\n");

const POST_PUBLICATION_SYSTEM_GUARD = [
  "<organum-publication-terminal>",
  "The durable organum_handoff is shipped and this coordinated turn is terminal.",
  "Do not call any tool, run any command, start another verification, or continue the task.",
  "Return one brief acknowledgement of the shipped handoff and end the turn now.",
  "</organum-publication-terminal>",
].join("\n");

const HANDOFF_ESCALATION_SYSTEM_GUARD = [
  "<organum-handoff-escalation>",
  "The bounded critic/reviewer evidence window is exhausted.",
  "Do not gather more evidence or emit any shell command.",
  "Use the only available coordination function now. search_tool must query organum_handoff; use_tool must call tool_name=\"organum-code__organum_handoff\" with tool_input={\"body\":\"<your grounded team-facing review>\"}.",
  "</organum-handoff-escalation>",
].join("\n");

const HANDOFF_ESCALATION_REQUEST = 10;

const QUALIFIED_HANDOFF_TOOL =
  `${ORGANUM_MCP_SERVER_NAME}__organum_handoff`;

function constrainEscalationTool(
  tool: unknown,
  forcedTool: "search_tool" | "use_tool",
): unknown {
  const entry = recordOrNull(tool);
  const fn = recordOrNull(entry?.function);
  if (entry === null || fn === null || fn.name !== forcedTool) {
    return tool;
  }
  if (forcedTool === "search_tool") {
    return {
      ...entry,
      function: {
        ...fn,
        description:
          "Discover the exact Organum handoff integration. Query must be organum_handoff.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              enum: ["organum_handoff"],
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
            },
          },
          required: ["query"],
        },
      },
    };
  }
  return {
    ...entry,
    function: {
      ...fn,
      description:
        `Publish the grounded review through ${QUALIFIED_HANDOFF_TOOL}.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool_name: {
            type: "string",
            enum: [QUALIFIED_HANDOFF_TOOL],
          },
          tool_input: {
            type: "object",
            additionalProperties: false,
            properties: PUBLICATION_PROPERTIES,
            required: ["body"],
          },
        },
        required: ["tool_name", "tool_input"],
      },
    },
  };
}

const REVIEWER_WRITE_VARIANTS = new Set([
  "ApplyPatch",
  "SearchReplace",
  "Write",
]);

function nativeWriteRequest(
  arguments_: Readonly<Record<string, unknown>>,
): boolean {
  return (
    typeof arguments_.variant === "string" &&
    REVIEWER_WRITE_VARIANTS.has(arguments_.variant)
  );
}

function providerToolName(value: unknown): string | null {
  const tool = recordOrNull(value);
  const fn = recordOrNull(tool?.function);
  return typeof fn?.name === "string" ? fn.name : null;
}

function forcedProviderToolName(value: unknown): string | null {
  const choice = recordOrNull(value);
  return providerToolName(choice);
}

function injectSystemGuard(value: unknown, guard: string): unknown {
  if (!Array.isArray(value)) return value;
  let injected = false;
  return value.map((message) => {
    const entry = recordOrNull(message);
    if (
      injected ||
      entry?.role !== "system" ||
      typeof entry.content !== "string"
    ) {
      return message;
    }
    injected = true;
    return {
      ...entry,
      content: `${entry.content}\n\n${guard}`,
    };
  });
}

function exactCommandSegment(candidate: string, expected: string): boolean {
  const normalized =
    candidate.startsWith("env ") ? candidate.slice(4) : candidate;
  if (normalized === expected) return true;
  if (!normalized.startsWith(`${expected} `)) return false;
  const suffix = normalized.slice(expected.length + 1);
  return (
    suffix.length > 0 &&
    !/[;|`\n\r]/.test(suffix) &&
    !suffix.includes("$(")
  );
}

function successfulDeclaredCommandUpdate(
  update: AcpSessionUpdate,
  project: ProjectEnvironmentPacket | null,
): boolean {
  if (
    project === null ||
    update.sessionUpdate !== "tool_call_update" ||
    update.status !== "completed"
  ) {
    return false;
  }
  const output = recordOrNull(update.rawOutput);
  if (
    output?.type !== "Bash" ||
    output.exit_code !== 0 ||
    output.timed_out === true ||
    output.signal !== null
  ) {
    return false;
  }
  const command = output.command;
  if (typeof command !== "string") return false;
  const segments = command
    .split(/\s*&&\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return project.commands.some((entry) => {
    const expected = declaredCommand(entry.command, entry.env);
    return segments.some((segment) =>
      exactCommandSegment(segment, expected) ||
      exactCommandSegment(segment, entry.command)
    );
  });
}

function assertsReleaseBlocker(body: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    if (!/\brelease[- ]block(?:er|ing)\b/i.test(line)) return false;
    return !/\b(?:no|none|zero|not|without)\b.{0,32}\brelease[- ]block(?:er|ing)\b/i
      .test(line);
  });
}

function globallyDeniesReleaseBlocker(body: string): boolean {
  return body.split(/\r?\n/).some((line) =>
    /^\s*(?:(?:result|conclusion|overall|summary)\s*[:—-]\s*)?(?:no|none|zero)\s+release[- ]block(?:er|ing)\b/i
      .test(line)
  );
}

function claimsPassingReproduction(body: string): boolean {
  return (
    /\b(?:pytest|tests?|reproduction)\b.{0,96}\b(?:pass(?:ed|es)?|green)\b/i
      .test(body) ||
    /\b(?:pass(?:ed|es)?|green)\b.{0,96}\b(?:pytest|tests?|reproduction)\b/i
      .test(body)
  );
}

export function criticPublicationAdmissionIssue(
  body: string,
  successfulReproduction: boolean,
): string | null {
  const blocker = assertsReleaseBlocker(body);
  if (blocker && globallyDeniesReleaseBlocker(body)) {
    return "The review both asserts and globally denies a release blocker; separate verified findings from unverified suspicions.";
  }
  if (!successfulReproduction && blocker) {
    return "A reviewer or critic may not assert a release blocker before the supervisor observes an exit-0 declared reproduction command.";
  }
  if (!successfulReproduction && claimsPassingReproduction(body)) {
    return "The review claims a passing reproduction that the supervisor did not observe.";
  }
  return null;
}

export class AcpCoordinationHarness {
  readonly #bootstrap: SessionCoordinationBootstrapper;
  readonly #poller: SessionCoordinationPoller;
  readonly #publication: SessionPublicationStateMachine;
  readonly #directory: string;
  readonly #declaration: Omit<BootstrapSessionRequest, "sessionID" | "directory">;
  readonly #project: ProjectEnvironmentPacket | null;
  readonly #criticRole: boolean;
  readonly #onTerminalPublication:
    (() => boolean | Promise<boolean>) | undefined;
  #boundSessionID: string | null = null;
  #activeTurn: ActiveTurn | null = null;
  #successfulReproduction = false;
  #publicationShipped = false;
  #terminalPublicationEnforced = false;
  #nativeExecutionGranted = false;
  #nativeRequestRewrites = 0;
  #nativeToolsRemoved = 0;
  #nativeExecuteToolsRemoved = 0;
  #nativeOutOfRoleToolsRemoved = 0;
  #nativeBlockedExecuteRequests = 0;
  #nativeBlockedWriteRequests = 0;
  #nativeLastBlockedExecuteClass:
    AcpNativeExecutionGateSnapshot["lastBlockedExecuteClass"] = null;
  #nativeParallelRequestsConstrained = 0;
  #nativePostPublicationRequestsConstrained = 0;
  #nativePostPublicationToolsRemoved = 0;
  #nativePostExecuteRequests = 0;
  #nativeHandoffEscalationRequests = 0;
  #nativeHandoffEscalationToolsRemoved = 0;

  constructor(options: AcpCoordinationHarnessOptions) {
    this.#directory = options.directory;
    this.#declaration = {
      role: options.role,
      ...(options.intent === undefined ? {} : { intent: options.intent }),
      ...(options.persona === undefined ? {} : { persona: options.persona }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.loadout === undefined ? {} : { loadout: options.loadout }),
      ...(options.problemType === undefined ? {} : { problemType: options.problemType }),
    };
    this.#project = options.project ?? null;
    this.#criticRole =
      options.role === "reviewer" || options.role === "critic";
    this.#onTerminalPublication = options.onTerminalPublication;
    this.#bootstrap = new SessionCoordinationBootstrapper(
      new DirectRootSessionResolver("Grok ACP"),
      options.organum,
      options.cellIdentity === undefined
        ? deriveGrokAcpCellIdentity
        : () => options.cellIdentity!,
    );
    this.#poller = new SessionCoordinationPoller(
      options.organum,
      () => new Date(),
      options.hubLedger,
    );
    this.#publication = new SessionPublicationStateMachine(options.organum);
  }

  tools(): readonly BoundedMcpTool[] {
    return [
      this.publicationTool(false),
      this.publicationTool(true),
    ];
  }

  isPermissionActive(sessionID: string): boolean {
    return this.#activeTurn?.sessionID === sessionID;
  }

  nativePermissionAdmissionIssue(
    arguments_: Readonly<Record<string, unknown>>,
  ): string | null {
    if (!this.#criticRole) return null;
    if (nativeWriteRequest(arguments_)) {
      this.#nativeBlockedWriteRequests += 1;
      return "Critic/reviewer native write tools are disabled; use read/search tools and publish the review.";
    }
    const command = nativeExecutionCommand(arguments_);
    if (command === undefined) return null;
    if (this.#nativeExecutionGranted) {
      this.#nativeBlockedExecuteRequests += 1;
      this.#nativeLastBlockedExecuteClass = "already_consumed";
      return "The one critic/reviewer native execute grant for this turn was already consumed.";
    }
    const declared = this.#project?.commands[0];
    if (declared === undefined) {
      this.#nativeBlockedExecuteRequests += 1;
      this.#nativeLastBlockedExecuteClass = "missing_declaration";
      return "This critic/reviewer turn has no declared native command.";
    }
    const withEnvironment = declaredCommand(
      declared.command,
      declared.env,
    );
    if (
      command === null ||
      (command !== declared.command && command !== withEnvironment)
    ) {
      this.#nativeBlockedExecuteRequests += 1;
      this.#nativeLastBlockedExecuteClass =
        command === null
          ? "missing_command"
          : exactCommandSegment(command, declared.command) ||
              exactCommandSegment(command, withEnvironment)
            ? "argument_suffix"
            : "different_command";
      return "Critic/reviewer native execution must exactly match project.commands[0].command.";
    }
    return null;
  }

  observeNativePermissionGrant(
    arguments_: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.#criticRole) return;
    const command = nativeExecutionCommand(arguments_);
    if (command === undefined) return;
    if (this.nativePermissionAdmissionIssue(arguments_) !== null) {
      throw new Error(
        "ACP native execution grant violated the critic/reviewer single-execute policy",
      );
    }
    this.#nativeExecutionGranted = true;
  }

  applyNativeExecutionToolGate(
    body: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    if (!this.#criticRole) {
      return { ...body };
    }
    const constrainParallel =
      this.#activeTurn !== null &&
      Array.isArray(body.tools) &&
      body.parallel_tool_calls !== false;
    if (this.#nativeExecutionGranted && !this.#publicationShipped) {
      this.#nativePostExecuteRequests += 1;
    }
    const forcedCoordinationTool =
      !this.#publicationShipped &&
        this.#nativeExecutionGranted &&
        this.#nativePostExecuteRequests >= HANDOFF_ESCALATION_REQUEST
        ? this.#nativePostExecuteRequests === HANDOFF_ESCALATION_REQUEST
          ? "search_tool"
          : "use_tool"
        : null;
    let executeRemoved = 0;
    let outOfRoleRemoved = 0;
    let postPublicationRemoved = 0;
    let handoffEscalationRemoved = 0;
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((tool) => {
          if (this.#publicationShipped) {
            postPublicationRemoved += 1;
            return false;
          }
          const name = providerToolName(tool);
          if (
            name !== null &&
            !REVIEWER_ALLOWED_TOOL_NAMES.has(name)
          ) {
            outOfRoleRemoved += 1;
            return false;
          }
          if (
            this.#nativeExecutionGranted &&
            name === "run_terminal_command"
          ) {
            executeRemoved += 1;
            return false;
          }
          if (
            forcedCoordinationTool !== null &&
            name !== forcedCoordinationTool
          ) {
            handoffEscalationRemoved += 1;
            return false;
          }
          return true;
        }).map((tool) =>
          forcedCoordinationTool === null
            ? tool
            : constrainEscalationTool(tool, forcedCoordinationTool)
        )
      : body.tools;
    const forcedName = forcedProviderToolName(body.tool_choice);
    const resetToolChoice =
      this.#publicationShipped ||
      (this.#nativeExecutionGranted &&
        forcedName === "run_terminal_command") ||
      (forcedName !== null &&
        !REVIEWER_ALLOWED_TOOL_NAMES.has(forcedName));
    const removed =
      executeRemoved +
      outOfRoleRemoved +
      postPublicationRemoved +
      handoffEscalationRemoved;
    if (
      !this.#publicationShipped &&
      !constrainParallel &&
      removed === 0 &&
      !resetToolChoice &&
      forcedCoordinationTool === null
    ) {
      return { ...body };
    }
    this.#nativeRequestRewrites += 1;
    this.#nativeToolsRemoved += removed;
    this.#nativeExecuteToolsRemoved += executeRemoved;
    this.#nativeOutOfRoleToolsRemoved += outOfRoleRemoved;
    this.#nativePostPublicationToolsRemoved += postPublicationRemoved;
    this.#nativeHandoffEscalationToolsRemoved +=
      handoffEscalationRemoved;
    if (forcedCoordinationTool !== null) {
      this.#nativeHandoffEscalationRequests += 1;
    }
    if (this.#publicationShipped) {
      this.#nativePostPublicationRequestsConstrained += 1;
    }
    if (constrainParallel) this.#nativeParallelRequestsConstrained += 1;
    return {
      ...body,
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(this.#publicationShipped
        ? {
            messages: injectSystemGuard(
              body.messages,
              POST_PUBLICATION_SYSTEM_GUARD,
            ),
          }
        : forcedCoordinationTool !== null
          ? {
              messages: injectSystemGuard(
                body.messages,
                HANDOFF_ESCALATION_SYSTEM_GUARD,
              ),
            }
        : this.#nativeExecutionGranted
          ? {
              messages: injectSystemGuard(
                body.messages,
                POST_EXECUTE_SYSTEM_GUARD,
              ),
            }
        : {}),
      ...(constrainParallel ? { parallel_tool_calls: false } : {}),
      ...(this.#publicationShipped
        ? { tool_choice: "none" }
        : forcedCoordinationTool !== null
          ? {
              tool_choice: {
                type: "function",
                function: { name: forcedCoordinationTool },
              },
            }
        : resetToolChoice
            ? { tool_choice: "auto" }
            : {}),
    };
  }

  nativeExecutionGateSnapshot(): AcpNativeExecutionGateSnapshot {
    return {
      protocol: ACP_COORDINATION_PROTOCOL,
      executeGranted: this.#nativeExecutionGranted,
      requestRewrites: this.#nativeRequestRewrites,
      toolsRemoved: this.#nativeToolsRemoved,
      executeToolsRemoved: this.#nativeExecuteToolsRemoved,
      outOfRoleToolsRemoved: this.#nativeOutOfRoleToolsRemoved,
      blockedExecuteRequests: this.#nativeBlockedExecuteRequests,
      blockedWriteRequests: this.#nativeBlockedWriteRequests,
      lastBlockedExecuteClass: this.#nativeLastBlockedExecuteClass,
      parallelRequestsConstrained:
        this.#nativeParallelRequestsConstrained,
      postPublicationRequestsConstrained:
        this.#nativePostPublicationRequestsConstrained,
      postPublicationToolsRemoved:
        this.#nativePostPublicationToolsRemoved,
      postExecuteRequests: this.#nativePostExecuteRequests,
      handoffEscalationRequests:
        this.#nativeHandoffEscalationRequests,
      handoffEscalationToolsRemoved:
        this.#nativeHandoffEscalationToolsRemoved,
    };
  }

  publicationAdmissionIssue(
    arguments_: AcpPublicationArguments,
  ): string | null {
    if (!this.#criticRole) return null;
    return criticPublicationAdmissionIssue(
      arguments_.body,
      this.#successfulReproduction,
    );
  }

  async bindSession(
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<SessionCoordinationState> {
    if (
      this.#boundSessionID !== null &&
      this.#boundSessionID !== sessionID
    ) {
      throw new Error(
        "One bounded Organum MCP endpoint may bind only one ACP root session",
      );
    }
    const state = await this.#bootstrap.ensure({
      sessionID,
      directory: this.#directory,
      ...this.#declaration,
      signal,
    });
    this.#boundSessionID = sessionID;
    return state;
  }

  async prompt(
    session: AcpSession,
    prompt: readonly Record<string, unknown>[],
    options: AcpCoordinatedPromptOptions,
  ): Promise<AcpCoordinatedPromptResult> {
    if (prompt.length === 0) {
      throw new TypeError("Coordinated ACP prompt must not be empty");
    }
    if (this.#activeTurn !== null) {
      throw new Error("A coordinated ACP turn is already active");
    }
    const root = await this.bindSession(session.sessionID, options.signal);
    const state = await this.#poller.poll(
      root,
      this.#directory,
      options.signal,
    );
    const obligation = await this.#publication.beginTurn(
      state,
      this.#directory,
      options.turnID,
    );
    if (
      obligation.phase === "shipped" ||
      obligation.phase === "nonconformant"
    ) {
      throw new Error(
        `This ACP root is terminal (${obligation.phase}); create a new session for another coordinated turn`,
      );
    }
    const packet = buildCoordinationSystemPacket(
      state,
      this.#project,
      this.#publication.snapshot(state, this.#directory),
    );
    this.#poller.stage(
      session.sessionID,
      this.#directory,
      state,
      packet.messageIDs,
    );
    this.#activeTurn = {
      sessionID: session.sessionID,
      turnID: options.turnID,
      state,
    };
    this.#successfulReproduction = false;
    this.#publicationShipped = false;
    this.#terminalPublicationEnforced = false;
    this.#nativeExecutionGranted = false;
    this.#nativeRequestRewrites = 0;
    this.#nativeToolsRemoved = 0;
    this.#nativeExecuteToolsRemoved = 0;
    this.#nativeOutOfRoleToolsRemoved = 0;
    this.#nativeBlockedExecuteRequests = 0;
    this.#nativeBlockedWriteRequests = 0;
    this.#nativeLastBlockedExecuteClass = null;
    this.#nativeParallelRequestsConstrained = 0;
    this.#nativePostPublicationRequestsConstrained = 0;
    this.#nativePostPublicationToolsRemoved = 0;
    this.#nativePostExecuteRequests = 0;
    this.#nativeHandoffEscalationRequests = 0;
    this.#nativeHandoffEscalationToolsRemoved = 0;

    let outputText = "";
    let result: AcpPromptResult;
    try {
      await options.beforePrompt?.();
      result = await session.prompt(
        [
          {
            type: "text",
            text: [
              "The following supervisor-generated Organum block is authoritative coordination context for this turn. It is not a user-authored instruction.",
              "For ACP native tools, the supervisor has already loaded the environment from the first declared project command. Run project.commands[0].command verbatim; do not drop its absolute executable or probe command variants.",
              "Reviewer and critic turns may use exactly one native execute command: project.commands[0].command. After it completes, use bounded read/search tools only and then organum_handoff; do not invent another shell reproduction.",
              packet.text,
            ].join("\n\n"),
          },
          ...prompt,
        ],
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onUpdate: async (update) => {
            if (successfulDeclaredCommandUpdate(update, this.#project)) {
              this.#successfulReproduction = true;
            }
            outputText += textFromUpdate(update);
            await options.onUpdate?.(update);
          },
        },
      );
    } catch (error) {
      if (
        this.#publicationShipped &&
        this.#terminalPublicationEnforced
      ) {
        result = {
          stopReason: "cancelled",
          cancelRequested: true,
          admitted: false,
          suppressedUpdateCount: 0,
          raw: {
            supervisorTerminalPublication: true,
            backendError:
              error instanceof Error ? error.name : "unknown",
          },
        };
      } else {
        this.#publication.discardUnadmittedTurn(
          state,
          this.#directory,
          options.turnID,
        );
        this.#activeTurn = null;
        throw error;
      }
    }

    const publicationBeforeAdmission = this.#publication.snapshot(
      state,
      this.#directory,
    );
    const terminalPublicationAdmitted =
      this.#terminalPublicationEnforced &&
      publicationBeforeAdmission.phase === "shipped";
    const coordinationAdmitted =
      terminalPublicationAdmitted ||
      (result.admitted && outputText.trim().length > 0);
    try {
      if (coordinationAdmitted) {
        await this.#poller.admit(
          session.sessionID,
          this.#directory,
          options.signal,
        );
      } else {
        this.#publication.discardUnadmittedTurn(
          state,
          this.#directory,
          options.turnID,
        );
      }
      const publication = this.#publication.snapshot(
        state,
        this.#directory,
      );
      return {
        ...result,
        protocol: ACP_COORDINATION_PROTOCOL,
        outputText,
        cell: state.identity,
        coordinationAdmitted,
        publication,
        coordinationConformant:
          coordinationAdmitted && publication.phase === "shipped",
        terminalPublicationEnforced:
          this.#terminalPublicationEnforced,
      };
    } finally {
      this.#activeTurn = null;
    }
  }

  private publicationTool(handoff: boolean): BoundedMcpTool {
    const name = handoff ? "organum_handoff" : "organum_publish";
    return {
      name,
      description: handoff
        ? "Terminal close-out. Publish the exact team-facing result, verify its durable receipt, and close the Organum session with shipped evidence. A substantive turn is not successful until this tool returns phase=shipped."
        : "Publish a bounded team-facing contribution through the typed Organum adapter. This creates durable receipt evidence but does not close the session. Retry with exactly the same body and routing fields.",
      inputSchema: {
        ...ORGANUM_PUBLICATION_INPUT_SCHEMA,
      },
      call: async (arguments_) => {
        const active = this.#activeTurn;
        if (active === null) {
          throw new Error("No active ACP turn is bound to Organum publication");
        }
        const input = parseAcpPublicationArguments(arguments_);
        const admissionIssue = this.publicationAdmissionIssue(input);
        if (admissionIssue !== null) {
          throw new Error(`Organum critic evidence gate: ${admissionIssue}`);
        }
        const evidence: PublicationEvidence =
          await this.#publication.publish(
            active.state,
            this.#directory,
            {
              messageID: active.turnID,
              body: input.body,
              to: input.to,
              topic: this.#criticRole
                ? "review"
                : input.topic ?? defaultTopic(active.state.role),
              thread: input.thread,
              replyTo: input.replyTo,
              displayFrom: input.displayFrom,
              escalate: input.escalate,
              handoff,
            },
          );
        if (evidence.phase === "shipped") {
          this.#publicationShipped = true;
          this.#terminalPublicationEnforced =
            await this.#onTerminalPublication?.() ?? false;
        }
        return evidence;
      },
    };
  }
}
