import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import {
  InferenceBrokerError,
  NATIVE_TOOL_POLICY_DENIAL_TEXT_V1,
  type InferenceBrokerCompleteResponseProjection,
  type InferenceBrokerCompleteResponseProjectionInput,
  type InferenceBrokerCompleteResponseProjectionResult,
  type JsonObject,
} from "./inference-broker.js";
import {
  decidedNativeToolApprovalConfound,
  inactiveNativeToolApprovalConfound,
  NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID,
  NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION,
  type NativeToolApprovalConfound,
  type NativeToolDecider,
} from "./native-tool-approval.js";
import { GROK_PREREGISTERED_WRAPPER_PRODUCT_SURFACE } from "./grok-native-tool-wrapper-capability.js";
import {
  type GrokNativeToolProposal,
  grokNativeToolArgumentsSchema,
  GrokNativeToolSupervisor,
} from "./grok-native-tool-supervisor.js";
import {
  canonicalizeToolArguments,
  TOOL_ARGUMENT_CANONICALIZATION,
} from "./tool-argument-canonicalization.js";

export const GROK_NATIVE_TOOL_PROJECTION_MAX_BYTES = 4 * 1024 * 1024;

const NATIVE_TOOL_NAME = "run_terminal_command";
const WRAPPER_DESCRIPTION =
  "Run the one-shot Organum Code preregistered terminal wrapper";

type ProjectionState = "open" | "released" | "closed";

export interface GrokNativeToolCapabilityTransportSnapshot {
  state: ProjectionState;
  bound: boolean;
  releasedFrames: number;
  failedFrames: number;
}

/**
 * Parent-owned one-shot transport. The raw capability is copied directly into
 * the child pipe, zeroed in parent memory, and never enters argv, env, config,
 * or a projected tool argument.
 */
export class GrokNativeToolCapabilityTransport {
  #state: ProjectionState = "open";
  #writer: Writable | null = null;
  #releasedFrames = 0;
  #failedFrames = 0;

  bind(writer: Writable): void {
    if (this.#writer !== null) {
      throw new Error("Grok native tool capability transport is already bound");
    }
    if (this.#state !== "open") {
      writer.destroy();
      throw new Error("Grok native tool capability transport is closed");
    }
    if (writer.destroyed || !writer.writable) {
      throw new Error("Grok native tool capability writer is unavailable");
    }
    this.#writer = writer;
  }

  async release(capability: Buffer): Promise<void> {
    if (this.#state !== "open" || this.#releasedFrames !== 0) {
      capability.fill(0);
      throw new Error("Grok native tool capability transport is not reusable");
    }
    const writer = this.#writer;
    if (writer === null || writer.destroyed || !writer.writable) {
      capability.fill(0);
      this.#failedFrames += 1;
      this.close();
      throw new Error("Grok native tool capability writer is unavailable");
    }
    const frame = Buffer.alloc(capability.byteLength + 1);
    capability.copy(frame);
    frame[frame.byteLength - 1] = 0x0a;
    capability.fill(0);
    this.#state = "released";
    this.#releasedFrames += 1;
    try {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const onError = (error: Error): void => {
          writer.off("error", onError);
          rejectWrite(error);
        };
        writer.once("error", onError);
        writer.end(frame, () => {
          writer.off("error", onError);
          resolveWrite();
        });
      });
    } catch (error) {
      this.#failedFrames += 1;
      writer.destroy();
      throw error;
    } finally {
      frame.fill(0);
    }
  }

  close(): void {
    if (this.#state === "closed") return;
    const shouldEnd = this.#state === "open";
    this.#state = "closed";
    if (shouldEnd && this.#writer !== null && !this.#writer.destroyed) {
      this.#writer.end();
    }
  }

  snapshot(): GrokNativeToolCapabilityTransportSnapshot {
    return {
      state: this.#state,
      bound: this.#writer !== null,
      releasedFrames: this.#releasedFrames,
      failedFrames: this.#failedFrames,
    };
  }
}

