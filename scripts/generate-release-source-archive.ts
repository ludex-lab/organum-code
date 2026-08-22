import { resolve } from "node:path";

import { createPublicSourceArchive } from "../src/release-source-archive.js";

function outputDirectory(args: readonly string[]): string {
  if (args.length === 0) return resolve("dist");
  if (args.length !== 2 || args[0] !== "--output-directory") {
    throw new Error(
      "usage: generate-release-source-archive [--output-directory PATH]",
    );
  }
  return resolve(args[1]!);
}

const result = await createPublicSourceArchive({
  repository: resolve("."),
  outputDirectory: outputDirectory(process.argv.slice(2)),
});
console.log(JSON.stringify(result));
