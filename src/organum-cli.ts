import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  derivePublishIdempotencyKey,
  isValidCellIdentity,
  parseCellIdentity,
  type CellIdentity,
} from "./organum-identity.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STDOUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 32 * 1024;
export const ORGANUM_BENCH_OOB_LOG_ENV =
  "ORGANUM_BENCH_OOB_LOG" as const;
export const ORGANUM_BENCH_ORIGIN_ENV =
  "ORGANUM_BENCH_ORIGIN" as const;
export const ORGANUM_BENCH_SEED_BODY_FILE_ENV =
  "ORGANUM_BENCH_SEED_BODY_FILE" as const;
export const ORGANUM_BENCH_SEED_SENDER_ENV =
  "ORGANUM_BENCH_SEED_SENDER" as const;
export const ORGANUM_BENCH_SEED_TOPIC_ENV =
  "ORGANUM_BENCH_SEED_TOPIC" as const;
export const ORGANUM_BENCH_SEED_THREAD_ENV =
  "ORGANUM_BENCH_SEED_THREAD" as const;
const ORGANUM_ENVIRONMENT_NAMES = [
  "CI",
  "ComSpec",
  "FORCE_COLOR",
  "LANG",
  "NO_COLOR",
  "ORGANUM_LANG",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "WINDIR",
] as const;

export interface OrganumCommandRequest {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  redactions: readonly string[];
}

export interface OrganumCommandResult {
  stdout: string;
  stderr: string;
}

export type OrganumCommandExecutor = (
  request: OrganumCommandRequest,
) => Promise<OrganumCommandResult>;

export class OrganumCommandError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "aborted"
      | "contract"
      | "exit"
      | "invalid_json"
      | "output_limit"
      | "spawn"
      | "timeout",
  ) {
    super(message);
    this.name = "OrganumCommandError";
  }
}

const ORGANUM_BENCH_SEED_ENVIRONMENT_NAMES = [
  ORGANUM_BENCH_SEED_BODY_FILE_ENV,
  ORGANUM_BENCH_SEED_SENDER_ENV,
  ORGANUM_BENCH_SEED_TOPIC_ENV,
  ORGANUM_BENCH_SEED_THREAD_ENV,
] as const;

function organumBenchmarkContractError(message: string): never {
  throw new OrganumCommandError(message, "contract");
}

/**
 * Admit only the supervisor-owned benchmark envelope needed by the Organum
 * subprocess. Seed variables are an all-or-none extension of a lane-scoped
 * OOB ledger and never enter the general child passthrough allowlist.
 */
export function buildOrganumBenchmarkEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const oobLog = source[ORGANUM_BENCH_OOB_LOG_ENV]?.trim();
  if (oobLog !== undefined) {
    if (
      oobLog.length === 0 ||
      !isAbsolute(oobLog) ||
      oobLog.includes("\0") ||
      Buffer.byteLength(oobLog, "utf8") > 4_096
    ) {
      organumBenchmarkContractError(
        `${ORGANUM_BENCH_OOB_LOG_ENV} must be a bounded absolute path`,
      );
    }
    output[ORGANUM_BENCH_OOB_LOG_ENV] = resolve(oobLog);
  }

  const oobOrigin = source[ORGANUM_BENCH_ORIGIN_ENV]?.trim();
  if (oobOrigin !== undefined) {
    if (
      oobLog === undefined ||
      (oobOrigin !== "lane" && oobOrigin !== "harness")
    ) {
      organumBenchmarkContractError(
        `${ORGANUM_BENCH_ORIGIN_ENV} requires an OOB log and must be lane or harness`,
      );
    }
    output[ORGANUM_BENCH_ORIGIN_ENV] = oobOrigin;
  }

  const presentSeedNames = ORGANUM_BENCH_SEED_ENVIRONMENT_NAMES.filter(
    (name) => source[name] !== undefined,
  );
  if (presentSeedNames.length === 0) return output;
  if (presentSeedNames.length !== ORGANUM_BENCH_SEED_ENVIRONMENT_NAMES.length) {
    organumBenchmarkContractError(
      "ORGANUM_BENCH_SEED_* variables must be supplied all-or-none",
    );
  }
  if (oobLog === undefined || oobOrigin !== "lane") {
    organumBenchmarkContractError(
      "ORGANUM_BENCH_SEED_* requires a lane-scoped OOB log",
    );
  }

  const bodyFile = source[ORGANUM_BENCH_SEED_BODY_FILE_ENV]?.trim() ?? "";
  if (
    bodyFile.length === 0 ||
    !isAbsolute(bodyFile) ||
    bodyFile.includes("\0") ||
    Buffer.byteLength(bodyFile, "utf8") > 4_096
  ) {
    organumBenchmarkContractError(
      `${ORGANUM_BENCH_SEED_BODY_FILE_ENV} must be a bounded absolute path`,
    );
  }
  const canonicalBodyFile = resolve(bodyFile);
  if (dirname(canonicalBodyFile) !== dirname(resolve(oobLog))) {
    organumBenchmarkContractError(
      `${ORGANUM_BENCH_SEED_BODY_FILE_ENV} must share the OOB run directory`,
    );
  }

  const sender = source[ORGANUM_BENCH_SEED_SENDER_ENV]?.trim() ?? "";
  if (!isValidCellIdentity(sender)) {
    organumBenchmarkContractError(
      `${ORGANUM_BENCH_SEED_SENDER_ENV} must be a canonical cell identity`,
    );
  }
  const topic = source[ORGANUM_BENCH_SEED_TOPIC_ENV]?.trim() ?? "";
  const thread = source[ORGANUM_BENCH_SEED_THREAD_ENV]?.trim() ?? "";
  for (const [name, value] of [
    [ORGANUM_BENCH_SEED_TOPIC_ENV, topic],
    [ORGANUM_BENCH_SEED_THREAD_ENV, thread],
  ] as const) {
    if (
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 128
    ) {
      organumBenchmarkContractError(
        `${name} must be nonempty and at most 128 UTF-8 bytes`,
      );
    }
  }

  output[ORGANUM_BENCH_SEED_BODY_FILE_ENV] = canonicalBodyFile;
  output[ORGANUM_BENCH_SEED_SENDER_ENV] = sender;
  output[ORGANUM_BENCH_SEED_TOPIC_ENV] = topic;
  output[ORGANUM_BENCH_SEED_THREAD_ENV] = thread;
  return output;
}