export interface GrokNativeToolProjectionApprovalContext {
  requestBodySha256: string;
  argumentCanonicalization: typeof TOOL_ARGUMENT_CANONICALIZATION;
  argumentSha256: string;
}

export interface GrokNativeToolProjectionDecision {
  approved: boolean;
  decider: string;
  provenance?: NativeToolDecider;
}

export type GrokNativeToolProjectionApprover = (
  proposal: Readonly<GrokNativeToolProposal>,
  context: Readonly<GrokNativeToolProjectionApprovalContext>,
) =>
  | boolean
  | GrokNativeToolProjectionDecision
  | Promise<boolean | GrokNativeToolProjectionDecision>;

export interface GrokNativeToolResponseProjectionOptions {
  supervisor: GrokNativeToolSupervisor;
  transport: GrokNativeToolCapabilityTransport;
  wrapperCommand?: string;
  approve: GrokNativeToolProjectionApprover;
  maxBytes?: number;
  now?: () => number;
}

export interface GrokNativeToolResponseProjectionSnapshot {
  closed: boolean;
  busy: boolean;
  pendingCommit: boolean;
  projectedCalls: number;
  rejectedResponses: number;
  requestBodySha256: string | null;
  nativeToolCallId: string | null;
  nativeToolName: string | null;
  argumentSha256: string | null;
  decider: string | null;
  approvalConfound: NativeToolApprovalConfound;
  firstFailureCode: string | null;
  lastFailureCode: string | null;
}

interface ParsedResponse {
  values: JsonObject[];
  encode(values: readonly JsonObject[]): Uint8Array;
}

interface ToolAssembly {
  index: number;
  callId: string;
  name: string;
  argumentText: string;
  callFragments: Array<JsonObject>;
}

interface PendingToolAssembly {
  index: number;
  callId: string | null;
  name: string | null;
  argumentText: string;
  callFragments: Array<JsonObject>;
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function projectionError(message: string, code: string): InferenceBrokerError {
  return new InferenceBrokerError(message, 502, code);
}

function boundedUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw projectionError(
      "Grok response projection requires valid UTF-8",
      "grok_projection_invalid_utf8",
    );
  }
}

function parseJsonResponse(body: Uint8Array): ParsedResponse {
  let value: JsonObject;
  try {
    const parsed = object(JSON.parse(boundedUtf8(body)));
    if (parsed === null) throw new Error("not an object");
    value = parsed;
  } catch (error) {
    if (error instanceof InferenceBrokerError) throw error;
    throw projectionError(
      "Grok response projection received malformed JSON",
      "grok_projection_malformed_json",
    );
  }
  return {
    values: [value],
    encode(values) {
      return new TextEncoder().encode(JSON.stringify(values[0]));
    },
  };
}

interface SseEvent {
  lines: string[];
  separator: string;
  valueIndex: number | null;
}

