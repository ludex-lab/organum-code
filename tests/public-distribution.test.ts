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

test("macOS release entitlements match the Bun standalone runtime contract", async () => {
  const entitlements = await readCutSource(
    "packaging/public-cut/macos-entitlements.plist",
    "packaging/macos-entitlements.plist",
  );
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-executable-page-protection",
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.disable-library-validation",
  ]) {
    assert.match(entitlements, new RegExp(`<key>${entitlement}</key>\\s*<true/>`, "u"));
  }
  assert.equal((entitlements.match(/<key>/gu) ?? []).length, 5);
});

test("signed candidate workflow fails closed before archive generation", async () => {
  const workflow = await readCutSource(
    "packaging/public-cut/release-candidate.yml",
    ".github/workflows/release-candidate.yml",
  );
  for (const secret of [
    "APPLE_CERTIFICATE_P12_BASE64",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_NOTARY_KEY_P8_BASE64",
    "APPLE_NOTARY_KEY_ID",
    "APPLE_NOTARY_ISSUER_ID",
    "WINDOWS_CERTIFICATE_PFX_BASE64",
    "WINDOWS_CERTIFICATE_PASSWORD",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`, "u"));
  }
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(workflow, /--options runtime --timestamp/u);
  assert.match(workflow, /packaging\/macos-entitlements\.plist/u);
  assert.match(workflow, /xcrun notarytool submit/u);
  assert.match(workflow, /sign \/f .* \/fd SHA256 \/tr .* \/td SHA256/u);
  assert.match(workflow, /verify \/pa \/v/u);
  assert.match(workflow, /uses: actions\/attest@v4/gu);
  assert.doesNotMatch(workflow, /gh release (create|upload|edit)/u);

  const macOS = workflow.slice(
    workflow.indexOf("  stage-macos:"),
    workflow.indexOf("  stage-windows:"),
  );
  assert(macOS.indexOf("codesign --force") < macOS.indexOf("bun run manifest:release"));
  assert(macOS.indexOf("xcrun notarytool submit") < macOS.indexOf("bun run manifest:release"));

  const windows = workflow.slice(workflow.indexOf("  stage-windows:"));
  assert(windows.indexOf("sign /f") < windows.indexOf("bun run manifest:release"));
  assert(windows.indexOf("verify /pa") < windows.indexOf("bun run manifest:release"));
});
