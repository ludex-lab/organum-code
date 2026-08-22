import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { buildBackendProbeEnvironment } from "./backend-catalog.js";
import {
  validateOrganumMcpHttpServer,
  type OrganumMcpHttpServer,
} from "./organum-mcp.js";

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

export interface AgyInstallation {
  binary: string;
  version: string;
}

export interface AgyHeadlessOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  mode?: "plan" | "accept-edits";
  printTimeout?: string;
  resume?: boolean;
}

export interface AgyRuntimePaths {
  home: string;
  mcpConfig: string;
  settings: string;
}

function boundedText(value: string, context: string, maxBytes: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > maxBytes
  ) {
    throw new Error(`${context} must be nonempty, NUL-free, and at most ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

function timeout(value: string): string {
  const normalized = boundedText(value, "Agy print timeout", 32);
  if (!/^[1-9]\d*(?:ms|s|m|h)(?:[1-9]\d*(?:ms|s|m|h))*$/.test(normalized)) {
    throw new Error("Agy print timeout must use a positive Go duration");
  }
  return normalized;
}

export function resolveAgyBinary(env: NodeJS.ProcessEnv): string {
  return env.ORGANUM_CODE_AGY_BIN?.trim() || "agy";
}

export function inspectAgy(env: NodeJS.ProcessEnv): AgyInstallation {
  const binary = resolveAgyBinary(env);
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: buildBackendProbeEnvironment(env),
  });
  if (result.error !== undefined) {
    throw new Error(
      `Unable to run Agy binary ${JSON.stringify(binary)}: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (result.status !== 0 || version.length === 0) {
    throw new Error(
      `Agy version check failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return { binary, version: version.split(/\r?\n/, 1)[0] };
}

export function buildAgyHeadlessArgs(
  prompt: string,
  options: AgyHeadlessOptions = {},
): string[] {
  const args = [
    ...(options.resume === true ? ["--continue"] : []),
    "--print",
    boundedText(prompt, "Agy prompt", 1024 * 1024),
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--sandbox",
    "--mode",
    options.mode ?? "accept-edits",
    "--print-timeout",
    timeout(options.printTimeout ?? "30m"),
  ];
  if (options.model !== undefined) {
    args.push("--model", boundedText(options.model, "Agy model", 128));
  }
  if (options.effort !== undefined) {
    args.push("--effort", options.effort);
  }
  return args;
}

export function agyRuntimePaths(runtimeDirectory: string): AgyRuntimePaths {
  const root = resolve(runtimeDirectory);
  const home = join(root, "home");
  return {
    home,
    mcpConfig: join(home, ".gemini", "config", "mcp_config.json"),
    settings: join(home, ".gemini", "antigravity-cli", "settings.json"),
  };
}

export function buildAgyChildEnvironment(
  env: NodeJS.ProcessEnv,
  runtimeDirectory: string,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  const paths = agyRuntimePaths(runtimeDirectory);
  child.HOME = paths.home;
  child.XDG_CONFIG_HOME = join(paths.home, ".config");
  child.NO_COLOR = env.NO_COLOR ?? "1";
  return child;
}

export function buildAgyMcpConfig(
  server: OrganumMcpHttpServer,
): string {
  const admitted = validateOrganumMcpHttpServer(server);
  return `${JSON.stringify({
    mcpServers: {
      [admitted.name]: {
        serverUrl: admitted.url,
        headers: {
          Authorization: admitted.headers[0].value,
        },
      },
    },
  }, null, 2)}\n`;
}
