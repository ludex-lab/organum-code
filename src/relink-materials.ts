import { createHash } from "node:crypto";

import type { InstallableReleaseManifest } from "./release-installation.js";

export const RELINK_MANIFEST_SCHEMA =
  "organum-code/relink-materials/v1" as const;

export const PINNED_BUN_SOURCE = {
  repository: "https://github.com/oven-sh/bun.git",
  tag: "bun-v1.3.14",
  commit: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
  licenseSha256:
    "2cb858b2db8fc793bca2093489c5bc8eee615d002cc4924254904044c27a0afa",
} as const;

export const PINNED_WEBKIT_SOURCE = {
  repository: "https://github.com/oven-sh/WebKit.git",
  commit: "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
  javaScriptCoreLicensePath: "Source/JavaScriptCore/COPYING.LIB",
  javaScriptCoreLicenseSha256:
    "5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547",
} as const;

export interface RelinkMaterialsManifest {
  schema: typeof RELINK_MANIFEST_SCHEMA;
  product: "organum-code";
  version: string;
  source: {
    repository: "https://github.com/ludex-lab/organum-code";
    commit: string;
    archive: string;
    checksum: string;
  };
  runtime: typeof PINNED_BUN_SOURCE;
  library: typeof PINNED_WEBKIT_SOURCE;
  materials: {
    instructions: "RELINKING.md";
    runtimeLicense: "BUN-LICENSE.md";
    libraryLicense: "JAVASCRIPTCORE-LGPL-2.0.txt";
    thirdPartyNotices: "THIRD_PARTY_NOTICES.txt";
  };
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function buildRelinkMaterialsManifest(options: {
  release: InstallableReleaseManifest;
  bunLicense: string;
  javaScriptCoreLicense: string;
}): RelinkMaterialsManifest {
  if (options.release.build.bun !== "1.3.14") {
    throw new Error("Relink materials require the pinned Bun 1.3.14 runtime");
  }
  if (sha256(options.bunLicense) !== PINNED_BUN_SOURCE.licenseSha256) {
    throw new Error("Pinned Bun relink license bytes drifted");
  }
  if (
    sha256(options.javaScriptCoreLicense) !==
    PINNED_WEBKIT_SOURCE.javaScriptCoreLicenseSha256
  ) {
    throw new Error("Pinned JavaScriptCore LGPL bytes drifted");
  }
  const sourceArchive = `organum-code-v${options.release.version}-source.tar`;
  return {
    schema: RELINK_MANIFEST_SCHEMA,
    product: "organum-code",
    version: options.release.version,
    source: {
      repository: "https://github.com/ludex-lab/organum-code",
      commit: options.release.source.commit,
      archive: sourceArchive,
      checksum: `${sourceArchive}.sha256`,
    },
    runtime: PINNED_BUN_SOURCE,
    library: PINNED_WEBKIT_SOURCE,
    materials: {
      instructions: "RELINKING.md",
      runtimeLicense: "BUN-LICENSE.md",
      libraryLicense: "JAVASCRIPTCORE-LGPL-2.0.txt",
      thirdPartyNotices: "THIRD_PARTY_NOTICES.txt",
    },
  };
}

export function serializeRelinkMaterialsManifest(
  manifest: RelinkMaterialsManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
