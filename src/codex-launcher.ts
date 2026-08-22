import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildBackendProbeEnvironment } from "./backend-catalog.js";
import {
  canonicalExistingPath,
  prepareBackendContainment,
  resolveExecutablePath,
  type PreparedBackendContainment,
} from "./containment.js";
import { BROKER_TOKEN_ENV } from "./inference-broker.js";
import {
  validateOrganumMcpHttpServer,
  type OrganumMcpHttpServer,
} from "./organum-mcp.js";
import {
  acquireNativeRuntimeOwner,
  validateNativePersistentRuntimeDirectory,
  type NativeRuntimeOwner,
} from "./native-interactive-lifecycle.js";
import type { ProviderProfile } from "./provider-profile.js";

const CODEX_PROVIDER_ID = "organum_code";
export const CODEX_MCP_TOKEN_ENV = "ORGANUM_CODE_CODEX_MCP_TOKEN";

const SAFE_ENVIRONMENT_NAMES = [
  "CI",
  "COLORTERM",
  "ComSpec",
  "FORCE_COLOR",
  "LANG",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
] as const;

const DENIED_ARGUMENTS = new Set([
  "--add-dir",
  "--ask-for-approval",
  "-a",
  "--cd",
  "-C",
  "--config",
  "-c",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--disable",
  "--enable",
  "--ignore-rules",
  "--ignore-user-config",
  "--local-provider",
  "--model",
  "-m",
  "--oss",
  "--profile",
  "-p",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox",
  "--search",
  "-s",
]);

const DENIED_SUBCOMMANDS = new Set([
  "app",
  "app-server",
  "apply",
  "a",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "e",
  "exec-server",
  "features",
  "fork",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "remote-control",
  "resume",
  "review",
  "sandbox",
  "unarchive",
  "update",
]);

export interface CodexInstallation {
  binary: string;
  version: string;
}

export interface PreparedCodexLaunch {
  containment: PreparedBackendContainment;
  diagnosticRuntimeDirectory: string;
  persistentRuntime: boolean;
  close(): Promise<void>;
}

export interface PrepareCodexLaunchOptions {
  mcpServer?: OrganumMcpHttpServer;
  runtimeDirectory?: string;
  beforeSpawn?: () => Promise<void>;
  stdinInput?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function hasArgument(args: readonly string[], name: string): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === name) return true;
    if (name.startsWith("--") && argument.startsWith(`${name}=`)) return true;
    if (
      name.startsWith("-") &&
      !name.startsWith("--") &&
      argument.startsWith(name)
    ) {
      return true;
    }
  }
  return false;
}

function forwardedCodexArgs(args: readonly string[]): string[] {
  const forwarded = [...args];
  for (const name of DENIED_ARGUMENTS) {
    if (hasArgument(forwarded, name)) {
      throw new Error(
        `${name} is fixed by the brokered Codex adapter`,
      );
    }
  }
  const first = forwarded[0];
  const optionBoundary = forwarded.indexOf("--");
  const parsedArguments = forwarded.slice(
    0,
    optionBoundary < 0 ? undefined : optionBoundary,
  );
  const deniedSubcommand = parsedArguments.find((argument) =>
    DENIED_SUBCOMMANDS.has(argument)
  );
  if (deniedSubcommand !== undefined) {
    throw new Error(
      `${deniedSubcommand} is not an admitted Codex agent surface`,
    );
  }
  if (first !== "exec" && parsedArguments.includes("exec")) {
    throw new Error("exec must be the first Codex argument");
  }
  return forwarded;
}

export function resolveCodexBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_CODEX_BIN?.trim() || "codex";
}

export function inspectCodex(env: NodeJS.ProcessEnv): CodexInstallation {
  const binary = resolveCodexBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Codex binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Codex version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: version.split(/\r?\n/, 1)[0] };
}

