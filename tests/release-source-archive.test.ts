import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPublicSourceArchive,
  verifyPublicSourceTree,
} from "../src/release-source-archive.js";

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

async function fixture(root: string): Promise<void> {
  const pkg = `${JSON.stringify({
    name: "organum-code",
    version: "0.1.0-preview.1",
    private: true,
  }, null, 2)}\n`;
  const readme = "public source fixture\n";
  await writeFile(join(root, "package.json"), pkg);
  await writeFile(join(root, "README.md"), readme);
  await writeFile(join(root, "PUBLIC_CUT_MANIFEST.json"), `${JSON.stringify({
    schema: "organum-code/public-cut/v1",
    source: { repository: "private", commit: "a".repeat(40) },
    target: "ludex-lab/organum-code",
    version: "0.1.0-preview.1",
    files: [
      { path: "README.md", sha256: sha256(readme) },
      { path: "package.json", sha256: sha256(pkg) },
    ],
  }, null, 2)}\n`);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Organum Code Test"]);
  git(root, ["config", "user.email", "test@organum.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "public cut fixture"]);
}

test("public source archive is deterministic and exactly cut-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-public-source-"));
  try {
    const repository = join(root, "repository");
    await mkdir(repository);
    await fixture(repository);
    const verified = await verifyPublicSourceTree(repository);
    assert.match(verified.commit, /^[0-9a-f]{40}$/u);
    const first = await createPublicSourceArchive({
      repository,
      outputDirectory: join(root, "first"),
    });
    const second = await createPublicSourceArchive({
      repository,
      outputDirectory: join(root, "second"),
    });
    assert.equal(first.archiveSha256, second.archiveSha256);
    assert.deepEqual(
      await readFile(first.archivePath),
      await readFile(second.archivePath),
    );
    const listing = spawnSync("tar", ["-tf", first.archivePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/u), [
      `${first.root}/`,
      `${first.root}/PUBLIC_CUT_MANIFEST.json`,
      `${first.root}/README.md`,
      `${first.root}/package.json`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public source archive refuses files outside or drifting from the cut", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-public-source-"));
  try {
    await fixture(root);
    await writeFile(join(root, "extra.txt"), "tracked surprise\n");
    git(root, ["add", "extra.txt"]);
    git(root, ["commit", "-m", "unexpected public file"]);
    await assert.rejects(
      verifyPublicSourceTree(root),
      /differs from the public cut inventory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
