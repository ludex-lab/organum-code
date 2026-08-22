import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_NATIVE_TOOL_HOOK_PATH } from "./claude-native-tool-hook.js";
import {
  claudeBrokerEnvironment,
  type InferenceBrokerSession,
} from "./inference-broker.js";
import { buildBackendProbeEnvironment } from "./backend-catalog.js";
import {
  canonicalExistingPath,
  prepareBackendContainment,
  type PreparedBackendContainment,
} from "./containment.js";
import {
  MTI_REFLEX_SERVER_NAME,
  type ProjectedMcpHttpServer,
  validateProjectedMcpHttpServer,
} from "./mti-reflex-mcp.js";
import {
  acquireNativeRuntimeOwner,
  validateNativePersistentRuntimeDirectory,
  type NativeRuntimeOwner,
} from "./native-interactive-lifecycle.js";
import { assertClaudeS16OperationalEnvironment } from "./native-tool-operational-admission.js";

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
  "--allow-dangerously-skip-permissions",
  "--chrome",
  "--dangerously-skip-permissions",
  "--mcp-config",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control",
  "--settings",
  "--strict-mcp-config",
]);

const ORGANUM_MCP_TOOL_NAMES = [
  "mcp__organum-code__organum_publish",
  "mcp__organum-code__organum_handoff",
] as const;
const MTI_REFLEX_CLAUDE_TOOL_NAME =
  "mcp__mti-reflex__mti_reflex_noop";

export interface ClaudeCodeInstallation {
  binary: string;
  version: string;
}

export interface PreparedClaudeCodeLaunch {
  containment: PreparedBackendContainment;
  runtimeDirectory: string;
  persistentRuntime: boolean;
  close(): Promise<void>;
}

export interface ClaudeCodeLaunchOptions {
  mcpServer?: ProjectedMcpHttpServer;
  signal?: AbortSignal;
  /**
   * Actor-owned private runtime outside the workspace. When present, Claude's
   * native conversation history survives wrapper process exit.
   */
  runtimeDirectory?: string;
  nativeToolProjection?: {
    endpoint: string;
    sessionID: string;
    /** Provider-zero fixtures may pin the built product entrypoint explicitly. */
    hookCommand?: {
      command: string;
      args: readonly string[];
    };
  };
}

export function resolveClaudeBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_CLAUDE_BIN?.trim() || "claude";
}

