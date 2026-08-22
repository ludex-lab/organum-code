import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertCanonicalBunRuntime,
  CANONICAL_BUN_VERSION,
  currentBunVersion,
} from "../src/runtime.js";

test("Bun version pin agrees across runtime metadata", () => {
  const packageJSON = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as { packageManager: string };
  const versionFile = readFileSync(".bun-version", "utf8").trim();

  assert.equal(CANONICAL_BUN_VERSION, "1.3.14");
  assert.equal(packageJSON.packageManager, `bun@${CANONICAL_BUN_VERSION}`);
  assert.equal(versionFile, CANONICAL_BUN_VERSION);
});

test("runtime guard accepts Node and the canonical Bun version", () => {
  assert.doesNotThrow(() => assertCanonicalBunRuntime(undefined));
  assert.doesNotThrow(() =>
    assertCanonicalBunRuntime(CANONICAL_BUN_VERSION),
  );
  assert.equal(currentBunVersion({ version: CANONICAL_BUN_VERSION }), "1.3.14");
});

test("runtime guard rejects a different Bun version", () => {
  assert.throws(
    () => assertCanonicalBunRuntime("1.3.13"),
    /Bun 1\.3\.14 is required; found Bun 1\.3\.13/,
  );
});
