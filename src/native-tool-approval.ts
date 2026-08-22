import { z } from "zod";

import {
  TOOL_ARGUMENT_CANONICALIZATION,
  TOOL_ARGUMENT_DIGEST_ALGORITHM,
  TOOL_ARGUMENT_MAX_BYTES,
} from "./tool-argument-canonicalization.js";

export const NATIVE_TOOL_APPROVAL_SCHEMA =
  "organum-code/native-tool-approval/v1" as const;
export const NATIVE_TOOL_APPROVAL_CONFOUND_SCHEMA =
  "organum-code/native-tool-approval-confound/v1" as const;
export const NATIVE_TOOL_CAPABILITY_SCHEMA =
  "organum-code/native-tool-capability/v1" as const;
export const NATIVE_TOOL_APPROVAL_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-native-tool-approval-v1.schema.json" as const;
export const NATIVE_TOOL_CAPABILITY_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-native-tool-capability-v1.schema.json" as const;
export const NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_ID =
  "organum-native-multi-proposal-deny" as const;
export const NATIVE_TOOL_MULTI_PROPOSAL_DENIAL_POLICY_VERSION =
  "1.0.0" as const;

export const NATIVE_TOOL_INVARIANT_IDS = [
  "I1_PRE_EXEC",
  "I2_REQUEST_BINDING",
  "I3_REJECT_BLOCKS",
  "I4_EXACT_ONCE",
  "I5_CANCEL_CLOSE",
  "I6_SECRET_FREE",
  "I7_UNKNOWN_CLOSED",
  "I8_NO_STANDING_GRANT",
  "I9_SETTLED",
  "I10_CONTAINMENT_FLOOR",
] as const;

export type NativeToolInvariantID =
  (typeof NATIVE_TOOL_INVARIANT_IDS)[number];
export type NativeToolInvariantStatus = "pass" | "fail" | "unproven";
export type NativeToolCapabilityClass =
  | "full"
  | "partial"
  | "unavailable"
  | "blocked";

const backendIDSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const boundedIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,510}[A-Za-z0-9])?$/);
const boundedVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const timestampSchema = z.string().datetime();
const grantIDSchema = z.string().regex(/^ocgrant-[0-9a-f]{32}$/);
const nativeToolNameSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    if (value.includes("\u0000")) {
      context.addIssue({
        code: "custom",
        message: "native tool names must not contain NUL",
      });
    }
    if (Buffer.byteLength(value, "utf8") > 512) {
      context.addIssue({
        code: "custom",
        message: "native tool names must be at most 512 UTF-8 bytes",
      });
    }
  });
export const nativeToolEffectClassSchema = z.enum([
  "read",
  "write",
  "execute",
  "network",
  "mcp",
  "unknown",
]);
export type NativeToolEffectClass = z.infer<
  typeof nativeToolEffectClassSchema
>;

export const nativeApprovalPathSchema = z
  .object({
    backendId: backendIDSchema,
    backendVersion: boundedVersionSchema,
    productSurface: boundedIdentifierSchema,
    launchMode: boundedIdentifierSchema,
    platform: z.enum(["darwin", "linux", "win32"]),
    platformVersion: boundedVersionSchema,
  })
  .strict();

export const nativeToolDeciderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      presenter: boundedIdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("policy"),
      policyId: boundedIdentifierSchema,
      policyVersion: boundedVersionSchema,
    })
    .strict(),
]);

const approvalConfoundLatencySchema = z
  .object({
    count: z.number().int().min(0).max(1),
    sum: z.number().int().nonnegative().max(86_400_000),
    max: z.number().int().nonnegative().max(86_400_000),
  })
  .strict();

