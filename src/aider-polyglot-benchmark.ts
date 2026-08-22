import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  PreparedSoftwareBenchmarkCase,
  SoftwareBenchmarkCorpusDriver,
  SoftwareBenchmarkEvaluation,
  SoftwareBenchmarkTask,
} from "./software-benchmark.js";

const INSTRUCTIONS_ADDENDUM = `

####

Use the above instructions to modify the supplied files: {file_list}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.
`;

interface ExerciseConfig {
  files: {
    solution: string[];
    test: string[];
    example: string[];
  };
}

export interface AiderPolyglotTestPlan {
  commands: readonly (readonly string[])[];
  workspace: string;
  timeoutMs: number;
  immutablePaths?: readonly string[];
}

export interface AiderPolyglotTestResult {
  passed: boolean;
  testsPassed: number;
  testsFailed: number;
}

export interface AiderPolyglotTestExecutor {
  preflight?(
    plan: AiderPolyglotTestPlan,
    signal?: AbortSignal,
  ): Promise<void>;
  execute(
    plan: AiderPolyglotTestPlan,
    signal?: AbortSignal,
  ): Promise<AiderPolyglotTestResult>;
}

export interface AiderPolyglotCorpusOptions {
  sourceRoot: string;
  sourceRevision: string;
  sourceProtocol: string;
  testTimeoutMs: number;
  testExecutor: AiderPolyglotTestExecutor;
  workRoot?: string;
}

interface PreparedMetadata {
  root: string;
  testCommands: readonly (readonly string[])[];
  oracleFiles: readonly SealedOracleFile[];
  sealedDigest: string;
}

interface SealedOracleFile {
  relativePath: string;
  sealedPath: string;
  digest: string;
}

function safeRelativePath(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${context} must be a nonempty path`);
  }
  if (isAbsolute(value)) throw new TypeError(`${context} must be relative`);
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${context} contains an unsafe path segment`);
  }
  return segments.join(sep);
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
  return value.map((item, index) => safeRelativePath(item, `${context}[${index}]`));
}

function parseExerciseConfig(input: unknown): ExerciseConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("exercise config must be an object");
  }
  const files = (input as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new TypeError("exercise config files must be an object");
  }
  const record = files as Record<string, unknown>;
  const solution = stringArray(record.solution, "solution files");
  const test = stringArray(record.test, "test files");
  const example = stringArray(record.example ?? [], "example files");
  if (solution.length === 0 || test.length === 0) {
    throw new TypeError("exercise config needs solution and test files");
  }
  return { files: { solution, test, example } };
}

async function assertNoSymlinks(
  root: string,
  context = "benchmark source",
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError(`${context} contains a symlink: ${entry.name}`);
    }
    if (entry.isDirectory()) await assertNoSymlinks(path, context);
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sealedOracleDigest(files: readonly SealedOracleFile[]): string {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  )) {
    digest.update(file.relativePath, "utf8");
    digest.update("\0");
    digest.update(file.digest, "ascii");
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function sealOfficialTests(
  root: string,
  workspace: string,
  testFiles: readonly string[],
): Promise<{
  files: readonly SealedOracleFile[];
  digest: string;
}> {
  const oracleRoot = join(root, "oracle");
  await mkdir(oracleRoot, { recursive: true, mode: 0o700 });
  const files: SealedOracleFile[] = [];
  for (const relativePath of testFiles) {
    const source = join(workspace, relativePath);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new TypeError(
        `official benchmark test must be a regular file: ${relativePath}`,
      );
    }
    const content = await readFile(source);
    const sealedPath = join(oracleRoot, relativePath);
    await mkdir(dirname(sealedPath), { recursive: true, mode: 0o700 });
    await writeFile(sealedPath, content, { flag: "wx", mode: 0o400 });
    await chmod(sealedPath, 0o400);
    files.push({
      relativePath,
      sealedPath,
      digest: sha256(content),
    });
  }
  return { files, digest: sealedOracleDigest(files) };
}

async function actorMutatedOracleFiles(
  workspace: string,
  oracleFiles: readonly SealedOracleFile[],
): Promise<string[]> {
  const mutated: string[] = [];
  for (const oracle of oracleFiles) {
    const candidate = join(workspace, oracle.relativePath);
    try {
      const candidateStat = await lstat(candidate);
      if (
        !candidateStat.isFile() ||
        candidateStat.isSymbolicLink() ||
        sha256(await readFile(candidate)) !== oracle.digest
      ) {
        mutated.push(oracle.relativePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        mutated.push(oracle.relativePath);
        continue;
      }
      throw error;
    }
  }
  return mutated;
}

async function assertEvaluationSourceSymlinksSafe(
  root: string,
  allowedOracleSymlinks: ReadonlySet<string>,
  directory = root,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path);
    if (entry.isSymbolicLink()) {
      if (allowedOracleSymlinks.has(relativePath)) continue;
      throw new TypeError(
        `benchmark actor workspace contains an unsupported symlink: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      await assertEvaluationSourceSymlinksSafe(
        root,
        allowedOracleSymlinks,
        path,
      );
    }
  }
}

async function ensureRealParentDirectories(
  root: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split(sep);
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(
          `benchmark oracle parent is not a real directory: ${relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { mode: 0o700 });
    }
  }
}