export function buildOrganumCliEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const name of ORGANUM_ENVIRONMENT_NAMES) {
    if (source[name] !== undefined) output[name] = source[name];
  }
  for (const name of Object.keys(source)) {
    if (name.startsWith("LC_") && source[name] !== undefined) {
      output[name] = source[name];
    }
  }
  Object.assign(output, buildOrganumBenchmarkEnvironment(source));

  const hostPaths = [
    ["ORGANUM_CODE_HOST_HOME", "HOME"],
    ["ORGANUM_CODE_HOST_USERPROFILE", "USERPROFILE"],
    ["ORGANUM_CODE_HOST_APPDATA", "APPDATA"],
    ["ORGANUM_CODE_HOST_LOCALAPPDATA", "LOCALAPPDATA"],
  ] as const;
  for (const [savedName, targetName] of hostPaths) {
    const value = source[savedName] ?? source[targetName];
    if (value !== undefined) output[targetName] = value;
  }
  return output;
}

function redact(text: string, values: readonly string[]): string {
  let output = text
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  for (const value of values) {
    if (value.length > 0) output = output.split(value).join("[REDACTED]");
  }
  return output;
}

export const executeOrganumCommand: OrganumCommandExecutor = async (
  request,
) => {
  if (request.signal?.aborted) {
    throw new OrganumCommandError("Organum command aborted", "aborted");
  }

  return await new Promise<OrganumCommandResult>((resolve, reject) => {
    const child = spawn(request.binary, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedError: OrganumCommandError | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);
      callback();
    };
    const failAndStop = (error: OrganumCommandError): void => {
      if (forcedError) return;
      forcedError = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const abort = (): void => {
      failAndStop(new OrganumCommandError("Organum command aborted", "aborted"));
    };
    const timer = setTimeout(() => {
      failAndStop(
        new OrganumCommandError(
          `Organum command timed out after ${request.timeoutMs}ms`,
          "timeout",
        ),
      );
    }, request.timeoutMs);

    request.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) {
        failAndStop(
          new OrganumCommandError(
            `Organum stdout exceeded ${request.maxStdoutBytes} bytes`,
            "output_limit",
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > request.maxStderrBytes) {
        failAndStop(
          new OrganumCommandError(
            `Organum stderr exceeded ${request.maxStderrBytes} bytes`,
            "output_limit",
          ),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      finish(() => {
        reject(
          new OrganumCommandError(
            `Unable to start Organum CLI: ${redact(error.message, request.redactions)}`,
            "spawn",
          ),
        );
      });
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (forcedError) {
          reject(forcedError);
          return;
        }
        const stderrText = redact(
          Buffer.concat(stderr).toString("utf8").trim(),
          request.redactions,
        );
        if (code !== 0) {
          const detail = stderrText ? `: ${stderrText}` : "";
          reject(
            new OrganumCommandError(
              `Organum command failed (${code ?? signal ?? "unknown"})${detail}`,
              "exit",
            ),
          );
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: stderrText,
        });
      });
    });

    child.stdin.on("error", () => {
      // The close event carries the authoritative command outcome.
    });
    child.stdin.end(request.stdin);
  });
};

