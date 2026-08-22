import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  prepareBackendContainment,
  type PreparedBackendContainment,
} from "./containment.js";
import {
  boundedDiagnosticText,
  type BoundedDiagnosticText,
} from "./benchmark-diagnostic.js";
import type {
  AiderPolyglotTestExecutor,
  AiderPolyglotTestPlan,
  AiderPolyglotTestResult,
} from "./aider-polyglot-benchmark.js";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DIAGNOSTIC_LIMIT_BYTES = 16 * 1024;
const SAFE_ENVIRONMENT_NAMES = [
  "LANG",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
] as const;

export interface ContainedBenchmarkTestExecutorOptions {
  brokerOrigin: string;
  env?: NodeJS.ProcessEnv;
  workRoot?: string;
  diagnosticRedactions?: readonly string[];
}

export interface BenchmarkTestCommandDiagnostic {
  command: readonly string[];
  exitCode: number;
  timedOut: boolean;
  outputBytes: number;
  output: BoundedDiagnosticText;
}

export interface BenchmarkTestCounts {
  passed: number;
  failed: number;
}

export function benchmarkTestCounts(
  output: string,
  exitCode: number,
): BenchmarkTestCounts {
  const passed = /(?:^|\s)(\d+) passed(?:,|\s|$)/m.exec(output);
  const failed = /(?:^|\s)(\d+) failed(?:,|\s|$)/m.exec(output);
  const errors = /(?:^|\s)(\d+) errors?(?:,|\s|$)/m.exec(output);
  if (passed !== null || failed !== null || errors !== null) return {
    passed: passed === null ? (exitCode === 0 ? 1 : 0) : Number(passed[1]),
    failed:
      (failed === null ? (exitCode === 0 ? 0 : 1) : Number(failed[1])) +
      (errors === null ? 0 : Number(errors[1])),
  };
  const unittestTotal = /Ran\s+(\d+)\s+tests?\s+in\s+/m.exec(output);
  if (unittestTotal !== null) {
    const count = (name: string): number => {
      const match = new RegExp(`${name}=(\\d+)`).exec(output);
      return match === null ? 0 : Number(match[1]);
    };
    const nonpassing =
      count("failures") +
      count("errors") +
      count("skipped") +
      count("unexpected successes");
    return {
      passed: Math.max(0, Number(unittestTotal[1]) - nonpassing),
      failed: nonpassing,
    };
  }
  return { passed: exitCode === 0 ? 1 : 0, failed: exitCode === 0 ? 0 : 1 };
}

export function buildContainedBenchmarkTestEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

function signalTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // The command may already have exited.
  }
}

function preflightCommand(command: readonly string[]): readonly string[] {
  const moduleIndex = command.indexOf("-m");
  const moduleName = moduleIndex < 0 ? undefined : command[moduleIndex + 1];
  if (
    moduleName !== undefined &&
    /^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName)
  ) {
    return [
      command[0],
      "-c",
      `import importlib; importlib.import_module(${JSON.stringify(moduleName)})`,
    ];
  }
  return [command[0], "--version"];
}

async function diagnosticPathRedactions(
  workspace: string,
  runtime: string,
): Promise<ReadonlyArray<readonly [string, string]>> {
  const candidates: Array<readonly [string, string]> = [
    [await realpath(workspace).catch(() => workspace), "<workspace>"],
    [workspace, "<workspace>"],
    [await realpath(runtime).catch(() => runtime), "<runtime>"],
    [runtime, "<runtime>"],
  ];
  const seen = new Set<string>();
  return candidates.filter(([path]) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

async function runContainedCommand(
  prepared: PreparedBackendContainment,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; outputBytes: number; timedOut: boolean }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
      cwd: prepared.cwd,
      env: prepared.spawn.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let outputBytes = 0;
    let timedOut = false;
    const append = (chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > OUTPUT_LIMIT_BYTES) {
        const encoded = Buffer.from(output, "utf8");
        let start = encoded.length - OUTPUT_LIMIT_BYTES;
        while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
          start += 1;
        }
        output = encoded.subarray(start).toString("utf8");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const stopForTimeout = (): void => {
      timedOut = true;
      signalTree(child.pid);
    };
    const stopForAbort = (): void => signalTree(child.pid);
    const timer = setTimeout(stopForTimeout, timeoutMs);
    signal?.addEventListener("abort", stopForAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopForAbort);
      rejectRun(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopForAbort);
      resolveRun({ exitCode: code ?? 1, output, outputBytes, timedOut });
    });
    if (signal?.aborted) stopForAbort();
  });
}

/**
 * Runs model-produced code under the same mandatory macOS boundary as the
 * actor. The evaluator receives no broker capability or provider credential.
 */
