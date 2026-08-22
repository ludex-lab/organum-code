import { BROKER_TOKEN_ENV, type InferenceBrokerSession } from "./inference-broker.js";
import { buildGrokArgs, buildGrokConfig } from "./grok-launcher.js";
import type { ProviderProfile } from "./provider-profile.js";
import type { ExecutionBudgetSnapshot } from "./execution-budget.js";

export const HARBOR_BROKER_PROTOCOL_VERSION = 1;
export const HARBOR_GROK_VERSION = "0.2.111";
export const HARBOR_VERSION = "0.18.0";

const MAX_HARBOR_PROMPT_BYTES = 256 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HarborGrokPrepareRequest {
  type: "prepare-grok";
  protocol_version: typeof HARBOR_BROKER_PROTOCOL_VERSION;
  session_id: string;
  prompt: string;
}

export interface HarborBrokerFinishRequest {
  type: "finish";
  protocol_version: typeof HARBOR_BROKER_PROTOCOL_VERSION;
  session_id: string;
}

export type HarborBrokerRequest =
  | HarborGrokPrepareRequest
  | HarborBrokerFinishRequest;

export interface HarborGrokLaunchPlan {
  schema: "organum-code/harbor-grok-plan/v1";
  session_id: string;
  backend: "grok";
  grok_version: typeof HARBOR_GROK_VERSION;
  model: string;
  config_toml: string;
  argv: string[];
  environment: {
    [BROKER_TOKEN_ENV]: string;
  };
  clear_environment: string[];
  broker: {
    base_url: string;
    expires_at: string;
  };
}

export interface HarborBrokerFinishReport {
  schema: "organum-code/harbor-broker-finish/v1";
  session_id: string;
  idle: boolean;
  forced_abort_requests: number;
  upstream_requests: number;
  rejected_requests: number;
  cancelled_requests: number;
  active_requests: number;
  usage: {
    responses: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
  };
  execution_budget?: ExecutionBudgetSnapshot;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validatedSessionID(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError("Harbor session_id must be a UUID");
  }
  return value.toLowerCase();
}

function validatedPrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Harbor prompt must be a nonempty string");
  }
  if (value.includes("\0")) {
    throw new TypeError("Harbor prompt must not contain NUL");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_HARBOR_PROMPT_BYTES) {
    throw new TypeError("Harbor prompt exceeds the 256 KiB admission limit");
  }
  return value;
}

export function parseHarborBrokerRequest(value: unknown): HarborBrokerRequest {
  const input = object(value);
  if (input === null) throw new TypeError("Harbor broker request must be an object");
  if (input.protocol_version !== HARBOR_BROKER_PROTOCOL_VERSION) {
    throw new TypeError(
      `Harbor broker protocol_version must be ${HARBOR_BROKER_PROTOCOL_VERSION}`,
    );
  }
  const sessionID = validatedSessionID(input.session_id);
  if (input.type === "prepare-grok") {
    return {
      type: "prepare-grok",
      protocol_version: HARBOR_BROKER_PROTOCOL_VERSION,
      session_id: sessionID,
      prompt: validatedPrompt(input.prompt),
    };
  }
  if (input.type === "finish") {
    return {
      type: "finish",
      protocol_version: HARBOR_BROKER_PROTOCOL_VERSION,
      session_id: sessionID,
    };
  }
  throw new TypeError("Harbor broker request type is not supported");
}

/**
 * Docker Desktop maps this hostname to the host and can reach a service that
 * remains bound to host loopback. Linux Docker is deliberately not guessed
 * here: it needs a separately admitted host-gateway transport.
 */
export function dockerDesktopBrokerBaseURL(
  hostBaseURL: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(
      "Harbor broker transport currently requires Docker Desktop on macOS or Windows",
    );
  }
  const url = new URL(hostBaseURL);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.username ||
    url.password ||
    url.pathname !== "/v1" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Harbor broker transport accepts only the scoped loopback /v1 broker URL",
    );
  }
  url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/, "");
}

export function buildHarborGrokLaunchPlan(
  profile: ProviderProfile,
  session: InferenceBrokerSession,
  request: HarborGrokPrepareRequest,
  platform: NodeJS.Platform = process.platform,
): HarborGrokLaunchPlan {
  const admitted = parseHarborBrokerRequest(request);
  if (admitted.type !== "prepare-grok") {
    throw new TypeError("Expected a prepare-grok request");
  }
  if (profile.apiKeyEnv === BROKER_TOKEN_ENV) {
    throw new TypeError(`${BROKER_TOKEN_ENV} is reserved for broker capabilities`);
  }
  const containerBaseURL = dockerDesktopBrokerBaseURL(session.baseURL, platform);
  const brokeredProfile: ProviderProfile = {
    ...profile,
    baseURL: containerBaseURL,
    apiKeyEnv: BROKER_TOKEN_ENV,
  };
  const argv = buildGrokArgs(
    [
      "--single",
      admitted.prompt,
      "--verbatim",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--no-subagents",
      "--disable-web-search",
      "--no-memory",
    ],
    admitted.session_id,
    profile.modelID,
  );
  return {
    schema: "organum-code/harbor-grok-plan/v1",
    session_id: admitted.session_id,
    backend: "grok",
    grok_version: HARBOR_GROK_VERSION,
    model: profile.modelID,
    config_toml: buildGrokConfig(brokeredProfile),
    argv,
    environment: {
      [BROKER_TOKEN_ENV]: session.token,
    },
    clear_environment: [profile.apiKeyEnv],
    broker: {
      base_url: containerBaseURL,
      expires_at: session.expiresAt,
    },
  };
}

export function buildHarborBrokerFinishReport(
  sessionID: string,
  settlement: {
    idle: boolean;
    forcedAbortRequests: number;
    snapshot: {
      upstreamRequests: number;
      rejectedRequests: number;
      cancelledRequests: number;
      activeRequests: number;
      usage: {
        responses: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
      };
      executionBudget?: ExecutionBudgetSnapshot;
    };
  },
): HarborBrokerFinishReport {
  const id = validatedSessionID(sessionID);
  const snapshot = settlement.snapshot;
  return {
    schema: "organum-code/harbor-broker-finish/v1",
    session_id: id,
    idle: settlement.idle,
    forced_abort_requests: settlement.forcedAbortRequests,
    upstream_requests: snapshot.upstreamRequests,
    rejected_requests: snapshot.rejectedRequests,
    cancelled_requests: snapshot.cancelledRequests,
    active_requests: snapshot.activeRequests,
    usage: {
      responses: snapshot.usage.responses,
      input_tokens: snapshot.usage.inputTokens,
      output_tokens: snapshot.usage.outputTokens,
      total_tokens: snapshot.usage.totalTokens,
      cached_input_tokens: snapshot.usage.cachedInputTokens,
      reasoning_tokens: snapshot.usage.reasoningTokens,
    },
    ...(snapshot.executionBudget === undefined
      ? {}
      : { execution_budget: snapshot.executionBudget }),
  };
}
