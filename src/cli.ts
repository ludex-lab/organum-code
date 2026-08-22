import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { buildOpenCodeConfig } from "./opencode-config.js";
import {
  allocateActorRuntime,
  normalizeActorName,
  type AllocatedActorRuntime,
} from "./actor-runtime.js";
import {
  runConfigurator,
  terminalConfiguratorIO,
  type ConfiguratorIO,
} from "./configurator.js";
import {
  inspectClaudeCode,
  launchClaudeCode,
} from "./claude-launcher.js";
import {
  claudeSignedHubModelID,
  inspectClaudeSignedHub,
  launchClaudeSignedHub,
} from "./claude-signed-hub-launcher.js";
import {
  ClaudeSignedHubAdapter,
  parseClaudeSignedHubCommand,
} from "./claude-signed-hub.js";
import {
  ClaudeNativeToolResponseProjection,
  type ClaudeNativeToolProjectionApprovalContext,
} from "./claude-native-tool-response-projection.js";
import {
  createClaudeNativeToolAuxiliaryHandler,
  ClaudeNativeToolSupervisor,
  type ClaudeNativeToolProposal,
} from "./claude-native-tool-supervisor.js";
import { CLAUDE_NATIVE_TOOL_HOOK_PATH } from "./claude-native-tool-hook.js";
import {
  firstPartyPluginEnabled,
  inspectOpenCode,
  launchOpenCode,
} from "./opencode-launcher.js";
import {
  ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV,
  prepareOpenCodeCastReceipt,
  readOpenCodeCastReceipt,
  type OpenCodeCastReceipt,
} from "./opencode-cast-receipt.js";
import {
  inspectGrokBuild,
  launchGrokBuild,
  normalizeGrokChatCompletionsSseEvent,
} from "./grok-launcher.js";
import {
  GrokNativeToolCapabilityTransport,
  GrokNativeToolResponseProjection,
  type GrokNativeToolProjectionApprovalContext,
} from "./grok-native-tool-response-projection.js";
import {
  createGrokNativeToolAuxiliaryHandler,
  GROK_NATIVE_TOOL_CONSUME_PATH,
  GrokNativeToolSupervisor,
  type GrokNativeToolProposal,
} from "./grok-native-tool-supervisor.js";
import {
  formatGrokRuntimeHealth,
  type GrokRuntimeHealthObserver,
} from "./grok-runtime-health.js";
import {
  parseGrokAcpCommand,
  parseGrokAcpTimeout,
  runGrokAcp,
  textFromAcpAgentUpdate,
} from "./grok-acp-runner.js";
import {
  GrokAcpSignedHubNoTurnError,
  SignedHubNoTurnError,
  loadGrokAcpSignedHubTurn,
  loadSignedHubTurn,
  ORGANUM_CODE_SIGNED_HUB_TURN_FILE_ENV,
} from "./grok-acp-signed-hub.js";
import {
  inspectDeepCode,
  launchDeepCode,
  normalizeDeepCodeChatCompletionsRequest,
} from "./deepcode-launcher.js";
import {
  DeepCodeSignedHubAdapter,
  parseDeepCodeSignedHubCommand,
} from "./deepcode-signed-hub.js";
import {
  inspectCodex,
  launchCodex,
} from "./codex-launcher.js";
import {
  CodexSignedHubAdapter,
  parseCodexSignedHubCommand,
} from "./codex-signed-hub.js";
import {
  cursorModelID,
  inspectCursor,
  launchCursorSignedHub,
} from "./cursor-launcher.js";
import {
  CursorSignedHubAdapter,
  parseCursorSignedHubCommand,
} from "./cursor-signed-hub.js";
import {
  assertClaudeS16OperationalEnvironment,
  assertGrokS16OperationalEnvironment,
} from "./native-tool-operational-admission.js";
import type { NativeToolDecider } from "./native-tool-approval.js";
import {
  brokerModeForProvider,
  buildBrokerLaunchEnvironment,
  createBrokeredProviderProfile,
  InferenceBroker,
  type InferenceBrokerAuxiliaryHandler,
  type InferenceBrokerSnapshot,
} from "./inference-broker.js";
import {
  ConfigurationError,
  loadProviderProfile,
} from "./provider-profile.js";
import { organumCodeVersionLine } from "./product.js";
import { runReleaseCommand } from "./release-cli.js";
import {
  assertCodingModelCapabilities,
  providerBrokerPolicy,
} from "./provider-policy.js";
import { loadProviderSecret } from "./provider-secret.js";
import {
  createGrokAdaptiveExecutionBudget,
  parseExecutionBudgetMode,
  type ExecutionBudgetMode,
} from "./execution-budget.js";
import {
  configToEnvironment,
  loadUserConfig,
  normalizeUserProfileName,
  resolveProfileConfigPath,
  type UserConfig,
} from "./user-config.js";
import {
  buildGrokAcpObservation,
  buildAndEmitOrganumCodeObservation,
  buildTerminalObservation,
} from "./observation-emitter.js";
import {
  finalizeNativeInteractiveLaunch,
  planNativeInteractiveLaunch,
  type NativeInteractiveLaunchPlan,
} from "./native-interactive-lifecycle.js";
import {
  createNativeProductLifecycle,
  type NativeProductLifecycle,
} from "./native-product-lifecycle.js";
import {
  bindOrganismCastCoordinationPacket,
  loadOrganismCastPlan,
  organismCastCheck,
  runOrganismCast,
} from "./organism-cast.js";
import {
  OrganismCastBrokerCoordination,
} from "./organism-cast-broker-coordination.js";
import { runOrganismCastSupervisorCLI } from "./organism-cast-supervisor-cli.js";
import { FileProviderUsageLedger } from "./provider-usage-ledger.js";
import { HarnessProvenanceCollector } from "./harness-provenance.js";
import {
  formatHubSupervisorDoctor,
  runHubSupervisorDoctor,
} from "./hub-supervisor-doctor.js";
import {
  parseSignedHubOperatorCommand,
  runSignedHubOperator,
} from "./signed-hub-operator.js";

