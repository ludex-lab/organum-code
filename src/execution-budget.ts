export type ExecutionBudgetMode = "adaptive" | "off";

export type ExecutionBudgetPhase =
  | "normal"
  | "checkpoint"
  | "conservation"
  | "exhausted";

export interface ExecutionBudgetUsage {
  responses: number;
  outputTokens: number;
}

export interface ExecutionBudgetPolicy {
  schemaVersion: 1;
  policyID: string;
  checkpointAfterResponses: number;
  conservationAfterResponses: number;
  maximumResponses: number;
  checkpointAfterOutputTokens: number;
  conservationAfterOutputTokens: number;
  maximumOutputTokens: number;
  initialReasoningEffort: "none" | null;
  conservationReasoningEffort: "none" | null;
}

export interface ExecutionBudgetSnapshot {
  schema: "organum-code/execution-budget/v1";
  policyID: string;
  phase: ExecutionBudgetPhase;
  responses: number;
  outputTokens: number;
  checkpointActuations: number;
  conservationActuations: number;
  blockedRequests: number;
  reasoningEffortActuations: number;
}

export interface ExecutionBudgetRequestDecision {
  admitted: boolean;
  phase: ExecutionBudgetPhase;
  body: Record<string, unknown>;
}

export const GROK_ADAPTIVE_EXECUTION_BUDGET_V1: ExecutionBudgetPolicy = {
  schemaVersion: 1,
  policyID: "organum-code/grok-adaptive-completion-v1",
  checkpointAfterResponses: 8,
  conservationAfterResponses: 10,
  maximumResponses: 24,
  checkpointAfterOutputTokens: 12_000,
  conservationAfterOutputTokens: 18_000,
  maximumOutputTokens: 64_000,
  initialReasoningEffort: null,
  conservationReasoningEffort: "none",
};

export const GROK_ADAPTIVE_EXECUTION_BUDGET_V2: ExecutionBudgetPolicy = {
  ...GROK_ADAPTIVE_EXECUTION_BUDGET_V1,
  policyID: "organum-code/grok-adaptive-completion-v2",
};

const CHECKPOINT_DIRECTIVE = [
  "[organum-code execution checkpoint v1]",
  "The execution is entering its completion budget.",
  "Preserve the best current artifact in the workspace, run only bounded verification needed for the acceptance criteria, fix concrete failures, and finish.",
  "Prefer concise tool calls over further exploratory analysis.",
].join(" ");

const CONSERVATION_DIRECTIVE = [
  "[organum-code execution conservation v1]",
  "The remaining execution budget is small.",
  "Stop exploratory analysis now.",
  "Preserve or complete the best viable artifact, run one bounded verification pass, fix only concrete blockers, and return the result.",
  "Do not restate history.",
].join(" ");

function positiveInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${context} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer`);
  }
  return value;
}

function validatePolicy(policy: ExecutionBudgetPolicy): ExecutionBudgetPolicy {
  if (policy.schemaVersion !== 1 || policy.policyID.trim().length === 0) {
    throw new TypeError("Execution budget policy identity is invalid");
  }
  const checkpointAfterResponses = positiveInteger(
    policy.checkpointAfterResponses,
    "checkpointAfterResponses",
  );
  const conservationAfterResponses = positiveInteger(
    policy.conservationAfterResponses,
    "conservationAfterResponses",
  );
  const maximumResponses = positiveInteger(
    policy.maximumResponses,
    "maximumResponses",
  );
  const checkpointAfterOutputTokens = positiveInteger(
    policy.checkpointAfterOutputTokens,
    "checkpointAfterOutputTokens",
  );
  const conservationAfterOutputTokens = positiveInteger(
    policy.conservationAfterOutputTokens,
    "conservationAfterOutputTokens",
  );
  const maximumOutputTokens = positiveInteger(
    policy.maximumOutputTokens,
    "maximumOutputTokens",
  );
  if (
    checkpointAfterResponses >= conservationAfterResponses ||
    conservationAfterResponses >= maximumResponses
  ) {
    throw new TypeError(
      "Execution budget response thresholds must increase strictly",
    );
  }
  if (
    checkpointAfterOutputTokens >= conservationAfterOutputTokens ||
    conservationAfterOutputTokens >= maximumOutputTokens
  ) {
    throw new TypeError(
      "Execution budget output-token thresholds must increase strictly",
    );
  }
  for (
    const [name, effort] of [
      ["initial", policy.initialReasoningEffort],
      ["conservation", policy.conservationReasoningEffort],
    ] as const
  ) {
    if (effort !== null && effort !== "none") {
      throw new TypeError(`Unsupported ${name} reasoning effort`);
    }
  }
  return {
    ...policy,
    policyID: policy.policyID.trim(),
    checkpointAfterResponses,
    conservationAfterResponses,
    maximumResponses,
    checkpointAfterOutputTokens,
    conservationAfterOutputTokens,
    maximumOutputTokens,
  };
}

function validUsage(usage: ExecutionBudgetUsage): ExecutionBudgetUsage {
  return {
    responses: nonNegativeInteger(usage.responses, "usage.responses"),
    outputTokens: nonNegativeInteger(
      usage.outputTokens,
      "usage.outputTokens",
    ),
  };
}

function messages(body: Readonly<Record<string, unknown>>): unknown[] {
  if (!Array.isArray(body.messages)) {
    throw new TypeError(
      "Adaptive execution budget requires a Chat Completions messages array",
    );
  }
  return [...body.messages];
}

function phaseFor(
  policy: ExecutionBudgetPolicy,
  usage: ExecutionBudgetUsage,
): ExecutionBudgetPhase {
  if (
    usage.responses >= policy.maximumResponses ||
    usage.outputTokens >= policy.maximumOutputTokens
  ) {
    return "exhausted";
  }
  if (
    usage.responses >= policy.conservationAfterResponses ||
    usage.outputTokens >= policy.conservationAfterOutputTokens
  ) {
    return "conservation";
  }
  if (
    usage.responses >= policy.checkpointAfterResponses ||
    usage.outputTokens >= policy.checkpointAfterOutputTokens
  ) {
    return "checkpoint";
  }
  return "normal";
}

export function parseExecutionBudgetMode(
  value: string | undefined,
  defaultMode: ExecutionBudgetMode,
): ExecutionBudgetMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return defaultMode;
  if (normalized === "adaptive" || normalized === "off") return normalized;
  throw new TypeError(
    "ORGANUM_CODE_EXECUTION_BUDGET must be adaptive or off",
  );
}

export class ExecutionBudgetController {
  readonly #policy: ExecutionBudgetPolicy;
  #checkpointActuations = 0;
  #conservationActuations = 0;
  #blockedRequests = 0;
  #reasoningEffortActuations = 0;

  constructor(policy: ExecutionBudgetPolicy) {
    this.#policy = validatePolicy(policy);
  }

  prepareChatCompletionsRequest(
    body: Readonly<Record<string, unknown>>,
    observedUsage: ExecutionBudgetUsage,
  ): ExecutionBudgetRequestDecision {
    const usage = validUsage(observedUsage);
    const phase = phaseFor(this.#policy, usage);
    if (phase === "exhausted") {
      this.#blockedRequests += 1;
      return { admitted: false, phase, body: { ...body } };
    }
    const reasoningEffort = phase === "conservation"
      ? this.#policy.conservationReasoningEffort ??
        this.#policy.initialReasoningEffort
      : this.#policy.initialReasoningEffort;
    if (reasoningEffort !== null) this.#reasoningEffortActuations += 1;
    if (phase === "normal") {
      return {
        admitted: true,
        phase,
        body: {
          ...body,
          ...(reasoningEffort === null
            ? {}
            : { reasoning_effort: reasoningEffort }),
        },
      };
    }
    const nextMessages = messages(body);
    const directive =
      phase === "checkpoint"
        ? CHECKPOINT_DIRECTIVE
        : CONSERVATION_DIRECTIVE;
    nextMessages.push({ role: "user", content: directive });
    if (phase === "checkpoint") {
      this.#checkpointActuations += 1;
      return {
        admitted: true,
        phase,
        body: {
          ...body,
          messages: nextMessages,
          ...(reasoningEffort === null
            ? {}
            : { reasoning_effort: reasoningEffort }),
        },
      };
    }
    this.#conservationActuations += 1;
    return {
      admitted: true,
      phase,
      body: {
        ...body,
        messages: nextMessages,
        ...(reasoningEffort === null
          ? {}
          : { reasoning_effort: reasoningEffort }),
      },
    };
  }

  snapshot(observedUsage: ExecutionBudgetUsage): ExecutionBudgetSnapshot {
    const usage = validUsage(observedUsage);
    return {
      schema: "organum-code/execution-budget/v1",
      policyID: this.#policy.policyID,
      phase: phaseFor(this.#policy, usage),
      responses: usage.responses,
      outputTokens: usage.outputTokens,
      checkpointActuations: this.#checkpointActuations,
      conservationActuations: this.#conservationActuations,
      blockedRequests: this.#blockedRequests,
      reasoningEffortActuations: this.#reasoningEffortActuations,
    };
  }
}

export function createGrokAdaptiveExecutionBudget(
  modelID: string,
): ExecutionBudgetController {
  const normalizedModel = modelID.trim();
  if (normalizedModel.length === 0) {
    throw new TypeError("Grok execution budget requires a model ID");
  }
  return new ExecutionBudgetController({
    ...GROK_ADAPTIVE_EXECUTION_BUDGET_V2,
    initialReasoningEffort: normalizedModel.toLowerCase() === "solar-open2"
      ? "none"
      : null,
    conservationReasoningEffort: normalizedModel.toLowerCase() === "solar-open2"
      ? "none"
      : null,
  });
}
