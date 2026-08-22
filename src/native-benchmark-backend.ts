import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";

import {
  prepareClaudeBenchmarkLaunch,
  type PreparedClaudeCodeLaunch,
} from "./claude-launcher.js";
import {
  prepareDeepCodeLaunch,
  type PreparedDeepCodeLaunch,
} from "./deepcode-launcher.js";
import {
  prepareGrokBuildLaunch,
  type PreparedGrokBuildLaunch,
} from "./grok-launcher.js";
import {
  boundedDiagnosticText,
  type BoundedDiagnosticText,
} from "./benchmark-diagnostic.js";
import type {
  InferenceBrokerSession,
  InferenceBrokerSnapshot,
} from "./inference-broker.js";
import type { ProviderProfile } from "./provider-profile.js";
import type {
  BenchmarkBrainIdentity,
  PreparedSoftwareBenchmarkCase,
  SoftwareBenchmarkBackendDriver,
  SoftwareBenchmarkAdapterEvidence,
  SoftwareBenchmarkCompletion,
  SoftwareBenchmarkExecution,
  SoftwareBenchmarkUsage,
} from "./software-benchmark.js";
import { nativeTerminalOutcome } from "./terminal-outcome.js";
import { prepareMacosPtyBridge } from "./pty-bridge.js";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const UNTRACKED_HASH_LIMIT_BYTES = 16 * 1024 * 1024;
const PATCH_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const ACTOR_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const DEEPCODE_STATE_LIMIT_BYTES = 1024 * 1024;
export interface PreparedNativeBenchmarkLaunch {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  pty: boolean;
  nativeSessionId?: string | null;
  completionReceiptPath?: string;
  diagnosticRuntimeDirectory?: string;
  diagnosticStateDirectory?: string;
  close(): Promise<void>;
}

export type NativeBenchmarkLaunchFactory = (
  prepared: PreparedSoftwareBenchmarkCase,
  signal?: AbortSignal,
) => Promise<PreparedNativeBenchmarkLaunch>;

export interface NativeSoftwareBenchmarkBackendOptions {
  backendID: string;
  profile: ProviderProfile;
  prepare: NativeBenchmarkLaunchFactory;
  adapterContract: NativeBenchmarkAdapterContract;
  usageSnapshot?: () => InferenceBrokerSnapshot;
  capturePatchDiagnostic?: boolean;
  captureActorDiagnostic?: boolean;
  diagnosticRedactions?: readonly string[];
}

export interface NativeBenchmarkAdapterContract {
  schemaVersion: 1;
  backendID: string;
  comparisonUnit: "native-tui-body";
  providerAccess: "broker-capability-only";
  externalNetwork: "broker-only";
  persistentState: "isolated-ephemeral";
  operatorInput: "none";
  adapterTurnLimit: null;
  completionSignal: "process-exit" | "notify-then-process-exit";
  protocolMediation: readonly string[];
  nativeDifferences: readonly string[];
}

const CLAUDE_BENCHMARK_CONTRACT: NativeBenchmarkAdapterContract = {
  schemaVersion: 1,
  backendID: "claude",
  comparisonUnit: "native-tui-body",
  providerAccess: "broker-capability-only",
  externalNetwork: "broker-only",
  persistentState: "isolated-ephemeral",
  operatorInput: "none",
  adapterTurnLimit: null,
  completionSignal: "process-exit",
  protocolMediation: ["anthropic-messages-to-chat-completions"],
  nativeDifferences: [
    "Claude Code native system prompt",
    "explicit Bash/Edit/Read/Write/Glob/Grep tool allowlist",
  ],
};

const GROK_BENCHMARK_CONTRACT: NativeBenchmarkAdapterContract = {
  schemaVersion: 1,
  backendID: "grok",
  comparisonUnit: "native-tui-body",
  providerAccess: "broker-capability-only",
  externalNetwork: "broker-only",
  persistentState: "isolated-ephemeral",
  operatorInput: "none",
  adapterTurnLimit: null,
  completionSignal: "process-exit",
  protocolMediation: [
    "empty-tool-name-sse-delta-normalization",
    "bind-session-summary-to-brokered-model",
  ],
  nativeDifferences: [
    "Grok Build native system prompt and coding tool surface",
    "headless one-shot lifecycle",
  ],
};