const HELP = `Organum Code

Use an API-backed brain through a brokered coding harness.

Usage:
  organum-code --version       Print the internal-preview product version
  organum-code release install --prefix ABSOLUTE_PATH --artifact PATH --manifest PATH --checksum PATH
                               Install one verified offline release bundle
  organum-code release status --prefix ABSOLUTE_PATH
                               Verify one managed local installation
  organum-code                 Launch the configured TUI (first run opens setup)
  organum-code configure [--profile NAME]
                               Configure the default or one named actor profile
  organum-code --profile NAME [backend] [args]
                               Launch one named actor profile
  organum-code --actor NAME --profile NAME [claude|grok|deepcode|codex|cursor] [args]
                               Launch or resume one persistent native actor
  organum-code --actor NAME grok acp "<prompt>"
                               Run one coordinated Grok ACP turn
  organum-code --actor NAME grok acp --signed-hub
                               Consume one signed Hub critic/review turn
  organum-code --actor NAME claude --signed-hub
                               Consume one signed Hub turn through Claude Code
  organum-code --actor NAME codex --signed-hub
                               Consume one signed Hub turn through Codex exec
  organum-code --actor NAME deepcode --signed-hub
                               Consume one signed Hub turn through Deep Code
  organum-code --actor NAME cursor --signed-hub
                               Consume one signed Hub turn through Cursor ask mode
  organum-code --actor NAME hub setup|status|recover [--backend grok|claude|codex|deepcode|cursor]
                               Preflight or recover signed Hub state without a provider
  organum-code cast check <manifest>
                               Validate one provider-zero organism cast
  organum-code cast supervisor prepare|start [...]
                               Run the provider-zero Track B producer boundary
  organum-code cast run <manifest>
                               Run a JJ_GO-authorized external cast
  organum-code opencode [args] Launch OpenCode through the broker
  organum-code claude [args]   Launch Claude Code through the Solar bridge
  organum-code grok [args]     Launch Grok Build through the broker
  organum-code deepcode [args] Launch Deep Code CLI through the broker
  organum-code codex [args]    Launch Codex CLI through a provider adapter
  organum-code cursor --signed-hub
                               Launch the bounded native-subscription Cursor adapter
  organum-code run <prompt>    Run one OpenCode prompt
  organum-code doctor          Validate environment and the selected TUI
  organum-code config          Print the generated secret-free config
  organum-code -- <args...>    Pass arguments through to the selected TUI

Persistent configuration:
  ~/.config/organum-code/config.json
                               Secret-free provider, model, and default TUI
  ORGANUM_CODE_CONFIG_FILE     Override the config path (must be absolute)
  ORGANUM_CODE_PROFILE         Named actor profile (same as --profile)
  ORGANUM_CODE_ACTOR           Restartable actor instance (same as --actor)

Environment-only configuration (also overrides saved values):
  ORGANUM_CODE_BASE_URL        OpenAI-compatible API base URL
  ORGANUM_CODE_MODEL           Exact provider model ID

Provider key sources (auto order: existing env, explicit file, macOS Keychain):
  ORGANUM_CODE_API_KEY         Provider API key (name is configurable)
  ORGANUM_CODE_SECRET_SOURCE   auto, environment, dotenv, or keychain
  ORGANUM_CODE_SECRET_FILE     Absolute private dotenv file outside workspace
  ORGANUM_CODE_KEYCHAIN_SERVICE
                               Default: organum-code.<provider-id>
  ORGANUM_CODE_KEYCHAIN_ACCOUNT Default: profile name, or default

Optional environment:
  ORGANUM_CODE_PROVIDER_ID     Default: organum-brain
  ORGANUM_CODE_PROVIDER_NAME   Default: Organum Brain
  ORGANUM_CODE_MODEL_NAME      Display name; defaults to model ID
  ORGANUM_CODE_API_KEY_ENV     Name of the key variable
  ORGANUM_CODE_CURSOR_BIN      Cursor CLI executable; default: cursor-agent
  ORGANUM_CODE_CURSOR_MODEL    Exact model selector for Cursor signed-Hub turns
  ORGANUM_CODE_PROTOCOL        chat-completions (default) or responses
  ORGANUM_CODE_CAPABILITY_STREAMING
  ORGANUM_CODE_CAPABILITY_TOOL_CALLING
  ORGANUM_CODE_CAPABILITY_REASONING
                               supported, unsupported, or unknown (default)
  ORGANUM_CODE_ROUTING_KIND    openrouter (optional Chat routing adapter)
  ORGANUM_CODE_ROUTING_FALLBACK_MODELS
                               Comma-separated model fallbacks (max 8)
  ORGANUM_CODE_ROUTING_PROVIDER_ORDER
                               Comma-separated provider slugs (max 16)
  ORGANUM_CODE_ROUTING_SORT    price, throughput, or latency
  ORGANUM_CODE_ROUTING_MAX_PROMPT_PRICE
  ORGANUM_CODE_ROUTING_MAX_COMPLETION_PRICE
                               OpenRouter USD / 1M token ceilings
  ORGANUM_CODE_ROLE            implementer (default), reviewer, critic, researcher
  ORGANUM_CODE_INTENT          Bounded Organum session intent (max 512 UTF-8 bytes)
  ORGANUM_CODE_ORGANUM_BIN     Organum executable; default: organum
  ORGANUM_CODE_PERSONA        Hub persona; requires ORGANUM_CODE_WORKSPACE
  ORGANUM_CODE_WORKSPACE      Stable hub workspace key; requires PERSONA
  ORGANUM_CODE_HUB_DIR        Optional absolute Organum home-hub directory
  ORGANUM_CODE_STATE_DIR      Durable actor state; defaults under XDG_STATE_HOME
  ORGANUM_CODE_SIGNED_HUB_DIR Absolute Organum Hub 0.4.5 directory for supervisor intake
  ORGANUM_CODE_SIGNED_HUB_BIN Organum Hub executable; default: organum-hub
  ORGANUM_CODE_SIGNED_HUB_PROTOCOL
                               Must equal 0.4.5 when the signed Hub runtime is configured
  ORGANUM_CODE_SIGNED_HUB_WIRE_URL
                               Optional HTTPS carrier health endpoint for doctor
  ORGANUM_CODE_SIGNED_HUB_CARRIER_TOKEN
                               Optional supervisor-only carrier credential; never sent to a backend
  ORGANUM_CODE_SIGNED_HUB_TURN_FILE
                               Private absolute signed-Hub turn manifest
  ORGANUM_CODE_PROJECT_CONTRACT
                               Explicit project instruction file (highest authority)
  ORGANUM_CODE_OPENCODE_BIN    OpenCode executable; default: opencode
  ORGANUM_CODE_CLAUDE_BIN      Claude Code executable; default: claude
  ORGANUM_CODE_CLAUDE_MODEL    Broker-advertised Claude model name
  ORGANUM_CODE_CLAUDE_SIGNED_HUB_MODEL
                               Exact full Claude model ID for native signed-Hub turns
  ORGANUM_CODE_GROK_BIN        Grok Build executable; default: grok
  ORGANUM_CODE_DEEPCODE_BIN    Deep Code executable; default: deepcode
  ORGANUM_CODE_CODEX_BIN       Codex executable; default: codex
  ORGANUM_CODE_BACKEND         opencode, claude, grok, deepcode, or codex
  ORGANUM_CODE_FIRST_PARTY_PLUGIN=0
                               Disable the bundled plugin and use OpenCode --pure
  ORGANUM_CODE_PASSTHROUGH_ENV Comma-separated extra child environment names
  ORGANUM_CODE_BROKER=0        Unsafe legacy direct-key mode; broker is default
  ORGANUM_CODE_EXECUTION_BUDGET adaptive or off; defaults to off
  ORGANUM_CODE_COORDINATION    on (default) or off for a persistent actor
  ORGANUM_CODE_GROK_NATIVE_TOOL_PROJECTION=1
                               Experimental exact one-shot terminal mediation
                               for Grok --single/-p on macOS
  ORGANUM_CODE_CLAUDE_NATIVE_TOOL_PROJECTION=1
                               Experimental exact one-shot Bash mediation for
                               a new Claude --print/-p turn on macOS
  ORGANUM_CODE_ACP_TIMEOUT_MS  Grok ACP turn deadline; default: 1800000
  ORGANUM_CODE_USAGE_REPORT=json
                               Print one secret-free provider usage report on exit
                               (automatic for Gemini, Groq, and OpenCode Zen presets)
  ORGANUM_CODE_HARNESS_PROVENANCE=json
                               Print the secret-free observed-request provenance/v1
                               projection on stderr after broker settlement
  ORGANUM_CODE_HARNESS_CWD_POLICY
                               same-clean-synthetic-git-fixture or unspecified
  ORGANUM_CODE_HARNESS_FIXTURE_SHA256
                               Caller-supplied fixture digest; required by the
                               same-clean-synthetic-git-fixture policy
  ORGANUM_CODE_OBSERVATION     auto (default), artifact, off, or required
                               Persist observation/v1; artifact skips ingestion
`;

export function brokerEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.ORGANUM_CODE_BROKER?.trim();
  if (value === undefined || value === "" || value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") return false;
  throw new Error("ORGANUM_CODE_BROKER must be 1, 0, true, or false");
}

export function nativeCoordinationEnabled(
  env: NodeJS.ProcessEnv,
  hasActor: boolean,
): boolean {
  const value = env.ORGANUM_CODE_COORDINATION?.trim().toLowerCase();
  if (value === undefined || value === "" || value === "on") return hasActor;
  if (value === "off") return false;
  throw new ConfigurationError(
    "ORGANUM_CODE_COORDINATION must be on or off",
  );
}

export interface HarnessProvenanceConfiguration {
  workspacePolicy: "same-clean-synthetic-git-fixture" | "unspecified";
  fixtureSha256: string | null;
}

export function harnessProvenanceConfiguration(
  env: NodeJS.ProcessEnv,
): HarnessProvenanceConfiguration | null {
  const mode = env.ORGANUM_CODE_HARNESS_PROVENANCE?.trim();
  if (mode === undefined || mode === "") return null;
  if (mode !== "json") {
    throw new ConfigurationError(
      "ORGANUM_CODE_HARNESS_PROVENANCE must be json when set",
    );
  }
  const policy = env.ORGANUM_CODE_HARNESS_CWD_POLICY?.trim() || "unspecified";
  if (
    policy !== "same-clean-synthetic-git-fixture" &&
    policy !== "unspecified"
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_HARNESS_CWD_POLICY must be same-clean-synthetic-git-fixture or unspecified",
    );
  }
  const digest = env.ORGANUM_CODE_HARNESS_FIXTURE_SHA256?.trim() || null;
  if (digest !== null && !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_HARNESS_FIXTURE_SHA256 must be a lowercase SHA-256 digest",
    );
  }
  if (policy === "same-clean-synthetic-git-fixture" && digest === null) {
    throw new ConfigurationError(
      "ORGANUM_CODE_HARNESS_FIXTURE_SHA256 is required for the synthetic fixture policy",
    );
  }
  if (policy === "unspecified" && digest !== null) {
    throw new ConfigurationError(
      "ORGANUM_CODE_HARNESS_FIXTURE_SHA256 requires the synthetic fixture policy",
    );
  }
  return { workspacePolicy: policy, fixtureSha256: digest };
}

function harnessMediation(
  backend: Backend,
  mode: "chat-completions" | "responses" | "responses-to-chat-completions" |
    "messages" | "messages-to-chat-completions",
): readonly string[] {
  if (backend === "claude") return ["anthropic-messages-to-chat-completions"];
  if (backend === "codex" && mode === "responses-to-chat-completions") {
    return ["responses-to-chat-completions"];
  }
  if (backend === "deepcode") {
    return ["drop-nonstandard-thinking-and-extra-body", "local-fixed-model-catalog"];
  }
  if (backend === "grok") {
    return [
      "empty-tool-name-sse-delta-normalization",
      "bind-session-summary-to-brokered-model",
    ];
  }
  return ["native-provider-protocol"];
}

type Backend =
  | "opencode"
  | "claude"
  | "grok"
  | "deepcode"
  | "codex"
  | "cursor";

export function executionBudgetMode(
  env: NodeJS.ProcessEnv,
  _backend: Backend,
): ExecutionBudgetMode {
  return parseExecutionBudgetMode(
    env.ORGANUM_CODE_EXECUTION_BUDGET,
    "off",
  );
}

export function grokNativeToolProjectionEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  const value = env.ORGANUM_CODE_GROK_NATIVE_TOOL_PROJECTION?.trim();
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") return true;
  throw new ConfigurationError(
    "ORGANUM_CODE_GROK_NATIVE_TOOL_PROJECTION must be 1, 0, true, or false",
  );
}

export function claudeNativeToolProjectionEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  const value = env.ORGANUM_CODE_CLAUDE_NATIVE_TOOL_PROJECTION?.trim();
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") return true;
  throw new ConfigurationError(
    "ORGANUM_CODE_CLAUDE_NATIVE_TOOL_PROJECTION must be 1, 0, true, or false",
  );
}

function safeGrokTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function approveGrokNativeToolProposal(
  proposal: Readonly<GrokNativeToolProposal>,
  context: Readonly<GrokNativeToolProjectionApprovalContext>,
): Promise<{
  approved: boolean;
  decider: string;
  provenance: NativeToolDecider;
}> {
  const command = typeof proposal.toolArguments.command === "string"
    ? proposal.toolArguments.command
    : "";
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return {
      approved: false,
      decider: "terminal-user-unavailable",
      provenance: {
        kind: "policy",
        policyId: "organum-native-noninteractive-deny",
        policyVersion: "1.0.0",
      },
    };
  }
  process.stderr.write(
    [
      "",
      "Organum Code Grok native terminal proposal",
      `call: ${safeGrokTerminalText(proposal.nativeToolCallId)}`,
      `request_sha256: ${context.requestBodySha256}`,
      `arguments_sha256: ${context.argumentSha256}`,
      "command:",
      safeGrokTerminalText(command),
      "",
    ].join("\n"),
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const answer = await terminal.question(
      "Allow this exact one-shot contained command? [y/N] ",
    );
    return {
      approved: /^(?:y|yes)$/i.test(answer.trim()),
      decider: "terminal-user",
      provenance: {
        kind: "human",
        presenter: "organum-code-terminal",
      },
    };
  } finally {
    terminal.close();
  }
}

async function approveClaudeNativeToolProposal(
  proposal: Readonly<ClaudeNativeToolProposal>,
  context: Readonly<ClaudeNativeToolProjectionApprovalContext>,
): Promise<{
  approved: boolean;
  decider: string;
  provenance: NativeToolDecider;
}> {
  const command = typeof proposal.toolArguments.command === "string"
    ? proposal.toolArguments.command
    : "";
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return {
      approved: false,
      decider: "terminal-user-unavailable",
      provenance: {
        kind: "policy",
        policyId: "organum-native-noninteractive-deny",
        policyVersion: "1.0.0",
      },
    };
  }
  process.stderr.write(
    [
      "",
      "Organum Code Claude native Bash proposal",
      `call: ${safeGrokTerminalText(proposal.nativeToolCallId)}`,
      `request_sha256: ${context.requestBodySha256}`,
      `arguments_sha256: ${context.argumentSha256}`,
      "command:",
      safeGrokTerminalText(command),
      "",
    ].join("\n"),
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const answer = await terminal.question(
      "Allow this exact one-shot contained Bash command? [y/N] ",
    );
    return {
      approved: /^(?:y|yes)$/i.test(answer.trim()),
      decider: "terminal-user",
      provenance: {
        kind: "human",
        presenter: "organum-code-terminal",
      },
    };
  } finally {
    terminal.close();
  }
}

function composeAuxiliaryHandlers(
  handlers: readonly (InferenceBrokerAuxiliaryHandler | undefined)[],
): InferenceBrokerAuxiliaryHandler | undefined {
  const admitted = handlers.filter(
    (handler): handler is InferenceBrokerAuxiliaryHandler =>
      handler !== undefined
  );
  if (admitted.length === 0) return undefined;
  return async (context) => {
    for (const handler of admitted) {
      if (await handler(context)) return true;
    }
    return false;
  };
}

export interface ParsedProfileArguments {
  profile?: string;
  actor?: string;
  args: readonly string[];
}

export function parseProfileArguments(
  args: readonly string[],
): ParsedProfileArguments {
  let profile: string | undefined;
  let actor: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      remaining.push(...args.slice(index));
      break;
    }
    let value: string | undefined;
    let kind: "profile" | "actor" | undefined;
    if (argument === "--profile") {
      value = args[index + 1];
      if (value === undefined) {
        throw new ConfigurationError("--profile requires a name");
      }
      kind = "profile";
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      value = argument.slice("--profile=".length);
      kind = "profile";
    } else if (argument === "--actor") {
      value = args[index + 1];
      if (value === undefined) {
        throw new ConfigurationError("--actor requires a name");
      }
      kind = "actor";
      index += 1;
    } else if (argument.startsWith("--actor=")) {
      value = argument.slice("--actor=".length);
      kind = "actor";
    }
    if (value === undefined) {
      remaining.push(argument);
      continue;
    }
    if (kind === "actor") {
      const normalized = normalizeActorName(value);
      if (actor !== undefined && actor !== normalized) {
        throw new ConfigurationError("Only one --actor may be selected");
      }
      actor = normalized;
      continue;
    }
    const normalized = normalizeUserProfileName(value);
    if (profile !== undefined && profile !== normalized) {
      throw new ConfigurationError("Only one --profile may be selected");
    }
    profile = normalized;
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(actor === undefined ? {} : { actor }),
    args: remaining,
  };
}

function selectedProfile(
  fromArguments: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromEnvironment = env.ORGANUM_CODE_PROFILE?.trim();
  if (!fromEnvironment) return fromArguments;
  const normalized = normalizeUserProfileName(fromEnvironment);
  if (fromArguments !== undefined && fromArguments !== normalized) {
    throw new ConfigurationError(
      "--profile conflicts with ORGANUM_CODE_PROFILE",
    );
  }
  return fromArguments ?? normalized;
}

export function selectedActorName(
  fromArguments: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromEnvironment = env.ORGANUM_CODE_ACTOR?.trim();
  if (!fromEnvironment) return fromArguments;
  const normalized = normalizeActorName(fromEnvironment);
  if (fromArguments !== undefined && fromArguments !== normalized) {
    throw new ConfigurationError(
      "--actor conflicts with ORGANUM_CODE_ACTOR",
    );
  }
  return fromArguments ?? normalized;
}

function selectedBackend(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { backend: Backend; args: readonly string[] } {
  if (
    args[0] === "opencode" ||
    args[0] === "claude" ||
    args[0] === "grok" ||
    args[0] === "deepcode" ||
    args[0] === "codex" ||
    args[0] === "cursor"
  ) {
    return { backend: args[0], args: args.slice(1) };
  }
  const configured = env.ORGANUM_CODE_BACKEND?.trim() || "opencode";
  if (
    configured !== "opencode" &&
    configured !== "claude" &&
    configured !== "grok" &&
    configured !== "deepcode" &&
    configured !== "codex" &&
    configured !== "cursor"
  ) {
    throw new Error(
      "ORGANUM_CODE_BACKEND must be opencode, claude, grok, deepcode, codex, or cursor",
    );
  }
  return { backend: configured, args };
}

export interface EffectiveUserEnvironment {
  env: NodeJS.ProcessEnv;
  config: UserConfig | null;
  configPath: string;
  configuredNow: boolean;
  profile: string | null;
}

function hasEnvironmentOnlyProfile(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.ORGANUM_CODE_BASE_URL?.trim() && env.ORGANUM_CODE_MODEL?.trim(),
  );
}

export async function resolveEffectiveUserEnvironment(
  env: NodeJS.ProcessEnv,
  options: {
    io?: ConfiguratorIO;
    workspace?: string;
    platform?: NodeJS.Platform;
    profile?: string;
  } = {},
): Promise<EffectiveUserEnvironment> {
  const io = options.io ?? terminalConfiguratorIO;
  const workspace = options.workspace ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const profile =
    options.profile === undefined
      ? undefined
      : normalizeUserProfileName(options.profile);
  const configPath = resolveProfileConfigPath(env, profile, platform);
  const existing = await loadUserConfig(configPath);
  if (existing !== null) {
    return {
      env: configToEnvironment(existing, env),
      config: existing,
      configPath,
      configuredNow: false,
      profile: profile ?? null,
    };
  }
  if (io.interactive) {
    const configured = await runConfigurator({
      io,
      env,
      configPath,
      workspace,
      profileName: profile,
      dependencies: { platform },
    });
    return {
      env: configToEnvironment(configured, env),
      config: configured,
      configPath,
      configuredNow: true,
      profile: profile ?? null,
    };
  }
  if (hasEnvironmentOnlyProfile(env)) {
    return {
      env: { ...env },
      config: null,
      configPath,
      configuredNow: false,
      profile: profile ?? null,
    };
  }
  throw new ConfigurationError(
    "No saved configuration was found. Run `organum-code configure` in a terminal, or set ORGANUM_CODE_BASE_URL and ORGANUM_CODE_MODEL for non-interactive use.",
  );
}