export const nativeToolApprovalConfoundSchema = z
  .object({
    schema: z.literal(NATIVE_TOOL_APPROVAL_CONFOUND_SCHEMA),
    productSurface: boundedIdentifierSchema,
    presentations: z.number().int().min(0).max(1),
    allowOnce: z.number().int().min(0).max(1),
    rejectOnce: z.number().int().min(0).max(1),
    cancelled: z.number().int().min(0).max(1),
    latencyMs: approvalConfoundLatencySchema,
    decider: nativeToolDeciderSchema.nullable(),
  })
  .strict()
  .superRefine((confound, context) => {
    const decisions =
      confound.allowOnce + confound.rejectOnce + confound.cancelled;
    if (
      decisions !== confound.presentations ||
      confound.latencyMs.count !== confound.presentations
    ) {
      context.addIssue({
        code: "custom",
        message:
          "approval confound decisions and latency count must equal presentations",
      });
    }
    if (
      confound.presentations === 0 &&
      (confound.latencyMs.sum !== 0 ||
        confound.latencyMs.max !== 0 ||
        confound.decider !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "an inactive approval confound requires zero latency and null decider",
      });
    }
    if (
      confound.presentations === 1 &&
      (confound.decider === null ||
        confound.latencyMs.max > confound.latencyMs.sum)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "an active approval confound requires a decider and bounded latency",
      });
    }
  });

export const nativeToolApprovalRequestSchema = z
  .object({
    requestedAt: timestampSchema,
    nativeToolCallId: boundedIdentifierSchema,
    nativeToolName: nativeToolNameSchema,
    effectClass: nativeToolEffectClassSchema,
    argumentCanonicalization: z.literal(TOOL_ARGUMENT_CANONICALIZATION),
    argumentDigestAlgorithm: z.literal(TOOL_ARGUMENT_DIGEST_ALGORITHM),
    argumentBytes: z.number().int().nonnegative().max(TOOL_ARGUMENT_MAX_BYTES),
    argumentSha256: sha256Schema,
  })
  .strict();

const grantAuditSchema = z
  .object({
    id: grantIDSchema,
    state: z.enum(["consumed", "revoked"]),
    settledAt: timestampSchema,
  })
  .strict();

const decisionReasonSchema = z.enum([
  "approved",
  "human_rejected",
  "policy_denied",
  "unknown_effect",
  "presenter_cancelled",
  "request_expired",
  "session_closed",
]);

export const nativeToolApprovalDecisionSchema = z
  .object({
    decidedAt: timestampSchema,
    decision: z.enum(["allow_once", "reject_once", "cancelled"]),
    reason: decisionReasonSchema,
    decider: nativeToolDeciderSchema,
    latencyMs: z.number().int().nonnegative().max(86_400_000),
    grant: grantAuditSchema.nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    const expectedReasons: Record<
      "allow_once" | "reject_once" | "cancelled",
      ReadonlySet<string>
    > = {
      allow_once: new Set(["approved"]),
      reject_once: new Set([
        "human_rejected",
        "policy_denied",
        "unknown_effect",
      ]),
      cancelled: new Set([
        "presenter_cancelled",
        "request_expired",
        "session_closed",
      ]),
    };
    if (!expectedReasons[decision.decision].has(decision.reason)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "decision reason does not match the decision",
      });
    }
    const hasGrant = decision.grant !== null;
    if ((decision.decision === "allow_once") !== hasGrant) {
      context.addIssue({
        code: "custom",
        path: ["grant"],
        message: "only allow_once decisions carry a terminal one-shot grant",
      });
    }
  });

