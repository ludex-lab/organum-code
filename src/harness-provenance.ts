import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  InferenceBrokerMode,
  InferenceBrokerRequestObservation,
  InferenceBrokerSettlement,
  JsonObject,
} from "./inference-broker.js";
import type { ProviderProtocol, Role } from "./provider-profile.js";
import type { ProviderSecretSourceKind } from "./provider-secret.js";
import {
  ORGANUM_CODE_PRODUCT,
  ORGANUM_CODE_VERSION,
} from "./product.js";

export const ORGANUM_CODE_HARNESS_PROVENANCE_SCHEMA =
  "organum-code/harness-provenance/v1" as const;
export const ORGANUM_CODE_HARNESS_PROVENANCE_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-harness-provenance-v1.schema.json" as const;
export const ORGANUM_CODE_HARNESS_TREATMENT =
  "same upstream model × Organum-Code-brokered native body" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime();
const nonnegativeInteger = z.number().int().nonnegative();

const boundaryProjectionSchema = z.object({
  visibility: z.enum([
    "observable-provider-request",
    "absent-at-observed-boundary",
  ]),
  count: nonnegativeInteger,
  sha256: sha256Schema.nullable(),
  utf8Bytes: nonnegativeInteger,
}).strict();

export const harnessProvenanceSchema = z.object({
  schema: z.literal(ORGANUM_CODE_HARNESS_PROVENANCE_SCHEMA),
  treatment: z.literal(ORGANUM_CODE_HARNESS_TREATMENT),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  producer: z.object({
    name: z.literal("organum-code"),
    version: z.string().min(1).max(128),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  }).strict(),
  backend: z.object({
    id: z.enum(["opencode", "claude", "grok", "deepcode", "codex"]),
    binary: z.string().min(1).max(4096),
    version: z.string().min(1).max(512),
  }).strict(),
  profile: z.object({
    name: z.string().min(1).max(128).nullable(),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(512),
    protocol: z.enum(["chat-completions", "responses"]),
    role: z.enum(["implementer", "reviewer", "critic", "researcher"]),
    secretSource: z.enum(["environment", "dotenv", "keychain"]),
  }).strict(),
  launch: z.object({
    actor: z.boolean(),
    coordination: z.boolean(),
    firstPartyPlugin: z.boolean().nullable(),
    submittedArguments: z.object({
      visibility: z.literal("sha256-only"),
      count: nonnegativeInteger,
      sha256: sha256Schema,
    }).strict(),
    bindingSha256: sha256Schema,
  }).strict(),
  workspace: z.object({
    policy: z.enum(["same-clean-synthetic-git-fixture", "unspecified"]),
    fixtureSha256: sha256Schema.nullable(),
    source: z.enum(["caller-supplied", "unavailable"]),
  }).strict(),
  transport: z.object({
    mode: z.enum([
      "chat-completions",
      "responses",
      "responses-to-chat-completions",
      "messages",
      "messages-to-chat-completions",
    ]),
    mediation: z.array(z.string().min(1).max(128)).max(16),
    auxiliaryRequests: nonnegativeInteger.nullable(),
  }).strict(),
  visibility: z.object({
    vendorInternalPrompt: z.literal("vendor-internal-opaque"),
    outboundRequest: z.literal("observable-provider-request"),
    rawPromptPersisted: z.literal(false),
    rawSystemPersisted: z.literal(false),
    rawToolDescriptionsPersisted: z.literal(false),
  }).strict(),
  requests: z.array(z.object({
    ordinal: z.number().int().positive(),
    upstreamRoute: z.string().min(1).max(1024),
    model: z.string().min(1).max(512),
    requestClass: z.enum([
      "tool-capable",
      "tool-result-followup",
      "text-only",
    ]),
    body: z.object({
      sha256: sha256Schema,
      utf8Bytes: nonnegativeInteger,
    }).strict(),
    system: boundaryProjectionSchema,
    tools: boundaryProjectionSchema.extend({
      names: z.array(z.string().min(1).max(1024)),
      canonicalSchemaSha256: sha256Schema.nullable(),
    }).strict(),
  }).strict()).max(1024),
  settlement: z.object({
    idle: z.boolean(),
    forcedAbortRequests: nonnegativeInteger,
    admittedRequests: nonnegativeInteger,
    activeRequests: nonnegativeInteger,
    rejectedRequests: nonnegativeInteger,
    upstreamRequests: nonnegativeInteger,
    cancelledRequests: nonnegativeInteger,
    usage: z.object({
      responses: nonnegativeInteger,
      inputTokens: nonnegativeInteger,
      outputTokens: nonnegativeInteger,
      totalTokens: nonnegativeInteger,
      cachedInputTokens: nonnegativeInteger,
      reasoningTokens: nonnegativeInteger,
    }).strict(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.workspace.policy === "same-clean-synthetic-git-fixture") {
    if (value.workspace.source !== "caller-supplied" || value.workspace.fixtureSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "the synthetic fixture policy requires a caller-supplied fixture digest",
      });
    }
  } else if (value.workspace.source !== "unavailable" || value.workspace.fixtureSha256 !== null) {
    context.addIssue({
      code: "custom",
      path: ["workspace"],
      message: "an unspecified fixture must not claim a fixture digest",
    });
  }
  if (value.requests.length !== value.settlement.upstreamRequests) {
    context.addIssue({
      code: "custom",
      path: ["requests"],
      message: "observed request count must equal broker upstream request count",
    });
  }
  for (const [index, request] of value.requests.entries()) {
    if (request.ordinal !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["requests", index, "ordinal"],
        message: "request ordinals must be contiguous and one-based",
      });
    }
    if (request.model !== value.profile.model) {
      context.addIssue({
        code: "custom",
        path: ["requests", index, "model"],
        message: "observed request model must match the configured upstream model",
      });
    }
  }
});

