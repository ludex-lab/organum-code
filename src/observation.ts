import { createHash } from "node:crypto";

import { z } from "zod";

import type { InferenceBrokerSnapshot } from "./inference-broker.js";
import { nativeToolApprovalConfoundSchema } from "./native-tool-approval.js";

export const ORGANUM_CODE_OBSERVATION_SCHEMA =
  "organum-code/observation/v1" as const;
export const ORGANUM_CODE_USAGE_SEMANTICS =
  "organum-code/provider-usage/v1" as const;
export const ORGANUM_CODE_OBSERVATION_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-observation-v1.schema.json" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const timestampSchema = z.string().datetime();
const nonnegativeInteger = z.number().int().nonnegative();
const nullableNonnegativeInteger = nonnegativeInteger.nullable();
const canonicalCellSchema = z
  .string()
  .regex(/^(?!\.)(?!.*\.$)[a-z0-9._-]{1,40}$/);
const receiptFileSchema = z
  .string()
  .regex(/^(?!\.{1,2}$)[^/\\\u0000]{1,512}$/);

export const observationBackendIDSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const observationUsageSchema = z
  .object({
    semantics: z.literal(ORGANUM_CODE_USAGE_SEMANTICS),
    source: z.enum(["inference-broker", "native-passive", "unavailable"]),
    completeness: z.enum(["complete", "lower-bound", "unavailable"]),
    requests: nullableNonnegativeInteger,
    responses: nullableNonnegativeInteger,
    inputTokens: nullableNonnegativeInteger,
    outputTokens: nullableNonnegativeInteger,
    cachedInputTokens: nullableNonnegativeInteger,
    totalTokens: nullableNonnegativeInteger,
    reasoningTokens: nullableNonnegativeInteger,
    costUsd: z.number().nonnegative().finite().nullable(),
  })
  .strict()
  .superRefine((usage, context) => {
    const tokenFields = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.totalTokens,
      usage.reasoningTokens,
    ];
    if (usage.completeness === "unavailable") {
      if (
        usage.source !== "unavailable" ||
        usage.requests !== null ||
        usage.responses !== null ||
        usage.costUsd !== null ||
        tokenFields.some((value) => value !== null)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "unavailable usage must use the unavailable source and null counters",
        });
      }
      return;
    }
    if (
      usage.source === "unavailable" ||
      usage.responses === null ||
      tokenFields.some((value) => value === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "complete or lower-bound usage requires a measured source, responses, and token counters",
      });
      return;
    }
    if (usage.completeness === "complete" && usage.requests === null) {
      context.addIssue({
        code: "custom",
        path: ["requests"],
        message: "complete usage requires a provider request count",
      });
    }
    if (
      usage.requests !== null &&
      usage.responses !== null &&
      usage.responses > usage.requests
    ) {
      context.addIssue({
        code: "custom",
        path: ["responses"],
        message: "usage responses cannot exceed provider requests",
      });
    }
    const input = usage.inputTokens as number;
    const output = usage.outputTokens as number;
    const cached = usage.cachedInputTokens as number;
    const total = usage.totalTokens as number;
    const reasoning = usage.reasoningTokens as number;
    if (cached > input) {
      context.addIssue({
        code: "custom",
        path: ["cachedInputTokens"],
        message: "cached input tokens must be a subset of input tokens",
      });
    }
    if (reasoning > output) {
      context.addIssue({
        code: "custom",
        path: ["reasoningTokens"],
        message: "reasoning tokens must be a subset of output tokens",
      });
    }
    if (total !== input + output) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "total tokens must equal input plus output tokens",
      });
    }
  });

