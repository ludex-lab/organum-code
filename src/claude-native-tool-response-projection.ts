import { createHash } from "node:crypto";

import { z } from "zod";

import { ClaudeNativeToolSupervisor } from "./claude-native-tool-supervisor.js";
import {
  InferenceBrokerError,
  type InferenceBrokerAnthropicToolProjectionResult,
  type InferenceBrokerAnthropicToolProjection,
  type InferenceBrokerAnthropicToolProjectionInput,
  type JsonObject,
} from "./inference-broker.js";
import { canonicalizeToolArguments } from "./tool-argument-canonicalization.js";
import {
  decidedNativeToolApprovalConfound,
  inactiveNativeToolApprovalConfound,
  NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID,
  NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION,
  type NativeToolApprovalConfound,
  type NativeToolDecider,
} from "./native-tool-approval.js";
import { CLAUDE_PRODUCTION_HOOK_PRODUCT_SURFACE } from "./claude-native-tool-production-capability.js";

export const CLAUDE_NATIVE_TOOL_PROJECTION_MAX_BYTES =
  4 * 1024 * 1024;

const bashArgumentsSchema = z
  .object({
    command: z.string().min(1).max(65_536),
    description: z.string().min(1).max(4_096).optional(),
    timeout: z.number().int().positive().max(600_000).optional(),
    run_in_background: z.boolean().optional(),
  })
  .strict();

export interface ClaudeNativeToolProjectionApprovalContext {
  requestBodySha256: string;
  argumentSha256: string;
}

export interface ClaudeNativeToolProjectionApproval {
  approved: boolean;
  decider: string;
  provenance?: NativeToolDecider;
}

export type ClaudeNativeToolProjectionApprover = (
  proposal: Readonly<{
    nativeToolCallId: string;
    nativeToolName: "Bash";
    toolArguments: z.infer<typeof bashArgumentsSchema>;
  }>,
  context: Readonly<ClaudeNativeToolProjectionApprovalContext>,
) => Promise<ClaudeNativeToolProjectionApproval>;

export interface ClaudeNativeToolResponseProjectionOptions {
  supervisor: ClaudeNativeToolSupervisor;
  approve: ClaudeNativeToolProjectionApprover;
  maxBytes?: number;
  now?: () => number;
}

export interface ClaudeNativeToolResponseProjectionSnapshot {
  closed: boolean;
  approvalPending: boolean;
  projectedResponses: number;
  textResponses: number;
  proposalResponses: number;
  concurrentPresentationsRejected: number;
  approved: number;
  denied: number;
  registered: number;
  nativeToolCallId: string | null;
  decider: string | null;
  approvalConfound: NativeToolApprovalConfound;
  requestBodySha256: string | null;
  argumentSha256: string | null;
}

function projectionError(message: string, code: string): InferenceBrokerError {
  return new InferenceBrokerError(message, 502, code);
}

function declaredBashTool(requestBody: Readonly<JsonObject>): boolean {
  if (!Array.isArray(requestBody.tools)) return false;
  return requestBody.tools.filter((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const tool = value as JsonObject;
    if (
      tool.type !== "function" ||
      typeof tool.function !== "object" ||
      tool.function === null ||
      Array.isArray(tool.function)
    ) {
      return false;
    }
    return (tool.function as JsonObject).name === "Bash";
  }).length === 1;
}

