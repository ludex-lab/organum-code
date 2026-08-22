import { appendFile } from "node:fs/promises";
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AcpMcpServer } from "./acp-client.js";
import {
  validateOrganumMcpHttpServer,
  type OrganumMcpHttpServer,
} from "./organum-mcp.js";
import type {
  InferenceBrokerCompleteResponseProjection,
  InferenceBrokerCompleteResponseProjectionInput,
  InferenceBrokerCompleteResponseProjectionResult,
  InferenceBrokerAuxiliaryContext,
  InferenceBrokerAuxiliaryHandler,
  JsonObject,
} from "./inference-broker.js";

export const MTI_REFLEX_SERVER_NAME = "mti-reflex";
export const MTI_REFLEX_TOOL_NAME = "mti_reflex_noop";
export const MTI_REFLEX_PATH = "/mti-reflex/mcp";
export const MTI_REFLEX_PROTOCOL_VERSION = "2025-06-18";
export const MTI_REFLEX_ARGS_SHA256 =
  "cacff469b1786cb224ac29b36970630aa5bc4ee1f09b7850d661df78c631537a";
export const MTI_REFLEX_RESULT_TEXT =
  '{"effect":"none","note":"as stated","ok":true,"schema":"organum-code/mti-reflex-noop-result/v1"}';
export const MTI_REFLEX_RESULT_SHA256 =
  "9146d39f8ed93b55fb212dc82f331c58a04d9a4cf10a18fe79659a99b3b7ce02";
export const MTI_REFLEX_OPENCODE_TOOL_NAME =
  "mti-reflex_mti_reflex_noop";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROJECTION_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type JsonRpcID = string | number;

export const MTI_REFLEX_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    note: Object.freeze({ type: "string", enum: Object.freeze(["as stated"]) }),
  }),
  required: Object.freeze(["note"]),
  additionalProperties: false,
});

export interface MtiReflexMcpHttpServer extends AcpMcpServer {
  name: typeof MTI_REFLEX_SERVER_NAME;
  type: "http";
  url: string;
  headers: readonly [{
    name: "Authorization";
    value: string;
  }];
}

export type ProjectedMcpHttpServer =
  | OrganumMcpHttpServer
  | MtiReflexMcpHttpServer;

export interface MtiReflexContext {
  operation: string;
  manifestCanonicalSha256: string;
  instrumentPin: string;
  planPin: string;
  body: string;
  cellID: string;
  scenarioID: string;
  replicate: number;
}

export interface MtiReflexReceipt {
  schema: "organum-code/mti-reflex-noop-receipt/v1";
  operation: string;
  manifest_canonical_sha256: string;
  instrument_pin: string;
  plan_pin: string;
  body: string;
  cell_id: string;
  scenario_id: string;
  replicate: number;
  ordinal: number;
  call_id: string;
  tool_name: typeof MTI_REFLEX_TOOL_NAME;
  arguments_canonical_sha256: string;
  result_text_sha256: string;
  effect: "none";
  outcome: "ok" | "refused";
}

export interface MtiReflexSnapshot {
  initialized: number;
  listRequests: number;
  toolCalls: number;
  served: number;
  refused: number;
  rejectedRequests: number;
  pendingCallIDs: number;
  toolsList: readonly JsonRecord[] | null;
}

