import { createHash } from "node:crypto";

import { z } from "zod";

import type { ExecutionBudgetSnapshot } from "./execution-budget.js";

const pinnedRevision = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "source revision must be a full lowercase git SHA");

const benchmarkTaskSchema = z
  .object({
    id: z.string().min(1),
    language: z.string().min(1),
  })
  .strict();

export const softwareBenchmarkManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    title: z.string().min(1),
    comparisonClass: z.enum([
      "internal-only",
      "corpus-aligned",
      "official-protocol",
    ]),
    scoreName: z.string().min(1),
    source: z
      .object({
        suite: z.string().min(1),
        repository: z.string().url(),
        revision: pinnedRevision,
        protocol: z.string().min(1),
      })
      .strict(),
    selection: z
      .object({
        method: z.string().min(1),
        description: z.string().min(1),
      })
      .strict(),
    run: z
      .object({
        attempts: z.number().int().positive(),
        actorTimeoutMs: z.number().int().positive(),
        testTimeoutMs: z.number().int().positive(),
        operatorIntervention: z.literal("forbidden"),
        brokerRequestBudget: z.number().int().positive().optional(),
        brokerMaxConcurrent: z.number().int().positive().optional(),
        executionBudgetPolicy: z
          .enum([
            "off",
            "organum-code/grok-adaptive-completion-v2",
          ])
          .optional(),
      })
      .strict(),
    tasks: z.array(benchmarkTaskSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, task] of manifest.tasks.entries()) {
      if (seen.has(task.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate task id: ${task.id}`,
          path: ["tasks", index, "id"],
        });
      }
      seen.add(task.id);
    }
  });

export type SoftwareBenchmarkManifest = z.infer<
  typeof softwareBenchmarkManifestSchema
>;
export type SoftwareBenchmarkTask = SoftwareBenchmarkManifest["tasks"][number];
export type BenchmarkComparisonClass =
  SoftwareBenchmarkManifest["comparisonClass"];

export function parseSoftwareBenchmarkManifest(
  input: unknown,
): SoftwareBenchmarkManifest {
  return softwareBenchmarkManifestSchema.parse(input);
}

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

export function softwareBenchmarkManifestDigest(
  manifest: SoftwareBenchmarkManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
}

export interface BenchmarkBrainIdentity {
  provider: string;
  model: string;
  protocol: string;
  reasoningEffort: string | null;
}

/**
 * Same key means the corpus, task set, attempt policy and brain are matched.
 * The backend is intentionally excluded so several TUI bodies can be compared.
 */
export function softwareBenchmarkComparisonKey(
  manifest: SoftwareBenchmarkManifest,
  brain: BenchmarkBrainIdentity,
): string {
  return softwareBenchmarkComparisonKeyFromDigest(
    softwareBenchmarkManifestDigest(manifest),
    brain,
  );
}

export function softwareBenchmarkComparisonKeyFromDigest(
  manifestDigest: string,
  brain: BenchmarkBrainIdentity,
): string {
  if (!/^[0-9a-f]{64}$/.test(manifestDigest)) {
    throw new TypeError("manifest digest must be a lowercase SHA-256");
  }
  const brainDigest = createHash("sha256")
    .update(JSON.stringify(canonicalize(brain)))
    .digest("hex");
  return `${manifestDigest}:${brainDigest}`;
}

export interface PreparedSoftwareBenchmarkCase {
  taskID: string;
  workspace: string;
  prompt: string;
  sessionLabel: string;
}

export interface SoftwareBenchmarkEvaluation {
  passed: boolean;
  testsPassed: number;
  testsFailed: number;
  testCommands: readonly (readonly string[])[];
  score?: {
    name: string;
    value: number;
    maximum: number;
  };
  verifierBinding?: {
    authority: "harbor-resolved-task";
    taskDigest: string;
    taskChecksum: string;
    ctrfSummary: boolean;
  };
  evalPlusBinding?: {
    authority: "pinned-evalplus-container";
    datasetSha256: string;
    datasetMd5: string;
    evaluatorImage: string;
    evaluatorImageID: string;
    taskID: string;
    solutionSha256: string;
    resultSha256: string;
    baseStatus: string;
    plusStatus: string;
    fillerOutcomeDriftTaskIDs: readonly string[];
    actorSolutionStatus: "regular" | "missing" | "unsafe" | "oversized";
    network: "none";
    rootFilesystem: "read-only";
    datasetMount: "read-only";
    sampleMount: "read-only";
  };
  oracleIntegrity?: {
    strategy: "workspace-external-sealed-copy";
    sealedDigest: string;
    actorMutatedFiles: readonly string[];
    evaluatorWorkspaceIsolated: true;
    immutableDuringEvaluation: true;
  };
}

export interface SoftwareBenchmarkUsage {
  providerRequests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export const softwareBenchmarkTerminalReasons = [
  "clean-exit",
  "max-tokens-truncation",
  "execution-budget-exhausted",
  "timeout",
  "aborted",
  "native-nonzero",
  "adapter-error",
  "unknown",
] as const;

export type SoftwareBenchmarkTerminalReason =
  (typeof softwareBenchmarkTerminalReasons)[number];

export interface SoftwareBenchmarkTerminalOutcome {
  schemaVersion: 1;
  reason: SoftwareBenchmarkTerminalReason;
  source:
    | "native-adapter"
    | "benchmark-supervisor"
    | "legacy-inference";
}

export interface SoftwareBenchmarkCompletion {
  nativeSessionId?: string | null;
  exitCode: number | null;
  cleanExit: boolean;
  terminalOutcome: SoftwareBenchmarkTerminalOutcome;
  toolCalls: number | null;
  testExecutions: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  patchDigest: string | null;
  containmentViolations: readonly string[];
  adapterViolations: readonly string[];
  adapterWarnings: readonly string[];
  usage: SoftwareBenchmarkUsage;
  executionBudget?: ExecutionBudgetSnapshot;
}

/**
 * Evidence that Organum Code gave a native TUI the shared benchmark input
 * without silently changing the comparison. This deliberately does not claim
 * that native system prompts or tool implementations are identical: those are
 * part of the TUI body being measured.
 */
export interface SoftwareBenchmarkAdapterEvidence {
  schemaVersion: 1;
  comparisonUnit: "native-tui-body" | "oracle-fixture";
  contractDigest: string;
  prompt: {
    sha256: string;
    utf8Bytes: number;
    argvOccurrences: 0 | 1;
  };
  workspaceCwdExact: true;
  providerAccess: "broker-capability-only" | "none";
  externalNetwork: "broker-only" | "none";
  persistentState: "isolated-ephemeral" | "isolated-persistent";
  operatorInput: "none";
  adapterTurnLimit: null;
  completionSignal:
    | "process-exit"
    | "notify-then-process-exit"
    | "harbor-interrupt";
  protocolMediation: readonly string[];
  nativeDifferences: readonly string[];
}

export interface SoftwareBenchmarkExecution {
  readonly adapterEvidence: SoftwareBenchmarkAdapterEvidence;
  wait(): Promise<SoftwareBenchmarkCompletion>;
  cancel(reason: "timeout" | "abort" | "backend-error"): Promise<void>;
}

export interface SoftwareBenchmarkBackendDriver {
  readonly backendID: string;
  start(
    prepared: PreparedSoftwareBenchmarkCase,
    brain: BenchmarkBrainIdentity,
    signal?: AbortSignal,
  ): Promise<SoftwareBenchmarkExecution>;
}

export interface SoftwareBenchmarkCorpusDriver {
  prepare(
    task: SoftwareBenchmarkTask,
    signal?: AbortSignal,
  ): Promise<PreparedSoftwareBenchmarkCase>;
  evaluate(
    prepared: PreparedSoftwareBenchmarkCase,
    signal?: AbortSignal,
  ): Promise<SoftwareBenchmarkEvaluation>;
  cleanup(prepared: PreparedSoftwareBenchmarkCase): Promise<void>;
}

export type SoftwareBenchmarkRunStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "aborted"
  | "containment-violation"
  | "infrastructure-error";

export interface SoftwareBenchmarkRunResult {
  manifestID: string;
  manifestDigest: string;
  comparisonKey: string;
  comparisonClass: BenchmarkComparisonClass;
  taskID: string;
  backendID: string;
  brain: BenchmarkBrainIdentity;
  attempt: number;
  status: SoftwareBenchmarkRunStatus;
  wallTimeMs: number;
  operatorInterventions: 0;
  adapterEvidence: SoftwareBenchmarkAdapterEvidence | null;
  terminalOutcome: SoftwareBenchmarkTerminalOutcome | null;
  completion: SoftwareBenchmarkCompletion | null;
  evaluation: SoftwareBenchmarkEvaluation | null;
  errorStage: "prepare" | "launch" | "actor" | "evaluate" | "cleanup" | null;
  error: string | null;
}

class BenchmarkDeadlineError extends Error {
  constructor(readonly stage: "actor" | "evaluate") {
    super(`${stage} deadline exceeded`);
    this.name = "BenchmarkDeadlineError";
  }
}

function renderError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: "actor" | "evaluate",
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(new DOMException("benchmark run aborted", "AbortError")),
      );
    const timer = setTimeout(
      () => finish(() => reject(new BenchmarkDeadlineError(stage))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export interface RunSoftwareBenchmarkCaseInput {
  manifest: SoftwareBenchmarkManifest;
  task: SoftwareBenchmarkTask;
  brain: BenchmarkBrainIdentity;
  attempt: number;
  signal?: AbortSignal;
}

export async function runSoftwareBenchmarkCase(
  input: RunSoftwareBenchmarkCaseInput,
  corpus: SoftwareBenchmarkCorpusDriver,
  backend: SoftwareBenchmarkBackendDriver,
): Promise<SoftwareBenchmarkRunResult> {
  if (input.attempt < 1 || input.attempt > input.manifest.run.attempts) {
    throw new RangeError("attempt is outside the manifest attempt policy");
  }
  if (!input.manifest.tasks.some((task) => task.id === input.task.id)) {
    throw new TypeError("task is not part of the benchmark manifest");
  }

  const startedAt = Date.now();
  const base = {
    manifestID: input.manifest.id,
    manifestDigest: softwareBenchmarkManifestDigest(input.manifest),
    comparisonKey: softwareBenchmarkComparisonKey(input.manifest, input.brain),
    comparisonClass: input.manifest.comparisonClass,
    taskID: input.task.id,
    backendID: backend.backendID,
    brain: input.brain,
    attempt: input.attempt,
    operatorInterventions: 0 as const,
  };
  let prepared: PreparedSoftwareBenchmarkCase | undefined;
  let execution: SoftwareBenchmarkExecution | undefined;
  let adapterEvidence: SoftwareBenchmarkAdapterEvidence | null = null;
  let result: SoftwareBenchmarkRunResult;

  try {
    prepared = await corpus.prepare(input.task, input.signal);
  } catch (error) {
    return {
      ...base,
      status:
        error instanceof DOMException && error.name === "AbortError"
          ? "aborted"
          : "infrastructure-error",
      wallTimeMs: Date.now() - startedAt,
      adapterEvidence: null,
      terminalOutcome: null,
      completion: null,
      evaluation: null,
      errorStage: "prepare",
      error: renderError(error),
    };
  }

  try {
    try {
      execution = await backend.start(prepared, input.brain, input.signal);
      adapterEvidence = execution.adapterEvidence;
    } catch (error) {
      result = {
        ...base,
        status:
          error instanceof DOMException && error.name === "AbortError"
            ? "aborted"
            : "infrastructure-error",
        wallTimeMs: Date.now() - startedAt,
        adapterEvidence: null,
        terminalOutcome: null,
        completion: null,
        evaluation: null,
        errorStage: "launch",
        error: renderError(error),
      };
      return result;
    }

    let completion: SoftwareBenchmarkCompletion;
    try {
      completion = await raceWithDeadline(
        execution.wait(),
        input.manifest.run.actorTimeoutMs,
        "actor",
        input.signal,
      );
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const timedOut = error instanceof BenchmarkDeadlineError;
      await execution.cancel(
        aborted ? "abort" : timedOut ? "timeout" : "backend-error",
      );
      result = {
        ...base,
        status: aborted ? "aborted" : timedOut ? "timeout" : "infrastructure-error",
        wallTimeMs: Date.now() - startedAt,
        adapterEvidence,
        terminalOutcome: {
          schemaVersion: 1,
          reason: aborted ? "aborted" : timedOut ? "timeout" : "adapter-error",
          source: "benchmark-supervisor",
        },
        completion: null,
        evaluation: null,
        errorStage: "actor",
        error: renderError(error),
      };
      return result;
    }

    let evaluation: SoftwareBenchmarkEvaluation;
    try {
      evaluation = await raceWithDeadline(
        corpus.evaluate(prepared, input.signal),
        input.manifest.run.testTimeoutMs,
        "evaluate",
        input.signal,
      );
    } catch (error) {
      result = {
        ...base,
        status:
          error instanceof DOMException && error.name === "AbortError"
            ? "aborted"
            : error instanceof BenchmarkDeadlineError
              ? "timeout"
              : "infrastructure-error",
        wallTimeMs: Date.now() - startedAt,
        adapterEvidence,
        terminalOutcome: completion.terminalOutcome,
        completion,
        evaluation: null,
        errorStage: "evaluate",
        error: renderError(error),
      };
      return result;
    }

    const adapterProblems = [
      ...completion.adapterViolations,
      ...completion.adapterWarnings,
    ];
    const adapterFailure = adapterProblems.length > 0;
    const status: SoftwareBenchmarkRunStatus =
      adapterFailure
        ? "infrastructure-error"
        : completion.containmentViolations.length > 0
        ? "containment-violation"
        : evaluation.passed && completion.cleanExit
          ? "passed"
          : "failed";
    result = {
      ...base,
      status,
      wallTimeMs: Date.now() - startedAt,
      adapterEvidence,
      terminalOutcome: completion.terminalOutcome,
      completion,
      evaluation,
      errorStage: adapterFailure ? "actor" : null,
      error: adapterFailure
        ? `adapter transport conformance failed: ${adapterProblems.join(", ")}`
        : null,
    };
    return result;
  } finally {
    try {
      await corpus.cleanup(prepared);
    } catch (error) {
      // Cleanup failure invalidates an otherwise completed result. Returning from
      // the try block still runs this finally, so throwing makes the run visibly
      // unusable rather than silently leaking a dirty fixture.
      throw new Error(`benchmark cleanup failed: ${renderError(error)}`, {
        cause: error,
      });
    }
  }
}
