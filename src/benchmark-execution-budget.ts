import {
  createGrokAdaptiveExecutionBudget,
  GROK_ADAPTIVE_EXECUTION_BUDGET_V2,
  parseExecutionBudgetMode,
  type ExecutionBudgetController,
} from "./execution-budget.js";
import type { InferenceBrokerLimits } from "./inference-broker.js";
import type {
  SoftwareBenchmarkManifest,
} from "./software-benchmark.js";

export interface SoftwareBenchmarkExecutionBudgetPlan {
  policyID: string | null;
  reasoningEffort: "none" | null;
  controller: ExecutionBudgetController | undefined;
  brokerLimits: Partial<InferenceBrokerLimits>;
}

export interface PlanSoftwareBenchmarkExecutionBudgetInput {
  manifest: SoftwareBenchmarkManifest;
  backendID: string;
  modelID: string;
  protocol: string;
  env?: NodeJS.ProcessEnv;
}

export function planSoftwareBenchmarkExecutionBudget(
  input: PlanSoftwareBenchmarkExecutionBudgetInput,
): SoftwareBenchmarkExecutionBudgetPlan {
  const declaredPolicy = input.manifest.run.executionBudgetPolicy ?? "off";
  const declaredMode =
    declaredPolicy === "off" ? "off" : "adaptive";
  const explicitMode = input.env?.ORGANUM_CODE_EXECUTION_BUDGET;
  if (
    explicitMode !== undefined &&
    parseExecutionBudgetMode(explicitMode, "off") !== declaredMode
  ) {
    throw new TypeError(
      "benchmark execution-budget environment conflicts with the manifest",
    );
  }
  const brokerLimits: Partial<InferenceBrokerLimits> = {
    ...(input.manifest.run.brokerRequestBudget === undefined
      ? {}
      : { maxRequests: input.manifest.run.brokerRequestBudget }),
    ...(input.manifest.run.brokerMaxConcurrent === undefined
      ? {}
      : { maxConcurrent: input.manifest.run.brokerMaxConcurrent }),
  };
  if (declaredPolicy === "off") {
    return {
      policyID: null,
      reasoningEffort: null,
      controller: undefined,
      brokerLimits,
    };
  }
  if (
    declaredPolicy !== GROK_ADAPTIVE_EXECUTION_BUDGET_V2.policyID ||
    input.backendID !== "grok" ||
    input.protocol !== "chat-completions"
  ) {
    throw new TypeError(
      "adaptive benchmark execution budget requires Grok Chat Completions",
    );
  }
  if (
    input.manifest.run.brokerRequestBudget !==
      GROK_ADAPTIVE_EXECUTION_BUDGET_V2.maximumResponses ||
    input.manifest.run.brokerMaxConcurrent !== 2
  ) {
    throw new TypeError(
      "adaptive benchmark manifest must bind the exact request and native auxiliary concurrency limits",
    );
  }
  const solar = input.modelID.trim().toLowerCase() === "solar-open2";
  return {
    policyID: GROK_ADAPTIVE_EXECUTION_BUDGET_V2.policyID,
    reasoningEffort: solar ? "none" : null,
    controller: createGrokAdaptiveExecutionBudget(input.modelID),
    brokerLimits,
  };
}
