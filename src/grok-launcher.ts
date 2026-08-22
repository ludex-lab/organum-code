import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { Writable } from "node:stream";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, homedir, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { quote } from "shell-quote";

import { buildBackendProbeEnvironment } from "./backend-catalog.js";
import {
  canonicalExistingPath,
  prepareBackendContainment,
  type PreparedBackendContainment,
} from "./containment.js";
import { BROKER_TOKEN_ENV } from "./inference-broker.js";
import type { JsonObject } from "./inference-broker.js";
import {
  MTI_REFLEX_SERVER_NAME,
  type ProjectedMcpHttpServer,
  validateProjectedMcpHttpServer,
} from "./mti-reflex-mcp.js";
import {
  enforceGrokRuntimeHealth,
  inspectGrokRuntimeHealth,
  type GrokRuntimeHealthObserver,
  type GrokRuntimeHealthReport,
} from "./grok-runtime-health.js";
import type { ProviderProfile } from "./provider-profile.js";
import type {
  ProjectCommand,
  ProjectEnvironmentPacket,
} from "./project-contract.js";
import {
  GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV,
  GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV,
  GROK_NATIVE_TOOL_WRAPPER_TURN_ENV,
} from "./grok-native-tool-supervisor.js";
import type { GrokNativeToolCapabilityTransport } from "./grok-native-tool-response-projection.js";
import { grokNativeToolWrapperProgram } from "./grok-native-tool-wrapper-program.js";
import {
  assertNativeToolOperationalEnvironment,
  GROK_S16_OPERATIONAL_ADMISSION,
} from "./native-tool-operational-admission.js";

const GROK_MODEL_ALIAS = "organum-code";
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

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/**
 * Solar/OpenAI-compatible streams may repeat a tool-call function with an
 * empty name while sending later argument fragments. Grok Build 0.2.106
 * overwrites the previously accumulated name with that empty string. Omitting
 * only the empty delta preserves the protocol meaning and lets Grok retain the
 * first nonempty name.
 */
export function normalizeGrokChatCompletionsSseEvent(
  event: Readonly<JsonObject>,
): JsonObject {
  const choices = Array.isArray(event.choices) ? event.choices : null;
  if (choices === null) return { ...event };
  let changed = false;
  const nextChoices = choices.map((choice) => {
    const choiceObject = object(choice);
    const delta = object(choiceObject?.delta);
    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : null;
    if (choiceObject === null || delta === null || calls === null) return choice;
    const nextCalls = calls.map((call) => {
      const callObject = object(call);
      const fn = object(callObject?.function);
      if (callObject === null || fn === null || fn.name !== "") return call;
      changed = true;
      const { name: _emptyName, ...nextFunction } = fn;
      return { ...callObject, function: nextFunction };
    });
    return { ...choiceObject, delta: { ...delta, tool_calls: nextCalls } };
  });
  return changed ? { ...event, choices: nextChoices } : { ...event };
}

export interface GrokBuildInstallation {
  binary: string;
  version: string;
}

export interface PreparedGrokBuildLaunch {
  containment: PreparedBackendContainment;
  runtimeDirectory: string;
  persistentRuntime: boolean;
  initialRuntimeHealth: GrokRuntimeHealthReport | null;
  close(): Promise<void>;
}

export interface GrokLaunchOptions {
  /**
   * Actor-owned state root outside the workspace. When omitted, the launch is
   * ephemeral and cannot resume after process exit.
   */
  runtimeDirectory?: string;
  mcpServer?: ProjectedMcpHttpServer;
  /**
   * Supervisor-issued UUID for a new native conversation. Resume flags in
   * args still take precedence and suppress this projection.
   */
  sessionID?: string;
  onRuntimeHealth?: GrokRuntimeHealthObserver;
  nativeToolProjection?: GrokNativeToolProjectionLaunch;
  signal?: AbortSignal;
}

