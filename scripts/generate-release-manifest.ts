import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildReleaseManifest,
  releaseChecksumLine,
  serializeReleaseManifest,
} from "../src/release-manifest.js";
import {
  assertCanonicalBunRuntime,
  currentBunVersion,
} from "../src/runtime.js";

function git(args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to resolve release source state: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires one value`);
  }
  return value;
}

async function replace(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

const allowed = new Set(["--artifact", "--manifest", "--checksum"]);
for (let index = 2; index < process.argv.length; index += 2) {
  if (!allowed.has(process.argv[index]) || process.argv[index + 1] === undefined) {
    throw new Error(
      "usage: generate-release-manifest [--artifact PATH] [--manifest PATH] [--checksum PATH]",
    );
  }
}

const bunVersion = currentBunVersion();
assertCanonicalBunRuntime(bunVersion);
if (bunVersion === undefined) {
  throw new Error("Release manifest generation requires the canonical Bun runtime");
}
if (git(["status", "--porcelain", "--untracked-files=no"]).length > 0) {
  throw new Error("Release manifest requires a clean tracked source tree");
}

const artifact = resolve(
  option("--artifact") ??
    (process.platform === "win32"
      ? "dist/organum-code.exe"
      : "dist/organum-code"),
);
const manifestPath = resolve(
  option("--manifest") ?? `${artifact}.release.json`,
);
const checksumPath = resolve(
  option("--checksum") ?? `${artifact}.sha256`,
);
const manifest = await buildReleaseManifest({
  artifactPath: artifact,
  sourceCommit: git(["rev-parse", "HEAD"]),
  bunVersion,
  platform: process.platform,
  arch: process.arch,
});
await replace(manifestPath, serializeReleaseManifest(manifest));
await replace(checksumPath, releaseChecksumLine(manifest));
console.log(JSON.stringify({ manifest: manifestPath, checksum: checksumPath }));
