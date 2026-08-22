import { createHash } from "node:crypto";

export const TOOL_ARGUMENT_CANONICALIZATION =
  "organum-code/rfc8785-json-arguments/v1" as const;
export const TOOL_ARGUMENT_DIGEST_ALGORITHM = "sha-256" as const;
export const TOOL_ARGUMENT_MAX_BYTES = 65_536;
export const TOOL_ARGUMENT_MAX_DEPTH = 64;
export const TOOL_ARGUMENT_MAX_NODES = 20_000;
export const TOOL_ARGUMENT_MAX_SOURCE_BYTES = TOOL_ARGUMENT_MAX_BYTES * 4;

export type CanonicalJSONValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJSONValue[]
  | { [key: string]: CanonicalJSONValue };

export type ToolArgumentCanonicalizationErrorKind =
  | "depth_limit"
  | "duplicate_key"
  | "invalid_json"
  | "invalid_number"
  | "invalid_object"
  | "invalid_unicode"
  | "node_limit"
  | "size_limit"
  | "unsupported_type";

export class ToolArgumentCanonicalizationError extends Error {
  readonly kind: ToolArgumentCanonicalizationErrorKind;

  constructor(kind: ToolArgumentCanonicalizationErrorKind, message: string) {
    super(message);
    this.name = "ToolArgumentCanonicalizationError";
    this.kind = kind;
  }
}

export interface CanonicalToolArguments {
  canonicalization: typeof TOOL_ARGUMENT_CANONICALIZATION;
  digestAlgorithm: typeof TOOL_ARGUMENT_DIGEST_ALGORITHM;
  canonicalText: string;
  canonicalBytes: Buffer;
  byteLength: number;
  sha256: string;
}

function fail(
  kind: ToolArgumentCanonicalizationErrorKind,
  message: string,
): never {
  throw new ToolArgumentCanonicalizationError(kind, message);
}

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    let codePoint = unit;

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        fail("invalid_unicode", "JSON strings must not contain lone surrogates");
      }
      codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x1_0000;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("invalid_unicode", "JSON strings must not contain lone surrogates");
    }

    if (
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      fail("invalid_unicode", "JSON strings must contain Unicode scalar values");
    }
  }
}

class CanonicalWriter {
  readonly parts: string[] = [];
  byteLength = 0;
  nodes = 0;

  append(value: string): void {
    this.byteLength += Buffer.byteLength(value, "utf8");
    if (this.byteLength > TOOL_ARGUMENT_MAX_BYTES) {
      fail(
        "size_limit",
        `Canonical tool arguments exceed ${TOOL_ARGUMENT_MAX_BYTES} UTF-8 bytes`,
      );
    }
    this.parts.push(value);
  }

  enter(depth: number): void {
    if (depth > TOOL_ARGUMENT_MAX_DEPTH) {
      fail(
        "depth_limit",
        `Tool arguments exceed the maximum depth of ${TOOL_ARGUMENT_MAX_DEPTH}`,
      );
    }
    this.nodes += 1;
    if (this.nodes > TOOL_ARGUMENT_MAX_NODES) {
      fail(
        "node_limit",
        `Tool arguments exceed the maximum node count of ${TOOL_ARGUMENT_MAX_NODES}`,
      );
    }
  }
}

function serialize(
  value: unknown,
  writer: CanonicalWriter,
  depth: number,
): void {
  writer.enter(depth);

  if (value === null) {
    writer.append("null");
    return;
  }
  if (typeof value === "boolean") {
    writer.append(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid_number", "Tool arguments must contain only finite numbers");
    }
    writer.append(JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    validateUnicode(value);
    writer.append(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      fail("invalid_object", "Tool argument arrays must not contain symbol keys");
    }
    writer.append("[");
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail("invalid_object", "Tool argument arrays must not contain holes");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        fail("invalid_object", "Tool argument arrays must contain data values");
      }
      if (index > 0) {
        writer.append(",");
      }
      serialize(descriptor.value, writer, depth + 1);
    }
    const allowed = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (
      Object.getOwnPropertyNames(value).some((name) => !allowed.has(name))
    ) {
      fail(
        "invalid_object",
        "Tool argument arrays must not contain named properties",
      );
    }
    writer.append("]");
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(
        "invalid_object",
        "Tool argument objects must have a plain or null prototype",
      );
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      fail("invalid_object", "Tool argument objects must not contain symbol keys");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        fail(
          "invalid_object",
          "Tool argument objects must contain enumerable data properties only",
        );
      }
      validateUnicode(key);
    }

    writer.append("{");
    keys.forEach((key, index) => {
      if (index > 0) {
        writer.append(",");
      }
      writer.append(JSON.stringify(key));
      writer.append(":");
      serialize(descriptors[key]!.value, writer, depth + 1);
    });
    writer.append("}");
    return;
  }

  fail(
    "unsupported_type",
    `Tool arguments contain unsupported value type ${typeof value}`,
  );
}

export function canonicalizeToolArguments(
  value: unknown,
): CanonicalToolArguments {
  const writer = new CanonicalWriter();
  serialize(value, writer, 0);
  const canonicalText = writer.parts.join("");
  const canonicalBytes = Buffer.from(canonicalText, "utf8");
  return {
    canonicalization: TOOL_ARGUMENT_CANONICALIZATION,
    digestAlgorithm: TOOL_ARGUMENT_DIGEST_ALGORITHM,
    canonicalText,
    canonicalBytes,
    byteLength: canonicalBytes.byteLength,
    sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
  };
}

const JSON_NUMBER =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