export interface GrokNativeToolProjectionLaunch {
  endpoint: string;
  sessionID: string;
  turnID: string;
  transport: GrokNativeToolCapabilityTransport;
  bindWrapperCommand(command: string): void;
}

export interface GrokAcpLaunchOptions extends GrokLaunchOptions {
  /**
   * Supervisor-discovered, non-secret environment required by the declared
   * project command. This is inherited by contained native tool processes.
   */
  toolEnvironment?: Readonly<Record<string, string>>;
  readablePaths?: readonly string[];
}

export interface GrokAcpToolAccess {
  environment: Readonly<Record<string, string>>;
  readablePaths: readonly string[];
}

export interface GrokPythonUserSite {
  base: string;
  sitePackages: string;
}

export function discoverGrokPythonUserSite(
  command: ProjectCommand | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GrokPythonUserSite | null {
  if (
    process.platform !== "darwin" ||
    command === undefined ||
    !/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(command.executable) ||
    command.resolved_executable === undefined
  ) {
    return null;
  }
  const result = spawnSync(
    command.resolved_executable,
    [
      "-I",
      "-S",
      "-c",
      "import site; print(site.getuserbase()); print(site.getusersitepackages())",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        HOME: homedir(),
        LANG: env.LANG ?? "C.UTF-8",
        PATH: env.PATH ?? "/usr/bin:/bin",
        PYTHONNOUSERSITE: "1",
      },
    },
  );
  const candidates =
    result.status === 0
      ? result.stdout.trim().split(/\r?\n/)
      : [];
  if (
    candidates.length !== 2 ||
    candidates.some((candidate) =>
      !isAbsolute(candidate) ||
      candidate.includes("\0") ||
      Buffer.byteLength(candidate, "utf8") > 4_096
    )
  ) {
    return null;
  }
  try {
    const canonicalBase = realpathSync.native(candidates[0]);
    const canonicalSitePackages = realpathSync.native(candidates[1]);
    const allowedRoot = realpathSync.native(
      join(homedir(), "Library", "Python"),
    );
    return (
        inside(allowedRoot, canonicalBase) &&
        inside(canonicalBase, canonicalSitePackages)
      )
      ? {
        base: canonicalBase,
        sitePackages: canonicalSitePackages,
      }
      : null;
  } catch {
    return null;
  }
}

export function buildGrokAcpToolAccess(
  project: ProjectEnvironmentPacket,
  pythonUserSite: GrokPythonUserSite | null,
): GrokAcpToolAccess {
  const command = project.commands[0];
  const environment: Record<string, string> = { ...(command?.env ?? {}) };
  const readablePaths: string[] = [];
  if (
    pythonUserSite !== null &&
    command !== undefined &&
    /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(command.executable)
  ) {
    environment.PYTHONUSERBASE = pythonUserSite.base;
    readablePaths.push(pythonUserSite.sitePackages);
  }
  return { environment, readablePaths };
}

export function resolveGrokBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_GROK_BIN?.trim() || "grok";
}

export function inspectGrokBuild(env: NodeJS.ProcessEnv): GrokBuildInstallation {
  const binary = resolveGrokBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Grok Build binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Grok Build version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: version.split(/\r?\n/, 1)[0] };
}

export const GROK_S13_PINNED_VERSION =
  GROK_S16_OPERATIONAL_ADMISSION.installedVersion;
export const GROK_S13_PINNED_MACOS =
  GROK_S16_OPERATIONAL_ADMISSION.macOSVersion;
export const GROK_S16_PINNED_DARWIN =
  GROK_S16_OPERATIONAL_ADMISSION.darwinVersion;

export function assertGrokS13PinnedEnvironment(
  installation: GrokBuildInstallation,
  platform = process.platform,
  macOSVersion = platform === "darwin"
    ? spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim()
    : "",
  darwinVersion = release(),
): void {
  assertNativeToolOperationalEnvironment(
    GROK_S16_OPERATIONAL_ADMISSION,
    {
      installedVersion: installation.version,
      platform,
      macOSVersion,
      darwinVersion,
    },
  );
}

