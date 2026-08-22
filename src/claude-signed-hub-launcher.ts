import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

import { PUBLICATION_MAX_BODY_BYTES } from "./coordination-publish.js";
import {
  acquireNativeRuntimeOwner,
  validateNativePersistentRuntimeDirectory,
} from "./native-interactive-lifecycle.js";
import { ConfigurationError } from "./provider-profile.js";

const CLAUDE_OUTPUT_MAX_BYTES = 256 * 1024;
const CLAUDE_PROMPT_MAX_BYTES = 1024 * 1024;
const CLAUDE_IDENTIFIER_MAX_BYTES = 256;
const CLAUDE_MODEL_MAX_BYTES = 256;
const CLAUDE_MAX_TURNS = 8;
const CLAUDE_MODEL_PATTERN = /^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,248}$/;

const CLAUDE_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

export interface ClaudeSignedHubInstallation {
  binary: string;
  version: string;
  nativeSubscription: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export interface ClaudeSignedHubResult {
  exitCode: number;
  successful: boolean;
  output: string | null;
  sessionID: string | null;
  modelID: string | null;
  vendorDurationMs: number | null;
  turns: number | null;
  totalCostUsd: number | null;
  failure:
    | "none"
    | "process_exit"
    | "output_too_large"
    | "malformed_result"
    | "vendor_error"
    | "model_mismatch"
    | "permission_denial"
    | "stdin_error";
}

export interface LaunchClaudeSignedHubOptions {
  beforeSpawn?: () => Promise<void>;
  runtimeDirectory?: string;
}

function boundedString(value: unknown, maximumBytes: number): string | null {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return null;
  }
  return value;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may already have exited.
  }
}

export function resolveClaudeSignedHubBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_CLAUDE_BIN?.trim() || "claude";
}

export function claudeSignedHubModelID(env: NodeJS.ProcessEnv): string {
  const model = env.ORGANUM_CODE_CLAUDE_SIGNED_HUB_MODEL?.trim();
  if (
    model === undefined ||
    !CLAUDE_MODEL_PATTERN.test(model) ||
    Buffer.byteLength(model, "utf8") > CLAUDE_MODEL_MAX_BYTES
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_CLAUDE_SIGNED_HUB_MODEL must be an explicit full Claude model ID beginning with claude-",
    );
  }
  return model;
}

/**
 * Native subscription authority stays inside Claude Code. Host HOME is kept
 * solely so Claude may resolve its own OAuth/keychain login. API keys, cloud
 * credentials, SCM credentials, Hub paths, and Organum signing material are
 * excluded by construction.
 */
export function buildClaudeSignedHubChildEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };
  for (const name of CLAUDE_ENVIRONMENT_ALLOWLIST) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  if (!result.PATH?.trim() || !result.HOME?.trim()) {
    throw new ConfigurationError(
      "Claude native subscription requires bounded PATH and HOME values",
    );
  }
  return result;
}

export function inspectClaudeSignedHub(
  env: NodeJS.ProcessEnv,
): ClaudeSignedHubInstallation {
  const binary = resolveClaudeSignedHubBinary(env);
  const childEnvironment = buildClaudeSignedHubChildEnvironment(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: childEnvironment,
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Claude Code binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Claude Code version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  const auth = spawnSync(binary, ["auth", "status"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: childEnvironment,
  });
  if (auth.error !== undefined) {
    throw new Error(
      `Unable to inspect Claude Code native subscription: ${auth.error.message}`,
    );
  }
  const status = parseClaudeSignedHubAuthStatus(
    Buffer.from(auth.stdout),
    auth.status ?? 1,
  );
  return {
    binary,
    version: version.split(/\r?\n/, 1)[0],
    ...status,
  };
}

export function parseClaudeSignedHubAuthStatus(
  bytes: Uint8Array,
  exitCode: number,
): Pick<
  ClaudeSignedHubInstallation,
  "nativeSubscription" | "authMethod" | "subscriptionType"
> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ConfigurationError(
      "Claude auth status did not return bounded JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError("Claude auth status must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.loggedIn !== "boolean" ||
    typeof record.authMethod !== "string" ||
    typeof record.apiProvider !== "string" ||
    (
      record.subscriptionType !== undefined &&
      record.subscriptionType !== null &&
      typeof record.subscriptionType !== "string"
    )
  ) {
    throw new ConfigurationError("Claude auth status JSON is malformed");
  }
  if (record.loggedIn && exitCode !== 0) {
    throw new ConfigurationError(
      "Claude auth status contradicted its process exit code",
    );
  }
  const subscriptionType = typeof record.subscriptionType === "string"
    ? boundedString(record.subscriptionType, CLAUDE_IDENTIFIER_MAX_BYTES)
    : null;
  const authMethod = boundedString(
    record.authMethod,
    CLAUDE_IDENTIFIER_MAX_BYTES,
  );
  if (authMethod === null || (record.subscriptionType !== undefined && subscriptionType === null)) {
    throw new ConfigurationError("Claude auth status identifiers are invalid");
  }
  return {
    nativeSubscription:
      exitCode === 0 &&
      record.loggedIn &&
      authMethod === "claude.ai" &&
      record.apiProvider === "firstParty" &&
      subscriptionType !== null,
    authMethod,
    subscriptionType,
  };
}

