import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  auditEvalPlusDataset,
  auditEvalPlusEvaluation,
  auditEvalPlusSamples,
  readEvalPlusSampleSolutions,
} from "./evalplus-anchor.js";
import type {
  PreparedSoftwareBenchmarkCase,
  SoftwareBenchmarkCorpusDriver,
  SoftwareBenchmarkEvaluation,
  SoftwareBenchmarkTask,
} from "./software-benchmark.js";

const ACTOR_PROMPT = [
  "Complete the function in solution.py.",
  "Edit solution.py directly and leave a complete, importable Python solution.",
  "No test files are available. Do not install packages or use the network.",
  "Finish when the implementation is complete.",
].join(" ");
const MAX_SOLUTION_BYTES = 256 * 1024;
const PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

type ActorSolutionStatus = "regular" | "missing" | "unsafe" | "oversized";

interface HumanEvalDatasetEntry {
  taskID: string;
  prompt: string;
}

interface PreparedMetadata {
  root: string;
  taskID: string;
  originalPrompt: string;
}

interface ProcessResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export interface HumanEvalPlusTaskEvaluationInput {
  taskID: string;
  solution: string;
  actorSolutionStatus: ActorSolutionStatus;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HumanEvalPlusTaskEvaluationResult {
  evaluatorImage: string;
  evaluatorImageID: string;
  solutionSha256: string;
  resultSha256: string;
  baseStatus: string;
  plusStatus: string;
  fillerOutcomeDriftTaskIDs: readonly string[];
}

export interface HumanEvalPlusTaskEvaluator {
  evaluate(
    input: HumanEvalPlusTaskEvaluationInput,
  ): Promise<HumanEvalPlusTaskEvaluationResult>;
}

export interface HumanEvalPlusTuiCorpusOptions {
  datasetPath: string;
  datasetSha256: string;
  datasetMd5: string;
  datasetTasks: number;
  testTimeoutMs: number;
  evaluator: HumanEvalPlusTaskEvaluator;
  workRoot?: string;
}

export interface DockerEvalPlusTaskEvaluatorOptions {
  datasetPath: string;
  datasetSha256: string;
  datasetMd5: string;
  evaluatorImage: string;
  baselineSamplesPath: string;
  baselineSamplesSha256: string;
  baselineResultsPath: string;
  baselineResultsSha256: string;
  dockerBin?: string;
  workRoot?: string;
}

export interface HumanEvalPlusBaselineOutcome {
  solution: string;
  baseStatus: string;
  plusStatus: string;
}

interface BaselineEvaluation {
  sampleLines: readonly {
    task_id: string;
    solution: string;
  }[];
  outcomes: ReadonlyMap<string, HumanEvalPlusBaselineOutcome>;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function appendBounded(current: string, chunk: string): string {
  const encoded = Buffer.from(current + chunk, "utf8");
  if (encoded.length <= PROCESS_OUTPUT_LIMIT_BYTES) {
    return encoded.toString("utf8");
  }
  let start = encoded.length - PROCESS_OUTPUT_LIMIT_BYTES;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}

export function auditHumanEvalPlusFillerResults(
  taskResults: Readonly<Record<string, unknown>>,
  expectedOutcomes: ReadonlyMap<string, HumanEvalPlusBaselineOutcome>,
  targetTaskID: string,
): string[] {
  const driftTaskIDs: string[] = [];
  for (const [taskID, expected] of expectedOutcomes) {
    if (taskID === targetTaskID) continue;
    const records = taskResults[taskID];
    if (!Array.isArray(records) || records.length !== 1) {
      throw new Error(`EvalPlus filler result is missing ${taskID}`);
    }
    const item = records[0];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError(`EvalPlus filler result is invalid for ${taskID}`);
    }
    const observed = item as Record<string, unknown>;
    if (observed.solution !== expected.solution) {
      throw new Error(`EvalPlus filler solution drifted for ${taskID}`);
    }
    if (
      observed.base_status !== expected.baseStatus ||
      observed.plus_status !== expected.plusStatus
    ) {
      driftTaskIDs.push(taskID);
    }
  }
  return driftTaskIDs;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolveRun, rejectRun) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: {
        LANG: process.env.LANG ?? "C.UTF-8",
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const terminate = (): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      terminate();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = appendBounded(output, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      output = appendBounded(output, chunk);
    });
    child.once("error", (error) => finish(() => rejectRun(error)));
    child.once("close", (code) =>
      finish(() =>
        resolveRun({
          exitCode: code ?? 1,
          output,
          timedOut,
        })
      )
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

async function initializeBaseline(workspace: string): Promise<void> {
  for (const args of [
    ["init", "--quiet"],
    ["add", "--all"],
    [
      "-c",
      "user.name=Organum Code Benchmark",
      "-c",
      "user.email=benchmark@invalid",
      "commit",
      "--quiet",
      "-m",
      "benchmark baseline",
    ],
  ] as const) {
    const result = await runProcess("git", args, {
      cwd: workspace,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`git ${args[0]} failed while preparing HumanEval+`);
    }
  }
}

async function loadDataset(
  path: string,
  expectedSha256: string,
  expectedMd5: string,
  expectedTasks: number,
): Promise<ReadonlyMap<string, HumanEvalDatasetEntry>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("HumanEval+ dataset must be a regular non-symlink file");
  }
  const compressed = await readFile(path);
  if (
    sha256(compressed) !== expectedSha256 ||
    createHash("md5").update(compressed).digest("hex") !== expectedMd5
  ) {
    throw new Error("HumanEval+ dataset digest does not match the fidelity protocol");
  }
  const lines = gunzipSync(compressed)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length !== expectedTasks) {
    throw new Error("HumanEval+ dataset task count does not match the fidelity protocol");
  }
  const entries = new Map<string, HumanEvalDatasetEntry>();
  for (const [index, line] of lines.entries()) {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`HumanEval+ dataset line ${index + 1} is not an object`);
    }
    const record = value as Record<string, unknown>;
    const taskID = record.task_id;
    const prompt = record.prompt;
    if (
      typeof taskID !== "string" ||
      !/^HumanEval\/(?:0|[1-9][0-9]{0,2})$/.test(taskID) ||
      typeof prompt !== "string" ||
      prompt.length === 0 ||
      entries.has(taskID)
    ) {
      throw new TypeError(`HumanEval+ dataset line ${index + 1} is malformed`);
    }
    entries.set(taskID, { taskID, prompt });
  }
  const expectedIDs = new Set(
    Array.from({ length: expectedTasks }, (_, index) => `HumanEval/${index}`),
  );
  if (
    entries.size !== expectedIDs.size ||
    [...entries.keys()].some((taskID) => !expectedIDs.has(taskID))
  ) {
    throw new Error("HumanEval+ dataset does not contain the exact canonical task IDs");
  }
  return entries;
}

