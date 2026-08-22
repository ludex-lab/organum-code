import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

const gitRevision = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const md5 = z.string().regex(/^[0-9a-f]{32}$/);

export const evalPlusAnchorManifestSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1),
    title: z.string().min(1),
    comparisonClass: z.union([
      z.literal("official-protocol"),
      z.literal("provider-adapted-protocol"),
    ]),
    scoreName: z.literal("humanevalplus_pass_at_1"),
    framework: z
      .object({
        repository: z.string().url(),
        release: z.literal("v0.3.1"),
        revision: gitRevision,
        evaluatorImage: z
          .string()
          .regex(/^ganler\/evalplus@sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    dataset: z
      .object({
        repository: z.string().url(),
        release: z.literal("v0.1.10"),
        asset: z.literal("HumanEvalPlus.jsonl.gz"),
        sha256,
        md5,
        tasks: z.literal(164),
      })
      .strict(),
    brain: z
      .object({
        provider: z.literal("upstage"),
        model: z.literal("solar-open2"),
        baseURL: z.literal("https://api.upstage.ai/v1"),
        protocol: z.literal("chat-completions"),
        setting: z.literal("chat"),
        reasoningEffort: z.union([z.null(), z.literal("none")]),
      })
      .strict(),
    generation: z
      .object({
        backend: z.literal("openai"),
        greedy: z.literal(true),
        samplesPerTask: z.literal(1),
        batchSize: z.literal(1),
        temperature: z.literal(0),
        topP: z.literal(0.95),
        maxNewTokens: z.literal(768),
        promptAdapter: z.literal("evalplus-v0.3.1-openai-chat-unaltered"),
        sanitizer: z.literal("evalplus-v0.3.1-default"),
        resume: z.literal(false),
        requestTransform: z
          .literal("broker-add-reasoning-effort-none")
          .optional(),
      })
      .strict(),
    evaluation: z
      .object({
        dataset: z.literal("humaneval"),
        mini: z.literal(false),
        noExtreme: z.literal(false),
        baseOnly: z.literal(false),
        testDetails: z.literal(false),
        version: z.literal("v0.1.10"),
        parallelism: z.literal("official-default-half-cpu"),
        containerNetwork: z.literal("none"),
      })
      .strict(),
    run: z
      .object({
        operatorIntervention: z.literal("forbidden"),
        generationDeadlineMs: z.number().int().positive(),
        brokerTtlMs: z.number().int().positive(),
        brokerRequestTimeoutMs: z.number().int().positive(),
        brokerRequestBudget: z.number().int().min(164),
        brokerMaxConcurrent: z.literal(1),
        cleanAcceptedRequests: z.literal(164),
        partialResultPolicy: z.literal("invalid-no-score"),
      })
      .strict(),
    reporting: z
      .object({
        preserveRawAndSanitizedSamples: z.literal(true),
        reportBaseAndPlusPassAt1: z.literal(true),
        reportProviderUsage: z.literal(true),
        contaminationCaveatRequired: z.literal(true),
        rankingScope: z.literal("brain-only-no-tui-ranking"),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const official =
      manifest.schemaVersion === 1 &&
      manifest.comparisonClass === "official-protocol" &&
      manifest.brain.reasoningEffort === null &&
      manifest.generation.requestTransform === undefined;
    const adapted =
      manifest.schemaVersion === 2 &&
      manifest.comparisonClass === "provider-adapted-protocol" &&
      manifest.brain.reasoningEffort === "none" &&
      manifest.generation.requestTransform ===
        "broker-add-reasoning-effort-none";
    if (!official && !adapted) {
      context.addIssue({
        code: "custom",
        message:
          "EvalPlus manifest version, comparison class, reasoning identity, and request transform must agree",
      });
    }
  });

export type EvalPlusAnchorManifest = z.infer<
  typeof evalPlusAnchorManifestSchema
>;

export function parseEvalPlusAnchorManifest(
  input: unknown,
): EvalPlusAnchorManifest {
  return evalPlusAnchorManifestSchema.parse(input);
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

export function evalPlusAnchorManifestDigest(
  manifest: EvalPlusAnchorManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
}

export interface EvalPlusDatasetAudit {
  sha256: string;
  md5: string;
  tasks: number;
  taskIDs: readonly string[];
}

export interface EvalPlusSampleAudit {
  sha256: string;
  bytes: number;
  samples: number;
  taskIDs: readonly string[];
}

export interface EvalPlusEvaluationAudit {
  tasks: number;
  basePassed: number;
  plusPassed: number;
  basePassAt1: number;
  plusPassAt1: number;
  baseStatuses: Readonly<Record<string, number>>;
  plusStatuses: Readonly<Record<string, number>>;
}

export interface EvalPlusPythonDistribution {
  name: string;
  version: string;
}

export async function auditEvalPlusDataset(
  path: string,
): Promise<EvalPlusDatasetAudit> {
  const compressed = await readFile(path);
  const lines = gunzipSync(compressed)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const taskIDs: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TypeError(`HumanEval+ dataset line ${index + 1} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`HumanEval+ dataset line ${index + 1} is not an object`);
    }
    const taskID = (parsed as { task_id?: unknown }).task_id;
    if (
      typeof taskID !== "string" ||
      !/^HumanEval\/(?:0|[1-9][0-9]{0,2})$/.test(taskID) ||
      seen.has(taskID)
    ) {
      throw new TypeError(
        `HumanEval+ dataset line ${index + 1} has an invalid or duplicate task_id`,
      );
    }
    seen.add(taskID);
    taskIDs.push(taskID);
  }
  return {
    sha256: createHash("sha256").update(compressed).digest("hex"),
    md5: createHash("md5").update(compressed).digest("hex"),
    tasks: taskIDs.length,
    taskIDs,
  };
}

export function assertEvalPlusDatasetMatchesManifest(
  audit: EvalPlusDatasetAudit,
  manifest: EvalPlusAnchorManifest,
): void {
  if (
    audit.sha256 !== manifest.dataset.sha256 ||
    audit.md5 !== manifest.dataset.md5 ||
    audit.tasks !== manifest.dataset.tasks
  ) {
    throw new Error("HumanEval+ dataset does not match the frozen manifest");
  }
}

export async function auditEvalPlusSamples(
  path: string,
  expectedTaskIDs: readonly string[],
): Promise<EvalPlusSampleAudit> {
  const content = await readFile(path);
  const lines = content
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const taskIDs: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TypeError(`EvalPlus sample line ${index + 1} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`EvalPlus sample line ${index + 1} is not an object`);
    }
    const sample = parsed as Record<string, unknown>;
    if (
      Object.keys(sample).sort().join(",") !== "solution,task_id" ||
      typeof sample.task_id !== "string" ||
      typeof sample.solution !== "string" ||
      seen.has(sample.task_id)
    ) {
      throw new TypeError(
        `EvalPlus sample line ${index + 1} has an invalid shape or duplicate task_id`,
      );
    }
    seen.add(sample.task_id);
    taskIDs.push(sample.task_id);
  }
  const expected = new Set(expectedTaskIDs);
  if (
    taskIDs.length !== expectedTaskIDs.length ||
    taskIDs.some((taskID) => !expected.has(taskID))
  ) {
    throw new Error("EvalPlus sample set does not match the frozen dataset");
  }
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    samples: taskIDs.length,
    taskIDs,
  };
}

export async function readEvalPlusSampleSolutions(
  path: string,
): Promise<ReadonlyMap<string, string>> {
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const solutions = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as {
      task_id?: unknown;
      solution?: unknown;
    };
    if (
      typeof parsed.task_id !== "string" ||
      typeof parsed.solution !== "string" ||
      solutions.has(parsed.task_id)
    ) {
      throw new TypeError(
        `EvalPlus sample line ${index + 1} cannot bind an evaluation solution`,
      );
    }
    solutions.set(parsed.task_id, parsed.solution);
  }
  return solutions;
}

