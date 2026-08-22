import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const executable = resolve(
  "dist",
  process.platform === "win32" ? "organum-code.exe" : "organum-code",
);

assert.equal(
  existsSync(executable),
  true,
  `standalone executable does not exist: ${executable}`,
);

const result = spawnSync(executable, ["--help"], {
  encoding: "utf8",
  timeout: 10_000,
});

assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /Use an API-backed brain through a brokered coding harness/);

const version = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(version.error, undefined, version.error?.message);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), "organum-code 0.1.0-preview.1");

console.log(`standalone smoke test passed: ${executable}`);
