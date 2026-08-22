import { createHash } from "node:crypto";

import {
  parseAcpPublicationArguments,
  type AcpPublicationArguments,
} from "./acp-coordination.js";
import {
  terminalConfiguratorIO,
  type ConfiguratorChoice,
} from "./configurator.js";
import { ORGANUM_MCP_SERVER_NAME } from "./organum-mcp.js";

export const ACP_PERMISSION_PROTOCOL = 1;
export const ACP_PERMISSION_METHOD = "session/request_permission";

type JsonRecord = Record<string, unknown>;

export type AcpOrganumOperation =
  | "organum_publish"
  | "organum_handoff";

export type AcpPermissionDecision =
  | "allow_once"
  | "reject_once"
  | "cancelled";

export type AcpPermissionReason =
  | "allowed"
  | "busy"
  | "inactive_turn"
  | "malformed"
  | "option_missing"
  | "presenter_error"
  | "session_mismatch"
  | "tool_not_allowed"
  | "user_cancelled"
  | "user_rejected";

export interface AcpPermissionPresentation {
  protocol: typeof ACP_PERMISSION_PROTOCOL;
  sessionID: string;
  toolCallID: string;
  qualifiedToolName: string;
  operation: AcpOrganumOperation;
  arguments: AcpPublicationArguments;
  bodyBytes: number;
  bodySHA256: string;
  admissionIssue: string | null;
}

export interface AcpPermissionPresenter {
  present(
    request: AcpPermissionPresentation,
  ): AcpPermissionDecision | Promise<AcpPermissionDecision>;
}

export interface AcpPermissionPresentationIO {
  readonly interactive: boolean;
  line(message?: string): void;
  choose(
    prompt: string,
    choices: readonly ConfiguratorChoice[],
    defaultValue?: string,
  ): Promise<string>;
}

export interface AcpPermissionAuditEvent {
  sessionID: string | null;
  toolCallID: string | null;
  operation: AcpOrganumOperation | null;
  decision: AcpPermissionDecision;
  reason: AcpPermissionReason;
}

export interface AcpPermissionSnapshot {
  protocol: typeof ACP_PERMISSION_PROTOCOL;
  requests: number;
  presented: number;
  granted: number;
  rejected: number;
  cancelled: number;
  malformed: number;
  presenterErrors: number;
  pendingGrants: number;
  consumedGrants: number;
  blockedToolCalls: number;
  events: readonly AcpPermissionAuditEvent[];
}

export interface AcpPermissionBrokerOptions {
  presenter: AcpPermissionPresenter;
  isSessionActive(sessionID: string): boolean;
  admissionIssue?(
    operation: AcpOrganumOperation,
    arguments_: AcpPublicationArguments,
  ): string | null;
  serverName?: string;
  maxAuditEvents?: number;
}

export interface AcpNativePermissionPresentation {
  protocol: typeof ACP_PERMISSION_PROTOCOL;
  sessionID: string;
  toolCallID: string;
  toolName: string;
  arguments: Readonly<JsonRecord>;
  argumentsBytes: number;
  argumentsSHA256: string;
}

export interface AcpNativePermissionPresenter {
  present(
    request: AcpNativePermissionPresentation,
  ): AcpPermissionDecision | Promise<AcpPermissionDecision>;
}

export type AcpNativePermissionReason =
  | "allowed"
  | "busy"
  | "inactive_turn"
  | "malformed"
  | "option_missing"
  | "policy_denied"
  | "policy_error"
  | "presenter_error"
  | "session_mismatch"
  | "user_cancelled"
  | "user_rejected";

export interface AcpNativePermissionAuditEvent {
  sessionID: string | null;
  toolCallID: string | null;
  toolName: string | null;
  decision: AcpPermissionDecision;
  reason: AcpNativePermissionReason;
}

export interface AcpNativePermissionSnapshot {
  protocol: typeof ACP_PERMISSION_PROTOCOL;
  requests: number;
  presented: number;
  granted: number;
  rejected: number;
  cancelled: number;
  malformed: number;
  presenterErrors: number;
  events: readonly AcpNativePermissionAuditEvent[];
}

export interface AcpReadOnlyIntegrationPermissionAuditEvent {
  sessionID: string | null;
  toolCallID: string | null;
  toolName: string | null;
  decision: AcpPermissionDecision;
  reason:
    | "allowed"
    | "inactive_turn"
    | "malformed"
    | "option_missing"
    | "session_mismatch"
    | "tool_not_allowed";
}

export interface AcpReadOnlyIntegrationPermissionSnapshot {
  protocol: typeof ACP_PERMISSION_PROTOCOL;
  requests: number;
  granted: number;
  rejected: number;
  cancelled: number;
  malformed: number;
  events: readonly AcpReadOnlyIntegrationPermissionAuditEvent[];
}

export interface AcpNativePermissionPolicyRequest {
  sessionID: string;
  toolCallID: string;
  toolName: string;
  arguments: Readonly<JsonRecord>;
}

export interface AcpNativePermissionBrokerOptions {
  presenter: AcpNativePermissionPresenter;
  isSessionActive(sessionID: string): boolean;
  admissionIssue?(
    request: AcpNativePermissionPolicyRequest,
  ): string | null;
  onGrant?(
    request: AcpNativePermissionPolicyRequest,
  ): void;
  maxAuditEvents?: number;
}

