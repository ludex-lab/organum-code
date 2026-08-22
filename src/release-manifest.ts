import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  ORGANUM_CODE_PRODUCT,
  ORGANUM_CODE_RELEASE_CHANNEL,
  ORGANUM_CODE_VERSION,
} from "./product.js";
import { CANONICAL_BUN_VERSION } from "./runtime.js";

export const RELEASE_MANIFEST_SCHEMA =
  "organum-code/release-manifest/v1" as const;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TARGET_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  product: typeof ORGANUM_CODE_PRODUCT;
  version: typeof ORGANUM_CODE_VERSION;
  channel: typeof ORGANUM_CODE_RELEASE_CHANNEL;
  source: {
    commit: string;
    clean: true;
  };
  build: {
    bun: typeof CANONICAL_BUN_VERSION;
    platform: string;
    arch: string;
  };
  artifact: {
    file: string;
    bytes: number;
    sha256: string;
  };
}

export interface BuildReleaseManifestOptions {
  artifactPath: string;
  sourceCommit: string;
  bunVersion: string;
  platform: string;
  arch: string;
}

function targetComponent(value: string, context: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TARGET_COMPONENT_PATTERN.test(normalized)) {
    throw new Error(`${context} is invalid`);
  }
  return normalized;
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildReleaseManifest(
  options: BuildReleaseManifestOptions,
): Promise<ReleaseManifest> {
  const artifactPath = resolve(options.artifactPath);
  const before = await lstat(artifactPath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      "Release artifact must be a nonempty regular non-symlink file",
    );
  }
  const commit = options.sourceCommit.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Release source commit must be a full lowercase Git SHA-1");
  }
  if (options.bunVersion !== CANONICAL_BUN_VERSION) {
    throw new Error(
      `Release manifest requires Bun ${CANONICAL_BUN_VERSION}`,
    );
  }
  const sha256 = await digestFile(artifactPath);
  const after = await lstat(artifactPath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error("Release artifact changed while it was being hashed");
  }
  const file = basename(artifactPath);
  if (file.length === 0 || file.includes("\0")) {
    throw new Error("Release artifact filename is invalid");
  }
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    product: ORGANUM_CODE_PRODUCT,
    version: ORGANUM_CODE_VERSION,
    channel: ORGANUM_CODE_RELEASE_CHANNEL,
    source: { commit, clean: true },
    build: {
      bun: CANONICAL_BUN_VERSION,
      platform: targetComponent(options.platform, "Release platform"),
      arch: targetComponent(options.arch, "Release architecture"),
    },
    artifact: {
      file,
      bytes: Number(before.size),
      sha256,
    },
  };
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function releaseChecksumLine(manifest: ReleaseManifest): string {
  return `${manifest.artifact.sha256}  ${manifest.artifact.file}\n`;
}
