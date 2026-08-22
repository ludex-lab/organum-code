import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AcpMcpServer } from "./acp-client.js";
import type {
  InferenceBrokerAuxiliaryContext,
  InferenceBrokerAuxiliaryHandler,
} from "./inference-broker.js";
import { ORGANUM_CODE_VERSION } from "./product.js";

export const ORGANUM_MCP_PROTOCOL_VERSION = "2025-06-18";
export const ORGANUM_MCP_SERVER_NAME = "organum-code";
export const ORGANUM_MCP_PATH = "/organum-code/mcp";
export const ORGANUM_MCP_MAX_REQUEST_BYTES = 64 * 1024;
export const ORGANUM_MCP_MAX_RESULT_BYTES = 64 * 1024;

type JsonRecord = Record<string, unknown>;
type JsonRpcID = string | number;

export interface BoundedMcpTool {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  call(arguments_: JsonRecord): Promise<unknown>;
}

export interface OrganumMcpHttpServer extends AcpMcpServer {
  name: typeof ORGANUM_MCP_SERVER_NAME;
  type: "http";
  url: string;
  headers: readonly [{
    name: "Authorization";
    value: string;
  }];
}

export interface OrganumMcpSnapshot {
  initialized: number;
  listRequests: number;
  toolCalls: number;
  toolErrors: number;
  rejectedRequests: number;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "MCP tool failed";
  return Array.from(
    raw
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"),
  ).slice(0, 512).join("");
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

async function readBoundedJson(
  request: IncomingMessage,
): Promise<JsonRecord> {
  const contentType = oneHeader(request.headers["content-type"]);
  if (
    contentType === null ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new Error("MCP accepts application/json only");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > ORGANUM_MCP_MAX_REQUEST_BYTES) {
      throw new Error("MCP request exceeds its byte limit");
    }
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const object = record(parsed);
  if (object === null) throw new Error("MCP request must be one JSON object");
  return object;
}

function protocolVersion(value: unknown): string {
  if (
    value === "2024-11-05" ||
    value === "2025-03-26" ||
    value === "2025-06-18" ||
    value === "2025-11-25"
  ) {
    return value;
  }
  return ORGANUM_MCP_PROTOCOL_VERSION;
}

export function validateOrganumMcpHttpServer(
  value: AcpMcpServer,
): OrganumMcpHttpServer {
  if (
    value.name !== ORGANUM_MCP_SERVER_NAME ||
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
      "Native Organum MCP requires one exact authenticated HTTP descriptor",
    );
  }
  const url = new URL(value.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^[1-9]\d*$/.test(url.port) ||
    Number(url.port) > 65_535 ||
    url.pathname !== ORGANUM_MCP_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Native Organum MCP must use the exact bounded loopback endpoint",
    );
  }
  return {
    name: ORGANUM_MCP_SERVER_NAME,
    type: "http",
    url: url.toString(),
    headers: [{
      name: "Authorization",
      value: value.headers[0].value,
    }],
  };
}

function toolResult(value: unknown): JsonRecord {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  if (Buffer.byteLength(text, "utf8") > ORGANUM_MCP_MAX_RESULT_BYTES) {
    throw new Error("MCP tool result exceeds its byte limit");
  }
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function toolError(error: unknown): JsonRecord {
  return {
    content: [{ type: "text", text: safeError(error) }],
    isError: true,
  };
}

export class BoundedOrganumMcpEndpoint {
  readonly #token: string;
  readonly #tokenHash: Buffer;
  readonly #tools: Map<string, BoundedMcpTool>;
  readonly #snapshot: OrganumMcpSnapshot = {
    initialized: 0,
    listRequests: 0,
    toolCalls: 0,
    toolErrors: 0,
    rejectedRequests: 0,
  };

  constructor(
    tools: readonly BoundedMcpTool[],
    token: string = randomBytes(32).toString("base64url"),
  ) {
    if (token.length < 24) {
      throw new TypeError("MCP endpoint requires a strong capability token");
    }
    this.#token = token;
    this.#tokenHash = hash(token);
    this.#tools = new Map();
    for (const tool of tools) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) ||
        this.#tools.has(tool.name)
      ) {
        throw new TypeError("MCP tool names must be unique lowercase identifiers");
      }
      this.#tools.set(tool.name, tool);
    }
  }

  get handler(): InferenceBrokerAuxiliaryHandler {
    return async (context) => await this.#handle(context);
  }

  descriptor(origin: string): OrganumMcpHttpServer {
    const url = new URL(ORGANUM_MCP_PATH, origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("Organum MCP must use an exact loopback HTTP origin");
    }
    return {
      name: ORGANUM_MCP_SERVER_NAME,
      type: "http",
      url: url.toString(),
      headers: [{
        name: "Authorization",
        value: `Bearer ${this.#token}`,
      }],
    };
  }

  snapshot(): OrganumMcpSnapshot {
    return { ...this.#snapshot };
  }

  private authorize(request: IncomingMessage): boolean {
    if (request.headers.origin !== undefined) return false;
    const authorization = oneHeader(request.headers.authorization);
    const match =
      authorization === null
        ? null
        : /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return (
      match !== null &&
      timingSafeEqual(hash(match[1]), this.#tokenHash)
    );
  }

  async #handle(
    context: InferenceBrokerAuxiliaryContext,
  ): Promise<boolean> {
    if (context.url.pathname !== ORGANUM_MCP_PATH) return false;
    const { request, response } = context;
    if (!this.authorize(request)) {
      this.#snapshot.rejectedRequests += 1;
      jsonResponse(response, request.headers.origin === undefined ? 401 : 403);
      return true;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      jsonResponse(response, 405);
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
    const id =
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : null;
    const method =
      typeof message.method === "string" ? message.method : null;
    if (message.jsonrpc !== "2.0" || method === null) {
      jsonResponse(response, 400, rpcError(id, -32600, "Invalid MCP request"));
      return true;
    }
    if (id === null) {
      jsonResponse(response, 202);
      return true;
    }

    if (method === "initialize") {
      const params = record(message.params);
      this.#snapshot.initialized += 1;
      jsonResponse(response, 200, rpcResult(id, {
        protocolVersion: protocolVersion(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: ORGANUM_MCP_SERVER_NAME,
          version: ORGANUM_CODE_VERSION,
        },
      }));
      return true;
    }
    if (method === "ping") {
      jsonResponse(response, 200, rpcResult(id, {}));
      return true;
    }
    if (method === "tools/list") {
      this.#snapshot.listRequests += 1;
      jsonResponse(response, 200, rpcResult(id, {
        tools: [...this.#tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }));
      return true;
    }
    if (method === "tools/call") {
      const params = record(message.params);
      const name = typeof params?.name === "string" ? params.name : null;
      const arguments_ =
        params?.arguments === undefined ? {} : record(params.arguments);
      if (name === null || arguments_ === null) {
        jsonResponse(
          response,
          400,
          rpcError(id, -32602, "Invalid MCP tool arguments"),
        );
        return true;
      }
      const tool = this.#tools.get(name);
      if (tool === undefined) {
        jsonResponse(
          response,
          404,
          rpcError(id, -32601, "Unknown MCP tool"),
        );
        return true;
      }
      this.#snapshot.toolCalls += 1;
      let result: JsonRecord;
      try {
        result = toolResult(await tool.call(arguments_));
      } catch (error) {
        this.#snapshot.toolErrors += 1;
        result = toolError(error);
      }
      jsonResponse(response, 200, rpcResult(id, result));
      return true;
    }

    jsonResponse(
      response,
      404,
      rpcError(id, -32601, "Unsupported MCP method"),
    );
    return true;
  }
}
