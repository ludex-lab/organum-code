import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OrganumHubSemanticAckSink,
  type OrganumHubSemanticAckOptions,
} from "./organum-hub-cli.js";
import { ConfigurationError } from "./provider-profile.js";
import type {
  SemanticAckRequest,
  SemanticAckReceipt,
  SemanticAckSink,
} from "./signed-hub-supervisor.js";

const MAX_KEYCHAIN_SEED_BYTES = 4096;

export type HubKeychainReader = (
  service: string,
  account: string,
) => Promise<string>;

export interface OrganumHubKeychainAckOptions extends Omit<
  OrganumHubSemanticAckOptions,
  "keyFile"
> {
  keychainService: string;
  keychainAccount: string;
  platform?: NodeJS.Platform;
  keychainRead?: HubKeychainReader;
}

function boundedLabel(value: string, context: string): string {
  const result = value.trim();
  if (
    result.length === 0 ||
    result.includes("\0") ||
    Buffer.byteLength(result, "utf8") > 512
  ) {
    throw new ConfigurationError(`${context} is invalid`);
  }
  return result;
}

function boundedSeed(value: string): string {
  const result = value.trim();
  if (
    result.length === 0 ||
    result.includes("\0") ||
    Buffer.byteLength(result, "utf8") > MAX_KEYCHAIN_SEED_BYTES
  ) {
    throw new ConfigurationError("Signed Hub Keychain seed is invalid");
  }
  return result;
}

function defaultKeychainRead(
  service: string,
  account: string,
): Promise<string> {
  return new Promise((resolveRead, rejectRead) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_KEYCHAIN_SEED_BYTES,
        env: { PATH: "/usr/bin:/bin" },
      },
      (error, stdout) => {
        if (error !== null) {
          rejectRead(
            new ConfigurationError(
              `Unable to read Signed Hub key from macOS Keychain service ${JSON.stringify(service)}`,
            ),
          );
          return;
        }
        resolveRead(stdout);
      },
    );
  });
}

/**
 * Materializes one Keychain seed only for the bounded Hub signing call. The
 * seed is never placed in argv, environment, actor state, or backend input.
 */
export class OrganumHubKeychainSemanticAckSink implements SemanticAckSink {
  private readonly options: Omit<
    OrganumHubKeychainAckOptions,
    "platform" | "keychainRead"
  >;
  private readonly reader: HubKeychainReader;

  constructor(options: OrganumHubKeychainAckOptions) {
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new ConfigurationError(
        "Signed Hub Keychain ACK signing is available only on Darwin",
      );
    }
    const {
      platform: _platform,
      keychainRead: _keychainRead,
      ...ackOptions
    } = options;
    this.options = {
      ...ackOptions,
      keychainService: boundedLabel(
        options.keychainService,
        "Signed Hub Keychain service",
      ),
      keychainAccount: boundedLabel(
        options.keychainAccount,
        "Signed Hub Keychain account",
      ),
    };
    this.reader = options.keychainRead ?? defaultKeychainRead;
  }

  private async withSink<T>(
    action: (sink: OrganumHubSemanticAckSink) => Promise<T>,
  ): Promise<T> {
    const seed = boundedSeed(
      await this.reader(
        this.options.keychainService,
        this.options.keychainAccount,
      ),
    );
    const directory = await mkdtemp(
      join(tmpdir(), "organum-code-hub-keychain-"),
    );
    await chmod(directory, 0o700);
    const keyFile = join(directory, "signing.seed");
    try {
      await writeFile(keyFile, `${seed}\n`, { mode: 0o600, flag: "wx" });
      const {
        keychainService: _service,
        keychainAccount: _account,
        ...sinkOptions
      } = this.options;
      return await action(new OrganumHubSemanticAckSink({
        ...sinkOptions,
        keyFile,
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async preflight(): Promise<void> {
    await this.withSink(async (sink) => await sink.preflight());
  }

  async emit(request: SemanticAckRequest): Promise<SemanticAckReceipt> {
    return await this.withSink(async (sink) => await sink.emit(request));
  }
}
