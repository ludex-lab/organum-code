export interface StreamToolCall {
  index: number;
  id: string;
  type: string;
  name: string;
  arguments: string;
  argumentFragments: number;
}

export interface SseDecodeResult {
  values: unknown[];
  done: boolean;
  parseErrors: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class SseJsonDecoder {
  #buffer = "";
  #done = false;
  #parseErrors = 0;

  push(text: string): SseDecodeResult {
    this.#buffer += text;
    const values: unknown[] = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.#buffer);
      if (match === null || match.index === undefined) break;
      const event = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      this.#decodeEvent(event, values);
    }
    return {
      values,
      done: this.#done,
      parseErrors: this.#parseErrors,
    };
  }

  finish(): SseDecodeResult {
    const values: unknown[] = [];
    if (this.#buffer.trim().length > 0) this.#decodeEvent(this.#buffer, values);
    this.#buffer = "";
    return {
      values,
      done: this.#done,
      parseErrors: this.#parseErrors,
    };
  }

  #decodeEvent(event: string, values: unknown[]): void {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) return;
    if (data === "[DONE]") {
      this.#done = true;
      return;
    }
    try {
      values.push(JSON.parse(data));
    } catch {
      this.#parseErrors += 1;
    }
  }
}

interface MutableToolCall extends StreamToolCall {}

export class StreamToolCallAssembler {
  #calls = new Map<number, MutableToolCall>();

  add(value: unknown): void {
    const choices = record(value)?.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      const toolCalls = record(record(choice)?.delta)?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const rawCall of toolCalls) {
        const call = record(rawCall);
        if (call === null || typeof call.index !== "number") continue;
        const existing = this.#calls.get(call.index) ?? {
          index: call.index,
          id: "",
          type: "",
          name: "",
          arguments: "",
          argumentFragments: 0,
        };
        if (typeof call.id === "string") existing.id = call.id;
        if (typeof call.type === "string") existing.type = call.type;
        const fn = record(call.function);
        if (typeof fn?.name === "string") existing.name += fn.name;
        if (typeof fn?.arguments === "string") {
          existing.arguments += fn.arguments;
          existing.argumentFragments += 1;
        }
        this.#calls.set(call.index, existing);
      }
    }
  }

  calls(): StreamToolCall[] {
    return [...this.#calls.values()]
      .sort((left, right) => left.index - right.index)
      .map((call) => ({ ...call }));
  }
}

const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

export function rateLimitHeaderSnapshot(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) result[name] = value.slice(0, 128);
  }
  return result;
}

export function retryDelayMs(
  attempt: number,
  headers: Pick<Headers, "get">,
  now = Date.now(),
): number {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(10_000, Math.ceil(seconds * 1_000));
    }
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.min(10_000, Math.max(0, timestamp - now));
    }
  }
  return Math.min(4_000, 250 * 2 ** Math.max(0, attempt));
}

export function safeErrorShape(value: unknown): Record<string, string> | null {
  const outer = record(value);
  const source = record(outer?.error) ?? outer;
  if (source === null) return null;
  const result: Record<string, string> = {};
  for (const key of ["_tag", "type", "code", "param"] as const) {
    const candidate = source[key];
    if (typeof candidate === "string") result[key] = candidate.slice(0, 128);
  }
  return Object.keys(result).length === 0 ? null : result;
}

export function parsedArguments(
  value: string,
): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}