export function inspectClaudeCode(env: NodeJS.ProcessEnv): ClaudeCodeInstallation {
  const binary = resolveClaudeBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Claude Code binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `Claude Code version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: result.stdout.trim() };
}

function hasArgument(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

const NATIVE_TOOL_PROJECTION_DENIED_ARGUMENTS = [
  "--allowedTools",
  "--bare",
  "--continue",
  "--disallowedTools",
  "--include-hook-events",
  "--max-turns",
  "--no-session-persistence",
  "--output-format",
  "--permission-mode",
  "--resume",
  "--session-id",
  "--system-prompt",
  "--tools",
] as const;

function forwardedClaudeArgs(args: readonly string[]): string[] {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  for (const name of DENIED_ARGUMENTS) {
    if (hasArgument(forwarded, name)) {
      throw new Error(
        `${name} is disabled in the brokered Claude adapter until its capability is explicitly admitted`,
      );
    }
  }
  if (hasArgument(forwarded, "--model")) {
    throw new Error("Claude model selection is fixed by the broker capability");
  }
  return forwarded;
}

export function buildClaudeArgs(
  args: readonly string[],
  advertisedModel: string,
  sessionID: string = randomUUID(),
): string[] {
  const forwarded = forwardedClaudeArgs(args);
  const resumes =
    hasArgument(forwarded, "--resume") ||
    hasArgument(forwarded, "--continue") ||
    hasArgument(forwarded, "--session-id");
  return [
    "--bare",
    "--no-chrome",
    "--disable-slash-commands",
    "--model",
    advertisedModel,
    ...(resumes ? [] : ["--session-id", sessionID]),
    ...forwarded,
  ];
}

function productSelfCommand(): { command: string; args: string[] } {
  const entrypoint = process.argv[1] ?? "";
  const sourceLaunch =
    entrypoint !== process.execPath &&
    /\.(?:[cm]?[jt]s)$/.test(entrypoint);
  return {
    command: process.execPath,
    args: sourceLaunch ? [entrypoint] : [],
  };
}

export function buildClaudeNativeToolSettings(
  endpoint: string,
  hookCommand: {
    command: string;
    args: readonly string[];
  } = productSelfCommand(),
): string {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.pathname !== CLAUDE_NATIVE_TOOL_HOOK_PATH ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Claude native tool hook endpoint is invalid");
  }
  return `${JSON.stringify({
    disableAllHooks: false,
    permissions: {
      allow: [],
      ask: [],
      deny: [],
    },
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: hookCommand.command,
          args: [
            ...hookCommand.args,
            "__claude-native-tool-hook",
            endpoint,
            "2000",
          ],
          timeout: 5,
        }],
      }],
    },
  }, null, 2)}\n`;
}

export function buildClaudeNativeToolProjectionArgs(
  args: readonly string[],
  advertisedModel: string,
  sessionID: string,
  settingsPath: string,
): string[] {
  const forwarded = forwardedClaudeArgs(args);
  if (
    !forwarded.some((argument) =>
      argument === "--print" || argument === "-p"
    )
  ) {
    throw new Error(
      "Claude native tool projection requires a new --print/-p turn",
    );
  }
  for (const name of NATIVE_TOOL_PROJECTION_DENIED_ARGUMENTS) {
    if (hasArgument(forwarded, name)) {
      throw new Error(
        `${name} is fixed by the Claude native tool projection`,
      );
    }
  }
  return [
    "--no-chrome",
    "--disable-slash-commands",
    "--model",
    advertisedModel,
    "--session-id",
    sessionID,
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-hook-events",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--settings",
    settingsPath,
    "--max-turns",
    "3",
    "--tools",
    "Bash",
    "--permission-mode",
    "dontAsk",
    "--prompt-suggestions",
    "false",
    ...forwarded,
  ];
}

export function buildClaudeBenchmarkArgs(
  prompt: string,
  advertisedModel: string,
  sessionID: string = randomUUID(),
): string[] {
  const args = buildClaudeArgs(
    [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--tools",
      "Bash,Edit,Read,Write,Glob,Grep",
      "--allowedTools",
      "Bash,Edit,Read,Write,Glob,Grep",
      "--disallowedTools",
      "WebFetch,WebSearch,Task,Agent",
      "--permission-mode",
      "bypassPermissions",
      "--prompt-suggestions",
      "false",
      prompt,
    ],
    advertisedModel,
    sessionID,
  );
  args.splice(args.length - 1, 0, "--dangerously-skip-permissions");
  return args;
}

export function buildClaudeMcpConfig(
  server: ProjectedMcpHttpServer,
): string {
  const admitted = validateProjectedMcpHttpServer(server);
  return `${JSON.stringify({
    mcpServers: {
      [admitted.name]: {
        type: admitted.type,
        url: admitted.url,
        headers: Object.fromEntries(
          admitted.headers.map(({ name, value }) => [name, value]),
        ),
      },
    },
  }, null, 2)}\n`;
}

function appendClaudeToolNames(
  args: readonly string[],
  flag: "--tools" | "--allowedTools",
): string[] {
  const result = [...args];
  const index = result.indexOf(flag);
  if (index < 0 || index + 1 >= result.length) {
    result.push(flag, ORGANUM_MCP_TOOL_NAMES.join(","));
    return result;
  }
  const existing = result[index + 1].split(",").filter(Boolean);
  result[index + 1] = [...new Set([
    ...existing,
    ...ORGANUM_MCP_TOOL_NAMES,
  ])].join(",");
  return result;
}

function projectClaudeMcpArgs(
  args: readonly string[],
  configPath: string,
  server: ProjectedMcpHttpServer,
): string[] {
  if (server.name === MTI_REFLEX_SERVER_NAME) {
    return buildClaudeMtiReflexProjectionArgs(args, configPath);
  }
  const withTools = appendClaudeToolNames(args, "--tools");
  const withPermission = appendClaudeToolNames(
    withTools,
    "--allowedTools",
  );
  return [
    ...withPermission,
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
  ];
}

export function buildClaudeMtiReflexProjectionArgs(
  args: readonly string[],
  configPath: string,
): string[] {
  for (const flag of ["--tools", "--allowedTools", "--disallowedTools"]) {
    if (hasArgument(args, flag)) {
      throw new Error(`${flag} is fixed by the MTI reflex projection`);
    }
  }
  return [
    ...args,
    "--tools",
    MTI_REFLEX_CLAUDE_TOOL_NAME,
    "--allowedTools",
    MTI_REFLEX_CLAUDE_TOOL_NAME,
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
  ];
}

export function buildClaudeChildEnvironment(
  env: NodeJS.ProcessEnv,
  configDirectory: string,
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("LC_") && env[name] !== undefined) {
      result[name] = env[name];
    }
  }
  const isolatedHome = join(configDirectory, "home");
  const isolatedTemporaryDirectory = join(configDirectory, "tmp");
  return {
    ...result,
    ...claudeBrokerEnvironment(session, advertisedModel),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_TMPDIR: isolatedTemporaryDirectory,
    CLAUDE_TMPDIR: isolatedTemporaryDirectory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The child may already have exited.
  }
}

export async function launchClaudeCode(
  args: readonly string[],
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: ClaudeCodeLaunchOptions = {},
): Promise<number> {
  const launch = await prepareClaudeCodeLaunch(
    args,
    session,
    advertisedModel,
    env,
    cwd,
    options,
  );
  try {
    const prepared = launch.containment;
    return await new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
        cwd: prepared.cwd,
        env: prepared.spawn.env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      const forwardInterrupt = (): void => signalTree(child.pid, "SIGINT");
      const forwardTermination = (): void => signalTree(child.pid, "SIGTERM");
      const abort = (): void => signalTree(child.pid, "SIGTERM");
      const cleanup = (): void => {
        process.off("SIGINT", forwardInterrupt);
        process.off("SIGTERM", forwardTermination);
        options.signal?.removeEventListener("abort", abort);
      };
      process.once("SIGINT", forwardInterrupt);
      process.once("SIGTERM", forwardTermination);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
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
    await launch.close();
  }
}

async function prepareClaudeLaunchWithArgs(
  childArgs:
    | readonly string[]
    | ((settingsPath: string) => readonly string[]),
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: ClaudeCodeLaunchOptions,
): Promise<PreparedClaudeCodeLaunch> {
  const persistentRuntime = options.runtimeDirectory !== undefined;
  const createdConfigDirectory = persistentRuntime
    ? undefined
    : await mkdtemp(join(tmpdir(), "organum-code-claude-"));
  const configDirectory = persistentRuntime
    ? await validateNativePersistentRuntimeDirectory(
        options.runtimeDirectory!,
        cwd,
        "Claude Code",
      )
    : canonicalExistingPath(
        createdConfigDirectory!,
        "Claude runtime directory",
      );
  const binary = resolveClaudeBinary(env);
  let containment: PreparedBackendContainment | undefined;
  let owner: NativeRuntimeOwner | undefined;
  let closed = false;
  const mcpConfigPath = join(configDirectory, "organum-mcp.json");
  const nativeToolSettingsPath = join(
    configDirectory,
    "native-tool-settings.json",
  );
  try {
    if (
      options.nativeToolProjection !== undefined &&
      options.mcpServer !== undefined
    ) {
      throw new Error(
        "Claude native tool projection does not admit MCP in its exact surface",
      );
    }
    if (persistentRuntime) {
      owner = await acquireNativeRuntimeOwner(configDirectory, "claude");
    }
    await Promise.all([
      mkdir(join(configDirectory, "home"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(join(configDirectory, "tmp"), {
        recursive: true,
        mode: 0o700,
      }),
      // A crashed prior launch may leave an expired MCP capability. The
      // single-owner lease makes removal safe before projecting a new one.
      rm(mcpConfigPath, { force: true }),
      rm(nativeToolSettingsPath, { force: true }),
    ]);
    const mcpServer = options.mcpServer;
    if (mcpServer !== undefined) {
      await writeFile(
        mcpConfigPath,
        buildClaudeMcpConfig(mcpServer),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
    if (options.nativeToolProjection !== undefined) {
      await writeFile(
        nativeToolSettingsPath,
        buildClaudeNativeToolSettings(
          options.nativeToolProjection.endpoint,
          options.nativeToolProjection.hookCommand,
        ),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    }
    const resolvedChildArgs =
      typeof childArgs === "function"
        ? childArgs(nativeToolSettingsPath)
        : childArgs;
    const childEnv = buildClaudeChildEnvironment(
      env,
      configDirectory,
      session,
      advertisedModel,
    );
    const prepared = await prepareBackendContainment({
      binary,
      args:
        mcpServer === undefined
          ? resolvedChildArgs
          : projectClaudeMcpArgs(
              resolvedChildArgs,
              mcpConfigPath,
              mcpServer,
            ),
      env: childEnv,
      workspace: cwd,
      runtimeDirectory: configDirectory,
      brokerOrigin: session.origin,
      readablePaths:
        options.nativeToolProjection === undefined
          ? []
          : [
              options.nativeToolProjection.hookCommand?.command ??
                process.execPath,
              ...(options.nativeToolProjection.hookCommand?.args ??
                productSelfCommand().args),
            ].filter((value) => value.startsWith("/")),
      immutablePaths:
        [
          ...(mcpServer === undefined ? [] : [mcpConfigPath]),
          ...(options.nativeToolProjection === undefined
            ? []
            : [nativeToolSettingsPath]),
          ...(owner === undefined ? [] : [owner.lockPath]),
        ],
      allowPty: true,
    });
    containment = prepared;
    return {
      containment: prepared,
      runtimeDirectory: configDirectory,
      persistentRuntime,
      async close() {
        if (closed) return;
        closed = true;
        await prepared.gate.close().catch(() => undefined);
        await rm(mcpConfigPath, { force: true }).catch(() => undefined);
        await rm(nativeToolSettingsPath, { force: true }).catch(
          () => undefined,
        );
        await owner?.close().catch(() => undefined);
        owner = undefined;
        if (createdConfigDirectory !== undefined) {
          await rm(createdConfigDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await containment?.gate.close().catch(() => undefined);
    await rm(mcpConfigPath, { force: true }).catch(() => undefined);
    await rm(nativeToolSettingsPath, { force: true }).catch(() => undefined);
    await owner?.close().catch(() => undefined);
    if (createdConfigDirectory !== undefined) {
      await rm(createdConfigDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function prepareClaudeCodeLaunch(
  args: readonly string[],
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: ClaudeCodeLaunchOptions = {},
): Promise<PreparedClaudeCodeLaunch> {
  if (options.nativeToolProjection !== undefined) {
    assertClaudeS16OperationalEnvironment(inspectClaudeCode(env).version);
  }
  return await prepareClaudeLaunchWithArgs(
    options.nativeToolProjection === undefined
      ? buildClaudeArgs(args, advertisedModel)
      : (settingsPath) =>
          buildClaudeNativeToolProjectionArgs(
            args,
            advertisedModel,
            options.nativeToolProjection!.sessionID,
            settingsPath,
          ),
    session,
    advertisedModel,
    env,
    cwd,
    options,
  );
}

export async function prepareClaudeBenchmarkLaunch(
  prompt: string,
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  sessionID: string = randomUUID(),
  options: ClaudeCodeLaunchOptions = {},
): Promise<PreparedClaudeCodeLaunch> {
  return await prepareClaudeLaunchWithArgs(
    buildClaudeBenchmarkArgs(prompt, advertisedModel, sessionID),
    session,
    advertisedModel,
    env,
    cwd,
    options,
  );
}
