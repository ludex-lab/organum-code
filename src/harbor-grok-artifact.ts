import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const artifactSchema = z.object({
  platform: z.enum(["linux-aarch64", "linux-x86_64"]),
  uname_system: z.literal("Linux"),
  uname_machines: z.array(z.string().min(1)).min(1),
  filename: z.string().regex(/^grok-[0-9]+\.[0-9]+\.[0-9]+-linux-(aarch64|x86_64)$/),
  source_url: z.string().url().refine(
    (value) => new URL(value).origin === "https://x.ai",
    "Grok artifact source must be the publisher HTTPS origin",
  ),
  sha256,
  bytes: z.number().int().positive(),
  format: z.string().min(1),
}).strict();

export const harborGrokArtifactManifestSchema = z.object({
  schema: z.literal("organum-code/harbor-grok-artifacts/v1"),
  grok_version: z.literal("0.2.111"),
  release_revision: z.string().regex(/^[0-9a-f]{10}$/),
  acquired_at: z.string().datetime({ offset: true }),
  distribution: z.object({
    publisher: z.literal("xAI"),
    installer_url: z.literal("https://x.ai/cli/install.sh"),
    transport: z.literal("publisher HTTPS direct binary"),
    publisher_checksum_available: z.literal(false),
    trust_model: z.literal(
      "TLS acquisition followed by repository-pinned SHA-256",
    ),
  }).strict(),
  cache_subdir: z.literal(".artifacts/harbor/grok/0.2.111"),
  artifacts: z.array(artifactSchema).length(2),
}).strict().superRefine((manifest, context) => {
  const platforms = new Set(manifest.artifacts.map(({ platform }) => platform));
  if (platforms.size !== manifest.artifacts.length) {
    context.addIssue({
      code: "custom",
      message: "Grok artifact platforms must be unique",
    });
  }
  for (const artifact of manifest.artifacts) {
    const expectedFilename =
      `grok-${manifest.grok_version}-${artifact.platform}`;
    if (artifact.filename !== expectedFilename) {
      context.addIssue({
        code: "custom",
        message: `Grok artifact filename/version mismatch: ${artifact.filename}`,
      });
    }
    if (artifact.source_url !== `https://x.ai/cli/${expectedFilename}`) {
      context.addIssue({
        code: "custom",
        message: `Grok artifact source/filename mismatch: ${artifact.source_url}`,
      });
    }
  }
});

export type HarborGrokArtifactManifest = z.infer<
  typeof harborGrokArtifactManifestSchema
>;
export type HarborGrokArtifact =
  HarborGrokArtifactManifest["artifacts"][number];
export type HarborGrokPlatform = HarborGrokArtifact["platform"];

export const DEFAULT_HARBOR_GROK_MANIFEST =
  "integrations/harbor/grok-artifacts-v1.json";

export function harborGrokManifestSha256(text: string): string {
  return createHash("sha256")
    .update(text.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

export async function readHarborGrokArtifactManifest(
  path = DEFAULT_HARBOR_GROK_MANIFEST,
): Promise<{
  manifest: HarborGrokArtifactManifest;
  sha256: string;
  path: string;
}> {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  const text = bytes.toString("utf8");
  const value: unknown = JSON.parse(text);
  return {
    manifest: harborGrokArtifactManifestSchema.parse(value),
    sha256: harborGrokManifestSha256(text),
    path: absolutePath,
  };
}

export function selectHarborGrokArtifact(
  manifest: HarborGrokArtifactManifest,
  platform: HarborGrokPlatform,
): HarborGrokArtifact {
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.platform === platform,
  );
  if (artifact === undefined) {
    throw new Error(`No pinned Grok artifact for ${platform}`);
  }
  return artifact;
}

export function harborGrokArtifactPath(
  manifest: HarborGrokArtifactManifest,
  artifact: HarborGrokArtifact,
  root = process.cwd(),
): string {
  return resolve(root, manifest.cache_subdir, artifact.filename);
}

export async function sha256File(path: string): Promise<{
  sha256: string;
  bytes: number;
}> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}

export async function verifyHarborGrokArtifact(
  path: string,
  artifact: HarborGrokArtifact,
): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== artifact.bytes) {
    throw new Error(
      `Grok artifact size mismatch for ${artifact.platform}: expected ` +
        `${artifact.bytes}, got ${metadata.size}`,
    );
  }
  const observed = await sha256File(path);
  if (observed.sha256 !== artifact.sha256) {
    throw new Error(
      `Grok artifact SHA-256 mismatch for ${artifact.platform}: expected ` +
        `${artifact.sha256}, got ${observed.sha256}`,
    );
  }
}
