import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildBackendProbeEnvironment } from "./backend-catalog.js";
import {
  canonicalExistingPath,
  prepareBackendContainment,
  resolveExecutablePath,
  type PreparedBackendContainment,
} from "./containment.js";
import {
  BROKER_TOKEN_ENV,
  type JsonObject,
} from "./inference-broker.js";
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
  "TERM",
  "USER",
  "WINDIR",
] as const;

export interface DeepCodeInstallation {
  binary: string;
  version: string;
}

export interface PreparedDeepCodeLaunch {
  containment: PreparedBackendContainment;
  completionReceiptPath?: string;
  diagnosticRuntimeDirectory: string;
  diagnosticStateDirectory: string;
  persistentRuntime: boolean;
  close(): Promise<void>;
}

export interface PrepareDeepCodeLaunchOptions {
  beforeSpawn?: () => Promise<void>;
  completionSignal?: boolean;
  permissionMode?: DeepCodePermissionMode;
  mcpServer?: OrganumMcpHttpServer;
  /**
   * Actor-owned private runtime outside the workspace. Native history under
   * the isolated Deep Code home survives wrapper process exit.
   */
  runtimeDirectory?: string;
}

export type DeepCodePermissionMode =
  | "interactive"
  | "contained-unattended"
  | "signed-hub-review";

export interface DeepCodeMcpBridge {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export const DEEPCODE_MCP_STDIO_BRIDGE_SOURCE = String.raw`#!/usr/bin/env node
"use strict";
const readline = require("node:readline");

const endpoint = process.argv[2];
const authorization = process.env.ORGANUM_CODE_MCP_AUTHORIZATION;
if (!endpoint || !authorization) {
  process.stderr.write("Organum MCP bridge configuration is missing\n");
  process.exit(2);
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let queue = Promise.resolve();
lines.on("line", (line) => {
  queue = queue.then(async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });
    if (response.status === 202 || response.status === 204) return;
    const body = await response.text();
    if (body.length > 0) process.stdout.write(body + "\n");
  }).catch((error) => {
    process.stderr.write(
      "Organum MCP bridge request failed: " +
        (error instanceof Error ? error.message : String(error)) +
        "\n",
    );
  });
});
`;

export function resolveDeepCodeBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_DEEPCODE_BIN?.trim() || "deepcode";
}

export function inspectDeepCode(env: NodeJS.ProcessEnv): DeepCodeInstallation {
  const binary = resolveDeepCodeBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Deep Code binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Deep Code version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: version.split(/\r?\n/, 1)[0] };
}

