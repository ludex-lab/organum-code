import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { ORGANUM_CODE_VERSION } from "../src/product.js";

type PublicPackage = Readonly<{
  name: string;
  version: string;
  bin: Readonly<Record<string, string>>;
}>;

const project = resolve(".");
const pkg = JSON.parse(
  await readFile(join(project, "package.json"), "utf8"),
) as PublicPackage;
assert.equal(pkg.name, "organum-code");
assert.equal(pkg.version, ORGANUM_CODE_VERSION);
assert.equal(pkg.bin["organum-code"], "./bin/organum-code");

const entrypoint = await readFile(join(project, "bin", "organum-code"), "utf8");
assert.match(entrypoint, /^#!\/usr\/bin\/env bun\r?\n/u);
assert.match(entrypoint, /import "\.\.\/src\/main\.ts";/u);

const root = await mkdtemp(join(tmpdir(), "organum-code-source-install-"));
const bunInstall = join(root, "bun-home");
const bin = join(bunInstall, "bin");
const tarball = join(root, `organum-code-${ORGANUM_CODE_VERSION}.tgz`);
const environment = {
  ...process.env,
  BUN_INSTALL: bunInstall,
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
};

function bun(args: readonly string[]) {
  return spawnSync(process.execPath, [...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
  });
}

try {
  const pack = spawnSync(
    process.execPath,
    ["pm", "pack", "--destination", root, "--ignore-scripts", "--quiet"],
    {
      cwd: project,
      env: process.env,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    },
  );
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);

  const install = bun(["add", "--global", tarball]);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const version = spawnSync("organum-code", ["--version"], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.equal(version.stdout.trim(), `organum-code ${ORGANUM_CODE_VERSION}`);

  const uninstall = bun(["remove", "--global", "organum-code"]);
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(
    (await readdir(bin).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })).some((name) => name === "organum-code" || name.startsWith("organum-code.")),
    false,
    "source-install command shim survived global uninstall",
  );
  console.log(`source install/uninstall smoke passed: ${process.platform}/${process.arch}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
