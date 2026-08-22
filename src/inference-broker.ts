import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  anthropicMessageHasTextContent,
  anthropicMessageNativeToolProposals,
  anthropicMessagesToChatCompletions,
  approximateAnthropicInputTokens,
  chatCompletionToAnthropicMessage,
  ChatCompletionAnthropicStream,
  type AnthropicNativeToolProposal,
  type AnthropicSseEvent,
} from "./anthropic-chat-bridge.js";
import {
  chatCompletionToResponse,
  ChatCompletionResponsesStream,
  ResponsesChatBridgeError,
  responsesToChatCompletions,
  type ChatToolThoughtSignature,
  type ResponsesSseEvent,
  type ResponsesToolKind,
} from "./responses-chat-bridge.js";
import type { ProviderProfile } from "./provider-profile.js";
import {
  rateLimitHeaderSnapshot,
  SseJsonDecoder,
} from "./provider-probe.js";
import {
  type ExecutionBudgetController,
  type ExecutionBudgetSnapshot,
} from "./execution-budget.js";

export type JsonObject = Record<string, unknown>;

export type InferenceBrokerRequestTransform = (
  body: Readonly<JsonObject>,
) => JsonObject;

export interface InferenceBrokerRequestObservation {
  ordinal: number;
  upstreamRoute: string;
  body: Readonly<JsonObject>;
}

export type InferenceBrokerRequestObserver = (
  input: Readonly<InferenceBrokerRequestObservation>,
) => void;

export type InferenceBrokerSseTransform = (
  event: Readonly<JsonObject>,
) => JsonObject;

export type InferenceBrokerChatCompletionTransform = (
  body: Readonly<JsonObject>,
) => JsonObject;

export interface InferenceBrokerChatCompletionStreamObserver {
  observe(event: Readonly<JsonObject>): void;
  complete(): void;
}

export interface InferenceBrokerCompleteResponseProjectionInput {
  requestBody: Readonly<JsonObject>;
  contentType: string;
  body: Uint8Array;
}

export interface InferenceBrokerCompleteResponseProjectionResult {
  body: Uint8Array;
  observedValues?: readonly unknown[];
  commit?(): void | Promise<void>;
}

export interface InferenceBrokerCompleteResponseProjection {
  maxBytes: number;
  project(
    input: InferenceBrokerCompleteResponseProjectionInput,
  ): Promise<InferenceBrokerCompleteResponseProjectionResult>;
  abort?(error: unknown): void | Promise<void>;
}

export interface InferenceBrokerAnthropicToolProjectionInput {
  requestBody: Readonly<JsonObject>;
  proposals: readonly AnthropicNativeToolProposal[];
  hasTextContent: boolean;
}

export type InferenceBrokerNativeToolTerminalDecision =
  "policy_denied";

export const NATIVE_TOOL_POLICY_DENIAL_REASON_V1 =
  "organum_native_tool_policy_denied" as const;
export const NATIVE_TOOL_POLICY_DENIAL_TEXT_V1 =
  "Native tool request denied (organum_native_tool_policy_denied)." as const;

export interface InferenceBrokerAnthropicToolProjectionResult {
  terminalDecision?: InferenceBrokerNativeToolTerminalDecision;
}

export interface InferenceBrokerAnthropicToolProjection {
  maxBytes: number;
  project(
    input: InferenceBrokerAnthropicToolProjectionInput,
  ):
    | void
    | InferenceBrokerAnthropicToolProjectionResult
    | Promise<void | InferenceBrokerAnthropicToolProjectionResult>;
  abort?(error: unknown): void | Promise<void>;
}

export interface InferenceBrokerAuxiliaryContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

export type InferenceBrokerAuxiliaryHandler = (
  context: InferenceBrokerAuxiliaryContext,
) => boolean | Promise<boolean>;

export const BROKER_TOKEN_ENV = "ORGANUM_CODE_BROKER_TOKEN";

export type InferenceBrokerMode =
  | "chat-completions"
  | "responses"
  | "responses-to-chat-completions"
  | "messages"
  | "messages-to-chat-completions";

export interface InferenceBrokerLimits {
  ttlMs: number;
  maxRequests: number;
  maxConcurrent: number;
  maxRequestBytes: number;
  requestTimeoutMs: number;
}

export interface InferenceBrokerOptions {
  upstreamBaseURL: string;
  upstreamApiKey: string;
  upstreamModel: string;
  mode: InferenceBrokerMode;
  advertisedModel?: string;
  limits?: Partial<InferenceBrokerLimits>;
  fetch?: typeof fetch;
  now?: () => number;
  token?: string;
  upstreamHeaders?: Readonly<Record<string, string>>;
  requestTransform?: InferenceBrokerRequestTransform;
  finalRequestTransform?: InferenceBrokerRequestTransform;
  sseTransform?: InferenceBrokerSseTransform;
  completeResponseProjection?: InferenceBrokerCompleteResponseProjection;
  /** Applied to a complete chat-completions response before bridge translation. */
  chatCompletionBridgeResponseTransform?: InferenceBrokerChatCompletionTransform;
  chatCompletionBridgeStreamObserver?: InferenceBrokerChatCompletionStreamObserver;
  anthropicToolProjection?: InferenceBrokerAnthropicToolProjection;
  executionBudget?: ExecutionBudgetController;
  auxiliaryHandler?: InferenceBrokerAuxiliaryHandler;
  requestLifecycle?: InferenceBrokerRequestLifecycle;
  usageObserver?: InferenceBrokerUsageObserver;
  requestObserver?: InferenceBrokerRequestObserver;
}

export interface InferenceBrokerRequestLifecycle {
  prepare(input: {
    requestID: string;
    body: Readonly<JsonObject>;
    signal?: AbortSignal;
  }): Promise<JsonObject>;
  verify?(input: {
    requestID: string;
    body: Readonly<JsonObject>;
  }): void | Promise<void>;
  accepted?(input: {
    requestID: string;
  }): void | Promise<void>;
  complete(input: {
    requestID: string;
    successful: boolean;
  }): void | Promise<void>;
}

export interface InferenceBrokerSession {
  origin: string;
  baseURL: string;
  token: string;
  tokenEnv: typeof BROKER_TOKEN_ENV;
  mode: InferenceBrokerMode;
  upstreamModel: string;
  expiresAt: string;
}

export interface InferenceBrokerSnapshot {
  admittedRequests: number;
  activeRequests: number;
  rejectedRequests: number;
  upstreamRequests: number;
  cancelledRequests: number;
  lastFailureCode: string | null;
  lastRejectedModel: string | null;
  rateLimit: InferenceBrokerRateLimitSnapshot | null;
  usage: InferenceBrokerUsage;
  executionBudget?: ExecutionBudgetSnapshot;
}

export interface InferenceBrokerRateLimitSnapshot {
  observedAt: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  blockedUntil: string | null;
}

export interface InferenceBrokerUsage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface InferenceBrokerUsageEvent
  extends Omit<InferenceBrokerUsage, "responses"> {
  response: number;
}

export type InferenceBrokerUsageObserver = (
  event: Readonly<InferenceBrokerUsageEvent>,
) => void;