export function buildCodexArgs(
  args: readonly string[],
  modelID: string,
): string[] {
  if (modelID.trim().length === 0) {
    throw new Error("Codex model binding is required");
  }
  const forwarded = forwardedCodexArgs(args);
  const nonInteractive = forwarded[0] === "exec";
  const command = nonInteractive && !forwarded.includes("--ephemeral")
    ? ["exec", "--ephemeral", ...forwarded.slice(1)]
    : forwarded;
  return [
    "--strict-config",
    "-c",
    `model_provider=${tomlString(CODEX_PROVIDER_ID)}`,
    "-c",
    `model=${tomlString(modelID)}`,
    "-c",
    `approval_policy=${tomlString(nonInteractive ? "never" : "on-request")}`,
    "-c",
    // The common outer containment owns filesystem and network isolation.
    // A second macOS Seatbelt layer cannot be nested reliably.
    `sandbox_mode=${tomlString("danger-full-access")}`,
    ...command,
  ];
}

export function buildCodexConfig(
  profile: ProviderProfile,
  childEnvironment: NodeJS.ProcessEnv,
  mcpServer?: OrganumMcpHttpServer,
): string {
  if (profile.protocol !== "responses") {
    throw new Error("Codex currently requires a Responses provider profile");
  }
  if (profile.apiKeyEnv !== BROKER_TOKEN_ENV) {
    throw new Error("Codex adapter accepts a broker capability only");
  }
  const capability = childEnvironment[BROKER_TOKEN_ENV]?.trim();
  if (!capability) throw new Error("Codex broker capability is missing");
  const path = childEnvironment.PATH?.trim();
  const home = childEnvironment.HOME?.trim();
  if (!path || !home) {
    throw new Error("Codex isolated PATH and HOME are required");
  }
  const admittedMcp = mcpServer === undefined
    ? undefined
    : validateOrganumMcpHttpServer(mcpServer);
  const lines = [
    `model = ${tomlString(profile.modelID)}`,
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    'approval_policy = "on-request"',
    'sandbox_mode = "danger-full-access"',
    "analytics.enabled = false",
    "feedback.enabled = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    "",
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "Organum Code Broker"',
    `base_url = ${tomlString(profile.baseURL)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(BROKER_TOKEN_ENV)}`,
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "supports_websockets = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    "",
    "[shell_environment_policy.set]",
    `PATH = ${tomlString(path)}`,
    `HOME = ${tomlString(home)}`,
    ...(childEnvironment.LANG
      ? [`LANG = ${tomlString(childEnvironment.LANG)}`]
      : []),
  ];
  if (admittedMcp !== undefined) {
    if (!childEnvironment[CODEX_MCP_TOKEN_ENV]?.trim()) {
      throw new Error("Codex Organum MCP capability is missing");
    }
    lines.push(
      "",
      `[mcp_servers.${admittedMcp.name}]`,
      `url = ${tomlString(admittedMcp.url)}`,
      `bearer_token_env_var = ${tomlString(CODEX_MCP_TOKEN_ENV)}`,
      "required = true",
      'enabled_tools = ["organum_publish", "organum_handoff"]',
      'default_tools_approval_mode = "approve"',
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildCodexChildEnvironment(
  env: NodeJS.ProcessEnv,
  configDirectory: string,
  profile: ProviderProfile,
  mcpServer?: OrganumMcpHttpServer,
): NodeJS.ProcessEnv {
  if (profile.protocol !== "responses") {
    throw new Error("Codex currently requires a Responses provider profile");
  }
  if (profile.apiKeyEnv !== BROKER_TOKEN_ENV) {
    throw new Error("Codex adapter accepts a broker capability only");
  }
  const capability = env[BROKER_TOKEN_ENV]?.trim();
  if (!capability) throw new Error("Codex broker capability is missing");
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  const isolatedHome = join(configDirectory, "home");
  const codexHome = join(configDirectory, "codex-home");
  const admittedMcp = mcpServer === undefined
    ? undefined
    : validateOrganumMcpHttpServer(mcpServer);
  return {
    ...result,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    [BROKER_TOKEN_ENV]: capability,
    ...(admittedMcp === undefined
      ? {}
      : {
          [CODEX_MCP_TOKEN_ENV]: admittedMcp.headers[0].value.slice(
            "Bearer ".length,
          ),
        }),
  };
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

async function codexReadablePaths(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string[]> {
  const paths = new Set<string>([dirname(executablePath)]);
  const prefix = await open(executablePath, "r")
    .then(async (handle) => {
      try {
        const buffer = Buffer.alloc(64);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    })
    .catch(() => "");
  if (prefix.startsWith("#!/usr/bin/env node")) {
    const nodePath = resolveExecutablePath("node", env, cwd);
    paths.add(nodePath);
    const packageBin = dirname(executablePath);
    const packageRoot = dirname(packageBin);
    if (packageRoot.endsWith(`${join("@openai", "codex")}`)) {
      paths.add(dirname(packageRoot));
    }
  }
  return [...paths];
}

export async function launchCodex(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: PrepareCodexLaunchOptions = {},
): Promise<number> {
  const launch = await prepareCodexLaunch(args, profile, env, cwd, options);
  try {
    const prepared = launch.containment;
    await options.beforeSpawn?.();
    return await new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
        cwd: prepared.cwd,
        env: prepared.spawn.env,
        stdio: options.stdinInput === undefined
          ? "inherit"
          : ["pipe", "inherit", "inherit"],
        detached: process.platform !== "win32",
      });
      let stdinError: Error | null = null;
      if (options.stdinInput !== undefined) {
        if (child.stdin === null) {
          rejectExit(new Error("Codex stdin prompt pipe is unavailable"));
          return;
        }
        child.stdin.once("error", (error) => {
          stdinError = error;
        });
        child.stdin.end(options.stdinInput, "utf8");
      }
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
        rejectExit(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        if (stdinError !== null) {
          rejectExit(stdinError);
          return;
        }
        resolveExit(code ?? signalExitCode(signal));
      });
    });
  } finally {
    await launch.close();
  }
}

export async function prepareCodexLaunch(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: PrepareCodexLaunchOptions = {},
): Promise<PreparedCodexLaunch> {
  const persistentRuntime = options.runtimeDirectory !== undefined;
  const createdConfigDirectory = persistentRuntime
    ? undefined
    : await mkdtemp(join(tmpdir(), "organum-code-codex-"));
  const configDirectory = persistentRuntime
    ? await validateNativePersistentRuntimeDirectory(
        options.runtimeDirectory!,
        cwd,
        "Codex",
      )
    : canonicalExistingPath(
        createdConfigDirectory!,
        "Codex runtime directory",
      );
  const binary = resolveCodexBinary(env);
  let containment: PreparedBackendContainment | undefined;
  let owner: NativeRuntimeOwner | undefined;
  let closed = false;
  const isolatedHome = join(configDirectory, "home");
  const codexHome = join(configDirectory, "codex-home");
  const configPath = join(codexHome, "config.toml");
  try {
    if (persistentRuntime) {
      owner = await acquireNativeRuntimeOwner(configDirectory, "codex");
    }
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await rm(configPath, { force: true });
    const childEnvironment = buildCodexChildEnvironment(
      env,
      configDirectory,
      profile,
      options.mcpServer,
    );
    await writeFile(
      configPath,
      buildCodexConfig(profile, childEnvironment, options.mcpServer),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const executablePath = resolveExecutablePath(binary, childEnvironment, cwd);
    const prepared = await prepareBackendContainment({
      binary,
      args: buildCodexArgs(args, profile.modelID),
      env: childEnvironment,
      workspace: cwd,
      runtimeDirectory: configDirectory,
      brokerOrigin: new URL(profile.baseURL).origin,
      readablePaths: await codexReadablePaths(
        executablePath,
        childEnvironment,
        cwd,
      ),
      immutablePaths: [
        configPath,
        ...(owner === undefined ? [] : [owner.lockPath]),
      ],
      allowPty: true,
    });
    containment = prepared;
    return {
      containment: prepared,
      diagnosticRuntimeDirectory: configDirectory,
      persistentRuntime,
      async close() {
        if (closed) return;
        closed = true;
        await prepared.gate.close().catch(() => undefined);
        await rm(configPath, { force: true }).catch(() => undefined);
        await owner?.close().catch(() => undefined);
        owner = undefined;
        if (createdConfigDirectory !== undefined) {
          await rm(createdConfigDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await containment?.gate.close().catch(() => undefined);
    await rm(configPath, { force: true }).catch(() => undefined);
    await owner?.close().catch(() => undefined);
    if (createdConfigDirectory !== undefined) {
      await rm(createdConfigDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
