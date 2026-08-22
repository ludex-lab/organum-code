import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const artifact = resolve(
  process.platform === "win32"
    ? "dist/organum-code.exe"
    : "dist/organum-code",
);
const manifest = `${artifact}.release.json`;
const checksum = `${artifact}.sha256`;
const manager = resolve("scripts/manage-release-installation.ts");
const root = await mkdtemp(join(tmpdir(), "organum-code-install-smoke-"));
const prefix = join(root, "prefix");

function manage(args: readonly string[]) {
  const result = spawnSync(process.execPath, [manager, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    installed: boolean;
    version: string | null;
  };
}

try {
  await writeFile(join(root, "sentinel"), "preserve\n");
  const installed = manage([
    "install",
    "--prefix", prefix,
    "--artifact", artifact,
    "--manifest", manifest,
    "--checksum", checksum,
  ]);
  assert.equal(installed.installed, true);
  assert.equal(installed.version, "0.1.0-preview.1");

  const executable = join(
    prefix,
    "bin",
    process.platform === "win32" ? "organum-code.exe" : "organum-code",
  );
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(version.error, undefined, version.error?.message);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "organum-code 0.1.0-preview.1");

  assert.equal(
    manage(["status", "--prefix", prefix]).installed,
    true,
  );
  assert.equal(
    manage(["uninstall", "--prefix", prefix]).installed,
    false,
  );
  await assert.rejects(access(executable));
  assert.equal(await readFile(join(root, "sentinel"), "utf8"), "preserve\n");
  console.log(`release installation smoke passed: ${process.platform}/${process.arch}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