function parseSseResponse(body: Uint8Array): ParsedResponse {
  const text = boundedUtf8(body);
  const events: SseEvent[] = [];
  const values: JsonObject[] = [];
  let offset = 0;
  let doneSeen = false;
  while (offset < text.length) {
    const separator = /\r?\n\r?\n/g;
    separator.lastIndex = offset;
    const match = separator.exec(text);
    const end = match?.index ?? text.length;
    const separatorText = match?.[0] ?? "";
    const lines = text.slice(offset, end).split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    let valueIndex: number | null = null;
    if (dataLines.length > 0) {
      const data = dataLines
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data === "[DONE]") {
        if (doneSeen) {
          throw projectionError(
            "Grok response projection received duplicate SSE termination",
            "grok_projection_malformed_sse",
          );
        }
        doneSeen = true;
      } else {
        if (doneSeen) {
          throw projectionError(
            "Grok response projection received data after SSE termination",
            "grok_projection_malformed_sse",
          );
        }
        try {
          const value = object(JSON.parse(data));
          if (value === null) throw new Error("not an object");
          valueIndex = values.length;
          values.push(value);
        } catch {
          throw projectionError(
            "Grok response projection received malformed SSE",
            "grok_projection_malformed_sse",
          );
        }
      }
    }
    events.push({ lines, separator: separatorText, valueIndex });
    if (match === null) break;
    offset = end + separatorText.length;
  }
  if (events.length === 0 || values.length === 0 || !doneSeen) {
    throw projectionError(
      "Grok response projection received an empty SSE response",
      "grok_projection_empty_sse",
    );
  }
  return {
    values,
    encode(projectedValues) {
      let output = "";
      for (const event of events) {
        if (event.valueIndex === null) {
          output += `${event.lines.join("\n")}${event.separator}`;
          continue;
        }
        const firstData = event.lines.findIndex((line) =>
          line.startsWith("data:")
        );
        const lines = event.lines.filter(
          (line, index) => !line.startsWith("data:") || index === firstData,
        );
        lines[firstData] = `data: ${
          JSON.stringify(projectedValues[event.valueIndex])
        }`;
        output += `${lines.join("\n")}${event.separator}`;
      }
      return new TextEncoder().encode(output);
    },
  };
}

function parseResponse(
  contentType: string,
  body: Uint8Array,
): ParsedResponse {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("text/event-stream")) return parseSseResponse(body);
  if (
    normalized.includes("application/json") ||
    normalized.includes("+json")
  ) {
    return parseJsonResponse(body);
  }
  throw projectionError(
    "Grok response projection received an unsupported content type",
    "grok_projection_content_type",
  );
}

function declaredTool(requestBody: Readonly<JsonObject>): JsonObject {
  const matches = Array.isArray(requestBody.tools)
    ? requestBody.tools.flatMap((candidate) => {
        const tool = object(candidate);
        const fn = object(tool?.function);
        return tool?.type === "function" && fn?.name === NATIVE_TOOL_NAME
          ? [fn]
          : [];
      })
    : [];
  if (matches.length !== 1) {
    throw projectionError(
      "Grok native terminal tool must be declared exactly once",
      "grok_projection_request_binding",
    );
  }
  const parameters = object(matches[0].parameters);
  const properties = object(parameters?.properties);
  const required = Array.isArray(parameters?.required)
    ? parameters.required
    : [];
  if (
    parameters?.type !== "object" ||
    properties === null ||
    object(properties.command)?.type !== "string" ||
    !required.includes("command")
  ) {
    throw projectionError(
      "Grok native terminal tool declaration has an incompatible schema",
      "grok_projection_request_binding",
    );
  }
  return matches[0];
}

function validateResponseModel(
  values: readonly JsonObject[],
  requestBody: Readonly<JsonObject>,
): void {
  if (typeof requestBody.model !== "string") {
    throw projectionError(
      "Grok projection request has no exact model binding",
      "grok_projection_request_binding",
    );
  }
  for (const value of values) {
    if (value.model !== undefined && value.model !== requestBody.model) {
      throw projectionError(
        "Grok response model does not match its broker request",
        "grok_projection_request_binding",
      );
    }
  }
}