export class ContainedAiderPolyglotTestExecutor
  implements AiderPolyglotTestExecutor
{
  readonly #brokerOrigin: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #workRoot: string;
  readonly #diagnosticRedactions: readonly string[];
  #diagnostics: BenchmarkTestCommandDiagnostic[] = [];

  constructor(options: ContainedBenchmarkTestExecutorOptions) {
    this.#brokerOrigin = new URL(options.brokerOrigin).origin;
    this.#env = options.env ?? process.env;
    this.#workRoot = resolve(options.workRoot ?? tmpdir());
    this.#diagnosticRedactions = [...(options.diagnosticRedactions ?? [])];
  }

  diagnostics(): readonly BenchmarkTestCommandDiagnostic[] {
    return this.#diagnostics.map((diagnostic) => ({
      ...diagnostic,
      command: [...diagnostic.command],
      output: { ...diagnostic.output },
    }));
  }

  async preflight(
    plan: AiderPolyglotTestPlan,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
    const runtime = await mkdtemp(
      join(this.#workRoot, "organum-code-benchmark-preflight-"),
    );
    const home = join(runtime, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const environment = buildContainedBenchmarkTestEnvironment(this.#env, home);
    const pathRedactions = await diagnosticPathRedactions(plan.workspace, runtime);
    const deadline = Date.now() + plan.timeoutMs;
    try {
      const seen = new Set<string>();
      for (const command of plan.commands) {
        const check = preflightCommand(command);
        const key = JSON.stringify(check);
        if (seen.has(key)) continue;
        seen.add(key);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error("benchmark oracle preflight timed out");
        }
        const prepared = await prepareBackendContainment({
          binary: check[0],
          args: check.slice(1),
          env: environment,
          workspace: plan.workspace,
          runtimeDirectory: runtime,
          brokerOrigin: this.#brokerOrigin,
          immutablePaths: plan.immutablePaths,
          allowPty: false,
        });
        let result: Awaited<ReturnType<typeof runContainedCommand>>;
        try {
          result = await runContainedCommand(prepared, remaining, signal);
        } finally {
          await prepared.gate.close().catch(() => undefined);
        }
        if (signal?.aborted) {
          throw new DOMException("benchmark preflight aborted", "AbortError");
        }
        if (result.timedOut || result.exitCode !== 0) {
          const diagnostic = boundedDiagnosticText(result.output, {
            maxBytes: DIAGNOSTIC_LIMIT_BYTES,
            retain: "tail",
            exactRedactions: this.#diagnosticRedactions,
            pathRedactions,
          });
          throw new Error(
            `benchmark oracle preflight failed for ${JSON.stringify(check.slice(0, 3))} (exit ${result.exitCode}): ${diagnostic.text.trim()}`,
          );
        }
      }
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  }

  async execute(
    plan: AiderPolyglotTestPlan,
    signal?: AbortSignal,
  ): Promise<AiderPolyglotTestResult> {
    this.#diagnostics = [];
    await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
    const runtime = await mkdtemp(
      join(this.#workRoot, "organum-code-benchmark-test-"),
    );
    const home = join(runtime, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const environment = buildContainedBenchmarkTestEnvironment(this.#env, home);
    const pathRedactions = await diagnosticPathRedactions(plan.workspace, runtime);
    const deadline = Date.now() + plan.timeoutMs;
    let testsPassed = 0;
    let testsFailed = 0;

    try {
      for (const command of plan.commands) {
        if (command.length === 0 || command[0].trim().length === 0) {
          throw new TypeError("benchmark test command must be nonempty");
        }
        if (signal?.aborted) {
          throw new DOMException("benchmark test aborted", "AbortError");
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { passed: false, testsPassed, testsFailed: testsFailed + 1 };
        }
        const prepared = await prepareBackendContainment({
          binary: command[0],
          args: command.slice(1),
          env: environment,
          workspace: plan.workspace,
          runtimeDirectory: runtime,
          brokerOrigin: this.#brokerOrigin,
          immutablePaths: plan.immutablePaths,
          allowPty: false,
        });
        let result: Awaited<ReturnType<typeof runContainedCommand>>;
        try {
          result = await runContainedCommand(prepared, remaining, signal);
        } finally {
          await prepared.gate.close().catch(() => undefined);
        }
        if (signal?.aborted) {
          throw new DOMException("benchmark test aborted", "AbortError");
        }
        this.#diagnostics.push({
          command: [...command],
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          outputBytes: result.outputBytes,
          output: boundedDiagnosticText(result.output, {
            maxBytes: DIAGNOSTIC_LIMIT_BYTES,
            retain: "tail",
            exactRedactions: this.#diagnosticRedactions,
            pathRedactions,
          }),
        });
        const counts = benchmarkTestCounts(result.output, result.exitCode);
        testsPassed += counts.passed;
        testsFailed += counts.failed;
        if (result.timedOut || result.exitCode !== 0) {
          return { passed: false, testsPassed, testsFailed };
        }
      }
      return { passed: true, testsPassed, testsFailed };
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  }
}