function tomlString(value: string, context: string): string {
  if (value.includes("\0")) throw new Error(`${context} must not contain NUL`);
  return JSON.stringify(value);
}

export function buildGrokConfig(
  profile: ProviderProfile,
  mcpServer?: ProjectedMcpHttpServer,
  nativeToolWrapperCommand?: string,
): string {
  const backend =
    profile.protocol === "responses" ? "responses" : "chat_completions";
  const modelAlias = profile.modelID;
  const admittedMcp =
    mcpServer === undefined
      ? undefined
      : validateProjectedMcpHttpServer(mcpServer);
  return [
    "[models]",
    `default = ${tomlString(modelAlias, "Grok model alias")}`,
    `session_summary = ${tomlString(modelAlias, "Grok session summary model alias")}`,
    "",
    `[model.${tomlString(modelAlias, "Grok model alias")}]`,
    `model = ${tomlString(profile.modelID, "Provider model ID")}`,
    `base_url = ${tomlString(profile.baseURL, "Provider base URL")}`,
    `name = ${tomlString(profile.modelName, "Provider model name")}`,
    `env_key = ${tomlString(profile.apiKeyEnv, "Provider key environment")}`,
    `api_backend = ${tomlString(backend, "Grok API backend")}`,
    "supports_backend_search = false",
    "",
    ...(nativeToolWrapperCommand === undefined
      ? []
      : [
          "[permission]",
          `rules = [{ action = "allow", tool = "bash", pattern = ${
            tomlString(
              nativeToolWrapperCommand,
              "Grok native tool wrapper command",
            )
          } }]`,
          "",
        ]),
    "[cli]",
    "auto_update = false",
    "",
    "[compat.cursor]",
    "skills = false",
    "rules = false",
    "agents = false",
    "mcps = false",
    "hooks = false",
    "sessions = false",
    "",
    "[compat.claude]",
    "skills = false",
    "rules = false",
    "agents = false",
    "mcps = false",
    "hooks = false",
    "sessions = false",
    "",
    "[compat.codex]",
    "sessions = false",
    "",
    ...(admittedMcp === undefined
      ? []
      : [
          `[mcp_servers.${admittedMcp.name}]`,
          `url = ${tomlString(admittedMcp.url, "Organum MCP URL")}`,
          "enabled = true",
          "",
          `[mcp_servers.${admittedMcp.name}.headers]`,
          ...admittedMcp.headers.map(({ name, value }) =>
            `${name} = ${tomlString(value, "Organum MCP header")}`
          ),
          "",
        ]),
  ].join("\n");
}

