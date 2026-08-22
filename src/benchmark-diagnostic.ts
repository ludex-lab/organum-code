import { createHash } from "node:crypto";

export interface BoundedDiagnosticText {
  text: string;
  redactedBytes: number;
  retainedBytes: number;
  truncated: boolean;
  retainedSha256: string;
}

export interface BoundedDiagnosticTextOptions {
  maxBytes: number;
  retain: "head" | "tail";
  exactRedactions?: readonly string[];
  pathRedactions?: ReadonlyArray<readonly [string, string]>;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function replaceAllLiteral(value: string, needle: string, replacement: string): string {
  return needle.length === 0 ? value : value.split(needle).join(replacement);
}

function safeUtf8Start(buffer: Buffer, start: number): number {
  let candidate = start;
  while (candidate < buffer.length && (buffer[candidate] & 0xc0) === 0x80) {
    candidate += 1;
  }
  return candidate;
}

function boundedBuffer(
  buffer: Buffer,
  maxBytes: number,
  retain: "head" | "tail",
): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  if (retain === "head") {
    let end = maxBytes;
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    return buffer.subarray(0, end);
  }
  return buffer.subarray(safeUtf8Start(buffer, buffer.length - maxBytes));
}

export function boundedDiagnosticText(
  input: string,
  options: BoundedDiagnosticTextOptions,
): BoundedDiagnosticText {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError("diagnostic byte limit must be a positive safe integer");
  }
  let redacted = stripTerminalControls(input);
  const paths = [...(options.pathRedactions ?? [])]
    .filter(([path]) => path.length > 0)
    .sort(([left], [right]) => right.length - left.length);
  for (const [path, replacement] of paths) {
    redacted = replaceAllLiteral(redacted, path, replacement);
    const jsonEscapedPath = JSON.stringify(path).slice(1, -1);
    if (jsonEscapedPath !== path) {
      redacted = replaceAllLiteral(redacted, jsonEscapedPath, replacement);
    }
  }
  const exact = [...new Set(options.exactRedactions ?? [])]
    .filter((value) => value.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const value of exact) {
    redacted = replaceAllLiteral(redacted, value, "<redacted>");
  }
  const encoded = Buffer.from(redacted, "utf8");
  const retained = boundedBuffer(encoded, options.maxBytes, options.retain);
  return {
    text: retained.toString("utf8"),
    redactedBytes: encoded.length,
    retainedBytes: retained.length,
    truncated: retained.length < encoded.length,
    retainedSha256: createHash("sha256").update(retained).digest("hex"),
  };
}
