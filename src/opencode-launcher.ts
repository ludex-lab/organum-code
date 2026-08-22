import { constants } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildBackendProbeEnvironment } from "./backend-catalog.js";

import type { OpenCodeConfig } from "./opencode-config.js";
import { isValidCellIdentity } from "./organum-identity.js";
import {
  packageFirstPartyPlugin,
  PLUGIN_PROBE_ENV,
  unsealFirstPartyPlugin,
} from "./plugin-package.js";
import {
  ORGANUM_CODE_INTENT_ENV,
  ORGANUM_CODE_HUB_DIRECTORY_ENV,
  ORGANUM_CODE_ORGANUM_BIN_ENV,
  ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV,
  ORGANUM_CODE_PERSONA_ENV,
  ORGANUM_CODE_PROJECT_CONTRACT_ENV,
  ORGANUM_CODE_ROLE_ENV,
  ORGANUM_CODE_STATE_DIRECTORY_ENV,
  ORGANUM_CODE_WORKSPACE_ENV,
} from "./plugin-protocol.js";
import {
  buildOrganumBenchmarkEnvironment,
} from "./organum-cli.js";

const SAFE_ENVIRONMENT_NAMES = [
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
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
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export interface OpenCodeInstallation {
  binary: string;
  version: string;
}

export function resolveOpenCodeBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_OPENCODE_BIN?.trim() || "opencode";
}

export function firstPartyPluginEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ORGANUM_CODE_FIRST_PARTY_PLUGIN?.trim();
  if (value === undefined || value === "" || value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") return false;
  throw new Error(
    "ORGANUM_CODE_FIRST_PARTY_PLUGIN must be 1, 0, true, or false",
  );
}

export function inspectOpenCode(env: NodeJS.ProcessEnv): OpenCodeInstallation {
  const binary = resolveOpenCodeBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });

  if (result.error) {
    throw new Error(
      `Unable to run OpenCode binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `OpenCode version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }

  const version = result.stdout.trim();
  if (!version) {
    throw new Error("OpenCode version check returned an empty version");
  }

  return { binary, version };
}

export function buildOpenCodeArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  if (firstPartyPluginEnabled(env)) {
    if (forwarded.includes("--pure")) {
      throw new Error(
        "--pure disables the Organum Code first-party plugin; set ORGANUM_CODE_FIRST_PARTY_PLUGIN=0 to run without it",
      );
    }
    return forwarded;
  }
  if (forwarded.includes("--pure")) return forwarded;
  return ["--pure", ...forwarded];
}

function preserveHostPath(
  childEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
  source: string,
  target: string,
): void {
  if (env[source] !== undefined) childEnv[target] = env[source];
}

function isolateExternalPluginConfiguration(
  childEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
  configDirectory: string,
): void {
  const isolatedHome = join(configDirectory, "home");

  preserveHostPath(childEnv, env, "HOME", "ORGANUM_CODE_HOST_HOME");
  preserveHostPath(
    childEnv,
    env,
    "USERPROFILE",
    "ORGANUM_CODE_HOST_USERPROFILE",
  );
  preserveHostPath(childEnv, env, "APPDATA", "ORGANUM_CODE_HOST_APPDATA");
  preserveHostPath(
    childEnv,
    env,
    "LOCALAPPDATA",
    "ORGANUM_CODE_HOST_LOCALAPPDATA",
  );

  childEnv.HOME = isolatedHome;
  childEnv.USERPROFILE = isolatedHome;
  childEnv.APPDATA = join(configDirectory, "app-data");
  childEnv.LOCALAPPDATA = join(configDirectory, "local-app-data");
  childEnv.XDG_CONFIG_HOME = join(configDirectory, "xdg-config");

  const hostHome = env.HOME ?? env.USERPROFILE;
  if (hostHome) {
    childEnv.XDG_DATA_HOME =
      env.XDG_DATA_HOME ?? join(hostHome, ".local", "share");
    childEnv.XDG_CACHE_HOME =
      env.XDG_CACHE_HOME ?? join(hostHome, ".cache");
    childEnv.XDG_STATE_HOME =
      env.XDG_STATE_HOME ?? join(hostHome, ".local", "state");
  }

  childEnv.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  childEnv.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  childEnv.OPENCODE_DISABLE_AUTOUPDATE = "1";
  childEnv.OPENCODE_DISABLE_MODELS_FETCH = "1";
}