function hasArgument(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function hasShortArgument(args: readonly string[], name: string): boolean {
  return args.some(
    (arg) => arg === name || arg.startsWith(`${name}=`) || arg.startsWith(name),
  );
}

export function buildGrokArgs(
  args: readonly string[],
  sessionID: string = randomUUID(),
  modelAlias: string = GROK_MODEL_ALIAS,
): string[] {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  if (hasArgument(forwarded, "--model") || hasShortArgument(forwarded, "-m")) {
    throw new Error("Grok model selection is fixed by the broker capability");
  }
  if (hasArgument(forwarded, "--system-prompt-override")) {
    throw new Error(
      "--system-prompt-override is disabled until the Grok coordination contract is admitted",
    );
  }
  const resumes =
    hasArgument(forwarded, "--resume") ||
    hasArgument(forwarded, "--continue") ||
    hasArgument(forwarded, "--session-id") ||
    hasShortArgument(forwarded, "-r") ||
    hasShortArgument(forwarded, "-c") ||
    hasShortArgument(forwarded, "-s");
  return [
    "--no-auto-update",
    "--model",
    modelAlias,
    ...(resumes ? [] : ["--session-id", sessionID]),
    ...forwarded,
  ];
}

export function buildGrokMtiReflexArgs(
  args: readonly string[],
  sessionID: string = randomUUID(),
  modelAlias: string = GROK_MODEL_ALIAS,
): string[] {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  for (const flag of [
    "--tools",
    "--disallowed-tools",
    "--agents",
    "--agent",
    "--permission-mode",
  ]) {
    if (hasArgument(forwarded, flag)) {
      throw new Error(`${flag} is fixed by the MTI reflex projection`);
    }
  }
  const base = buildGrokArgs(forwarded, sessionID, modelAlias);
  return [
    ...base.slice(0, 6),
    "--tools",
    "",
    "--disable-web-search",
    "--no-plan",
    "--no-subagents",
    "--no-memory",
    "--permission-mode",
    "dontAsk",
    ...base.slice(6),
  ];
}

export function buildGrokNativeToolProjectionArgs(
  args: readonly string[],
  sessionID: string,
  modelAlias: string = GROK_MODEL_ALIAS,
): string[] {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  const singleFlags = forwarded.filter((argument) =>
    argument === "--single" ||
    argument.startsWith("--single=") ||
    argument === "-p" ||
    (/^-p[^-]/.test(argument))
  );
  if (singleFlags.length !== 1) {
    throw new Error(
      "Grok native tool response projection requires exactly one --single/-p turn",
    );
  }
  const forbidden = [
    "--resume",
    "--continue",
    "--session-id",
    "--fork-session",
    "--permission-mode",
    "--allow",
    "--always-approve",
    "--deny",
    "--tools",
    "--disallowed-tools",
    "--sandbox",
    "--cwd",
    "--worktree",
    "--worktree-ref",
    "--restore-code",
  ];
  if (
    forbidden.some((name) => hasArgument(forwarded, name)) ||
    hasShortArgument(forwarded, "-r") ||
    hasShortArgument(forwarded, "-c") ||
    hasShortArgument(forwarded, "-s")
  ) {
    throw new Error(
      "Grok native tool response projection owns session and permission controls",
    );
  }
  const built = buildGrokArgs(forwarded, sessionID, modelAlias);
  return [
    ...built.slice(0, 5),
    "--permission-mode",
    "dontAsk",
    "--no-plan",
    "--no-subagents",
    "--no-memory",
    "--disable-web-search",
    ...built.slice(5),
  ];
}

export function buildGrokAcpArgs(): string[] {
  return ["--no-auto-update", "agent", "stdio"];
}

export function buildGrokChildEnvironment(
  env: NodeJS.ProcessEnv,
  configDirectory: string,
  providerKeyEnvironment: string,
  toolEnvironment: Readonly<Record<string, string>> = {},
  nativeToolProjection?: Pick<
    GrokNativeToolProjectionLaunch,
    "endpoint" | "sessionID" | "turnID"
  >,
): NodeJS.ProcessEnv {
  if (providerKeyEnvironment !== BROKER_TOKEN_ENV) {
    throw new Error("Grok adapter accepts a broker capability only");
  }
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  const capability = env[BROKER_TOKEN_ENV]?.trim();
  if (!capability) throw new Error("Grok broker capability is missing");
  const boundedToolEnvironment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(toolEnvironment)) {
    if (
      (name !== "PYTHONPATH" && name !== "PYTHONUSERBASE") ||
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 1_024
    ) {
      throw new Error(
        "Grok ACP tool environment accepts only bounded PYTHONPATH and PYTHONUSERBASE dependency settings",
      );
    }
    boundedToolEnvironment[name] = value;
  }
  const isolatedHome = join(configDirectory, "home");
  let nativeToolEnvironment: NodeJS.ProcessEnv = {};
  if (nativeToolProjection !== undefined) {
    const endpoint = new URL(nativeToolProjection.endpoint);
    if (
      process.platform !== "darwin" ||
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port.length === 0 ||
      endpoint.pathname !== "/grok-native-tool-wrapper" ||
      endpoint.username.length > 0 ||
      endpoint.password.length > 0 ||
      endpoint.search.length > 0 ||
      endpoint.hash.length > 0 ||
      nativeToolProjection.sessionID.length === 0 ||
      nativeToolProjection.sessionID.length > 512 ||
      nativeToolProjection.sessionID.includes("\0") ||
      nativeToolProjection.turnID.length === 0 ||
      nativeToolProjection.turnID.length > 512 ||
      nativeToolProjection.turnID.includes("\0")
    ) {
      throw new Error("Grok native tool projection environment is invalid");
    }
    nativeToolEnvironment = {
      [GROK_NATIVE_TOOL_WRAPPER_ENDPOINT_ENV]: endpoint.href,
      [GROK_NATIVE_TOOL_WRAPPER_SESSION_ENV]:
        nativeToolProjection.sessionID,
      [GROK_NATIVE_TOOL_WRAPPER_TURN_ENV]: nativeToolProjection.turnID,
    };
  }
  return {
    ...result,
    ...boundedToolEnvironment,
    ...nativeToolEnvironment,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    GROK_HOME: configDirectory,
    PYTHONDONTWRITEBYTECODE: "1",
    [BROKER_TOKEN_ENV]: capability,
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

export async function launchGrokBuild(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: GrokLaunchOptions = {},
): Promise<number> {
  const launch = await prepareGrokBuildLaunch(
    args,
    profile,
    env,
    cwd,
    options,
  );
  try {
    const prepared = launch.containment;
    return await new Promise<number>((resolveExit, rejectExit) => {
      const projection = options.nativeToolProjection;
      const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
        cwd: prepared.cwd,
        env: prepared.spawn.env,
        stdio: projection === undefined
          ? "inherit"
          : [
              "ignore",
              "inherit",
              "inherit",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "pipe",
            ],
        detached: process.platform !== "win32",
      });
      if (projection !== undefined) {
        const writer = child.stdio.at(9);
        if (!(writer instanceof Writable)) {
          signalTree(child.pid, "SIGTERM");
          rejectExit(
            new Error("Grok native tool capability fd 9 is unavailable"),
          );
          return;
        }
        try {
          projection.transport.bind(writer);
        } catch (error) {
          signalTree(child.pid, "SIGTERM");
          rejectExit(error);
          return;
        }
      }
      const forwardInterrupt = (): void => signalTree(child.pid, "SIGINT");
      const forwardTermination = (): void => signalTree(child.pid, "SIGTERM");
      const cleanup = (): void => {
        process.off("SIGINT", forwardInterrupt);
        process.off("SIGTERM", forwardTermination);
        options.signal?.removeEventListener("abort", forwardTermination);
      };
      process.once("SIGINT", forwardInterrupt);
      process.once("SIGTERM", forwardTermination);
      options.signal?.addEventListener("abort", forwardTermination, {
        once: true,
      });
      if (options.signal?.aborted) forwardTermination();
      child.once("error", (error) => {
        cleanup();
        rejectExit(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        resolveExit(code ?? signalExitCode(signal));
      });
    });
  } finally {
    options.nativeToolProjection?.transport.close();
    await launch.close();
  }
}

export async function prepareGrokBuildLaunch(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: GrokLaunchOptions = {},
): Promise<PreparedGrokBuildLaunch> {
  const projection = options.nativeToolProjection;
  if (projection !== undefined) {
    assertGrokS13PinnedEnvironment(inspectGrokBuild(env));
  }
  if (
    projection !== undefined &&
    options.sessionID !== undefined &&
    options.sessionID !== projection.sessionID
  ) {
    throw new Error(
      "Grok native tool projection session does not match the launch session",
    );
  }
  return await prepareGrokBuildLaunchWithArgs(
    projection === undefined
      ? options.mcpServer?.name === MTI_REFLEX_SERVER_NAME
        ? buildGrokMtiReflexArgs(
            args,
            options.sessionID ?? randomUUID(),
            profile.modelID,
          )
        : buildGrokArgs(
            args,
            options.sessionID ?? randomUUID(),
            profile.modelID,
          )
      : buildGrokNativeToolProjectionArgs(
          args,
          projection.sessionID,
          profile.modelID,
        ),
    profile,
    env,
    cwd,
    options.runtimeDirectory,
    {},
    [],
    options.mcpServer,
    options.onRuntimeHealth,
    projection,
  );
}

export async function prepareGrokBuildAcpLaunch(
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: GrokAcpLaunchOptions = {},
): Promise<PreparedGrokBuildLaunch> {
  return await prepareGrokBuildLaunchWithArgs(
    buildGrokAcpArgs(),
    profile,
    env,
    cwd,
    options.runtimeDirectory,
    options.toolEnvironment,
    options.readablePaths,
    undefined,
    options.onRuntimeHealth,
    undefined,
  );
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function validateGrokPersistentRuntimeDirectory(
  runtimeDirectory: string,
  cwd: string,
): Promise<string> {
  if (!isAbsolute(runtimeDirectory) || runtimeDirectory.includes("\0")) {
    throw new Error("Persistent Grok runtime directory must be an absolute path");
  }
  const metadata = await lstat(runtimeDirectory).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(
      "Persistent Grok runtime directory must be an existing non-symlink directory",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(
      "Persistent Grok runtime directory must not be accessible by group or other users",
    );
  }
  const runtime = canonicalExistingPath(
    runtimeDirectory,
    "Persistent Grok runtime directory",
  );
  const workspace = canonicalExistingPath(cwd, "Grok workspace");
  if (inside(workspace, runtime) || inside(runtime, workspace)) {
    throw new Error(
      "Persistent Grok runtime directory must be disjoint from the workspace",
    );
  }
  return runtime;
}

async function replaceGrokConfig(
  configDirectory: string,
  content: string,
): Promise<string> {
  const configPath = join(configDirectory, "config.toml");
  const temporary = join(
    configDirectory,
    `.organum-code-config-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, configPath);
    if (process.platform !== "win32") await chmod(configPath, 0o600);
    return configPath;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function prepareGrokBuildLaunchWithArgs(
  childArgs: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv,
  cwd: string,
  persistentRuntimeDirectory?: string,
  toolEnvironment: Readonly<Record<string, string>> = {},
  readablePaths: readonly string[] = [],
  mcpServer?: ProjectedMcpHttpServer,
  onRuntimeHealth?: GrokRuntimeHealthObserver,
  nativeToolProjection?: GrokNativeToolProjectionLaunch,
): Promise<PreparedGrokBuildLaunch> {
  const persistentRuntime = persistentRuntimeDirectory !== undefined;
  const createdConfigDirectory = persistentRuntime
    ? undefined
    : await mkdtemp(join(tmpdir(), "organum-code-grok-"));
  const configDirectory = persistentRuntime
    ? await validateGrokPersistentRuntimeDirectory(
        persistentRuntimeDirectory,
        cwd,
      )
    : canonicalExistingPath(
        createdConfigDirectory!,
        "Grok runtime directory",
      );
  const binary = resolveGrokBinary(env);
  let containment: PreparedBackendContainment | undefined;
  const lockPath = join(configDirectory, ".organum-code-owner.lock");
  let ownsLock = false;
  let closed = false;
  let initialRuntimeHealth: GrokRuntimeHealthReport | null = null;
  let wrapperPath: string | undefined;
  let ownsWrapper = false;
  try {
    if (persistentRuntime) {
      initialRuntimeHealth = await inspectGrokRuntimeHealth(configDirectory);
      await enforceGrokRuntimeHealth(
        initialRuntimeHealth,
        "launch",
        onRuntimeHealth,
      );
    }
    if (persistentRuntime) {
      const lock = await open(lockPath, "wx", 0o600).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            "Persistent Grok runtime already has an owner lock; concurrent or stale ownership must be resolved explicitly",
          );
        }
        throw error;
      });
      try {
        await lock.writeFile(
          `${JSON.stringify({ schema: 1, pid: process.pid })}\n`,
          "utf8",
        );
        await lock.sync();
      } finally {
        await lock.close();
      }
      ownsLock = true;
    }
    await mkdir(join(configDirectory, "home"), { recursive: true, mode: 0o700 });
    let wrapperCommand: string | undefined;
    if (nativeToolProjection !== undefined) {
      if (profile.protocol !== "chat-completions") {
        throw new Error(
          "Grok native tool projection requires chat-completions",
        );
      }
      wrapperPath = join(
        configDirectory,
        "organum-code-grok-native-tool-wrapper.mjs",
      );
      await writeFile(wrapperPath, grokNativeToolWrapperProgram(), {
        encoding: "utf8",
        mode: 0o500,
        flag: "wx",
      });
      ownsWrapper = true;
      wrapperCommand = quote([process.execPath, wrapperPath]);
      nativeToolProjection.bindWrapperCommand(wrapperCommand);
    }
    const configPath = await replaceGrokConfig(
      configDirectory,
      buildGrokConfig(profile, mcpServer, wrapperCommand),
    );
    const childEnvironment = buildGrokChildEnvironment(
      env,
      configDirectory,
      profile.apiKeyEnv,
      toolEnvironment,
      nativeToolProjection,
    );
    const prepared = await prepareBackendContainment({
      binary,
      args: [...childArgs],
      env: childEnvironment,
      workspace: cwd,
      runtimeDirectory: configDirectory,
      brokerOrigin: new URL(profile.baseURL).origin,
      immutablePaths: [
        configPath,
        ...(wrapperPath === undefined ? [] : [wrapperPath]),
        ...(persistentRuntime ? [lockPath] : []),
      ],
      readablePaths: [
        ...readablePaths,
        ...(wrapperPath === undefined ? [] : [dirname(process.execPath)]),
      ],
      allowPty: true,
    });
    containment = prepared;
    return {
      containment: prepared,
      runtimeDirectory: configDirectory,
      persistentRuntime,
      initialRuntimeHealth,
      async close() {
        if (closed) return;
        closed = true;
        await prepared.gate.close().catch(() => undefined);
        let healthError: unknown;
        if (persistentRuntime) {
          try {
            await enforceGrokRuntimeHealth(
              await inspectGrokRuntimeHealth(configDirectory),
              "settle",
              onRuntimeHealth,
            );
          } catch (error) {
            healthError = error;
          }
        }
        if (persistentRuntime) {
          // Config is a per-launch projection and may contain an ephemeral MCP
          // capability. Native history lives elsewhere in the actor runtime.
          await rm(configPath, { force: true }).catch(() => undefined);
          if (wrapperPath !== undefined && ownsWrapper) {
            await rm(wrapperPath, { force: true }).catch(() => undefined);
            ownsWrapper = false;
          }
        }
        if (ownsLock) {
          ownsLock = false;
          await rm(lockPath, { force: true });
        }
        if (createdConfigDirectory !== undefined) {
          await rm(createdConfigDirectory, { recursive: true, force: true });
        }
        if (healthError !== undefined) throw healthError;
      },
    };
  } catch (error) {
    await containment?.gate.close().catch(() => undefined);
    if (persistentRuntime) {
      await rm(join(configDirectory, "config.toml"), { force: true }).catch(
        () => undefined,
      );
      if (wrapperPath !== undefined && ownsWrapper) {
        await rm(wrapperPath, { force: true }).catch(() => undefined);
        ownsWrapper = false;
      }
    }
    if (ownsLock) {
      ownsLock = false;
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
    if (createdConfigDirectory !== undefined) {
      await rm(createdConfigDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
