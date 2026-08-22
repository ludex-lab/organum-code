import type {
  SoftwareBenchmarkTerminalOutcome,
  SoftwareBenchmarkTerminalReason,
} from "./software-benchmark.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parsedJsonLine(line: string): JsonRecord | null {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
}

function grokErrorKind(message: string): string | null {
  const prefix = "Internal error: ";
  if (!message.startsWith(prefix)) return null;
  const detail = parsedJsonLine(message.slice(prefix.length));
  return typeof detail?.error_kind === "string" ? detail.error_kind : null;
}

/**
 * Grok emits one JSON object per line. Only a native `type:error` record can
 * classify a typed terminal cause; task text or ordinary model output that
 * merely mentions an error token is ignored.
 */
export function classifyGrokTerminalReason(
  output: string,
): SoftwareBenchmarkTerminalReason | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const event = parsedJsonLine(line);
    if (event?.type !== "error" || typeof event.message !== "string") continue;
    if (grokErrorKind(event.message) === "max_tokens_truncation") {
      return "max-tokens-truncation";
    }
    if (
      event.message ===
        "execution_budget_exhausted: Adaptive execution budget exhausted" ||
      event.message.startsWith("execution_budget_exhausted: ")
    ) {
      return "execution-budget-exhausted";
    }
  }
  return null;
}

export interface NativeTerminalOutcomeInput {
  backendID: string;
  cancelled: boolean;
  cleanExit: boolean;
  stdout: string;
  stderr: string;
}

export function nativeTerminalOutcome(
  input: NativeTerminalOutcomeInput,
): SoftwareBenchmarkTerminalOutcome {
  if (input.cancelled) {
    return {
      schemaVersion: 1,
      reason: "aborted",
      source: "benchmark-supervisor",
    };
  }
  if (input.cleanExit) {
    return {
      schemaVersion: 1,
      reason: "clean-exit",
      source: "native-adapter",
    };
  }
  const grokReason =
    input.backendID === "grok"
      ? classifyGrokTerminalReason(`${input.stdout}\n${input.stderr}`)
      : null;
  return {
    schemaVersion: 1,
    reason: grokReason ?? "native-nonzero",
    source: "native-adapter",
  };
}
