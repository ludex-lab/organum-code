import { spawnSync } from "node:child_process";
import { release } from "node:os";

import { CLAUDE_S14_ADMISSION_RECEIPT } from "./claude-native-tool-production-capability.js";
import { GROK_S13_ADMISSION_RECEIPT } from "./grok-native-tool-wrapper-capability.js";

export interface NativeToolOperationalAdmissionTuple {
  receipt: string;
  backendId: "grok" | "claude";
  backendVersion: string;
  installedVersion: string;
  productSurface:
    | "cli-print-wrapper-projection"
    | "cli-print-hook-projection";
  platform: "darwin";
  macOSVersion: string;
  darwinVersion: string;
}

export interface NativeToolOperationalEnvironment {
  installedVersion: string;
  platform: NodeJS.Platform;
  macOSVersion: string;
  darwinVersion: string;
}

function parseReceipt(
  receipt: string,
  backendId: "grok" | "claude",
  productSurface:
    | "cli-print-wrapper-projection"
    | "cli-print-hook-projection",
): Omit<
  NativeToolOperationalAdmissionTuple,
  "installedVersion"
> {
  const parts = receipt.split(":");
  if (
    parts.length !== 5 ||
    parts[0] !== "receipt" ||
    parts[3] !== productSurface ||
    parts[4] !== "full"
  ) {
    throw new Error(`Native tool admission receipt is invalid for ${backendId}`);
  }
  const backendPrefix = `${backendId}-`;
  const backend = parts[1]!;
  const platform = parts[2]!;
  const platformMatch = /^macos-([0-9]+(?:\.[0-9]+)*)-darwin-([0-9]+(?:\.[0-9]+)*)$/
    .exec(platform);
  if (!backend.startsWith(backendPrefix) || platformMatch === null) {
    throw new Error(`Native tool admission receipt tuple is invalid for ${backendId}`);
  }
  const backendVersion = backend.slice(backendPrefix.length);
  if (backendVersion.length === 0) {
    throw new Error(`Native tool admission backend version is empty for ${backendId}`);
  }
  return {
    receipt,
    backendId,
    backendVersion,
    productSurface,
    platform: "darwin",
    macOSVersion: platformMatch[1]!,
    darwinVersion: platformMatch[2]!,
  };
}

function grokTuple(): NativeToolOperationalAdmissionTuple {
  const parsed = parseReceipt(
    GROK_S13_ADMISSION_RECEIPT,
    "grok",
    "cli-print-wrapper-projection",
  );
  const match = /^([0-9]+(?:\.[0-9]+)*)\+([0-9a-f]+)$/.exec(
    parsed.backendVersion,
  );
  if (match === null) {
    throw new Error("Grok admission receipt cannot derive the installed version");
  }
  return {
    ...parsed,
    installedVersion: `grok ${match[1]} (${match[2]}) [stable]`,
  };
}

function claudeTuple(): NativeToolOperationalAdmissionTuple {
  const parsed = parseReceipt(
    CLAUDE_S14_ADMISSION_RECEIPT,
    "claude",
    "cli-print-hook-projection",
  );
  if (!/^[0-9]+(?:\.[0-9]+)*$/.test(parsed.backendVersion)) {
    throw new Error(
      "Claude admission receipt cannot derive the installed version",
    );
  }
  return {
    ...parsed,
    installedVersion: `${parsed.backendVersion} (Claude Code)`,
  };
}

export const GROK_S16_OPERATIONAL_ADMISSION = grokTuple();
export const CLAUDE_S16_OPERATIONAL_ADMISSION = claudeTuple();

export function inspectNativeToolOperationalEnvironment(
  installedVersion: string,
): NativeToolOperationalEnvironment {
  const result = process.platform === "darwin"
    ? spawnSync("sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 5_000,
      })
    : null;
  return {
    installedVersion,
    platform: process.platform,
    macOSVersion:
      result !== null &&
        result.error === undefined &&
        result.status === 0
        ? result.stdout.trim()
        : "",
    darwinVersion: release(),
  };
}

export function assertNativeToolOperationalEnvironment(
  tuple: NativeToolOperationalAdmissionTuple,
  observed: NativeToolOperationalEnvironment,
): void {
  if (
    observed.installedVersion !== tuple.installedVersion ||
    observed.platform !== tuple.platform ||
    observed.macOSVersion !== tuple.macOSVersion ||
    observed.darwinVersion !== tuple.darwinVersion
  ) {
    throw new Error(
      `${tuple.backendId} native tool projection is pinned by ${tuple.receipt}`,
    );
  }
}

export function assertGrokS16OperationalEnvironment(
  installedVersion: string,
  observed: NativeToolOperationalEnvironment =
    inspectNativeToolOperationalEnvironment(installedVersion),
): void {
  assertNativeToolOperationalEnvironment(
    GROK_S16_OPERATIONAL_ADMISSION,
    observed,
  );
}

export function assertClaudeS16OperationalEnvironment(
  installedVersion: string,
  observed: NativeToolOperationalEnvironment =
    inspectNativeToolOperationalEnvironment(installedVersion),
): void {
  assertNativeToolOperationalEnvironment(
    CLAUDE_S16_OPERATIONAL_ADMISSION,
    observed,
  );
}