export type HarnessProvenance = z.infer<typeof harnessProvenanceSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function projection(values: readonly unknown[]): {
  visibility: "observable-provider-request" | "absent-at-observed-boundary";
  count: number;
  sha256: string | null;
  utf8Bytes: number;
} {
  if (values.length === 0) {
    return {
      visibility: "absent-at-observed-boundary",
      count: 0,
      sha256: null,
      utf8Bytes: 0,
    };
  }
  const canonical = canonicalJSON(values);
  return {
    visibility: "observable-provider-request",
    count: values.length,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    utf8Bytes: Buffer.byteLength(canonical, "utf8"),
  };
}

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function systemValues(body: Readonly<JsonObject>): readonly unknown[] {
  const values: unknown[] = [];
  if (body.system !== undefined) values.push(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const candidate = record(message);
      if (candidate?.role === "system") values.push(candidate.content ?? null);
    }
  }
  return values;
}

function toolValues(body: Readonly<JsonObject>): readonly JsonObject[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    const candidate = record(tool);
    return candidate === null ? [] : [candidate];
  });
}

function toolName(tool: Readonly<JsonObject>): string | null {
  const fn = record(tool.function);
  const value = fn?.name ?? tool.name;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canonicalToolSchema(tool: Readonly<JsonObject>): JsonObject {
  const fn = record(tool.function);
  return {
    type: typeof tool.type === "string" ? tool.type : null,
    name: toolName(tool),
    parameters: fn?.parameters ?? tool.input_schema ?? null,
    strict: fn?.strict ?? tool.strict ?? null,
  };
}

function hasToolResult(body: Readonly<JsonObject>): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message) => {
    const candidate = record(message);
    if (candidate?.role === "tool") return true;
    if (!Array.isArray(candidate?.content)) return false;
    return candidate.content.some((part) => record(part)?.type === "tool_result");
  });
}

function observedRequest(input: InferenceBrokerRequestObservation): HarnessProvenance["requests"][number] {
  const canonicalBody = canonicalJSON(input.body);
  const tools = toolValues(input.body);
  const toolProjection = projection(tools);
  const names = Array.from(new Set(tools.flatMap((tool) => {
    const name = toolName(tool);
    return name === null ? [] : [name];
  }))).sort();
  return {
    ordinal: input.ordinal,
    upstreamRoute: input.upstreamRoute,
    model: String(input.body.model),
    requestClass: hasToolResult(input.body)
      ? "tool-result-followup"
      : tools.length > 0
        ? "tool-capable"
        : "text-only",
    body: {
      sha256: createHash("sha256").update(canonicalBody, "utf8").digest("hex"),
      utf8Bytes: Buffer.byteLength(canonicalBody, "utf8"),
    },
    system: projection(systemValues(input.body)),
    tools: {
      ...toolProjection,
      names,
      canonicalSchemaSha256:
        tools.length === 0 ? null : canonicalSha256(tools.map(canonicalToolSchema)),
    },
  };
}