async function printDoctor(
  env: NodeJS.ProcessEnv,
  backend: Backend,
  actorRuntime: AllocatedActorRuntime | null,
): Promise<boolean> {
  const profile = loadProviderProfile(env, { requireApiKey: false });
  const secret = backend === "cursor"
    ? null
    : await loadProviderSecret(profile, env, {
        workspace: process.cwd(),
      });
  const installation =
    backend === "opencode"
      ? inspectOpenCode(env)
      : backend === "claude"
        ? inspectClaudeCode(env)
        : backend === "grok"
          ? inspectGrokBuild(env)
          : backend === "deepcode"
            ? inspectDeepCode(env)
            : backend === "codex"
              ? inspectCodex(env)
              : inspectCursor(env);
  const hub = await runHubSupervisorDoctor({ env, cwd: process.cwd() });

  console.log(`Organum Code doctor: ${hub.healthy ? "ok" : "FAIL"}`);
  console.log(`${backend}: ${installation.version} (${installation.binary})`);
  console.log(`Role: ${profile.role}`);
  if (backend === "cursor") {
    console.log(`Model: ${cursorModelID(env)}`);
    console.log("Provider access: native subscription");
    console.log("External network: Cursor vendor native");
  } else {
    console.log(`Provider: ${profile.providerID} (${profile.protocol})`);
    console.log(`Model: ${profile.modelID}`);
    console.log(`Base URL: ${profile.baseURL}`);
    console.log(
      `API key source: ${secret!.source.kind} (${secret!.source.label})`,
    );
    console.log(`Credential broker: ${brokerEnabled(env) ? "enabled" : "DISABLED"}`);
  }
  console.log(`Execution budget: ${executionBudgetMode(env, backend)}`);
  if (actorRuntime !== null) {
    console.log(`Actor: ${actorRuntime.actor} (persistent)`);
    console.log(`Actor runtime: ${actorRuntime.runtimeDirectory}`);
  }
  for (const line of formatHubSupervisorDoctor(hub)) console.log(line);
  return hub.healthy;
}

function printUsageSnapshot(
  backend: Backend,
  profile: ReturnType<typeof loadProviderProfile>,
  snapshot: InferenceBrokerSnapshot,
): void {
  console.error(
    JSON.stringify({
      schema: "organum-code/provider-usage/v1",
      backend,
      provider: profile.providerID,
      model: profile.modelID,
      upstream_requests: snapshot.upstreamRequests,
      rejected_requests: snapshot.rejectedRequests,
      cancelled_requests: snapshot.cancelledRequests,
      rate_limit: snapshot.rateLimit,
      usage: snapshot.usage,
      execution_budget: snapshot.executionBudget ?? null,
    }),
  );
}

interface CastObservationContext {
  runID: string;
  runDirectory: string;
  arm: "organum" | "bare";
  pack: string;
  lane: string;
  comparisonKey: string;
  preregistrationID: string;
  promptSha256: string;
}

function castObservationContext(
  env: NodeJS.ProcessEnv,
): CastObservationContext | null {
  const enabled = env.ORGANUM_CODE_CAST_LANE?.trim();
  if (enabled === undefined || enabled === "") return null;
  if (enabled !== "1") {
    throw new ConfigurationError("ORGANUM_CODE_CAST_LANE must be 1 when set");
  }
  const arm = env.ORGANUM_CODE_CAST_ARM?.trim();
  const runID = env.ORGANUM_CODE_CAST_RUN_ID?.trim();
  const rawRunDirectory =
    env.ORGANUM_CODE_CAST_RUN_DIRECTORY?.trim();
  const pack = env.ORGANUM_CODE_CAST_PACK?.trim();
  const lane = env.ORGANUM_CODE_CAST_LANE_ID?.trim();
  const comparisonKey = env.ORGANUM_CODE_CAST_COMPARISON_KEY?.trim();
  const preregistrationID =
    env.ORGANUM_CODE_CAST_PREREGISTRATION_ID?.trim();
  const promptSha256 =
    env.ORGANUM_CODE_CAST_PROMPT_SHA256?.trim();
  if (
    (arm !== "organum" && arm !== "bare") ||
    runID === undefined ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runID) ||
    rawRunDirectory === undefined ||
    !isAbsolute(rawRunDirectory) ||
    rawRunDirectory.includes("\0") ||
    Buffer.byteLength(rawRunDirectory, "utf8") > 4_096 ||
    pack === undefined ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pack) ||
    lane === undefined ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(lane) ||
    comparisonKey === undefined ||
    !/^[0-9a-f]{64}$/.test(comparisonKey) ||
    preregistrationID === undefined ||
    preregistrationID.length === 0 ||
    preregistrationID.length > 256 ||
    promptSha256 === undefined ||
    !/^[0-9a-f]{64}$/.test(promptSha256)
  ) {
    throw new ConfigurationError(
      "Organism cast observation binding is incomplete or invalid",
    );
  }
  return {
    runID,
    runDirectory: resolve(rawRunDirectory),
    arm,
    pack,
    lane,
    comparisonKey,
    preregistrationID,
    promptSha256,
  };
}

