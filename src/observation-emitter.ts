import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { resolveActorStateDirectory } from "./actor-runtime.js";
import type { AcpCoordinatedPromptResult } from "./acp-coordination.js";
import type {
  InferenceBrokerSettlement,
  InferenceBrokerSnapshot,
} from "./inference-broker.js";
import {
  canonicalObservationBackendID,
  ORGANUM_CODE_OBSERVATION_SCHEMA,
  observationRunID,
  observationSourceDigest,
  observationUsageFromBroker,
  parseOrganumCodeObservation,
  type OrganumCodeObservation,
} from "./observation.js";
import { OrganumCli } from "./organum-cli.js";
import type { ProviderProfile } from "./provider-profile.js";
import {
  ORGANUM_CODE_PRODUCT,
  ORGANUM_CODE_VERSION,
} from "./product.js";
import type { SoftwareBenchmarkRunResult } from "./software-benchmark.js";
import type { NativeToolApprovalConfound } from "./native-tool-approval.js";

export const ORGANUM_CODE_OBSERVATION_MODE_ENV =
  "ORGANUM_CODE_OBSERVATION" as const;
export type ObservationEmissionMode =
  | "artifact"
  | "auto"
  | "off"
  | "required";

export interface ObservationEmissionResult {
  mode: ObservationEmissionMode;
  artifactPath: string | null;
  ingested: boolean;
  error: string | null;
}

export interface ObservationEmitterDependencies {
  stateDirectory?: string;
  organum?: Pick<OrganumCli, "ingestObservation">;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return Array.from(
    value
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"),
  ).slice(0, 512).join("");
}

function boundedClassification(value: string): string {
  const bounded = Array.from(value).slice(0, 1_024).join("");
  return bounded.length === 0 ? "no classification available" : bounded;
}

export function observationEmissionMode(
  env: NodeJS.ProcessEnv,
): ObservationEmissionMode {
  const value = env[ORGANUM_CODE_OBSERVATION_MODE_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "artifact" || value === "off" || value === "required") {
    return value;
  }
  throw new Error(
    `${ORGANUM_CODE_OBSERVATION_MODE_ENV} must be artifact, auto, off, or required`,
  );
}

function usageCompleteness(
  settlement: InferenceBrokerSettlement | undefined,
): "complete" | "lower-bound" {
  return settlement?.idle === true && settlement.forcedAbortRequests === 0
    ? "complete"
    : "lower-bound";
}

function terminalStatus(
  exitCode: number | null,
  failed: boolean,
): OrganumCodeObservation["run"]["status"] {
  if (failed) return "error";
  if (exitCode === 130 || exitCode === 143) return "cancelled";
  return exitCode === 0 ? "passed" : "failed";
}

function benchmarkStatus(
  status: SoftwareBenchmarkRunResult["status"],
): OrganumCodeObservation["run"]["status"] {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
    case "containment-violation":
      return "failed";
    case "timeout":
      return "timeout";
    case "aborted":
      return "cancelled";
    case "infrastructure-error":
      return "error";
  }
}

function producer(input: {
  producerVersion?: string;
  producerCommit?: string | null;
}): OrganumCodeObservation["provenance"]["producer"] {
  return {
    name: ORGANUM_CODE_PRODUCT,
    version: input.producerVersion ?? ORGANUM_CODE_VERSION,
    commit: input.producerCommit ?? null,
  };
}

function comparisonDigest(value: string | null | undefined): string | null {
  return value == null ? null : observationSourceDigest(value);
}

export interface TerminalObservationInput {
  backend: string;
  backendVersion?: string | null;
  backendProtocol: string;
  nativeSessionId?: string | null;
  profile: ProviderProfile;
  exitCode: number | null;
  failed?: boolean;
  startedAt: string;
  finishedAt: string;
  recordedAt?: string;
  settlement?: InferenceBrokerSettlement;
  producerVersion?: string;
  producerCommit?: string | null;
  canonicalCell?: string | null;
  joinStatus?: "joined" | "not-joined" | "unknown";
  identityRole?: string | null;
  outcomeGate?: "pass" | "fail" | "partial" | "not-evaluated";
  outcomeChecks?: Record<string, boolean>;
  nativeToolApproval?: NativeToolApprovalConfound | null;
  comparisonKey?: string | null;
  preregistrationId?: string | null;
  evaluationName?: string;
  evaluationScenario?: string | null;
  coordination?: {
    contributions: number;
    topic: string | null;
    publicationPhase: string | null;
    sessionClosed: boolean | null;
    receipt: {
      file: string;
      bodyBytes: number;
      bodySha256: string;
    } | null;
  };
}