export function buildDeepCodeArgs(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

export function normalizeDeepCodeChatCompletionsRequest(
  body: Readonly<JsonObject>,
): JsonObject {
  const normalized = { ...body };
  // Deep Code emits DeepSeek-specific request controls even when thinking is
  // disabled. They are not part of the OpenAI Chat Completions contract and
  // providers such as Upstage reject them instead of ignoring them.
  delete normalized.thinking;
  delete normalized.extra_body;
  return normalized;
}

export function buildDeepCodeSettings(
  notifyPath?: string,
  permissionMode: DeepCodePermissionMode = "interactive",
  mcpBridge?: DeepCodeMcpBridge,
): string {
  const containedUnattended = permissionMode === "contained-unattended";
  const signedHubReview = permissionMode === "signed-hub-review";
  return `${JSON.stringify(
    {
      telemetryEnabled: false,
      debugLogEnabled: false,
      ...(notifyPath === undefined ? {} : { notify: notifyPath }),
      permissions: {
        allow: [
          "read-in-cwd",
          ...(signedHubReview ? [] : ["write-in-cwd"]),
          "query-git-log",
          ...(mcpBridge === undefined ? [] : ["mcp"]),
        ],
        deny: [
          "read-out-cwd",
          "write-out-cwd",
          ...(containedUnattended || signedHubReview
            ? ["delete-in-cwd"]
            : []),
          ...(signedHubReview ? ["write-in-cwd"] : []),
          "delete-out-cwd",
          "mutate-git-log",
          "network",
          ...(mcpBridge === undefined ? ["mcp"] : []),
        ],
        ask: containedUnattended || signedHubReview
          ? []
          : ["delete-in-cwd"],
        // Unknown shell classifications are admitted only for the benchmark
        // profile, where the real boundary is mandatory OS containment and
        // the actor has neither a provider key nor general network access.
        defaultMode: containedUnattended ? "allowAll" : "askAll",
      },
      ...(mcpBridge === undefined
        ? {}
        : {
            mcpServers: {
              "organum-code": {
                command: mcpBridge.command,
                args: [...mcpBridge.args],
                env: { ...mcpBridge.env },
              },
            },
          }),
      statusline: { enabled: false, providers: [] },
    },
    null,
    2,
  )}\n`;
}

export function buildDeepCodeChildEnvironment(
  env: NodeJS.ProcessEnv,
  configDirectory: string,
  profile: ProviderProfile,
): NodeJS.ProcessEnv {
  if (profile.protocol !== "chat-completions") {
    throw new Error(
      "Deep Code currently requires a Chat Completions provider profile",
    );
  }
  if (profile.apiKeyEnv !== BROKER_TOKEN_ENV) {
    throw new Error("Deep Code adapter accepts a broker capability only");
  }
  const capability = env[BROKER_TOKEN_ENV]?.trim();
  if (!capability) throw new Error("Deep Code broker capability is missing");

  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  const isolatedHome = join(configDirectory, "home");
  return {
    ...result,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    DEEPCODE_MODEL: profile.modelID,
    DEEPCODE_BASE_URL: profile.baseURL,
    DEEPCODE_API_KEY: capability,
    DEEPCODE_TELEMETRY_ENABLED: "false",
    DEEPCODE_DEBUG_LOG_ENABLED: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
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
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may already have exited.
  }
}

export async function launchDeepCode(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: PrepareDeepCodeLaunchOptions = {},
): Promise<number> {
  const launch = await prepareDeepCodeLaunch(
    args,
    profile,
    env,
    cwd,
    options,
  );
  try {
    const prepared = launch.containment;
    await options.beforeSpawn?.();
    return await new Promise<number>((resolveExit, rejectExit) => {
      const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
        cwd: prepared.cwd,
        env: prepared.spawn.env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
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
        resolveExit(code ?? signalExitCode(signal));
      });
    });
  } finally {
    await launch.close();
  }
}