export interface HarnessProvenanceCollectorOptions {
  backend: "opencode" | "claude" | "grok" | "deepcode" | "codex";
  binary: string;
  backendVersion: string;
  profileName: string | null;
  provider: string;
  model: string;
  protocol: ProviderProtocol;
  role: Role;
  secretSource: ProviderSecretSourceKind;
  submittedArguments: readonly string[];
  actor: boolean;
  coordination: boolean;
  firstPartyPlugin: boolean | null;
  workspacePolicy: "same-clean-synthetic-git-fixture" | "unspecified";
  fixtureSha256: string | null;
  mode: InferenceBrokerMode;
  mediation: readonly string[];
  producerVersion?: string;
  producerCommit?: string | null;
  now?: () => Date;
}

export class HarnessProvenanceCollector {
  readonly #options: HarnessProvenanceCollectorOptions;
  readonly #startedAt: string;
  readonly #requests: HarnessProvenance["requests"] = [];

  constructor(options: HarnessProvenanceCollectorOptions) {
    this.#options = options;
    this.#startedAt = (options.now?.() ?? new Date()).toISOString();
  }

  observe = (input: InferenceBrokerRequestObservation): void => {
    this.#requests.push(observedRequest(input));
  };

  finalize(settlement: InferenceBrokerSettlement): HarnessProvenance {
    const argumentsProjection = {
      visibility: "sha256-only" as const,
      count: this.#options.submittedArguments.length,
      sha256: canonicalSha256(this.#options.submittedArguments),
    };
    const launch = {
      actor: this.#options.actor,
      coordination: this.#options.coordination,
      firstPartyPlugin: this.#options.firstPartyPlugin,
      submittedArguments: argumentsProjection,
      bindingSha256: canonicalSha256({
        backend: this.#options.backend,
        model: this.#options.model,
        profileName: this.#options.profileName,
        actor: this.#options.actor,
        coordination: this.#options.coordination,
        firstPartyPlugin: this.#options.firstPartyPlugin,
        submittedArguments: argumentsProjection,
      }),
    };
    return harnessProvenanceSchema.parse({
      schema: ORGANUM_CODE_HARNESS_PROVENANCE_SCHEMA,
      treatment: ORGANUM_CODE_HARNESS_TREATMENT,
      startedAt: this.#startedAt,
      finishedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      producer: {
        name: ORGANUM_CODE_PRODUCT,
        version: this.#options.producerVersion ?? ORGANUM_CODE_VERSION,
        commit: this.#options.producerCommit ?? null,
      },
      backend: {
        id: this.#options.backend,
        binary: this.#options.binary,
        version: this.#options.backendVersion,
      },
      profile: {
        name: this.#options.profileName,
        provider: this.#options.provider,
        model: this.#options.model,
        protocol: this.#options.protocol,
        role: this.#options.role,
        secretSource: this.#options.secretSource,
      },
      launch,
      workspace: {
        policy: this.#options.workspacePolicy,
        fixtureSha256: this.#options.fixtureSha256,
        source: this.#options.fixtureSha256 === null ? "unavailable" : "caller-supplied",
      },
      transport: {
        mode: this.#options.mode,
        mediation: [...this.#options.mediation],
        auxiliaryRequests: null,
      },
      visibility: {
        vendorInternalPrompt: "vendor-internal-opaque",
        outboundRequest: "observable-provider-request",
        rawPromptPersisted: false,
        rawSystemPersisted: false,
        rawToolDescriptionsPersisted: false,
      },
      requests: [...this.#requests],
      settlement: {
        idle: settlement.idle,
        forcedAbortRequests: settlement.forcedAbortRequests,
        admittedRequests: settlement.snapshot.admittedRequests,
        activeRequests: settlement.snapshot.activeRequests,
        rejectedRequests: settlement.snapshot.rejectedRequests,
        upstreamRequests: settlement.snapshot.upstreamRequests,
        cancelledRequests: settlement.snapshot.cancelledRequests,
        usage: settlement.snapshot.usage,
      },
    });
  }
}

export function harnessProvenanceStructuralJSONSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(harnessProvenanceSchema, {
    target: "draft-2020-12",
  });
  const { $schema, ...shape } = generated;
  return {
    $schema,
    $id: ORGANUM_CODE_HARNESS_PROVENANCE_JSON_SCHEMA_ID,
    $comment:
      "Structural projection. The Zod source and its cross-field refinements remain authoritative.",
    ...shape,
  };
}
