import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CLAUDE_NATIVE_TOOL_HOOK_MAX_INPUT_BYTES,
  CLAUDE_NATIVE_TOOL_HOOK_PATH,
  CLAUDE_NATIVE_TOOL_HOOK_DECISION_SCHEMA,
  claudeNativeToolHookRequestSchema,
  type ClaudeNativeToolHookDecision,
  type ClaudeNativeToolHookRequest,
} from "./claude-native-tool-hook.js";
import {
  classifyExactNativeToolEffect,
  type NativeToolEffectClass,
} from "./native-tool-approval.js";
import { canonicalizeToolArguments } from "./tool-argument-canonicalization.js";
import type { InferenceBrokerAuxiliaryHandler } from "./inference-broker.js";

export type ClaudeNativeToolSupervisorRejectReason =
  | "policy_denied"
  | "unknown_effect"
  | "binding_mismatch"
  | "missing_proposal"
  | "busy"
  | "request_expired"
  | "session_closed";

export interface ClaudeNativeToolProposal {
  nativeToolCallId: string;
  nativeToolName: string;
  toolArguments: Record<string, unknown>;
}

interface PendingProposal {
  nativeToolCallId: string;
  nativeToolName: string;
  effectClass: Exclude<NativeToolEffectClass, "unknown">;
  argumentBytes: number;
  argumentSha256: string;
  canonicalBytes: Buffer;
  registeredAtMs: number;
}

export interface ClaudeNativeToolSupervisorSnapshot {
  sessionId: string;
  turnId: string;
  closed: boolean;
  pending: number;
  registered: number;
  issuedGrants: number;
  pendingGrants: number;
  consumed: number;
  revoked: number;
  rejected: number;
}

export interface ClaudeNativeToolTerminalGrant {
  id: string;
  state: "consumed";
}

export interface ClaudeNativeToolSupervisorOptions {
  sessionId: string;
  turnId: string;
  proposalTtlMs?: number;
  now?: () => number;
  allow?: (request: ClaudeNativeToolHookRequest) => boolean;
}

function classify(nativeToolName: string): NativeToolEffectClass {
  return classifyExactNativeToolEffect(nativeToolName, [
    { nativeToolName: "Bash", effectClass: "execute" },
  ]);
}

function decision(
  request: ClaudeNativeToolHookRequest,
  value: "allow_once" | "reject_once",
  reason: "approved" | ClaudeNativeToolSupervisorRejectReason,
): ClaudeNativeToolHookDecision {
  return {
    schema: CLAUDE_NATIVE_TOOL_HOOK_DECISION_SCHEMA,
    decision: value,
    reason,
    sessionId: request.sessionId,
    promptId: request.promptId,
    nativeToolCallId: request.nativeToolCallId,
    nativeToolName: request.nativeToolName,
    effectClass: request.effectClass,
    argumentBytes: request.argumentBytes,
    argumentSha256: request.argumentSha256,
  };
}

export class ClaudeNativeToolSupervisor {
  readonly #sessionId: string;
  readonly #turnId: string;
  readonly #proposalTtlMs: number;
  readonly #now: () => number;
  readonly #allow: (request: ClaudeNativeToolHookRequest) => boolean;
  #closed = false;
  #promptId: string | null = null;
  #pending: PendingProposal | null = null;
  #registered = 0;
  #issuedGrants = 0;
  #consumed = 0;
  #revoked = 0;
  #rejected = 0;
  #terminalGrants: ClaudeNativeToolTerminalGrant[] = [];

  constructor(options: ClaudeNativeToolSupervisorOptions) {
    if (
      options.sessionId.length === 0 ||
      options.sessionId.includes("\u0000") ||
      options.turnId.length === 0 ||
      options.turnId.includes("\u0000")
    ) {
      throw new Error("Claude supervisor actor identity is invalid");
    }
    const proposalTtlMs = options.proposalTtlMs ?? 10_000;
    if (
      !Number.isInteger(proposalTtlMs) ||
      proposalTtlMs < 1 ||
      proposalTtlMs > 300_000
    ) {
      throw new Error("Claude supervisor proposal TTL is invalid");
    }
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
    this.#proposalTtlMs = proposalTtlMs;
    this.#now = options.now ?? Date.now;
    this.#allow = options.allow ?? (() => true);
  }

  registerProposal(proposal: ClaudeNativeToolProposal): boolean {
    if (this.#closed || this.#pending !== null) return false;
    if (
      proposal.nativeToolCallId.length === 0 ||
      proposal.nativeToolCallId.includes("\u0000")
    ) {
      return false;
    }
    let effectClass: NativeToolEffectClass;
    let canonical: ReturnType<typeof canonicalizeToolArguments>;
    try {
      effectClass = classify(proposal.nativeToolName);
      canonical = canonicalizeToolArguments(proposal.toolArguments);
    } catch {
      return false;
    }
    if (effectClass === "unknown") return false;
    this.#pending = {
      nativeToolCallId: proposal.nativeToolCallId,
      nativeToolName: proposal.nativeToolName,
      effectClass,
      argumentBytes: canonical.byteLength,
      argumentSha256: canonical.sha256,
      canonicalBytes: Buffer.from(canonical.canonicalBytes),
      registeredAtMs: this.#now(),
    };
    this.#registered += 1;
    return true;
  }