export function buildTerminalObservation(
  input: TerminalObservationInput,
): OrganumCodeObservation {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const processStatus = terminalStatus(
    input.exitCode,
    input.failed ?? false,
  );
  const terminalToolDenied =
    processStatus === "passed" &&
    input.nativeToolApproval?.rejectOnce === 1;
  const status = terminalToolDenied ? "cancelled" : processStatus;
  const source = {
    schema: "organum-code/product-terminal/v1",
    backend: canonicalObservationBackendID(input.backend),
    backendVersion: input.backendVersion ?? null,
    provider: input.profile.providerID,
    model: input.profile.modelID,
    exitCode: input.exitCode,
    status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    nativeSessionId: input.nativeSessionId ?? null,
    nativeToolApproval: input.nativeToolApproval ?? null,
    comparisonKey: input.comparisonKey ?? null,
    preregistrationId: input.preregistrationId ?? null,
    evaluationName: input.evaluationName ?? "product-terminal",
    evaluationScenario: input.evaluationScenario ?? null,
    usage: input.settlement?.snapshot ?? null,
  };
  const sourceDigest = observationSourceDigest(source);
  return parseOrganumCodeObservation({
    schema: ORGANUM_CODE_OBSERVATION_SCHEMA,
    run: {
      id: observationRunID({
        sourceDigest,
        attempt: 1,
        backendSessionId: input.nativeSessionId ?? null,
      }),
      attempt: 1,
      status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      recordedAt,
      timingCompleteness: "complete",
      comparisonKey: input.comparisonKey ?? null,
      preregistrationId: input.preregistrationId ?? null,
    },
    identity: {
      canonicalCell: input.canonicalCell ?? null,
      joinStatus: input.joinStatus ?? "not-joined",
      role: input.identityRole === undefined ? input.profile.role : input.identityRole,
      persona: null,
      workspace: null,
    },
    backend: {
      id: canonicalObservationBackendID(input.backend),
      version: input.backendVersion ?? null,
      protocol: input.backendProtocol,
      nativeSessionId: input.nativeSessionId ?? null,
    },
    brain: {
      provider: input.profile.providerID,
      model: input.profile.modelID,
      protocol: input.profile.protocol,
      reasoning: { enabled: null, effort: null },
    },
    usage: observationUsageFromBroker(
      input.settlement?.snapshot,
      usageCompleteness(input.settlement),
    ),
    coordination: input.coordination ?? {
      contributions: 0,
      topic: null,
      publicationPhase: null,
      sessionClosed: null,
      receipt: null,
    },
    discipline: {
      nativeToolApproval: input.nativeToolApproval ?? null,
      commands: [],
      declaredExecutions: null,
      additionalReadOnlyCommands: null,
      strictSingleExecute: null,
      executionBudgetPhase:
        input.settlement?.snapshot.executionBudget?.phase ?? null,
      checkpointActuations:
        input.settlement?.snapshot.executionBudget?.checkpointActuations ??
        null,
      conservationActuations:
        input.settlement?.snapshot.executionBudget?.conservationActuations ??
        null,
      worktreeClean: null,
    },
    outcome: {
      gate:
        terminalToolDenied
          ? "not-evaluated"
          : input.outcomeGate ?? (status === "passed" ? "pass" : "fail"),
      classification: boundedClassification(
        terminalToolDenied
          ? "native tool proposal denied before execution"
          : status === "passed"
          ? "backend process exited cleanly"
          : `backend process ended with ${status}`,
      ),
      causalClaim: "observational",
      checks:
        terminalToolDenied
          ? {
              native_tool_execution_denied: true,
              backend_process_clean_exit: true,
            }
          : input.outcomeChecks ??
            { backend_process_clean_exit: status === "passed" },
    },
    provenance: {
      observationSource: "reported",
      producer: producer(input),
      source: {
        schema: source.schema,
        digest: sourceDigest,
        repositoryCommit: null,
        priorFailure: null,
      },
    },
    evaluation: {
      name: input.evaluationName ?? "product-terminal",
      scenario: input.evaluationScenario ?? null,
    },
  });
}