async function readActorSolution(
  path: string,
  fallback: string,
): Promise<{ solution: string; status: ActorSolutionStatus }> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { solution: fallback, status: "missing" };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { solution: fallback, status: "unsafe" };
  }
  if (metadata.size > MAX_SOLUTION_BYTES) {
    return { solution: fallback, status: "oversized" };
  }
  const solution = await readFile(path, "utf8");
  if (solution.includes("\0")) {
    return { solution: fallback, status: "unsafe" };
  }
  return { solution, status: "regular" };
}

export class HumanEvalPlusTuiCorpusDriver
  implements SoftwareBenchmarkCorpusDriver
{
  readonly #datasetPath: string;
  readonly #datasetSha256: string;
  readonly #datasetMd5: string;
  readonly #datasetTasks: number;
  readonly #testTimeoutMs: number;
  readonly #evaluator: HumanEvalPlusTaskEvaluator;
  readonly #workRoot: string;
  readonly #prepared = new Map<string, PreparedMetadata>();
  #dataset: ReadonlyMap<string, HumanEvalDatasetEntry> | null = null;

  constructor(options: HumanEvalPlusTuiCorpusOptions) {
    this.#datasetPath = resolve(options.datasetPath);
    this.#datasetSha256 = options.datasetSha256;
    this.#datasetMd5 = options.datasetMd5;
    this.#datasetTasks = options.datasetTasks;
    this.#testTimeoutMs = options.testTimeoutMs;
    this.#evaluator = options.evaluator;
    this.#workRoot = resolve(options.workRoot ?? tmpdir());
  }

  async #entries(): Promise<ReadonlyMap<string, HumanEvalDatasetEntry>> {
    this.#dataset ??= await loadDataset(
      this.#datasetPath,
      this.#datasetSha256,
      this.#datasetMd5,
      this.#datasetTasks,
    );
    return this.#dataset;
  }

  async prepare(
    task: SoftwareBenchmarkTask,
    signal?: AbortSignal,
  ): Promise<PreparedSoftwareBenchmarkCase> {
    if (signal?.aborted) {
      throw new DOMException("benchmark prepare aborted", "AbortError");
    }
    if (task.language !== "python") {
      throw new TypeError("HumanEval+ TUI fidelity supports Python tasks only");
    }
    const entry = (await this.#entries()).get(task.id);
    if (entry === undefined) {
      throw new Error(`task is not in the pinned HumanEval+ dataset: ${task.id}`);
    }
    await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.#workRoot, "organum-code-humaneval-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(join(workspace, "solution.py"), entry.prompt, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await initializeBaseline(workspace);
      this.#prepared.set(workspace, {
        root,
        taskID: task.id,
        originalPrompt: entry.prompt,
      });
      return {
        taskID: task.id,
        workspace,
        prompt: ACTOR_PROMPT,
        sessionLabel: `humanevalplus-${task.id.replace("/", "-")}`,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async evaluate(
    prepared: PreparedSoftwareBenchmarkCase,
    signal?: AbortSignal,
  ): Promise<SoftwareBenchmarkEvaluation> {
    const metadata = this.#prepared.get(prepared.workspace);
    if (metadata === undefined || metadata.taskID !== prepared.taskID) {
      throw new TypeError("HumanEval+ fixture is not owned by this corpus driver");
    }
    const actor = await readActorSolution(
      join(prepared.workspace, "solution.py"),
      metadata.originalPrompt,
    );
    const result = await this.#evaluator.evaluate({
      taskID: metadata.taskID,
      solution: actor.solution,
      actorSolutionStatus: actor.status,
      timeoutMs: this.#testTimeoutMs,
      signal,
    });
    const basePassed = result.baseStatus === "pass";
    const plusPassed = basePassed && result.plusStatus === "pass";
    return {
      passed: plusPassed,
      testsPassed: Number(basePassed) + Number(plusPassed),
      testsFailed: 2 - Number(basePassed) - Number(plusPassed),
      testCommands: [[
        "python",
        "-m",
        "evalplus.evaluate",
        "--dataset",
        "humaneval",
        "--version",
        "v0.1.10",
      ]],
      score: {
        name: "humanevalplus_task_pass",
        value: plusPassed ? 1 : 0,
        maximum: 1,
      },
      evalPlusBinding: {
        authority: "pinned-evalplus-container",
        datasetSha256: this.#datasetSha256,
        datasetMd5: this.#datasetMd5,
        evaluatorImage: result.evaluatorImage,
        evaluatorImageID: result.evaluatorImageID,
        taskID: metadata.taskID,
        solutionSha256: result.solutionSha256,
        resultSha256: result.resultSha256,
        baseStatus: result.baseStatus,
        plusStatus: result.plusStatus,
        fillerOutcomeDriftTaskIDs: result.fillerOutcomeDriftTaskIDs,
        actorSolutionStatus: actor.status,
        network: "none",
        rootFilesystem: "read-only",
        datasetMount: "read-only",
        sampleMount: "read-only",
      },
    };
  }

  async cleanup(prepared: PreparedSoftwareBenchmarkCase): Promise<void> {
    const metadata = this.#prepared.get(prepared.workspace);
    if (metadata === undefined) {
      throw new TypeError("HumanEval+ fixture is not owned by this corpus driver");
    }
    this.#prepared.delete(prepared.workspace);
    await rm(metadata.root, { recursive: true, force: true });
  }
}