function assembleToolCalls(
  values: readonly JsonObject[],
): ToolAssembly[] | null {
  let sawToolCall = false;
  let sawToolFinish = false;
  let sawAssistantContent = false;
  let sawIncompatibleFinish = false;
  const choiceIndexes = new Set<number>();
  const pending = new Map<number, PendingToolAssembly>();
  for (const value of values) {
    if (!Array.isArray(value.choices)) continue;
    for (const rawChoice of value.choices) {
      const choice = object(rawChoice);
      if (choice === null) {
        throw projectionError(
          "Grok response contains a malformed choice",
          "grok_projection_ambiguous_response",
        );
      }
      if (typeof choice.index === "number") choiceIndexes.add(choice.index);
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (choice.finish_reason === "tool_calls") sawToolFinish = true;
        else sawIncompatibleFinish = true;
      }
      const carrier = object(choice.delta) ?? object(choice.message);
      if (carrier === null) continue;
      if (
        typeof carrier.content === "string" &&
        carrier.content.length > 0
      ) {
        sawAssistantContent = true;
        if (sawToolCall || Array.isArray(carrier.tool_calls)) {
          throw projectionError(
            "Grok response mixes terminal authority with assistant content",
            "grok_projection_ambiguous_response",
          );
        }
      }
      if (!Array.isArray(carrier.tool_calls)) continue;
      for (const rawCall of carrier.tool_calls) {
        const call = object(rawCall);
        if (
          call === null ||
          !Number.isSafeInteger(call.index) ||
          (call.index as number) < 0
        ) {
          throw projectionError(
            "Grok response contains an invalid tool call index",
            "grok_projection_ambiguous_response",
          );
        }
        sawToolCall = true;
        const index = call.index as number;
        const assembly = pending.get(index) ?? {
          index,
          callId: null,
          name: null,
          argumentText: "",
          callFragments: [],
        };
        pending.set(index, assembly);
        assembly.callFragments.push(call);
        if (call.type !== undefined && call.type !== "function") {
          throw projectionError(
            "Grok response contains a non-function tool call",
            "grok_projection_ambiguous_response",
          );
        }
        if (call.id !== undefined) {
          if (
            typeof call.id !== "string" ||
            call.id.length === 0 ||
            call.id.includes("\u0000") ||
            (assembly.callId !== null && call.id !== assembly.callId)
          ) {
            throw projectionError(
              "Grok response contains conflicting tool call IDs",
              "grok_projection_request_binding",
            );
          }
          assembly.callId = call.id;
        }
        const fn = object(call.function);
        if (fn === null) continue;
        if (fn.name !== undefined && fn.name !== "") {
          if (
            typeof fn.name !== "string" ||
            (assembly.name !== null && fn.name !== assembly.name)
          ) {
            throw projectionError(
              "Grok response contains conflicting native tool names",
              "grok_projection_request_binding",
            );
          }
          assembly.name = fn.name;
        }
        if (fn.arguments !== undefined) {
          if (typeof fn.arguments !== "string") {
            throw projectionError(
              "Grok native tool arguments must be JSON text",
              "grok_projection_request_binding",
            );
          }
          assembly.argumentText += fn.arguments;
        }
      }
    }
  }
  if (!sawToolCall) {
    if (sawToolFinish) {
      throw projectionError(
        "Grok response finished as a tool call without one complete call",
        "grok_projection_ambiguous_response",
      );
    }
    return null;
  }
  if (
    choiceIndexes.size !== 1 ||
    !choiceIndexes.has(0) ||
    !sawToolFinish ||
    sawAssistantContent ||
    sawIncompatibleFinish
  ) {
    throw projectionError(
      "Grok response does not contain one complete terminal tool call",
      "grok_projection_ambiguous_response",
    );
  }
  const assemblies = [...pending.values()].sort((left, right) =>
    left.index - right.index
  );
  const callIds = new Set<string>();
  for (const [expectedIndex, assembly] of assemblies.entries()) {
    if (
      assembly.index !== expectedIndex ||
      assembly.callId === null ||
      assembly.name === null
    ) {
      throw projectionError(
        "Grok response does not contain complete contiguous tool calls",
        "grok_projection_ambiguous_response",
      );
    }
    if (callIds.has(assembly.callId)) {
      throw projectionError(
        "Grok response contains duplicate tool call IDs",
        "grok_projection_request_binding",
      );
    }
    callIds.add(assembly.callId);
  }
  return assemblies as ToolAssembly[];
}

function argumentsObject(text: string): Record<string, unknown> {
  try {
    const value = object(JSON.parse(text));
    if (value === null) throw new Error("not an object");
    return value;
  } catch {
    throw projectionError(
      "Grok native tool arguments are not one JSON object",
      "grok_projection_request_binding",
    );
  }
}