const DEEPCODE_BENCHMARK_CONTRACT: NativeBenchmarkAdapterContract = {
  schemaVersion: 1,
  backendID: "deepcode",
  comparisonUnit: "native-tui-body",
  providerAccess: "broker-capability-only",
  externalNetwork: "broker-only",
  persistentState: "isolated-ephemeral",
  operatorInput: "none",
  adapterTurnLimit: null,
  completionSignal: "notify-then-process-exit",
  protocolMediation: [
    "drop-nonstandard-thinking-and-extra_body",
    "local-fixed-model-catalog",
  ],
  nativeDifferences: [
    "Deep Code native system prompt and coding tool surface",
    "PTY plus native notify completion lifecycle",
  ],
};

function contractDigest(contract: NativeBenchmarkAdapterContract): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function auditAdapterLaunch(
  prepared: PreparedSoftwareBenchmarkCase,
  launch: PreparedNativeBenchmarkLaunch,
  contract: NativeBenchmarkAdapterContract,
): SoftwareBenchmarkAdapterEvidence {
  const promptOccurrences = launch.args.filter(
    (argument) => argument === prepared.prompt,
  ).length;
  if (promptOccurrences !== 1) {
    throw new Error(
      `benchmark adapter conformance failed: expected the exact prompt once in argv, observed ${promptOccurrences}`,
    );
  }
  if (realpathSync(launch.cwd) !== realpathSync(prepared.workspace)) {
    throw new Error(
      "benchmark adapter conformance failed: actor cwd differs from the prepared workspace",
    );
  }
  return {
    schemaVersion: 1,
    comparisonUnit: contract.comparisonUnit,
    contractDigest: contractDigest(contract),
    prompt: {
      sha256: createHash("sha256").update(prepared.prompt).digest("hex"),
      utf8Bytes: Buffer.byteLength(prepared.prompt, "utf8"),
      argvOccurrences: 1,
    },
    workspaceCwdExact: true,
    providerAccess: contract.providerAccess,
    externalNetwork: contract.externalNetwork,
    persistentState: contract.persistentState,
    operatorInput: contract.operatorInput,
    adapterTurnLimit: contract.adapterTurnLimit,
    completionSignal: contract.completionSignal,
    protocolMediation: [...contract.protocolMediation],
    nativeDifferences: [...contract.nativeDifferences],
  };
}

export interface NativeBenchmarkPatchDiagnostic {
  trackedDiff: BoundedDiagnosticText;
  untrackedPaths: readonly string[];
}

export interface NativeBenchmarkActorDiagnostic {
  stdout: BoundedDiagnosticText;
  stderr: BoundedDiagnosticText;
  deepCodeState: BoundedDiagnosticText | null;
}

function assertBrainMatchesProfile(
  brain: BenchmarkBrainIdentity,
  profile: ProviderProfile,
): void {
  if (
    brain.provider !== profile.providerID ||
    brain.model !== profile.modelID ||
    brain.protocol !== profile.protocol
  ) {
    throw new TypeError("benchmark brain identity does not match the brokered profile");
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

function unixDescendants(pid: number): number[] {
  const snapshot = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of snapshot.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const descendants: number[] = [];
  const visit = (parent: number): void => {
    for (const child of children.get(parent) ?? []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(pid);
  return descendants;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process may already have exited.
  }
}

function signalTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  knownDescendants: Set<number>,
): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    signalPid(pid, signal);
    return;
  }
  for (const descendant of unixDescendants(pid)) {
    knownDescendants.add(descendant);
  }
  // Deepest-first direct signals reach children which opened a new process
  // group/session. The group signal retains the fast path for ordinary trees.
  for (const descendant of knownDescendants) {
    signalPid(descendant, signal);
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The leader may already have exited or may not own a process group.
  }
  signalPid(pid, signal);
}

function appendBounded(current: string, chunk: string): string {
  const encoded = Buffer.from(current + chunk, "utf8");
  if (encoded.length <= OUTPUT_LIMIT_BYTES) return encoded.toString("utf8");
  let start = encoded.length - OUTPUT_LIMIT_BYTES;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}

