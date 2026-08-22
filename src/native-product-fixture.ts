import { randomUUID } from "node:crypto";

import {
  prepareClaudeBenchmarkLaunch,
  type PreparedClaudeCodeLaunch,
} from "./claude-launcher.js";
import {
  prepareDeepCodeLaunch,
  type PreparedDeepCodeLaunch,
} from "./deepcode-launcher.js";
import {
  prepareGrokBuildLaunch,
  type PreparedGrokBuildLaunch,
} from "./grok-launcher.js";
import type {
  InferenceBrokerSession,
  InferenceBrokerSnapshot,
} from "./inference-broker.js";
import type { NativeBenchmarkBackendID } from "./native-adapter-conformance.js";
import {
  buildDeepCodeBenchmarkArgs,
  buildGrokBenchmarkArgs,
  NativeSoftwareBenchmarkBackendDriver,
  type NativeBenchmarkAdapterContract,
  type PreparedNativeBenchmarkLaunch,
} from "./native-benchmark-backend.js";
import type { OrganumMcpHttpServer } from "./organum-mcp.js";
import type { ProviderProfile } from "./provider-profile.js";

const PRODUCT_CONTRACTS: Record<
  NativeBenchmarkBackendID,
  NativeBenchmarkAdapterContract
> = {
  claude: {
    schemaVersion: 1,
    backendID: "claude",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    persistentState: "isolated-ephemeral",
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "process-exit",
    protocolMediation: [
      "anthropic-messages-to-chat-completions",
      "supervisor-owned-authenticated-http-mcp",
    ],
    nativeDifferences: [
      "Claude Code native system prompt",
      "strict explicit MCP config and qualified tool allowlist",
    ],
  },
  grok: {
    schemaVersion: 1,
    backendID: "grok",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    persistentState: "isolated-ephemeral",
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "process-exit",
    protocolMediation: [
      "empty-tool-name-sse-delta-normalization",
      "bind-session-summary-to-brokered-model",
      "supervisor-owned-authenticated-http-mcp",
    ],
    nativeDifferences: [
      "Grok Build native search_tool/use_tool MCP discovery",
      "headless one-shot lifecycle",
    ],
  },
  deepcode: {
    schemaVersion: 1,
    backendID: "deepcode",
    comparisonUnit: "native-tui-body",
    providerAccess: "broker-capability-only",
    externalNetwork: "broker-only",
    persistentState: "isolated-ephemeral",
    operatorInput: "none",
    adapterTurnLimit: null,
    completionSignal: "notify-then-process-exit",
    protocolMediation: [
      "drop-nonstandard-thinking-and-extra_body",
      "local-fixed-model-catalog",
      "immutable-stdio-to-authenticated-http-mcp",
    ],
    nativeDifferences: [
      "Deep Code native asynchronous MCP initialization",
      "PTY plus native notify completion lifecycle",
    ],
  },
};

export interface NativeProductFixtureDriverOptions {
  backend: NativeBenchmarkBackendID;
  profile: ProviderProfile;
  env: NodeJS.ProcessEnv;
  session: InferenceBrokerSession;
  advertisedClaudeModel: string;
  mcpServer: OrganumMcpHttpServer;
  usageSnapshot: () => InferenceBrokerSnapshot;
  diagnosticRedactions: readonly string[];
}

function projectClaude(
  launch: PreparedClaudeCodeLaunch,
  nativeSessionId: string,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId,
    close: () => launch.close(),
  };
}

function projectGrok(
  launch: PreparedGrokBuildLaunch,
  nativeSessionId: string,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: false,
    nativeSessionId,
    close: () => launch.close(),
  };
}

function projectDeepCode(
  launch: PreparedDeepCodeLaunch,
): PreparedNativeBenchmarkLaunch {
  return {
    executable: launch.containment.spawn.executable,
    args: launch.containment.spawn.args,
    env: launch.containment.spawn.env,
    cwd: launch.containment.cwd,
    pty: true,
    ...(launch.completionReceiptPath === undefined
      ? {}
      : { completionReceiptPath: launch.completionReceiptPath }),
    diagnosticRuntimeDirectory: launch.diagnosticRuntimeDirectory,
    diagnosticStateDirectory: launch.diagnosticStateDirectory,
    close: () => launch.close(),
  };
}

export function createNativeProductFixtureDriver(
  options: NativeProductFixtureDriverOptions,
): NativeSoftwareBenchmarkBackendDriver {
  return new NativeSoftwareBenchmarkBackendDriver({
    backendID: options.backend,
    adapterContract: PRODUCT_CONTRACTS[options.backend],
    profile: options.profile,
    usageSnapshot: options.usageSnapshot,
    captureActorDiagnostic: true,
    diagnosticRedactions: options.diagnosticRedactions,
    async prepare(prepared) {
      if (options.backend === "claude") {
        const nativeSessionId = randomUUID();
        return projectClaude(
          await prepareClaudeBenchmarkLaunch(
            prepared.prompt,
            options.session,
            options.advertisedClaudeModel,
            options.env,
            prepared.workspace,
            nativeSessionId,
            { mcpServer: options.mcpServer },
          ),
          nativeSessionId,
        );
      }
      if (options.backend === "grok") {
        const request = buildGrokBenchmarkArgs(prepared.prompt);
        return projectGrok(
          await prepareGrokBuildLaunch(
            request.args,
            options.profile,
            options.env,
            prepared.workspace,
            {
              mcpServer: options.mcpServer,
              sessionID: request.sessionID,
            },
          ),
          request.sessionID,
        );
      }
      return projectDeepCode(
        await prepareDeepCodeLaunch(
          buildDeepCodeBenchmarkArgs(prepared.prompt),
          options.profile,
          options.env,
          prepared.workspace,
          {
            completionSignal: true,
            permissionMode: "contained-unattended",
            mcpServer: options.mcpServer,
          },
        ),
      );
    },
  });
}
