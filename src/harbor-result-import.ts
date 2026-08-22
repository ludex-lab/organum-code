import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import {
  softwareBenchmarkTerminalReasons,
  softwareBenchmarkComparisonKeyFromDigest,
  type BenchmarkBrainIdentity,
  type BenchmarkComparisonClass,
  type SoftwareBenchmarkAdapterEvidence,
  type SoftwareBenchmarkCompletion,
  type SoftwareBenchmarkEvaluation,
  type SoftwareBenchmarkRunResult,
  type SoftwareBenchmarkTerminalOutcome,
} from "./software-benchmark.js";
import {
  assertHarborFullResolvedLock,
  parseHarborFullPreregistration,
  type HarborFullPreregistration,
} from "./harbor-full-preregistration.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const sha256Ref = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nonNegativeInteger = z.number().int().nonnegative();
const nullableNonNegativeInteger = nonNegativeInteger.nullable();

const preregistrationSchemaV1 = z
  .object({
    schema: z.literal(
      "organum-code/harbor-terminal-bench-preregistration/v1",
    ),
    dataset: z
      .object({
        id: z.string().min(1),
        release: z.string().min(1),
        task_count: z.number().int().positive(),
      })
      .passthrough(),
    selection: z
      .object({
        include_task_name: z.string().min(1).optional(),
        include_task_names: z.array(z.string().min(1)).min(1).optional(),
        attempts: z.number().int().positive(),
        retries: nonNegativeInteger,
        concurrency: z.number().int().positive(),
      })
      .passthrough()
      .superRefine((selection, context) => {
        const choices = [
          selection.include_task_name !== undefined,
          selection.include_task_names !== undefined,
        ].filter(Boolean).length;
        if (choices !== 1) {
          context.addIssue({
            code: "custom",
            message:
              "selection must define exactly one of include_task_name or include_task_names",
          });
        }
      }),
    adapter: z
      .object({
        import_path: z.string().min(1),
        harbor_version: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        backend: z.string().min(1).optional(),
        backend_version: z.string().min(1).optional(),
        grok_version: z.string().min(1).optional(),
      })
      .passthrough()
      .superRefine((adapter, context) => {
        if (
          adapter.backend_version === undefined &&
          adapter.grok_version === undefined
        ) {
          context.addIssue({
            code: "custom",
            message: "adapter must pin backend_version or grok_version",
          });
        }
        if (
          adapter.backend_version !== undefined &&
          adapter.grok_version !== undefined &&
          adapter.backend_version !== adapter.grok_version
        ) {
          context.addIssue({
            code: "custom",
            message: "backend_version and grok_version disagree",
          });
        }
      }),
  })
  .passthrough();