export function buildClaudeSignedHubArgs(modelID: string): string[] {
  if (
    !CLAUDE_MODEL_PATTERN.test(modelID) ||
    Buffer.byteLength(modelID, "utf8") > CLAUDE_MODEL_MAX_BYTES
  ) {
    throw new ConfigurationError("Claude signed-Hub model ID is invalid");
  }
  return [
    "--print",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--model",
    modelID,
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--tools",
    "Read,Glob,Grep",
    "--permission-mode",
    "dontAsk",
    "--prompt-suggestions",
    "false",
    "--max-turns",
    String(CLAUDE_MAX_TURNS),
  ];
}

export function parseClaudeSignedHubResult(
  bytes: Uint8Array,
  exitCode: number,
  requestedModelID: string,
  outputTooLarge = false,
  stdinError = false,
): ClaudeSignedHubResult {
  const failed = (
    failure: ClaudeSignedHubResult["failure"],
  ): ClaudeSignedHubResult => ({
    exitCode,
    successful: false,
    output: null,
    sessionID: null,
    modelID: null,
    vendorDurationMs: null,
    turns: null,
    totalCostUsd: null,
    failure,
  });
  if (stdinError) return failed("stdin_error");
  if (outputTooLarge) return failed("output_too_large");
  if (exitCode !== 0) return failed("process_exit");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return failed("malformed_result");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failed("malformed_result");
  }
  const record = value as Record<string, unknown>;
  if (
    record.type !== "result" ||
    record.subtype !== "success" ||
    record.is_error !== false
  ) {
    return failed("vendor_error");
  }
  if (
    !Array.isArray(record.permission_denials) ||
    record.permission_denials.length !== 0
  ) {
    return failed("permission_denial");
  }
  if (
    typeof record.modelUsage !== "object" ||
    record.modelUsage === null ||
    Array.isArray(record.modelUsage)
  ) {
    return failed("malformed_result");
  }
  const observedModels = Object.keys(record.modelUsage);
  if (
    observedModels.length !== 1 ||
    observedModels[0] !== requestedModelID
  ) {
    return failed("model_mismatch");
  }

  const output = boundedString(record.result, PUBLICATION_MAX_BODY_BYTES);
  const sessionID = boundedString(
    record.session_id,
    CLAUDE_IDENTIFIER_MAX_BYTES,
  );
  const duration = record.duration_ms;
  const turns = record.num_turns;
  const cost = record.total_cost_usd;
  if (
    output === null ||
    output.trim().length === 0 ||
    sessionID === null ||
    sessionID.trim().length === 0 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isSafeInteger(turns) ||
    Number(turns) < 1 ||
    Number(turns) > CLAUDE_MAX_TURNS ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    return failed("malformed_result");
  }
  return {
    exitCode,
    successful: true,
    output,
    sessionID,
    modelID: requestedModelID,
    vendorDurationMs: duration,
    turns: Number(turns),
    totalCostUsd: cost,
    failure: "none",
  };
}

export async function launchClaudeSignedHub(
  prompt: string,
  modelID: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: LaunchClaudeSignedHubOptions = {},
): Promise<ClaudeSignedHubResult> {
  if (
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") > CLAUDE_PROMPT_MAX_BYTES
  ) {
    throw new ConfigurationError(
      "Claude Signed Hub prompt must be nonempty and at most 1 MiB",
    );
  }
  const childEnvironment = buildClaudeSignedHubChildEnvironment(env);
  const binary = resolveClaudeSignedHubBinary(env);
  const args = buildClaudeSignedHubArgs(modelID);
  const runtime = options.runtimeDirectory === undefined
    ? null
    : await validateNativePersistentRuntimeDirectory(
        options.runtimeDirectory,
        cwd,
        "Claude Signed Hub",
      );
  const owner = runtime === null
    ? null
    : await acquireNativeRuntimeOwner(runtime, "claude");
  try {
    await options.beforeSpawn?.();
    return await new Promise<ClaudeSignedHubResult>((resolveRun, rejectRun) => {
      const child = spawn(binary, args, {
        cwd,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let outputTooLarge = false;
      let stdinError = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > CLAUDE_OUTPUT_MAX_BYTES) {
          outputTooLarge = true;
          signalTree(child.pid, "SIGTERM");
          return;
        }
        stdout.push(chunk);
      });
      // Failure diagnostics may contain account or vendor details. The
      // signed-Hub surface retains only a bounded typed failure class.
      child.stderr.resume();
      child.stdin.once("error", () => {
        stdinError = true;
      });
      child.stdin.end(prompt, "utf8");

      const forwardInterrupt = (): void => signalTree(child.pid, "SIGINT");
      const forwardTermination = (): void => signalTree(child.pid, "SIGTERM");
      const cleanup = (): void => {
        process.off("SIGINT", forwardInterrupt);
        process.off("SIGTERM", forwardTermination);
      };
      process.once("SIGINT", forwardInterrupt);
      process.once("SIGTERM", forwardTermination);
      child.once("error", (error) => {
        cleanup();
        rejectRun(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        resolveRun(
          parseClaudeSignedHubResult(
            Buffer.concat(stdout),
            code ?? signalExitCode(signal),
            modelID,
            outputTooLarge,
            stdinError,
          ),
        );
      });
    });
  } finally {
    await owner?.close().catch(() => undefined);
  }
}