export interface FieldItem {
  file: string;
  from: string;
  from_id: string;
  to: string;
  topic: string;
  thread: string;
  in_reply_to: string;
  idem: string;
  ts: string;
  escalate: boolean;
  body: string;
}

export interface JoinResult {
  cell: CellIdentity;
  role: string;
  started: boolean;
  persona: string | null;
  workspace: JoinWorkspace | null;
  registration: JoinRegistration | null;
  charter: string;
  goal: JoinGoal[];
  inbox: FieldItem[];
  alarms: Array<Record<string, unknown>>;
}

export interface JoinGoal {
  from: string;
  body: string;
  file?: string;
  from_id?: string;
  to?: string;
  topic?: string;
  ts?: string;
  thread?: string;
  in_reply_to?: string;
  escalate?: boolean;
}

export interface JoinWorkspace {
  key: string;
  label: string;
}

export interface JoinRegistration {
  epoch: string;
  registeredAt: string;
  leaseExpiresAt: string | null;
}

export interface HubMemberBinding {
  identity: CellIdentity;
  epoch: string;
}

export interface HubItem {
  event_id: string;
  file: string;
  from_id: string;
  from: string;
  from_persona: string;
  from_workspace: string;
  to_address: string;
  to_id: CellIdentity;
  to_persona: string;
  to_workspace: string;
  to_epoch: string;
  ts: string;
  topic: string;
  idem: string;
  thread: string;
  in_reply_to: string;
  escalate: false;
  body: string;
}

export interface HubInboxPage {
  items: HubItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface HubInboxRequest extends HubMemberBinding {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface HubReadReceipt {
  file: string;
  eventID: string;
  forID: CellIdentity;
  toEpoch: string;
  read: true;
  alreadyRead: boolean;
}

export interface HubReadTarget {
  file: string;
  event_id: string;
  to_id: CellIdentity;
  to_epoch: string;
}

export interface HubSendReceipt {
  file: string;
  eventID: string;
  fromID: CellIdentity;
  idempotencyKey: string;
  to: {
    address: string;
    cell: CellIdentity;
    persona: string;
    workspace: string;
    epoch: string;
  };
}

export interface SessionStatus {
  sid: string;
  role: string;
  intent: string;
  age_min: number;
  idle_min: number;
  notes: number;
  started_at: string;
}

export interface PublishReceipt {
  file: string;
  fromID: CellIdentity;
  idempotencyKey: string;
}

interface PublishBase {
  identity: CellIdentity;
  turnID: string;
  body: string;
  displayFrom?: string;
  topic?: string;
  thread?: string;
  replyTo?: string;
  escalate?: boolean;
  signal?: AbortSignal;
}

export interface AgoraPublishRequest extends PublishBase {}

export interface RelaySendRequest extends PublishBase {
  to: string;
}

export interface HubSendRequest extends PublishBase {
  to: string;
}

export interface OrganumCliOptions {
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  hubDirectory?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  redactions?: readonly string[];
  executor?: OrganumCommandExecutor;
}

export interface OrganumJoinRequest {
  identity: CellIdentity;
  role: string;
  intent?: string;
  persona?: string;
  workspace?: string;
  loadout?: string;
  problemType?: string;
  signal?: AbortSignal;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrganumCommandError(`${context} must be an object`, "contract");
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  if (typeof value[key] !== "string") {
    throw new OrganumCommandError(`${context}.${key} must be a string`, "contract");
  }
  return value[key];
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const output = value[key];
  if (typeof output !== "number" || !Number.isFinite(output)) {
    throw new OrganumCommandError(`${context}.${key} must be a number`, "contract");
  }
  return output;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): boolean {
  if (typeof value[key] !== "boolean") {
    throw new OrganumCommandError(`${context}.${key} must be a boolean`, "contract");
  }
  return value[key];
}

function optionalNullableStringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | null {
  const output = value[key];
  if (output === undefined || output === null) return null;
  if (typeof output !== "string") {
    throw new OrganumCommandError(`${context}.${key} must be a string or null`, "contract");
  }
  return output;
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const output = value[key];
  if (output === undefined) return undefined;
  if (typeof output !== "string") {
    throw new OrganumCommandError(`${context}.${key} must be a string`, "contract");
  }
  return output;
}

function optionalBooleanField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): boolean | undefined {
  const output = value[key];
  if (output === undefined) return undefined;
  if (typeof output !== "boolean") {
    throw new OrganumCommandError(`${context}.${key} must be a boolean`, "contract");
  }
  return output;
}

function canonicalDimension(value: string, context: string): string {
  if (!isValidCellIdentity(value)) {
    throw new OrganumCommandError(
      `${context} must use the canonical Organum identity grammar`,
      "contract",
    );
  }
  return value.toLowerCase();
}

function parseJoinWorkspace(
  value: unknown,
  context: string,
): JoinWorkspace | null {
  if (value === undefined || value === null) return null;
  const workspace = record(value, context);
  const label = stringField(workspace, "label", context);
  if (label.trim().length === 0) {
    throw new OrganumCommandError(`${context}.label must be nonempty`, "contract");
  }
  return {
    key: canonicalDimension(stringField(workspace, "key", context), `${context}.key`),
    label,
  };
}

function parseJoinRegistration(
  value: unknown,
  context: string,
): JoinRegistration | null {
  if (value === undefined || value === null) return null;
  const registration = record(value, context);
  const epoch = stringField(registration, "epoch", context);
  const registeredAt = stringField(registration, "registered_at", context);
  const leaseExpiresAt = optionalNullableStringField(
    registration,
    "lease_expires_at",
    context,
  );
  if (epoch.trim().length === 0) {
    throw new OrganumCommandError(`${context}.epoch must be nonempty`, "contract");
  }
  if (registeredAt.trim().length === 0) {
    throw new OrganumCommandError(
      `${context}.registered_at must be nonempty`,
      "contract",
    );
  }
  if (leaseExpiresAt !== null && leaseExpiresAt.trim().length === 0) {
    throw new OrganumCommandError(
      `${context}.lease_expires_at must be nonempty or null`,
      "contract",
    );
  }
  return { epoch, registeredAt, leaseExpiresAt };
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): unknown[] {
  if (!Array.isArray(value[key])) {
    throw new OrganumCommandError(`${context}.${key} must be an array`, "contract");
  }
  return value[key];
}

function parseFieldItem(value: unknown, context: string): FieldItem {
  const item = record(value, context);
  return {
    file: safeEnvelopeFile(stringField(item, "file", context)),
    from: stringField(item, "from", context),
    from_id: stringField(item, "from_id", context),
    to: stringField(item, "to", context),
    topic: stringField(item, "topic", context),
    thread: stringField(item, "thread", context),
    in_reply_to: stringField(item, "in_reply_to", context),
    idem: stringField(item, "idem", context),
    ts: stringField(item, "ts", context),
    escalate: booleanField(item, "escalate", context),
    body: stringField(item, "body", context),
  };
}

function parseFieldItems(value: unknown, context: string): FieldItem[] {
  if (!Array.isArray(value)) {
    throw new OrganumCommandError(`${context} must be an array`, "contract");
  }
  return value.map((item, index) => parseFieldItem(item, `${context}[${index}]`));
}

function nonemptyStringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const output = stringField(value, key, context);
  if (output.trim().length === 0) {
    throw new OrganumCommandError(`${context}.${key} must be nonempty`, "contract");
  }
  return output;
}

