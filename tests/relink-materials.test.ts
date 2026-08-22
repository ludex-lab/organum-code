import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRelinkMaterialsManifest,
  serializeRelinkMaterialsManifest,
} from "../src/relink-materials.js";
import type { InstallableReleaseManifest } from "../src/release-installation.js";

const release = {
  schema: "organum-code/release-manifest/v1",
  product: "organum-code",
  version: "0.1.0-preview.1",
  channel: "internal-preview",
  source: { commit: "a".repeat(40), clean: true },
  build: { bun: "1.3.14", platform: "linux", arch: "x64" },
  artifact: { file: "organum-code", bytes: 1, sha256: "b".repeat(64) },
} as InstallableReleaseManifest;

test("relink manifest binds application, Bun, WebKit, and exact license bytes", async () => {
  const bunLicense = await readFile("licenses/BUN-1.3.14-LICENSE.md", "utf8");
  const javaScriptCoreLicense = await readFile(
    "licenses/JAVASCRIPTCORE-LGPL-2.0.txt",
    "utf8",
  );
  const manifest = buildRelinkMaterialsManifest({
    release,
    bunLicense,
    javaScriptCoreLicense,
  });
  assert.equal(manifest.source.commit, "a".repeat(40));
  assert.equal(
    manifest.source.archive,
    "organum-code-v0.1.0-preview.1-source.tar",
  );
  assert.equal(
    manifest.runtime.commit,
    "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
  );
  assert.equal(
    manifest.library.commit,
    "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
  );
  assert.equal(JSON.parse(serializeRelinkMaterialsManifest(manifest)).schema,
    "organum-code/relink-materials/v1");
});

test("relink manifest refuses license or runtime drift", async () => {
  const bunLicense = await readFile("licenses/BUN-1.3.14-LICENSE.md", "utf8");
  const javaScriptCoreLicense = await readFile(
    "licenses/JAVASCRIPTCORE-LGPL-2.0.txt",
    "utf8",
  );
  assert.throws(
    () => buildRelinkMaterialsManifest({
      release,
      bunLicense: `${bunLicense}drift`,
      javaScriptCoreLicense,
    }),
    /Bun relink license bytes drifted/,
  );
  assert.throws(
    () => buildRelinkMaterialsManifest({
      release: {
        ...release,
        build: { ...release.build, bun: "1.3.15" },
      } as unknown as InstallableReleaseManifest,
      bunLicense,
      javaScriptCoreLicense,
    }),
    /pinned Bun 1\.3\.14/,
  );
});
