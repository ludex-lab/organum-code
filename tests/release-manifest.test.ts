import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReleaseManifest,
  releaseChecksumLine,
  serializeReleaseManifest,
} from "../src/release-manifest.js";

test("release manifest binds exact product, source, target, bytes, and SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-release-manifest-"));
  try {
    const artifact = join(root, "organum-code");
    const bytes = Buffer.from("standalone-fixture\n", "utf8");
    await writeFile(artifact, bytes, { mode: 0o755 });
    const manifest = await buildReleaseManifest({
      artifactPath: artifact,
      sourceCommit: "a".repeat(40),
      bunVersion: "1.3.14",
      platform: "darwin",
      arch: "arm64",
    });

    assert.deepEqual(manifest, {
      schema: "organum-code/release-manifest/v1",
      product: "organum-code",
      version: "0.1.0-preview.1",
      channel: "internal-preview",
      source: { commit: "a".repeat(40), clean: true },
      build: { bun: "1.3.14", platform: "darwin", arch: "arm64" },
      artifact: {
        file: "organum-code",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    assert.equal(JSON.parse(serializeReleaseManifest(manifest)).schema, manifest.schema);
    assert.equal(
      releaseChecksumLine(manifest),
      `${manifest.artifact.sha256}  organum-code\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release manifest rejects symlinks, version drift, and abbreviated commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-release-manifest-"));
  try {
    const artifact = join(root, "organum-code");
    const linked = join(root, "linked-organum-code");
    await writeFile(artifact, "fixture", { mode: 0o755 });
    await symlink(artifact, linked);
    const base = {
      artifactPath: artifact,
      sourceCommit: "b".repeat(40),
      bunVersion: "1.3.14",
      platform: "linux",
      arch: "x64",
    };

    await assert.rejects(
      buildReleaseManifest({ ...base, artifactPath: linked }),
      /non-symlink/,
    );
    await assert.rejects(
      buildReleaseManifest({ ...base, bunVersion: "1.3.13" }),
      /requires Bun 1\.3\.14/,
    );
    await assert.rejects(
      buildReleaseManifest({ ...base, sourceCommit: "b".repeat(12) }),
      /full lowercase Git SHA-1/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