export interface AcpObservationInput {
  backendVersion?: string | null;
  profile: ProviderProfile;
  nativeSessionId: string;
  result: AcpCoordinatedPromptResult;
  successful: boolean;
  startedAt: string;
  finishedAt: string;
  recordedAt?: string;
  settlement: InferenceBrokerSettlement;
  persona?: string | null;
  workspace?: string | null;
  producerVersion?: string;
  producerCommit?: string | null;
}

export function buildGrokAcpObservation(
  input: AcpObservationInput,
): OrganumCodeObservation {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const receipt = input.result.publication.receipt;
  const contributions = receipt === null ? 0 : 1;
  const source = {
    schema: "organum-code/grok-acp-terminal/v1",
    sessionID: input.nativeSessionId,
    cell: input.result.cell,
    stopReason: input.result.stopReason,
    successful: input.successful,
    publication: input.result.publication,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    usage: input.settlement.snapshot,
  };
  const sourceDigest = observationSourceDigest(source);
  return parseOrganumCodeObservation({
    schema: ORGANUM_CODE_OBSERVATION_SCHEMA,
    run: {
      id: observationRunID({
        sourceDigest,
        attempt: 1,
        backendSessionId: input.nativeSessionId,
      }),
      attempt: 1,
      status: input.successful ? "passed" : "failed",
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      recordedAt,
      timingCompleteness: "complete",
      comparisonKey: null,
      preregistrationId: null,
    },
    identity: {
      canonicalCell: input.result.cell,
      joinStatus: "joined",
      role: input.profile.role,
      persona: input.persona ?? null,
      workspace: input.workspace ?? null,
    },
    backend: {
      id: "grok-build",
      version: input.backendVersion ?? null,
      protocol: "acp",
      nativeSessionId: input.nativeSessionId,
    },
    brain: {
      provider: input.profile.providerID,
      model: input.profile.modelID,
      protocol: input.profile.protocol,
      reasoning: {
        enabled: null,
        effort: null,
      },
    },
    usage: observationUsageFromBroker(
      input.settlement.snapshot,
      usageCompleteness(input.settlement),
    ),
    coordination: {
      contributions,
      topic: receipt?.topic ?? null,
      publicationPhase: input.result.publication.phase,
      sessionClosed: input.result.publication.phase === "shipped",
      receipt:
        receipt === null
          ? null
          : {
              file: receipt.file,
              bodyBytes: receipt.body_bytes,
              bodySha256: receipt.body_sha256,
            },
    },
    discipline: {
      nativeToolApproval: null,
      commands: [],
      declaredExecutions: null,
      additionalReadOnlyCommands: null,
      strictSingleExecute: null,
      executionBudgetPhase:
        input.settlement.snapshot.executionBudget?.phase ?? null,
      checkpointActuations:
        input.settlement.snapshot.executionBudget?.checkpointActuations ??
        null,
      conservationActuations:
        input.settlement.snapshot.executionBudget?.conservationActuations ??
        null,
      worktreeClean: null,
    },
    outcome: {
      gate: input.successful ? "pass" : "fail",
      classification: boundedClassification(input.successful
        ? "coordinated ACP turn shipped"
        : "coordinated ACP turn incomplete"),
      causalClaim: "observational",
      checks: {
        coordination_conformant: input.result.coordinationConformant,
        terminal_publication:
          input.result.publication.phase === "shipped",
      },
    },
    provenance: {
      observationSource: "reported",
      producer: producer(input),
      source: {
        schema: source.schema,
        digest: sourceDigest,
        repositoryCommit: null,
        priorFailure: null,
      },
    },
    evaluation: { name: "grok-acp-product", scenario: null },
  });
}

export interface BenchmarkObservationInput {
  result: SoftwareBenchmarkRunResult;
  backendVersion?: string | null;
  startedAt: string;
  finishedAt: string;
  recordedAt?: string;
  settlement?: InferenceBrokerSettlement;
  repositoryCommit?: string | null;
  producerVersion?: string;
  producerCommit?: string | null;
  preregistrationId?: string | null;
}