function incrementStatus(target: Record<string, number>, status: string): void {
  target[status] = (target[status] ?? 0) + 1;
}

export function auditEvalPlusEvaluation(
  value: unknown,
  dataset: EvalPlusDatasetAudit,
  samples: ReadonlyMap<string, string>,
): EvalPlusEvaluationAudit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("EvalPlus evaluation result must be an object");
  }
  const result = value as Record<string, unknown>;
  const evaluation = result.eval;
  if (
    result.hash !== dataset.md5 ||
    typeof evaluation !== "object" ||
    evaluation === null ||
    Array.isArray(evaluation)
  ) {
    throw new Error("EvalPlus evaluation result is not bound to the dataset");
  }
  const taskResults = evaluation as Record<string, unknown>;
  const expected = new Set(dataset.taskIDs);
  if (
    Object.keys(taskResults).length !== dataset.tasks ||
    Object.keys(taskResults).some((taskID) => !expected.has(taskID)) ||
    samples.size !== dataset.tasks
  ) {
    throw new Error("EvalPlus evaluation task set is incomplete or has extras");
  }

  let basePassed = 0;
  let plusPassed = 0;
  const baseStatuses: Record<string, number> = {};
  const plusStatuses: Record<string, number> = {};
  for (const taskID of dataset.taskIDs) {
    const records = taskResults[taskID];
    if (!Array.isArray(records) || records.length !== 1) {
      throw new Error(`EvalPlus evaluation must contain one result for ${taskID}`);
    }
    const record = records[0];
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new TypeError(`EvalPlus evaluation result for ${taskID} is invalid`);
    }
    const item = record as Record<string, unknown>;
    if (
      item.task_id !== taskID ||
      item.solution !== samples.get(taskID) ||
      typeof item.base_status !== "string" ||
      typeof item.plus_status !== "string"
    ) {
      throw new Error(
        `EvalPlus evaluation result for ${taskID} is not bound to its sample`,
      );
    }
    incrementStatus(baseStatuses, item.base_status);
    incrementStatus(plusStatuses, item.plus_status);
    if (item.base_status === "pass") basePassed += 1;
    if (item.base_status === "pass" && item.plus_status === "pass") {
      plusPassed += 1;
    }
  }
  return {
    tasks: dataset.tasks,
    basePassed,
    plusPassed,
    basePassAt1: basePassed / dataset.tasks,
    plusPassAt1: plusPassed / dataset.tasks,
    baseStatuses,
    plusStatuses,
  };
}