export const organumCodeObservationSchema = z
  .object({
    schema: z.literal(ORGANUM_CODE_OBSERVATION_SCHEMA),
    run: z
      .object({
        id: z.string().regex(/^ocobs-[0-9a-f]{64}$/),
        attempt: z.number().int().positive(),
        status: z.enum([
          "passed",
          "failed",
          "timeout",
          "cancelled",
          "error",
        ]),
        startedAt: timestampSchema.nullable(),
        finishedAt: timestampSchema.nullable(),
        recordedAt: timestampSchema,
        timingCompleteness: z.enum(["complete", "partial"]),
        comparisonKey: sha256Schema.nullable(),
        preregistrationId: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    identity: z
      .object({
        canonicalCell: canonicalCellSchema.nullable(),
        joinStatus: z.enum(["joined", "not-joined", "unknown"]),
        role: z.string().min(1).max(64).nullable(),
        persona: canonicalCellSchema.nullable(),
        workspace: canonicalCellSchema.nullable(),
      })
      .strict(),
    backend: z
      .object({
        id: observationBackendIDSchema,
        version: z.string().min(1).max(512).nullable(),
        protocol: z.string().min(1).max(64),
        nativeSessionId: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    brain: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(256),
        protocol: z.string().min(1).max(64),
        reasoning: z
          .object({
            enabled: z.boolean().nullable(),
            effort: z.string().min(1).max(64).nullable(),
          })
          .strict(),
      })
      .strict(),
    usage: observationUsageSchema,
    coordination: z
      .object({
        contributions: nonnegativeInteger,
        topic: z.string().min(1).max(128).nullable(),
        publicationPhase: z.string().min(1).max(64).nullable(),
        sessionClosed: z.boolean().nullable(),
        receipt: z
          .object({
            file: receiptFileSchema,
            bodyBytes: nonnegativeInteger,
            bodySha256: sha256Schema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    discipline: z
      .object({
        nativeToolApproval: nativeToolApprovalConfoundSchema
          .nullable()
          .optional(),
        commands: z.array(z.string().max(4_096)).max(256),
        declaredExecutions: nullableNonnegativeInteger,
        additionalReadOnlyCommands: nullableNonnegativeInteger,
        strictSingleExecute: z.boolean().nullable(),
        executionBudgetPhase: z.string().min(1).max(64).nullable(),
        checkpointActuations: nullableNonnegativeInteger,
        conservationActuations: nullableNonnegativeInteger,
        worktreeClean: z.boolean().nullable(),
      })
      .strict(),
    outcome: z
      .object({
        gate: z.enum(["pass", "fail", "partial", "not-evaluated"]),
        classification: z.string().min(1).max(1_024),
        causalClaim: z.enum(["observational", "controlled"]),
        checks: z.record(z.string().min(1).max(128), z.boolean()),
      })
      .strict(),
    provenance: z
      .object({
        observationSource: z.literal("reported"),
        producer: z
          .object({
            name: z.literal("organum-code"),
            version: z.string().min(1).max(128),
            commit: gitCommitSchema.nullable(),
          })
          .strict(),
        source: z
          .object({
            schema: z.string().min(1).max(256),
            digest: sha256Schema,
            repositoryCommit: gitCommitSchema.nullable(),
            priorFailure: z
              .object({
                backendId: observationBackendIDSchema,
                nativeSessionId: z.string().min(1).max(256),
                runId: z.string().regex(/^ocobs-[0-9a-f]{64}$/).nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      })
      .strict(),
    evaluation: z
      .object({
        name: z.string().min(1).max(256),
        scenario: z.string().min(1).max(512).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.identity.joinStatus === "joined" &&
      observation.identity.canonicalCell === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["identity", "canonicalCell"],
        message: "joined observations require a canonical cell",
      });
    }
    if (
      observation.identity.joinStatus === "not-joined" &&
      observation.identity.canonicalCell !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["identity", "canonicalCell"],
        message: "not-joined observations cannot claim a canonical cell",
      });
    }
    if (
      observation.identity.persona === null !==
      (observation.identity.workspace === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "persona and workspace must be present or absent together",
      });
    }
    if (
      observation.run.timingCompleteness === "complete" &&
      (observation.run.startedAt === null ||
        observation.run.finishedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "timingCompleteness"],
        message: "complete timing requires start and finish timestamps",
      });
    }
    if (
      observation.run.startedAt !== null &&
      observation.run.finishedAt !== null &&
      Date.parse(observation.run.startedAt) >
        Date.parse(observation.run.finishedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "finishedAt"],
        message: "finish timestamp cannot precede start timestamp",
      });
    }
    if (
      observation.run.finishedAt !== null &&
      Date.parse(observation.run.finishedAt) >
        Date.parse(observation.run.recordedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "recordedAt"],
        message: "record timestamp cannot precede finish timestamp",
      });
    }
    if (
      observation.run.startedAt !== null &&
      Date.parse(observation.run.startedAt) >
        Date.parse(observation.run.recordedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "recordedAt"],
        message: "record timestamp cannot precede start timestamp",
      });
    }
    if (
      observation.outcome.gate === "pass" &&
      observation.run.status !== "passed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "gate"],
        message: "a passing gate requires a passed run",
      });
    }
    if (
      observation.coordination.contributions === 0 &&
      observation.coordination.receipt !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["coordination", "receipt"],
        message: "a zero-contribution observation cannot have a receipt",
      });
    }
    if (
      observation.coordination.contributions > 0 &&
      (observation.coordination.receipt === null ||
        observation.identity.canonicalCell === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coordination"],
        message:
          "a contributed observation requires a receipt and canonical cell",
      });
    }
  });