export function buildBenchmarkObservation(
  input: BenchmarkObservationInput,
): OrganumCodeObservation {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const runStatus = benchmarkStatus(input.result.status);
  const snapshot = input.settlement?.snapshot;
  const source = {
    schema: "organum-code/software-benchmark-observation-source/v1",
    manifestID: input.result.manifestID,
    manifestDigest: input.result.manifestDigest,
    taskID: input.result.taskID,
    backendID: canonicalObservationBackendID(input.result.backendID),
    attempt: input.result.attempt,
    status: input.result.status,
    terminalOutcome: input.result.terminalOutcome,
    evaluation: input.result.evaluation,
    completion: input.result.completion === null
      ? null
      : {
          nativeSessionId: input.result.completion.nativeSessionId ?? null,
          exitCode: input.result.completion.exitCode,
          cleanExit: input.result.completion.cleanExit,
          patchDigest: input.result.completion.patchDigest,
          toolCalls: input.result.completion.toolCalls,
          testExecutions: input.result.completion.testExecutions,
          containmentViolations:
            input.result.completion.containmentViolations,
          adapterViolations: input.result.completion.adapterViolations,
        },
    usage: snapshot ?? null,
  };
  const sourceDigest = observationSourceDigest(source);
  const checks: Record<string, boolean> = {
    benchmark_passed: input.result.status === "passed",
    clean_exit: input.result.completion?.cleanExit ?? false,
    adapter_conformant:
      (input.result.completion?.adapterViolations.length ?? 0) === 0,
    containment_clean:
      (input.result.completion?.containmentViolations.length ?? 0) === 0,
  };
  return parseOrganumCodeObservation({
    schema: ORGANUM_CODE_OBSERVATION_SCHEMA,
    run: {
      id: observationRunID({
        sourceDigest,
        attempt: input.result.attempt,
        backendSessionId:
          input.result.completion?.nativeSessionId ?? null,
      }),
      attempt: input.result.attempt,
      status: runStatus,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      recordedAt,
      timingCompleteness: "complete",
      comparisonKey: comparisonDigest(input.result.comparisonKey),
      preregistrationId: input.preregistrationId ?? null,
    },
    identity: {
      canonicalCell: null,
      joinStatus: "not-joined",
      role: null,
      persona: null,
      workspace: null,
    },
    backend: {
      id: canonicalObservationBackendID(input.result.backendID),
      version: input.backendVersion ?? null,
      protocol: "native-tui",
      nativeSessionId:
        input.result.completion?.nativeSessionId ?? null,
    },
    brain: {
      provider: input.result.brain.provider,
      model: input.result.brain.model,
      protocol: input.result.brain.protocol,
      reasoning: {
        enabled:
          input.result.brain.reasoningEffort === null
            ? null
            : input.result.brain.reasoningEffort !== "none",
        effort: input.result.brain.reasoningEffort,
      },
    },
    usage: observationUsageFromBroker(
      snapshot,
      usageCompleteness(input.settlement),
    ),
    coordination: {
      contributions: 0,
      topic: null,
      publicationPhase: null,
      sessionClosed: null,
      receipt: null,
    },
    discipline: {
      nativeToolApproval: null,
      commands: [],
      declaredExecutions: input.result.completion?.testExecutions ?? null,
      additionalReadOnlyCommands: null,
      strictSingleExecute: null,
      executionBudgetPhase:
        snapshot?.executionBudget?.phase ??
        input.result.completion?.executionBudget?.phase ??
        null,
      checkpointActuations:
        snapshot?.executionBudget?.checkpointActuations ??
        input.result.completion?.executionBudget?.checkpointActuations ??
        null,
      conservationActuations:
        snapshot?.executionBudget?.conservationActuations ??
        input.result.completion?.executionBudget?.conservationActuations ??
        null,
      worktreeClean: null,
    },
    outcome: {
      gate:
        input.result.status === "passed"
          ? "pass"
          : input.result.evaluation === null
            ? "not-evaluated"
            : "fail",
      classification: boundedClassification(
        input.result.error ?? `software benchmark ${input.result.status}`,
      ),
      causalClaim: "controlled",
      checks,
    },
    provenance: {
      observationSource: "reported",
      producer: producer(input),
      source: {
        schema: source.schema,
        digest: sourceDigest,
        repositoryCommit: input.repositoryCommit ?? null,
        priorFailure: null,
      },
    },
    evaluation: {
      name: input.result.manifestID,
      scenario: input.result.taskID,
    },
  });
}

