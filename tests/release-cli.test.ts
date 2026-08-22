import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runReleaseCommand } from "../src/release-cli.js";
import { installRelease, type ReleaseBundlePaths } from "../src/release-installation.js";

async function fixtureBundle(root: string): Promise<ReleaseBundlePaths> {
  const file = process.platform === "win32" ? "organum-code.exe" : "organum-code";
  const artifactPath = join(root, "bundle", file);
  const manifestPath = `${artifactPath}.release.json`;
  const checksumPath = `${artifactPath}.sha256`;
  const bytes = Buffer.from("standalone release fixture\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(root, "bundle"), { recursive: true });
  await writeFile(artifactPath, bytes);
  if (process.platform !== "win32") await chmod(artifactPath, 0o755);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "organum-code/release-manifest/v1",
    product: "organum-code",
    version: "0.1.0-preview.1",
    channel: "internal-preview",
    source: { commit: "a".repeat(40), clean: true },
    build: { bun: "1.3.14", platform: process.platform, arch: process.arch },
    artifact: { file, bytes: bytes.length, sha256 },
  }, null, 2)}\n`);
  await writeFile(checksumPath, `${sha256}  ${file}\n`);
  return { artifactPath, manifestPath, checksumPath };
}

test("standalone release status and uninstall are absolute and preserve unrelated data", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-release-cli-"));
  const prefix = join(root, "prefix");
  try {
    await mkdir(prefix, { recursive: true });
    await writeFile(join(prefix, "user-owned.txt"), "preserve me\n");
    assert.deepEqual(await runReleaseCommand(["status", "--prefix", prefix]), {
      operation: "status",
      prefix,
      installed: false,
      generation: null,
      version: null,
      sha256: null,
    });
    await assert.rejects(
      runReleaseCommand(["status", "--prefix", "relative"]),
      /absolute path/,
    );
    await installRelease(prefix, await fixtureBundle(root));
    assert.deepEqual(await runReleaseCommand(["uninstall", "--prefix", prefix]), {
      operation: "uninstall",
      prefix,
      installed: false,
      generation: null,
      version: null,
      sha256: null,
    });
    assert.equal(
      (await runReleaseCommand(["status", "--prefix", prefix])).installed,
      false,
    );
    assert.equal(await readFile(join(prefix, "user-owned.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