interface PermissionOption {
  optionID: string;
  kind: string;
}

interface ParsedPermissionRequest {
  sessionID: string;
  toolCallID: string;
  qualifiedToolName: string;
  operation: AcpOrganumOperation;
  arguments: AcpPublicationArguments;
  options: readonly PermissionOption[];
}

interface PendingPermissionGrant {
  sessionID: string;
  operation: AcpOrganumOperation;
  fingerprint: string;
}

interface ParsedNativePermissionRequest {
  sessionID: string;
  toolCallID: string;
  toolName: string;
  arguments: JsonRecord;
  argumentsJSON: string;
  options: readonly PermissionOption[];
}

interface ParsedReadOnlyIntegrationPermissionRequest {
  sessionID: string;
  toolCallID: string;
  toolName: string;
  argumentsJSON: string;
  options: readonly PermissionOption[];
}

class AcpPermissionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpPermissionContractError";
  }
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AcpPermissionContractError(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function boundedString(
  value: unknown,
  context: string,
  maxBytes = 512,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new AcpPermissionContractError(
      `${context} must be a nonempty bounded string without NUL`,
    );
  }
  return value;
}

function permissionOptions(value: unknown): readonly PermissionOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new AcpPermissionContractError(
      "ACP permission options must be a nonempty bounded array",
    );
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const option = record(item, `ACP permission options[${index}]`);
    const optionID = boundedString(
      option.optionId,
      `ACP permission options[${index}].optionId`,
      256,
    );
    const kind = boundedString(
      option.kind,
      `ACP permission options[${index}].kind`,
      64,
    );
    if (seen.has(optionID)) {
      throw new AcpPermissionContractError(
        "ACP permission option IDs must be unique",
      );
    }
    seen.add(optionID);
    return { optionID, kind };
  });
}

function operationFromName(
  value: string,
  serverName: string,
): AcpOrganumOperation | null {
  const prefix = `${serverName}__`;
  if (!value.startsWith(prefix)) return null;
  const operation = value.slice(prefix.length);
  return operation === "organum_publish" || operation === "organum_handoff"
    ? operation
    : null;
}

function parsePermissionRequest(
  value: unknown,
  serverName: string,
): ParsedPermissionRequest {
  const input = record(value, "ACP permission request");
  const sessionID = boundedString(
    input.sessionId,
    "ACP permission sessionId",
    512,
  );
  const toolCall = record(input.toolCall, "ACP permission toolCall");
  const toolCallID = boundedString(
    toolCall.toolCallId,
    "ACP permission toolCallId",
    512,
  );
  if (toolCall.status !== undefined && toolCall.status !== "pending") {
    throw new AcpPermissionContractError(
      "ACP permission tool call must still be pending",
    );
  }
  const qualifiedToolName = boundedString(
    toolCall.title,
    "ACP permission tool title",
    512,
  );
  const operation = operationFromName(qualifiedToolName, serverName);
  if (operation === null) {
    throw new AcpPermissionContractError(
      "ACP permission tool is outside the bounded Organum surface",
    );
  }
  const rawInput = record(
    toolCall.rawInput,
    "ACP permission tool rawInput",
  );
  if (rawInput.variant !== "UseTool") {
    throw new AcpPermissionContractError(
      "ACP permission request is not a Grok UseTool call",
    );
  }
  if (rawInput.tool_name !== qualifiedToolName) {
    throw new AcpPermissionContractError(
      "ACP permission title and tool_name do not match",
    );
  }
  return {
    sessionID,
    toolCallID,
    qualifiedToolName,
    operation,
    arguments: parseAcpPublicationArguments(rawInput.tool_input),
    options: permissionOptions(input.options),
  };
}

function shallowRejectOption(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const options = (value as JsonRecord).options;
  if (!Array.isArray(options) || options.length > 16) return null;
  const parsed: Array<{ optionID: string; kind: unknown }> = [];
  for (const item of options) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const option = item as JsonRecord;
    if (
      typeof option.optionId === "string" &&
      option.optionId.trim().length > 0 &&
      !option.optionId.includes("\0") &&
      Buffer.byteLength(option.optionId, "utf8") <= 256
    ) {
      parsed.push({ optionID: option.optionId, kind: option.kind });
    }
  }
  const reject = parsed.find((option) => option.kind === "reject_once");
  if (
    reject === undefined ||
    parsed.filter((option) => option.optionID === reject.optionID).length !== 1
  ) {
    return null;
  }
  return reject.optionID;
}

function selected(optionID: string): JsonRecord {
  return {
    outcome: {
      outcome: "selected",
      optionId: optionID,
    },
  };
}

function cancelled(): JsonRecord {
  return { outcome: { outcome: "cancelled" } };
}

function bodyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function permissionFingerprint(
  operation: AcpOrganumOperation,
  arguments_: AcpPublicationArguments,
): string {
  return bodyHash(JSON.stringify([
    operation,
    arguments_.body,
    arguments_.to ?? null,
    arguments_.topic ?? null,
    arguments_.thread ?? null,
    arguments_.replyTo ?? null,
    arguments_.displayFrom ?? null,
    arguments_.escalate ?? null,
  ]));
}