  evaluate(input: unknown): ClaudeNativeToolHookDecision {
    const request = claudeNativeToolHookRequestSchema.parse(input);
    const failure = this.#bindingFailure(request);
    if (failure !== null) return this.#reject(request, failure);
    const pending = this.#pending;
    if (pending === null) return this.#reject(request, "missing_proposal");
    if (this.#expired(pending)) {
      this.#revokePending();
      return this.#reject(request, "request_expired");
    }
    const canonical = canonicalizeToolArguments(request.toolArguments);
    const exact =
      pending.nativeToolCallId === request.nativeToolCallId &&
      pending.nativeToolName === request.nativeToolName &&
      pending.effectClass === request.effectClass &&
      pending.argumentBytes === request.argumentBytes &&
      pending.argumentSha256 === request.argumentSha256 &&
      pending.canonicalBytes.equals(canonical.canonicalBytes);
    if (!exact) {
      this.#revokePending();
      return this.#reject(request, "binding_mismatch");
    }
    this.#promptId = request.promptId;
    if (!this.#allow(request)) {
      this.#revokePending();
      return this.#reject(request, "policy_denied");
    }
    const grantId = `ocgrant-${randomBytes(16).toString("hex")}`;
    this.#pending = null;
    pending.canonicalBytes.fill(0);
    this.#terminalGrants.push({ id: grantId, state: "consumed" });
    this.#issuedGrants += 1;
    this.#consumed += 1;
    return decision(request, "allow_once", "approved");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#revokePending();
  }

  snapshot(): ClaudeNativeToolSupervisorSnapshot {
    return {
      sessionId: this.#sessionId,
      turnId: this.#turnId,
      closed: this.#closed,
      pending: this.#pending === null ? 0 : 1,
      registered: this.#registered,
      issuedGrants: this.#issuedGrants,
      pendingGrants: 0,
      consumed: this.#consumed,
      revoked: this.#revoked,
      rejected: this.#rejected,
    };
  }

  terminalGrants(): readonly ClaudeNativeToolTerminalGrant[] {
    return this.#terminalGrants.map((grant) => ({ ...grant }));
  }

  #bindingFailure(
    request: ClaudeNativeToolHookRequest,
  ): ClaudeNativeToolSupervisorRejectReason | null {
    if (this.#closed) return "session_closed";
    if (request.sessionId !== this.#sessionId) return "binding_mismatch";
    if (this.#promptId !== null && request.promptId !== this.#promptId) {
      return "binding_mismatch";
    }
    let canonical: ReturnType<typeof canonicalizeToolArguments>;
    try {
      canonical = canonicalizeToolArguments(request.toolArguments);
    } catch {
      return "binding_mismatch";
    }
    if (
      canonical.canonicalization !== request.argumentCanonicalization ||
      canonical.digestAlgorithm !== request.argumentDigestAlgorithm ||
      canonical.byteLength !== request.argumentBytes ||
      canonical.sha256 !== request.argumentSha256
    ) {
      return "binding_mismatch";
    }
    if (
      request.nativeToolName !== "Bash" ||
      request.effectClass !== "execute"
    ) {
      return "unknown_effect";
    }
    return null;
  }

  #expired(pending: PendingProposal): boolean {
    return this.#now() - pending.registeredAtMs > this.#proposalTtlMs;
  }

  #revokePending(): void {
    if (this.#pending === null) return;
    this.#pending.canonicalBytes.fill(0);
    this.#pending = null;
    this.#revoked += 1;
  }

  #reject(
    request: ClaudeNativeToolHookRequest,
    reason: ClaudeNativeToolSupervisorRejectReason,
  ): ClaudeNativeToolHookDecision {
    this.#rejected += 1;
    return decision(request, "reject_once", reason);
  }
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > CLAUDE_NATIVE_TOOL_HOOK_MAX_INPUT_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function respond(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export function createClaudeNativeToolAuxiliaryHandler(
  supervisor: ClaudeNativeToolSupervisor,
): InferenceBrokerAuxiliaryHandler {
  return async ({ request, response, url }) => {
    if (url.pathname !== CLAUDE_NATIVE_TOOL_HOOK_PATH) return false;
    if (
      request.method !== "POST" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      respond(response, 404, { error: "unavailable" });
      return true;
    }
    const input = await readBoundedJson(request);
    try {
      const decision = supervisor.evaluate(input);
      respond(response, 200, decision);
    } catch {
      respond(response, 422, { error: "invalid_request" });
    }
    return true;
  };
}
