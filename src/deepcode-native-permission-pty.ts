import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_DESCRIPTION_BYTES = 4 * 1024;

type JsonRecord = Record<string, unknown>;

export interface DeepCodePendingPermission {
  sessionId: string;
  nativeToolCallId: string;
  nativeToolName: string;
  scopes: readonly ["unknown"];
  command: string;
  description: string | null;
  argumentBytes: number;
  argumentSha256: string;
  sourcePath: string;
}

export interface DeepCodePermissionExpectation {
  nativeToolName: string;
  command: string;
}

export class DeepCodePermissionStateError extends Error {
  constructor(
    readonly reason:
      | "ambiguous_state"
      | "malformed_state"
      | "oversized_state"
      | "request_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DeepCodePermissionStateError";
  }
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeepCodePermissionStateError(
      "malformed_state",
      `${context} must be an object`,
    );
  }
  return value as JsonRecord;
}

function boundedString(
  value: unknown,
  context: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new DeepCodePermissionStateError(
      "malformed_state",
      `${context} must be a nonempty bounded string without NUL`,
    );
  }
  return value;
}

function singleton(value: unknown, context: string): unknown {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new DeepCodePermissionStateError(
      "ambiguous_state",
      `${context} must contain exactly one item`,
    );
  }
  return value[0];
}

export function parseDeepCodePendingPermissionIndex(
  value: unknown,
  sourcePath: string,
  expectation: DeepCodePermissionExpectation,
): DeepCodePendingPermission {
  const index = record(value, "Deep Code session index");
  if (index.version !== 1) {
    throw new DeepCodePermissionStateError(
      "malformed_state",
      "Deep Code session index version must be 1",
    );
  }
  const entry = record(
    singleton(index.entries, "Deep Code session entries"),
    "Deep Code session entry",
  );
  if (entry.status !== "ask_permission") {
    throw new DeepCodePermissionStateError(
      "malformed_state",
      "Deep Code session must be stopped at ask_permission",
    );
  }
  const sessionId = boundedString(entry.id, "Deep Code session id", 512);
  const toolCall = record(
    singleton(entry.toolCalls, "Deep Code pending tool calls"),
    "Deep Code pending tool call",
  );
  const nativeToolCallId = boundedString(
    toolCall.id,
    "Deep Code tool-call id",
    512,
  );
  const fn = record(toolCall.function, "Deep Code tool-call function");
  const nativeToolName = boundedString(
    fn.name,
    "Deep Code native tool name",
    512,
  );
  const rawArguments = boundedString(
    fn.arguments,
    "Deep Code native tool arguments",
    MAX_COMMAND_BYTES + MAX_DESCRIPTION_BYTES,
  );
  let argumentsObject: JsonRecord;
  try {
    argumentsObject = record(
      JSON.parse(rawArguments),
      "Deep Code native tool arguments",
    );
  } catch (error) {
    if (error instanceof DeepCodePermissionStateError) throw error;
    throw new DeepCodePermissionStateError(
      "malformed_state",
      "Deep Code native tool arguments must be valid JSON",
    );
  }
  const argumentCommand = boundedString(
    argumentsObject.command,
    "Deep Code native command argument",
    MAX_COMMAND_BYTES,
  );

  const request = record(
    singleton(entry.askPermissions, "Deep Code permission requests"),
    "Deep Code permission request",
  );
  const requestId = boundedString(
    request.toolCallId,
    "Deep Code permission request tool-call id",
    512,
  );
  const requestName = boundedString(
    request.name,
    "Deep Code permission request name",
    512,
  );
  const command = boundedString(
    request.command,
    "Deep Code permission request command",
    MAX_COMMAND_BYTES,
  );
  const description =
    request.description === undefined || request.description === null
      ? null
      : boundedString(
          request.description,
          "Deep Code permission request description",
          MAX_DESCRIPTION_BYTES,
        );
  if (
    !Array.isArray(request.scopes) ||
    request.scopes.length !== 1 ||
    request.scopes[0] !== "unknown"
  ) {
    throw new DeepCodePermissionStateError(
      "request_mismatch",
      "Deep Code permission scope must be exactly unknown",
    );
  }
  if (
    requestId !== nativeToolCallId ||
    requestName !== "bash" ||
    command !== argumentCommand
  ) {
    throw new DeepCodePermissionStateError(
      "request_mismatch",
      "Deep Code permission request does not match its pending tool call",
    );
  }
  if (
    nativeToolName !== expectation.nativeToolName ||
    command !== expectation.command
  ) {
    throw new DeepCodePermissionStateError(
      "request_mismatch",
      "Deep Code permission request does not match the expected turn",
    );
  }
  return {
    sessionId,
    nativeToolCallId,
    nativeToolName,
    scopes: ["unknown"],
    command,
    description,
    argumentBytes: Buffer.byteLength(rawArguments, "utf8"),
    argumentSha256: createHash("sha256").update(rawArguments).digest("hex"),
    sourcePath,
  };
}

export async function readDeepCodePendingPermission(
  stateDirectory: string,
  expectation: DeepCodePermissionExpectation,
): Promise<DeepCodePendingPermission> {
  const projects = (await readdir(stateDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (projects.length !== 1) {
    throw new DeepCodePermissionStateError(
      "ambiguous_state",
      "Deep Code state must contain exactly one project directory",
    );
  }
  const sourcePath = join(
    stateDirectory,
    projects[0]!.name,
    "sessions-index.json",
  );
  const bytes = await readFile(sourcePath);
  if (bytes.length > MAX_INDEX_BYTES) {
    throw new DeepCodePermissionStateError(
      "oversized_state",
      "Deep Code session index exceeds the bounded state envelope",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DeepCodePermissionStateError(
      "malformed_state",
      "Deep Code session index must be complete JSON",
    );
  }
  return parseDeepCodePendingPermissionIndex(
    value,
    sourcePath,
    expectation,
  );
}

export function escapeDeepCodePermissionTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderDeepCodePermissionPresentation(
  request: DeepCodePendingPermission,
): string {
  return [
    "Organum Code Deep Code native permission",
    `  Session: ${escapeDeepCodePermissionTerminalText(request.sessionId)}`,
    `  Tool: ${escapeDeepCodePermissionTerminalText(request.nativeToolName)}`,
    `  Scope: ${request.scopes[0]}`,
    `  Arguments bytes: ${request.argumentBytes}`,
    `  Arguments SHA-256: ${request.argumentSha256}`,
    "  Exact command:",
    escapeDeepCodePermissionTerminalText(request.command),
    "Allow this observed native request once?",
  ].join("\n");
}
