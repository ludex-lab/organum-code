import { z } from "zod";

import {
  classifyExactNativeToolEffect,
  nativeToolEffectClassSchema,
  type NativeToolEffectClass,
} from "./native-tool-approval.js";
import {
  canonicalizeToolArguments,
  TOOL_ARGUMENT_CANONICALIZATION,
  TOOL_ARGUMENT_DIGEST_ALGORITHM,
  TOOL_ARGUMENT_MAX_BYTES,
} from "./tool-argument-canonicalization.js";

export const CLAUDE_NATIVE_TOOL_HOOK_REQUEST_SCHEMA =
  "organum-code/claude-preregistered-tool-hook-request/v1" as const;
export const CLAUDE_NATIVE_TOOL_HOOK_DECISION_SCHEMA =
  "organum-code/claude-preregistered-tool-hook-decision/v1" as const;
export const CLAUDE_NATIVE_TOOL_HOOK_PATH =
  "/claude-native-tool-hook" as const;
export const CLAUDE_NATIVE_TOOL_HOOK_MAX_INPUT_BYTES = 262_144;
export const CLAUDE_NATIVE_TOOL_HOOK_MAX_RESPONSE_BYTES = 16_384;

const boundedString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\u0000"));
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const toolInputSchema = z.record(z.string(), z.unknown());
const permissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

export const claudePreToolUseInputSchema = z
  .object({
    session_id: boundedString(512),
    prompt_id: boundedString(512),
    transcript_path: boundedString(16_384),
    cwd: boundedString(16_384),
    permission_mode: permissionModeSchema,
    effort: z
      .object({
        level: z.enum(["low", "medium", "high", "xhigh", "max"]),
      })
      .strict()
      .optional(),
    hook_event_name: z.literal("PreToolUse"),
    tool_name: boundedString(512),
    tool_input: toolInputSchema,
    tool_use_id: boundedString(512),
  })
  .strict();

export const claudeNativeToolHookRequestSchema = z
  .object({
    schema: z.literal(CLAUDE_NATIVE_TOOL_HOOK_REQUEST_SCHEMA),
    sessionId: boundedString(512),
    promptId: boundedString(512),
    nativeToolCallId: boundedString(512),
    nativeToolName: boundedString(512),
    effectClass: nativeToolEffectClassSchema,
    argumentCanonicalization: z.literal(TOOL_ARGUMENT_CANONICALIZATION),
    argumentDigestAlgorithm: z.literal(TOOL_ARGUMENT_DIGEST_ALGORITHM),
    argumentBytes: z.number().int().nonnegative().max(TOOL_ARGUMENT_MAX_BYTES),
    argumentSha256: sha256Schema,
    toolArguments: toolInputSchema,
  })
  .strict();

export const claudeNativeToolHookDecisionSchema = z
  .object({
    schema: z.literal(CLAUDE_NATIVE_TOOL_HOOK_DECISION_SCHEMA),
    decision: z.enum(["allow_once", "reject_once"]),
    reason: z.enum([
      "approved",
      "policy_denied",
      "unknown_effect",
      "binding_mismatch",
      "missing_proposal",
      "busy",
      "request_expired",
      "session_closed",
    ]),
    sessionId: boundedString(512),
    promptId: boundedString(512),
    nativeToolCallId: boundedString(512),
    nativeToolName: boundedString(512),
    effectClass: nativeToolEffectClassSchema,
    argumentBytes: z.number().int().nonnegative().max(TOOL_ARGUMENT_MAX_BYTES),
    argumentSha256: sha256Schema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      (decision.decision === "allow_once") !==
      (decision.reason === "approved")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only an approved decision can allow once",
      });
    }
  });

export type ClaudeNativeToolHookRequest = z.infer<
  typeof claudeNativeToolHookRequestSchema
>;
export type ClaudeNativeToolHookDecision = z.infer<
  typeof claudeNativeToolHookDecisionSchema
>;

export type ClaudeNativeToolHookFailureKind =
  | "binding_mismatch"
  | "endpoint_invalid"
  | "input_invalid"
  | "input_oversized"
  | "response_invalid"
  | "response_oversized"
  | "supervisor_status"
  | "transport_failed";

export class ClaudeNativeToolHookError extends Error {
  readonly kind: ClaudeNativeToolHookFailureKind;

  constructor(kind: ClaudeNativeToolHookFailureKind) {
    super(kind);
    this.name = "ClaudeNativeToolHookError";
    this.kind = kind;
  }
}