export class DockerEvalPlusTaskEvaluator
  implements HumanEvalPlusTaskEvaluator
{
  readonly #datasetPath: string;
  readonly #datasetSha256: string;
  readonly #datasetMd5: string;
  readonly #evaluatorImage: string;
  readonly #baselineSamplesPath: string;
  readonly #baselineSamplesSha256: string;
  readonly #baselineResultsPath: string;
  readonly #baselineResultsSha256: string;
  readonly #dockerBin: string;
  readonly #workRoot: string;
  #imageID: string | null = null;
  #baseline: BaselineEvaluation | null = null;

  constructor(options: DockerEvalPlusTaskEvaluatorOptions) {
    this.#datasetPath = resolve(options.datasetPath);
    this.#datasetSha256 = options.datasetSha256;
    this.#datasetMd5 = options.datasetMd5;
    this.#evaluatorImage = options.evaluatorImage;
    this.#baselineSamplesPath = resolve(options.baselineSamplesPath);
    this.#baselineSamplesSha256 = options.baselineSamplesSha256;
    this.#baselineResultsPath = resolve(options.baselineResultsPath);
    this.#baselineResultsSha256 = options.baselineResultsSha256;
    this.#dockerBin = options.dockerBin ?? "docker";
    this.#workRoot = resolve(options.workRoot ?? tmpdir());
  }

  async #verifiedImageID(): Promise<string> {
    if (this.#imageID !== null) return this.#imageID;
    const inspected = await runProcess(
      this.#dockerBin,
      ["image", "inspect", this.#evaluatorImage],
      { timeoutMs: 60_000 },
    );
    if (inspected.exitCode !== 0 || inspected.timedOut) {
      throw new Error(
        "pinned EvalPlus evaluator image is unavailable; prepare it before provider execution",
      );
    }
    const values: unknown = JSON.parse(inspected.output);
    const image =
      Array.isArray(values) &&
      typeof values[0] === "object" &&
      values[0] !== null &&
      !Array.isArray(values[0])
        ? values[0] as Record<string, unknown>
        : null;
    if (
      image === null ||
      typeof image.Id !== "string" ||
      !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.includes(this.#evaluatorImage)
    ) {
      throw new Error("local EvalPlus evaluator image does not match its pinned digest");
    }
    this.#imageID = image.Id;
    return image.Id;
  }

  async #verifiedBaseline(): Promise<BaselineEvaluation> {
    if (this.#baseline !== null) return this.#baseline;
    const datasetAudit = await auditEvalPlusDataset(this.#datasetPath);
    if (
      datasetAudit.sha256 !== this.#datasetSha256 ||
      datasetAudit.md5 !== this.#datasetMd5
    ) {
      throw new Error("HumanEval+ baseline dataset digest drifted");
    }
    const sampleMetadata = await lstat(this.#baselineSamplesPath);
    const resultMetadata = await lstat(this.#baselineResultsPath);
    if (
      !sampleMetadata.isFile() ||
      sampleMetadata.isSymbolicLink() ||
      !resultMetadata.isFile() ||
      resultMetadata.isSymbolicLink()
    ) {
      throw new TypeError("HumanEval+ baseline artifacts must be regular files");
    }
    const sampleBytes = await readFile(this.#baselineSamplesPath);
    const resultBytes = await readFile(this.#baselineResultsPath);
    if (
      sha256(sampleBytes) !== this.#baselineSamplesSha256 ||
      sha256(resultBytes) !== this.#baselineResultsSha256
    ) {
      throw new Error("HumanEval+ baseline artifact digest drifted");
    }
    await auditEvalPlusSamples(
      this.#baselineSamplesPath,
      datasetAudit.taskIDs,
    );
    const solutions = await readEvalPlusSampleSolutions(
      this.#baselineSamplesPath,
    );
    const resultValue: unknown = JSON.parse(resultBytes.toString("utf8"));
    auditEvalPlusEvaluation(resultValue, datasetAudit, solutions);
    const evaluation = (resultValue as { eval: Record<string, unknown> }).eval;
    const sampleLines = sampleBytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as {
        task_id: string;
        solution: string;
      });
    const outcomes = new Map<string, HumanEvalPlusBaselineOutcome>();
    for (const [taskID, solution] of solutions) {
      const records = evaluation[taskID];
      if (!Array.isArray(records) || records.length !== 1) {
        throw new Error(`HumanEval+ baseline result is missing ${taskID}`);
      }
      const outcome = records[0];
      if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
        throw new TypeError(`HumanEval+ baseline result is invalid for ${taskID}`);
      }
      const record = outcome as Record<string, unknown>;
      if (
        record.solution !== solution ||
        typeof record.base_status !== "string" ||
        typeof record.plus_status !== "string"
      ) {
        throw new Error(`HumanEval+ baseline result drifted for ${taskID}`);
      }
      outcomes.set(taskID, {
        solution,
        baseStatus: record.base_status,
        plusStatus: record.plus_status,
      });
    }
    this.#baseline = { sampleLines, outcomes };
    return this.#baseline;
  }

  async preflight(): Promise<{
    evaluatorImageID: string;
    datasetSha256: string;
    datasetMd5: string;
  }> {
    const evaluatorImageID = await this.#verifiedImageID();
    const datasetMetadata = await lstat(this.#datasetPath);
    if (!datasetMetadata.isFile() || datasetMetadata.isSymbolicLink()) {
      throw new TypeError("HumanEval+ evaluator dataset is not a regular file");
    }
    const datasetBytes = await readFile(this.#datasetPath);
    const datasetSha256 = sha256(datasetBytes);
    const datasetMd5 = createHash("md5").update(datasetBytes).digest("hex");
    if (
      datasetSha256 !== this.#datasetSha256 ||
      datasetMd5 !== this.#datasetMd5
    ) {
      throw new Error("HumanEval+ evaluator dataset digest drifted");
    }
    await this.#verifiedBaseline();
    return { evaluatorImageID, datasetSha256, datasetMd5 };
  }

  async evaluate(
    input: HumanEvalPlusTaskEvaluationInput,
  ): Promise<HumanEvalPlusTaskEvaluationResult> {
    const { evaluatorImageID } = await this.preflight();

    await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.#workRoot, "organum-code-evalplus-task-"));
    const samplePath = join(root, "samples.jsonl");
    const baseline = await this.#verifiedBaseline();
    if (!baseline.outcomes.has(input.taskID)) {
      throw new Error(`HumanEval+ baseline does not contain ${input.taskID}`);
    }
    const sample = baseline.sampleLines
      .map((entry) =>
        JSON.stringify(
          entry.task_id === input.taskID
            ? { task_id: entry.task_id, solution: input.solution }
            : entry,
        )
      )
      .join("\n") + "\n";
    const sampleSha256 = sha256(sample);
    const containerName =
      `organum-code-evalplus-task-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(samplePath, sample, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
      await chmod(samplePath, 0o400);
      const result = await runProcess(
        this.#dockerBin,
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--tmpfs",
          "/tmp:rw,nosuid,size=1073741824",
          "--env",
          "HOME=/tmp",
          "--env",
          "XDG_CACHE_HOME=/tmp/cache",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--env",
          "HUMANEVAL_OVERRIDE_PATH=/data/HumanEvalPlus.jsonl.gz",
          "--mount",
          `type=bind,src=${root},dst=/output`,
          "--mount",
          `type=bind,src=${samplePath},dst=/output/samples.jsonl,readonly`,
          "--mount",
          `type=bind,src=${this.#datasetPath},dst=/data/HumanEvalPlus.jsonl.gz,readonly`,
          "--entrypoint",
          "python",
          this.#evaluatorImage,
          "-m",
          "evalplus.evaluate",
          "--dataset",
          "humaneval",
          "--samples",
          "/output/samples.jsonl",
          "--version",
          "v0.1.10",
        ],
        {
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        },
      );
      if (result.exitCode !== 0 || result.timedOut || input.signal?.aborted) {
        throw new Error(
          `pinned networkless EvalPlus task evaluation failed: ${result.output.slice(-2_000)}`,
        );
      }
      if (sha256(await readFile(samplePath)) !== sampleSha256) {
        throw new Error("EvalPlus evaluator mutated its read-only task sample");
      }
      const resultPath = join(
        root,
        `${basename(samplePath, ".jsonl")}_eval_results.json`,
      );
      const resultBytes = await readFile(resultPath);
      const value: unknown = JSON.parse(resultBytes.toString("utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("EvalPlus task result is not an object");
      }
      const record = value as Record<string, unknown>;
      const evaluation = record.eval;
      if (
        record.hash !== this.#datasetMd5 ||
        typeof evaluation !== "object" ||
        evaluation === null ||
        Array.isArray(evaluation)
      ) {
        throw new Error("EvalPlus task result is not bound to the pinned dataset");
      }
      const taskResults = evaluation as Record<string, unknown>;
      const taskEntries = taskResults[input.taskID];
      if (
        Object.keys(taskResults).length !== baseline.outcomes.size ||
        !Array.isArray(taskEntries) ||
        taskEntries.length !== 1
      ) {
        throw new Error("EvalPlus task result has an unexpected task set");
      }
      const fillerOutcomeDriftTaskIDs = auditHumanEvalPlusFillerResults(
        taskResults,
        baseline.outcomes,
        input.taskID,
      );
      const item = taskEntries[0];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new TypeError("EvalPlus task result entry is invalid");
      }
      const outcome = item as Record<string, unknown>;
      if (
        outcome.task_id !== input.taskID ||
        outcome.solution !== input.solution ||
        typeof outcome.base_status !== "string" ||
        typeof outcome.plus_status !== "string"
      ) {
        throw new Error("EvalPlus task outcome is not bound to the submitted solution");
      }
      return {
        evaluatorImage: this.#evaluatorImage,
        evaluatorImageID,
        solutionSha256: sha256(input.solution),
        resultSha256: sha256(resultBytes),
        baseStatus: outcome.base_status,
        plusStatus: outcome.plus_status,
        fillerOutcomeDriftTaskIDs,
      };
    } finally {
      await runProcess(
        this.#dockerBin,
        ["rm", "-f", containerName],
        { timeoutMs: 30_000 },
      ).catch(() => null);
      await rm(root, { recursive: true, force: true });
    }
  }
}