export type OrganumCodeObservation = z.infer<
  typeof organumCodeObservationSchema
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function observationSourceDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function observationRunID(input: {
  sourceDigest: string;
  attempt: number;
  backendSessionId: string | null;
}): string {
  const sourceDigest = sha256Schema.parse(input.sourceDigest);
  const attempt = z.number().int().positive().parse(input.attempt);
  const backendSessionId = z
    .string()
    .min(1)
    .max(256)
    .nullable()
    .parse(input.backendSessionId);
  const digest = observationSourceDigest({
    attempt,
    backendSessionId,
    sourceDigest,
  });
  return `ocobs-${digest}`;
}

const BACKEND_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  deepcode: "deepcode",
  "deep-code": "deepcode",
  grok: "grok-build",
  "grok-acp": "grok-build",
  "grok-build": "grok-build",
  opencode: "opencode",
};

export function canonicalObservationBackendID(input: string): string {
  const normalized = input.trim().toLowerCase();
  return observationBackendIDSchema.parse(
    BACKEND_ALIASES[normalized] ?? normalized,
  );
}

export function parseOrganumCodeObservation(
  input: unknown,
): OrganumCodeObservation {
  return organumCodeObservationSchema.parse(input);
}

export function organumCodeObservationStructuralJSONSchema(): Record<
  string,
  unknown
> {
  const generated = z.toJSONSchema(organumCodeObservationSchema, {
    target: "draft-2020-12",
  });
  const { $schema, ...shape } = generated;
  return {
    $schema,
    $id: ORGANUM_CODE_OBSERVATION_JSON_SCHEMA_ID,
    $comment:
      "Structural projection. The Zod source and its cross-field refinements remain authoritative.",
    ...shape,
  };
}

export function observationUsageFromBroker(
  snapshot: InferenceBrokerSnapshot | undefined,
  completeness: "complete" | "lower-bound",
): OrganumCodeObservation["usage"] {
  if (snapshot === undefined) {
    return observationUsageSchema.parse({
      semantics: ORGANUM_CODE_USAGE_SEMANTICS,
      source: "unavailable",
      completeness: "unavailable",
      requests: null,
      responses: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      costUsd: null,
    });
  }
  return observationUsageSchema.parse({
    semantics: ORGANUM_CODE_USAGE_SEMANTICS,
    source: "inference-broker",
    completeness,
    requests: snapshot.upstreamRequests,
    responses: snapshot.usage.responses,
    inputTokens: snapshot.usage.inputTokens,
    outputTokens: snapshot.usage.outputTokens,
    cachedInputTokens: snapshot.usage.cachedInputTokens,
    totalTokens: snapshot.usage.totalTokens,
    reasoningTokens: snapshot.usage.reasoningTokens,
    costUsd: null,
  });
}

const legacyGrokWarrenResultSchema = z
  .object({
    schema: z.literal("organum-code/grok-acp-warren-result/v1"),
    source: z
      .object({
        priorFailedSession: z.string().min(1),
        repositoryCommit: gitCommitSchema,
      })
      .passthrough(),
    backend: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .passthrough(),
    brain: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        reasoning: z.boolean(),
      })
      .passthrough(),
    coordination: z
      .object({
        canonicalCell: canonicalCellSchema,
        contributions: nonnegativeInteger,
        contributionFile: z.string().min(1),
        topic: z.string().min(1),
        publicationBodyBytes: nonnegativeInteger,
        publicationBodySha256: sha256Schema,
        publicationPhase: z.string().min(1),
        sessionClosed: z.boolean(),
        worktreeClean: z.boolean(),
      })
      .passthrough(),
    usage: z
      .object({
        responses: nonnegativeInteger,
        inputTokens: nonnegativeInteger,
        outputTokens: nonnegativeInteger,
        totalTokens: nonnegativeInteger,
        cachedInputTokens: nonnegativeInteger,
        reasoningTokens: nonnegativeInteger,
        executionBudgetPhase: z.string().min(1),
        checkpointActuations: nonnegativeInteger,
        conservationActuations: nonnegativeInteger,
      })
      .passthrough(),
    nativeExecution: z
      .object({
        declaredReproductionCommands: nonnegativeInteger,
        additionalReadOnlyCommands: nonnegativeInteger,
        commands: z.array(z.string()),
        strictSingleExecuteDiscipline: z.boolean(),
      })
      .passthrough(),
    checks: z.record(z.string(), z.boolean()),
    gate: z.enum(["pass", "fail"]),
    classification: z.string().min(1),
  })
  .passthrough();

