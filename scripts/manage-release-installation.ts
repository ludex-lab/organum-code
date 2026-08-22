import { isAbsolute, resolve } from "node:path";

import {
  inspectInstallation,
  installRelease,
  rollbackRelease,
  uninstallRelease,
  upgradeRelease,
  type InstallState,
  type ReleaseBundlePaths,
} from "../src/release-installation.js";

const USAGE = `usage:
  manage-release-installation install --prefix ABSOLUTE_PATH --artifact PATH --manifest PATH --checksum PATH
  manage-release-installation upgrade --prefix ABSOLUTE_PATH --artifact PATH --manifest PATH --checksum PATH
  manage-release-installation rollback --prefix ABSOLUTE_PATH
  manage-release-installation status --prefix ABSOLUTE_PATH
  manage-release-installation uninstall --prefix ABSOLUTE_PATH`;

type Operation = "install" | "upgrade" | "rollback" | "status" | "uninstall";

function parseOptions(args: readonly string[]): Map<string, string> {
  if (args.length % 2 !== 0) throw new Error(USAGE);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      throw new Error(USAGE);
    }
    options.set(name, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.trim().length === 0) throw new Error(USAGE);
  return value;
}

function bundle(options: Map<string, string>): ReleaseBundlePaths {
  return {
    artifactPath: resolve(required(options, "--artifact")),
    manifestPath: resolve(required(options, "--manifest")),
    checksumPath: resolve(required(options, "--checksum")),
  };
}

function summary(
  operation: Operation,
  prefix: string,
  state: InstallState | null,
) {
  const active = state?.releases.find((release) => release.id === state.active);
  return {
    operation,
    prefix,
    installed: state !== null,
    generation: state?.generation ?? null,
    version: active?.version ?? null,
    sha256: active?.sha256 ?? null,
    previous: state?.previous ?? null,
  };
}

async function run(): Promise<void> {
  const operation = process.argv[2] as Operation | undefined;
  if (
    operation !== "install" &&
    operation !== "upgrade" &&
    operation !== "rollback" &&
    operation !== "status" &&
    operation !== "uninstall"
  ) {
    throw new Error(USAGE);
  }
  const options = parseOptions(process.argv.slice(3));
  const allowed = operation === "install" || operation === "upgrade"
    ? new Set(["--prefix", "--artifact", "--manifest", "--checksum"])
    : new Set(["--prefix"]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(USAGE);
  }
  const rawPrefix = required(options, "--prefix");
  if (!isAbsolute(rawPrefix)) {
    throw new Error("--prefix must be an absolute path");
  }
  const prefix = resolve(rawPrefix);
  let state: InstallState | null;
  switch (operation) {
    case "install":
      state = await installRelease(prefix, bundle(options));
      break;
    case "upgrade":
      state = await upgradeRelease(prefix, bundle(options));
      break;
    case "rollback":
      state = await rollbackRelease(prefix);
      break;
    case "status":
      state = await inspectInstallation(prefix);
      break;
    case "uninstall":
      await uninstallRelease(prefix);
      state = null;
      break;
  }
  console.log(JSON.stringify(summary(operation, prefix, state)));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