export function buildChildEnvironment(
  env: NodeJS.ProcessEnv,
  config: OpenCodeConfig,
  configDirectory: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  const allowedNames = new Set<string>(SAFE_ENVIRONMENT_NAMES);

  for (const name of Object.keys(env)) {
    if (name.startsWith("LC_")) allowedNames.add(name);
  }

  for (const provider of Object.values(config.provider)) {
    const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(
      provider.options.apiKey,
    );
    if (match) allowedNames.add(match[1]);
  }

  if (env[PLUGIN_PROBE_ENV] !== undefined) allowedNames.add(PLUGIN_PROBE_ENV);

  const passthrough = env.ORGANUM_CODE_PASSTHROUGH_ENV?.trim();
  if (passthrough) {
    for (const rawName of passthrough.split(",")) {
      const name = rawName.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
          `Invalid environment name in ORGANUM_CODE_PASSTHROUGH_ENV: ${JSON.stringify(name)}`,
        );
      }
      allowedNames.add(name);
    }
  }

  for (const name of allowedNames) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }

  const result: NodeJS.ProcessEnv = {
    ...childEnv,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    [ORGANUM_CODE_ROLE_ENV]: config.default_agent.replace(/^organum-/, ""),
  };

  const intent = env[ORGANUM_CODE_INTENT_ENV]?.trim();
  if (intent) {
    if (intent.includes("\0") || Buffer.byteLength(intent, "utf8") > 512) {
      throw new Error(`${ORGANUM_CODE_INTENT_ENV} must be at most 512 UTF-8 bytes`);
    }
    result[ORGANUM_CODE_INTENT_ENV] = intent;
  }
  const organumBinary = env[ORGANUM_CODE_ORGANUM_BIN_ENV]?.trim();
  if (organumBinary) {
    if (organumBinary.includes("\0")) {
      throw new Error(`${ORGANUM_CODE_ORGANUM_BIN_ENV} must not contain NUL`);
    }
    result[ORGANUM_CODE_ORGANUM_BIN_ENV] = organumBinary;
  }
  const persona = env[ORGANUM_CODE_PERSONA_ENV]?.trim();
  const workspace = env[ORGANUM_CODE_WORKSPACE_ENV]?.trim();
  if ((persona === undefined) !== (workspace === undefined)) {
    throw new Error(
      `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must be set together`,
    );
  }
  if (persona !== undefined && workspace !== undefined) {
    if (!isValidCellIdentity(persona) || !isValidCellIdentity(workspace)) {
      throw new Error(
        `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must use the canonical Organum identity grammar`,
      );
    }
    result[ORGANUM_CODE_PERSONA_ENV] = persona;
    result[ORGANUM_CODE_WORKSPACE_ENV] = workspace;
  }
  const hubDirectory = env[ORGANUM_CODE_HUB_DIRECTORY_ENV]?.trim();
  if (hubDirectory !== undefined) {
    if (
      hubDirectory.length === 0 ||
      hubDirectory.includes("\0") ||
      !isAbsolute(hubDirectory)
    ) {
      throw new Error(
        `${ORGANUM_CODE_HUB_DIRECTORY_ENV} must be a nonempty absolute path`,
      );
    }
    result[ORGANUM_CODE_HUB_DIRECTORY_ENV] = resolve(hubDirectory);
  }
  const projectContract = env[ORGANUM_CODE_PROJECT_CONTRACT_ENV]?.trim();
  if (projectContract) {
    if (
      projectContract.includes("\0") ||
      Buffer.byteLength(projectContract, "utf8") > 1024
    ) {
      throw new Error(
        `${ORGANUM_CODE_PROJECT_CONTRACT_ENV} must be a path of at most 1024 UTF-8 bytes`,
      );
    }
    result[ORGANUM_CODE_PROJECT_CONTRACT_ENV] = projectContract;
  }

  const castReceipt = env[ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV]?.trim();
  if (castReceipt !== undefined) {
    if (
      castReceipt.length === 0 ||
      castReceipt.includes("\0") ||
      !isAbsolute(castReceipt) ||
      Buffer.byteLength(castReceipt, "utf8") > 4_096
    ) {
      throw new Error(
        `${ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV} must be a bounded absolute path`,
      );
    }
    result[ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV] = resolve(castReceipt);
  }

  Object.assign(result, buildOrganumBenchmarkEnvironment(env));

  if (firstPartyPluginEnabled(env)) {
    isolateExternalPluginConfiguration(result, env, configDirectory);
    const requestedStateDirectory =
      env[ORGANUM_CODE_STATE_DIRECTORY_ENV]?.trim();
    if (requestedStateDirectory !== undefined) {
      if (
        requestedStateDirectory.length === 0 ||
        requestedStateDirectory.includes("\0") ||
        !isAbsolute(requestedStateDirectory)
      ) {
        throw new Error(
          `${ORGANUM_CODE_STATE_DIRECTORY_ENV} must be a nonempty absolute path`,
        );
      }
      result[ORGANUM_CODE_STATE_DIRECTORY_ENV] = resolve(
        requestedStateDirectory,
      );
    } else if (persona !== undefined) {
      const stateHome = result.XDG_STATE_HOME?.trim();
      if (
        stateHome === undefined ||
        stateHome.length === 0 ||
        stateHome.includes("\0") ||
        !isAbsolute(stateHome)
      ) {
        throw new Error(
          `${ORGANUM_CODE_STATE_DIRECTORY_ENV} or an absolute host XDG_STATE_HOME is required for hub admission durability`,
        );
      }
      result[ORGANUM_CODE_STATE_DIRECTORY_ENV] = join(
        resolve(stateHome),
        "organum-code",
      );
    }
  }

  return result;
}