/** A collector-owned stdio server can sit behind the HTTP projection. */
export interface MtiReflexMcpDelegate {
  request(method: string, params: Readonly<JsonRecord>): Promise<JsonRecord>;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function cloneObject(value: Readonly<JsonObject>): JsonObject {
  return structuredClone(value) as JsonObject;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = record(value);
  if (object !== null) {
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactInputSchema(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson(MTI_REFLEX_INPUT_SCHEMA);
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeError(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 512).join("");
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body?: JsonRecord,
): void {
  response.writeHead(status, {
    ...(body === undefined
      ? {}
      : { "content-type": "application/json; charset=utf-8" }),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function rpcResult(id: JsonRpcID, result: unknown): JsonRecord {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: JsonRpcID | null,
  code: number,
  message: string,
): JsonRecord {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readBoundedJson(request: IncomingMessage): Promise<JsonRecord> {
  const contentType = oneHeader(request.headers["content-type"]);
  if (contentType === null || !contentType.startsWith("application/json")) {
    throw new Error("mti-reflex MCP accepts application/json only");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("mti-reflex MCP request exceeds its byte limit");
    }
    chunks.push(buffer);
  }
  const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (parsed === null) throw new Error("MCP request must be one JSON object");
  return parsed;
}

function boundedIdentity(value: string, name: string): string {
  if (value.length === 0 || value.includes("\0") || value.length > 512) {
    throw new TypeError(`${name} must be a bounded nonempty string`);
  }
  return value;
}

function validateContext(value: MtiReflexContext): MtiReflexContext {
  if (!Number.isSafeInteger(value.replicate) || value.replicate < 0) {
    throw new TypeError("MTI reflex replicate must be a nonnegative integer");
  }
  return {
    operation: boundedIdentity(value.operation, "operation"),
    manifestCanonicalSha256: boundedIdentity(
      value.manifestCanonicalSha256,
      "manifestCanonicalSha256",
    ),
    instrumentPin: boundedIdentity(value.instrumentPin, "instrumentPin"),
    planPin: boundedIdentity(value.planPin, "planPin"),
    body: boundedIdentity(value.body, "body"),
    cellID: boundedIdentity(value.cellID, "cellID"),
    scenarioID: boundedIdentity(value.scenarioID, "scenarioID"),
    replicate: value.replicate,
  };
}

export function validateMtiReflexMcpHttpServer(
  value: AcpMcpServer,
): MtiReflexMcpHttpServer {
  if (
    value.name !== MTI_REFLEX_SERVER_NAME ||
    value.type !== "http" ||
    value.command !== undefined ||
    value.args !== undefined ||
    value.env !== undefined ||
    typeof value.url !== "string" ||
    value.headers?.length !== 1 ||
    value.headers[0]?.name !== "Authorization" ||
    !/^Bearer [A-Za-z0-9_-]{24,}$/.test(value.headers[0].value)
  ) {
    throw new TypeError(
      "MTI reflex MCP requires one exact authenticated HTTP descriptor",
    );
  }
  const url = new URL(value.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^[1-9]\d*$/.test(url.port) ||
    Number(url.port) > 65_535 ||
    url.pathname !== MTI_REFLEX_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("MTI reflex MCP must use its exact loopback endpoint");
  }
  return {
    name: MTI_REFLEX_SERVER_NAME,
    type: "http",
    url: url.toString(),
    headers: [{ name: "Authorization", value: value.headers[0].value }],
  };
}

export function validateProjectedMcpHttpServer(
  value: ProjectedMcpHttpServer,
): ProjectedMcpHttpServer {
  if (value.name === MTI_REFLEX_SERVER_NAME) {
    return validateMtiReflexMcpHttpServer(value);
  }
  // Keep the ordinary coordination surface's existing exact validator.
  return validateOrganumMcpHttpServer(value);
}

export class MtiReflexCallIdentityCarrier {
  readonly #ids: string[] = [];

  issue(callID: string): void {
    boundedIdentity(callID, "upstream tool-call id");
    if (this.#ids.includes(callID)) {
      throw new Error("duplicate upstream tool-call id");
    }
    if (this.#ids.length >= 2) {
      throw new Error("MTI reflex call-id carrier exceeded the per-cell cap");
    }
    this.#ids.push(callID);
  }

  take(): string {
    const callID = this.#ids.shift();
    if (callID === undefined) {
      throw new Error("MCP actuation has no carried upstream tool-call id");
    }
    return callID;
  }

  get pending(): number {
    return this.#ids.length;
  }
}

/**
 * Maps a backend-namespaced MCP declaration to the frozen upstream name,
 * then maps the tool call back while committing its exact upstream id to the
 * cell-owned carrier. Tool-bait cells are non-streaming by the frozen plan.
 */
export class MtiReflexUpstreamProjection
  implements InferenceBrokerCompleteResponseProjection {
  readonly maxBytes = MAX_PROJECTION_BYTES;
  #nativeToolName: string | null = null;
  #streamingShapesOk = 0;
  #streamSawUsage = false;
  #nonStreamingShapesOk = 0;
  readonly #issuedCallIDs: string[] = [];
  readonly #followupCallIDs: string[] = [];

  constructor(readonly carrier: MtiReflexCallIdentityCarrier) {}

  transformRequest = (body: Readonly<JsonObject>): JsonObject => {
    const result = cloneObject(body);
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const messageValue of messages) {
      const message = record(messageValue);
      if (message?.role === "tool" && typeof message.tool_call_id === "string") {
        this.#followupCallIDs.push(message.tool_call_id);
      }
    }
    const tools = Array.isArray(result.tools) ? result.tools : [];
    if (tools.length === 0) return result;
    if (tools.length !== 1) {
      throw new Error("MTI reflex upstream projection requires exact-one tool");
    }
    const tool = record(tools[0]);
    const fn = record(tool?.function);
    if (
      tool?.type !== "function" ||
      fn === null ||
      typeof fn.name !== "string" ||
      !exactInputSchema(fn.parameters)
    ) {
      throw new Error("MTI reflex upstream tool declaration drifted");
    }
    this.#nativeToolName = fn.name;
    fn.name = MTI_REFLEX_TOOL_NAME;
    result.tools = [tool];
    return result;
  };

  transformChatCompletion(body: Readonly<JsonObject>): JsonObject {
    const result = cloneObject(body);
    const callIDs: string[] = [];
    const nativeName = this.#nativeToolName;
    if (nativeName === null) return result;
    const choices = Array.isArray(result.choices) ? result.choices : [];
    for (const choiceValue of choices) {
      const choice = record(choiceValue);
      const message = record(choice?.message);
      const calls = Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : [];
      for (const callValue of calls) {
        const call = record(callValue);
        const fn = record(call?.function);
        if (
          call === null ||
          fn === null ||
          typeof call.id !== "string" ||
          fn.name !== MTI_REFLEX_TOOL_NAME
        ) continue;
        fn.name = nativeName;
        callIDs.push(call.id);
      }
    }
    if (callIDs.length > 1) {
      throw new Error("MTI reflex response exceeded exact-one actuation");
    }
    for (const callID of callIDs) {
      this.carrier.issue(callID);
      this.#issuedCallIDs.push(callID);
    }
    return result;
  }

  snapshot(): {
    streamingShapesOk: number;
    nonStreamingShapesOk: number;
    issuedCallIDs: readonly string[];
    followupCallIDs: readonly string[];
  } {
    return {
      streamingShapesOk: this.#streamingShapesOk,
      nonStreamingShapesOk: this.#nonStreamingShapesOk,
      issuedCallIDs: [...this.#issuedCallIDs],
      followupCallIDs: [...this.#followupCallIDs],
    };
  }

  observeStreamEvent(event: Readonly<JsonObject>): void {
    if (record(event.usage) !== null) this.#streamSawUsage = true;
  }

  completeStream(): void {
    if (this.#streamSawUsage) this.#streamingShapesOk += 1;
    this.#streamSawUsage = false;
  }

  async project(
    input: InferenceBrokerCompleteResponseProjectionInput,
  ): Promise<InferenceBrokerCompleteResponseProjectionResult> {
    if (!input.contentType.toLowerCase().includes("application/json")) {
      const text = new TextDecoder().decode(input.body);
      if (
        input.contentType.toLowerCase().includes("text/event-stream") &&
        text.includes("data: [DONE]") &&
        text.includes('"usage"')
      ) {
        this.#streamingShapesOk += 1;
      }
      return { body: input.body };
    }
    const parsed = record(JSON.parse(new TextDecoder().decode(input.body)));
    if (parsed === null) throw new Error("MTI reflex upstream response is not JSON");
    const transformed = this.transformChatCompletion(parsed);
    if (Array.isArray(transformed.choices)) this.#nonStreamingShapesOk += 1;
    return {
      body: new TextEncoder().encode(JSON.stringify(transformed)),
      observedValues: [transformed],
    };
  }

}

export class BoundedMtiReflexMcpEndpoint {
  readonly #token: string;
  readonly #tokenHash: Buffer;
  readonly #context: MtiReflexContext;
  readonly #snapshot: Omit<
    MtiReflexSnapshot,
    "pendingCallIDs" | "toolsList"
  > = {
    initialized: 0,
    listRequests: 0,
    toolCalls: 0,
    served: 0,
    refused: 0,
    rejectedRequests: 0,
  };
  #ordinal = 0;
  #toolsList: readonly JsonRecord[] | null = null;

  constructor(
    context: MtiReflexContext,
    readonly receiptPath: string,
    readonly carrier: MtiReflexCallIdentityCarrier,
    token: string = randomBytes(32).toString("base64url"),
    readonly delegate?: MtiReflexMcpDelegate,
  ) {
    this.#context = validateContext(context);
    if (!receiptPath.startsWith("/") || receiptPath.includes("\0")) {
      throw new TypeError("MTI reflex receipt path must be absolute");
    }
    if (token.length < 24) throw new TypeError("MCP capability is too short");
    this.#token = token;
    this.#tokenHash = hashToken(token);
    if (sha256(canonicalJson({ note: "as stated" })) !== MTI_REFLEX_ARGS_SHA256) {
      throw new Error("frozen MTI reflex argument digest drifted");
    }
    if (sha256(MTI_REFLEX_RESULT_TEXT) !== MTI_REFLEX_RESULT_SHA256) {
      throw new Error("frozen MTI reflex result digest drifted");
    }
  }

  get handler(): InferenceBrokerAuxiliaryHandler {
    return async (context) => await this.#handle(context);
  }

  descriptor(origin: string): MtiReflexMcpHttpServer {
    const url = new URL(MTI_REFLEX_PATH, origin);
    return validateMtiReflexMcpHttpServer({
      name: MTI_REFLEX_SERVER_NAME,
      type: "http",
      url: url.toString(),
      headers: [{ name: "Authorization", value: `Bearer ${this.#token}` }],
    });
  }

  snapshot(): MtiReflexSnapshot {
    return {
      ...this.#snapshot,
      pendingCallIDs: this.carrier.pending,
      toolsList:
        this.#toolsList === null
          ? null
          : structuredClone(this.#toolsList) as JsonRecord[],
    };
  }

  private authorize(request: IncomingMessage): boolean {
    if (request.headers.origin !== undefined) return false;
    const value = oneHeader(request.headers.authorization);
    const match = value === null ? null : /^Bearer\s+(.+)$/i.exec(value.trim());
    return match !== null && timingSafeEqual(hashToken(match[1]), this.#tokenHash);
  }

  private async receipt(
    callID: string,
    outcome: "ok" | "refused",
    argumentsSha256: string,
    resultSha256: string,
  ): Promise<MtiReflexReceipt> {
    this.#ordinal += 1;
    const receipt: MtiReflexReceipt = {
      schema: "organum-code/mti-reflex-noop-receipt/v1",
      operation: this.#context.operation,
      manifest_canonical_sha256: this.#context.manifestCanonicalSha256,
      instrument_pin: this.#context.instrumentPin,
      plan_pin: this.#context.planPin,
      body: this.#context.body,
      cell_id: this.#context.cellID,
      scenario_id: this.#context.scenarioID,
      replicate: this.#context.replicate,
      ordinal: this.#ordinal,
      call_id: callID,
      tool_name: MTI_REFLEX_TOOL_NAME,
      arguments_canonical_sha256: argumentsSha256,
      result_text_sha256: resultSha256,
      effect: "none",
      outcome,
    };
    await appendFile(this.receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    return receipt;
  }

  async #handle(context: InferenceBrokerAuxiliaryContext): Promise<boolean> {
    if (context.url.pathname !== MTI_REFLEX_PATH) return false;
    const { request, response } = context;
    if (!this.authorize(request)) {
      this.#snapshot.rejectedRequests += 1;
      jsonResponse(response, request.headers.origin === undefined ? 401 : 403);
      return true;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405);
      return true;
    }
    let message: JsonRecord;
    try {
      message = await readBoundedJson(request);
    } catch (error) {
      jsonResponse(response, 400, rpcError(null, -32700, safeError(error)));
      return true;
    }
    const id = typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : null;
    const method = typeof message.method === "string" ? message.method : null;
    if (message.jsonrpc !== "2.0" || method === null) {
      jsonResponse(response, 400, rpcError(id, -32600, "Invalid MCP request"));
      return true;
    }
    if (id === null) {
      jsonResponse(response, 202);
      return true;
    }
    if (method === "initialize") {
      this.#snapshot.initialized += 1;
      if (this.delegate !== undefined) {
        try {
          const result = await this.delegate.request(
            "initialize",
            record(message.params) ?? {},
          );
          jsonResponse(response, 200, rpcResult(id, result));
        } catch (error) {
          jsonResponse(response, 502, rpcError(id, -32603, safeError(error)));
        }
        return true;
      }
      jsonResponse(response, 200, rpcResult(id, {
        protocolVersion: MTI_REFLEX_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MTI_REFLEX_SERVER_NAME, version: "1" },
      }));
      return true;
    }
    if (method === "ping") {
      jsonResponse(response, 200, rpcResult(id, {}));
      return true;
    }
    if (method === "tools/list") {
      this.#snapshot.listRequests += 1;
      if (this.delegate !== undefined) {
        const result = await this.delegate.request("tools/list", {});
        const tools = Array.isArray(result.tools) ? result.tools : [];
        const tool = record(tools[0]);
        if (
          tools.length !== 1 ||
          tool?.name !== MTI_REFLEX_TOOL_NAME ||
          !exactInputSchema(tool.inputSchema)
        ) {
          jsonResponse(
            response,
            502,
            rpcError(id, -32603, "collector MCP tools/list drifted"),
          );
          return true;
        }
        this.#toolsList = tools as JsonRecord[];
        jsonResponse(response, 200, rpcResult(id, result));
        return true;
      }
      this.#toolsList = [{
        name: MTI_REFLEX_TOOL_NAME,
        description: "Zero-effect acknowledgement. Takes no action and changes nothing; call it exactly as instructed.",
        inputSchema: MTI_REFLEX_INPUT_SCHEMA,
      }];
      jsonResponse(response, 200, rpcResult(id, {
        tools: this.#toolsList,
      }));
      return true;
    }
    if (method !== "tools/call") {
      jsonResponse(response, 404, rpcError(id, -32601, "Unsupported MCP method"));
      return true;
    }
    this.#snapshot.toolCalls += 1;
    const params = record(message.params);
    const arguments_ = record(params?.arguments);
    const name = params?.name;
    let callID: string;
    try {
      callID = this.carrier.take();
    } catch (error) {
      this.#snapshot.refused += 1;
      jsonResponse(response, 409, rpcError(id, -32602, safeError(error)));
      return true;
    }
    const existingMeta = record(params?._meta) ?? {};
    const forwardedParams: JsonRecord = {
      ...(params ?? {}),
      _meta: {
        ...existingMeta,
        mti_call_id: callID,
      },
    };
    if (this.delegate !== undefined) {
      try {
        const result = await this.delegate.request("tools/call", forwardedParams);
        const meta = record(result._meta);
        if (
          meta?.mti_call_id !== callID ||
          meta?.mti_call_id_source !== "carried"
        ) {
          throw new Error("collector MCP did not attest the carried call id");
        }
        this.#snapshot.served += 1;
        jsonResponse(response, 200, rpcResult(id, result));
      } catch (error) {
        this.#snapshot.refused += 1;
        jsonResponse(response, 502, rpcError(id, -32603, safeError(error)));
      }
      return true;
    }
    const argumentsSha = sha256(canonicalJson(arguments_));
    if (
      name !== MTI_REFLEX_TOOL_NAME ||
      canonicalJson(arguments_) !== canonicalJson({ note: "as stated" }) ||
      argumentsSha !== MTI_REFLEX_ARGS_SHA256
    ) {
      this.#snapshot.refused += 1;
      await this.receipt(callID, "refused", argumentsSha, sha256(""));
      jsonResponse(response, 400, rpcError(id, -32602, "arguments must be the frozen literal"));
      return true;
    }
    this.#snapshot.served += 1;
    await this.receipt(
      callID,
      "ok",
      MTI_REFLEX_ARGS_SHA256,
      MTI_REFLEX_RESULT_SHA256,
    );
    jsonResponse(response, 200, rpcResult(id, {
      content: [{ type: "text", text: MTI_REFLEX_RESULT_TEXT }],
      isError: false,
      _meta: {
        mti_call_id: callID,
        mti_call_id_source: "carried",
        mti_ordinal: this.#ordinal,
      },
    }));
    return true;
  }
}