function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) => key.includes("\0") || hasNul(nested),
    );
  }
  return false;
}

function parseNativePermissionRequest(
  value: unknown,
): ParsedNativePermissionRequest {
  const input = record(value, "ACP native permission request");
  const sessionID = boundedString(
    input.sessionId,
    "ACP native permission sessionId",
    512,
  );
  const toolCall = record(
    input.toolCall,
    "ACP native permission toolCall",
  );
  const toolCallID = boundedString(
    toolCall.toolCallId,
    "ACP native permission toolCallId",
    512,
  );
  if (toolCall.status !== undefined && toolCall.status !== "pending") {
    throw new AcpPermissionContractError(
      "ACP native permission tool call must still be pending",
    );
  }
  const toolName = boundedString(
    toolCall.title,
    "ACP native permission tool title",
    8 * 1024,
  );
  if (
    /^[A-Za-z0-9._-]{1,64}__[A-Za-z0-9._-]{1,128}$/.test(toolName)
  ) {
    throw new AcpPermissionContractError(
      "ACP native permission must not route a qualified integration tool",
    );
  }
  const rawInput = record(
    toolCall.rawInput,
    "ACP native permission tool rawInput",
  );
  const variant =
    rawInput.variant === undefined
      ? undefined
      : boundedString(
          rawInput.variant,
          "ACP native permission rawInput.variant",
          128,
        );
  if (variant === "UseTool" || rawInput.tool_name !== undefined) {
    throw new AcpPermissionContractError(
      "ACP native permission must use a backend-native raw input variant",
    );
  }
  if (Object.keys(rawInput).length === 0) {
    throw new AcpPermissionContractError(
      "ACP native permission raw input must not be empty",
    );
  }
  const arguments_ = rawInput;
  if (hasNul(arguments_)) {
    throw new AcpPermissionContractError(
      "ACP native permission arguments must not contain NUL",
    );
  }
  const argumentsJSON = JSON.stringify(arguments_);
  if (Buffer.byteLength(argumentsJSON, "utf8") > 64 * 1024) {
    throw new AcpPermissionContractError(
      "ACP native permission arguments exceed 65536 UTF-8 bytes",
    );
  }
  return {
    sessionID,
    toolCallID,
    toolName,
    arguments: arguments_,
    argumentsJSON,
    options: permissionOptions(input.options),
  };
}

function parseReadOnlyIntegrationPermissionRequest(
  value: unknown,
): ParsedReadOnlyIntegrationPermissionRequest {
  const input = record(value, "ACP read-only integration permission request");
  const sessionID = boundedString(
    input.sessionId,
    "ACP read-only integration permission sessionId",
    512,
  );
  const toolCall = record(
    input.toolCall,
    "ACP read-only integration permission toolCall",
  );
  const toolCallID = boundedString(
    toolCall.toolCallId,
    "ACP read-only integration permission toolCallId",
    512,
  );
  if (toolCall.status !== undefined && toolCall.status !== "pending") {
    throw new AcpPermissionContractError(
      "ACP read-only integration tool call must still be pending",
    );
  }
  const rawInput = record(
    toolCall.rawInput,
    "ACP read-only integration permission rawInput",
  );
  if (rawInput.variant !== "UseTool") {
    throw new AcpPermissionContractError(
      "ACP read-only integration permission request is not a UseTool call",
    );
  }
  const toolName = boundedString(
    rawInput.tool_name,
    "ACP read-only integration permission tool_name",
    512,
  );
  if (!/^[A-Za-z0-9._-]{1,64}__[A-Za-z0-9._-]{1,128}$/.test(toolName)) {
    throw new AcpPermissionContractError(
      "ACP read-only integration tool name is invalid",
    );
  }
  const arguments_ = record(
    rawInput.tool_input,
    "ACP read-only integration permission tool_input",
  );
  if (hasNul(arguments_)) {
    throw new AcpPermissionContractError(
      "ACP read-only integration arguments must not contain NUL",
    );
  }
  const argumentsJSON = JSON.stringify(arguments_);
  if (Buffer.byteLength(argumentsJSON, "utf8") > 64 * 1024) {
    throw new AcpPermissionContractError(
      "ACP read-only integration arguments exceed 65536 UTF-8 bytes",
    );
  }
  return {
    sessionID,
    toolCallID,
    toolName,
    argumentsJSON,
    options: permissionOptions(input.options),
  };
}

function isOrganumPermissionRequest(
  value: unknown,
  serverName: string,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const toolCall = (value as JsonRecord).toolCall;
  if (
    toolCall === null ||
    typeof toolCall !== "object" ||
    Array.isArray(toolCall)
  ) {
    return false;
  }
  const title = (toolCall as JsonRecord).title;
  return (
    title === `${serverName}__organum_publish` ||
    title === `${serverName}__organum_handoff`
  );
}

function isUseToolPermissionRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const toolCall = (value as JsonRecord).toolCall;
  if (
    toolCall === null ||
    typeof toolCall !== "object" ||
    Array.isArray(toolCall)
  ) {
    return false;
  }
  const rawInput = (toolCall as JsonRecord).rawInput;
  return (
    rawInput !== null &&
    typeof rawInput === "object" &&
    !Array.isArray(rawInput) &&
    (rawInput as JsonRecord).variant === "UseTool"
  );
}

function safeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function preview(value: string, maxCharacters = 1_024): {
  text: string;
  truncated: boolean;
} {
  const characters = Array.from(value);
  return {
    text: safeTerminalText(characters.slice(0, maxCharacters).join("")),
    truncated: characters.length > maxCharacters,
  };
}

export class TerminalAcpPermissionPresenter
  implements AcpPermissionPresenter
{
  constructor(
    private readonly io: AcpPermissionPresentationIO =
      terminalConfiguratorIO,
  ) {}

  async present(
    request: AcpPermissionPresentation,
  ): Promise<AcpPermissionDecision> {
    if (!this.io.interactive) return "reject_once";
    const body = preview(request.arguments.body, 65_536);
    this.io.line("");
    this.io.line("Organum Code ACP permission");
    this.io.line(`  Session: ${safeTerminalText(request.sessionID)}`);
    this.io.line(`  Operation: ${request.operation}`);
    this.io.line(`  Body bytes: ${request.bodyBytes}`);
    this.io.line(`  Body SHA-256: ${request.bodySHA256}`);
    if (request.arguments.to !== undefined) {
      this.io.line(`  Recipient: ${safeTerminalText(request.arguments.to)}`);
    }
    this.io.line("  Team-facing body:");
    this.io.line(body.text);
    if (body.truncated) {
      this.io.line("  … body exceeded the admitted publication envelope");
    }
    if (request.admissionIssue !== null) {
      this.io.line("  Evidence gate: WILL REJECT WITHOUT PUBLISHING");
      this.io.line(`  ${safeTerminalText(request.admissionIssue)}`);
    }
    const decision = await this.io.choose(
      request.admissionIssue === null
        ? "Allow this exact one-shot Organum operation?"
        : "Return this evidence error to the agent for correction?",
      request.admissionIssue === null
        ? [
          { value: "allow_once", label: "Allow once" },
          { value: "reject_once", label: "Reject" },
        ]
        : [
          { value: "allow_once", label: "Return correction" },
          { value: "reject_once", label: "Cancel turn" },
        ],
      "reject_once",
    );
    return decision === "allow_once" ? "allow_once" : "reject_once";
  }
}

export class TerminalAcpNativePermissionPresenter
  implements AcpNativePermissionPresenter
{
  constructor(
    private readonly io: AcpPermissionPresentationIO =
      terminalConfiguratorIO,
  ) {}

  async present(
    request: AcpNativePermissionPresentation,
  ): Promise<AcpPermissionDecision> {
    if (!this.io.interactive) return "reject_once";
    const argumentsPreview = preview(
      JSON.stringify(request.arguments, null, 2),
    );
    this.io.line("");
    this.io.line("Grok ACP native tool permission");
    this.io.line(`  Session: ${safeTerminalText(request.sessionID)}`);
    this.io.line(`  Tool: ${safeTerminalText(request.toolName)}`);
    this.io.line(`  Arguments bytes: ${request.argumentsBytes}`);
    this.io.line(`  Arguments SHA-256: ${request.argumentsSHA256}`);
    this.io.line("  Exact arguments:");
    this.io.line(argumentsPreview.text);
    if (argumentsPreview.truncated) {
      this.io.line("  … preview truncated; verify the hash for exact identity");
    }
    const decision = await this.io.choose(
      "Allow this exact one-shot contained native tool call?",
      [
        { value: "allow_once", label: "Allow once" },
        { value: "reject_once", label: "Reject" },
      ],
      "reject_once",
    );
    return decision === "allow_once" ? "allow_once" : "reject_once";
  }
}

export class BoundedAcpNativePermissionBroker {
  readonly #presenter: AcpNativePermissionPresenter;
  readonly #isSessionActive: (sessionID: string) => boolean;
  readonly #admissionIssue:
    | AcpNativePermissionBrokerOptions["admissionIssue"]
    | undefined;
  readonly #onGrant:
    | AcpNativePermissionBrokerOptions["onGrant"]
    | undefined;
  readonly #maxAuditEvents: number;
  readonly #events: AcpNativePermissionAuditEvent[] = [];
  #sessionID: string | null = null;
  #presenting = false;
  #requests = 0;
  #presented = 0;
  #granted = 0;
  #rejected = 0;
  #cancelled = 0;
  #malformed = 0;
  #presenterErrors = 0;