function parseHubItem(
  value: unknown,
  context: string,
  binding: HubMemberBinding,
): HubItem {
  const item = record(value, context);
  const toID = parseCellIdentity(nonemptyStringField(item, "to_id", context));
  const toEpoch = nonemptyStringField(item, "to_epoch", context);
  if (toID !== binding.identity || toEpoch !== binding.epoch) {
    throw new OrganumCommandError(
      `${context} does not match the active hub member binding`,
      "contract",
    );
  }
  const escalate = booleanField(item, "escalate", context);
  if (escalate) {
    throw new OrganumCommandError(
      `${context}.escalate must be false for the queue-only hub contract`,
      "contract",
    );
  }
  return {
    event_id: nonemptyStringField(item, "event_id", context),
    file: safeEnvelopeFile(stringField(item, "file", context)),
    from_id: stringField(item, "from_id", context),
    from: stringField(item, "from", context),
    from_persona: stringField(item, "from_persona", context),
    from_workspace: stringField(item, "from_workspace", context),
    to_address: nonemptyStringField(item, "to_address", context),
    to_id: toID,
    to_persona: canonicalDimension(
      nonemptyStringField(item, "to_persona", context),
      `${context}.to_persona`,
    ),
    to_workspace: canonicalDimension(
      nonemptyStringField(item, "to_workspace", context),
      `${context}.to_workspace`,
    ),
    to_epoch: toEpoch,
    ts: nonemptyStringField(item, "ts", context),
    topic: stringField(item, "topic", context),
    idem: stringField(item, "idem", context),
    thread: stringField(item, "thread", context),
    in_reply_to: stringField(item, "in_reply_to", context),
    escalate: false,
    body: stringField(item, "body", context),
  };
}