const harborJobConfigSchema = z
  .object({
    n_attempts: z.number().int().positive().optional(),
    n_concurrent_trials: z.number().int().positive(),
    agents: z
      .array(
        z
          .object({
            name: z.string().min(1),
            model_name: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1),
    datasets: z
      .array(
        z
          .object({
            name: z.string().min(1),
            ref: sha256Ref,
            task_names: z.array(z.string().min(1)).min(1),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const harborTrialLockSchema = z
  .object({
    schema_version: z.literal(1),
    task: z
      .object({
        name: z.string().min(1),
        digest: sha256Ref,
        source: z.string().min(1),
      })
      .passthrough(),
    agent: z
      .object({
        name: z.string().min(1),
        model_name: z.string().min(1),
      })
      .passthrough(),
    environment: z
      .object({
        type: z.string().min(1),
      })
      .passthrough(),
    verifier: z
      .object({
        disable: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const harborJobLockSchema = z
  .object({
    schema_version: z.literal(2),
    harbor: z
      .object({
        version: z.string().min(1),
      })
      .passthrough(),
    n_concurrent_trials: z.number().int().positive(),
    retry: z
      .object({
        max_retries: nonNegativeInteger,
      })
      .passthrough(),
    trials: z.array(harborTrialLockSchema).min(1),
  })
  .passthrough();

const harborJobResultSchema = z
  .object({
    id: z.string().uuid(),
    n_total_trials: z.number().int().positive(),
    stats: z
      .object({
        n_completed_trials: nonNegativeInteger,
        n_errored_trials: nonNegativeInteger,
        n_running_trials: nonNegativeInteger,
        n_pending_trials: nonNegativeInteger,
        n_cancelled_trials: nonNegativeInteger,
        n_retries: nonNegativeInteger,
      })
      .passthrough(),
  })
  .passthrough();

const adapterEvidenceMetadataSchema = z
  .object({
    schema: z.literal("organum-code/harbor-adapter-evidence/v1"),
    prompt_sha256: sha256,
    prompt_utf8_bytes: nonNegativeInteger,
    prompt_argv_occurrences: z.union([z.literal(0), z.literal(1)]),
    workspace_cwd_exact: z.literal(true),
    provider_access: z.literal("broker-capability-only"),
    external_network: z.literal("broker-only"),
    persistent_state: z.literal("isolated-ephemeral"),
    operator_input: z.literal("none"),
    adapter_turn_limit: z.null(),
    completion_signal: z.enum(["process-exit", "harbor-interrupt"]),
    protocol_mediation: z.array(z.string()),
    native_differences: z.array(z.string()),
    capability_file_absent: z.literal(true),
    agent_distribution: z.literal("pinned-offline-static-elf").optional(),
    installation_network: z.literal("none").optional(),
    artifact_platform: z
      .enum(["linux-x86_64", "linux-aarch64"])
      .optional(),
    artifact_sha256: sha256.optional(),
    artifact_manifest_sha256: sha256.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const offlineArtifactEvidence = [
      evidence.agent_distribution,
      evidence.installation_network,
      evidence.artifact_platform,
      evidence.artifact_sha256,
      evidence.artifact_manifest_sha256,
    ];
    const observed = offlineArtifactEvidence.filter(
      (value) => value !== undefined,
    ).length;
    if (observed !== 0 && observed !== offlineArtifactEvidence.length) {
      context.addIssue({
        code: "custom",
        message: "offline artifact evidence must be complete when present",
      });
    }
  });

const terminalOutcomeMetadataSchema = z
  .object({
    schema: z.literal(
      "organum-code/software-benchmark-terminal-outcome/v1",
    ),
    reason: z.enum(softwareBenchmarkTerminalReasons),
    source: z.enum(["native-adapter", "benchmark-supervisor"]),
  })
  .strict();

const agentMetadataSchema = z
  .object({
    schema: z.literal("organum-code/harbor-agent-metadata/v1"),
    backend: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    provider_protocol: z.string().min(1).optional(),
    broker_idle: z.boolean(),
    broker_forced_abort_requests: nonNegativeInteger,
    broker_upstream_requests: nonNegativeInteger,
    broker_rejected_requests: nonNegativeInteger,
    broker_cancelled_requests: nonNegativeInteger,
    broker_active_requests: nonNegativeInteger.optional(),
    agent_exit_code: z.number().int().nullable(),
    agent_interrupted: z.boolean().optional(),
    agent_cancelled: z.boolean().optional(),
    actor_process_group_absent: z.literal(true).optional(),
    terminal_outcome: terminalOutcomeMetadataSchema.optional(),
    adapter_evidence: adapterEvidenceMetadataSchema.optional(),
    execution_budget: z
      .object({
        schema: z.literal("organum-code/execution-budget/v1"),
        policyID: z.string().min(1),
        phase: z.enum([
          "normal",
          "checkpoint",
          "conservation",
          "exhausted",
        ]),
        responses: nonNegativeInteger,
        outputTokens: nonNegativeInteger,
        checkpointActuations: nonNegativeInteger,
        conservationActuations: nonNegativeInteger,
        blockedRequests: nonNegativeInteger,
        reasoningEffortActuations: nonNegativeInteger,
      })
      .strict()
      .optional(),
  })
  .passthrough();

const harborTrialResultSchema = z
  .object({
    id: z.string().uuid(),
    task_name: z.string().min(1),
    trial_name: z.string().min(1),
    task_id: z
      .object({
        ref: sha256Ref,
      })
      .passthrough(),
    source: z.string().min(1),
    task_checksum: sha256,
    config: z
      .object({
        job_id: z.string().uuid(),
        agent: z
          .object({
            name: z.string().min(1),
            model_name: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
    agent_info: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        model_info: z
          .object({
            name: z.string().min(1),
            provider: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
    agent_result: z
      .object({
        n_input_tokens: nullableNonNegativeInteger,
        n_cache_tokens: nullableNonNegativeInteger,
        n_output_tokens: nullableNonNegativeInteger,
        cost_usd: z.number().nonnegative().nullable(),
        metadata: agentMetadataSchema,
      })
      .passthrough(),
    verifier_result: z
      .object({
        rewards: z.record(z.string(), z.number()),
      })
      .nullable(),
    exception_info: z.unknown().nullable(),
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
    agent_execution: z
      .object({
        started_at: z.string().min(1),
        finished_at: z.string().min(1),
      })
      .nullable(),
  })
  .passthrough();

const ctrfSchema = z
  .object({
    results: z
      .object({
        summary: z
          .object({
            tests: nonNegativeInteger,
            passed: nonNegativeInteger,
            failed: nonNegativeInteger,
          })
          .passthrough()
          .superRefine((summary, context) => {
            if (summary.passed + summary.failed > summary.tests) {
              context.addIssue({
                code: "custom",
                message: "CTRF passed plus failed exceeds total tests",
              });
            }
          }),
      })
      .passthrough(),
  })
  .passthrough();

type HarborPreregistration =
  | z.infer<typeof preregistrationSchemaV1>
  | HarborFullPreregistration;
type HarborJobConfig = z.infer<typeof harborJobConfigSchema>;
type HarborJobLock = z.infer<typeof harborJobLockSchema>;
type HarborTrialResult = z.infer<typeof harborTrialResultSchema>;
type HarborCtrf = z.infer<typeof ctrfSchema>;

export interface HarborResultImportInput {
  jobDirectory: string;
  preregistrationPath: string;
  manifestID: string;
  comparisonClass: BenchmarkComparisonClass;
  brainProtocol: string;
  brainReasoningEffort?: string | null;
}

export interface HarborImportSource {
  engine: "harbor";
  harborVersion: string;
  jobID: string;
  dataset: string;
  datasetRelease: string;
  datasetRef: string;
  preregistrationSha256: string;
  taskBindings: readonly {
    name: string;
    digest: string;
    checksum: string;
  }[];
  attempts: number;
  retries: 0;
  concurrency: number;
}

export interface HarborImportedSoftwareBenchmark {
  schema: "organum-code/harbor-software-benchmark-import/v1";
  importedAt: string;
  source: HarborImportSource;
  admission: {
    valid: true;
    expectedTrials: number;
    importedTrials: number;
    warnings: readonly string[];
  };
  runs: readonly SoftwareBenchmarkRunResult[];
}

interface LoadedTrial {
  directory: string;
  result: HarborTrialResult;
  ctrf: HarborCtrf | null;
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

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function portableTextSha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

async function readJson(path: string): Promise<{ raw: string; value: unknown }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Harbor artifact ${path}`, { cause: error });
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`Harbor artifact is not valid JSON: ${path}`, {
      cause: error,
    });
  }
}

function parsePreregistration(value: unknown): HarborPreregistration {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).schema ===
      "organum-code/harbor-terminal-bench-preregistration/v2"
  ) {
    return parseHarborFullPreregistration(value);
  }
  return preregistrationSchemaV1.parse(value);
}

async function readOptionalCtrf(path: string): Promise<HarborCtrf | null> {
  try {
    const artifact = await readJson(path);
    return ctrfSchema.parse(artifact.value);
  } catch (error) {
    if (
      error instanceof Error &&
      "cause" in error &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function selectedTaskNames(preregistration: HarborPreregistration): string[] {
  const selection = preregistration.selection;
  const includeTaskName =
    "include_task_name" in selection
      ? selection.include_task_name
      : undefined;
  const names =
    selection.include_task_names ??
    (includeTaskName === undefined ? [] : [includeTaskName]);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new TypeError("preregistration contains duplicate task names");
  }
  return [...unique].sort();
}

function exactStringSet(
  observed: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const left = [...new Set(observed)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new TypeError(
      `${label} mismatch: expected ${JSON.stringify(right)}, observed ${JSON.stringify(left)}`,
    );
  }
}

function harborModelMatches(
  configured: string,
  provider: string,
  model: string,
): boolean {
  return configured === model || configured === `${provider}/${model}`;
}

function durationMs(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    throw new TypeError("Harbor timestamps must be valid ISO date-times");
  }
  if (finished < started) {
    throw new TypeError("Harbor finish timestamp precedes start timestamp");
  }
  return finished - started;
}

function safeException(exception: unknown): string {
  if (typeof exception === "string") {
    if (/timeout/i.test(exception)) return "HarborTimeoutError";
    if (/cancel/i.test(exception)) return "HarborCancelledError";
    return "HarborException";
  }
  if (exception && typeof exception === "object") {
    const object = exception as Record<string, unknown>;
    const name =
      typeof object.exception_type === "string"
        ? object.exception_type
        : typeof object.type === "string"
          ? object.type
          : "HarborException";
    const message =
      typeof object.exception_message === "string"
        ? object.exception_message
        : typeof object.message === "string"
          ? object.message
          : "";
    if (/timeout/i.test(`${name} ${message}`)) return `${name}: timeout`;
    if (/cancel/i.test(`${name} ${message}`)) return `${name}: cancelled`;
    return name.slice(0, 128);
  }
  return "Harbor trial failed with an unclassified exception";
}

function exceptionStatus(
  exception: unknown,
): Pick<SoftwareBenchmarkRunResult, "status" | "errorStage" | "error"> {
  const rendered = safeException(exception);
  if (/timeout/i.test(rendered)) {
    return { status: "timeout", errorStage: "actor", error: rendered };
  }
  if (/cancel/i.test(rendered)) {
    return { status: "aborted", errorStage: "actor", error: rendered };
  }
  return {
    status: "infrastructure-error",
    errorStage: /verifier/i.test(rendered) ? "evaluate" : "actor",
    error: rendered,
  };
}

function exceptionType(exception: unknown): string | null {
  if (
    typeof exception === "object" &&
    exception !== null &&
    "exception_type" in exception &&
    typeof exception.exception_type === "string"
  ) {
    return exception.exception_type;
  }
  return null;
}

function adapterEvidence(
  metadata: z.infer<typeof agentMetadataSchema>,
  contractDigest: string,
): SoftwareBenchmarkAdapterEvidence | null {
  const evidence = metadata.adapter_evidence;
  if (evidence === undefined) return null;
  return {
    schemaVersion: 1,
    comparisonUnit: "native-tui-body",
    contractDigest,
    prompt: {
      sha256: evidence.prompt_sha256,
      utf8Bytes: evidence.prompt_utf8_bytes,
      argvOccurrences: evidence.prompt_argv_occurrences,
    },
    workspaceCwdExact: evidence.workspace_cwd_exact,
    providerAccess: evidence.provider_access,
    externalNetwork: evidence.external_network,
    persistentState: evidence.persistent_state,
    operatorInput: evidence.operator_input,
    adapterTurnLimit: evidence.adapter_turn_limit,
    completionSignal: evidence.completion_signal,
    protocolMediation: evidence.protocol_mediation,
    nativeDifferences: evidence.native_differences,
  };
}

function evaluationFor(
  trial: LoadedTrial,
): SoftwareBenchmarkEvaluation | null {
  const rewards = trial.result.verifier_result?.rewards;
  if (rewards === undefined) return null;
  const reward = rewards.reward;
  if (
    reward === undefined ||
    !Number.isFinite(reward) ||
    reward < 0 ||
    reward > 1
  ) {
    throw new TypeError(
      `Harbor trial ${trial.result.trial_name} has no reward in [0, 1]`,
    );
  }
  const summary = trial.ctrf?.results.summary;
  return {
    passed: reward === 1,
    testsPassed: summary?.passed ?? 0,
    testsFailed: summary?.failed ?? 0,
    testCommands: [],
    score: {
      name: "reward",
      value: reward,
      maximum: 1,
    },
    verifierBinding: {
      authority: "harbor-resolved-task",
      taskDigest: trial.result.task_id.ref,
      taskChecksum: trial.result.task_checksum,
      ctrfSummary: summary !== undefined,
    },
  };
}

function completionFor(
  trial: LoadedTrial,
): SoftwareBenchmarkCompletion {
  const metadata = trial.result.agent_result.metadata;
  const adapterViolations: string[] = [];
  if (!metadata.broker_idle) {
    adapterViolations.push("broker_not_idle");
  }
  if (
    metadata.broker_active_requests !== undefined &&
    metadata.broker_active_requests !== 0
  ) {
    adapterViolations.push("broker_active_requests");
  }
  if (metadata.broker_forced_abort_requests !== 0) {
    adapterViolations.push("broker_forced_abort");
  }
  return {
    exitCode: metadata.agent_exit_code,
    cleanExit: metadata.agent_exit_code === 0,
    terminalOutcome: terminalOutcomeFor(trial),
    toolCalls: null,
    testExecutions: trial.ctrf?.results.summary.tests ?? null,
    filesChanged: null,
    linesAdded: null,
    linesDeleted: null,
    patchDigest: null,
    containmentViolations: [],
    adapterViolations,
    adapterWarnings: [],
    usage: {
      providerRequests: metadata.broker_upstream_requests,
      inputTokens: trial.result.agent_result.n_input_tokens,
      outputTokens: trial.result.agent_result.n_output_tokens,
      cacheReadTokens: trial.result.agent_result.n_cache_tokens,
      reasoningTokens: null,
      costUsd: trial.result.agent_result.cost_usd,
    },
    ...(metadata.execution_budget === undefined
      ? {}
      : { executionBudget: metadata.execution_budget }),
  };
}

function terminalOutcomeFor(
  trial: LoadedTrial,
): SoftwareBenchmarkTerminalOutcome {
  const metadata = trial.result.agent_result.metadata;
  if (metadata.terminal_outcome !== undefined) {
    return {
      schemaVersion: 1,
      reason: metadata.terminal_outcome.reason,
      source: metadata.terminal_outcome.source,
    };
  }
  const rendered = safeException(trial.result.exception_info);
  const reason =
    /timeout/i.test(rendered)
      ? "timeout"
      : /cancel/i.test(rendered)
        ? "aborted"
        : metadata.agent_exit_code === 0
          ? "clean-exit"
          : metadata.execution_budget?.phase === "exhausted"
            ? "execution-budget-exhausted"
            : metadata.agent_exit_code === null
              ? "unknown"
              : "native-nonzero";
  return {
    schemaVersion: 1,
    reason,
    source: "legacy-inference",
  };
}

function importedResult(
  trial: LoadedTrial,
  manifestID: string,
  manifestDigest: string,
  comparisonClass: BenchmarkComparisonClass,
  brainProtocol: string,
  brainReasoningEffort: string | null,
  attempt: number,
  contractDigest: string,
): SoftwareBenchmarkRunResult {
  const metadata = trial.result.agent_result.metadata;
  const brain: BenchmarkBrainIdentity = {
    provider: trial.result.agent_info.model_info.provider,
    model: trial.result.agent_info.model_info.name,
    protocol: metadata.provider_protocol ?? brainProtocol,
    reasoningEffort: brainReasoningEffort,
  };
  if (
    metadata.provider_protocol !== undefined &&
    metadata.provider_protocol !== brainProtocol
  ) {
    throw new TypeError(
      `brain protocol mismatch for ${trial.result.trial_name}: expected ${brainProtocol}, observed ${metadata.provider_protocol}`,
    );
  }
  const completion = completionFor(trial);
  const evaluation = evaluationFor(trial);
  const base = {
    manifestID,
    manifestDigest,
    comparisonKey: softwareBenchmarkComparisonKeyFromDigest(
      manifestDigest,
      brain,
    ),
    comparisonClass,
    taskID: trial.result.task_name,
    backendID: metadata.backend,
    brain,
    attempt,
    wallTimeMs: durationMs(
      trial.result.started_at,
      trial.result.finished_at,
    ),
    operatorInterventions: 0 as const,
    adapterEvidence: adapterEvidence(metadata, contractDigest),
    terminalOutcome: completion.terminalOutcome,
    completion,
    evaluation,
  };
  if (
    exceptionType(trial.result.exception_info) ===
      "NonZeroAgentExitCodeError" &&
    evaluation !== null &&
    completion.adapterViolations.length === 0 &&
    completion.usage.providerRequests !== null &&
    completion.usage.providerRequests > 0
  ) {
    return {
      ...base,
      status: "failed",
      errorStage: null,
      error: "NonZeroAgentExitCodeError",
    };
  }
  if (trial.result.exception_info !== null) {
    return { ...base, ...exceptionStatus(trial.result.exception_info) };
  }
  if (evaluation === null) {
    return {
      ...base,
      status: "infrastructure-error",
      errorStage: "evaluate",
      error: "Harbor verifier produced no result",
    };
  }
  if (completion.adapterViolations.length > 0) {
    return {
      ...base,
      status: "infrastructure-error",
      errorStage: "actor",
      error: `adapter transport conformance failed: ${completion.adapterViolations.join(", ")}`,
    };
  }
  return {
    ...base,
    status:
      evaluation.passed && completion.cleanExit ? "passed" : "failed",
    errorStage: null,
    error: null,
  };
}

async function loadTrials(jobDirectory: string): Promise<LoadedTrial[]> {
  const entries = await readdir(jobDirectory, { withFileTypes: true });
  const trials: LoadedTrial[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(jobDirectory, entry.name);
    let artifact: { raw: string; value: unknown };
    try {
      artifact = await readJson(join(directory, "result.json"));
    } catch (error) {
      if (
        error instanceof Error &&
        "cause" in error &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    trials.push({
      directory,
      result: harborTrialResultSchema.parse(artifact.value),
      ctrf: await readOptionalCtrf(join(directory, "verifier", "ctrf.json")),
    });
  }
  return trials.sort((left, right) => {
    const time = Date.parse(left.result.started_at) - Date.parse(right.result.started_at);
    return time || left.result.trial_name.localeCompare(right.result.trial_name);
  });
}

export async function importHarborSoftwareBenchmark(
  input: HarborResultImportInput,
): Promise<HarborImportedSoftwareBenchmark> {
  if (!input.manifestID.trim()) throw new TypeError("manifestID is required");
  if (!input.brainProtocol.trim()) {
    throw new TypeError("brainProtocol is required");
  }
  const brainReasoningEffort = input.brainReasoningEffort ?? null;
  if (
    brainReasoningEffort !== null &&
    brainReasoningEffort.trim().length === 0
  ) {
    throw new TypeError("brainReasoningEffort must be null or nonempty");
  }
  const jobDirectory = resolve(input.jobDirectory);
  const preregistrationPath = resolve(input.preregistrationPath);
  const [preregArtifact, configArtifact, lockArtifact, resultArtifact, trials] =
    await Promise.all([
      readJson(preregistrationPath),
      readJson(join(jobDirectory, "config.json")),
      readJson(join(jobDirectory, "lock.json")),
      readJson(join(jobDirectory, "result.json")),
      loadTrials(jobDirectory),
    ]);
  const preregistration = parsePreregistration(preregArtifact.value);
  const config = harborJobConfigSchema.parse(configArtifact.value);
  const lock = harborJobLockSchema.parse(lockArtifact.value);
  const jobResult = harborJobResultSchema.parse(resultArtifact.value);
  const taskNames = selectedTaskNames(preregistration);

  if (lock.harbor.version !== preregistration.adapter.harbor_version) {
    throw new TypeError("Harbor version does not match preregistration");
  }
  if (
    config.n_concurrent_trials !== preregistration.selection.concurrency ||
    lock.n_concurrent_trials !== preregistration.selection.concurrency
  ) {
    throw new TypeError("Harbor concurrency does not match preregistration");
  }
  if (preregistration.selection.retries !== 0 || lock.retry.max_retries !== 0) {
    throw new TypeError(
      "Harbor result importer v1 accepts only preregistered zero-retry jobs",
    );
  }
  if (jobResult.stats.n_retries !== 0) {
    throw new TypeError("Harbor job contains an unregistered retry");
  }
  if (
    jobResult.stats.n_running_trials !== 0 ||
    jobResult.stats.n_pending_trials !== 0
  ) {
    throw new TypeError("Harbor job is not terminal");
  }
  if (config.agents.length !== 1 || config.datasets.length !== 1) {
    throw new TypeError(
      "Harbor result importer v1 requires one agent and one dataset per job",
    );
  }
  const configuredAgent = config.agents[0]!;
  const configuredDataset = config.datasets[0]!;
  if (configuredAgent.name !== preregistration.adapter.import_path) {
    throw new TypeError("Harbor agent import path does not match preregistration");
  }
  if (
    !harborModelMatches(
      configuredAgent.model_name,
      preregistration.adapter.provider,
      preregistration.adapter.model,
    )
  ) {
    throw new TypeError("Harbor configured model does not match preregistration");
  }
  if (configuredDataset.name !== preregistration.dataset.id) {
    throw new TypeError("Harbor dataset does not match preregistration");
  }
  if (
    preregistration.schema ===
      "organum-code/harbor-terminal-bench-preregistration/v2" &&
    configuredDataset.ref !== preregistration.dataset.ref
  ) {
    throw new TypeError(
      "Harbor resolved dataset ref does not match full preregistration",
    );
  }
  exactStringSet(configuredDataset.task_names, taskNames, "Harbor task selection");
  exactStringSet(
    lock.trials.map((trial) => trial.task.name),
    taskNames,
    "Harbor locked task selection",
  );

  const expectedTrials =
    taskNames.length * preregistration.selection.attempts;
  if (
    lock.trials.length !== expectedTrials ||
    jobResult.n_total_trials !== expectedTrials ||
    trials.length !== expectedTrials
  ) {
    throw new TypeError(
      `Harbor trial count mismatch: expected ${expectedTrials}, lock ${lock.trials.length}, job ${jobResult.n_total_trials}, artifacts ${trials.length}`,
    );
  }
  if (
    jobResult.stats.n_completed_trials !== expectedTrials ||
    jobResult.stats.n_errored_trials >
      jobResult.stats.n_completed_trials ||
    jobResult.stats.n_cancelled_trials >
      jobResult.stats.n_completed_trials
  ) {
    throw new TypeError("Harbor terminal trial accounting does not balance");
  }
  if (input.comparisonClass === "official-protocol") {
    if (
      preregistration.schema !==
      "organum-code/harbor-terminal-bench-preregistration/v2"
    ) {
      throw new TypeError(
        "official-protocol requires the digest-bound v2 full preregistration",
      );
    }
    if (
      taskNames.length !== preregistration.dataset.task_count ||
      preregistration.selection.attempts !==
        preregistration.official_protocol.leaderboard_attempts
    ) {
      throw new TypeError(
        "official-protocol requires the complete preregistered dataset and attempt count",
      );
    }
    if (
      config.n_attempts !== undefined &&
      config.n_attempts !== preregistration.selection.attempts
    ) {
      throw new TypeError(
        "Harbor configured attempts do not match full preregistration",
      );
    }
    if (
      JSON.stringify(configuredDataset.task_names) !==
      JSON.stringify(preregistration.selection.include_task_names)
    ) {
      throw new TypeError(
        "official-protocol requires the preregistered registry task order",
      );
    }
    assertHarborFullResolvedLock(preregistration, lockArtifact.value);
  }

  const trialByTask = new Map(
    lock.trials.map((trial) => [
      `${trial.task.name}\0${trial.agent.name}\0${trial.agent.model_name}`,
      trial,
    ]),
  );
  for (const locked of lock.trials) {
    const key = `${locked.task.name}\0${locked.agent.name}\0${locked.agent.model_name}`;
    const canonical = trialByTask.get(key)!;
    if (
      locked.task.digest !== canonical.task.digest ||
      locked.task.source !== canonical.task.source ||
      locked.environment.type !== canonical.environment.type ||
      locked.verifier.disable !== canonical.verifier.disable
    ) {
      throw new TypeError(
        `Harbor repeated lock identity drifted for ${locked.task.name}`,
      );
    }
  }
  const legacyGrokVersion =
    "grok_version" in preregistration.adapter
      ? preregistration.adapter.grok_version
      : undefined;
  const expectedBackendVersion =
    preregistration.adapter.backend_version ??
    legacyGrokVersion!;
  const expectedBackend =
    preregistration.adapter.backend ??
    (legacyGrokVersion === undefined ? undefined : "grok");
  const taskBindings = trials.map((trial) => {
    if (trial.result.config.job_id !== jobResult.id) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} belongs to another job`,
      );
    }
    const key = `${trial.result.task_name}\0${trial.result.config.agent.name}\0${trial.result.config.agent.model_name}`;
    const locked = trialByTask.get(key);
    if (locked === undefined) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} has no matching lock entry`,
      );
    }
    if (
      trial.result.task_id.ref !== locked.task.digest ||
      trial.result.source !== locked.task.source
    ) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} task identity drifted`,
      );
    }
    const metadata = trial.result.agent_result.metadata;
    if (
      trial.result.agent_info.model_info.provider !==
        preregistration.adapter.provider ||
      trial.result.agent_info.model_info.name !== preregistration.adapter.model ||
      metadata.provider !== preregistration.adapter.provider ||
      metadata.model !== preregistration.adapter.model
    ) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} brain identity drifted`,
      );
    }
    if (trial.result.agent_info.version !== expectedBackendVersion) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} backend version drifted`,
      );
    }
    if (expectedBackend !== undefined && metadata.backend !== expectedBackend) {
      throw new TypeError(
        `Harbor trial ${trial.result.trial_name} backend identity drifted`,
      );
    }
    return {
      name: trial.result.task_name,
      digest: trial.result.task_id.ref,
      checksum: trial.result.task_checksum,
    };
  });
  const uniqueTaskBindings = [
    ...new Map(
      taskBindings.map((binding) => [binding.name, binding]),
    ).values(),
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (uniqueTaskBindings.length !== taskNames.length) {
    throw new TypeError("Harbor task bindings are ambiguous");
  }
  for (const binding of taskBindings) {
    const canonical = uniqueTaskBindings.find(
      (candidate) => candidate.name === binding.name,
    )!;
    if (
      binding.digest !== canonical.digest ||
      binding.checksum !== canonical.checksum
    ) {
      throw new TypeError(
        `Harbor repeated task identity drifted for ${binding.name}`,
      );
    }
  }

  const protocolRecord = {
    schemaVersion: 1,
    engine: "harbor",
    harborVersion: lock.harbor.version,
    dataset: {
      id: configuredDataset.name,
      release: preregistration.dataset.release,
      ref: configuredDataset.ref,
    },
    tasks: uniqueTaskBindings,
    attempts: preregistration.selection.attempts,
    retries: 0,
    concurrency: preregistration.selection.concurrency,
    environment: [...new Set(lock.trials.map((trial) => trial.environment.type))].sort(),
    verifierDisabled: [
      ...new Set(lock.trials.map((trial) => trial.verifier.disable)),
    ].sort(),
  };
  const manifestDigest = digest(protocolRecord);
  const contractDigest = digest({
    schemaVersion: 1,
    engine: "harbor",
    harborVersion: lock.harbor.version,
    agentImportPath: preregistration.adapter.import_path,
    agentVersions: [
      ...new Set(trials.map((trial) => trial.result.agent_info.version)),
    ].sort(),
    backends: [
      ...new Set(
        trials.map((trial) => trial.result.agent_result.metadata.backend),
      ),
    ].sort(),
    providerAccess: "broker-capability-only",
  });

  const attempts = new Map<string, number>();
  const runs = trials.map((trial) => {
    const metadata = trial.result.agent_result.metadata;
    const attemptKey = [
      trial.result.task_name,
      metadata.backend,
      trial.result.agent_info.model_info.provider,
      trial.result.agent_info.model_info.name,
    ].join("\0");
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    return importedResult(
      trial,
      input.manifestID,
      manifestDigest,
      input.comparisonClass,
      input.brainProtocol,
      brainReasoningEffort,
      attempt,
      contractDigest,
    );
  });

  const warnings: string[] = [];
  if (runs.some((run) => run.adapterEvidence === null)) {
    warnings.push(
      "One or more legacy trials predate per-run Harbor adapter evidence; common outcome and usage fields remain imported, but adapterEvidence is null.",
    );
  }
  return {
    schema: "organum-code/harbor-software-benchmark-import/v1",
    importedAt: new Date().toISOString(),
    source: {
      engine: "harbor",
      harborVersion: lock.harbor.version,
      jobID: jobResult.id,
      dataset: configuredDataset.name,
      datasetRelease: preregistration.dataset.release,
      datasetRef: configuredDataset.ref,
      preregistrationSha256: portableTextSha256(preregArtifact.raw),
      taskBindings: uniqueTaskBindings,
      attempts: preregistration.selection.attempts,
      retries: 0,
      concurrency: preregistration.selection.concurrency,
    },
    admission: {
      valid: true,
      expectedTrials,
      importedTrials: runs.length,
      warnings,
    },
    runs,
  };
}

export function defaultHarborManifestID(
  preregistrationPath: string,
): string {
  return `organum-code/${basename(preregistrationPath, ".json")}`;
}
