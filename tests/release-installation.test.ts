import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectInstallation,
  installRelease,
  rollbackRelease,
  uninstallRelease,
  upgradeRelease,
  verifyReleaseBundle,
  type ReleaseBundlePaths,
} from "../src/release-installation.js";

async function fixtureBundle(
  root: string,
  version: string,
  body: string,
  commitCharacter: string,
): Promise<ReleaseBundlePaths> {
  const directory = join(root, version, createHash("sha256").update(body).digest("hex"));
  await mkdir(directory, { recursive: true });
  const file = process.platform === "win32" ? "organum-code.exe" : "organum-code";
  const artifactPath = join(directory, file);
  const manifestPath = `${artifactPath}.release.json`;
  const checksumPath = `${artifactPath}.sha256`;
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(artifactPath, bytes);
  if (process.platform !== "win32") await chmod(artifactPath, 0o755);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "organum-code/release-manifest/v1",
    product: "organum-code",
    version,
    channel: "internal-preview",
    source: { commit: commitCharacter.repeat(40), clean: true },
    build: { bun: "1.3.14", platform: process.platform, arch: process.arch },
    artifact: { file, bytes: bytes.length, sha256 },
  }, null, 2)}\n`);
  await writeFile(checksumPath, `${sha256}  ${file}\n`);
  return { artifactPath, manifestPath, checksumPath };
}

test("install, upgrade, rollback, and uninstall preserve unrelated prefix data", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-installation-"));
  const prefix = join(root, "prefix");
  try {
    const first = await fixtureBundle(root, "0.1.0-preview.1", "release-one\n", "a");
    const second = await fixtureBundle(root, "0.1.0-preview.2", "release-two\n", "b");
    await mkdir(prefix, { recursive: true });
    await writeFile(join(prefix, "user-owned.txt"), "preserve me\n");

    const installed = await installRelease(prefix, first);
    assert.equal(installed.generation, 1);
    assert.equal(installed.previous, null);
    const executable = join(
      prefix,
      "bin",
      process.platform === "win32" ? "organum-code.exe" : "organum-code",
    );
    assert.equal(await readFile(executable, "utf8"), "release-one\n");

    const upgraded = await upgradeRelease(prefix, second);
    assert.equal(upgraded.generation, 2);
    assert.equal(upgraded.releases.length, 2);
    assert.equal(await readFile(executable, "utf8"), "release-two\n");

    const rolledBack = await rollbackRelease(prefix);
    assert.equal(rolledBack.generation, 3);
    assert.equal(
      rolledBack.releases.find((release) => release.id === rolledBack.active)?.version,
      "0.1.0-preview.1",
    );
    assert.equal(await readFile(executable, "utf8"), "release-one\n");
    assert.equal((await inspectInstallation(prefix))?.generation, 3);

    await uninstallRelease(prefix);
    assert.equal(await inspectInstallation(prefix), null);
    assert.equal(await readFile(join(prefix, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle refuses checksum drift and same-version byte rebinding", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-installation-"));
  const prefix = join(root, "prefix");
  try {
    const first = await fixtureBundle(root, "0.1.0-preview.1", "release-one\n", "a");
    const rebound = await fixtureBundle(root, "0.1.0-preview.1", "other-bytes\n", "b");
    const badChecksum = await fixtureBundle(root, "0.1.0-preview.2", "release-two\n", "c");
    await writeFile(badChecksum.checksumPath, `${"0".repeat(64)}  ${
      process.platform === "win32" ? "organum-code.exe" : "organum-code"
    }\n`);

    await assert.rejects(verifyReleaseBundle(badChecksum), /checksum file/);
    await installRelease(prefix, first);
    await assert.rejects(
      upgradeRelease(prefix, rebound),
      /already bound to different bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered active executables block status, rollback, and uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-installation-"));
  const prefix = join(root, "prefix");
  try {
    const first = await fixtureBundle(root, "0.1.0-preview.1", "release-one\n", "a");
    const second = await fixtureBundle(root, "0.1.0-preview.2", "release-two\n", "b");
    await installRelease(prefix, first);
    await upgradeRelease(prefix, second);
    const executable = join(
      prefix,
      "bin",
      process.platform === "win32" ? "organum-code.exe" : "organum-code",
    );
    await writeFile(executable, "tampered!!!\n");

    await assert.rejects(inspectInstallation(prefix), /does not match install state/);
    await assert.rejects(rollbackRelease(prefix), /does not match install state/);
    await assert.rejects(uninstallRelease(prefix), /does not match install state/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial install never replaces an unmanaged executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-installation-"));
  const prefix = join(root, "prefix");
  try {
    const bundle = await fixtureBundle(root, "0.1.0-preview.1", "release-one\n", "a");
    const bin = join(prefix, "bin");
    const executable = join(
      bin,
      process.platform === "win32" ? "organum-code.exe" : "organum-code",
    );
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "user binary\n");

    await assert.rejects(
      installRelease(prefix, bundle),
      /unmanaged organum-code executable/,
    );
    assert.equal(await readFile(executable, "utf8"), "user binary\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall refuses unregistered managed-root entries before deleting anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-installation-"));
  const prefix = join(root, "prefix");
  try {
    const bundle = await fixtureBundle(root, "0.1.0-preview.1", "release-one\n", "a");
    await installRelease(prefix, bundle);
    const executable = join(
      prefix,
      "bin",
      process.platform === "win32" ? "organum-code.exe" : "organum-code",
    );
    await writeFile(
      join(prefix, "lib", "organum-code", "unregistered"),
      "do not delete\n",
    );

    await assert.rejects(uninstallRelease(prefix), /unregistered entries/);
    assert.equal(await readFile(executable, "utf8"), "release-one\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
