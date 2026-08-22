import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { AcpNdjsonTransport } from "./acp-client.js";
import {
  launchClaudeCode,
} from "./claude-launcher.js";
import { launchGrokBuild } from "./grok-launcher.js";
import {
  brokerModeForProvider,
  buildBrokerLaunchEnvironment,
  createBrokeredProviderProfile,
  InferenceBroker,
} from "./inference-broker.js";
import {
  BoundedMtiReflexMcpEndpoint,
  MtiReflexCallIdentityCarrier,
  MtiReflexUpstreamProjection,
  type MtiReflexContext,
  type MtiReflexMcpDelegate,
  type MtiReflexSnapshot,
} from "./mti-reflex-mcp.js";
import {
  buildOpenCodeConfig,
  projectOpenCodeMtiReflexConfig,
} from "./opencode-config.js";
import { launchOpenCode } from "./opencode-launcher.js";
import type { ProviderProfile } from "./provider-profile.js";

export type MtiReflexBody = "claude" | "grok" | "opencode";

export interface MtiReflexStdioServerOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface MtiReflexCellRunOptions {
  body: MtiReflexBody;
  profile: ProviderProfile;
  upstreamToken: string;
  advertisedClaudeModel?: string;
  stream: boolean;
  prompt: string;
  context: MtiReflexContext;
  receiptPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdioServer: MtiReflexStdioServerOptions;
}

export interface MtiReflexCellRunResult {
  schema: "organum-code/mti-reflex-cell-run-result/v1";
  body: MtiReflexBody;
  exitCode: number;
  endpoint: MtiReflexSnapshot;
  projection: ReturnType<MtiReflexUpstreamProjection["snapshot"]>;
  broker: ReturnType<InferenceBroker["snapshot"]>;
}

function boundedAbsolutePath(value: string, name: string): string {
  if (!value.startsWith("/") || value.includes("\0") || value.length > 4_096) {
    throw new TypeError(`${name} must be a bounded absolute path`);
  }
  return value;
}

function literalLoopbackBaseURL(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("MTI reflex upstream must be the literal loopback /v1");
  }
  return url.toString().replace(/\/$/, "");
}

class StdioMcpDelegate implements MtiReflexMcpDelegate {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #transport: AcpNdjsonTransport;

  constructor(options: MtiReflexStdioServerOptions) {
    boundedAbsolutePath(options.executable, "MCP executable");
    boundedAbsolutePath(options.cwd, "MCP working directory");
    this.#child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#transport = new AcpNdjsonTransport(
      this.#child.stdin,
      this.#child.stdout,
      64 * 1024,
    );
    this.#child.stderr.resume();
  }

  async request(method: string, params: Readonly<Record<string, unknown>>) {
    const result = await this.#transport.request(method, params, {
      timeoutMs: 10_000,
    });
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("collector MCP returned a non-object result");
    }
    return result as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.#transport.close().catch(() => undefined);
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    if (this.#child.pid !== undefined) {
      try {
        process.kill(
          process.platform === "win32" ? this.#child.pid : -this.#child.pid,
          "SIGTERM",
        );
      } catch {
        // The collector server may have exited when stdin closed.
      }
    }
  }
}

function launchArguments(options: MtiReflexCellRunOptions): readonly string[] {
  if (options.body === "claude") {
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      options.prompt,
    ];
  }
  if (options.body === "grok") return ["-p", options.prompt];
  return [
    "run",
    "--format",
    "json",
    "--title",
    `MTI reflex ${options.context.cellID}`,
    options.prompt,
  ];
}

export async function runMtiReflexCell(
  options: MtiReflexCellRunOptions,
): Promise<MtiReflexCellRunResult> {
  if (options.env.ORGANUM_CODE_SECRET_SOURCE !== "environment") {
    throw new TypeError(
      "MTI reflex requires ORGANUM_CODE_SECRET_SOURCE=environment",
    );
  }
  if (!options.upstreamToken || options.upstreamToken.includes("\0")) {
    throw new TypeError("MTI reflex upstream token is missing or invalid");
  }
  const profile: ProviderProfile = {
    ...options.profile,
    baseURL: literalLoopbackBaseURL(options.profile.baseURL),
  };
  const carrier = new MtiReflexCallIdentityCarrier();
  const projection = new MtiReflexUpstreamProjection(carrier);
  const delegate = new StdioMcpDelegate(options.stdioServer);
  const endpoint = new BoundedMtiReflexMcpEndpoint(
    options.context,
    options.receiptPath,
    carrier,
    undefined,
    delegate,
  );
  const mode = options.body === "claude"
    ? "messages-to-chat-completions" as const
    : brokerModeForProvider(profile);
  if (mode !== "chat-completions" && mode !== "messages-to-chat-completions") {
    await delegate.close();
    throw new TypeError("MTI reflex currently requires chat-completions wire shape");
  }
  const broker = new InferenceBroker({
    upstreamBaseURL: profile.baseURL,
    upstreamApiKey: options.upstreamToken,
    upstreamModel: profile.modelID,
    advertisedModel:
      options.body === "claude"
        ? options.advertisedClaudeModel ?? "claude-sonnet-4-5"
        : undefined,
    mode,
    finalRequestTransform: (body) => ({
      ...projection.transformRequest(body),
      stream: options.stream,
    }),
    ...(options.body === "claude"
      ? {
          chatCompletionBridgeResponseTransform: (body: Readonly<Record<string, unknown>>) =>
            projection.transformChatCompletion(body),
          chatCompletionBridgeStreamObserver: {
            observe: (event: Readonly<Record<string, unknown>>) =>
              projection.observeStreamEvent(event),
            complete: () => projection.completeStream(),
          },
        }
      : { completeResponseProjection: projection }),
    auxiliaryHandler: endpoint.handler,
  });
  const session = await broker.start();
  const descriptor = endpoint.descriptor(session.origin);
  const brokered = createBrokeredProviderProfile(profile, session);
  const launchEnvironment = buildBrokerLaunchEnvironment(
    options.env,
    profile.apiKeyEnv,
    session,
  );
  const args = launchArguments(options);
  let exitCode: number;
  try {
    if (options.body === "claude") {
      exitCode = await launchClaudeCode(
        args,
        session,
        options.advertisedClaudeModel ?? "claude-sonnet-4-5",
        launchEnvironment,
        options.cwd,
        { mcpServer: descriptor },
      );
    } else if (options.body === "grok") {
      exitCode = await launchGrokBuild(
        args,
        brokered,
        launchEnvironment,
        options.cwd,
        { mcpServer: descriptor },
      );
    } else {
      exitCode = await launchOpenCode(
        args,
        projectOpenCodeMtiReflexConfig(
          buildOpenCodeConfig(brokered),
          descriptor,
        ),
        {
          ...launchEnvironment,
          ORGANUM_CODE_FIRST_PARTY_PLUGIN: "0",
        },
        options.cwd,
      );
    }
    await broker.settle({ graceMs: 1_000, forceTimeoutMs: 1_000 });
    return {
      schema: "organum-code/mti-reflex-cell-run-result/v1",
      body: options.body,
      exitCode,
      endpoint: endpoint.snapshot(),
      projection: projection.snapshot(),
      broker: broker.snapshot(),
    };
  } finally {
    await broker.close().catch(() => undefined);
    await delegate.close();
  }
}
