import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runReleaseCommand } from "../src/release-cli.js";

test("standalone release status is explicit, absolute, and reports absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "organum-code-release-cli-"));
  try {
    assert.deepEqual(await runReleaseCommand(["status", "--prefix", root]), {
      operation: "status",
      prefix: root,
      installed: false,
      generation: null,
      version: null,
      sha256: null,
    });
    await assert.rejects(
      runReleaseCommand(["status", "--prefix", "relative"]),
      /absolute path/,
    );
    await assert.rejects(
      runReleaseCommand(["uninstall", "--prefix", root]),
      /release install/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