const reportGrokRuntimeHealth: GrokRuntimeHealthObserver = (report, phase) => {
  console.error(formatGrokRuntimeHealth(report, phase));
};

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseProfileArguments(args);
  args = parsed.args;
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "version" || args[0] === "--version" || args[0] === "-V") {
    if (args.length !== 1) {
      throw new ConfigurationError("version accepts no additional arguments");
    }
    console.log(organumCodeVersionLine());
    return 0;
  }
  if (args[0] === "release") {
    console.log(JSON.stringify(await runReleaseCommand(args.slice(1))));
    return 0;
  }

  const actorProfile = selectedProfile(parsed.profile, env);
  const actorName = selectedActorName(parsed.actor, env);
  const configPath = resolveProfileConfigPath(env, actorProfile);
  const hubOperation = parseSignedHubOperatorCommand(args);
  if (hubOperation !== null) {
    if (actorName === undefined) {
      throw new ConfigurationError(
        "Signed Hub operator commands require --actor for durable state ownership",
      );
    }
    const actorRuntime = await allocateActorRuntime({
      actor: actorName,
      profile: actorProfile,
      backend: hubOperation.backend,
      workspace: process.cwd(),
      env,
    });
    const result = await runSignedHubOperator({
      operation: hubOperation.operation,
      environment: env,
      directory: process.cwd(),
      actorRuntime,
    });
    console.log(JSON.stringify(result.report, null, 2));
    return result.exitCode;
  }
  if (args[0] === "cast") {
    if (actorName !== undefined || actorProfile !== undefined) {
      throw new ConfigurationError(
        "cast owns every lane actor and profile; do not select a top-level actor or profile",
      );
    }
    const operation = args[1];
    if (operation === "supervisor") {
      return await runOrganismCastSupervisorCLI(args.slice(2));
    }
    const manifest = args[2];
    if (
      (operation !== "check" && operation !== "run") ||
      manifest === undefined ||
      args.length !== 3
    ) {
      throw new ConfigurationError(
        "cast requires exactly `check <manifest>` or `run <manifest>`",
      );
    }
    const plan = await loadOrganismCastPlan(manifest);
    if (operation === "check") {
      console.log(JSON.stringify(organismCastCheck(plan), null, 2));
      return 0;
    }
    if (env.JJ_GO !== "1") {
      throw new ConfigurationError(
        "cast run requires fresh explicit provider-active authorization through JJ_GO=1",
      );
    }
    const result = await runOrganismCast(plan);
    console.log(JSON.stringify(result, null, 2));
    return result.completed ? 0 : 2;
  }
  if (args[0] === "configure") {
    if (actorName !== undefined) {
      throw new ConfigurationError(
        "--actor does not apply to profile configuration",
      );
    }
    const existing = await loadUserConfig(configPath);
    await runConfigurator({
      io: terminalConfiguratorIO,
      env,
      configPath,
      workspace: process.cwd(),
      existing,
      profileName: actorProfile,
    });
    return 0;
  }

  const effective = await resolveEffectiveUserEnvironment(env, {
    profile: actorProfile,
  });
  env = effective.env;
  const castContext = castObservationContext(env);

  const selected = selectedBackend(args, env);
  const claudeSignedHubCommand = selected.backend === "claude"
    ? parseClaudeSignedHubCommand(selected.args)
    : null;
  const codexSignedHubCommand = selected.backend === "codex"
    ? parseCodexSignedHubCommand(selected.args)
    : null;
  const deepCodeSignedHubCommand = selected.backend === "deepcode"
    ? parseDeepCodeSignedHubCommand(selected.args)
    : null;
  const cursorSignedHubCommand = selected.backend === "cursor"
    ? parseCursorSignedHubCommand(selected.args)
    : null;
  const provenanceConfiguration = harnessProvenanceConfiguration(env);
  const usageReport = env.ORGANUM_CODE_USAGE_REPORT?.trim();
  if (usageReport !== undefined && usageReport !== "" && usageReport !== "json") {
    throw new ConfigurationError("ORGANUM_CODE_USAGE_REPORT must be json when set");
  }

  const profile = loadProviderProfile(env, {
    requireApiKey:
      selected.backend === "cursor" || claudeSignedHubCommand !== null
        ? false
        : !brokerEnabled(env),
  });
  const automaticQuotaReport =
    profile.providerID === "gemini" ||
    profile.providerID === "groq" ||
    profile.providerID === "opencode-zen";
  const budgetMode = executionBudgetMode(env, selected.backend);
  if (
    budgetMode === "adaptive" &&
    (selected.backend !== "grok" || profile.protocol !== "chat-completions")
  ) {
    throw new ConfigurationError(
      "Adaptive execution budget currently requires Grok with chat-completions",
    );
  }
  if (
    actorName !== undefined &&
    selected.backend === "opencode"
  ) {
    throw new ConfigurationError(
      "Named persistent actors require Claude Code, Grok Build, Deep Code, Codex, or Cursor",
    );
  }

  let openCodeCastReceiptPath: string | null = null;
  if (selected.backend === "opencode" && castContext?.arm === "organum") {
    if (!firstPartyPluginEnabled(env)) {
      throw new ConfigurationError(
        "Organum OpenCode cast lanes require the first-party plugin",
      );
    }
    openCodeCastReceiptPath = await prepareOpenCodeCastReceipt(
      castContext.runDirectory,
      castContext.lane,
      process.cwd(),
    );
  }

  if (selected.args[0] === "config") {
    console.log(JSON.stringify(buildOpenCodeConfig(profile), null, 2));
    return 0;
  }
  if (selected.backend !== "cursor" && claudeSignedHubCommand === null) {
    assertCodingModelCapabilities(profile);
  }

  let actorRuntime: AllocatedActorRuntime | null = null;
  if (actorName !== undefined) {
    actorRuntime = await allocateActorRuntime({
      actor: actorName,
      profile: effective.profile,
      backend: selected.backend,
      workspace: process.cwd(),
      env,
    });
  }
  const coordinationEnabled = nativeCoordinationEnabled(
    env,
    actorRuntime !== null,
  );
  if (selected.args[0] === "doctor") {
    return (await printDoctor(env, selected.backend, actorRuntime)) ? 0 : 1;
  }

  let claudeSignedHubAdapter: ClaudeSignedHubAdapter | null = null;
  let claudeSignedHubPrompt: string | null = null;
  let claudeSignedHubModel: string | null = null;
  let claudeSignedHubVersion: string | null = null;
  if (claudeSignedHubCommand !== null) {
    if (
      actorRuntime === null ||
      (profile.role !== "critic" && profile.role !== "reviewer")
    ) {
      throw new ConfigurationError(
        "Claude Signed Hub mode requires a persistent critic or reviewer actor",
      );
    }
    if (!coordinationEnabled) {
      throw new ConfigurationError(
        "Claude Signed Hub mode requires native coordination for supervisor-owned durable handoff",
      );
    }
    if (provenanceConfiguration !== null || castContext !== null) {
      throw new ConfigurationError(
        "Harness and cast provenance are not admitted for Claude Signed Hub mode",
      );
    }
    claudeSignedHubModel = claudeSignedHubModelID(env);
    const installation = inspectClaudeSignedHub(env);
    if (!installation.nativeSubscription) {
      throw new ConfigurationError(
        "Claude Signed Hub requires a host Claude subscription login; run `claude auth login` before setup or launch",
      );
    }
    claudeSignedHubVersion = installation.version;
    const turn = await loadSignedHubTurn({
      environment: env,
      directory: process.cwd(),
      actorRuntime,
    });
    claudeSignedHubAdapter = new ClaudeSignedHubAdapter(turn);
    try {
      claudeSignedHubPrompt = await claudeSignedHubAdapter.preparePrompt();
    } catch (error) {
      if (!(error instanceof SignedHubNoTurnError)) throw error;
      console.error(error.message);
      return error.disposition === "reconciliation_required" ? 2 : 0;
    }
  }

  let codexSignedHubAdapter: CodexSignedHubAdapter | null = null;
  let codexSignedHubArguments: readonly string[] | null = null;
  let codexSignedHubStdin: string | null = null;
  if (codexSignedHubCommand !== null) {
    if (
      actorRuntime === null ||
      (profile.role !== "critic" && profile.role !== "reviewer")
    ) {
      throw new ConfigurationError(
        "Codex Signed Hub mode requires a persistent critic or reviewer actor",
      );
    }
    if (!coordinationEnabled) {
      throw new ConfigurationError(
        "Codex Signed Hub mode requires native coordination for durable handoff",
      );
    }
    if (provenanceConfiguration !== null || castContext !== null) {
      throw new ConfigurationError(
        "Harness and cast provenance are not admitted for Codex Signed Hub mode",
      );
    }
    const turn = await loadSignedHubTurn({
      environment: env,
      directory: process.cwd(),
      actorRuntime,
    });
    codexSignedHubAdapter = new CodexSignedHubAdapter(turn);
    try {
      const launch = await codexSignedHubAdapter.prepareLaunch();
      codexSignedHubArguments = launch.args;
      codexSignedHubStdin = launch.stdin;
    } catch (error) {
      if (!(error instanceof SignedHubNoTurnError)) throw error;
      console.error(error.message);
      return error.disposition === "reconciliation_required" ? 2 : 0;
    }
  }

  let cursorSignedHubAdapter: CursorSignedHubAdapter | null = null;
  let cursorSignedHubPrompt: string | null = null;
  let cursorSignedHubModel: string | null = null;
  let cursorSignedHubVersion: string | null = null;
  if (cursorSignedHubCommand !== null) {
    if (
      actorRuntime === null ||
      (profile.role !== "critic" && profile.role !== "reviewer")
    ) {
      throw new ConfigurationError(
        "Cursor Signed Hub mode requires a persistent critic or reviewer actor",
      );
    }
    if (!coordinationEnabled) {
      throw new ConfigurationError(
        "Cursor Signed Hub mode requires native coordination for supervisor-owned durable handoff",
      );
    }
    if (provenanceConfiguration !== null || castContext !== null) {
      throw new ConfigurationError(
        "Harness and cast provenance are not admitted for Cursor Signed Hub mode",
      );
    }
    cursorSignedHubModel = cursorModelID(env);
    cursorSignedHubVersion = inspectCursor(env).version;
    const turn = await loadSignedHubTurn({
      environment: env,
      directory: process.cwd(),
      actorRuntime,
    });
    cursorSignedHubAdapter = new CursorSignedHubAdapter(turn);
    try {
      cursorSignedHubPrompt = await cursorSignedHubAdapter.preparePrompt();
    } catch (error) {
      if (!(error instanceof SignedHubNoTurnError)) throw error;
      console.error(error.message);
      return error.disposition === "reconciliation_required" ? 2 : 0;
    }
  }

  let deepCodeSignedHubAdapter: DeepCodeSignedHubAdapter | null = null;
  let deepCodeSignedHubArguments: readonly string[] | null = null;
  if (deepCodeSignedHubCommand !== null) {
    if (
      actorRuntime === null ||
      (profile.role !== "critic" && profile.role !== "reviewer")
    ) {
      throw new ConfigurationError(
        "Deep Code Signed Hub mode requires a persistent critic or reviewer actor",
      );
    }
    if (!coordinationEnabled) {
      throw new ConfigurationError(
        "Deep Code Signed Hub mode requires native coordination for durable handoff",
      );
    }
    if (provenanceConfiguration !== null || castContext !== null) {
      throw new ConfigurationError(
        "Harness and cast provenance are not admitted for Deep Code Signed Hub mode",
      );
    }
    const turn = await loadSignedHubTurn({
      environment: env,
      directory: process.cwd(),
      actorRuntime,
    });
    deepCodeSignedHubAdapter = new DeepCodeSignedHubAdapter(turn);
    try {
      deepCodeSignedHubArguments = (
        await deepCodeSignedHubAdapter.prepareLaunch()
      ).args;
    } catch (error) {
      if (!(error instanceof SignedHubNoTurnError)) throw error;
      console.error(error.message);
      return error.disposition === "reconciliation_required" ? 2 : 0;
    }
  }

  if (claudeSignedHubCommand !== null) {
    if (
      claudeSignedHubAdapter === null ||
      claudeSignedHubPrompt === null ||
      claudeSignedHubModel === null ||
      claudeSignedHubVersion === null ||
      actorRuntime === null
    ) {
      throw new ConfigurationError(
        "Claude Signed Hub launch state is incomplete",
      );
    }
    const productLifecycle = await createNativeProductLifecycle({
      actorRuntime,
      profile,
      environment: env,
      directory: process.cwd(),
    });
    claudeSignedHubAdapter.bindPublicationBaseline(productLifecycle.snapshot());
    const result = await launchClaudeSignedHub(
      claudeSignedHubPrompt,
      claudeSignedHubModel,
      env,
      process.cwd(),
      {
        runtimeDirectory: actorRuntime.runtimeDirectory,
        beforeSpawn: async () => await claudeSignedHubAdapter!.beginExposure(),
      },
    );
    if (result.successful) {
      await productLifecycle.callPublication(
        {
          body: result.output!,
          topic: "review",
        },
        true,
      );
    }
    const completed = await claudeSignedHubAdapter.complete(
      result.successful,
      productLifecycle.snapshot(),
    );
    const signed = completed.signedHub;
    console.error(
      `Organum Code Claude Signed Hub: version=${claudeSignedHubVersion}, model=${result.modelID ?? claudeSignedHubModel}, turns=${result.turns ?? 0}, event=${signed.eventID}, source_seq=${signed.sourceAcceptedSeq}, outcome=${signed.semanticOutcome}, ack=${signed.ackEventID}, ack_seq=${signed.ackAcceptedSeq}, terminal=${result.failure}`,
    );
    if (!completed.successful || result.output === null) return 2;
    process.stdout.write(result.output);
    if (!result.output.endsWith("\n")) process.stdout.write("\n");
    return 0;
  }

  if (selected.backend === "cursor") {
    if (
      cursorSignedHubAdapter === null ||
      cursorSignedHubPrompt === null ||
      cursorSignedHubModel === null ||
      cursorSignedHubVersion === null ||
      actorRuntime === null
    ) {
      throw new ConfigurationError(
        "Cursor currently exposes only the exact persistent `cursor --signed-hub` product surface",
      );
    }
    const productLifecycle = await createNativeProductLifecycle({
      actorRuntime,
      profile,
      environment: env,
      directory: process.cwd(),
    });
    cursorSignedHubAdapter.bindPublicationBaseline(productLifecycle.snapshot());
    const result = await launchCursorSignedHub(
      cursorSignedHubPrompt,
      cursorSignedHubModel,
      env,
      process.cwd(),
      {
        runtimeDirectory: actorRuntime.runtimeDirectory,
        beforeSpawn: async () => await cursorSignedHubAdapter!.beginExposure(),
      },
    );
    if (result.successful) {
      await productLifecycle.callPublication(
        {
          body: result.output!,
          topic: "review",
        },
        true,
      );
    }
    const completed = await cursorSignedHubAdapter.complete(
      result.successful,
      productLifecycle.snapshot(),
    );
    const signed = completed.signedHub;
    console.error(
      `Organum Code Cursor Signed Hub: version=${cursorSignedHubVersion}, event=${signed.eventID}, source_seq=${signed.sourceAcceptedSeq}, outcome=${signed.semanticOutcome}, ack=${signed.ackEventID}, ack_seq=${signed.ackAcceptedSeq}, terminal=${result.failure}`,
    );
    if (!completed.successful || result.output === null) return 2;
    process.stdout.write(result.output);
    if (!result.output.endsWith("\n")) process.stdout.write("\n");
    return 0;
  }

  if (!brokerEnabled(env)) {
    console.error(
      "Warning: ORGANUM_CODE_BROKER=0 exposes the real provider credential to the backend and its tools.",
    );
    if (
      selected.backend === "claude" ||
      selected.backend === "grok" ||
      selected.backend === "deepcode" ||
      selected.backend === "codex"
    ) {
      throw new Error(`${selected.backend} requires the credential broker`);
    }
    if (provenanceConfiguration !== null) {
      throw new ConfigurationError(
        "Harness provenance requires the credential broker",
      );
    }
    return launchOpenCode(selected.args, buildOpenCodeConfig(profile), env);
  }

  const secret = await loadProviderSecret(profile, env, {
    workspace: process.cwd(),
  });
  const installation =
    selected.backend === "opencode"
      ? inspectOpenCode(env)
      : selected.backend === "claude"
        ? inspectClaudeCode(env)
        : selected.backend === "grok"
          ? inspectGrokBuild(env)
          : selected.backend === "deepcode"
            ? inspectDeepCode(env)
            : inspectCodex(env);
  const acpCommand =
    selected.backend === "grok"
      ? parseGrokAcpCommand(selected.args)
      : null;
  if (acpCommand !== null) {
    if (provenanceConfiguration !== null) {
      throw new ConfigurationError(
        "Harness provenance is not yet admitted for the Grok ACP path",
      );
    }
    if (!coordinationEnabled) {
      throw new ConfigurationError(
        "Grok ACP requires native coordination; use the native Grok path for a bare actor",
      );
    }
    const observationStartedAt = new Date().toISOString();
    const signedHubTurn = acpCommand.kind === "signed-hub"
      ? await loadGrokAcpSignedHubTurn({
          environment: env,
          directory: process.cwd(),
          actorRuntime,
        })
      : undefined;
    const controller = new AbortController();
    let receivedSignal: NodeJS.Signals | null = null;
    let wroteText = false;
    let outputEndsWithNewline = true;
    const interrupt = (): void => {
      receivedSignal = "SIGINT";
      controller.abort(new Error("Grok ACP interrupted"));
    };
    const terminate = (): void => {
      receivedSignal = "SIGTERM";
      controller.abort(new Error("Grok ACP terminated"));
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
      const acp = await runGrokAcp({
        profile,
        upstreamApiKey: secret.value,
        environment: env,
        directory: process.cwd(),
        actorRuntime,
        ...(acpCommand.kind === "prompt"
          ? { prompt: acpCommand.prompt }
          : { signedHubTurn: signedHubTurn! }),
        timeoutMs: parseGrokAcpTimeout(env.ORGANUM_CODE_ACP_TIMEOUT_MS),
        executionBudgetMode: budgetMode,
        signal: controller.signal,
        onUpdate(update) {
          const text = textFromAcpAgentUpdate(update);
          if (text.length === 0) return;
          process.stdout.write(text);
          wroteText = true;
          outputEndsWithNewline = text.endsWith("\n");
        },
        onBrokerSettlement(settlement) {
          if (usageReport === "json" || automaticQuotaReport) {
            printUsageSnapshot(
              selected.backend,
              profile,
              settlement.snapshot,
            );
          }
        },
        onRuntimeHealth: reportGrokRuntimeHealth,
      });
      const observationFinishedAt = new Date().toISOString();
      const emission = await buildAndEmitOrganumCodeObservation(
        () => buildGrokAcpObservation({
          backendVersion: installation.version,
          profile,
          nativeSessionId: acp.sessionID,
          result: acp.result,
          successful: acp.successful,
          startedAt: observationStartedAt,
          finishedAt: observationFinishedAt,
          recordedAt: new Date().toISOString(),
          settlement: acp.broker,
          persona: env.ORGANUM_CODE_PERSONA?.trim().toLowerCase() || null,
          workspace: env.ORGANUM_CODE_WORKSPACE?.trim().toLowerCase() || null,
        }),
        { env, cwd: process.cwd() },
      );
      if (emission.error !== null) {
        console.error(
          `Organum Code observation was not ingested: ${emission.error}`,
        );
      }
      if (receivedSignal !== null) return signalExitCode(receivedSignal);
      const nativeLastEvent =
        acp.nativePermissions.events[acp.nativePermissions.events.length - 1];
      const nativeLastToolKind =
        /^[A-Za-z]+/.exec(nativeLastEvent?.toolName ?? "")?.[0] ?? "none";
      const nativeLastReason = nativeLastEvent?.reason ?? "none";
      const signedHubStatus = acp.signedHub === null
        ? ""
        : `, signed_hub_event=${acp.signedHub.eventID}, signed_hub_source_seq=${acp.signedHub.sourceAcceptedSeq}, signed_hub_outcome=${acp.signedHub.semanticOutcome}, signed_hub_ack=${acp.signedHub.ackEventID}, signed_hub_ack_seq=${acp.signedHub.ackAcceptedSeq}`;
      if (!acp.successful) {
        console.error(
          `Organum Code ACP incomplete: stop=${acp.result.stopReason}, publication=${acp.result.publication.phase}, admitted=${String(acp.result.coordinationAdmitted)}, native_permissions=${acp.nativePermissions.granted}/${acp.nativePermissions.requests}, native_malformed=${acp.nativePermissions.malformed}, native_execute=${String(acp.nativeExecutionGate.executeGranted)}, native_execute_tools_removed=${acp.nativeExecutionGate.executeToolsRemoved}, native_out_of_role_tools_removed=${acp.nativeExecutionGate.outOfRoleToolsRemoved}, native_post_publish_tools_removed=${acp.nativeExecutionGate.postPublicationToolsRemoved}, native_handoff_escalations=${acp.nativeExecutionGate.handoffEscalationRequests}, native_blocked_execute=${acp.nativeExecutionGate.blockedExecuteRequests}, native_blocked_write=${acp.nativeExecutionGate.blockedWriteRequests}, native_blocked_execute_class=${acp.nativeExecutionGate.lastBlockedExecuteClass ?? "none"}, native_last_tool_kind=${nativeLastToolKind}, native_last_reason=${nativeLastReason}${signedHubStatus}`,
        );
        return 2;
      }
      console.error(
        `Organum Code ACP shipped: cell=${acp.result.cell}, permissions=${acp.permissions.granted}, native_permissions=${acp.nativePermissions.granted}, publication=${acp.result.publication.phase}, native_execute=${String(acp.nativeExecutionGate.executeGranted)}, native_execute_tools_removed=${acp.nativeExecutionGate.executeToolsRemoved}, native_out_of_role_tools_removed=${acp.nativeExecutionGate.outOfRoleToolsRemoved}, native_post_publish_tools_removed=${acp.nativeExecutionGate.postPublicationToolsRemoved}, native_handoff_escalations=${acp.nativeExecutionGate.handoffEscalationRequests}, native_blocked_execute=${acp.nativeExecutionGate.blockedExecuteRequests}, native_blocked_write=${acp.nativeExecutionGate.blockedWriteRequests}, native_blocked_execute_class=${acp.nativeExecutionGate.lastBlockedExecuteClass ?? "none"}, native_last_tool_kind=${nativeLastToolKind}, native_last_reason=${nativeLastReason}${signedHubStatus}`,
      );
      return 0;
    } catch (error) {
      if (receivedSignal !== null) return signalExitCode(receivedSignal);
      if (error instanceof GrokAcpSignedHubNoTurnError) {
        console.error(error.message);
        return error.disposition === "reconciliation_required" ? 2 : 0;
      }
      throw error;
    } finally {
      if (wroteText && !outputEndsWithNewline) process.stdout.write("\n");
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
  const requestedLaunchArgs =
    codexSignedHubArguments ?? deepCodeSignedHubArguments ?? selected.args;
  const interactivePlan: NativeInteractiveLaunchPlan | null =
    actorRuntime === null
      ? null
      : await planNativeInteractiveLaunch(actorRuntime, requestedLaunchArgs);
  let launchArgs = interactivePlan?.args ?? requestedLaunchArgs;
  const nativeToolProjectionEnabled =
    grokNativeToolProjectionEnabled(env);
  const claudeProjectionEnabled =
    claudeNativeToolProjectionEnabled(env);
  if (
    nativeToolProjectionEnabled &&
    (selected.backend !== "grok" ||
      profile.protocol !== "chat-completions")
  ) {
    throw new ConfigurationError(
      "Grok native tool projection requires Grok chat-completions on macOS",
    );
  }
  if (
    claudeProjectionEnabled &&
    (selected.backend !== "claude" ||
      actorRuntime !== null)
  ) {
    throw new ConfigurationError(
      "Claude native tool projection requires Claude Code 2.1.220, a new non-actor --print/-p turn, and macOS",
    );
  }
  if (nativeToolProjectionEnabled) {
    assertGrokS16OperationalEnvironment(installation.version);
  }
  if (claudeProjectionEnabled) {
    assertClaudeS16OperationalEnvironment(installation.version);
  }
  const productLifecycle: NativeProductLifecycle | null =
    actorRuntime === null || !coordinationEnabled
      ? null
      : await createNativeProductLifecycle({
          actorRuntime,
          profile,
          environment: env,
          directory: process.cwd(),
          upstreamApiKey: secret.value,
        });
  if (codexSignedHubAdapter !== null) {
    if (productLifecycle === null) {
      throw new ConfigurationError(
        "Codex Signed Hub durable publication lifecycle is unavailable",
      );
    }
    codexSignedHubAdapter.bindPublicationBaseline(productLifecycle.snapshot());
  }
  if (deepCodeSignedHubAdapter !== null) {
    if (productLifecycle === null) {
      throw new ConfigurationError(
        "Deep Code Signed Hub durable publication lifecycle is unavailable",
      );
    }
    deepCodeSignedHubAdapter.bindPublicationBaseline(
      productLifecycle.snapshot(),
    );
  }
  const coordinationTurnID =
    castContext?.arm === "organum"
      ? `cast:${castContext.runID}:${castContext.lane}`
      : null;
  const castPromptSha256 =
    castContext?.arm === "organum"
      ? castContext.promptSha256
      : null;
  let castBrokerCoordination: OrganismCastBrokerCoordination | null = null;
  if (coordinationTurnID !== null && castPromptSha256 !== null) {
    if (productLifecycle === null && openCodeCastReceiptPath === null) {
      throw new ConfigurationError(
        "Organum cast coordination lifecycle is unavailable",
      );
    }
    if (productLifecycle !== null) {
      const turn = await productLifecycle.prepareCoordinationTurn(
        coordinationTurnID,
      );
      launchArgs = [
        ...bindOrganismCastCoordinationPacket(
          launchArgs,
          castPromptSha256,
          turn.packet,
        ).args,
      ];
      castBrokerCoordination = new OrganismCastBrokerCoordination(
        productLifecycle,
        coordinationTurnID,
      );
    }
  }
  const nativeToolSessionID = nativeToolProjectionEnabled
    ? interactivePlan?.nativeSessionID ?? randomUUID()
    : null;
  const nativeToolTurnID = nativeToolProjectionEnabled
    ? `turn-${randomUUID()}`
    : null;
  const nativeToolSupervisor =
    nativeToolSessionID === null || nativeToolTurnID === null
      ? null
      : new GrokNativeToolSupervisor({
          sessionId: nativeToolSessionID,
          turnId: nativeToolTurnID,
        });
  const nativeToolTransport = nativeToolSupervisor === null
    ? null
    : new GrokNativeToolCapabilityTransport();
  const nativeToolProjection =
    nativeToolSupervisor === null || nativeToolTransport === null
      ? null
      : new GrokNativeToolResponseProjection({
          supervisor: nativeToolSupervisor,
          transport: nativeToolTransport,
          approve: approveGrokNativeToolProposal,
        });
  const nativeToolAuxiliaryHandler = nativeToolSupervisor === null
    ? undefined
    : createGrokNativeToolAuxiliaryHandler(nativeToolSupervisor);
  const claudeNativeSessionID = claudeProjectionEnabled
    ? randomUUID()
    : null;
  const claudeNativeTurnID = claudeProjectionEnabled
    ? `turn-${randomUUID()}`
    : null;
  const claudeNativeSupervisor =
    claudeNativeSessionID === null || claudeNativeTurnID === null
      ? null
      : new ClaudeNativeToolSupervisor({
          sessionId: claudeNativeSessionID,
          turnId: claudeNativeTurnID,
        });
  const claudeNativeProjection = claudeNativeSupervisor === null
    ? null
    : new ClaudeNativeToolResponseProjection({
        supervisor: claudeNativeSupervisor,
        approve: approveClaudeNativeToolProposal,
      });
  const claudeNativeAuxiliaryHandler = claudeNativeSupervisor === null
    ? undefined
    : createClaudeNativeToolAuxiliaryHandler(claudeNativeSupervisor);
  let castUsageLedger: FileProviderUsageLedger | null = null;
  if (castContext !== null) {
    castUsageLedger = new FileProviderUsageLedger({
      directory: join(
        castContext.runDirectory,
        "provider-usage",
      ),
      runID: castContext.runID,
      laneID: castContext.lane,
      backend: selected.backend,
      provider: profile.providerID,
      model: profile.modelID,
      protocol: profile.protocol,
    });
  }
  const brokerMode =
    selected.backend === "claude"
      ? "messages-to-chat-completions" as const
      : selected.backend === "codex" &&
          profile.protocol === "chat-completions"
        ? "responses-to-chat-completions" as const
        : brokerModeForProvider(profile);
  const providerPolicy = providerBrokerPolicy(profile, brokerMode);
  const provenanceCollector = provenanceConfiguration === null
    ? null
    : new HarnessProvenanceCollector({
        backend: selected.backend,
        binary: installation.binary,
        backendVersion: installation.version,
        profileName: effective.profile,
        provider: profile.providerID,
        model: profile.modelID,
        protocol: profile.protocol,
        role: profile.role,
        secretSource: secret.source.kind,
        submittedArguments: selected.args,
        actor: actorRuntime !== null,
        coordination: coordinationEnabled,
        firstPartyPlugin:
          selected.backend === "opencode"
            ? firstPartyPluginEnabled(env)
            : null,
        workspacePolicy: provenanceConfiguration.workspacePolicy,
        fixtureSha256: provenanceConfiguration.fixtureSha256,
        mode: brokerMode,
        mediation: harnessMediation(selected.backend, brokerMode),
      });
  const broker = new InferenceBroker({
    upstreamBaseURL: profile.baseURL,
    upstreamApiKey: secret.value,
    upstreamModel: profile.modelID,
    mode: brokerMode,
    advertisedModel:
      selected.backend === "claude"
        ? env.ORGANUM_CODE_CLAUDE_MODEL?.trim() || "claude-sonnet-4-5"
        : undefined,
    upstreamHeaders: providerPolicy.upstreamHeaders,
    requestTransform:
      selected.backend === "deepcode"
        ? normalizeDeepCodeChatCompletionsRequest
        : undefined,
    finalRequestTransform: providerPolicy.requestTransform,
    sseTransform:
      selected.backend === "grok" &&
        profile.protocol === "chat-completions" &&
        nativeToolProjection === null
        ? normalizeGrokChatCompletionsSseEvent
        : undefined,
    completeResponseProjection: nativeToolProjection ?? undefined,
    anthropicToolProjection: claudeNativeProjection ?? undefined,
    executionBudget:
      budgetMode === "adaptive"
        ? createGrokAdaptiveExecutionBudget(profile.modelID)
        : undefined,
    auxiliaryHandler: composeAuxiliaryHandlers([
      nativeToolAuxiliaryHandler,
      claudeNativeAuxiliaryHandler,
      productLifecycle?.endpoint.handler,
    ]),
    requestLifecycle: castBrokerCoordination ?? undefined,
    usageObserver: castUsageLedger?.observer(),
    requestObserver: provenanceCollector?.observe,
  });
  const session = await broker.start();
  const mcpServer = productLifecycle?.endpoint.descriptor(session.origin);
  const observationStartedAt = new Date().toISOString();
  let observedExitCode: number | null = null;
  let launchFailed = false;
  let observedNativeSessionID =
    interactivePlan?.nativeSessionID ??
      nativeToolSessionID ??
      claudeNativeSessionID;
  let openCodeCastReceipt: OpenCodeCastReceipt | null = null;
  try {
    if (selected.backend === "claude") {
      observedExitCode = await launchClaudeCode(
        launchArgs,
        session,
        env.ORGANUM_CODE_CLAUDE_MODEL?.trim() || "claude-sonnet-4-5",
        buildBrokerLaunchEnvironment(env, profile.apiKeyEnv, session),
        process.cwd(),
        claudeNativeProjection === null || claudeNativeSessionID === null
          ? actorRuntime === null
            ? {}
            : {
              runtimeDirectory: actorRuntime.runtimeDirectory,
              mcpServer,
            }
          : {
              nativeToolProjection: {
                endpoint:
                  `${session.origin}${CLAUDE_NATIVE_TOOL_HOOK_PATH}`,
                sessionID: claudeNativeSessionID,
              },
            },
      );
      return observedExitCode;
    }
    const brokeredBase = createBrokeredProviderProfile(profile, session);
    const brokered =
      selected.backend === "codex" && profile.protocol === "chat-completions"
        ? { ...brokeredBase, protocol: "responses" as const }
        : brokeredBase;
    const launchEnvironment = buildBrokerLaunchEnvironment(
      env,
      profile.apiKeyEnv,
      session,
    );
    if (selected.backend === "grok") {
      const nativeToolLaunch =
        nativeToolProjection === null ||
          nativeToolTransport === null ||
          nativeToolSessionID === null ||
          nativeToolTurnID === null
          ? undefined
          : {
              endpoint: `${session.origin}${GROK_NATIVE_TOOL_CONSUME_PATH}`,
              sessionID: nativeToolSessionID,
              turnID: nativeToolTurnID,
              transport: nativeToolTransport,
              bindWrapperCommand(command: string) {
                nativeToolProjection.bindWrapperCommand(command);
              },
            };
      observedExitCode = await launchGrokBuild(
        launchArgs,
        brokered,
        launchEnvironment,
        process.cwd(),
        {
          ...(actorRuntime === null
            ? {}
            : {
                runtimeDirectory: actorRuntime.runtimeDirectory,
                mcpServer,
                onRuntimeHealth: reportGrokRuntimeHealth,
              }),
          sessionID:
            nativeToolSessionID ??
            interactivePlan?.nativeSessionID ??
            undefined,
          nativeToolProjection: nativeToolLaunch,
        },
      );
      return observedExitCode;
    }
    if (selected.backend === "deepcode") {
      const backendExitCode = await launchDeepCode(
        launchArgs,
        brokered,
        launchEnvironment,
        process.cwd(),
        actorRuntime === null
          ? {}
          : {
              runtimeDirectory: actorRuntime.runtimeDirectory,
              mcpServer,
              ...(deepCodeSignedHubAdapter === null
                ? {}
                : {
                    beforeSpawn: async () =>
                      await deepCodeSignedHubAdapter!.beginExposure(),
                    permissionMode: "signed-hub-review" as const,
                  }),
              ...(castContext === null
                ? {}
                : {
                    completionSignal: true,
                    permissionMode:
                      "contained-unattended" as const,
                  }),
            },
      );
      observedExitCode = backendExitCode;
      if (deepCodeSignedHubAdapter !== null) {
        const completed = await deepCodeSignedHubAdapter.complete(
          backendExitCode,
          productLifecycle?.snapshot() ?? null,
        );
        const signed = completed.signedHub;
        console.error(
          `Organum Code Deep Code Signed Hub: event=${signed.eventID}, source_seq=${signed.sourceAcceptedSeq}, outcome=${signed.semanticOutcome}, ack=${signed.ackEventID}, ack_seq=${signed.ackAcceptedSeq}`,
        );
        if (!completed.successful) {
          observedExitCode = 2;
          return 2;
        }
      }
      return observedExitCode;
    }
    if (selected.backend === "codex") {
      const backendExitCode = await launchCodex(
        launchArgs,
        brokered,
        launchEnvironment,
        process.cwd(),
        actorRuntime === null
          ? {}
          : {
              runtimeDirectory: actorRuntime.runtimeDirectory,
              mcpServer,
              ...(codexSignedHubAdapter === null
                ? {}
                : {
                    beforeSpawn: async () =>
                      await codexSignedHubAdapter!.beginExposure(),
                    stdinInput: codexSignedHubStdin!,
                  }),
            },
      );
      observedExitCode = backendExitCode;
      if (codexSignedHubAdapter !== null) {
        const completed = await codexSignedHubAdapter.complete(
          backendExitCode,
          productLifecycle?.snapshot() ?? null,
        );
        const signed = completed.signedHub;
        console.error(
          `Organum Code Codex Signed Hub: event=${signed.eventID}, source_seq=${signed.sourceAcceptedSeq}, outcome=${signed.semanticOutcome}, ack=${signed.ackEventID}, ack_seq=${signed.ackAcceptedSeq}`,
        );
        if (!completed.successful) {
          observedExitCode = 2;
          return 2;
        }
      }
      return observedExitCode;
    }
    observedExitCode = await launchOpenCode(
      selected.args,
      buildOpenCodeConfig(brokered),
      {
        ...launchEnvironment,
        ...(openCodeCastReceiptPath === null
          ? {}
          : {
              [ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV]:
                openCodeCastReceiptPath,
            }),
      },
    );
    return observedExitCode;
  } catch (error) {
    launchFailed = true;
    throw error;
  } finally {
    nativeToolProjection?.close();
    claudeNativeProjection?.close();
    const nativeToolApproval =
      nativeToolProjection?.snapshot().approvalConfound ??
      claudeNativeProjection?.snapshot().approvalConfound ??
      null;
    const grokApprovalSettled =
      nativeToolProjection === null ||
      nativeToolSupervisor === null ||
      (
        nativeToolProjection.snapshot().busy === false &&
        nativeToolProjection.snapshot().pendingCommit === false &&
        nativeToolSupervisor.snapshot().pending === 0 &&
        nativeToolSupervisor.snapshot().pendingGrants === 0 &&
        nativeToolSupervisor.snapshot().pendingConsumeCapabilities === 0
      );
    const claudeApprovalSettled =
      claudeNativeProjection === null ||
      claudeNativeSupervisor === null ||
      (
        claudeNativeProjection.snapshot().approvalPending === false &&
        claudeNativeSupervisor.snapshot().pending === 0 &&
        claudeNativeSupervisor.snapshot().pendingGrants === 0
      );
    const settlement = await broker.settle({
      graceMs: 1_000,
      forceTimeoutMs: 1_000,
    });
    try {
      if (provenanceCollector !== null) {
        console.error(JSON.stringify(provenanceCollector.finalize(settlement)));
      }
      if (!grokApprovalSettled || !claudeApprovalSettled) {
        throw new Error(
          "Native tool approval telemetry cannot report a pending authority state",
        );
      }
      const coordinationClean =
        coordinationTurnID !== null &&
        observedExitCode === 0 &&
        !launchFailed &&
        settlement.idle &&
        settlement.forcedAbortRequests === 0;
      await castBrokerCoordination?.finish(coordinationClean);
      if (coordinationClean) {
        if (openCodeCastReceiptPath !== null) {
          openCodeCastReceipt = await readOpenCodeCastReceipt(
            openCodeCastReceiptPath,
          );
          observedNativeSessionID = openCodeCastReceipt.root_session_id;
        }
        console.error(
          `Organum Code coordination delivery: ${
            JSON.stringify(
              openCodeCastReceipt?.delivery ??
                productLifecycle?.coordinationSnapshot() ??
                null,
            )
          }`,
        );
      }
      if (
        actorRuntime !== null &&
        interactivePlan !== null &&
        observedExitCode !== null
      ) {
        const finalized = await finalizeNativeInteractiveLaunch(
          actorRuntime,
          interactivePlan,
        );
        observedNativeSessionID = finalized.native_session_id;
      }
      if (usageReport === "json" || automaticQuotaReport) {
        printUsageSnapshot(selected.backend, profile, settlement.snapshot);
      }
      {
        const observationFinishedAt = new Date().toISOString();
        const publication =
          openCodeCastReceipt?.publication ??
          productLifecycle?.snapshot() ??
          null;
        const emission = await buildAndEmitOrganumCodeObservation(
          () => buildTerminalObservation({
            backend: selected.backend,
            backendVersion: installation.version,
            backendProtocol:
              selected.backend === "opencode"
                ? "opencode-session"
                : selected.backend === "claude"
                ? "anthropic-messages"
                : "native-tui",
            profile,
            nativeSessionId: observedNativeSessionID,
            exitCode: observedExitCode,
            failed: launchFailed,
            startedAt: observationStartedAt,
            finishedAt: observationFinishedAt,
            recordedAt: new Date().toISOString(),
            settlement,
            nativeToolApproval,
            canonicalCell:
              openCodeCastReceipt?.canonical_cell ??
              productLifecycle?.identity ??
              null,
            joinStatus:
              openCodeCastReceipt !== null
                ? "joined"
                : productLifecycle === null
                ? "not-joined"
                : productLifecycle.joined
                  ? "joined"
                  : "unknown",
            identityRole: profile.role,
            comparisonKey: castContext?.comparisonKey ?? null,
            preregistrationId:
              castContext?.preregistrationID ?? null,
            evaluationName:
              castContext === null
                ? "product-terminal"
                : `organism-bench/${castContext.pack}`,
            evaluationScenario:
              castContext === null
                ? null
                : `${castContext.arm}/${castContext.lane}`,
            coordination:
              publication === null
                ? undefined
                : {
                    contributions:
                      publication.receipt === null ? 0 : 1,
                    topic: publication.receipt?.topic ?? null,
                    publicationPhase: publication.phase,
                    sessionClosed: publication.phase === "shipped",
                    receipt:
                      publication.receipt === null
                        ? null
                        : {
                            file: publication.receipt.file,
                            bodyBytes: publication.receipt.body_bytes,
                            bodySha256:
                              publication.receipt.body_sha256,
                          },
                  },
          }),
          { env, cwd: process.cwd() },
        );
        if (emission.error !== null) {
          console.error(
            `Organum Code observation was not ingested: ${emission.error}`,
          );
        }
      }
    } finally {
      await broker.close();
    }
  }
}
