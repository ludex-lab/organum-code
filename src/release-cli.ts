import { isAbsolute, resolve } from "node:path";

import {
  inspectInstallation,
  installRelease,
  type InstallState,
} from "./release-installation.js";

const RELEASE_USAGE =
  "release install --prefix ABSOLUTE_PATH --artifact PATH --manifest PATH --checksum PATH | release status --prefix ABSOLUTE_PATH";

export interface ReleaseCommandResult {
  operation: "install" | "status";
  prefix: string;
  installed: boolean;
  generation: number | null;
  version: string | null;
  sha256: string | null;
}

function parseOptions(args: readonly string[]): Map<string, string> {
  if (args.length % 2 !== 0) throw new Error(RELEASE_USAGE);
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
      throw new Error(RELEASE_USAGE);
    }
    options.set(name, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(RELEASE_USAGE);
  }
  return value;
}

function result(
  operation: ReleaseCommandResult["operation"],
  prefix: string,
  state: InstallState | null,
): ReleaseCommandResult {
  const active = state?.releases.find((release) => release.id === state.active);
  return {
    operation,
    prefix,
    installed: state !== null,
    generation: state?.generation ?? null,
    version: active?.version ?? null,
    sha256: active?.sha256 ?? null,
  };
}

export async function runReleaseCommand(
  args: readonly string[],
): Promise<ReleaseCommandResult> {
  const operation = args[0];
  if (operation !== "install" && operation !== "status") {
    throw new Error(RELEASE_USAGE);
  }
  const options = parseOptions(args.slice(1));
  const allowed = operation === "install"
    ? new Set(["--prefix", "--artifact", "--manifest", "--checksum"])
    : new Set(["--prefix"]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(RELEASE_USAGE);
  }
  const rawPrefix = required(options, "--prefix");
  if (!isAbsolute(rawPrefix)) throw new Error("--prefix must be an absolute path");
  const prefix = resolve(rawPrefix);
  if (operation === "status") {
    return result(operation, prefix, await inspectInstallation(prefix));
  }
  const state = await installRelease(prefix, {
    artifactPath: resolve(required(options, "--artifact")),
    manifestPath: resolve(required(options, "--manifest")),
    checksumPath: resolve(required(options, "--checksum")),
  });
  return result(operation, prefix, state);
}