async function readBoundedJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const size = Math.min((await handle.stat()).size, DEEPCODE_STATE_LIMIT_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function projectDeepCodePermissionState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid-index" };
  }
  const entries = Array.isArray((value as { entries?: unknown }).entries)
    ? (value as { entries: unknown[] }).entries.slice(-8)
    : [];
  return {
    sessions: entries.map((entry) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      const permissions = Array.isArray(record.askPermissions)
        ? record.askPermissions.slice(0, 8)
        : [];
      return {
        status: typeof record.status === "string" ? record.status : null,
        failReason:
          typeof record.failReason === "string" ? record.failReason : null,
        askPermissions: permissions.map((permission) => {
          const request = permission && typeof permission === "object" && !Array.isArray(permission)
            ? permission as Record<string, unknown>
            : {};
          return {
            name: typeof request.name === "string" ? request.name : null,
            scopes: Array.isArray(request.scopes)
              ? request.scopes.filter((scope): scope is string => typeof scope === "string").slice(0, 8)
              : [],
            command: typeof request.command === "string" ? request.command : null,
            description:
              typeof request.description === "string" ? request.description : null,
          };
        }),
      };
    }),
  };
}

async function collectDeepCodeState(
  directory: string | undefined,
): Promise<string | null> {
  if (directory === undefined) return null;
  let projectDirectories;
  try {
    projectDirectories = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 8);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const projects: unknown[] = [];
  for (const entry of projectDirectories) {
    try {
      projects.push(projectDeepCodePermissionState(
        await readBoundedJson(join(directory, entry.name, "sessions-index.json")),
      ));
    } catch (error) {
      projects.push({
        status:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing-index"
            : "unreadable-index",
      });
    }
  }
  return JSON.stringify({ projects });
}

async function collectActorDiagnostic(
  launch: PreparedNativeBenchmarkLaunch,
  stdout: string,
  stderr: string,
  exactRedactions: readonly string[] | null,
): Promise<NativeBenchmarkActorDiagnostic | null> {
  if (exactRedactions === null) return null;
  const pathRedactions: Array<readonly [string, string]> = [
    [launch.cwd, "<workspace>"],
    ...(launch.diagnosticRuntimeDirectory === undefined
      ? []
      : [[launch.diagnosticRuntimeDirectory, "<runtime>"] as const]),
  ];
  const options = {
    maxBytes: ACTOR_DIAGNOSTIC_LIMIT_BYTES,
    retain: "tail" as const,
    exactRedactions,
    pathRedactions,
  };
  const state = await collectDeepCodeState(launch.diagnosticStateDirectory);
  return {
    stdout: boundedDiagnosticText(stdout, options),
    stderr: boundedDiagnosticText(stderr, options),
    deepCodeState:
      state === null ? null : boundedDiagnosticText(state, options),
  };
}