export const nativeToolApprovalAuditSchema = z
  .object({
    schema: z.literal(NATIVE_TOOL_APPROVAL_SCHEMA),
    path: nativeApprovalPathSchema,
    actor: z
      .object({
        supervisorRoot: boundedIdentifierSchema,
        nativeSessionId: boundedIdentifierSchema,
        turnId: boundedIdentifierSchema,
      })
      .strict(),
    request: nativeToolApprovalRequestSchema,
    decision: nativeToolApprovalDecisionSchema,
  })
  .strict()
  .superRefine((audit, context) => {
    const requestedAt = Date.parse(audit.request.requestedAt);
    const decidedAt = Date.parse(audit.decision.decidedAt);
    if (decidedAt < requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["decision", "decidedAt"],
        message: "decision timestamp cannot precede the request",
      });
    }
    if (
      audit.decision.grant !== null &&
      Date.parse(audit.decision.grant.settledAt) < decidedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision", "grant", "settledAt"],
        message: "grant settlement cannot precede the decision",
      });
    }
    if (
      audit.request.effectClass === "unknown" &&
      audit.decision.decider.kind === "policy" &&
      (audit.decision.decision !== "reject_once" ||
        audit.decision.reason !== "unknown_effect")
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message:
          "policy must reject_once with unknown_effect for unknown native tool effects",
      });
    }
    if (
      audit.decision.decider.kind === "human" &&
      ((audit.decision.decision === "reject_once" &&
        audit.decision.reason !== "human_rejected") ||
        (audit.decision.decision === "cancelled" &&
          audit.decision.reason !== "presenter_cancelled"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision", "reason"],
        message: "human decision reason does not match human provenance",
      });
    }
    if (
      audit.decision.decider.kind === "policy" &&
      ((audit.decision.decision === "reject_once" &&
        audit.decision.reason !== "policy_denied" &&
        audit.decision.reason !== "unknown_effect") ||
        (audit.decision.decision === "cancelled" &&
          audit.decision.reason !== "request_expired" &&
          audit.decision.reason !== "session_closed"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision", "reason"],
        message: "policy decision reason does not match policy provenance",
      });
    }
  });

const invariantResultSchema = z
  .object({
    status: z.enum(["pass", "fail", "unproven"]),
    reason: z.enum([
      "verified",
      "counterexample",
      "fixture_failed",
      "not_observed",
      "surface_unavailable",
      "version_drift",
      "fixture_unavailable",
    ]),
    evidence: z
      .string()
      .regex(/^(?!\.{1,2}$)[^\\\u0000]{1,512}$/),
  })
  .strict()
  .superRefine((result, context) => {
    const validReasons: Record<NativeToolInvariantStatus, ReadonlySet<string>> = {
      pass: new Set(["verified"]),
      fail: new Set(["counterexample", "fixture_failed"]),
      unproven: new Set([
        "not_observed",
        "surface_unavailable",
        "version_drift",
        "fixture_unavailable",
      ]),
    };
    if (!validReasons[result.status].has(result.reason)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "invariant reason does not match its status",
      });
    }
  });

export const nativeToolInvariantVectorSchema = z
  .object({
    I1_PRE_EXEC: invariantResultSchema,
    I2_REQUEST_BINDING: invariantResultSchema,
    I3_REJECT_BLOCKS: invariantResultSchema,
    I4_EXACT_ONCE: invariantResultSchema,
    I5_CANCEL_CLOSE: invariantResultSchema,
    I6_SECRET_FREE: invariantResultSchema,
    I7_UNKNOWN_CLOSED: invariantResultSchema,
    I8_NO_STANDING_GRANT: invariantResultSchema,
    I9_SETTLED: invariantResultSchema,
    I10_CONTAINMENT_FLOOR: invariantResultSchema,
  })
  .strict();

type NativeToolInvariantVector = z.infer<
  typeof nativeToolInvariantVectorSchema
>;

export function deriveNativeToolCapabilityClass(
  invariants: Pick<
    NativeToolInvariantVector,
    NativeToolInvariantID
  >,
): NativeToolCapabilityClass {
  if (
    invariants.I6_SECRET_FREE.status === "fail" ||
    invariants.I10_CONTAINMENT_FLOOR.status === "fail"
  ) {
    return "blocked";
  }
  if (invariants.I1_PRE_EXEC.status !== "pass") {
    return "unavailable";
  }
  if (
    NATIVE_TOOL_INVARIANT_IDS.every(
      (invariant) => invariants[invariant].status === "pass",
    )
  ) {
    return "full";
  }
  return "partial";
}