  constructor(options: AcpNativePermissionBrokerOptions) {
    if (typeof options.presenter?.present !== "function") {
      throw new TypeError("ACP native permission presenter is invalid");
    }
    if (typeof options.isSessionActive !== "function") {
      throw new TypeError(
        "ACP native permission broker requires an active-session predicate",
      );
    }
    if (
      options.admissionIssue !== undefined &&
      typeof options.admissionIssue !== "function"
    ) {
      throw new TypeError(
        "ACP native permission admission policy is invalid",
      );
    }
    if (
      options.onGrant !== undefined &&
      typeof options.onGrant !== "function"
    ) {
      throw new TypeError(
        "ACP native permission grant observer is invalid",
      );
    }
    this.#presenter = options.presenter;
    this.#isSessionActive = options.isSessionActive;
    this.#admissionIssue = options.admissionIssue;
    this.#onGrant = options.onGrant;
    this.#maxAuditEvents = options.maxAuditEvents ?? 128;
    if (
      !Number.isSafeInteger(this.#maxAuditEvents) ||
      this.#maxAuditEvents < 1 ||
      this.#maxAuditEvents > 1_024
    ) {
      throw new TypeError(
        "ACP native permission audit limit must be between 1 and 1024",
      );
    }
  }

  bindSession(sessionID: string): void {
    const value = boundedString(
      sessionID,
      "ACP native permission bound session",
      512,
    );
    if (this.#sessionID !== null && this.#sessionID !== value) {
      throw new Error(
        "One ACP native permission broker may bind only one ACP root session",
      );
    }
    this.#sessionID = value;
  }

  readonly handle = async (params: unknown): Promise<JsonRecord> => {
    this.#requests += 1;
    let request: ParsedNativePermissionRequest;
    try {
      request = parseNativePermissionRequest(params);
    } catch {
      this.#malformed += 1;
      return this.rejectMalformed(params);
    }
    if (this.#sessionID === null || request.sessionID !== this.#sessionID) {
      return this.reject(request, "session_mismatch");
    }
    if (!this.#isSessionActive(request.sessionID)) {
      return this.reject(request, "inactive_turn");
    }
    if (this.#presenting) return this.reject(request, "busy");
    const allow = request.options.find(
      (option) => option.kind === "allow_once",
    );
    const reject = request.options.find(
      (option) => option.kind === "reject_once",
    );
    if (allow === undefined || reject === undefined) {
      return this.reject(request, "option_missing");
    }
    const policyRequest = this.policyRequest(request);
    try {
      const admissionIssue =
        this.#admissionIssue?.(policyRequest) ?? null;
      if (admissionIssue !== null) {
        return this.reject(request, "policy_denied");
      }
    } catch {
      return this.reject(request, "policy_error");
    }

    this.#presenting = true;
    this.#presented += 1;
    let decision: AcpPermissionDecision;
    try {
      decision = await this.#presenter.present({
        protocol: ACP_PERMISSION_PROTOCOL,
        sessionID: request.sessionID,
        toolCallID: request.toolCallID,
        toolName: request.toolName,
        arguments: request.arguments,
        argumentsBytes: Buffer.byteLength(request.argumentsJSON, "utf8"),
        argumentsSHA256: bodyHash(request.argumentsJSON),
      });
    } catch {
      this.#presenterErrors += 1;
      return this.reject(request, "presenter_error");
    } finally {
      this.#presenting = false;
    }
    if (decision === "allow_once") {
      try {
        this.#onGrant?.(policyRequest);
      } catch {
        return this.reject(request, "policy_error");
      }
      this.#granted += 1;
      this.record(request, decision, "allowed");
      return selected(allow.optionID);
    }
    if (decision === "cancelled") {
      this.#cancelled += 1;
      this.record(request, decision, "user_cancelled");
      return cancelled();
    }
    return this.reject(request, "user_rejected");
  };

  snapshot(): AcpNativePermissionSnapshot {
    return {
      protocol: ACP_PERMISSION_PROTOCOL,
      requests: this.#requests,
      presented: this.#presented,
      granted: this.#granted,
      rejected: this.#rejected,
      cancelled: this.#cancelled,
      malformed: this.#malformed,
      presenterErrors: this.#presenterErrors,
      events: this.#events.map((event) => ({ ...event })),
    };
  }

  private rejectMalformed(params: unknown): JsonRecord {
    const optionID = shallowRejectOption(params);
    if (optionID === null) {
      this.#cancelled += 1;
      this.pushEvent({
        sessionID: null,
        toolCallID: null,
        toolName: null,
        decision: "cancelled",
        reason: "malformed",
      });
      return cancelled();
    }
    this.#rejected += 1;
    this.pushEvent({
      sessionID: null,
      toolCallID: null,
      toolName: null,
      decision: "reject_once",
      reason: "malformed",
    });
    return selected(optionID);
  }

  private reject(
    request: ParsedNativePermissionRequest,
    reason: Exclude<
      AcpNativePermissionReason,
      "allowed" | "malformed" | "user_cancelled"
    >,
  ): JsonRecord {
    const option = request.options.find(
      (candidate) => candidate.kind === "reject_once",
    );
    if (option === undefined) {
      this.#cancelled += 1;
      this.record(request, "cancelled", reason);
      return cancelled();
    }
    this.#rejected += 1;
    this.record(request, "reject_once", reason);
    return selected(option.optionID);
  }

  private record(
    request: ParsedNativePermissionRequest,
    decision: AcpPermissionDecision,
    reason: AcpNativePermissionReason,
  ): void {
    this.pushEvent({
      sessionID: request.sessionID,
      toolCallID: request.toolCallID,
      toolName: request.toolName,
      decision,
      reason,
    });
  }

