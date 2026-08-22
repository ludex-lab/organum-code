import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { z } from "zod";

import type { InferenceBrokerAuxiliaryHandler } from "./inference-broker.js";
import {
  classifyExactNativeToolEffect,
  type NativeToolEffectClass,
} from "./native-tool-approval.js";
import {
  canonicalizeToolArguments,
  TOOL_ARGUMENT_CANONICALIZATION,
  TOOL_ARGUMENT_DIGEST_ALGORITHM,
} from "./tool-argument-canonicalization.js";

export const GROK_NATIVE_TOOL_CONSUME_PATH =
  "/grok-native-tool-wrapper" as const;
export const GROK_NATIVE_TOOL_CONSUME_SCHEMA =
  "organum-code/grok-native-tool-consume/v1" as const;
export const GROK_NATIVE_TOOL_EXECUTION_SCHEMA =
  "organum-code/grok-native-tool-execution/v1" as const;
export const GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV =
  "ORGANUM_CODE_GROK_TOOL_ENDPOINT" as const;
export const GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV =
  "ORGANUM_CODE_GROK_TOOL_SESSION" as const;
export const GROK_NATIVE_TOOL_WRAPPER_TURN_ENV =
  "ORGANUM_CODE_GROK_TOOL_TURN" as const;
// Grok's persistent shell reserves fd 3 and fd 4 for shell-state transport.
export const GROK_NATIVE_TOOL_CONSUME_CAPABILITY_FD = 9 as const;

const MAX_COMMAND_BYTES = 65_536;
const MAX_AUXILIARY_REQUEST_BYTES = 16_384;
const boundedIdentity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"));
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const grantId = z.string().regex(/^ocgrant-[0-9a-f]{32}$/);
const consumeCapability = z.string().regex(/^occonsume-[0-9a-f]{64}$/);
export const grokNativeToolArgumentsSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(MAX_COMMAND_BYTES)
      .refine((value) =>
        !value.includes("\0") &&
        Buffer.byteLength(value, "utf8") <= MAX_COMMAND_BYTES
      ),
    description: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0"))
      .optional(),
  })
  .strict();

export const grokNativeToolConsumeRequestSchema = z
  .object({
    schema: z.literal(GROK_NATIVE_TOOL_CONSUME_SCHEMA),
    sessionId: boundedIdentity,
    turnId: boundedIdentity,
    consumeCapability,
  })
  .strict();

export const grokNativeToolExecutionSchema = z
  .object({
    schema: z.literal(GROK_NATIVE_TOOL_EXECUTION_SCHEMA),
    sessionId: boundedIdentity,
    turnId: boundedIdentity,
    nativeToolCallId: boundedIdentity,
    nativeToolName: z.literal("run_terminal_command"),
    effectClass: z.literal("execute"),
    argumentCanonicalization: z.literal(TOOL_ARGUMENT_CANONICALIZATION),
    argumentDigestAlgorithm: z.literal(TOOL_ARGUMENT_DIGEST_ALGORITHM),
    argumentBytes: z.number().int().nonnegative(),
    argumentSha256: sha256,
    grantId,
    command: grokNativeToolArgumentsSchema.shape.command,
  })
  .strict();

export type GrokNativeToolConsumeRequest = z.infer<
  typeof grokNativeToolConsumeRequestSchema
>;
export type GrokNativeToolExecution = z.infer<
  typeof grokNativeToolExecutionSchema
>;

export interface GrokNativeToolProposal {
  nativeToolCallId: string;
  nativeToolName: string;
  toolArguments: Record<string, unknown>;
}

interface PendingProposal {
  nativeToolCallId: string;
  nativeToolName: "run_terminal_command";
  effectClass: "execute";
  argumentBytes: number;
  argumentSha256: string;
  canonicalBytes: Buffer;
  command: string;
  registeredAtMs: number;
}

export type GrokNativeToolSupervisorRejectReason =
  | "binding_mismatch"
  | "busy"
  | "consume_capability_mismatch"
  | "missing_proposal"
  | "policy_denied"
  | "request_expired"
  | "session_closed"
  | "unknown_effect";

export interface GrokNativeToolSupervisorSnapshot {
  sessionId: string;
  turnId: string;
  closed: boolean;
  pending: number;
  registered: number;
  issuedGrants: number;
  pendingGrants: number;
  issuedConsumeCapabilities: number;
  pendingConsumeCapabilities: number;
  consumedConsumeCapabilities: number;
  revokedConsumeCapabilities: number;
  consumed: number;
  revoked: number;
  rejected: number;
  lastRejectReason: GrokNativeToolSupervisorRejectReason | null;
}