async function writeObservationArtifact(
  observation: OrganumCodeObservation,
  stateDirectory: string,
  workspace: string,
): Promise<string> {
  const requestedState = resolve(stateDirectory);
  const canonicalWorkspace = await realpath(workspace);
  const within = (root: string, candidate: string): boolean => {
    const path = relative(resolve(root), resolve(candidate));
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  if (
    within(canonicalWorkspace, requestedState) ||
    within(requestedState, canonicalWorkspace)
  ) {
    throw new Error(
      "observation state directory must be disjoint from the workspace",
    );
  }
  await mkdir(requestedState, { recursive: true, mode: 0o700 });
  const stateMetadata = await lstat(requestedState);
  if (!stateMetadata.isDirectory() || stateMetadata.isSymbolicLink()) {
    throw new Error(
      "observation state directory must be a real non-symlink directory",
    );
  }
  if (process.platform !== "win32" && (stateMetadata.mode & 0o077) !== 0) {
    throw new Error(
      "observation state directory must not be accessible by group or other users",
    );
  }
  const canonicalState = await realpath(requestedState);
  if (
    within(canonicalWorkspace, canonicalState) ||
    within(canonicalState, canonicalWorkspace)
  ) {
    throw new Error(
      "observation state directory must be disjoint from the workspace",
    );
  }
  const directory = join(canonicalState, "observations");
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const directoryMetadata = await lstat(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    (process.platform !== "win32" && (directoryMetadata.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "observation artifact directory must be a private real directory",
    );
  }
  const target = join(directory, `${observation.run.id}.json`);
  const body = `${JSON.stringify(observation, null, 2)}\n`;
  try {
    const existing = await readFile(target, "utf8");
    if (existing !== body) {
      throw new Error(
        `observation artifact conflict for ${observation.run.id}`,
      );
    }
    return target;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const temporary = join(directory, `.${observation.run.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, body, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, target);
    return target;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const existing = await readFile(target, "utf8");
      if (existing === body) return target;
      throw new Error(
        `observation artifact conflict for ${observation.run.id}`,
      );
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function emitOrganumCodeObservation(
  observationInput: OrganumCodeObservation,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    dependencies?: ObservationEmitterDependencies;
  } = {},
): Promise<ObservationEmissionResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const mode = observationEmissionMode(env);
  if (mode === "off") {
    return { mode, artifactPath: null, ingested: false, error: null };
  }
  let artifactPath: string | null = null;
  try {
    const observation = parseOrganumCodeObservation(observationInput);
    const stateDirectory =
      options.dependencies?.stateDirectory ??
      resolveActorStateDirectory(env);
    artifactPath = await writeObservationArtifact(
      observation,
      stateDirectory,
      cwd,
    );
    if (mode === "artifact") {
      return { mode, artifactPath, ingested: false, error: null };
    }
    const organum =
      options.dependencies?.organum ??
      new OrganumCli({
        binary: env.ORGANUM_CODE_ORGANUM_BIN?.trim() || "organum",
        cwd,
        env,
      });
    await organum.ingestObservation(artifactPath);
    return { mode, artifactPath, ingested: true, error: null };
  } catch (error) {
    if (mode === "required") throw error;
    return {
      mode,
      artifactPath,
      ingested: false,
      error: safeError(error),
    };
  }
}

export async function buildAndEmitOrganumCodeObservation(
  build: () => OrganumCodeObservation,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    dependencies?: ObservationEmitterDependencies;
  } = {},
): Promise<ObservationEmissionResult> {
  const env = options.env ?? process.env;
  const mode = observationEmissionMode(env);
  if (mode === "off") {
    return { mode, artifactPath: null, ingested: false, error: null };
  }
  try {
    return await emitOrganumCodeObservation(build(), options);
  } catch (error) {
    if (mode === "required") throw error;
    return {
      mode,
      artifactPath: null,
      ingested: false,
      error: safeError(error),
    };
  }
}

export function observationSnapshot(
  settlement: InferenceBrokerSettlement | undefined,
): InferenceBrokerSnapshot | undefined {
  return settlement?.snapshot;
}