function providerKeyEnvironment(value: string): string {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (match === null) {
    throw new Error(
      "OpenCode provider apiKey must be an {env:NAME} reference",
    );
  }
  return match[1];
}

/**
 * OpenCode 1.18.3 has two config consumers. The legacy runtime reads
 * OPENCODE_CONFIG_CONTENT, while the v2 /api runtime reads opencode.json from
 * OPENCODE_CONFIG_DIR. Keep the disk projection secret-free and let the v2
 * integration registry resolve credentials from the named environment.
 */
export function buildOpenCodeDiskConfig(config: OpenCodeConfig): unknown {
  return {
    ...config,
    provider: Object.fromEntries(
      Object.entries(config.provider).map(([id, provider]) => [
        id,
        {
          ...provider,
          env: [providerKeyEnvironment(provider.options.apiKey)],
          options: {
            ...provider.options,
            apiKey: undefined,
          },
        },
      ]),
    ),
  };
}

export async function materializeOpenCodeConfig(
  configDirectory: string,
  config: OpenCodeConfig,
): Promise<string> {
  const path = join(configDirectory, "opencode.json");
  await writeFile(path, `${JSON.stringify(buildOpenCodeDiskConfig(config), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return path;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

export async function launchOpenCode(
  args: readonly string[],
  config: OpenCodeConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  const childArgs = buildOpenCodeArgs(args, env);
  const configDirectory = await mkdtemp(join(tmpdir(), "organum-code-"));
  const binary = resolveOpenCodeBinary(env);

  try {
    await materializeOpenCodeConfig(configDirectory, config);
    if (firstPartyPluginEnabled(env)) {
      await packageFirstPartyPlugin(configDirectory);
    }
    const childEnv = buildChildEnvironment(env, config, configDirectory);

    return await new Promise<number>((resolve, reject) => {
      const child = spawn(binary, childArgs, {
        cwd,
        env: childEnv,
        stdio: "inherit",
      });

      const forwardInterrupt = () => child.kill("SIGINT");
      const forwardTermination = () => child.kill("SIGTERM");
      const cleanupListeners = () => {
        process.off("SIGINT", forwardInterrupt);
        process.off("SIGTERM", forwardTermination);
      };

      process.once("SIGINT", forwardInterrupt);
      process.once("SIGTERM", forwardTermination);
      child.once("error", (error) => {
        cleanupListeners();
        reject(error);
      });
      child.once("close", (code, signal) => {
        cleanupListeners();
        resolve(code ?? signalExitCode(signal));
      });
    });
  } finally {
    if (firstPartyPluginEnabled(env)) {
      await unsealFirstPartyPlugin(configDirectory);
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
}
