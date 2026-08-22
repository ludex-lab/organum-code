import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";

interface PublicCutManifest {
  schema: "organum-code/public-cut/v1";
  target: "ludex-lab/organum-code";
  version: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface SourceArchiveResult {
  archivePath: string;
  checksumPath: string;
  archiveFile: string;
  archiveSha256: string;
  archiveBytes: number;
  sourceCommit: string;
  root: string;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to archive public source: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function exactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((component) =>
      component.length > 0 && component !== "." && component !== "..")
  );
}

async function readPublicCutManifest(root: string): Promise<PublicCutManifest> {
  const path = resolve(root, "PUBLIC_CUT_MANIFEST.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Public cut manifest must be a regular non-symlink file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Public cut manifest is not valid JSON");
  }
  const manifest = value as Partial<PublicCutManifest>;
  if (
    manifest.schema !== "organum-code/public-cut/v1" ||
    manifest.target !== "ludex-lab/organum-code" ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Public cut manifest identity is invalid");
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      !exactPath(file.path) ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      seen.has(file.path)
    ) {
      throw new Error("Public cut manifest file inventory is invalid");
    }
    seen.add(file.path);
  }
  return manifest as PublicCutManifest;
}

export async function verifyPublicSourceTree(root: string): Promise<{
  commit: string;
  version: string;
}> {
  const repository = resolve(root);
  if (git(repository, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("Public source archive requires a clean tracked tree");
  }
  const manifest = await readPublicCutManifest(repository);
  const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    private?: unknown;
  };
  if (
    pkg.name !== "organum-code" ||
    pkg.version !== manifest.version ||
    pkg.private !== true
  ) {
    throw new Error("Public package identity does not match its cut manifest");
  }
  const expected = new Set([
    ...manifest.files.map((file) => file.path),
    "PUBLIC_CUT_MANIFEST.json",
  ]);
  const tracked = git(repository, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => path.length > 0);
  if (
    tracked.length !== expected.size ||
    tracked.some((path) => !expected.has(path))
  ) {
    throw new Error("Tracked public source differs from the public cut inventory");
  }
  for (const file of manifest.files) {
    const path = resolve(repository, file.path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Public source is not a regular file: ${file.path}`);
    }
    if (await sha256File(path) !== file.sha256) {
      throw new Error(`Public source digest drifted: ${file.path}`);
    }
  }
  const commit = git(repository, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Public source commit is not a full SHA-1");
  }
  return { commit, version: manifest.version };
}

async function replaceText(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function createPublicSourceArchive(options: {
  repository: string;
  outputDirectory: string;
}): Promise<SourceArchiveResult> {
  const repository = resolve(options.repository);
  const outputDirectory = resolve(options.outputDirectory);
  const source = await verifyPublicSourceTree(repository);
  const root = `organum-code-v${source.version}-source`;
  const archiveFile = `${root}.tar`;
  const archivePath = resolve(outputDirectory, archiveFile);
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const temporary = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    git(repository, [
      "archive",
      "--format=tar",
      `--prefix=${root}/`,
      `--output=${temporary}`,
      source.commit,
    ]);
    await rename(temporary, archivePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const stat = await lstat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await replaceText(
    checksumPath,
    `${archiveSha256}  ${basename(archivePath)}\n`,
  );
  return {
    archivePath,
    checksumPath,
    archiveFile,
    archiveSha256,
    archiveBytes: stat.size,
    sourceCommit: source.commit,
    root,
  };
}
