import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalLicenseText,
  generateThirdPartyNotices,
} from "../scripts/generate-third-party-notices.js";

test("license hashing canonicalizes checkout line endings", () => {
  assert.equal(canonicalLicenseText("line one\r\nline two\r\n"), "line one\nline two\n");
  assert.equal(canonicalLicenseText("line one\nline two"), "line one\nline two\n");
});

test("third-party notices bind the pinned compiler runtime and production graph", async () => {
  const notices = await generateThirdPartyNotices();
  assert.match(notices, /Bun 1\.3\.14/);
  assert.match(notices, /JavaScriptCore/);
  assert.match(notices, /IMPORTANT LGPL NOTICE/);
  assert.match(notices, /JAVASCRIPTCORE-LGPL-2\.0\.txt/);
  assert.match(
    notices,
    /0d9b296af33f2b851fcbf4df3e9ec89751734ba4/,
  );
  assert.match(
    notices,
    /5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/,
  );
  assert.match(notices, /@anthropic-ai\/sandbox-runtime@0\.0\.50 \(Apache-2\.0\)/);
  assert.match(notices, /@pondwader\/socks5-server@1\.0\.10 \(MIT\)/);
  assert.match(notices, /shell-quote@1\.8\.3 \(MIT\)/);
  assert.match(notices, /shell-quote@1\.10\.0 \(MIT\)/);
  assert.match(notices, /zod@4\.1\.8 \(MIT\)/);
  assert.match(notices, /zod@3\.25\.76 \(MIT\)/);
  assert.equal(notices.endsWith("\n"), true);
});
