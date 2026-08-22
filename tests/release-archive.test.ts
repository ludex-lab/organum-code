import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createReleaseArchive,
  posixBootstrap,
  posixUninstallBootstrap,
  powershellBootstrap,
  powershellUninstallBootstrap,
  releaseArchiveFile,
  releaseArchiveRoot,
} from "../src/release-archive.js";
import type {
  InstallableReleaseManifest,
  ReleaseBundlePaths,
} from "../src/release-installation.js";

async function fixture(root: string): Promise<{
  paths: ReleaseBundlePaths & {
    licensePath: string;
    bunLicensePath: string;
    javaScriptCoreLicensePath: string;
    relinkingPath: string;
    thirdPartyNoticesPath: string;
  };
  manifest: InstallableReleaseManifest;
}> {
  const file = process.platform === "win32" ? "organum-code.exe" : "organum-code";
  const artifactPath = join(root, file);
  const manifestPath = `${artifactPath}.release.json`;
  const checksumPath = `${artifactPath}.sha256`;
  const licensePath = join(root, "LICENSE");
  const thirdPartyNoticesPath = join(root, "THIRD_PARTY_NOTICES.txt");
  const body = Buffer.from("offline executable fixture\n", "utf8");
  const digest = createHash("sha256").update(body).digest("hex");
  const manifest: InstallableReleaseManifest = {
    schema: "organum-code/release-manifest/v1",
    product: "organum-code",
    version: "0.1.0-preview.1",
    channel: "internal-preview",
    source: { commit: "a".repeat(40), clean: true },
    build: { bun: "1.3.14", platform: process.platform, arch: process.arch },
    artifact: { file, bytes: body.byteLength, sha256: digest },
  };
  await writeFile(artifactPath, body);
  if (process.platform !== "win32") await chmod(artifactPath, 0o755);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(checksumPath, `${digest}  ${file}\n`);
  await writeFile(licensePath, "Organum Code fixture license\n");
  await writeFile(thirdPartyNoticesPath, "Fixture third-party notices\n");
  return {
    paths: {
      artifactPath,
      manifestPath,
      checksumPath,
      licensePath,
      bunLicensePath: resolve("licenses/BUN-1.3.14-LICENSE.md"),
      javaScriptCoreLicensePath: resolve(
        "licenses/JAVASCRIPTCORE-LGPL-2.0.txt",
      ),
      relinkingPath: resolve("docs/public-binary-relinking.md"),
      thirdPartyNoticesPath,
    },
    manifest,
  };
}

test("release archive naming and bootstraps are platform-bound and runtime-free", () => {
  const manifest = {
    version: "0.1.0-preview.1",
    build: { platform: "darwin", arch: "arm64" },
  } as InstallableReleaseManifest;
  assert.equal(
    releaseArchiveRoot(manifest),
    "organum-code-v0.1.0-preview.1-darwin-arm64",
  );
  assert.equal(
    releaseArchiveFile(manifest),
    "organum-code-v0.1.0-preview.1-darwin-arm64.tar",
  );
  const sh = posixBootstrap("organum-code");
  const ps1 = powershellBootstrap("organum-code.exe");
  const uninstallSh = posixUninstallBootstrap("organum-code");
  const uninstallPs1 = powershellUninstallBootstrap("organum-code.exe");
  assert.match(sh, /organum-code" release install/);
  assert.match(ps1, /organum-code\.exe/);
  assert.match(ps1, /release install/);
  assert.match(uninstallSh, /organum-code" release uninstall/);
  assert.match(uninstallPs1, /organum-code\.exe/);
  assert.match(uninstallPs1, /release uninstall/);
  assert.doesNotMatch(sh, /\bbun\b/i);
  assert.doesNotMatch(ps1, /\bbun\b/i);
  assert.doesNotMatch(uninstallSh, /\bbun\b/i);
  assert.doesNotMatch(uninstallPs1, /\bbun\b/i);
});

test("release tar is deterministic and contains one rooted offline bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-release-archive-"));
  try {
    const source = join(root, "source");
    const firstOutput = join(root, "first");
    const secondOutput = join(root, "second");
    await mkdir(source, { recursive: true });
    const { paths, manifest } = await fixture(source);
    const first = await createReleaseArchive({ ...paths, outputDirectory: firstOutput });
    const second = await createReleaseArchive({ ...paths, outputDirectory: secondOutput });
    assert.equal(first.archiveFile, releaseArchiveFile(manifest));
    assert.equal(first.archiveSha256, second.archiveSha256);
    assert.deepEqual(
      await readFile(first.archivePath),
      await readFile(second.archivePath),
    );
    assert.equal(
      await readFile(first.checksumPath, "utf8"),
      `${first.archiveSha256}  ${first.archiveFile}\n`,
    );

    const listing = spawnSync("tar", ["-tf", first.archivePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(listing.status, 0, listing.stderr);
    const prefix = `${releaseArchiveRoot(manifest)}/`;
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/), [
      `${prefix}${manifest.artifact.file}`,
      `${prefix}${manifest.artifact.file}.release.json`,
      `${prefix}${manifest.artifact.file}.sha256`,
      `${prefix}bundle.json`,
      `${prefix}install.sh`,
      `${prefix}install.ps1`,
      `${prefix}uninstall.sh`,
      `${prefix}uninstall.ps1`,
      `${prefix}RELINKING.md`,
      `${prefix}relink.json`,
      `${prefix}BUN-LICENSE.md`,
      `${prefix}JAVASCRIPTCORE-LGPL-2.0.txt`,
      `${prefix}README.txt`,
      `${prefix}LICENSE`,
      `${prefix}THIRD_PARTY_NOTICES.txt`,
    ]);
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    const extraction = spawnSync(
      "tar",
      ["-xf", first.archivePath, "-C", extracted],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(extraction.status, 0, extraction.stderr);
    const relink = JSON.parse(
      await readFile(join(extracted, releaseArchiveRoot(manifest), "relink.json"), "utf8"),
    ) as {
      schema: string;
      source: { commit: string; archive: string };
      runtime: { commit: string };
      library: { commit: string };
    };
    assert.equal(relink.schema, "organum-code/relink-materials/v1");
    assert.equal(relink.source.commit, manifest.source.commit);
    assert.equal(
      relink.source.archive,
      "organum-code-v0.1.0-preview.1-source.tar",
    );
    assert.equal(
      relink.runtime.commit,
      "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    );
    assert.equal(
      relink.library.commit,
      "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    );
    assert.match(
      await readFile(
        join(extracted, releaseArchiveRoot(manifest), "JAVASCRIPTCORE-LGPL-2.0.txt"),
        "utf8",
      ),
      /GNU LIBRARY GENERAL PUBLIC LICENSE/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