export interface ClaudeNativeToolHookExecution {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export interface ClaudeNativeToolHookOptions {
  endpoint: string;
  input: unknown;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

function fail(kind: ClaudeNativeToolHookFailureKind): never {
  throw new ClaudeNativeToolHookError(kind);
}

function classify(nativeToolName: string): NativeToolEffectClass {
  return classifyExactNativeToolEffect(nativeToolName, [
    { nativeToolName: "Bash", effectClass: "execute" },
  ]);
}

export function buildClaudeNativeToolHookRequest(
  input: unknown,
): ClaudeNativeToolHookRequest {
  let parsed: z.infer<typeof claudePreToolUseInputSchema>;
  try {
    parsed = claudePreToolUseInputSchema.parse(input);
  } catch {
    fail("input_invalid");
  }
  let canonical: ReturnType<typeof canonicalizeToolArguments>;
  try {
    canonical = canonicalizeToolArguments(parsed.tool_input);
  } catch {
    fail("input_invalid");
  }
  return claudeNativeToolHookRequestSchema.parse({
    schema: CLAUDE_NATIVE_TOOL_HOOK_REQUEST_SCHEMA,
    sessionId: parsed.session_id,
    promptId: parsed.prompt_id,
    nativeToolCallId: parsed.tool_use_id,
    nativeToolName: parsed.tool_name,
    effectClass: classify(parsed.tool_name),
    argumentCanonicalization: canonical.canonicalization,
    argumentDigestAlgorithm: canonical.digestAlgorithm,
    argumentBytes: canonical.byteLength,
    argumentSha256: canonical.sha256,
    toolArguments: parsed.tool_input,
  });
}

function exactLoopbackEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    fail("endpoint_invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.pathname !== "/claude-native-tool-hook"
  ) {
    fail("endpoint_invalid");
  }
  return endpoint;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (response.body === null) fail("response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > CLAUDE_NATIVE_TOOL_HOOK_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("response_oversized");
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    fail("response_invalid");
  }
}

function assertDecisionBinding(
  request: ClaudeNativeToolHookRequest,
  decision: ClaudeNativeToolHookDecision,
): void {
  if (
    decision.sessionId !== request.sessionId ||
    decision.promptId !== request.promptId ||
    decision.nativeToolCallId !== request.nativeToolCallId ||
    decision.nativeToolName !== request.nativeToolName ||
    decision.effectClass !== request.effectClass ||
    decision.argumentBytes !== request.argumentBytes ||
    decision.argumentSha256 !== request.argumentSha256
  ) {
    fail("binding_mismatch");
  }
}

function hookOutput(
  permissionDecision: "allow" | "deny",
): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason:
        permissionDecision === "allow"
          ? "One exact broker-preregistered Organum grant was consumed."
          : "Organum denied this native tool call.",
    },
  })}\n`;
}

async function execute(
  options: ClaudeNativeToolHookOptions,
): Promise<ClaudeNativeToolHookExecution> {
  const endpoint = exactLoopbackEndpoint(options.endpoint);
  const request = buildClaudeNativeToolHookRequest(options.input);
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    fail("input_invalid");
  }
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail("transport_failed");
  }
  if (response.status !== 200) fail("supervisor_status");
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    fail("response_invalid");
  }
  let parsed: ClaudeNativeToolHookDecision;
  try {
    parsed = claudeNativeToolHookDecisionSchema.parse(
      JSON.parse(await boundedResponseText(response)),
    );
  } catch (error) {
    if (error instanceof ClaudeNativeToolHookError) throw error;
    fail("response_invalid");
  }
  assertDecisionBinding(request, parsed);
  return {
    exitCode: 0,
    stdout: hookOutput(
      parsed.decision === "allow_once" ? "allow" : "deny",
    ),
    stderr: "",
  };
}

export async function runClaudeNativeToolHook(
  options: ClaudeNativeToolHookOptions,
): Promise<ClaudeNativeToolHookExecution> {
  try {
    return await execute(options);
  } catch (error) {
    const kind =
      error instanceof ClaudeNativeToolHookError
        ? error.kind
        : "response_invalid";
    return {
      exitCode: 2,
      stdout: "",
      stderr: `organum_claude_hook_error:${kind}\n`,
    };
  }
}

export async function readBoundedClaudeHookInput(
  stream: NodeJS.ReadableStream,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > CLAUDE_NATIVE_TOOL_HOOK_MAX_INPUT_BYTES) {
      fail("input_oversized");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("input_invalid");
  }
}