export async function prepareDeepCodeLaunch(
  args: readonly string[],
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: PrepareDeepCodeLaunchOptions = {},
): Promise<PreparedDeepCodeLaunch> {
  const persistentRuntime = options.runtimeDirectory !== undefined;
  const createdConfigDirectory = persistentRuntime
    ? undefined
    : await mkdtemp(join(tmpdir(), "organum-code-deepcode-"));
  const configDirectory = persistentRuntime
    ? await validateNativePersistentRuntimeDirectory(
        options.runtimeDirectory!,
        cwd,
        "Deep Code",
      )
    : canonicalExistingPath(
        createdConfigDirectory!,
        "Deep Code runtime directory",
      );
  const binary = resolveDeepCodeBinary(env);
  let containment: PreparedBackendContainment | undefined;
  let owner: NativeRuntimeOwner | undefined;
  let closed = false;
  const settingsDirectory = join(configDirectory, "home", ".deepcode");
  const settingsPath = join(settingsDirectory, "settings.json");
  const completionReceiptPath = options.completionSignal
    ? join(configDirectory, "completion.json")
    : undefined;
  const notifyPath = options.completionSignal
    ? join(configDirectory, "notify.cjs")
    : undefined;
  const mcpBridgePath =
    options.mcpServer === undefined
      ? undefined
      : join(configDirectory, "organum-mcp-stdio.cjs");
  const ephemeralProjectionPaths = [
    settingsPath,
    ...(completionReceiptPath === undefined ? [] : [completionReceiptPath]),
    ...(notifyPath === undefined ? [] : [notifyPath]),
    ...(mcpBridgePath === undefined ? [] : [mcpBridgePath]),
  ];
  try {
    if (persistentRuntime) {
      owner = await acquireNativeRuntimeOwner(configDirectory, "deepcode");
    }
    await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all(
      ephemeralProjectionPaths.map(async (path) =>
        await rm(path, { force: true })
      ),
    );
    if (notifyPath !== undefined && completionReceiptPath !== undefined) {
      const notifySource = [
        "#!/usr/bin/env node",
        'const { renameSync, writeFileSync } = require("node:fs");',
        `const target = ${JSON.stringify(completionReceiptPath)};`,
        'const temporary = `${target}.tmp`;',
        "const body = JSON.stringify({",
        "  status: process.env.STATUS ?? null,",
        "  duration: process.env.DURATION ?? null,",
        "});",
        'writeFileSync(temporary, `${body}\\n`, { encoding: "utf8", mode: 0o600 });',
        "renameSync(temporary, target);",
        "",
      ].join("\n");
      await writeFile(notifyPath, notifySource, {
        encoding: "utf8",
        mode: 0o700,
        flag: "wx",
      });
    }
    const childEnvironment = buildDeepCodeChildEnvironment(
      env,
      configDirectory,
      profile,
    );
    const executablePath = resolveExecutablePath(binary, childEnvironment, cwd);
    const nodePath = resolveExecutablePath("node", childEnvironment, cwd);
    const admittedMcp =
      options.mcpServer === undefined
        ? undefined
        : validateOrganumMcpHttpServer(options.mcpServer);
    if (mcpBridgePath !== undefined) {
      await writeFile(mcpBridgePath, DEEPCODE_MCP_STDIO_BRIDGE_SOURCE, {
        encoding: "utf8",
        mode: 0o500,
        flag: "wx",
      });
    }
    const mcpBridge: DeepCodeMcpBridge | undefined =
      admittedMcp === undefined || mcpBridgePath === undefined
        ? undefined
        : {
            command: nodePath,
            args: [mcpBridgePath, admittedMcp.url],
            env: {
              ORGANUM_CODE_MCP_AUTHORIZATION:
                admittedMcp.headers[0].value,
            },
          };
    await writeFile(
      settingsPath,
      buildDeepCodeSettings(
        notifyPath,
        options.permissionMode,
        mcpBridge,
      ),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    const prepared = await prepareBackendContainment({
      binary,
      args: buildDeepCodeArgs(args),
      env: childEnvironment,
      workspace: cwd,
      workspaceWritable: options.permissionMode !== "signed-hub-review",
      runtimeDirectory: configDirectory,
      brokerOrigin: new URL(profile.baseURL).origin,
      // The published CLI is an `#!/usr/bin/env node` bundle with adjacent
      // dynamic chunks. Admit only that bundle directory and the selected
      // Node executable, not the surrounding package manager tree.
      readablePaths: [dirname(executablePath), nodePath],
      immutablePaths: [
        settingsPath,
        ...(notifyPath === undefined ? [] : [notifyPath]),
        ...(mcpBridgePath === undefined ? [] : [mcpBridgePath]),
        ...(owner === undefined ? [] : [owner.lockPath]),
      ],
      allowPty: true,
    });
    containment = prepared;
    return {
      containment: prepared,
      ...(completionReceiptPath === undefined ? {} : { completionReceiptPath }),
      diagnosticRuntimeDirectory: configDirectory,
      diagnosticStateDirectory: join(settingsDirectory, "projects"),
      persistentRuntime,
      async close() {
        if (closed) return;
        closed = true;
        await prepared.gate.close().catch(() => undefined);
        await Promise.all(
          ephemeralProjectionPaths.map(async (path) =>
            await rm(path, { force: true }).catch(() => undefined)
          ),
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
    await Promise.all(
      ephemeralProjectionPaths.map(async (path) =>
        await rm(path, { force: true }).catch(() => undefined)
      ),
    );
    await owner?.close().catch(() => undefined);
    if (createdConfigDirectory !== undefined) {
      await rm(createdConfigDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