async function restoreSealedOracle(
  evaluationWorkspace: string,
  oracleFiles: readonly SealedOracleFile[],
): Promise<string[]> {
  const immutablePaths: string[] = [];
  for (const oracle of oracleFiles) {
    const content = await readFile(oracle.sealedPath);
    if (sha256(content) !== oracle.digest) {
      throw new Error(
        `sealed benchmark oracle integrity failure: ${oracle.relativePath}`,
      );
    }
    await ensureRealParentDirectories(evaluationWorkspace, oracle.relativePath);
    const target = join(evaluationWorkspace, oracle.relativePath);
    await rm(target, { recursive: true, force: true });
    await writeFile(target, content, { flag: "wx", mode: 0o400 });
    await chmod(target, 0o400);
    immutablePaths.push(target);
  }
  return immutablePaths;
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        LANG: process.env.LANG ?? "C.UTF-8",
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`${executable} exited ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

function testCommands(
  language: string,
  sourceProtocol: string,
  testFiles: readonly string[],
): readonly (readonly string[])[] {
  switch (language) {
    case "python":
      if (sourceProtocol === "aider-polyglot-225") {
        return [["python3", "-m", "pytest", "-q"]];
      }
      if (sourceProtocol === "aider-polyglot-225-unittest-v1") {
        return [["python3", "-m", "unittest", "-q", ...testFiles]];
      }
      throw new TypeError(
        `unsupported Aider Polyglot Python protocol: ${sourceProtocol}`,
      );
    case "rust":
      return [["cargo", "test", "--", "--include-ignored"]];
    case "go":
      return [["go", "test", "./..."]];
    case "javascript":
      return [["npm", "run", "test"]];
    case "java":
      return [["./gradlew", "test"]];
    case "cpp":
      return [
        ["cmake", "-S", ".", "-B", "build", "-DEXERCISM_RUN_ALL_TESTS=1", "-G", "Unix Makefiles"],
        ["cmake", "--build", "build"],
      ];
    default:
      throw new TypeError(`unsupported Aider Polyglot language: ${language}`);
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function enableOfficialTests(
  workspace: string,
  language: string,
  testFiles: readonly string[],
): Promise<void> {
  for (const file of testFiles) {
    const path = join(workspace, file);
    let content = await readFile(path, "utf8");
    if (language === "javascript") {
      content = content.replace(/\bxtest\(/g, "test(");
    } else if (language === "java") {
      content = content.replace(/@Disabled\([^)]*\)\s*\r?\n/g, "");
    } else {
      continue;
    }
    await writeFile(path, content, "utf8");
  }
}

async function initializeBaseline(workspace: string): Promise<void> {
  await run("git", ["init", "--quiet"], workspace);
  await run("git", ["add", "--all"], workspace);
  await run(
    "git",
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
    workspace,
  );
}

export class AiderPolyglotCorpusDriver implements SoftwareBenchmarkCorpusDriver {
  readonly #sourceRoot: string;
  readonly #sourceRevision: string;
  readonly #sourceProtocol: string;
  readonly #testTimeoutMs: number;
  readonly #testExecutor: AiderPolyglotTestExecutor;
  readonly #workRoot: string;
  readonly #prepared = new Map<string, PreparedMetadata>();
  #verifiedSource = false;

  constructor(options: AiderPolyglotCorpusOptions) {
    this.#sourceRoot = resolve(options.sourceRoot);
    this.#sourceRevision = options.sourceRevision;
    this.#sourceProtocol = options.sourceProtocol;
    this.#testTimeoutMs = options.testTimeoutMs;
    this.#testExecutor = options.testExecutor;
    this.#workRoot = resolve(options.workRoot ?? tmpdir());
    if (!/^[0-9a-f]{40}$/.test(this.#sourceRevision)) {
      throw new TypeError("Aider Polyglot source revision must be a full lowercase Git SHA");
    }
    if (this.#sourceProtocol.trim().length === 0) {
      throw new TypeError("Aider Polyglot source protocol must be nonempty");
    }
    if (!Number.isSafeInteger(this.#testTimeoutMs) || this.#testTimeoutMs < 1) {
      throw new TypeError("Aider Polyglot test timeout must be positive");
    }
  }

  async #verifySource(): Promise<void> {
    if (this.#verifiedSource) return;
    const sourceStat = await lstat(this.#sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new TypeError("Aider Polyglot source root must be a real directory");
    }
    const revision = await run("git", ["rev-parse", "HEAD"], this.#sourceRoot);
    if (revision !== this.#sourceRevision) {
      throw new Error(
        `Aider Polyglot revision mismatch: expected ${this.#sourceRevision}, got ${revision}`,
      );
    }
    const dirty = await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      this.#sourceRoot,
    );
    if (dirty.length > 0) {
      throw new Error("Aider Polyglot source checkout must be clean");
    }
    this.#verifiedSource = true;
  }

  async prepare(
    task: SoftwareBenchmarkTask,
    signal?: AbortSignal,
  ): Promise<PreparedSoftwareBenchmarkCase> {
    if (signal?.aborted) throw new DOMException("benchmark prepare aborted", "AbortError");
    await this.#verifySource();
    const taskID = safeRelativePath(task.id, "benchmark task id");
    const parts = taskID.split(sep);
    if (parts.length !== 2 || parts[0] !== task.language) {
      throw new TypeError("Aider Polyglot task id must be language/exercise");
    }
    const source = join(
      this.#sourceRoot,
      parts[0],
      "exercises",
      "practice",
      parts[1],
    );
    const sourceRelative = relative(this.#sourceRoot, source);
    if (sourceRelative.startsWith(`..${sep}`) || sourceRelative === "..") {
      throw new TypeError("benchmark task escaped the pinned source root");
    }
    const sourceStat = await lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new TypeError(`Aider Polyglot task is not a real directory: ${task.id}`);
    }
    await assertNoSymlinks(source);

    const config = parseExerciseConfig(
      JSON.parse(await readFile(join(source, ".meta", "config.json"), "utf8")),
    );
    const promptParts = [
      await readOptional(join(source, ".docs", "introduction.md")),
      await readFile(join(source, ".docs", "instructions.md"), "utf8"),
      await readOptional(join(source, ".docs", "instructions.append.md")),
    ];
    const fileList = config.files.solution.map((file) => file.split(sep).at(-1)).join(" ");
    const prompt = `${promptParts.join("")}${INSTRUCTIONS_ADDENDUM.replace("{file_list}", fileList)}`;

    await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.#workRoot, "organum-code-aider-"));
    const workspace = join(root, "workspace");
    try {
      await cp(source, workspace, { recursive: true, errorOnExist: true });
      await enableOfficialTests(workspace, task.language, config.files.test);
      await rm(join(workspace, ".meta"), { recursive: true, force: true });
      await rm(join(workspace, ".docs"), { recursive: true, force: true });
      await initializeBaseline(workspace);
      const oracle = await sealOfficialTests(
        root,
        workspace,
        config.files.test,
      );
      const commands = testCommands(
        task.language,
        this.#sourceProtocol,
        config.files.test,
      );
      await this.#testExecutor.preflight?.(
        {
          commands,
          workspace,
          timeoutMs: this.#testTimeoutMs,
          immutablePaths: oracle.files.map((file) =>
            join(workspace, file.relativePath)
          ),
        },
        signal,
      );
      this.#prepared.set(workspace, {
        root,
        testCommands: commands,
        oracleFiles: oracle.files,
        sealedDigest: oracle.digest,
      });
      return {
        taskID: task.id,
        workspace,
        prompt,
        sessionLabel: `aider-polyglot-${task.language}-${parts[1]}`,
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
    if (metadata === undefined) {
      throw new TypeError("benchmark fixture is not owned by this corpus driver");
    }
    const actorMutatedFiles = await actorMutatedOracleFiles(
      prepared.workspace,
      metadata.oracleFiles,
    );
    const allowedOracleSymlinks = new Set(
      metadata.oracleFiles.map((file) => file.relativePath),
    );
    await assertEvaluationSourceSymlinksSafe(
      prepared.workspace,
      allowedOracleSymlinks,
    );
    const evaluationRoot = await mkdtemp(join(metadata.root, "evaluation-"));
    const evaluationWorkspace = join(evaluationRoot, "workspace");
    try {
      await cp(prepared.workspace, evaluationWorkspace, {
        recursive: true,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      const immutablePaths = await restoreSealedOracle(
        evaluationWorkspace,
        metadata.oracleFiles,
      );
      await assertNoSymlinks(
        evaluationWorkspace,
        "isolated benchmark evaluation workspace",
      );
      const result = await this.#testExecutor.execute(
        {
          commands: metadata.testCommands,
          workspace: evaluationWorkspace,
          timeoutMs: this.#testTimeoutMs,
          immutablePaths,
        },
        signal,
      );
      return {
        passed: result.passed,
        testsPassed: result.testsPassed,
        testsFailed: result.testsFailed,
        testCommands: metadata.testCommands,
        oracleIntegrity: {
          strategy: "workspace-external-sealed-copy",
          sealedDigest: metadata.sealedDigest,
          actorMutatedFiles,
          evaluatorWorkspaceIsolated: true,
          immutableDuringEvaluation: true,
        },
      };
    } finally {
      await rm(evaluationRoot, { recursive: true, force: true });
    }
  }

  async cleanup(prepared: PreparedSoftwareBenchmarkCase): Promise<void> {
    const metadata = this.#prepared.get(prepared.workspace);
    if (metadata === undefined) {
      throw new TypeError("benchmark fixture is not owned by this corpus driver");
    }
    this.#prepared.delete(prepared.workspace);
    await rm(metadata.root, { recursive: true, force: true });
  }
}