function parseHubInboxPage(
  value: unknown,
  binding: HubMemberBinding,
): HubInboxPage {
  const page = record(value, "hub.inbox");
  const items = arrayField(page, "items", "hub.inbox").map((item, index) =>
    parseHubItem(item, `hub.inbox.items[${index}]`, binding),
  );
  const nextCursor = optionalNullableStringField(
    page,
    "next_cursor",
    "hub.inbox",
  );
  const hasMore = booleanField(page, "has_more", "hub.inbox");
  if (
    (nextCursor !== null && nextCursor.length === 0) ||
    hasMore !== (nextCursor !== null)
  ) {
    throw new OrganumCommandError(
      "hub.inbox cursor and has_more are inconsistent",
      "contract",
    );
  }
  return { items, nextCursor, hasMore };
}

function parseJoinGoal(value: unknown, context: string): JoinGoal {
  const item = record(value, context);
  const file = optionalStringField(item, "file", context);
  const fromID = optionalStringField(item, "from_id", context);
  const to = optionalStringField(item, "to", context);
  const topic = optionalStringField(item, "topic", context);
  const ts = optionalStringField(item, "ts", context);
  const thread = optionalStringField(item, "thread", context);
  const inReplyTo = optionalStringField(item, "in_reply_to", context);
  const escalate = optionalBooleanField(item, "escalate", context);
  return {
    from: stringField(item, "from", context),
    body: stringField(item, "body", context),
    ...(file === undefined ? {} : { file: safeEnvelopeFile(file) }),
    ...(fromID === undefined
      ? {}
      : { from_id: canonicalDimension(fromID, `${context}.from_id`) }),
    ...(to === undefined ? {} : { to }),
    ...(topic === undefined ? {} : { topic }),
    ...(ts === undefined ? {} : { ts }),
    ...(thread === undefined ? {} : { thread }),
    ...(inReplyTo === undefined ? {} : { in_reply_to: inReplyTo }),
    ...(escalate === undefined ? {} : { escalate }),
  };
}

function currentGoal(value: unknown, context: string): JoinGoal | null {
  if (value === null) return null;
  const goal = parseJoinGoal(value, context);
  if (
    goal.file === undefined ||
    goal.from.trim().length === 0 ||
    goal.from_id === undefined ||
    goal.topic !== "goal" ||
    goal.ts === undefined ||
    goal.ts.trim().length === 0 ||
    goal.thread === undefined
  ) {
    throw new OrganumCommandError(
      `${context} must be a full canonical topic:goal envelope`,
      "contract",
    );
  }
  return goal;
}

function safeEnvelopeFile(value: string): string {
  if (
    !value.endsWith(".md") ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new OrganumCommandError(
      "Organum publish receipt returned an unsafe file name",
      "contract",
    );
  }
  return value;
}

function appendOptional(
  args: string[],
  flag: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) args.push(flag, value);
}

export class OrganumCli {
  private readonly binary: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly redactions: readonly string[];
  private readonly executor: OrganumCommandExecutor;

  constructor(options: OrganumCliOptions = {}) {
    this.binary = options.binary ?? "organum";
    this.cwd = options.cwd ?? process.cwd();
    this.env = buildOrganumCliEnvironment(options.env ?? process.env);
    if (options.hubDirectory !== undefined) {
      if (
        options.hubDirectory.trim().length === 0 ||
        options.hubDirectory.includes("\0") ||
        !isAbsolute(options.hubDirectory)
      ) {
        throw new OrganumCommandError(
          "Organum hub directory must be a nonempty absolute path",
          "contract",
        );
      }
      this.env.ORGANUM_HUB = resolve(options.hubDirectory);
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT;
    this.redactions = options.redactions ?? [];
    this.executor = options.executor ?? executeOrganumCommand;
  }

  private async run(
    args: readonly string[],
    options: { stdin?: string; signal?: AbortSignal } = {},
  ): Promise<OrganumCommandResult> {
    return await this.executor({
      binary: this.binary,
      args,
      cwd: this.cwd,
      env: this.env,
      stdin: options.stdin,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      signal: options.signal,
      redactions: this.redactions,
    });
  }

  private async json(
    args: readonly string[],
    options: { stdin?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const result = await this.run(args, options);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new OrganumCommandError(
        "Organum CLI returned invalid JSON",
        "invalid_json",
      );
    }
  }

  async ingestObservation(
    artifactPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      artifactPath.trim().length === 0 ||
      artifactPath.includes("\0") ||
      !isAbsolute(artifactPath)
    ) {
      throw new OrganumCommandError(
        "Observation artifact path must be nonempty and absolute",
        "contract",
      );
    }
    await this.run(
      ["observatory", "ingest", resolve(artifactPath)],
      { signal },
    );
  }