export interface InferenceBrokerSettlement {
  forcedAbortRequests: number;
  idle: boolean;
  snapshot: InferenceBrokerSnapshot;
}

const DEFAULT_LIMITS: InferenceBrokerLimits = {
  ttlMs: 4 * 60 * 60 * 1_000,
  maxRequests: 256,
  maxConcurrent: 2,
  maxRequestBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10 * 60 * 1_000,
};
const MAX_USAGE_CAPTURE_BYTES = 1024 * 1024;
const MAX_TOOL_THOUGHT_SIGNATURES = 256;
const MAX_TOOL_CALL_ID_BYTES = 4 * 1024;
const MAX_TOOL_NAME_BYTES = 1024;
const PROTECTED_UPSTREAM_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "x-api-key",
]);

export class InferenceBrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InferenceBrokerError";
  }
}

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function validatedUpstreamHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  const entries = Object.entries(headers);
  if (entries.length > 16) {
    throw new TypeError("At most 16 broker-owned upstream headers are allowed");
  }
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    const normalized = name.trim().toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) ||
      PROTECTED_UPSTREAM_HEADERS.has(normalized) ||
      normalized.startsWith("sec-") ||
      normalized.startsWith("proxy-") ||
      normalized.startsWith("x-forwarded-")
    ) {
      throw new TypeError(`Broker upstream header is not admitted: ${name}`);
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new TypeError(`Broker upstream header has an invalid value: ${name}`);
    }
    validated[name] = value;
  }
  return validated;
}