  private policyRequest(
    request: ParsedNativePermissionRequest,
  ): AcpNativePermissionPolicyRequest {
    return {
      sessionID: request.sessionID,
      toolCallID: request.toolCallID,
      toolName: request.toolName,
      arguments: request.arguments,
    };
  }

  private pushEvent(event: AcpNativePermissionAuditEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxAuditEvents) this.#events.shift();
  }
}

export class BoundedAcpPermissionBroker {
  readonly #presenter: AcpPermissionPresenter;
  readonly #isSessionActive: (sessionID: string) => boolean;
  readonly #admissionIssue:
    | ((
      operation: AcpOrganumOperation,
      arguments_: AcpPublicationArguments,
    ) => string | null)
    | undefined;
  readonly #serverName: string;
  readonly #maxAuditEvents: number;
  readonly #events: AcpPermissionAuditEvent[] = [];
  #sessionID: string | null = null;
  #presenting = false;
  #requests = 0;
  #presented = 0;
  #granted = 0;
  #rejected = 0;
  #cancelled = 0;
  #malformed = 0;
  #presenterErrors = 0;
  readonly #pendingGrants: PendingPermissionGrant[] = [];
  #consumedGrants = 0;
  #blockedToolCalls = 0;

  constructor(options: AcpPermissionBrokerOptions) {
    if (typeof options.presenter?.present !== "function") {
      throw new TypeError("ACP permission presenter is invalid");
    }
    this.#presenter = options.presenter;
    if (typeof options.isSessionActive !== "function") {
      throw new TypeError(
        "ACP permission broker requires an active-session predicate",
      );
    }
    this.#isSessionActive = options.isSessionActive;
    this.#admissionIssue = options.admissionIssue;
    this.#serverName =
      options.serverName ?? ORGANUM_MCP_SERVER_NAME;
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(this.#serverName) ||
      this.#serverName.includes("__")
    ) {
      throw new TypeError("ACP permission MCP server name is invalid");
    }
    this.#maxAuditEvents = options.maxAuditEvents ?? 128;
    if (
      !Number.isSafeInteger(this.#maxAuditEvents) ||
      this.#maxAuditEvents < 1 ||
      this.#maxAuditEvents > 1_024
    ) {
      throw new TypeError(
        "ACP permission audit limit must be between 1 and 1024",
      );
    }
  }

  bindSession(sessionID: string): void {
    const value = boundedString(sessionID, "ACP permission bound session", 512);
    if (this.#sessionID !== null && this.#sessionID !== value) {
      throw new Error(
        "One ACP permission broker may bind only one ACP root session",
      );
    }
    this.#sessionID = value;
  }

  readonly handle = async (params: unknown): Promise<JsonRecord> => {
    this.#requests += 1;
    let request: ParsedPermissionRequest;
    try {
      request = parsePermissionRequest(params, this.#serverName);
    } catch {
      if (
        isUseToolPermissionRequest(params) &&
        !isOrganumPermissionRequest(params, this.#serverName)
      ) {
        return this.rejectToolNotAllowed(params);
      }
      this.#malformed += 1;
      return this.rejectMalformed(params);
    }

    if (this.#sessionID === null || request.sessionID !== this.#sessionID) {
      return this.reject(request, "session_mismatch");
    }
    if (!this.#isSessionActive(request.sessionID)) {
      return this.reject(request, "inactive_turn");
    }
    if (this.#presenting) return this.reject(request, "busy");
    if (this.#pendingGrants.length >= 16) {
      return this.reject(request, "busy");
    }

    const allow = request.options.find(
      (option) => option.kind === "allow_once",
    );
    const reject = request.options.find(
      (option) => option.kind === "reject_once",
    );
    if (allow === undefined || reject === undefined) {
      return this.reject(request, "option_missing");
    }

    this.#presenting = true;
    this.#presented += 1;
    let decision: AcpPermissionDecision;
    try {
      decision = await this.#presenter.present({
        protocol: ACP_PERMISSION_PROTOCOL,
        sessionID: request.sessionID,
        toolCallID: request.toolCallID,
        qualifiedToolName: request.qualifiedToolName,
        operation: request.operation,
        arguments: request.arguments,
        bodyBytes: Buffer.byteLength(request.arguments.body, "utf8"),
        bodySHA256: bodyHash(request.arguments.body),
        admissionIssue:
          this.#admissionIssue?.(
            request.operation,
            request.arguments,
          ) ?? null,
      });
    } catch {
      this.#presenterErrors += 1;
      return this.reject(request, "presenter_error");
    } finally {
      this.#presenting = false;
    }

    if (decision === "allow_once") {
      this.#granted += 1;
      this.#pendingGrants.push({
        sessionID: request.sessionID,
        operation: request.operation,
        fingerprint: permissionFingerprint(
          request.operation,
          request.arguments,
        ),
      });
      this.record(request, decision, "allowed");
      return selected(allow.optionID);
    }
    if (decision === "cancelled") {
      this.#cancelled += 1;
      this.record(request, decision, "user_cancelled");
      return cancelled();
    }
    return this.reject(request, "user_rejected");
  };

  consumeOneShotGrant(
    operation: AcpOrganumOperation,
    arguments_: unknown,
  ): void {
    if (
      operation !== "organum_publish" &&
      operation !== "organum_handoff"
    ) {
      this.#blockedToolCalls += 1;
      throw new Error("ACP tool call is outside the bounded Organum surface");
    }
    const sessionID = this.#sessionID;
    if (
      sessionID === null ||
      !this.#isSessionActive(sessionID)
    ) {
      this.#blockedToolCalls += 1;
      throw new Error(
        "ACP Organum tool call has no active bound permission session",
      );
    }
    let parsed: AcpPublicationArguments;
    try {
      parsed = parseAcpPublicationArguments(arguments_);
    } catch {
      this.#blockedToolCalls += 1;
      throw new Error(
        "ACP Organum tool call arguments failed permission validation",
      );
    }
    const fingerprint = permissionFingerprint(operation, parsed);
    const index = this.#pendingGrants.findIndex(
      (grant) =>
        grant.sessionID === sessionID &&
        grant.operation === operation &&
        grant.fingerprint === fingerprint,
    );
    if (index < 0) {
      this.#blockedToolCalls += 1;
      throw new Error(
        "ACP Organum tool call has no matching one-shot permission grant",
      );
    }
    this.#pendingGrants.splice(index, 1);
    this.#consumedGrants += 1;
  }

  snapshot(): AcpPermissionSnapshot {
    return {
      protocol: ACP_PERMISSION_PROTOCOL,
      requests: this.#requests,
      presented: this.#presented,
      granted: this.#granted,
      rejected: this.#rejected,
      cancelled: this.#cancelled,
      malformed: this.#malformed,
      presenterErrors: this.#presenterErrors,
      pendingGrants: this.#pendingGrants.length,
      consumedGrants: this.#consumedGrants,
      blockedToolCalls: this.#blockedToolCalls,
      events: this.#events.map((event) => ({ ...event })),
    };
  }

  private rejectMalformed(params: unknown): JsonRecord {
    const optionID = shallowRejectOption(params);
    if (optionID === null) {
      this.#cancelled += 1;
      this.pushEvent({
        sessionID: null,
        toolCallID: null,
        operation: null,
        decision: "cancelled",
        reason: "malformed",
      });
      return cancelled();
    }
    this.#rejected += 1;
    this.pushEvent({
      sessionID: null,
      toolCallID: null,
      operation: null,
      decision: "reject_once",
      reason: "malformed",
    });
    return selected(optionID);
  }

  private rejectToolNotAllowed(params: unknown): JsonRecord {
    const optionID = shallowRejectOption(params);
    if (optionID === null) {
      this.#cancelled += 1;
      this.pushEvent({
        sessionID: null,
        toolCallID: null,
        operation: null,
        decision: "cancelled",
        reason: "tool_not_allowed",
      });
      return cancelled();
    }
    this.#rejected += 1;
    this.pushEvent({
      sessionID: null,
      toolCallID: null,
      operation: null,
      decision: "reject_once",
      reason: "tool_not_allowed",
    });
    return selected(optionID);
  }

  private reject(
    request: ParsedPermissionRequest,
    reason: Exclude<
      AcpPermissionReason,
      "allowed" | "malformed" | "user_cancelled"
    >,
  ): JsonRecord {
    const option = request.options.find(
      (candidate) => candidate.kind === "reject_once",
    );
    if (option === undefined) {
      this.#cancelled += 1;
      this.record(request, "cancelled", reason);
      return cancelled();
    }
    this.#rejected += 1;
    this.record(request, "reject_once", reason);
    return selected(option.optionID);
  }

  private record(
    request: ParsedPermissionRequest,
    decision: AcpPermissionDecision,
    reason: AcpPermissionReason,
  ): void {
    this.pushEvent({
      sessionID: request.sessionID,
      toolCallID: request.toolCallID,
      operation: request.operation,
      decision,
      reason,
    });
  }

  private pushEvent(event: AcpPermissionAuditEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxAuditEvents) this.#events.shift();
  }
}