  async join(options: OrganumJoinRequest): Promise<JoinResult> {
    if (options.workspace !== undefined && options.persona === undefined) {
      throw new OrganumCommandError(
        "Organum workspace requires an explicit persona registration",
        "contract",
      );
    }
    const args = ["join", "--role", options.role, "--for", options.identity, "--json"];
    appendOptional(args, "--intent", options.intent);
    appendOptional(args, "--persona", options.persona);
    appendOptional(args, "--workspace", options.workspace);
    appendOptional(args, "--loadout", options.loadout);
    appendOptional(args, "--problem-type", options.problemType);
    const value = record(
      await this.json(args, { signal: options.signal }),
      "join",
    );
    const returnedCell = parseCellIdentity(stringField(value, "cell", "join"));
    if (returnedCell !== options.identity) {
      throw new OrganumCommandError(
        "Organum join returned a different canonical cell identity",
        "contract",
      );
    }
    const returnedRole = stringField(value, "role", "join");
    if (returnedRole !== options.role) {
      throw new OrganumCommandError(
        "Organum join returned a different role",
        "contract",
      );
    }
    const personaValue = optionalNullableStringField(value, "persona", "join");
    const persona =
      personaValue === null
        ? null
        : canonicalDimension(personaValue, "join.persona");
    const workspace = parseJoinWorkspace(value.workspace, "join.workspace");
    const registration = parseJoinRegistration(
      value.registration,
      "join.registration",
    );
    if (options.persona !== undefined) {
      const expectedPersona = canonicalDimension(options.persona, "join request persona");
      if (persona !== expectedPersona || workspace === null || registration === null) {
        throw new OrganumCommandError(
          "Organum join did not return the requested hub registration",
          "contract",
        );
      }
      if (
        options.workspace !== undefined &&
        workspace.key !== canonicalDimension(options.workspace, "join request workspace")
      ) {
        throw new OrganumCommandError(
          "Organum join returned a different canonical workspace",
          "contract",
        );
      }
    } else if (persona !== null || workspace !== null || registration !== null) {
      throw new OrganumCommandError(
        "Organum join returned an unexpected hub registration",
        "contract",
      );
    }
    const goal = arrayField(value, "goal", "join").map((entry, index) =>
      parseJoinGoal(entry, `join.goal[${index}]`),
    );
    const alarms = arrayField(value, "alarms", "join").map((entry, index) =>
      record(entry, `join.alarms[${index}]`),
    );

    return {
      cell: returnedCell,
      role: returnedRole,
      started: booleanField(value, "started", "join"),
      persona,
      workspace,
      registration,
      charter: stringField(value, "charter", "join"),
      goal,
      inbox: parseFieldItems(value.inbox, "join.inbox"),
      alarms,
    };
  }