function anthropicTerminalDecisionMessage(
  message: Readonly<JsonObject>,
  decision: InferenceBrokerNativeToolTerminalDecision,
): JsonObject {
  if (decision !== "policy_denied") {
    throw new InferenceBrokerError(
      "Anthropic native tool terminal decision is unsupported",
      500,
      "native_tool_terminal_decision_invalid",
    );
  }
  return {
    ...message,
    content: [{
      type: "text",
      text: NATIVE_TOOL_POLICY_DENIAL_TEXT_V1,
    }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };
}

function anthropicTerminalDecisionEvents(
  events: readonly AnthropicSseEvent[],
  decision: InferenceBrokerNativeToolTerminalDecision,
): AnthropicSseEvent[] {
  if (decision !== "policy_denied") {
    throw new InferenceBrokerError(
      "Anthropic native tool terminal decision is unsupported",
      500,
      "native_tool_terminal_decision_invalid",
    );
  }
  const start = events.find((event) => event.event === "message_start");
  const startMessage = record(start?.data.message);
  if (start === undefined || startMessage === null) {
    throw new InferenceBrokerError(
      "Anthropic terminal decision requires a message start",
      502,
      "native_tool_terminal_decision_invalid",
    );
  }
  const finalDelta = [...events]
    .reverse()
    .find((event) => event.event === "message_delta");
  const finalUsage = record(finalDelta?.data.usage) ?? { output_tokens: 0 };
  return [
    {
      event: "message_start",
      data: {
        ...start.data,
        message: {
          ...startMessage,
          content: [],
          stop_reason: null,
          stop_sequence: null,
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: NATIVE_TOOL_POLICY_DENIAL_TEXT_V1,
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: finalUsage,
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nestedNumber(
  object: JsonObject,
  container: string,
  field: string,
): number | null {
  const nested = record(object[container]);
  return nested === null ? null : nonnegativeNumber(nested[field]);
}

function providerUsage(value: unknown): Omit<InferenceBrokerUsage, "responses"> | null {
  const envelope = record(value);
  const usage = envelope === null ? null : record(envelope.usage);
  if (usage === null) return null;
  const input =
    nonnegativeNumber(usage.prompt_tokens) ??
    nonnegativeNumber(usage.input_tokens) ??
    0;
  const reportedOutput =
    nonnegativeNumber(usage.completion_tokens) ??
    nonnegativeNumber(usage.output_tokens) ??
    0;
  const reportedTotal =
    nonnegativeNumber(usage.total_tokens) ?? input + reportedOutput;
  const unattributedOutput = Math.max(
    0,
    reportedTotal - input - reportedOutput,
  );
  const output = reportedOutput + unattributedOutput;
  const total = input + output;
  const cached =
    nestedNumber(usage, "prompt_tokens_details", "cached_tokens") ??
    nestedNumber(usage, "input_tokens_details", "cached_tokens") ??
    nonnegativeNumber(usage.prompt_cache_hit_tokens) ??
    nonnegativeNumber(usage.cache_read_input_tokens) ??
    0;
  const explicitReasoning =
    nestedNumber(usage, "completion_tokens_details", "reasoning_tokens") ??
    nestedNumber(usage, "output_tokens_details", "reasoning_tokens") ??
    0;
  const reasoning = Math.min(
    output,
    Math.max(explicitReasoning, unattributedOutput),
  );
  if (input === 0 && output === 0 && total === 0 && cached === 0 && reasoning === 0) {
    return null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
  };
}

interface RewrittenSseChunk {
  output: string;
  values: JsonObject[];
}

class SseEventRewriter {
  #buffer = "";

  constructor(readonly transform: InferenceBrokerSseTransform) {}

  push(text: string): RewrittenSseChunk {
    this.#buffer += text;
    let output = "";
    const values: JsonObject[] = [];
    while (true) {
      const separator = /\r?\n\r?\n/.exec(this.#buffer);
      if (separator === null || separator.index === undefined) break;
      const event = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator[0].length);
      const rewritten = this.#rewrite(event, separator[0]);
      output += rewritten.output;
      values.push(...rewritten.values);
    }
    return { output, values };
  }

  finish(text = ""): RewrittenSseChunk {
    this.#buffer += text;
    if (this.#buffer.length === 0) return { output: "", values: [] };
    const event = this.#buffer;
    this.#buffer = "";
    return this.#rewrite(event, "");
  }

  #rewrite(event: string, separator: string): RewrittenSseChunk {
    const lines = event.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") {
      return { output: `${event}${separator}`, values: [] };
    }
    try {
      const value = record(JSON.parse(data));
      if (value === null) return { output: `${event}${separator}`, values: [] };
      const transformed = this.transform(value);
      const firstData = lines.findIndex((line) => line.startsWith("data:"));
      const outputLines = lines.filter(
        (line, index) => !line.startsWith("data:") || index === firstData,
      );
      outputLines[firstData] = `data: ${JSON.stringify(transformed)}`;
      return {
        output: `${outputLines.join("\n")}${separator}`,
        values: [transformed],
      };
    } catch {
      // A malformed provider event remains byte-for-byte visible to the client;
      // response adaptation must not turn parse failure into silent data loss.
      return { output: `${event}${separator}`, values: [] };
    }
  }
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameSecret(left: string, rightHash: Buffer): boolean {
  return timingSafeEqual(hash(left), rightHash);
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function presentedTokens(headers: IncomingHttpHeaders): string[] {
  const values: string[] = [];
  const apiKey = oneHeader(headers["x-api-key"]);
  if (apiKey !== null) values.push(apiKey);
  const authorization = oneHeader(headers.authorization);
  if (authorization !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match === null) return ["__invalid_authorization__"];
    values.push(match[1]);
  }
  return values;
}

function positiveInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${context} must be a positive safe integer`);
  }
  return value;
}

function rateLimitResetDeadline(value: string | undefined, now: number): number {
  if (value === undefined) return 0;
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const numeric = Number(normalized);
  let candidate = 0;
  if (Number.isFinite(numeric) && numeric >= 0) {
    candidate = numeric >= 1_000_000_000
      ? numeric * 1_000
      : now + numeric * 1_000;
  } else {
    const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(
      normalized,
    );
    if (
      duration !== null &&
      duration.slice(1).some((part) => part !== undefined)
    ) {
      const milliseconds =
        Number(duration[1] ?? 0) * 3_600_000 +
        Number(duration[2] ?? 0) * 60_000 +
        Number(duration[3] ?? 0) * 1_000;
      candidate = now + milliseconds;
    } else {
      const timestamp = Date.parse(normalized);
      candidate = Number.isFinite(timestamp) ? timestamp : 0;
    }
  }
  if (!Number.isFinite(candidate) || candidate <= now) return 0;
  // Provider metadata is observational, not authority to create an unbounded
  // local denial. Published request/token windows reset well within this cap.
  return Math.min(candidate, now + 7 * 24 * 60 * 60 * 1_000);
}

function validatedBaseURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Broker upstream base URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "Broker upstream base URL must not contain credentials, query, or fragment",
    );
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "::1" &&
    url.hostname !== "localhost"
  ) {
    throw new TypeError("Non-loopback broker upstream must use https");
  }
  return value.replace(/\/+$/, "");
}

function routeFor(mode: InferenceBrokerMode): {
  inbound: string;
  upstream: string;
} {
  if (mode === "chat-completions") {
    return { inbound: "/v1/chat/completions", upstream: "/chat/completions" };
  }
  if (mode === "responses") {
    return { inbound: "/v1/responses", upstream: "/responses" };
  }
  if (mode === "responses-to-chat-completions") {
    return { inbound: "/v1/responses", upstream: "/chat/completions" };
  }
  if (mode === "messages") {
    return { inbound: "/v1/messages", upstream: "/messages" };
  }
  return { inbound: "/v1/messages", upstream: "/chat/completions" };
}

export class BrokerCapabilityGuard {
  readonly #tokenHash: Buffer;
  readonly #expiresAt: number;
  readonly #limits: InferenceBrokerLimits;
  readonly #now: () => number;
  #admitted = 0;
  #active = 0;
  #rejected = 0;

  constructor(
    token: string,
    issuedAt: number,
    limits: InferenceBrokerLimits,
    now: () => number = Date.now,
  ) {
    this.#tokenHash = hash(token);
    this.#expiresAt = issuedAt + limits.ttlMs;
    this.#limits = limits;
    this.#now = now;
  }

  authorize(headers: IncomingHttpHeaders): void {
    if (headers.origin !== undefined) {
      this.#reject("Browser-origin requests are not accepted", 403, "origin_denied");
    }
    const tokens = presentedTokens(headers);
    if (
      tokens.length === 0 ||
      tokens.some((token) => !sameSecret(token, this.#tokenHash))
    ) {
      this.#reject("Invalid broker capability", 401, "invalid_capability");
    }
    if (this.#now() >= this.#expiresAt) {
      this.#reject("Broker capability expired", 401, "capability_expired");
    }
  }

  reserve(): void {
    if (this.#admitted >= this.#limits.maxRequests) {
      this.#reject("Broker request budget exhausted", 429, "request_budget_exhausted");
    }
    if (this.#active >= this.#limits.maxConcurrent) {
      this.#reject("Broker concurrency limit reached", 429, "concurrency_limit");
    }
    this.#admitted += 1;
    this.#active += 1;
  }

  release(): void {
    this.#active = Math.max(0, this.#active - 1);
  }

  snapshot(): Pick<
    InferenceBrokerSnapshot,
    "admittedRequests" | "activeRequests" | "rejectedRequests"
  > {
    return {
      admittedRequests: this.#admitted,
      activeRequests: this.#active,
      rejectedRequests: this.#rejected,
    };
  }

  #reject(message: string, status: number, code: string): never {
    this.#rejected += 1;
    throw new InferenceBrokerError(message, status, code);
  }
}

function limitsFrom(options: Partial<InferenceBrokerLimits> | undefined): InferenceBrokerLimits {
  const limits = { ...DEFAULT_LIMITS, ...options };
  return {
    ttlMs: positiveInteger(limits.ttlMs, "Broker ttlMs"),
    maxRequests: positiveInteger(limits.maxRequests, "Broker maxRequests"),
    maxConcurrent: positiveInteger(limits.maxConcurrent, "Broker maxConcurrent"),
    maxRequestBytes: positiveInteger(
      limits.maxRequestBytes,
      "Broker maxRequestBytes",
    ),
    requestTimeoutMs: positiveInteger(
      limits.requestTimeoutMs,
      "Broker requestTimeoutMs",
    ),
  };
}

async function readBoundedJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<JsonObject> {
  const contentType = oneHeader(request.headers["content-type"]);
  if (contentType === null || !contentType.toLowerCase().startsWith("application/json")) {
    throw new InferenceBrokerError(
      "Broker accepts application/json only",
      415,
      "unsupported_media_type",
    );
  }
  const declared = Number(oneHeader(request.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new InferenceBrokerError(
      "Broker request body exceeds its byte limit",
      413,
      "request_too_large",
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new InferenceBrokerError(
        "Broker request body exceeds its byte limit",
        413,
        "request_too_large",
      );
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const object = record(value);
    if (object === null) throw new Error("not an object");
    return object;
  } catch {
    throw new InferenceBrokerError(
      "Broker request body must be one JSON object",
      400,
      "invalid_json",
    );
  }
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function safeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const known =
    error instanceof InferenceBrokerError
      ? error
      : new InferenceBrokerError(
          "Broker request failed internally",
          502,
          "broker_internal_error",
        );
  jsonResponse(response, known.status, {
    error: { type: known.code, message: known.message },
  });
}

function typedBrokerError(
  error: unknown,
  message: string,
  code: string,
): InferenceBrokerError {
  return error instanceof InferenceBrokerError
    ? error
    : new InferenceBrokerError(message, 502, code);
}

function upstreamError(response: ServerResponse, upstream: Response, messages: boolean): void {
  const headers: Record<string, string> = {};
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter !== null) headers["retry-after"] = retryAfter.slice(0, 128);
  if (messages) {
    jsonResponse(
      response,
      upstream.status,
      {
        type: "error",
        error: {
          type: upstream.status === 429 ? "overloaded_error" : "api_error",
          message: `Upstream provider returned HTTP ${upstream.status}`,
        },
      },
      headers,
    );
    return;
  }
  jsonResponse(
    response,
    upstream.status,
    {
      error: {
        type: "upstream_error",
        code: `http_${upstream.status}`,
        message: `Upstream provider returned HTTP ${upstream.status}`,
      },
    },
    headers,
  );
}

export async function writeBrokerResponseBytes(
  response: ServerResponse,
  bytes: Uint8Array,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new InferenceBrokerError(
      "Broker downstream response closed during write",
      499,
      "response_closed",
    );
  }
  if (response.write(bytes)) return;
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolveWrite();
    };
    const onClose = (): void => {
      cleanup();
      rejectWrite(
        new InferenceBrokerError(
          "Broker downstream response closed during backpressure",
          499,
          "response_closed",
        ),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectWrite(
        typedBrokerError(
          error,
          "Broker downstream response failed during write",
          "downstream_write_error",
        ),
      );
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.destroyed || response.writableEnded) onClose();
  });
}

async function finishBrokerResponse(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new InferenceBrokerError(
      "Broker downstream response closed before finish",
      499,
      "response_closed",
    );
  }
  await new Promise<void>((resolveFinish, rejectFinish) => {
    const cleanup = (): void => {
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onFinish = (): void => {
      cleanup();
      resolveFinish();
    };
    const onClose = (): void => {
      if (response.writableFinished) {
        onFinish();
        return;
      }
      cleanup();
      rejectFinish(
        new InferenceBrokerError(
          "Broker downstream response closed before flush",
          499,
          "response_closed",
        ),
      );
    };
    const onError = (): void => {
      cleanup();
      rejectFinish(
        new InferenceBrokerError(
          "Broker downstream response failed before flush",
          499,
          "downstream_write_error",
        ),
      );
    };
    response.once("finish", onFinish);
    response.once("close", onClose);
    response.once("error", onError);
    response.end();
  });
}

async function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: JsonObject,
): Promise<void> {
  await writeBrokerResponseBytes(
    response,
    new TextEncoder().encode(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    ),
  );
}

function validatedModel(body: JsonObject, expected: string): void {
  if (body.model !== expected) {
    throw new InferenceBrokerError(
      "Broker capability is bound to one exact model",
      400,
      "model_mismatch",
    );
  }
}

export function createBrokeredProviderProfile(
  profile: ProviderProfile,
  session: Pick<InferenceBrokerSession, "baseURL">,
): ProviderProfile {
  return {
    ...profile,
    baseURL: session.baseURL,
    apiKeyEnv: BROKER_TOKEN_ENV,
  };
}

export function brokerCapabilityEnvironment(
  session: Pick<InferenceBrokerSession, "token">,
): NodeJS.ProcessEnv {
  return { [BROKER_TOKEN_ENV]: session.token };
}

export function brokerModeForProvider(
  profile: Pick<ProviderProfile, "protocol">,
): "chat-completions" | "responses" {
  return profile.protocol;
}

export function buildBrokerLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  upstreamKeyEnv: string,
  session: Pick<InferenceBrokerSession, "token">,
): NodeJS.ProcessEnv {
  if (upstreamKeyEnv === BROKER_TOKEN_ENV) {
    throw new TypeError(
      `${BROKER_TOKEN_ENV} is reserved for the session capability`,
    );
  }
  const result: NodeJS.ProcessEnv = {
    ...env,
    [BROKER_TOKEN_ENV]: session.token,
  };
  delete result[upstreamKeyEnv];
  for (const name of Object.keys(result)) {
    if (name.startsWith("ORGANUM_CODE_CAST_")) delete result[name];
  }
  return result;
}

export function claudeBrokerEnvironment(
  session: Pick<InferenceBrokerSession, "origin" | "token">,
  advertisedModel: string,
): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_BASE_URL: session.origin,
    ANTHROPIC_API_KEY: session.token,
    ANTHROPIC_MODEL: advertisedModel,
  };
}

export class InferenceBroker {
  readonly #upstreamBaseURL: string;
  readonly #upstreamApiKey: string;
  readonly #upstreamModel: string;
  readonly #advertisedModel: string;
  readonly #mode: InferenceBrokerMode;
  readonly #limits: InferenceBrokerLimits;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #token: string;
  readonly #upstreamHeaders: Readonly<Record<string, string>>;
  readonly #requestTransform: InferenceBrokerRequestTransform | undefined;
  readonly #finalRequestTransform: InferenceBrokerRequestTransform | undefined;
  readonly #sseTransform: InferenceBrokerSseTransform | undefined;
  readonly #completeResponseProjection:
    | InferenceBrokerCompleteResponseProjection
    | undefined;
  readonly #chatCompletionBridgeResponseTransform:
    | InferenceBrokerChatCompletionTransform
    | undefined;
  readonly #chatCompletionBridgeStreamObserver:
    | InferenceBrokerChatCompletionStreamObserver
    | undefined;
  readonly #anthropicToolProjection:
    | InferenceBrokerAnthropicToolProjection
    | undefined;
  readonly #executionBudget: ExecutionBudgetController | undefined;
  readonly #auxiliaryHandler: InferenceBrokerAuxiliaryHandler | undefined;
  readonly #requestLifecycle: InferenceBrokerRequestLifecycle | undefined;
  readonly #usageObserver: InferenceBrokerUsageObserver | undefined;
  readonly #requestObserver: InferenceBrokerRequestObserver | undefined;
  readonly #issuedAt: number;
  readonly #guard: BrokerCapabilityGuard;
  readonly #server: Server;
  #session: InferenceBrokerSession | null = null;
  #upstreamRequests = 0;
  #cancelledRequests = 0;
  #lastFailureCode: string | null = null;
  #lastRejectedModel: string | null = null;
  #rateLimit: InferenceBrokerRateLimitSnapshot | null = null;
  #rateLimitBlockedUntil = 0;
  #requestSequence = 0;
  readonly #toolThoughtSignatures = new Map<string, {
    name: string;
    argumentsSha256: string;
    signature: string;
  }>();
  readonly #upstreamControllers = new Set<AbortController>();
  readonly #upstreamReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  readonly #activeResponses = new Set<ServerResponse>();
  readonly #usage: InferenceBrokerUsage = {
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(options: InferenceBrokerOptions) {
    this.#upstreamBaseURL = validatedBaseURL(options.upstreamBaseURL);
    this.#upstreamApiKey = options.upstreamApiKey.trim();
    this.#upstreamModel = options.upstreamModel.trim();
    this.#mode = options.mode;
    this.#advertisedModel =
      options.advertisedModel?.trim() || this.#upstreamModel;
    this.#limits = limitsFrom(options.limits);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#token = options.token ?? randomBytes(32).toString("base64url");
    this.#upstreamHeaders = validatedUpstreamHeaders(options.upstreamHeaders);
    this.#requestTransform = options.requestTransform;
    this.#finalRequestTransform = options.finalRequestTransform;
    this.#sseTransform = options.sseTransform;
    this.#completeResponseProjection = options.completeResponseProjection;
    this.#chatCompletionBridgeResponseTransform =
      options.chatCompletionBridgeResponseTransform;
    this.#chatCompletionBridgeStreamObserver =
      options.chatCompletionBridgeStreamObserver;
    this.#anthropicToolProjection = options.anthropicToolProjection;
    this.#executionBudget = options.executionBudget;
    this.#auxiliaryHandler = options.auxiliaryHandler;
    this.#requestLifecycle = options.requestLifecycle;
    this.#usageObserver = options.usageObserver;
    this.#requestObserver = options.requestObserver;
    this.#issuedAt = this.#now();
    if (
      this.#executionBudget !== undefined &&
      this.#mode !== "chat-completions"
    ) {
      throw new TypeError(
        "Adaptive execution budget currently requires chat-completions mode",
      );
    }
    if (
      this.#completeResponseProjection !== undefined &&
      this.#sseTransform !== undefined
    ) {
      throw new TypeError(
        "Complete response projection and streaming SSE transformation are mutually exclusive",
      );
    }
    if (this.#completeResponseProjection !== undefined) {
      positiveInteger(
        this.#completeResponseProjection.maxBytes,
        "Complete response projection maxBytes",
      );
    }
    if (this.#anthropicToolProjection !== undefined) {
      if (this.#mode !== "messages-to-chat-completions") {
        throw new TypeError(
          "Anthropic tool projection requires messages-to-chat-completions mode",
        );
      }
      positiveInteger(
        this.#anthropicToolProjection.maxBytes,
        "Anthropic tool projection maxBytes",
      );
    }
    if (
      this.#upstreamApiKey.length === 0 ||
      this.#upstreamModel.length === 0 ||
      this.#token.length < 24
    ) {
      throw new TypeError("Broker key, model, and strong capability token are required");
    }
    this.#guard = new BrokerCapabilityGuard(
      this.#token,
      this.#issuedAt,
      this.#limits,
      this.#now,
    );
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        this.#lastFailureCode =
          error instanceof InferenceBrokerError
            ? error.code
            : "broker_internal_error";
        safeError(response, error);
      });
    });
    this.#server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  async start(): Promise<InferenceBrokerSession> {
    if (this.#session !== null) return { ...this.#session };
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolveStart();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(0, "127.0.0.1");
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("Inference broker returned no TCP address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    this.#session = {
      origin,
      baseURL: `${origin}/v1`,
      token: this.#token,
      tokenEnv: BROKER_TOKEN_ENV,
      mode: this.#mode,
      upstreamModel: this.#upstreamModel,
      expiresAt: new Date(this.#issuedAt + this.#limits.ttlMs).toISOString(),
    };
    return { ...this.#session };
  }

  snapshot(): InferenceBrokerSnapshot {
    return {
      ...this.#guard.snapshot(),
      upstreamRequests: this.#upstreamRequests,
      cancelledRequests: this.#cancelledRequests,
      lastFailureCode: this.#lastFailureCode,
      lastRejectedModel: this.#lastRejectedModel,
      rateLimit: this.#rateLimit === null
        ? null
        : {
            ...this.#rateLimit,
            headers: { ...this.#rateLimit.headers },
            blockedUntil:
              this.#rateLimitBlockedUntil > this.#now()
                ? new Date(this.#rateLimitBlockedUntil).toISOString()
                : null,
          },
      usage: { ...this.#usage },
      ...(this.#executionBudget === undefined
        ? {}
        : {
            executionBudget: this.#executionBudget.snapshot({
              responses: this.#usage.responses,
              outputTokens: this.#usage.outputTokens,
            }),
          }),
    };
  }

  async settle(options: {
    graceMs?: number;
    forceTimeoutMs?: number;
  } = {}): Promise<InferenceBrokerSettlement> {
    const graceMs = Math.max(0, options.graceMs ?? 1_000);
    const forceTimeoutMs = Math.max(0, options.forceTimeoutMs ?? 1_000);
    if (await this.#waitForIdle(graceMs)) {
      return { forcedAbortRequests: 0, idle: true, snapshot: this.snapshot() };
    }

    const forcedAbortRequests = this.#guard.snapshot().activeRequests;
    for (const controller of this.#upstreamControllers) {
      if (controller.signal.aborted) continue;
      this.#cancelledRequests += 1;
      controller.abort(new Error("Broker settlement forced active request closed"));
    }
    for (const response of this.#activeResponses) {
      response.destroy(
        new Error("Broker settlement forced downstream response closed"),
      );
    }
    await Promise.allSettled(
      [...this.#upstreamReaders].map((reader) =>
        reader.cancel("Broker settlement forced active response closed")
      ),
    );
    const idle = await this.#waitForIdle(forceTimeoutMs);
    return { forcedAbortRequests, idle, snapshot: this.snapshot() };
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await this.settle({ graceMs: 0, forceTimeoutMs: 1_000 });
    await new Promise<void>((resolveClose, rejectClose) => {
      this.#server.close((error) =>
        error === undefined ? resolveClose() : rejectClose(error),
      );
      this.#server.closeAllConnections();
    });
    this.#session = null;
  }

  async #waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#guard.snapshot().activeRequests > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    return true;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      this.#auxiliaryHandler !== undefined &&
      await this.#auxiliaryHandler({
        request,
        response,
        url,
      })
    ) {
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      this.#guard.authorize(request.headers);
      this.#guard.reserve();
      try {
        jsonResponse(response, 200, {
          object: "list",
          data: [{
            id: this.#advertisedModel,
            object: "model",
            created: 0,
            owned_by: "organum-code-broker",
          }],
        });
      } finally {
        this.#guard.release();
      }
      return;
    }
    if (request.method !== "POST") {
      throw new InferenceBrokerError("Broker accepts POST only", 405, "method_not_allowed");
    }
    this.#guard.authorize(request.headers);
    const route = routeFor(this.#mode);
    const countTokens =
      (this.#mode === "messages" ||
        this.#mode === "messages-to-chat-completions") &&
      url.pathname === "/v1/messages/count_tokens";
    // Some official clients append transport metadata to the Messages URL.
    // Routing is bound to the exact pathname and no downstream query is ever
    // forwarded to the fixed upstream destination.
    if (!countTokens && url.pathname !== route.inbound) {
      throw new InferenceBrokerError("Broker route is not admitted", 404, "route_denied");
    }
    const body = await readBoundedJson(request, this.#limits.maxRequestBytes);
    if (countTokens) {
      this.#validateModel(body, this.#advertisedModel);
      this.#guard.reserve();
      try {
        jsonResponse(response, 200, {
          input_tokens: approximateAnthropicInputTokens(body),
        });
      } finally {
        this.#guard.release();
      }
      return;
    }

    let upstreamBody = body;
    let requestedModel = this.#advertisedModel;
    let bridgeStream = false;
    let responsesToolKinds: ReadonlyMap<string, ResponsesToolKind> | null = null;
    if (this.#mode === "messages-to-chat-completions") {
      this.#validateModel(body, this.#advertisedModel);
      const translated = anthropicMessagesToChatCompletions(
        body,
        this.#upstreamModel,
      );
      upstreamBody = translated.body;
      requestedModel = translated.requestedModel;
      bridgeStream = translated.stream;
    } else if (this.#mode === "responses-to-chat-completions") {
      this.#validateModel(body, this.#advertisedModel);
      let translated: ReturnType<typeof responsesToChatCompletions>;
      try {
        translated = responsesToChatCompletions(body, this.#upstreamModel, {
          thoughtSignatureForCall: (callID, name, arguments_) =>
            this.#toolThoughtSignature(callID, name, arguments_),
        });
      } catch (error) {
        if (error instanceof ResponsesChatBridgeError) {
          throw new InferenceBrokerError(
            error.message,
            400,
            "unsupported_responses_request",
          );
        }
        throw error;
      }
      upstreamBody = translated.body;
      requestedModel = translated.requestedModel;
      bridgeStream = translated.stream;
      responsesToolKinds = translated.toolKinds;
    } else {
      this.#validateModel(body, this.#upstreamModel);
    }
    if (
      Buffer.byteLength(JSON.stringify(upstreamBody), "utf8") >
        this.#limits.maxRequestBytes
    ) {
      throw new InferenceBrokerError(
        "Broker protocol translation exceeded the request byte limit",
        413,
        "translated_request_body_too_large",
      );
    }
    if (this.#requestTransform !== undefined) {
      upstreamBody = this.#requestTransform(upstreamBody);
      this.#validateModel(upstreamBody, this.#upstreamModel);
      if (
        Buffer.byteLength(JSON.stringify(upstreamBody), "utf8") >
          this.#limits.maxRequestBytes
      ) {
        throw new InferenceBrokerError(
          "Broker request transform exceeded the request byte limit",
          413,
          "request_transform_body_too_large",
        );
      }
    }
    if (this.#executionBudget !== undefined) {
      const decision =
        this.#executionBudget.prepareChatCompletionsRequest(
          upstreamBody,
          {
            responses: this.#usage.responses,
            outputTokens: this.#usage.outputTokens,
          },
        );
      if (!decision.admitted) {
        throw new InferenceBrokerError(
          "Adaptive execution budget exhausted",
          429,
          "execution_budget_exhausted",
        );
      }
      upstreamBody = decision.body;
      this.#validateModel(upstreamBody, this.#upstreamModel);
    }

    this.#guard.reserve();
    this.#activeResponses.add(response);
    const controller = new AbortController();
    this.#upstreamControllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error("Broker upstream timeout")),
      this.#limits.requestTimeoutMs,
    );
    const abort = (): void => {
      if (controller.signal.aborted) return;
      this.#cancelledRequests += 1;
      controller.abort(new Error("Backend request cancelled"));
    };
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });

    let lifecycleRequestID: string | null = null;
    let requestCompleted = false;
    try {
      if (this.#requestLifecycle !== undefined) {
        const requestID = `provider-${++this.#requestSequence}`;
        upstreamBody = await this.#requestLifecycle.prepare({
          requestID,
          body: upstreamBody,
          signal: controller.signal,
        });
        lifecycleRequestID = requestID;
        this.#validateModel(upstreamBody, this.#upstreamModel);
        if (
          Buffer.byteLength(JSON.stringify(upstreamBody), "utf8") >
            this.#limits.maxRequestBytes
        ) {
          throw new InferenceBrokerError(
            "Broker request lifecycle exceeded the request byte limit",
            413,
            "request_lifecycle_body_too_large",
          );
        }
      }
      if (this.#finalRequestTransform !== undefined) {
        upstreamBody = this.#finalRequestTransform(upstreamBody);
        this.#validateModel(upstreamBody, this.#upstreamModel);
        if (
          Buffer.byteLength(JSON.stringify(upstreamBody), "utf8") >
            this.#limits.maxRequestBytes
        ) {
          throw new InferenceBrokerError(
            "Broker final request transform exceeded the request byte limit",
            413,
            "final_request_transform_body_too_large",
          );
        }
      }
      if (
        lifecycleRequestID !== null &&
        this.#requestLifecycle?.verify !== undefined
      ) {
        await this.#requestLifecycle.verify({
          requestID: lifecycleRequestID,
          body: upstreamBody,
        });
      }
      this.#assertProviderQuotaAvailable();
      this.#requestObserver?.({
        ordinal: this.#upstreamRequests + 1,
        upstreamRoute: route.upstream,
        body: upstreamBody,
      });
      this.#upstreamRequests += 1;
      const upstreamURL = `${this.#upstreamBaseURL}${route.upstream}`;
      let upstream: Response;
      try {
        upstream = await this.#fetch(upstreamURL, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: bridgeStream ? "text/event-stream" : "application/json",
            ...this.#upstreamHeaders,
            ...(this.#mode === "messages"
              ? {
                  "x-api-key": this.#upstreamApiKey,
                  "anthropic-version":
                    oneHeader(request.headers["anthropic-version"]) ?? "2023-06-01",
                }
              : { authorization: `Bearer ${this.#upstreamApiKey}` }),
          },
          body: JSON.stringify(upstreamBody),
        });
        this.#observeRateLimit(upstream);
      } catch (error) {
        throw typedBrokerError(
          error,
          "Broker could not reach the upstream provider",
          "upstream_fetch_error",
        );
      }
      if (!upstream.ok) {
        upstreamError(
          response,
          upstream,
          this.#mode === "messages" ||
            this.#mode === "messages-to-chat-completions",
        );
        return;
      }
      if (
        lifecycleRequestID !== null &&
        this.#requestLifecycle?.accepted !== undefined
      ) {
        await this.#requestLifecycle.accepted({
          requestID: lifecycleRequestID,
        });
      }
      if (this.#mode === "messages-to-chat-completions") {
        if (bridgeStream) {
          try {
            await this.#bridgeStream(
              upstream,
              response,
              requestedModel,
              upstreamBody,
            );
          } catch (error) {
            throw typedBrokerError(
              error,
              "Broker lost the upstream response stream",
              "upstream_stream_error",
            );
          }
          requestCompleted = true;
        } else {
          let upstreamResponseBody: unknown;
          try {
            upstreamResponseBody = await upstream.json();
          } catch (error) {
            throw typedBrokerError(
              error,
              "Upstream provider returned invalid JSON",
              "invalid_upstream_json",
            );
          }
          this.#recordUsage(upstreamResponseBody);
          if (this.#chatCompletionBridgeResponseTransform !== undefined) {
            const object = record(upstreamResponseBody);
            if (object === null) {
              throw new InferenceBrokerError(
                "Upstream chat completion is not a JSON object",
                502,
                "invalid_upstream_json",
              );
            }
            upstreamResponseBody =
              this.#chatCompletionBridgeResponseTransform(object);
          }
          const translated = chatCompletionToAnthropicMessage(
            upstreamResponseBody,
            requestedModel,
          );
          let terminalDecision:
            | InferenceBrokerNativeToolTerminalDecision
            | undefined;
          if (this.#anthropicToolProjection !== undefined) {
            try {
              const projected =
                await this.#anthropicToolProjection.project({
                requestBody: upstreamBody,
                proposals: anthropicMessageNativeToolProposals(translated),
                hasTextContent: anthropicMessageHasTextContent(translated),
              });
              terminalDecision = projected?.terminalDecision;
            } catch (error) {
              await this.#anthropicToolProjection.abort?.(error);
              throw error;
            }
          }
          jsonResponse(
            response,
            200,
            terminalDecision === undefined
              ? translated
              : anthropicTerminalDecisionMessage(
                translated,
                terminalDecision,
              ),
          );
          requestCompleted = true;
        }
        return;
      }
      if (this.#mode === "responses-to-chat-completions") {
        if (responsesToolKinds === null) {
          throw new InferenceBrokerError(
            "Responses bridge lost its tool binding",
            500,
            "responses_bridge_state_missing",
          );
        }
        if (bridgeStream) {
          try {
            await this.#bridgeResponsesStream(
              upstream,
              response,
              requestedModel,
              responsesToolKinds,
            );
          } catch (error) {
            throw typedBrokerError(
              error,
              "Broker lost the upstream response stream",
              "upstream_stream_error",
            );
          }
          requestCompleted = true;
        } else {
          let upstreamResponseBody: unknown;
          try {
            upstreamResponseBody = await upstream.json();
          } catch (error) {
            throw typedBrokerError(
              error,
              "Upstream provider returned invalid JSON",
              "invalid_upstream_json",
            );
          }
          this.#recordUsage(upstreamResponseBody);
          jsonResponse(
            response,
            200,
            chatCompletionToResponse(
              upstreamResponseBody,
              requestedModel,
              responsesToolKinds,
              {
                onThoughtSignature: (metadata) =>
                  this.#rememberToolThoughtSignature(metadata),
              },
            ),
          );
          requestCompleted = true;
        }
        return;
      }
      try {
        await this.#passThrough(upstream, response, upstreamBody);
        requestCompleted = true;
      } catch (error) {
        throw typedBrokerError(
          error,
          "Broker lost the upstream response stream",
          "upstream_stream_error",
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.headersSent) {
          throw new InferenceBrokerError(
            "Broker request cancelled",
            499,
            "request_cancelled",
          );
        }
        response.destroy();
        return;
      }
      throw error;
    } finally {
      if (
        lifecycleRequestID !== null &&
        this.#requestLifecycle !== undefined
      ) {
        await this.#requestLifecycle.complete({
          requestID: lifecycleRequestID,
          successful: requestCompleted,
        });
      }
      clearTimeout(timer);
      request.off("aborted", abort);
      this.#upstreamControllers.delete(controller);
      this.#activeResponses.delete(response);
      this.#guard.release();
    }
  }

  #validateModel(body: JsonObject, expected: string): void {
    try {
      validatedModel(body, expected);
    } catch (error) {
      this.#lastRejectedModel =
        typeof body.model === "string" ? body.model.slice(0, 256) : null;
      throw error;
    }
  }

  #rememberToolThoughtSignature(metadata: ChatToolThoughtSignature): void {
    if (
      Buffer.byteLength(metadata.callID, "utf8") > MAX_TOOL_CALL_ID_BYTES ||
      Buffer.byteLength(metadata.name, "utf8") > MAX_TOOL_NAME_BYTES
    ) {
      return;
    }
    this.#toolThoughtSignatures.delete(metadata.callID);
    this.#toolThoughtSignatures.set(metadata.callID, {
      name: metadata.name,
      argumentsSha256: createHash("sha256")
        .update(metadata.arguments, "utf8")
        .digest("hex"),
      signature: metadata.signature,
    });
    while (this.#toolThoughtSignatures.size > MAX_TOOL_THOUGHT_SIGNATURES) {
      const oldest = this.#toolThoughtSignatures.keys().next().value;
      if (oldest === undefined) break;
      this.#toolThoughtSignatures.delete(oldest);
    }
  }

  #toolThoughtSignature(
    callID: string,
    name: string,
    arguments_: string,
  ): string | undefined {
    const stored = this.#toolThoughtSignatures.get(callID);
    if (
      stored === undefined ||
      stored.name !== name ||
      stored.argumentsSha256 !== createHash("sha256")
        .update(arguments_, "utf8")
        .digest("hex")
    ) {
      return undefined;
    }
    return stored.signature;
  }

  #assertProviderQuotaAvailable(): void {
    if (this.#rateLimitBlockedUntil <= this.#now()) return;
    throw new InferenceBrokerError(
      "Provider rate limit is still cooling down; no upstream request was sent",
      429,
      "provider_quota_guard",
    );
  }

  #observeRateLimit(upstream: Response): void {
    const now = this.#now();
    const headers = rateLimitHeaderSnapshot(upstream.headers);
    let blockedUntil = 0;
    if (headers["x-ratelimit-remaining-requests"] === "0") {
      blockedUntil = Math.max(
        blockedUntil,
        rateLimitResetDeadline(headers["x-ratelimit-reset-requests"], now),
      );
    }
    if (headers["x-ratelimit-remaining-tokens"] === "0") {
      blockedUntil = Math.max(
        blockedUntil,
        rateLimitResetDeadline(headers["x-ratelimit-reset-tokens"], now),
      );
    }
    if (upstream.status === 429) {
      blockedUntil = Math.max(
        blockedUntil,
        rateLimitResetDeadline(headers["retry-after"], now),
      );
    }
    this.#rateLimitBlockedUntil = Math.max(this.#rateLimitBlockedUntil, blockedUntil);
    if (Object.keys(headers).length > 0 || upstream.status === 429) {
      this.#rateLimit = {
        observedAt: new Date(now).toISOString(),
        status: upstream.status,
        headers,
        blockedUntil:
          this.#rateLimitBlockedUntil > now
            ? new Date(this.#rateLimitBlockedUntil).toISOString()
            : null,
      };
    }
  }

  async #passThrough(
    upstream: Response,
    response: ServerResponse,
    requestBody: Readonly<JsonObject>,
  ): Promise<void> {
    if (this.#completeResponseProjection !== undefined) {
      await this.#projectCompleteResponse(upstream, response, requestBody);
      return;
    }
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (upstream.body === null) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    this.#upstreamReaders.add(reader);
    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    const isSse = contentType.includes("text/event-stream");
    const decoder = isSse ? new TextDecoder() : null;
    const sse = isSse && this.#sseTransform === undefined
      ? new SseJsonDecoder()
      : null;
    const rewriter = isSse && this.#sseTransform !== undefined
      ? new SseEventRewriter(this.#sseTransform)
      : null;
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let captureOverflow = false;
    let usageRecorded = false;
    const observe = (items: readonly unknown[]): void => {
      if (usageRecorded) return;
      for (const item of items) {
        if (this.#recordUsage(item)) {
          usageRecorded = true;
          break;
        }
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isSse && decoder !== null && rewriter !== null) {
          const rewritten = rewriter.push(decoder.decode(value, { stream: true }));
          observe(rewritten.values);
          if (rewritten.output.length > 0) {
            await writeBrokerResponseBytes(
              response,
              new TextEncoder().encode(rewritten.output),
            );
          }
          continue;
        } else if (isSse && decoder !== null && sse !== null) {
          observe(sse.push(decoder.decode(value, { stream: true })).values);
        } else if (!captureOverflow) {
          capturedBytes += value.byteLength;
          if (capturedBytes <= MAX_USAGE_CAPTURE_BYTES) captured.push(value.slice());
          else captureOverflow = true;
        }
        await writeBrokerResponseBytes(response, value);
      }
      if (isSse && decoder !== null && rewriter !== null) {
        const rewritten = rewriter.finish(decoder.decode());
        observe(rewritten.values);
        if (rewritten.output.length > 0) {
          await writeBrokerResponseBytes(
            response,
            new TextEncoder().encode(rewritten.output),
          );
        }
      } else if (isSse && sse !== null) {
        observe(sse.finish().values);
      } else if (!captureOverflow && captured.length > 0) {
        try {
          observe([JSON.parse(new TextDecoder().decode(Buffer.concat(captured))) as unknown]);
        } catch {
          // Usage measurement is observational and never changes provider delivery.
        }
      }
      response.end();
    } finally {
      this.#upstreamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  async #projectCompleteResponse(
    upstream: Response,
    response: ServerResponse,
    requestBody: Readonly<JsonObject>,
  ): Promise<void> {
    const projection = this.#completeResponseProjection!;
    if (upstream.body === null) {
      const error = new InferenceBrokerError(
        "Upstream response projection requires a body",
        502,
        "empty_upstream_response",
      );
      await projection.abort?.(error);
      throw error;
    }
    const reader = upstream.body.getReader();
    this.#upstreamReaders.add(reader);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > projection.maxBytes) {
          await reader.cancel("Complete response projection byte limit exceeded")
            .catch(() => undefined);
          throw new InferenceBrokerError(
            "Upstream response exceeds the projection byte limit",
            502,
            "upstream_response_too_large",
          );
        }
        chunks.push(value.slice());
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const contentType =
        upstream.headers.get("content-type") ??
        "application/json; charset=utf-8";
      const projected = await projection.project({
        requestBody,
        contentType,
        body,
      });
      if (projected.body.byteLength > projection.maxBytes) {
        throw new InferenceBrokerError(
          "Projected response exceeds the projection byte limit",
          502,
          "projected_response_too_large",
        );
      }
      for (const value of projected.observedValues ?? []) {
        if (this.#recordUsage(value)) break;
      }
      response.writeHead(upstream.status, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (projected.body.byteLength > 0) {
        await writeBrokerResponseBytes(response, projected.body);
      }
      await finishBrokerResponse(response);
      await projected.commit?.();
    } catch (error) {
      await projection.abort?.(error);
      throw error;
    } finally {
      this.#upstreamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  async #bridgeResponsesStream(
    upstream: Response,
    response: ServerResponse,
    requestedModel: string,
    toolKinds: ReadonlyMap<string, ResponsesToolKind>,
  ): Promise<void> {
    if (upstream.body === null) {
      throw new InferenceBrokerError(
        "Upstream stream has no body",
        502,
        "empty_upstream_stream",
      );
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    const decoder = new TextDecoder();
    const sse = new SseJsonDecoder();
    const bridge = new ChatCompletionResponsesStream(
      requestedModel,
      toolKinds,
      {
        onThoughtSignature: (metadata) =>
          this.#rememberToolThoughtSignature(metadata),
      },
    );
    const reader = upstream.body.getReader();
    this.#upstreamReaders.add(reader);
    let parseErrors = 0;
    let usageRecorded = false;
    const emit = async (events: readonly ResponsesSseEvent[]): Promise<void> => {
      for (const event of events) {
        await writeSseEvent(response, event.event, event.data);
      }
    };
    const consume = async (decoded: ReturnType<SseJsonDecoder["push"]>) => {
      if (decoded.parseErrors > parseErrors) {
        throw new InferenceBrokerError(
          "Upstream returned malformed SSE",
          502,
          "malformed_upstream_sse",
        );
      }
      parseErrors = decoded.parseErrors;
      for (const item of decoded.values) {
        if (!usageRecorded && this.#recordUsage(item)) usageRecorded = true;
        await emit(bridge.push(item));
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode();
          if (tail.length > 0) await consume(sse.push(tail));
          await consume(sse.finish());
          break;
        }
        const decoded = sse.push(decoder.decode(value, { stream: true }));
        await consume(decoded);
        if (decoded.done) break;
      }
      await emit(bridge.finish());
      await finishBrokerResponse(response);
    } finally {
      this.#upstreamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  async #bridgeStream(
    upstream: Response,
    response: ServerResponse,
    requestedModel: string,
    requestBody: Readonly<JsonObject>,
  ): Promise<void> {
    if (upstream.body === null) {
      throw new InferenceBrokerError(
        "Upstream stream has no body",
        502,
        "empty_upstream_stream",
      );
    }
    const projection = this.#anthropicToolProjection;
    if (projection === undefined) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
    }
    const decoder = new TextDecoder();
    const sse = new SseJsonDecoder();
    const bridge = new ChatCompletionAnthropicStream(requestedModel);
    const reader = upstream.body.getReader();
    this.#upstreamReaders.add(reader);
    let parseErrors = 0;
    let usageRecorded = false;
    let upstreamBytes = 0;
    const bufferedEvents: AnthropicSseEvent[] = [];
    const emit = async (event: AnthropicSseEvent): Promise<void> => {
      if (projection === undefined) {
        await writeSseEvent(response, event.event, event.data);
      } else {
        bufferedEvents.push(event);
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!done) {
          upstreamBytes += value.byteLength;
          if (
            projection !== undefined &&
            upstreamBytes > projection.maxBytes
          ) {
            await reader.cancel(
              "Anthropic tool projection byte limit exceeded",
            ).catch(() => undefined);
            throw new InferenceBrokerError(
              "Upstream response exceeds the Anthropic projection byte limit",
              502,
              "upstream_response_too_large",
            );
          }
        }
        const decoded = done
          ? sse.finish()
          : sse.push(decoder.decode(value, { stream: true }));
        if (decoded.parseErrors > parseErrors) {
          throw new InferenceBrokerError(
            "Upstream returned malformed SSE",
            502,
            "malformed_upstream_sse",
          );
        }
        parseErrors = decoded.parseErrors;
        for (const item of decoded.values) {
          const observed = record(item);
          if (observed !== null) {
            this.#chatCompletionBridgeStreamObserver?.observe(observed);
          }
          if (!usageRecorded && this.#recordUsage(item)) usageRecorded = true;
          for (const event of bridge.push(item)) {
            await emit(event);
          }
        }
        if (done || decoded.done) break;
      }
      for (const event of bridge.finish()) {
        await emit(event);
      }
      this.#chatCompletionBridgeStreamObserver?.complete();
      if (projection !== undefined) {
        const projected = await projection.project({
          requestBody,
          proposals: bridge.nativeToolProposals(),
          hasTextContent: bridge.hasTextContent(),
        });
        const outputEvents =
          projected?.terminalDecision === undefined
            ? bufferedEvents
            : anthropicTerminalDecisionEvents(
              bufferedEvents,
              projected.terminalDecision,
            );
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        });
        for (const event of outputEvents) {
          await writeSseEvent(response, event.event, event.data);
        }
      }
      response.end();
    } catch (error) {
      await projection?.abort?.(error);
      throw error;
    } finally {
      this.#upstreamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  #recordUsage(value: unknown): boolean {
    const observed = providerUsage(value);
    if (observed === null) return false;
    this.#usageObserver?.({
      response: this.#usage.responses + 1,
      ...observed,
    });
    this.#usage.responses += 1;
    this.#usage.inputTokens += observed.inputTokens;
    this.#usage.outputTokens += observed.outputTokens;
    this.#usage.totalTokens += observed.totalTokens;
    this.#usage.cachedInputTokens += observed.cachedInputTokens;
    this.#usage.reasoningTokens += observed.reasoningTokens;
    return true;
  }
}