export interface GrokNativeToolTerminalGrant {
  id: string;
  state: "consumed";
}

export interface GrokNativeToolSupervisorOptions {
  sessionId: string;
  turnId: string;
  proposalTtlMs?: number;
  now?: () => number;
  allow?: (proposal: GrokNativeToolProposal) => boolean;
}

function classify(nativeToolName: string): NativeToolEffectClass {
  return classifyExactNativeToolEffect(nativeToolName, [{
    nativeToolName: "run_terminal_command",
    effectClass: "execute",
  }]);
}

export class GrokNativeToolSupervisor {
  readonly #sessionId: string;
  readonly #turnId: string;
  readonly #proposalTtlMs: number;
  readonly #now: () => number;
  readonly #allow: (proposal: GrokNativeToolProposal) => boolean;
  #closed = false;
  #pending: PendingProposal | null = null;
  #registered = 0;
  #issuedGrants = 0;
  #issuedConsumeCapabilities = 0;
  #consumedConsumeCapabilities = 0;
  #revokedConsumeCapabilities = 0;
  #consumed = 0;
  #revoked = 0;
  #rejected = 0;
  #lastRejectReason: GrokNativeToolSupervisorRejectReason | null = null;
  #terminalGrants: GrokNativeToolTerminalGrant[] = [];
  #pendingConsumeCapability: Buffer | null = null;
  #pendingConsumeCapabilityDigest: Buffer | null = null;

