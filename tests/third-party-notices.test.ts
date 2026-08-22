import assert from "node:assert/strict";
import test from "node:test";

import { generateThirdPartyNotices } from "../scripts/generate-third-party-notices.js";

test("third-party notices bind the pinned compiler runtime and production graph", async () => {
  const notices = await generateThirdPartyNotices();
  assert.match(notices, /Bun 1\.3\.14/);
  assert.match(notices, /JavaScriptCore/);
  assert.match(notices, /@anthropic-ai\/sandbox-runtime@0\.0\.50 \(Apache-2\.0\)/);
  assert.match(notices, /@pondwader\/socks5-server@1\.0\.10 \(MIT\)/);
  assert.match(notices, /shell-quote@1\.8\.3 \(MIT\)/);
  assert.match(notices, /shell-quote@1\.10\.0 \(MIT\)/);
  assert.match(notices, /zod@4\.1\.8 \(MIT\)/);
  assert.match(notices, /zod@3\.25\.76 \(MIT\)/);
  assert.equal(notices.endsWith("\n"), true);
});