function requestBodySha256(body: Readonly<JsonObject>): string {
  return createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
}

function rewriteToolCall(
  assembly: ToolAssembly,
  wrapperCommand: string,
): void {
  const projectedArguments = JSON.stringify({
    command: wrapperCommand,
    description: WRAPPER_DESCRIPTION,
  });
  let emitted = false;
  for (const call of assembly.callFragments) {
    if (!emitted) {
      call.type = "function";
      call.function = {
        name: NATIVE_TOOL_NAME,
        arguments: projectedArguments,
      };
      emitted = true;
      continue;
    }
    if (call.function !== undefined) call.function = {};
  }
}

function rewriteToolDenial(values: readonly JsonObject[]): void {
  let contentEmitted = false;
  let terminalFinishEmitted = false;
  for (const value of values) {
    if (!Array.isArray(value.choices)) continue;
    for (const rawChoice of value.choices) {
      const choice = object(rawChoice);
      if (choice === null) continue;
      const carrier = object(choice.delta) ?? object(choice.message);
      if (carrier !== null && Array.isArray(carrier.tool_calls)) {
        delete carrier.tool_calls;
        if (!contentEmitted) {
          carrier.content = NATIVE_TOOL_POLICY_DENIAL_TEXT_V1;
          contentEmitted = true;
        }
      }
      if (choice.finish_reason === "tool_calls") {
        choice.finish_reason = "stop";
        terminalFinishEmitted = true;
      }
    }
  }
  if (!contentEmitted || !terminalFinishEmitted) {
    throw projectionError(
      "Grok native tool denial could not form a terminal response",
      "grok_projection_terminal_denial_invalid",
    );
  }
}