export class BoundedAcpReadOnlyIntegrationPermissionBroker {
  readonly #allowedTools: ReadonlySet<string>;
  readonly #isSessionActive: (sessionID: string) => boolean;
  readonly #maxAuditEvents: number;
  readonly #events: AcpReadOnlyIntegrationPermissionAuditEvent[] = [];
  #sessionID: string | null = null;
  #requests = 0;
  #granted = 0;
  #rejected = 0;
  #cancelled = 0;
  #malformed = 0;

  constructor(options: {
    allowedTools: readonly string[];
    isSessionActive(sessionID: string): boolean;
    maxAuditEvents?: number;
  }) {
    if (
      !Array.isArray(options.allowedTools) ||
      options.allowedTools.length === 0 ||
      options.allowedTools.length > 128 ||
      options.allowedTools.some((tool) =>
        !/^[A-Za-z0-9._-]{1,64}__[A-Za-z0-9._-]{1,128}$/.test(tool)
      )
    ) {
      throw new TypeError(
        "ACP read-only integration tools must be a bounded qualified allowlist",
      );
    }
    this.#allowedTools = new Set(options.allowedTools);
    if (this.#allowedTools.size !== options.allowedTools.length) {
      throw new TypeError(
        "ACP read-only integration tool allowlist must be unique",
      );
    }
    if (typeof options.isSessionActive !== "function") {
      throw new TypeError(
        "ACP read-only integration permission broker requires an active-session predicate",
      );
    }
    this.#isSessionActive = options.isSessionActive;
    this.#maxAuditEvents = options.maxAuditEvents ?? 128;
    if (
      !Number.isSafeInteger(this.#maxAuditEvents) ||
      this.#maxAuditEvents < 1 ||
      this.#maxAuditEvents > 1_024
    ) {
      throw new TypeError(
        "ACP read-only integration permission audit limit must be between 1 and 1024",
      );
    }
  }

  bindSession(sessionID: string): void {
    const value = boundedString(
      sessionID,
      "ACP read-only integration permission bound session",
      512,
    );
    if (this.#sessionID !== null && this.#sessionID !== value) {
      throw new Error(
        "One ACP read-only integration permission broker may bind only one ACP root session",
      );
    }
    this.#sessionID = value;
  }

  readonly handle = async (params: unknown): Promise<JsonRecord> => {
    this.#requests += 1;
    let request: ParsedReadOnlyIntegrationPermissionRequest;
    try {
      request = parseReadOnlyIntegrationPermissionRequest(params);
    } catch {
      this.#malformed += 1;
      return this.rejectMalformed(params);
    }
    if (this.#sessionID === null || request.sessionID !== this.#sessionID) {
      return this.reject(request, "session_mismatch");
    }
    if (!this.#isSessionActive(request.sessionID)) {
      return this.reject(request, "inactive_turn");
    }
    if (!this.#allowedTools.has(request.toolName)) {
      return this.reject(request, "tool_not_allowed");
    }
    const allow = request.options.find(
      (option) => option.kind === "allow_once",
    );
    const reject = request.options.find(
      (option) => option.kind === "reject_once",
    );
    if (allow === undefined || reject === undefined) {
      return this.reject(request, "option_missing");
    }
    this.#granted += 1;
    this.pushEvent({
      sessionID: request.sessionID,
      toolCallID: request.toolCallID,
      toolName: request.toolName,
      decision: "allow_once",
      reason: "allowed",
    });
    return selected(allow.optionID);
  };

  snapshot(): AcpReadOnlyIntegrationPermissionSnapshot {
    return {
      protocol: ACP_PERMISSION_PROTOCOL,
      requests: this.#requests,
      granted: this.#granted,
      rejected: this.#rejected,
      cancelled: this.#cancelled,
      malformed: this.#malformed,
      events: this.#events.map((event) => ({ ...event })),
    };
  }

  private rejectMalformed(params: unknown): JsonRecord {
    const optionID = shallowRejectOption(params);
    if (optionID === null) {
      this.#cancelled += 1;
      this.pushEvent({
        sessionID: null,
        toolCallID: null,
        toolName: null,
        decision: "cancelled",
        reason: "malformed",
      });
      return cancelled();
    }
    this.#rejected += 1;
    this.pushEvent({
      sessionID: null,
      toolCallID: null,
      toolName: null,
      decision: "reject_once",
      reason: "malformed",
    });
    return selected(optionID);
  }

  private reject(
    request: ParsedReadOnlyIntegrationPermissionRequest,
    reason: Exclude<
      AcpReadOnlyIntegrationPermissionAuditEvent["reason"],
      "allowed" | "malformed"
    >,
  ): JsonRecord {
    const option = request.options.find(
      (candidate) => candidate.kind === "reject_once",
    );
    if (option === undefined) {
      this.#cancelled += 1;
      this.pushEvent({
        sessionID: request.sessionID,
        toolCallID: request.toolCallID,
        toolName: request.toolName,
        decision: "cancelled",
        reason,
      });
      return cancelled();
    }
    this.#rejected += 1;
    this.pushEvent({
      sessionID: request.sessionID,
      toolCallID: request.toolCallID,
      toolName: request.toolName,
      decision: "reject_once",
      reason,
    });
    return selected(option.optionID);
  }

  private pushEvent(event: AcpReadOnlyIntegrationPermissionAuditEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxAuditEvents) this.#events.shift();
  }
}

export class AcpPermissionRouter {
  constructor(
    private readonly organum: BoundedAcpPermissionBroker,
    private readonly native: BoundedAcpNativePermissionBroker,
    private readonly serverName = ORGANUM_MCP_SERVER_NAME,
    private readonly readOnlyIntegration?:
      BoundedAcpReadOnlyIntegrationPermissionBroker,
  ) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(serverName) ||
      serverName.includes("__")
    ) {
      throw new TypeError("ACP permission router MCP server name is invalid");
    }
  }

  bindSession(sessionID: string): void {
    this.organum.bindSession(sessionID);
    this.native.bindSession(sessionID);
    this.readOnlyIntegration?.bindSession(sessionID);
  }

  readonly handle = async (params: unknown): Promise<JsonRecord> => {
    if (isOrganumPermissionRequest(params, this.serverName)) {
      return await this.organum.handle(params);
    }
    if (isUseToolPermissionRequest(params)) {
      return this.readOnlyIntegration === undefined
        ? await this.organum.handle(params)
        : await this.readOnlyIntegration.handle(params);
    }
    return await this.native.handle(params);
  };
}