export const nativeToolCapabilitySchema = z
  .object({
    schema: z.literal(NATIVE_TOOL_CAPABILITY_SCHEMA),
    path: nativeApprovalPathSchema,
    fixture: z
      .object({
        id: boundedIdentifierSchema,
        sourceRevision: gitCommitSchema,
        providerCalls: z.literal(0),
        argumentCanonicalization: z.literal(TOOL_ARGUMENT_CANONICALIZATION),
        policy: z
          .object({
            id: boundedIdentifierSchema,
            version: boundedVersionSchema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    invariants: nativeToolInvariantVectorSchema,
    classification: z.enum(["full", "partial", "unavailable", "blocked"]),
    receipt: z
      .string()
      .regex(/^(?!\.{1,2}$)[^/\\\u0000]{1,512}$/)
      .nullable(),
  })
  .strict()
  .superRefine((capability, context) => {
    const derived = deriveNativeToolCapabilityClass(capability.invariants);
    if (capability.classification !== derived) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: `classification must be derived as ${derived}`,
      });
    }
  });

export type NativeToolApprovalAudit = z.infer<
  typeof nativeToolApprovalAuditSchema
>;
export type NativeToolDecider = z.infer<typeof nativeToolDeciderSchema>;
export type NativeToolApprovalConfound = z.infer<
  typeof nativeToolApprovalConfoundSchema
>;

export function inactiveNativeToolApprovalConfound(
  productSurface: string,
): NativeToolApprovalConfound {
  return nativeToolApprovalConfoundSchema.parse({
    schema: NATIVE_TOOL_APPROVAL_CONFOUND_SCHEMA,
    productSurface,
    presentations: 0,
    allowOnce: 0,
    rejectOnce: 0,
    cancelled: 0,
    latencyMs: { count: 0, sum: 0, max: 0 },
    decider: null,
  });
}

export function decidedNativeToolApprovalConfound(input: {
  productSurface: string;
  decision: "allow_once" | "reject_once" | "cancelled";
  latencyMs: number;
  decider: NativeToolDecider;
}): NativeToolApprovalConfound {
  const latencyMs = Math.ceil(input.latencyMs);
  return nativeToolApprovalConfoundSchema.parse({
    schema: NATIVE_TOOL_APPROVAL_CONFOUND_SCHEMA,
    productSurface: input.productSurface,
    presentations: 1,
    allowOnce: input.decision === "allow_once" ? 1 : 0,
    rejectOnce: input.decision === "reject_once" ? 1 : 0,
    cancelled: input.decision === "cancelled" ? 1 : 0,
    latencyMs: { count: 1, sum: latencyMs, max: latencyMs },
    decider: input.decider,
  });
}
export type NativeToolCapability = z.infer<typeof nativeToolCapabilitySchema>;

export function classifyExactNativeToolEffect(
  nativeToolName: string,
  mappings: ReadonlyArray<{
    nativeToolName: string;
    effectClass: Exclude<NativeToolEffectClass, "unknown">;
  }>,
): NativeToolEffectClass {
  const candidate = nativeToolNameSchema.parse(nativeToolName);
  const exactMappings = new Map<
    string,
    Exclude<NativeToolEffectClass, "unknown">
  >();
  for (const mapping of mappings) {
    const mappedName = nativeToolNameSchema.parse(mapping.nativeToolName);
    const effectClass = nativeToolEffectClassSchema.parse(mapping.effectClass);
    if (effectClass === "unknown") {
      throw new Error("Explicit native tool mappings cannot target unknown");
    }
    if (exactMappings.has(mappedName)) {
      throw new Error(`Duplicate native tool mapping: ${mappedName}`);
    }
    exactMappings.set(mappedName, effectClass);
  }
  return exactMappings.get(candidate) ?? "unknown";
}

export function parseNativeToolApprovalAudit(
  input: unknown,
): NativeToolApprovalAudit {
  return nativeToolApprovalAuditSchema.parse(input);
}

export function parseNativeToolCapability(
  input: unknown,
): NativeToolCapability {
  return nativeToolCapabilitySchema.parse(input);
}

function structuralJSONSchema(
  schema: z.ZodType,
  id: string,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const { $schema, ...shape } = generated;
  return {
    $schema,
    $id: id,
    $comment:
      "Structural projection. The Zod source and its cross-field refinements remain authoritative.",
    ...shape,
  };
}

export function nativeToolApprovalStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    nativeToolApprovalAuditSchema,
    NATIVE_TOOL_APPROVAL_JSON_SCHEMA_ID,
  );
}

export function nativeToolCapabilityStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    nativeToolCapabilitySchema,
    NATIVE_TOOL_CAPABILITY_JSON_SCHEMA_ID,
  );
}
