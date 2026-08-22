import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import {
  ORGANUM_CODE_PRODUCT,
  ORGANUM_CODE_VERSION,
} from "./product.js";

export const ACP_PROTOCOL_VERSION = 1;
export const DEFAULT_ACP_MAX_LINE_BYTES = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type RequestID = string | number;

export interface AcpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: JsonRecord;
  authMethods: readonly AcpAuthMethod[];
  raw: JsonRecord;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpMcpServer {
  name: string;
  type?: "http" | "sse";
  command?: string;
  args?: readonly string[];
  env?: readonly { name: string; value: string }[];
  url?: string;
  headers?: readonly { name: string; value: string }[];
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  cancelRequested: boolean;
  admitted: boolean;
  suppressedUpdateCount: number;
  raw: JsonRecord;
}

export interface AcpPromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onUpdate?: (update: AcpSessionUpdate) => void | Promise<void>;
}

export type AcpClientRequestHandler = (
  params: unknown,
) => unknown | Promise<unknown>;

export type AcpNotificationHandler = (
  params: unknown,
) => void | Promise<void>;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  signal?: AbortSignal;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requestKey(id: RequestID): string {
  return `${typeof id}:${String(id)}`;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export class AcpRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed (${code}): ${message}`);
    this.name = "AcpRemoteError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Minimal, inspectable JSON-RPC 2.0 transport for ACP's newline-delimited
 * stdio binding. The transport is backend-neutral and also handles optional
 * agent-to-client requests such as permission or filesystem callbacks.
 */
export class AcpNdjsonTransport {
  private nextID = 1;
  private closed = false;
  private failure: Error | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers = new Map<string, AcpClientRequestHandler>();
  private readonly notificationHandlers =
    new Map<string, Set<AcpNotificationHandler>>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly maxLineBytes = DEFAULT_ACP_MAX_LINE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new TypeError("ACP maximum line size must be a positive safe integer");
    }
    void this.readLoop().catch((error: unknown) => {
      this.fail(
        error instanceof Error ? error : new AcpProtocolError(String(error)),
      );
    });
  }

  onRequest(method: string, handler: AcpClientRequestHandler): () => void {
    if (method.trim().length === 0) {
      throw new TypeError("ACP request method must not be empty");
    }
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  onNotification(method: string, handler: AcpNotificationHandler): () => void {
    if (method.trim().length === 0) {
      throw new TypeError("ACP notification method must not be empty");
    }
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  async request(
    method: string,
    params: unknown,
    options: AcpRequestOptions = {},
  ): Promise<unknown> {
    this.assertOpen();
    if (method.trim().length === 0) {
      throw new TypeError("ACP request method must not be empty");
    }
    if (options.signal?.aborted) {
      throw abortError(`${method} aborted before dispatch`);
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new TypeError("ACP request timeout must be a positive safe integer");
    }

    const id = this.nextID++;
    const key = requestKey(id);
    let pending: PendingRequest | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      pending = { method, resolve, reject };
    });
    this.pending.set(key, pending!);

    const rejectLocally = (error: Error): void => {
      const current = this.pending.get(key);
      if (current === undefined) return;
      this.pending.delete(key);
      this.clearPending(current);
      current.reject(error);
      void this.notify("$/cancel_request", { requestId: id }).catch(() => undefined);
    };
    if (options.timeoutMs !== undefined) {
      pending!.timer = setTimeout(() => {
        rejectLocally(
          new Error(`${method} timed out after ${options.timeoutMs}ms`),
        );
      }, options.timeoutMs);
    }
    if (options.signal !== undefined) {
      pending!.signal = options.signal;
      pending!.abort = () => {
        rejectLocally(abortError(`${method} aborted`));
      };
      options.signal.addEventListener("abort", pending!.abort, { once: true });
    }

    try {
      await this.writeMessage({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const current = this.pending.get(key);
      if (current !== undefined) {
        this.pending.delete(key);
        this.clearPending(current);
        current.reject(error);
      }
    }
    return await response;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.assertOpen();
    if (method.trim().length === 0) {
      throw new TypeError("ACP notification method must not be empty");
    }
    await this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.fail(new Error("ACP transport closed"));
    await new Promise<void>((resolveClose) => {
      this.input.end(resolveClose);
    }).catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.failure !== null) throw this.failure;
    if (this.closed) throw new Error("ACP transport is closed");
  }

  private clearPending(
    pending: PendingRequest,
  ): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.abort !== undefined && pending.signal !== undefined) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async writeMessage(message: JsonRecord): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > this.maxLineBytes) {
      throw new AcpProtocolError("outbound ACP message exceeds the line limit");
    }
    const write = async (): Promise<void> => {
      this.assertOpen();
      if (this.input.write(encoded)) return;
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const cleanup = (): void => {
          this.input.off("drain", resolveWrite);
          this.input.off("error", rejectWrite);
        };
        this.input.once("drain", () => {
          cleanup();
          resolveWrite();
        });
        this.input.once("error", (error) => {
          cleanup();
          rejectWrite(error);
        });
      });
    };
    const queued = this.writeTail.then(write);
    this.writeTail = queued.catch(() => undefined);
    await queued;
  }

  private async readLoop(): Promise<void> {
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    for await (const chunk of this.output) {
      buffered += decoder.write(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer,
      );
      buffered = await this.consumeLines(buffered);
      if (Buffer.byteLength(buffered, "utf8") > this.maxLineBytes) {
        throw new AcpProtocolError("inbound ACP message exceeds the line limit");
      }
    }
    buffered += decoder.end();
    if (buffered.trim().length > 0) {
      await this.consumeLine(buffered);
    }
    if (!this.closed) {
      throw new Error("ACP agent closed stdout");
    }
  }

  private async consumeLines(value: string): Promise<string> {
    let buffered = value;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return buffered;
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        throw new AcpProtocolError("inbound ACP message exceeds the line limit");
      }
      if (line.trim().length > 0) await this.consumeLine(line);
    }
  }

  private async consumeLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AcpProtocolError("ACP agent emitted malformed JSON");
    }
    const message = record(parsed);
    if (message === null || message.jsonrpc !== "2.0") {
      throw new AcpProtocolError("ACP agent emitted a non-JSON-RPC message");
    }
    const method = typeof message.method === "string" ? message.method : null;
    const id =
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : null;
    if (method !== null && id !== null) {
      await this.handleInboundRequest(id, method, message.params);
      return;
    }
    if (method !== null) {
      const handlers = this.notificationHandlers.get(method);
      if (handlers !== undefined) {
        for (const handler of handlers) await handler(message.params);
      }
      return;
    }
    if (id === null || (!("result" in message) && !("error" in message))) {
      throw new AcpProtocolError("ACP agent emitted an invalid response");
    }
    const key = requestKey(id);
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    this.clearPending(pending);
    const remoteError = record(message.error);
    if (remoteError !== null) {
      pending.reject(
        new AcpRemoteError(
          pending.method,
          typeof remoteError.code === "number" ? remoteError.code : -32000,
          typeof remoteError.message === "string"
            ? remoteError.message
            : "unknown remote error",
          remoteError.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleInboundRequest(
    id: RequestID,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      await this.writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported client method: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      await this.writeMessage({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      await this.writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: errorMessage(error) },
      });
    }
  }
}

function requiredRecord(value: unknown, context: string): JsonRecord {
  const result = record(value);
  if (result === null) throw new AcpProtocolError(`${context} must be an object`);
  return result;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AcpProtocolError(`${context} must be a nonempty string`);
  }
  return value;
}

function authMethods(value: unknown): readonly AcpAuthMethod[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AcpProtocolError("initialize.authMethods must be an array");
  }
  return value.map((item, index) => {
    const method = requiredRecord(item, `initialize.authMethods[${index}]`);
    return {
      id: requiredString(method.id, `initialize.authMethods[${index}].id`),
      ...(typeof method.name === "string" ? { name: method.name } : {}),
      ...(typeof method.description === "string"
        ? { description: method.description }
        : {}),
    };
  });
}

function stopReason(value: unknown): AcpStopReason {
  if (
    value === "end_turn" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new AcpProtocolError("session/prompt returned an unknown stopReason");
}

interface ActivePrompt {
  cancelRequested: boolean;
  cancelDispatch?: Promise<void>;
  suppressedUpdateCount: number;
}

export class AcpSession {
  private activePrompt: ActivePrompt | null = null;

  constructor(
    readonly sessionID: string,
    private readonly transport: AcpNdjsonTransport,
  ) {}

  async prompt(
    prompt: readonly JsonRecord[],
    options: AcpPromptOptions = {},
  ): Promise<AcpPromptResult> {
    if (prompt.length === 0) throw new TypeError("ACP prompt must not be empty");
    if (this.activePrompt !== null) {
      throw new Error(`ACP session ${this.sessionID} already has an active prompt`);
    }
    if (options.signal?.aborted) {
      throw abortError("ACP prompt aborted before dispatch");
    }
    const active: ActivePrompt = {
      cancelRequested: false,
      suppressedUpdateCount: 0,
    };
    this.activePrompt = active;
    const removeUpdate = this.transport.onNotification(
      "session/update",
      async (params) => {
        const notification = requiredRecord(params, "session/update params");
        if (notification.sessionId !== this.sessionID) return;
        const update = requiredRecord(
          notification.update,
          "session/update update",
        ) as AcpSessionUpdate;
        requiredString(update.sessionUpdate, "session/update sessionUpdate");
        if (active.cancelRequested) {
          active.suppressedUpdateCount += 1;
          return;
        }
        await options.onUpdate?.(update);
      },
    );
    const abort = (): void => {
      active.cancelRequested = true;
      active.cancelDispatch ??= this.transport.notify("session/cancel", {
        sessionId: this.sessionID,
      });
      void active.cancelDispatch.catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const raw = requiredRecord(
        await this.transport.request(
          "session/prompt",
          { sessionId: this.sessionID, prompt },
          { timeoutMs: options.timeoutMs },
        ),
        "session/prompt result",
      );
      await active.cancelDispatch;
      const reason = stopReason(raw.stopReason);
      return {
        stopReason: reason,
        cancelRequested: active.cancelRequested,
        admitted: !active.cancelRequested && reason !== "cancelled",
        suppressedUpdateCount: active.suppressedUpdateCount,
        raw,
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      removeUpdate();
      if (this.activePrompt === active) this.activePrompt = null;
    }
  }

  async cancel(): Promise<boolean> {
    const active = this.activePrompt;
    if (active === null) return false;
    active.cancelRequested = true;
    active.cancelDispatch ??= this.transport.notify("session/cancel", {
      sessionId: this.sessionID,
    });
    void active.cancelDispatch.catch(() => undefined);
    await active.cancelDispatch;
    return true;
  }
}

export class AcpClient {
  private initialization: AcpInitializeResult | null = null;

  constructor(
    private readonly transport: AcpNdjsonTransport,
    private readonly name: string = ORGANUM_CODE_PRODUCT,
    private readonly version: string = ORGANUM_CODE_VERSION,
  ) {}

  onRequest(method: string, handler: AcpClientRequestHandler): () => void {
    return this.transport.onRequest(method, handler);
  }

  async initialize(
    clientCapabilities: JsonRecord = {},
    options: AcpRequestOptions = {},
  ): Promise<AcpInitializeResult> {
    if (this.initialization !== null) return this.initialization;
    const raw = requiredRecord(
      await this.transport.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities,
          clientInfo: { name: this.name, version: this.version },
        },
        options,
      ),
      "initialize result",
    );
    if (raw.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpProtocolError(
        `unsupported ACP protocol version ${String(raw.protocolVersion)}`,
      );
    }
    const capabilities =
      raw.agentCapabilities === undefined
        ? {}
        : requiredRecord(raw.agentCapabilities, "initialize.agentCapabilities");
    this.initialization = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      authMethods: authMethods(raw.authMethods),
      raw,
    };
    return this.initialization;
  }

  async authenticate(
    methodID: string,
    options: AcpRequestOptions = {},
  ): Promise<void> {
    this.requireInitialized();
    if (methodID.trim().length === 0) {
      throw new TypeError("ACP authentication method must not be empty");
    }
    await this.transport.request(
      "authenticate",
      { methodId: methodID, _meta: { headless: true } },
      options,
    );
  }

  async newSession(
    cwd: string,
    mcpServers: readonly AcpMcpServer[] = [],
    options: AcpRequestOptions = {},
  ): Promise<AcpSession> {
    this.requireInitialized();
    this.validateCwd(cwd);
    const result = requiredRecord(
      await this.transport.request(
        "session/new",
        { cwd, mcpServers },
        options,
      ),
      "session/new result",
    );
    return new AcpSession(
      requiredString(result.sessionId, "session/new sessionId"),
      this.transport,
    );
  }

  async loadSession(
    sessionID: string,
    cwd: string,
    mcpServers: readonly AcpMcpServer[] = [],
    options: AcpRequestOptions = {},
  ): Promise<AcpSession> {
    const initialization = this.requireInitialized();
    if (initialization.agentCapabilities.loadSession !== true) {
      throw new Error("ACP agent does not advertise session/load");
    }
    this.validateCwd(cwd);
    requiredString(sessionID, "session/load sessionId");
    await this.transport.request(
      "session/load",
      { sessionId: sessionID, cwd, mcpServers },
      options,
    );
    return new AcpSession(sessionID, this.transport);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private requireInitialized(): AcpInitializeResult {
    if (this.initialization === null) {
      throw new Error("ACP client must initialize before session operations");
    }
    return this.initialization;
  }

  private validateCwd(cwd: string): void {
    if (!isAbsolute(cwd)) {
      throw new TypeError("ACP session cwd must be an absolute path");
    }
  }
}

export interface SpawnAcpProcessOptions {
  executable: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}

export interface AcpProcessConnection {
  client: AcpClient;
  child: ChildProcessWithoutNullStreams;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
  close(): Promise<void>;
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    // The process may already have exited.
  }
}

export function spawnAcpProcess(
  options: SpawnAcpProcessOptions,
): AcpProcessConnection {
  if (options.executable.trim().length === 0) {
    throw new TypeError("ACP executable must not be empty");
  }
  if (!isAbsolute(options.cwd)) {
    throw new TypeError("ACP process cwd must be absolute");
  }
  const child = spawn(options.executable, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = Buffer.concat([
      stderr,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
    if (stderr.byteLength > maxStderrBytes) {
      stderr = stderr.subarray(stderr.byteLength - maxStderrBytes);
    }
  });
  const transport = new AcpNdjsonTransport(
    child.stdin,
    child.stdout,
    options.maxLineBytes,
  );
  const client = new AcpClient(transport);
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  let closed = false;
  return {
    client,
    child,
    exit,
    stderr: () => stderr.toString("utf8"),
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => undefined);
      if (child.exitCode !== null || child.signalCode !== null) return;
      let gracefulTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exit.catch(() => undefined),
        new Promise<void>((resolveWait) => {
          gracefulTimer = setTimeout(resolveWait, 500);
        }),
      ]);
      if (gracefulTimer !== undefined) clearTimeout(gracefulTimer);
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalProcessTree(child, "SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exit.catch(() => undefined),
        new Promise<void>((resolveWait) => {
          timer = setTimeout(resolveWait, 1_000);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        signalProcessTree(child, "SIGKILL");
        await exit.catch(() => undefined);
      }
    },
  };
}
