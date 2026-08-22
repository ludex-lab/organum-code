import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createReleaseArchive } from "../src/release-archive.js";
import { verifyReleaseBundle } from "../src/release-installation.js";
import {
  assertCanonicalBunRuntime,
  currentBunVersion,
} from "../src/runtime.js";

function git(args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to resolve release source state: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const allowed = new Set([
    "--artifact",
    "--manifest",
    "--checksum",
    "--license",
    "--bun-license",
    "--javascriptcore-license",
    "--relinking",
    "--third-party-notices",
    "--output-directory",
  ]);
  if (args.length % 2 !== 0) throw new Error("Release archive options must be name/value pairs");
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      throw new Error(
        "usage: generate-release-archive [--artifact PATH] [--manifest PATH] [--checksum PATH] [--license PATH] [--bun-license PATH] [--javascriptcore-license PATH] [--relinking PATH] [--third-party-notices PATH] [--output-directory PATH]",
      );
    }
    options.set(name, value);
  }
  return options;
}

const bunVersion = currentBunVersion();
assertCanonicalBunRuntime(bunVersion);
if (git(["status", "--porcelain", "--untracked-files=no"]).length > 0) {
  throw new Error("Release archive requires a clean tracked source tree");
}

const options = parseOptions(process.argv.slice(2));
const artifactPath = resolve(
  options.get("--artifact") ??
    (process.platform === "win32" ? "dist/organum-code.exe" : "dist/organum-code"),
);
const manifestPath = resolve(
  options.get("--manifest") ?? `${artifactPath}.release.json`,
);
const checksumPath = resolve(
  options.get("--checksum") ?? `${artifactPath}.sha256`,
);
const verified = await verifyReleaseBundle({
  artifactPath,
  manifestPath,
  checksumPath,
});
if (verified.manifest.source.commit !== git(["rev-parse", "HEAD"])) {
  throw new Error("Release manifest source commit does not match HEAD");
}
const result = await createReleaseArchive({
  artifactPath,
  manifestPath,
  checksumPath,
  licensePath: resolve(options.get("--license") ?? "LICENSE"),
  bunLicensePath: resolve(
    options.get("--bun-license") ?? "licenses/BUN-1.3.14-LICENSE.md",
  ),
  javaScriptCoreLicensePath: resolve(
    options.get("--javascriptcore-license") ??
      "licenses/JAVASCRIPTCORE-LGPL-2.0.txt",
  ),
  relinkingPath: resolve(
    options.get("--relinking") ?? "docs/public-binary-relinking.md",
  ),
  thirdPartyNoticesPath: resolve(
    options.get("--third-party-notices") ?? "dist/THIRD_PARTY_NOTICES.txt",
  ),
  outputDirectory: resolve(options.get("--output-directory") ?? "dist"),
});
console.log(JSON.stringify(result));