class StrictJSONParser {
  readonly source: string;
  index = 0;
  nodes = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(): CanonicalJSONValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      fail("invalid_json", "Unexpected trailing JSON input");
    }
    return value;
  }

  private enter(depth: number): void {
    if (depth > TOOL_ARGUMENT_MAX_DEPTH) {
      fail(
        "depth_limit",
        `Tool arguments exceed the maximum depth of ${TOOL_ARGUMENT_MAX_DEPTH}`,
      );
    }
    this.nodes += 1;
    if (this.nodes > TOOL_ARGUMENT_MAX_NODES) {
      fail(
        "node_limit",
        `Tool arguments exceed the maximum node count of ${TOOL_ARGUMENT_MAX_NODES}`,
      );
    }
  }

  private parseValue(depth: number): CanonicalJSONValue {
    this.enter(depth);
    const unit = this.source.charCodeAt(this.index);
    if (unit === 0x22) {
      return this.parseString();
    }
    if (unit === 0x7b) {
      return this.parseObject(depth);
    }
    if (unit === 0x5b) {
      return this.parseArray(depth);
    }
    if (unit === 0x74) {
      this.consumeLiteral("true");
      return true;
    }
    if (unit === 0x66) {
      this.consumeLiteral("false");
      return false;
    }
    if (unit === 0x6e) {
      this.consumeLiteral("null");
      return null;
    }
    if (unit === 0x2d || (unit >= 0x30 && unit <= 0x39)) {
      return this.parseNumber();
    }
    fail("invalid_json", "Expected a JSON value");
  }

  private parseObject(depth: number): { [key: string]: CanonicalJSONValue } {
    this.index += 1;
    this.skipWhitespace();
    const result: { [key: string]: CanonicalJSONValue } = Object.create(null);
    const keys = new Set<string>();
    if (this.source.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      return result;
    }

    while (true) {
      if (this.source.charCodeAt(this.index) !== 0x22) {
        fail("invalid_json", "Expected a JSON object key");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        fail("duplicate_key", `Duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source.charCodeAt(this.index) !== 0x3a) {
        fail("invalid_json", "Expected ':' after a JSON object key");
      }
      this.index += 1;
      this.skipWhitespace();
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: this.parseValue(depth + 1),
        writable: true,
      });
      this.skipWhitespace();
      const delimiter = this.source.charCodeAt(this.index);
      if (delimiter === 0x7d) {
        this.index += 1;
        return result;
      }
      if (delimiter !== 0x2c) {
        fail("invalid_json", "Expected ',' or '}' in a JSON object");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): CanonicalJSONValue[] {
    this.index += 1;
    this.skipWhitespace();
    const result: CanonicalJSONValue[] = [];
    if (this.source.charCodeAt(this.index) === 0x5d) {
      this.index += 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source.charCodeAt(this.index);
      if (delimiter === 0x5d) {
        this.index += 1;
        return result;
      }
      if (delimiter !== 0x2c) {
        fail("invalid_json", "Expected ',' or ']' in a JSON array");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;

    while (this.index < this.source.length) {
      const unit = this.source.charCodeAt(this.index);
      if (unit === 0x22) {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.index));
        } catch {
          fail("invalid_json", "Invalid JSON string");
        }
        if (typeof value !== "string") {
          fail("invalid_json", "Invalid JSON string");
        }
        validateUnicode(value);
        return value;
      }
      if (unit <= 0x1f) {
        fail("invalid_json", "JSON strings must escape control characters");
      }
      if (unit === 0x5c) {
        this.index += 1;
        const escape = this.source.charCodeAt(this.index);
        if (
          escape === 0x22 ||
          escape === 0x2f ||
          escape === 0x5c ||
          escape === 0x62 ||
          escape === 0x66 ||
          escape === 0x6e ||
          escape === 0x72 ||
          escape === 0x74
        ) {
          this.index += 1;
          continue;
        }
        if (escape === 0x75) {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            fail("invalid_json", "Invalid JSON Unicode escape");
          }
          this.index += 5;
          continue;
        }
        fail("invalid_json", "Invalid JSON escape");
      }
      this.index += 1;
    }

    fail("invalid_json", "Unterminated JSON string");
  }

  private parseNumber(): number {
    const start = this.index;
    while (
      this.index < this.source.length &&
      /[0-9eE+\-.]/.test(this.source[this.index]!)
    ) {
      this.index += 1;
    }
    const token = this.source.slice(start, this.index);
    if (!JSON_NUMBER.test(token)) {
      fail("invalid_json", "Invalid JSON number");
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      fail("invalid_number", "JSON number is outside the finite binary64 range");
    }
    return value;
  }

  private consumeLiteral(expected: string): void {
    if (this.source.slice(this.index, this.index + expected.length) !== expected) {
      fail("invalid_json", `Expected JSON literal ${expected}`);
    }
    this.index += expected.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const unit = this.source.charCodeAt(this.index);
      if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) {
        return;
      }
      this.index += 1;
    }
  }
}

export function parseToolArgumentsJSON(source: string): CanonicalJSONValue {
  if (Buffer.byteLength(source, "utf8") > TOOL_ARGUMENT_MAX_SOURCE_BYTES) {
    fail(
      "size_limit",
      `Tool argument source exceeds ${TOOL_ARGUMENT_MAX_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  return new StrictJSONParser(source).parse();
}

export function parseAndCanonicalizeToolArgumentsJSON(
  source: string,
): CanonicalToolArguments {
  return canonicalizeToolArguments(parseToolArgumentsJSON(source));
}