export interface GrokWarrenObservationContext {
  attempt: number;
  recordedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  backendSessionId?: string | null;
  comparisonKey?: string | null;
  preregistrationId?: string | null;
  producerVersion: string;
  producerCommit?: string | null;
}

export function normalizeGrokWarrenObservation(
  input: unknown,
  context: GrokWarrenObservationContext,
): OrganumCodeObservation {
  const source = legacyGrokWarrenResultSchema.parse(input);
  const sourceDigest = observationSourceDigest(source);
  const startedAt = context.startedAt ?? null;
  const finishedAt = context.finishedAt ?? null;
  const nativeSessionId = context.backendSessionId ?? null;
  return parseOrganumCodeObservation({
    schema: ORGANUM_CODE_OBSERVATION_SCHEMA,
    run: {
      id: observationRunID({
        sourceDigest,
        attempt: context.attempt,
        backendSessionId: nativeSessionId,
      }),
      attempt: context.attempt,
      status: source.gate === "pass" ? "passed" : "failed",
      startedAt,
      finishedAt,
      recordedAt: context.recordedAt,
      timingCompleteness:
        startedAt !== null && finishedAt !== null ? "complete" : "partial",
      comparisonKey: context.comparisonKey ?? null,
      preregistrationId: context.preregistrationId ?? null,
    },
    identity: {
      canonicalCell: source.coordination.canonicalCell,
      joinStatus: "joined",
      role: "critic",
      persona: null,
      workspace: null,
    },
    backend: {
      id: canonicalObservationBackendID(source.backend.name),
      version: source.backend.version,
      protocol: "acp",
      nativeSessionId,
    },
    brain: {
      provider: source.brain.provider,
      model: source.brain.model,
      protocol: "openai-chat-completions",
      reasoning: {
        enabled: source.brain.reasoning,
        effort: null,
      },
    },
    usage: {
      semantics: ORGANUM_CODE_USAGE_SEMANTICS,
      source: "inference-broker",
      completeness: "lower-bound",
      requests: null,
      responses: source.usage.responses,
      inputTokens: source.usage.inputTokens,
      outputTokens: source.usage.outputTokens,
      cachedInputTokens: source.usage.cachedInputTokens,
      totalTokens: source.usage.totalTokens,
      reasoningTokens: source.usage.reasoningTokens,
      costUsd: null,
    },
    coordination: {
      contributions: source.coordination.contributions,
      topic: source.coordination.topic,
      publicationPhase: source.coordination.publicationPhase,
      sessionClosed: source.coordination.sessionClosed,
      receipt:
        source.coordination.contributions === 0
          ? null
          : {
              file: source.coordination.contributionFile,
              bodyBytes: source.coordination.publicationBodyBytes,
              bodySha256: source.coordination.publicationBodySha256,
            },
    },
    discipline: {
      nativeToolApproval: null,
      commands: source.nativeExecution.commands,
      declaredExecutions:
        source.nativeExecution.declaredReproductionCommands,
      additionalReadOnlyCommands:
        source.nativeExecution.additionalReadOnlyCommands,
      strictSingleExecute:
        source.nativeExecution.strictSingleExecuteDiscipline,
      executionBudgetPhase: source.usage.executionBudgetPhase,
      checkpointActuations: source.usage.checkpointActuations,
      conservationActuations: source.usage.conservationActuations,
      worktreeClean: source.coordination.worktreeClean,
    },
    outcome: {
      gate: source.gate,
      classification: source.classification,
      causalClaim: "observational",
      checks: source.checks,
    },
    provenance: {
      observationSource: "reported",
      producer: {
        name: "organum-code",
        version: context.producerVersion,
        commit: context.producerCommit ?? null,
      },
      source: {
        schema: source.schema,
        digest: sourceDigest,
        repositoryCommit: source.source.repositoryCommit,
        priorFailure: {
          backendId: "opencode",
          nativeSessionId: source.source.priorFailedSession,
          runId: null,
        },
      },
    },
    evaluation: {
      name: "warren-solar-critic",
      scenario: "R3 failed critic coordination replay",
    },
  });
}
