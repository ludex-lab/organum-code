import { spawnSync } from "node:child_process";

import type { ConfiguredBackend } from "./user-config.js";

export type BackendCatalogID = ConfiguredBackend | "agy";

export interface BackendCatalogEntry {
  id: BackendCatalogID;
  label: string;
  binary: string;
  installed: boolean;
  version?: string;
  adapterReady: boolean;
  installURL: string;
  installHint: string;
}

export interface BackendVersionResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

export type BackendVersionRunner = (
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => BackendVersionResult;

const DEFINITIONS: ReadonlyArray<{
  id: BackendCatalogID;
  label: string;
  defaultBinary: string;
  binaryEnvironment: string;
  adapterReady: boolean;
  installURL: string;
  installHint: string;
}> = [
  {
    id: "claude",
    label: "Claude Code",
    defaultBinary: "claude",
    binaryEnvironment: "ORGANUM_CODE_CLAUDE_BIN",
    adapterReady: true,
    installURL: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "opencode",
    label: "OpenCode",
    defaultBinary: "opencode",
    binaryEnvironment: "ORGANUM_CODE_OPENCODE_BIN",
    adapterReady: true,
    installURL: "https://opencode.ai/docs",
    installHint: "brew install anomalyco/tap/opencode",
  },
  {
    id: "grok",
    label: "Grok Build",
    defaultBinary: "grok",
    binaryEnvironment: "ORGANUM_CODE_GROK_BIN",
    adapterReady: true,
    installURL: "https://docs.x.ai/build/overview",
    installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
  {
    id: "deepcode",
    label: "Deep Code CLI",
    defaultBinary: "deepcode",
    binaryEnvironment: "ORGANUM_CODE_DEEPCODE_BIN",
    adapterReady: true,
    installURL: "https://github.com/lessweb/deepcode-cli",
    installHint: "npm install -g @vegamo/deepcode-cli",
  },
  {
    id: "codex",
    label: "Codex CLI",
    defaultBinary: "codex",
    binaryEnvironment: "ORGANUM_CODE_CODEX_BIN",
    adapterReady: true,
    installURL: "https://developers.openai.com/codex/cli",
    installHint: "npm install -g @openai/codex",
  },
  {
    id: "cursor",
    label: "Cursor Agent CLI",
    defaultBinary: "cursor-agent",
    binaryEnvironment: "ORGANUM_CODE_CURSOR_BIN",
    // The signed-Hub vertical is explicit and actor-owned. Do not offer
    // Cursor as the configurator's general TUI until its ordinary launch and
    // native-subscription product contract is admitted separately.
    adapterReady: false,
    installURL: "https://docs.cursor.com/en/cli/installation",
    installHint: "curl https://cursor.com/install -fsS | bash",
  },
  {
    id: "agy",
    label: "Antigravity CLI",
    defaultBinary: "agy",
    binaryEnvironment: "ORGANUM_CODE_AGY_BIN",
    // Agy authenticates through the OS keyring and talks directly to the
    // Antigravity harness. It must not be presented as selectable until the
    // native-auth containment boundary is admitted separately from API brokers.
    adapterReady: false,
    installURL: "https://antigravity.google/docs/cli/install",
    installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
];

function defaultRunner(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): BackendVersionResult {
  return spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 5_000,
    env,
  });
}

export function buildBackendProbeEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of [
    "ComSpec",
    "LANG",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TERM",
    "WINDIR",
  ]) {
    if (env[name] !== undefined) safe[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) safe[name] = value;
  }
  return safe;
}

function renderedOutput(result: BackendVersionResult): string | undefined {
  for (const output of [result.stdout, result.stderr]) {
    const rendered = output?.toString().trim();
    if (rendered) return rendered.split(/\r?\n/, 1)[0];
  }
  return undefined;
}

export function inspectBackendCatalog(
  env: NodeJS.ProcessEnv,
  runner: BackendVersionRunner = defaultRunner,
): BackendCatalogEntry[] {
  const probeEnvironment = buildBackendProbeEnvironment(env);
  return DEFINITIONS.map((definition) => {
    const binary =
      env[definition.binaryEnvironment]?.trim() || definition.defaultBinary;
    const result = runner(binary, ["--version"], probeEnvironment);
    const version = renderedOutput(result);
    const installed =
      result.error === undefined && result.status === 0 && version !== undefined;
    return {
      id: definition.id,
      label: definition.label,
      binary,
      installed,
      ...(installed ? { version } : {}),
      adapterReady: definition.adapterReady,
      installURL: definition.installURL,
      installHint: definition.installHint,
    };
  });
}

export function selectableBackends(
  catalog: readonly BackendCatalogEntry[],
): BackendCatalogEntry[] {
  return catalog.filter((entry) => entry.installed && entry.adapterReady);
}
