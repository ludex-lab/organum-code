import {
  linkSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  InferenceBrokerUsageEvent,
  InferenceBrokerUsageObserver,
} from "./inference-broker.js";
import { ConfigurationError } from "./provider-profile.js";

export const RAW_PROVIDER_USAGE_SCHEMA =
  "organum-code/provider-usage-raw/v1" as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface FileProviderUsageLedgerOptions {
  directory: string;
  runID: string;
  laneID: string;
  backend: "opencode" | "claude" | "grok" | "deepcode" | "codex";
  provider: string;
  model: string;
  protocol: string;
}

function bounded(value: string, name: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > 256
  ) {
    throw new ConfigurationError(
      `${name} must be a nonempty bounded string without NUL`,
    );
  }
  return normalized;
}

export class FileProviderUsageLedger {
  readonly #directory: string;
  readonly #binding: Omit<FileProviderUsageLedgerOptions, "directory">;

  constructor(options: FileProviderUsageLedgerOptions) {
    if (
      !isAbsolute(options.directory) ||
      options.directory.includes("\0") ||
      !ID_PATTERN.test(options.runID) ||
      !ID_PATTERN.test(options.laneID)
    ) {
      throw new ConfigurationError(
        "Raw provider-usage ledger requires an absolute directory and canonical run/lane IDs",
      );
    }
    this.#directory = resolve(options.directory);
    this.#binding = {
      runID: options.runID,
      laneID: options.laneID,
      backend: options.backend,
      provider: bounded(options.provider, "Raw usage provider"),
      model: bounded(options.model, "Raw usage model"),
      protocol: bounded(options.protocol, "Raw usage protocol"),
    };
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(this.#directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ConfigurationError(
        "Raw provider-usage ledger directory must be a private real directory",
      );
    }
  }

  observer(): InferenceBrokerUsageObserver {
    return (event) => this.record(event);
  }

  record(event: Readonly<InferenceBrokerUsageEvent>): void {
    if (!Number.isSafeInteger(event.response) || event.response < 1) {
      throw new ConfigurationError(
        "Raw provider-usage response sequence must be a positive safe integer",
      );
    }
    const name =
      `${this.#binding.laneID}-${String(event.response).padStart(6, "0")}.json`;
    const path = join(this.#directory, name);
    const temporary = `${path}.${process.pid}.tmp`;
    const record = {
      schema: RAW_PROVIDER_USAGE_SCHEMA,
      run_id: this.#binding.runID,
      lane_id: this.#binding.laneID,
      backend: this.#binding.backend,
      provider: this.#binding.provider,
      model: this.#binding.model,
      protocol: this.#binding.protocol,
      response: event.response,
      usage: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        cachedInputTokens: event.cachedInputTokens,
        reasoningTokens: event.reasoningTokens,
      },
    };
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      linkSync(temporary, path);
    } finally {
      unlinkSync(temporary);
    }
  }
}