export class ClaudeNativeToolResponseProjection
  implements InferenceBrokerAnthropicToolProjection {
  readonly maxBytes: number;
  readonly #supervisor: ClaudeNativeToolSupervisor;
  readonly #approve: ClaudeNativeToolProjectionApprover;
  readonly #now: () => number;
  #closed = false;
  #approvalPending = false;
  #projectedResponses = 0;
  #textResponses = 0;
  #proposalResponses = 0;
  #concurrentPresentationsRejected = 0;
  #approved = 0;
  #denied = 0;
  #registered = 0;
  #nativeToolCallId: string | null = null;
  #decider: string | null = null;
  #approvalConfound = inactiveNativeToolApprovalConfound(
    CLAUDE_PRODUCTION_HOOK_PRODUCT_SURFACE,
  );
  #requestBodySha256: string | null = null;
  #argumentSha256: string | null = null;

  constructor(options: ClaudeNativeToolResponseProjectionOptions) {
    this.#supervisor = options.supervisor;
    this.#approve = options.approve;
    this.#now = options.now ?? performance.now.bind(performance);
    this.maxBytes =
      options.maxBytes ?? CLAUDE_NATIVE_TOOL_PROJECTION_MAX_BYTES;
    if (
      !Number.isInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > 16 * 1024 * 1024
    ) {
      throw new TypeError("Claude native tool projection byte cap is invalid");
    }
  }

  async project(
    input: InferenceBrokerAnthropicToolProjectionInput,
  ): Promise<InferenceBrokerAnthropicToolProjectionResult> {
    if (this.#closed) {
      throw projectionError(
        "Claude native tool projection is closed",
        "claude_projection_closed",
      );
    }
    this.#projectedResponses += 1;
    if (input.proposals.length === 0) {
      this.#textResponses += 1;
      return {};
    }
    this.#proposalResponses += 1;
    if (this.#nativeToolCallId !== null) {
      throw projectionError(
        "Claude native tool projection admits only one native tool call",
        "claude_projection_replay",
      );
    }
    if (this.#approvalPending) {
      this.#concurrentPresentationsRejected += 1;
      throw projectionError(
        "Claude native tool approval already has one pending presentation",
        "claude_projection_concurrent_presentation",
      );
    }
    if (input.hasTextContent) {
      throw projectionError(
        "Claude native tool response is ambiguous",
        "claude_projection_ambiguous_response",
      );
    }
    if (!declaredBashTool(input.requestBody)) {
      throw projectionError(
        "Claude request did not declare the exact Bash tool",
        "claude_projection_request_binding",
      );
    }
    if (input.proposals.length > 1) {
      const callIds = new Set<string>();
      for (const proposal of input.proposals) {
        if (proposal.nativeToolName !== "Bash") {
          throw projectionError(
            "Claude native tool response used an unknown tool",
            "claude_projection_unknown_tool",
          );
        }
        if (
          proposal.nativeToolCallId.length === 0 ||
          proposal.nativeToolCallId.includes("\u0000") ||
          callIds.has(proposal.nativeToolCallId)
        ) {
          throw projectionError(
            "Claude native tool response contains conflicting call IDs",
            "claude_projection_request_binding",
          );
        }
        callIds.add(proposal.nativeToolCallId);
        try {
          bashArgumentsSchema.parse(proposal.toolArguments);
        } catch {
          throw projectionError(
            "Claude Bash arguments do not match the admitted schema",
            "claude_projection_argument_schema",
          );
        }
      }
      const approvalStartedAt = this.#now();
      this.#recordDecision(
        "reject_once",
        approvalStartedAt,
        multiProposalDenialDecider,
      );
      this.#decider =
        `${NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID}@${NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION}`;
      this.#requestBodySha256 = createHash("sha256")
        .update(JSON.stringify(input.requestBody))
        .digest("hex");
      this.#denied += 1;
      this.close();
      return { terminalDecision: "policy_denied" };
    }
    const proposal = input.proposals[0]!;
    if (proposal.nativeToolName !== "Bash") {
      throw projectionError(
        "Claude native tool response used an unknown tool",
        "claude_projection_unknown_tool",
      );
    }
    let toolArguments: z.infer<typeof bashArgumentsSchema>;
    try {
      toolArguments = bashArgumentsSchema.parse(proposal.toolArguments);
    } catch {
      throw projectionError(
        "Claude Bash arguments do not match the admitted schema",
        "claude_projection_argument_schema",
      );
    }
    const canonical = canonicalizeToolArguments(toolArguments);
    if (this.#approvalConfound.presentations !== 0) {
      throw projectionError(
        "Claude native tool approval was already presented for this turn",
        "claude_projection_approval_replay",
      );
    }
    const requestBodySha256 = createHash("sha256")
      .update(JSON.stringify(input.requestBody))
      .digest("hex");
    let approval: ClaudeNativeToolProjectionApproval;
    this.#approvalPending = true;
    const approvalStartedAt = this.#now();
    try {
      approval = await this.#approve({
        nativeToolCallId: proposal.nativeToolCallId,
        nativeToolName: "Bash",
        toolArguments,
      }, {
        requestBodySha256,
        argumentSha256: canonical.sha256,
      });
    } catch {
      this.#recordDecision(
        "cancelled",
        approvalStartedAt,
        presenterFailureDecider,
      );
      throw projectionError(
        "Claude native tool approval failed",
        "claude_projection_approval_failed",
      );
    } finally {
      this.#approvalPending = false;
    }
    if (
      typeof approval.decider !== "string" ||
      approval.decider.length === 0 ||
      approval.decider.length > 128
    ) {
      this.#recordDecision(
        "cancelled",
        approvalStartedAt,
        presenterFailureDecider,
      );
      throw projectionError(
        "Claude native tool decider is invalid",
        "claude_projection_decider_invalid",
      );
    }
    try {
      this.#recordDecision(
        approval.approved ? "allow_once" : "reject_once",
        approvalStartedAt,
        approval.provenance ?? unspecifiedDecider,
      );
    } catch {
      this.#recordDecision(
        "cancelled",
        approvalStartedAt,
        presenterFailureDecider,
      );
      throw projectionError(
        "Claude native tool decider is invalid",
        "claude_projection_decider_invalid",
      );
    }
    this.#decider = approval.decider;
    this.#requestBodySha256 = requestBodySha256;
    this.#argumentSha256 = canonical.sha256;
    if (!approval.approved) {
      this.#denied += 1;
      this.#nativeToolCallId = proposal.nativeToolCallId;
      this.close();
      return { terminalDecision: "policy_denied" };
    }
    this.#approved += 1;
    if (!this.#supervisor.registerProposal({
      nativeToolCallId: proposal.nativeToolCallId,
      nativeToolName: proposal.nativeToolName,
      toolArguments,
    })) {
      throw projectionError(
        "Claude native Bash proposal could not be preregistered",
        "claude_projection_registration_failed",
      );
    }
    this.#registered += 1;
    this.#nativeToolCallId = proposal.nativeToolCallId;
    return {};
  }

  abort(): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#supervisor.close();
  }

  snapshot(): ClaudeNativeToolResponseProjectionSnapshot {
    return {
      closed: this.#closed,
      approvalPending: this.#approvalPending,
      projectedResponses: this.#projectedResponses,
      textResponses: this.#textResponses,
      proposalResponses: this.#proposalResponses,
      concurrentPresentationsRejected:
        this.#concurrentPresentationsRejected,
      approved: this.#approved,
      denied: this.#denied,
      registered: this.#registered,
      nativeToolCallId: this.#nativeToolCallId,
      decider: this.#decider,
      approvalConfound: this.#approvalConfound,
      requestBodySha256: this.#requestBodySha256,
      argumentSha256: this.#argumentSha256,
    };
  }

  #recordDecision(
    decision: "allow_once" | "reject_once" | "cancelled",
    startedAt: number,
    decider: NativeToolDecider,
  ): void {
    this.#approvalConfound = decidedNativeToolApprovalConfound({
      productSurface: CLAUDE_PRODUCTION_HOOK_PRODUCT_SURFACE,
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