  constructor(options: GrokNativeToolSupervisorOptions) {
    this.#sessionId = boundedIdentity.parse(options.sessionId);
    this.#turnId = boundedIdentity.parse(options.turnId);
    const ttl = options.proposalTtlMs ?? 10_000;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300_000) {
      throw new Error("Grok native tool proposal TTL is invalid");
    }
    this.#proposalTtlMs = ttl;
    this.#now = options.now ?? Date.now;
    this.#allow = options.allow ?? (() => true);
  }

  registerProposal(proposal: GrokNativeToolProposal): boolean {
    if (this.#closed || this.#pending !== null) {
      this.#reject(this.#closed ? "session_closed" : "busy");
      return false;
    }
    let effectClass: NativeToolEffectClass;
    try {
      boundedIdentity.parse(proposal.nativeToolCallId);
      effectClass = classify(proposal.nativeToolName);
    } catch {
      this.#reject("binding_mismatch");
      return false;
    }
    if (effectClass === "unknown") {
      this.#reject("unknown_effect");
      return false;
    }
    let arguments_: z.infer<typeof grokNativeToolArgumentsSchema>;
    let canonical: ReturnType<typeof canonicalizeToolArguments>;
    try {
      arguments_ = grokNativeToolArgumentsSchema.parse(proposal.toolArguments);
      canonical = canonicalizeToolArguments(proposal.toolArguments);
    } catch {
      this.#reject("binding_mismatch");
      return false;
    }
    this.#pending = {
      nativeToolCallId: proposal.nativeToolCallId,
      nativeToolName: "run_terminal_command",
      effectClass: "execute",
      argumentBytes: canonical.byteLength,
      argumentSha256: canonical.sha256,
      canonicalBytes: Buffer.from(canonical.canonicalBytes),
      command: arguments_.command,
      registeredAtMs: this.#now(),
    };
    this.#pendingConsumeCapability = Buffer.from(
      `occonsume-${randomBytes(32).toString("hex")}`,
      "utf8",
    );
    this.#pendingConsumeCapabilityDigest = createHash("sha256")
      .update(this.#pendingConsumeCapability)
      .digest();
    this.#registered += 1;
    return true;
  }

  takeConsumeCapability(): Buffer | null {
    const capability = this.#pendingConsumeCapability;
    if (capability === null || this.#pendingConsumeCapabilityDigest === null) {
      return null;
    }
    this.#pendingConsumeCapability = null;
    this.#issuedConsumeCapabilities += 1;
    return capability;
  }

  consume(input: unknown): GrokNativeToolExecution | null {
    let request: GrokNativeToolConsumeRequest;
    try {
      request = grokNativeToolConsumeRequestSchema.parse(input);
    } catch {
      this.#reject("binding_mismatch");
      return null;
    }
    if (this.#closed) {
      this.#reject("session_closed");
      return null;
    }
    if (
      request.sessionId !== this.#sessionId ||
      request.turnId !== this.#turnId
    ) {
      this.#reject("binding_mismatch");
      return null;
    }
    const pending = this.#pending;
    if (pending === null) {
      this.#reject("missing_proposal");
      return null;
    }
    const capabilityDigest = this.#pendingConsumeCapabilityDigest;
    const presentedDigest = createHash("sha256")
      .update(request.consumeCapability, "utf8")
      .digest();
    if (
      capabilityDigest === null ||
      !timingSafeEqual(presentedDigest, capabilityDigest)
    ) {
      presentedDigest.fill(0);
      this.#reject("consume_capability_mismatch");
      return null;
    }
    presentedDigest.fill(0);
    this.#consumePendingCapability();
    if (this.#now() - pending.registeredAtMs > this.#proposalTtlMs) {
      this.#revokePending();
      this.#reject("request_expired");
      return null;
    }
    const proposal: GrokNativeToolProposal = {
      nativeToolCallId: pending.nativeToolCallId,
      nativeToolName: pending.nativeToolName,
      toolArguments: JSON.parse(
        pending.canonicalBytes.toString("utf8"),
      ) as Record<string, unknown>,
    };
    if (!this.#allow(proposal)) {
      this.#revokePending();
      this.#reject("policy_denied");
      return null;
    }
    const id = `ocgrant-${randomBytes(16).toString("hex")}`;
    this.#pending = null;
    pending.canonicalBytes.fill(0);
    this.#issuedGrants += 1;
    this.#consumed += 1;
    this.#terminalGrants.push({ id, state: "consumed" });
    return grokNativeToolExecutionSchema.parse({
      schema: GROK_NATIVE_TOOL_EXECUTION_SCHEMA,
      sessionId: this.#sessionId,
      turnId: this.#turnId,
      nativeToolCallId: pending.nativeToolCallId,
      nativeToolName: pending.nativeToolName,
      effectClass: pending.effectClass,
      argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
      argumentDigestAlgorithm: TOOL_ARGUMENT_DIGEST_ALGORITHM,
      argumentBytes: pending.argumentBytes,
      argumentSha256: pending.argumentSha256,
      grantId: id,
      command: pending.command,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#revokePending();
  }

  snapshot(): GrokNativeToolSupervisorSnapshot {
    return {
      sessionId: this.#sessionId,
      turnId: this.#turnId,
      closed: this.#closed,
      pending: this.#pending === null ? 0 : 1,
      registered: this.#registered,
      issuedGrants: this.#issuedGrants,
      pendingGrants: 0,
      issuedConsumeCapabilities: this.#issuedConsumeCapabilities,
      pendingConsumeCapabilities:
        this.#pendingConsumeCapabilityDigest === null ? 0 : 1,
      consumedConsumeCapabilities: this.#consumedConsumeCapabilities,
      revokedConsumeCapabilities: this.#revokedConsumeCapabilities,
      consumed: this.#consumed,
      revoked: this.#revoked,
      rejected: this.#rejected,
      lastRejectReason: this.#lastRejectReason,
    };
  }

  terminalGrants(): readonly GrokNativeToolTerminalGrant[] {
    return this.#terminalGrants.map((grant) => ({ ...grant }));
  }

  #revokePending(): void {
    if (this.#pending === null) return;
    this.#pending.canonicalBytes.fill(0);
    this.#pending = null;
    this.#revokePendingCapability();
    this.#revoked += 1;
  }

  #consumePendingCapability(): void {
    this.#pendingConsumeCapability?.fill(0);
    this.#pendingConsumeCapability = null;
    this.#pendingConsumeCapabilityDigest?.fill(0);
    this.#pendingConsumeCapabilityDigest = null;
    this.#consumedConsumeCapabilities += 1;
  }

  #revokePendingCapability(): void {
    if (this.#pendingConsumeCapabilityDigest === null) return;
    this.#pendingConsumeCapability?.fill(0);
    this.#pendingConsumeCapability = null;
    this.#pendingConsumeCapabilityDigest.fill(0);
    this.#pendingConsumeCapabilityDigest = null;
    this.#revokedConsumeCapabilities += 1;
  }

  #reject(reason: GrokNativeToolSupervisorRejectReason): void {
    this.#rejected += 1;
    this.#lastRejectReason = reason;
  }
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_AUXILIARY_REQUEST_BYTES) return null;
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

export function createGrokNativeToolAuxiliaryHandler(
  supervisor: GrokNativeToolSupervisor,
): InferenceBrokerAuxiliaryHandler {
  return async ({ request, response, url }) => {
    if (url.pathname !== GROK_NATIVE_TOOL_CONSUME_PATH) return false;
    if (
      request.method !== "POST" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      respond(response, 404, { error: "unavailable" });
      return true;
    }
    const execution = supervisor.consume(await readBoundedJson(request));
    if (execution === null) {
      respond(response, 409, { error: "unavailable" });
      return true;
    }
    respond(response, 200, execution);
    return true;
  };
}