function canonicalDistributionName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

export function parseEvalPlusRequirementsLock(
  content: string,
): readonly EvalPlusPythonDistribution[] {
  const packages: EvalPlusPythonDistribution[] = [];
  const seen = new Set<string>();
  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^;\s]+)$/.exec(line);
    if (match === null) {
      throw new TypeError(
        `EvalPlus requirements lock line ${index + 1} is not an exact package pin`,
      );
    }
    const name = canonicalDistributionName(match[1]);
    if (seen.has(name)) {
      throw new TypeError(
        `EvalPlus requirements lock line ${index + 1} duplicates ${name}`,
      );
    }
    seen.add(name);
    packages.push({ name, version: match[2] });
  }
  if (!seen.has("evalplus")) {
    throw new TypeError("EvalPlus requirements lock must pin evalplus");
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function assertEvalPlusPythonEnvironmentMatchesLock(
  actual: readonly EvalPlusPythonDistribution[],
  expected: readonly EvalPlusPythonDistribution[],
): void {
  const normalizedActual = actual
    .map(({ name, version }) => ({
      name: canonicalDistributionName(name),
      version,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(normalizedActual) !== JSON.stringify(expected)) {
    throw new Error(
      "EvalPlus Python environment does not match the qualified requirements lock",
    );
  }
}

export function evalPlusPythonEnvironmentSource(): string {
  return [
    "import importlib.metadata as metadata",
    "import json",
    "import platform",
    "packages = sorted(",
    '    [{"name": dist.metadata["Name"], "version": dist.version} for dist in metadata.distributions()],',
    '    key=lambda item: item["name"].lower(),',
    ")",
    "print(json.dumps({",
    '    "implementation": platform.python_implementation(),',
    '    "python": platform.python_version(),',
    '    "platform": platform.platform(),',
    '    "packages": packages,',
    "}, sort_keys=True))",
  ].join("\n");
}

export function evalPlusCodegenPythonSource(
  idRange: readonly [number, number] | null,
): string {
  const range = idRange === null ? "None" : `[${idRange[0]}, ${idRange[1]}]`;
  return [
    "import os",
    "from evalplus.codegen import run_codegen",
    "path = run_codegen(",
    '    model="solar-open2",',
    '    dataset="humaneval",',
    '    root=os.environ["ORGANUM_CODE_EVALPLUS_OUTPUT_ROOT"],',
    "    bs=1,",
    "    n_samples=1,",
    "    temperature=0.0,",
    "    resume=False,",
    "    greedy=True,",
    `    id_range=${range},`,
    '    version="v0.1.10",',
    '    backend="openai",',
    '    base_url=os.environ["ORGANUM_CODE_EVALPLUS_BASE_URL"],',
    "    jsonl_fmt=True,",
    ")",
    "print(path)",
  ].join("\n");
}
