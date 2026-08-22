import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  releaseArchiveFile,
  releaseArchiveRoot,
} from "../src/release-archive.js";
import { verifyReleaseBundle } from "../src/release-installation.js";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const artifact = resolve(
  process.platform === "win32" ? "dist/organum-code.exe" : "dist/organum-code",
);
const manifestPath = `${artifact}.release.json`;
const checksumPath = `${artifact}.sha256`;
const bundle = await verifyReleaseBundle({ artifactPath: artifact, manifestPath, checksumPath });
const archive = resolve("dist", releaseArchiveFile(bundle.manifest));
const archiveChecksum = `${archive}.sha256`;
const expectedChecksum = `${await sha256File(archive)}  ${releaseArchiveFile(bundle.manifest)}\n`;
assert.equal(await readFile(archiveChecksum, "utf8"), expectedChecksum);

const root = await mkdtemp(join(tmpdir(), "organum-code-release-archive-"));
const extraction = join(root, "extracted");
const prefix = join(root, "installed");
try {
  await mkdir(extraction, { recursive: true });
  const extract = spawnSync("tar", ["-xf", archive, "-C", extraction], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(extract.status, 0, extract.stderr);
  const bundleRoot = join(extraction, releaseArchiveRoot(bundle.manifest));
  const install = process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy", "Bypass",
          "-File", join(bundleRoot, "install.ps1"),
          prefix,
        ],
        { encoding: "utf8", timeout: 30_000 },
      )
    : spawnSync(
        "/bin/sh",
        [join(bundleRoot, "install.sh"), prefix],
        { encoding: "utf8", timeout: 30_000 },
      );
  assert.equal(install.error, undefined, install.error?.message);
  assert.equal(install.status, 0, install.stderr);
  const receipt = JSON.parse(install.stdout) as { installed: boolean; version: string };
  assert.equal(receipt.installed, true);
  assert.equal(receipt.version, bundle.manifest.version);

  const installed = join(prefix, "bin", bundle.manifest.artifact.file);
  const version = spawnSync(installed, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(version.error, undefined, version.error?.message);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `organum-code ${bundle.manifest.version}`);
  const status = spawnSync(installed, ["release", "status", "--prefix", prefix], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal((JSON.parse(status.stdout) as { installed: boolean }).installed, true);
  console.log(`release archive smoke passed: ${process.platform}/${process.arch}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