export class GrokNativeToolResponseProjection
  implements InferenceBrokerCompleteResponseProjection {
  readonly maxBytes: number;
  readonly #supervisor: GrokNativeToolSupervisor;
  readonly #transport: GrokNativeToolCapabilityTransport;
  #wrapperCommand: string | null;
  readonly #approve: GrokNativeToolProjectionApprover;
  readonly #now: () => number;
  #closed = false;
  #busy = false;
  #pendingCommit = false;
  #projectedCalls = 0;
  #rejectedResponses = 0;
  #requestBodySha256: string | null = null;
  #nativeToolCallId: string | null = null;
  #nativeToolName: string | null = null;
  #argumentSha256: string | null = null;
  #decider: string | null = null;
  #approvalConfound = inactiveNativeToolApprovalConfound(
    GROK_PREREGISTERED_WRAPPER_PRODUCT_SURFACE,
  );
  #firstFailureCode: string | null = null;
  #lastFailureCode: string | null = null;

  constructor(options: GrokNativeToolResponseProjectionOptions) {
    this.#supervisor = options.supervisor;
    this.#transport = options.transport;
    this.#wrapperCommand = options.wrapperCommand ?? null;
    this.#approve = options.approve;
    this.#now = options.now ?? performance.now.bind(performance);
    this.maxBytes =
      options.maxBytes ?? GROK_NATIVE_TOOL_PROJECTION_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      (this.#wrapperCommand !== null &&
        (this.#wrapperCommand.length === 0 ||
          this.#wrapperCommand.includes("\0")))
    ) {
      throw new TypeError("Grok native tool response projection is invalid");
    }
  }

  bindWrapperCommand(command: string): void {
    if (
      this.#wrapperCommand !== null ||
      command.length === 0 ||
      command.includes("\0")
    ) {
      throw new Error("Grok native tool wrapper command cannot be rebound");
    }
    this.#wrapperCommand = command;
  }

  async project(
    input: InferenceBrokerCompleteResponseProjectionInput,
  ): Promise<InferenceBrokerCompleteResponseProjectionResult> {
    if (this.#closed) {
      return this.#reject(
        "Grok response projection is closed",
        "grok_projection_closed",
      );
    }
    if (this.#busy || this.#pendingCommit) {
      return this.#reject(
        "Grok response projection is concurrently occupied",
        "grok_projection_concurrency",
      );
    }
    this.#busy = true;
    try {
      const parsed = parseResponse(input.contentType, input.body);
      validateResponseModel(parsed.values, input.requestBody);
      const assemblies = assembleToolCalls(parsed.values);
      if (assemblies === null) {
        return { body: input.body, observedValues: parsed.values };
      }
      if (this.#projectedCalls !== 0) {
        return this.#reject(
          "Grok response projection admits only one native tool call",
          "grok_projection_replay",
        );
      }
      declaredTool(input.requestBody);
      const proposals = assemblies.map((assembly) => {
        if (assembly.name !== NATIVE_TOOL_NAME) {
          return this.#reject(
            "Grok response selected an unadmitted native tool",
            "grok_projection_unknown_tool",
          );
        }
        const toolArguments = argumentsObject(assembly.argumentText);
        try {
          grokNativeToolArgumentsSchema.parse(toolArguments);
        } catch {
          return this.#reject(
            "Grok native terminal tool arguments do not match the admitted schema",
            "grok_projection_request_binding",
          );
        }
        return {
          nativeToolCallId: assembly.callId,
          nativeToolName: assembly.name,
          toolArguments,
        } satisfies GrokNativeToolProposal;
      });
      if (assemblies.length > 1) {
        const approvalStartedAt = this.#now();
        this.#recordDecision(
          "reject_once",
          approvalStartedAt,
          multiProposalDenialDecider,
        );
        this.#decider =
          `${NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID}@${NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION}`;
        this.#requestBodySha256 = requestBodySha256(input.requestBody);
        rewriteToolDenial(parsed.values);
        this.close();
        return {
          body: parsed.encode(parsed.values),
          observedValues: parsed.values,
        };
      }
      const assembly = assemblies[0]!;
      const proposal = proposals[0]!;
      const wrapperCommand = this.#wrapperCommand;
      if (wrapperCommand === null) {
        return this.#reject(
          "Grok native tool wrapper command is not bound",
          "grok_projection_wrapper_unavailable",
        );
      }
      const toolArguments = proposal.toolArguments;
      const canonical = canonicalizeToolArguments(toolArguments);
      if (this.#approvalConfound.presentations !== 0) {
        return this.#reject(
          "Grok native tool approval was already presented for this turn",
          "grok_projection_approval_replay",
        );
      }
      const requestDigest = requestBodySha256(input.requestBody);
      let approval: boolean | GrokNativeToolProjectionDecision;
      const approvalStartedAt = this.#now();
      try {
        approval = await this.#approve(proposal, {
          requestBodySha256: requestDigest,
          argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
          argumentSha256: canonical.sha256,
        });
      } catch {
        this.#recordDecision(
          "cancelled",
          approvalStartedAt,
          presenterFailureDecider,
        );
        return this.#reject(
          "Grok native terminal tool decider failed",
          "grok_projection_approval_failed",
        );
      }
      const decision = typeof approval === "boolean"
        ? {
            approved: approval,
            decider: "unspecified",
            provenance: unspecifiedDecider,
          }
        : approval;
      if (
        decision.decider.length === 0 ||
        decision.decider.length > 512 ||
        decision.decider.includes("\0")
      ) {
        this.#recordDecision(
          "cancelled",
          approvalStartedAt,
          presenterFailureDecider,
        );
        return this.#reject(
          "Grok native terminal tool decider provenance is invalid",
          "grok_projection_decider_invalid",
        );
      }
      try {
        this.#recordDecision(
          decision.approved ? "allow_once" : "reject_once",
          approvalStartedAt,
          decision.provenance ?? unspecifiedDecider,
        );
      } catch {
        this.#recordDecision(
          "cancelled",
          approvalStartedAt,
          presenterFailureDecider,
        );
        return this.#reject(
          "Grok native terminal tool decider provenance is invalid",
          "grok_projection_decider_invalid",
        );
      }
      this.#decider = decision.decider;
      if (!decision.approved) {
        rewriteToolDenial(parsed.values);
        this.close();
        return {
          body: parsed.encode(parsed.values),
          observedValues: parsed.values,
        };
      }
      if (!this.#supervisor.registerProposal(proposal)) {
        return this.#reject(
          "Grok native terminal tool proposal could not be preregistered",
          "grok_projection_registration_failed",
        );
      }
      this.#requestBodySha256 = requestDigest;
      this.#nativeToolCallId = assembly.callId;
      this.#nativeToolName = assembly.name;
      this.#argumentSha256 = canonical.sha256;
      rewriteToolCall(assembly, wrapperCommand);
      this.#pendingCommit = true;
      return {
        body: parsed.encode(parsed.values),
        observedValues: parsed.values,
        commit: async () => {
          if (this.#closed || !this.#pendingCommit) {
            throw projectionError(
              "Grok native terminal tool projection commit is unavailable",
              "grok_projection_commit_unavailable",
            );
          }
          const capability = this.#supervisor.takeConsumeCapability();
          if (capability === null) {
            throw projectionError(
              "Grok native terminal tool capability was not issued",
              "grok_projection_capability_unavailable",
            );
          }
          try {
            await this.#transport.release(capability);
          } catch {
            throw projectionError(
              "Grok native terminal tool capability transport failed",
              "grok_projection_capability_transport",
            );
          }
          this.#pendingCommit = false;
          this.#projectedCalls += 1;
        },
      };
    } catch (error) {
      if (error instanceof InferenceBrokerError) {
        this.#rejectedResponses += 1;
        this.#firstFailureCode ??= error.code;
        this.#lastFailureCode = error.code;
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  abort(error: unknown): void {
    if (error instanceof InferenceBrokerError) {
      this.#firstFailureCode ??= error.code;
      this.#lastFailureCode = error.code;
    }
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingCommit = false;
    this.#supervisor.close();
    this.#transport.close();
  }

  snapshot(): GrokNativeToolResponseProjectionSnapshot {
    return {
      closed: this.#closed,
      busy: this.#busy,
      pendingCommit: this.#pendingCommit,
      projectedCalls: this.#projectedCalls,
      rejectedResponses: this.#rejectedResponses,
      requestBodySha256: this.#requestBodySha256,
      nativeToolCallId: this.#nativeToolCallId,
      nativeToolName: this.#nativeToolName,
      argumentSha256: this.#argumentSha256,
      decider: this.#decider,
      approvalConfound: this.#approvalConfound,
      firstFailureCode: this.#firstFailureCode,
      lastFailureCode: this.#lastFailureCode,
    };
  }

  #reject(message: string, code: string): never {
    throw projectionError(message, code);
  }

  #recordDecision(
    decision: "allow_once" | "reject_once" | "cancelled",
    startedAt: number,
    decider: NativeToolDecider,
  ): void {
    this.#approvalConfound = decidedNativeToolApprovalConfound({
      productSurface: GROK_PREREGISTERED_WRAPPER_PRODUCT_SURFACE,
      decision,
      latencyMs: Math.max(0, this.#now() - startedAt),
      decider,
    });
  }
}

const unspecifiedDecider: NativeToolDecider = {
  kind: "policy",
  policyId: "organum-native-unspecified-decider",
  policyVersion: "1.0.0",
};

const presenterFailureDecider: NativeToolDecider = {
  kind: "policy",
  policyId: "organum-native-presenter-failure",
  policyVersion: "1.0.0",
};

const multiProposalDenialDecider: NativeToolDecider = {
  kind: "policy",
  policyId: NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID,
  policyVersion: NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION,
};
