import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readCutSource(
  privateTemplatePath: string,
  publicPath: string,
): Promise<string> {
  try {
    return await readFile(privateTemplatePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await readFile(publicPath, "utf8");
  }
}

test("public source command is Bun-owned and never impersonates a signed binary", async () => {
  const entrypoint = await readCutSource(
    "packaging/public-cut/organum-code",
    "bin/organum-code",
  );
  assert.match(entrypoint, /^#!\/usr\/bin\/env bun\r?\n/u);
  assert.match(entrypoint, /import "\.\.\/src\/main\.ts";/u);
  assert.doesNotMatch(entrypoint, /dist\/|\.exe|codesign|signtool/iu);
});

test("public installation documentation pins a tag and has symmetric removal", async () => {
  const documentation = await readFile("docs/source-installation.md", "utf8");
  assert.match(
    documentation,
    /bun add --global github:ludex-lab\/organum-code#v0\.1\.0-preview\.1/u,
  );
  assert.match(documentation, /bun remove --global organum-code/u);
  assert.match(documentation, /no Apple Developer ID or Windows Authenticode claim/u);
});