  async readAgora(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<FieldItem[]> {
    return parseFieldItems(
      await this.json(["agora", "read", "--for", identity, "--json"], {
        signal,
      }),
      "agora.read",
    );
  }

  async readCurrentGoal(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<JoinGoal | null> {
    return currentGoal(
      await this.json(["agora", "goal", "--for", identity, "--json"], {
        signal,
      }),
      "agora.goal",
    );
  }

  async readRelayInbox(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<FieldItem[]> {
    return parseFieldItems(
      await this.json(["relay", "inbox", "--for", identity, "--json"], {
        signal,
      }),
      "relay.inbox",
    );
  }

  async readHubInbox(request: HubInboxRequest): Promise<HubInboxPage> {
    if (request.epoch.trim().length === 0) {
      throw new OrganumCommandError(
        "Hub member binding epoch must be nonempty",
        "contract",
      );
    }
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new OrganumCommandError(
        "Hub inbox limit must be an integer from 1 to 100",
        "contract",
      );
    }
    if (
      request.cursor !== undefined &&
      (request.cursor.length === 0 ||
        request.cursor.includes("\0") ||
        Buffer.byteLength(request.cursor, "utf8") > 1024)
    ) {
      throw new OrganumCommandError(
        "Hub inbox cursor must be a nonempty opaque value at most 1024 UTF-8 bytes",
        "contract",
      );
    }
    const args = [
      "hub",
      "inbox",
      "--for",
      request.identity,
      "--limit",
      String(limit),
    ];
    appendOptional(args, "--cursor", request.cursor);
    args.push("--json");
    return parseHubInboxPage(
      await this.json(args, { signal: request.signal }),
      request,
    );
  }

  async markHubRead(
    binding: HubMemberBinding,
    item: HubReadTarget,
    signal?: AbortSignal,
  ): Promise<HubReadReceipt> {
    if (
      item.to_id !== binding.identity ||
      item.to_epoch !== binding.epoch ||
      binding.epoch.trim().length === 0
    ) {
      throw new OrganumCommandError(
        "Hub ACK item does not match the active member binding",
        "contract",
      );
    }
    const context = "hub.read";
    const value = record(
      await this.json(
        [
          "hub",
          "read",
          "--for",
          binding.identity,
          safeEnvelopeFile(item.file),
          "--json",
        ],
        { signal },
      ),
      context,
    );
    const file = safeEnvelopeFile(stringField(value, "file", context));
    const eventID = nonemptyStringField(value, "event_id", context);
    const forID = parseCellIdentity(nonemptyStringField(value, "for_id", context));
    const toEpoch = nonemptyStringField(value, "to_epoch", context);
    const read = booleanField(value, "read", context);
    const alreadyRead = booleanField(value, "already_read", context);
    if (
      file !== item.file ||
      eventID !== item.event_id ||
      forID !== binding.identity ||
      toEpoch !== binding.epoch ||
      !read
    ) {
      throw new OrganumCommandError(
        "Organum hub ACK returned a mismatched receipt",
        "contract",
      );
    }
    return {
      file,
      eventID,
      forID,
      toEpoch,
      read: true,
      alreadyRead,
    };
  }

  async sendHub(request: HubSendRequest): Promise<HubSendReceipt> {
    if (request.escalate === true) {
      throw new OrganumCommandError(
        "Hub send is queue-only and does not accept escalation",
        "contract",
      );
    }
    const to = request.to.trim();
    if (
      to.length === 0 ||
      to === "*" ||
      to.toLowerCase() === "all" ||
      to.includes(",") ||
      Buffer.byteLength(to, "utf8") > 128
    ) {
      throw new OrganumCommandError(
        "Hub recipient must be one exact cell or persona@workspace address",
        "contract",
      );
    }
    const idempotencyKey = derivePublishIdempotencyKey(
      request.identity,
      request.turnID,
      request.body,
    );
    const args = [
      "hub",
      "send",
      "--for",
      request.identity,
      "--to",
      to,
      "--idem-key",
      idempotencyKey,
      "--json",
    ];
    appendOptional(args, "--from", request.displayFrom);
    appendOptional(args, "--topic", request.topic);
    appendOptional(args, "--thread", request.thread);
    appendOptional(args, "--reply-to", request.replyTo);
    const context = "hub.send";
    const value = record(
      await this.json(args, { stdin: request.body, signal: request.signal }),
      context,
    );
    const fromID = parseCellIdentity(nonemptyStringField(value, "from_id", context));
    const idem = nonemptyStringField(value, "idem", context);
    const target = record(value.to, `${context}.to`);
    const receipt: HubSendReceipt = {
      file: safeEnvelopeFile(stringField(value, "file", context)),
      eventID: nonemptyStringField(value, "event_id", context),
      fromID,
      idempotencyKey: idem,
      to: {
        address: nonemptyStringField(target, "address", `${context}.to`),
        cell: parseCellIdentity(
          nonemptyStringField(target, "cell", `${context}.to`),
        ),
        persona: canonicalDimension(
          nonemptyStringField(target, "persona", `${context}.to`),
          `${context}.to.persona`,
        ),
        workspace: canonicalDimension(
          nonemptyStringField(target, "workspace", `${context}.to`),
          `${context}.to.workspace`,
        ),
        epoch: nonemptyStringField(target, "epoch", `${context}.to`),
      },
    };
    if (
      receipt.fromID !== request.identity ||
      receipt.idempotencyKey !== idempotencyKey
    ) {
      throw new OrganumCommandError(
        "Organum hub send returned a mismatched sender or idempotency receipt",
        "contract",
      );
    }
    return receipt;
  }

  async sessionStatus(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<SessionStatus | null> {
    const raw = await this.json(
      ["session", "status", "--for", identity, "--json"],
      { signal },
    );
    if (raw === null) return null;
    const value = record(raw, "session.status");
    return {
      sid: stringField(value, "sid", "session.status"),
      role: stringField(value, "role", "session.status"),
      intent: stringField(value, "intent", "session.status"),
      age_min: numberField(value, "age_min", "session.status"),
      idle_min: numberField(value, "idle_min", "session.status"),
      notes: numberField(value, "notes", "session.status"),
      started_at: stringField(value, "started_at", "session.status"),
    };
  }

  private async publish(
    channel: "agora" | "relay",
    request: AgoraPublishRequest | RelaySendRequest,
  ): Promise<PublishReceipt> {
    const idempotencyKey = derivePublishIdempotencyKey(
      request.identity,
      request.turnID,
      request.body,
    );
    const args = [
      channel,
      channel === "agora" ? "post" : "send",
      "--for",
      request.identity,
      "--idem-key",
      idempotencyKey,
      "--json",
    ];
    if (channel === "relay") {
      appendOptional(args, "--to", (request as RelaySendRequest).to);
    }
    appendOptional(args, "--from", request.displayFrom);
    appendOptional(args, "--topic", request.topic);
    appendOptional(args, "--thread", request.thread);
    appendOptional(args, "--reply-to", request.replyTo);
    if (request.escalate) args.push("--escalate");

    const value = record(
      await this.json(args, { stdin: request.body, signal: request.signal }),
      `${channel}.publish`,
    );
    const fromID = parseCellIdentity(
      stringField(value, "from_id", `${channel}.publish`),
    );
    if (fromID !== request.identity) {
      throw new OrganumCommandError(
        "Organum publish receipt returned a different canonical from_id",
        "contract",
      );
    }
    return {
      file: safeEnvelopeFile(stringField(value, "file", `${channel}.publish`)),
      fromID,
      idempotencyKey,
    };
  }

  async publishAgora(request: AgoraPublishRequest): Promise<PublishReceipt> {
    return await this.publish("agora", request);
  }

  async sendRelay(request: RelaySendRequest): Promise<PublishReceipt> {
    if (request.to.trim().length === 0) {
      throw new OrganumCommandError("Relay recipient must not be empty", "contract");
    }
    return await this.publish("relay", request);
  }

  async markRelayRead(
    identity: CellIdentity,
    file: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run(["relay", "read", "--for", identity, safeEnvelopeFile(file)], {
      signal,
    });
  }

  async note(
    identity: CellIdentity,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (text.trim().length === 0) {
      throw new OrganumCommandError("Session note must not be empty", "contract");
    }
    await this.run(["session", "note", "--for", identity, text], { signal });
  }

  async end(
    identity: CellIdentity,
    shippedFile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run(
      ["session", "end", "--for", identity, "--ship", safeEnvelopeFile(shippedFile)],
      { signal },
    );
  }
}

export type RelevanceReason = "active-thread" | "direct" | "goal" | "recent";

export interface BoundedFieldItem extends FieldItem {
  relevance: RelevanceReason;
  body_truncated: boolean;
}

export interface BoundedCoordinationView {
  items: BoundedFieldItem[];
  total: number;
  omitted: number;
  truncated: boolean;
  refetch: true;
}

export interface BoundCoordinationOptions {
  activeThread?: string;
  maxItems?: number;
  maxItemBytes?: number;
  maxTotalBytes?: number;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function directToIdentity(item: FieldItem, identity: CellIdentity): boolean {
  return item.to
    .split(",")
    .some((target) => target.trim().toLowerCase() === identity);
}

function relevance(
  item: FieldItem,
  identity: CellIdentity,
  activeThread?: string,
): RelevanceReason {
  if (directToIdentity(item, identity)) return "direct";
  if (activeThread && item.thread === activeThread) return "active-thread";
  if (item.topic.toLowerCase() === "goal") return "goal";
  return "recent";
}

function relevanceRank(reason: RelevanceReason): number {
  switch (reason) {
    case "direct":
      return 0;
    case "active-thread":
      return 1;
    case "goal":
      return 2;
    case "recent":
      return 3;
  }
}

function fitItem(
  item: FieldItem,
  reason: RelevanceReason,
  maxBytes: number,
): BoundedFieldItem | undefined {
  const characters = Array.from(item.body);
  const make = (length: number): BoundedFieldItem => ({
    ...item,
    body: characters.slice(0, length).join(""),
    relevance: reason,
    body_truncated: length < characters.length,
  });
  if (jsonBytes(make(0)) > maxBytes) return undefined;

  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(make(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return make(low);
}

export function boundCoordinationItems(
  source: readonly FieldItem[],
  identity: CellIdentity,
  options: BoundCoordinationOptions = {},
): BoundedCoordinationView {
  const maxItems = options.maxItems ?? 20;
  const maxItemBytes = options.maxItemBytes ?? 2 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024;
  if (maxItems < 1 || maxItemBytes < 256 || maxTotalBytes < 512) {
    throw new Error("Coordination bounds are too small");
  }

  const ranked = source
    .map((item) => ({
      item,
      reason: relevance(item, identity, options.activeThread),
    }))
    .sort((left, right) => {
      const rank = relevanceRank(left.reason) - relevanceRank(right.reason);
      if (rank !== 0) return rank;
      const timestamp = right.item.ts.localeCompare(left.item.ts);
      if (timestamp !== 0) return timestamp;
      return left.item.file.localeCompare(right.item.file);
    });

  const items: BoundedFieldItem[] = [];
  const view = (): BoundedCoordinationView => ({
    items,
    total: source.length,
    omitted: source.length - items.length,
    truncated:
      source.length !== items.length || items.some((item) => item.body_truncated),
    refetch: true,
  });
  if (jsonBytes(view()) > maxTotalBytes) {
    throw new Error("Coordination total bound cannot fit its envelope");
  }

  for (const entry of ranked) {
    if (items.length >= maxItems) break;
    const item = fitItem(entry.item, entry.reason, maxItemBytes);
    if (!item) continue;
    items.push(item);
    if (jsonBytes(view()) > maxTotalBytes) items.pop();
  }

  return view();
}