function spawnNativeActor(
  launch: PreparedNativeBenchmarkLaunch,
): ChildProcessWithoutNullStreams {
  const command = launch.pty
    ? prepareMacosPtyBridge(launch.executable, launch.args)
    : { executable: launch.executable, args: launch.args };
  return spawn(
    command.executable,
    [...command.args],
    {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
}

async function waitForReceiptOrExit(
  path: string,
  exited: () => boolean,
): Promise<"completed" | "failed" | null> {
  while (!exited()) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as {
        status?: unknown;
      };
      if (value.status === "completed" || value.status === "failed") {
        return value.status;
      }
      throw new Error("Deep Code completion receipt has an invalid status");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          continue;
        }
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
}

function runGit(cwd: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${result.error?.message ?? result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

interface PatchMetrics {
  filesChanged: number;
  linesAdded: number | null;
  linesDeleted: number | null;
  patchDigest: string | null;
}

interface PatchObservation {
  metrics: PatchMetrics;
  diagnostic: NativeBenchmarkPatchDiagnostic | null;
}

function collectPatchObservation(
  workspace: string,
  diagnosticRedactions: readonly string[] | null,
): PatchObservation {
  const diff = runGit(workspace, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const numstat = runGit(workspace, ["diff", "--numstat", "HEAD", "--"])
    .toString("utf8")
    .trim();
  const untracked = runGit(workspace, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();

  const paths = new Set<string>();
  let added = 0;
  let deleted = 0;
  let binary = false;
  if (numstat.length > 0) {
    for (const line of numstat.split("\n")) {
      const [left, right, path] = line.split("\t");
      if (path === undefined) continue;
      paths.add(path);
      if (left === "-" || right === "-") binary = true;
      else {
        added += Number.parseInt(left, 10);
        deleted += Number.parseInt(right, 10);
      }
    }
  }

  const digest = createHash("sha256");
  if (diff.length > 0) digest.update(diff);
  let hashedBytes = diff.length;
  for (const path of untracked) {
    paths.add(path);
    digest.update("\0untracked\0").update(path).update("\0");
    const absolute = join(workspace, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      digest.update("symlink");
      binary = true;
      continue;
    }
    if (!stat.isFile() || hashedBytes + stat.size > UNTRACKED_HASH_LIMIT_BYTES) {
      digest.update(`unhashed:${stat.mode}:${stat.size}`);
      binary = true;
      continue;
    }
    const content = readFileSync(absolute);
    hashedBytes += content.length;
    digest.update(content);
    const text = content.toString("utf8");
    if (text.includes("\0")) binary = true;
    else {
      const newlines = text.match(/\n/g)?.length ?? 0;
      added += newlines + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
    }
  }

  return {
    metrics: {
      filesChanged: paths.size,
      linesAdded: binary ? null : added,
      linesDeleted: binary ? null : deleted,
      patchDigest: paths.size === 0 ? null : digest.digest("hex"),
    },
    diagnostic:
      diagnosticRedactions === null
        ? null
        : {
            trackedDiff: boundedDiagnosticText(
              runGit(workspace, [
                "diff",
                "--no-ext-diff",
                "--unified=3",
                "HEAD",
                "--",
              ]).toString("utf8"),
              {
                maxBytes: PATCH_DIAGNOSTIC_LIMIT_BYTES,
                retain: "head",
                exactRedactions: diagnosticRedactions,
                pathRedactions: [[workspace, "<workspace>"]],
              },
            ),
            untrackedPaths: untracked.map((path) =>
              boundedDiagnosticText(path, {
                maxBytes: 4 * 1024,
                retain: "head",
                exactRedactions: diagnosticRedactions,
              }).text
            ),
          },
  };
}

function usageFrom(
  snapshot: InferenceBrokerSnapshot | undefined,
): SoftwareBenchmarkUsage {
  if (snapshot === undefined) {
    return {
      providerRequests: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      costUsd: null,
    };
  }
  return {
    providerRequests: snapshot.upstreamRequests,
    inputTokens: snapshot.usage.inputTokens,
    outputTokens: snapshot.usage.outputTokens,
    cacheReadTokens: snapshot.usage.cachedInputTokens,
    reasoningTokens: snapshot.usage.reasoningTokens,
    costUsd: null,
  };
}

export function benchmarkAdapterHealthFromBrokerSnapshot(
  snapshot: InferenceBrokerSnapshot | undefined,
): { violations: string[]; warnings: string[] } {
  if (snapshot === undefined) return { violations: [], warnings: [] };
  const violations: string[] = [];
  const warnings: string[] = [];
  if (snapshot.rejectedRequests > 0) {
    violations.push(`broker-rejected-requests:${snapshot.rejectedRequests}`);
  }
  if (
    snapshot.cancelledRequests > 0 &&
    (snapshot.activeRequests > 0 ||
      snapshot.upstreamRequests !== snapshot.usage.responses)
  ) {
    violations.push(`broker-cancelled-requests:${snapshot.cancelledRequests}`);
  }
  if (snapshot.activeRequests > 0) {
    violations.push(`broker-active-after-actor-exit:${snapshot.activeRequests}`);
  }
  if (snapshot.lastFailureCode !== null) {
    const failure = `broker-failure:${snapshot.lastFailureCode}`;
    const expectedBudgetExhaustion =
      snapshot.lastFailureCode === "execution_budget_exhausted" &&
      snapshot.executionBudget?.phase === "exhausted" &&
      snapshot.executionBudget.blockedRequests > 0 &&
      snapshot.executionBudget.responses === snapshot.usage.responses &&
      snapshot.executionBudget.outputTokens === snapshot.usage.outputTokens &&
      snapshot.activeRequests === 0 &&
      snapshot.upstreamRequests === snapshot.usage.responses;
    if (expectedBudgetExhaustion) {
      return { violations, warnings };
    }
    if (
      violations.length === 0 &&
      snapshot.upstreamRequests === snapshot.usage.responses
    ) {
      warnings.push(
        `${failure}:recovered-locally${snapshot.lastRejectedModel === null ? "" : `:model=${snapshot.lastRejectedModel}`}`,
      );
    } else {
      violations.push(failure);
    }
  }
  return { violations, warnings };
}

class NativeBenchmarkExecution implements SoftwareBenchmarkExecution {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #completion: Promise<SoftwareBenchmarkCompletion>;
  readonly adapterEvidence: SoftwareBenchmarkAdapterEvidence;
  #exited = false;
  #cancelled = false;

  constructor(
    private readonly launch: PreparedNativeBenchmarkLaunch,
    private readonly backendID: string,
    adapterEvidence: SoftwareBenchmarkAdapterEvidence,
    private readonly usageSnapshot: (() => InferenceBrokerSnapshot) | undefined,
    private readonly patchDiagnosticRedactions: readonly string[] | null,
    private readonly actorDiagnosticRedactions: readonly string[] | null,
    private readonly observeDiagnostic: (
      diagnostic: NativeBenchmarkPatchDiagnostic | null,
    ) => void,
    private readonly observeActorDiagnostic: (
      diagnostic: NativeBenchmarkActorDiagnostic | null,
    ) => void,
  ) {
    this.adapterEvidence = adapterEvidence;
    this.#child = spawnNativeActor(launch);
    this.#completion = this.#observe();
  }

  async #observe(): Promise<SoftwareBenchmarkCompletion> {
    let stdout = "";
    let stderr = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    this.#child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    const exit = new Promise<{ code: number; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        this.#child.once("error", rejectExit);
        this.#child.once("close", (code, signal) => {
          this.#exited = true;
          resolveExit({ code: code ?? signalExitCode(signal), signal });
        });
      },
    );

    let deepCodeStatus: "completed" | "failed" | null = null;
    try {
      if (this.launch.completionReceiptPath !== undefined) {
        deepCodeStatus = await waitForReceiptOrExit(
          this.launch.completionReceiptPath,
          () => this.#exited,
        );
        if (deepCodeStatus !== null && !this.#exited) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          this.#child.stdin.write("\x04");
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          this.#child.stdin.write("\x04");
        }
      }
      const observedExit = await exit;
      this.observeActorDiagnostic(await collectActorDiagnostic(
        this.launch,
        stdout,
        stderr,
        this.actorDiagnosticRedactions,
      ));
      const patch = collectPatchObservation(
        this.launch.cwd,
        this.patchDiagnosticRedactions,
      );
      this.observeDiagnostic(patch.diagnostic);
      const usageSnapshot = this.usageSnapshot?.();
      const adapterHealth = benchmarkAdapterHealthFromBrokerSnapshot(usageSnapshot);
      const cleanExit =
        !this.#cancelled &&
        observedExit.code === 0 &&
        deepCodeStatus !== "failed";
      return {
        ...(this.launch.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: this.launch.nativeSessionId }),
        exitCode: observedExit.code,
        cleanExit,
        terminalOutcome: nativeTerminalOutcome({
          backendID: this.backendID,
          cancelled: this.#cancelled,
          cleanExit,
          stdout,
          stderr,
        }),
        toolCalls: null,
        testExecutions: null,
        ...patch.metrics,
        containmentViolations: [],
        adapterViolations: adapterHealth.violations,
        adapterWarnings: adapterHealth.warnings,
        usage: usageFrom(usageSnapshot),
        ...(usageSnapshot?.executionBudget === undefined
          ? {}
          : { executionBudget: usageSnapshot.executionBudget }),
      };
    } finally {
      // Keep bounded buffers alive until close so a noisy child cannot trigger
      // an unhandled stream error; content is intentionally not a result field.
      void stdout;
      void stderr;
      await this.launch.close();
    }
  }

  wait(): Promise<SoftwareBenchmarkCompletion> {
    return this.#completion;
  }

  async cancel(): Promise<void> {
    if (this.#cancelled || this.#exited) return;
    this.#cancelled = true;
    const knownDescendants = new Set<number>();
    signalTree(this.#child.pid, "SIGINT", knownDescendants);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (!this.#exited) {
      signalTree(this.#child.pid, "SIGTERM", knownDescendants);
    }
    await Promise.race([
      this.#completion.catch(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000)),
    ]);
    if (!this.#exited) {
      signalTree(this.#child.pid, "SIGKILL", knownDescendants);
      // An escaped descendant can keep inherited pipe descriptors open even
      // after the actor leader exits. Closing our ends bounds ChildProcess
      // `close` without weakening the descendant kill.
      this.#child.stdin.destroy();
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
    }
    const closed = await Promise.race([
      this.#completion.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveWait) =>
        setTimeout(() => resolveWait(false), 2_000)
      ),
    ]);
    if (!closed) {
      throw new Error("Native benchmark actor tree did not close after SIGKILL");
    }
  }
}

export class NativeSoftwareBenchmarkBackendDriver
  implements SoftwareBenchmarkBackendDriver
{
  readonly backendID: string;
  readonly #profile: ProviderProfile;
  readonly #prepare: NativeBenchmarkLaunchFactory;
  readonly #adapterContract: NativeBenchmarkAdapterContract;
  readonly #usageSnapshot: (() => InferenceBrokerSnapshot) | undefined;
  readonly #patchDiagnosticRedactions: readonly string[] | null;
  readonly #actorDiagnosticRedactions: readonly string[] | null;
  #diagnostic: NativeBenchmarkPatchDiagnostic | null = null;
  #actorDiagnostic: NativeBenchmarkActorDiagnostic | null = null;

  constructor(options: NativeSoftwareBenchmarkBackendOptions) {
    this.backendID = options.backendID;
    this.#profile = options.profile;
    this.#prepare = options.prepare;
    this.#adapterContract = options.adapterContract;
    if (options.adapterContract.backendID !== options.backendID) {
      throw new TypeError("benchmark adapter contract backend does not match driver");
    }
    this.#usageSnapshot = options.usageSnapshot;
    this.#patchDiagnosticRedactions = options.capturePatchDiagnostic
      ? [...(options.diagnosticRedactions ?? [])]
      : null;
    this.#actorDiagnosticRedactions = options.captureActorDiagnostic
      ? [...(options.diagnosticRedactions ?? [])]
      : null;
  }

  diagnostic(): NativeBenchmarkPatchDiagnostic | null {
    return this.#diagnostic === null
      ? null
      : {
          trackedDiff: { ...this.#diagnostic.trackedDiff },
          untrackedPaths: [...this.#diagnostic.untrackedPaths],
        };
  }

  actorDiagnostic(): NativeBenchmarkActorDiagnostic | null {
    return this.#actorDiagnostic === null
      ? null
      : {
          stdout: { ...this.#actorDiagnostic.stdout },
          stderr: { ...this.#actorDiagnostic.stderr },
          deepCodeState:
            this.#actorDiagnostic.deepCodeState === null
              ? null
              : { ...this.#actorDiagnostic.deepCodeState },
        };
  }

  async start(
    prepared: PreparedSoftwareBenchmarkCase,
    brain: BenchmarkBrainIdentity,
    signal?: AbortSignal,
  ): Promise<SoftwareBenchmarkExecution> {
    if (signal?.aborted) throw new DOMException("benchmark launch aborted", "AbortError");
    assertBrainMatchesProfile(brain, this.#profile);
    this.#diagnostic = null;
    this.#actorDiagnostic = null;
    const launch = await this.#prepare(prepared, signal);
    try {
      const adapterEvidence = auditAdapterLaunch(
        prepared,
        launch,
        this.#adapterContract,
      );
      return new NativeBenchmarkExecution(
        launch,
        this.backendID,
        adapterEvidence,
        this.#usageSnapshot,
        this.#patchDiagnosticRedactions,
        this.#actorDiagnosticRedactions,
        (diagnostic) => {
          this.#diagnostic = diagnostic;
        },
        (diagnostic) => {
          this.#actorDiagnostic = diagnostic;
        },
      );
    } catch (error) {
      await launch.close().catch(() => undefined);
      throw error;
    }
  }
}

export function buildGrokBenchmarkArgs(
  prompt: string,
  sessionID: string = randomUUID(),
): { args: string[]; sessionID: string } {
  return {
    sessionID,
    args: [
      "--no-leader",
      "--always-approve",
      "--disable-web-search",
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--output-format",
      "json",
      "--single",
      prompt,
    ],
  };
}

export function buildDeepCodeBenchmarkArgs(prompt: string): string[] {
  return ["-p", prompt];
}

function projectGrokLaunch(
  launch: PreparedGrokBuildLaunch,
  nativeSessionId: string,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId,
    close: () => launch.close(),
  };
}

function projectClaudeLaunch(
  launch: PreparedClaudeCodeLaunch,
  nativeSessionId: string,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId,
    close: () => launch.close(),
  };
}

function projectDeepCodeLaunch(
  launch: PreparedDeepCodeLaunch,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: true,
    ...(launch.completionReceiptPath === undefined
      ? {}
      : { completionReceiptPath: launch.completionReceiptPath }),
    diagnosticRuntimeDirectory: launch.diagnosticRuntimeDirectory,
    diagnosticStateDirectory: launch.diagnosticStateDirectory,
    close: () => launch.close(),
  };
}

export interface ConcreteNativeBenchmarkDriverOptions {
  profile: ProviderProfile;
  env: NodeJS.ProcessEnv;
  usageSnapshot?: () => InferenceBrokerSnapshot;
  capturePatchDiagnostic?: boolean;
  captureActorDiagnostic?: boolean;
  diagnosticRedactions?: readonly string[];
}

export interface ClaudeNativeBenchmarkDriverOptions
  extends ConcreteNativeBenchmarkDriverOptions {
  session: Pick<InferenceBrokerSession, "origin" | "token">;
  advertisedModel: string;
}

export function createClaudeSoftwareBenchmarkDriver(
  options: ClaudeNativeBenchmarkDriverOptions,
): NativeSoftwareBenchmarkBackendDriver {
  return new NativeSoftwareBenchmarkBackendDriver({
    backendID: "claude",
    adapterContract: CLAUDE_BENCHMARK_CONTRACT,
    profile: options.profile,
    usageSnapshot: options.usageSnapshot,
    capturePatchDiagnostic: options.capturePatchDiagnostic,
    captureActorDiagnostic: options.captureActorDiagnostic,
    diagnosticRedactions: options.diagnosticRedactions,
    async prepare(prepared) {
      const nativeSessionId = randomUUID();
      const launch = await prepareClaudeBenchmarkLaunch(
        prepared.prompt,
        options.session,
        options.advertisedModel,
        options.env,
        prepared.workspace,
        nativeSessionId,
      );
      return projectClaudeLaunch(launch, nativeSessionId);
    },
  });
}

export function createGrokSoftwareBenchmarkDriver(
  options: ConcreteNativeBenchmarkDriverOptions,
): NativeSoftwareBenchmarkBackendDriver {
  return new NativeSoftwareBenchmarkBackendDriver({
    backendID: "grok",
    adapterContract: GROK_BENCHMARK_CONTRACT,
    profile: options.profile,
    usageSnapshot: options.usageSnapshot,
    capturePatchDiagnostic: options.capturePatchDiagnostic,
    captureActorDiagnostic: options.captureActorDiagnostic,
    diagnosticRedactions: options.diagnosticRedactions,
    async prepare(prepared) {
      const request = buildGrokBenchmarkArgs(prepared.prompt);
      const launch = await prepareGrokBuildLaunch(
        request.args,
        options.profile,
        options.env,
        prepared.workspace,
      );
      return projectGrokLaunch(launch, request.sessionID);
    },
  });
}

export function createDeepCodeSoftwareBenchmarkDriver(
  options: ConcreteNativeBenchmarkDriverOptions,
): NativeSoftwareBenchmarkBackendDriver {
  return new NativeSoftwareBenchmarkBackendDriver({
    backendID: "deepcode",
    adapterContract: DEEPCODE_BENCHMARK_CONTRACT,
    profile: options.profile,
    usageSnapshot: options.usageSnapshot,
    capturePatchDiagnostic: options.capturePatchDiagnostic,
    captureActorDiagnostic: options.captureActorDiagnostic,
    diagnosticRedactions: options.diagnosticRedactions,
    async prepare(prepared) {
      const launch = await prepareDeepCodeLaunch(
        buildDeepCodeBenchmarkArgs(prepared.prompt),
        options.profile,
        options.env,
        prepared.workspace,
        {
          completionSignal: true,
          permissionMode: "contained-unattended",
        },
      );
      return projectDeepCodeLaunch(launch);
    },
  });
}
