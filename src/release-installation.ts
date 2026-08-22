import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:process";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

import { z } from "zod";

import {
  ORGANUM_CODE_PRODUCT,
  ORGANUM_CODE_RELEASE_CHANNEL,
} from "./product.js";
import { RELEASE_MANIFEST_SCHEMA } from "./release-manifest.js";
import { CANONICAL_BUN_VERSION } from "./runtime.js";

export const INSTALL_STATE_SCHEMA =
  "organum-code/install-state/v1" as const;
export const INSTALL_STATE_FILE = "install-state.json" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_METADATA_BYTES = 64 * 1024;

const installableManifestSchema = z.object({
  schema: z.literal(RELEASE_MANIFEST_SCHEMA),
  product: z.literal(ORGANUM_CODE_PRODUCT),
  version: z.string().regex(SEMVER_PATTERN),
  channel: z.literal(ORGANUM_CODE_RELEASE_CHANNEL),
  source: z.object({
    commit: z.string().regex(COMMIT_PATTERN),
    clean: z.literal(true),
  }).strict(),
  build: z.object({
    bun: z.literal(CANONICAL_BUN_VERSION),
    platform: z.string().regex(TARGET_PATTERN),
    arch: z.string().regex(TARGET_PATTERN),
  }).strict(),
  artifact: z.object({
    file: z.string().min(1).max(255),
    bytes: z.number().int().positive().safe(),
    sha256: z.string().regex(SHA256_PATTERN),
  }).strict(),
}).strict();

export type InstallableReleaseManifest = z.infer<
  typeof installableManifestSchema
>;

const installedReleaseSchema = z.object({
  id: z.string().min(1).max(512),
  version: z.string().regex(SEMVER_PATTERN),
  channel: z.literal(ORGANUM_CODE_RELEASE_CHANNEL),
  sourceCommit: z.string().regex(COMMIT_PATTERN),
  bun: z.literal(CANONICAL_BUN_VERSION),
  platform: z.string().regex(TARGET_PATTERN),
  arch: z.string().regex(TARGET_PATTERN),
  file: z.string().min(1).max(255),
  bytes: z.number().int().positive().safe(),
  sha256: z.string().regex(SHA256_PATTERN),
  path: z.string().min(1).max(1_024),
}).strict();

export type InstalledRelease = z.infer<typeof installedReleaseSchema>;

const installStateSchema = z.object({
  schema: z.literal(INSTALL_STATE_SCHEMA),
  product: z.literal(ORGANUM_CODE_PRODUCT),
  generation: z.number().int().positive().safe(),
  active: z.string().min(1).max(512),
  previous: z.string().min(1).max(512).nullable(),
  releases: z.array(installedReleaseSchema).min(1).max(64),
}).strict();

export type InstallState = z.infer<typeof installStateSchema>;

export interface ReleaseBundlePaths {
  artifactPath: string;
  manifestPath: string;
  checksumPath: string;
  platform?: string;
  arch?: string;
}

export interface VerifiedReleaseBundle {
  artifactPath: string;
  manifest: InstallableReleaseManifest;
}

interface InstallationPaths {
  prefix: string;
  binDirectory: string;
  managedRoot: string;
  releasesRoot: string;
  statePath: string;
}

function expectedArtifactFile(platform: string): string {
  return platform === "win32" ? "organum-code.exe" : "organum-code";
}

async function regularFile(path: string, context: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${context} must be a regular non-symlink file`);
  }
  return stat;
}

async function boundedText(path: string, context: string): Promise<string> {
  const before = await regularFile(path, context);
  if (before.size < 1n || before.size > BigInt(MAX_METADATA_BYTES)) {
    throw new Error(`${context} has an invalid size`);
  }
  const text = await readFile(path, "utf8");
  const after = await regularFile(path, context);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`${context} changed while it was being read`);
  }
  return text;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyReleaseBundle(
  options: ReleaseBundlePaths,
): Promise<VerifiedReleaseBundle> {
  const platform = (options.platform ?? hostPlatform).toLowerCase();
  const arch = (options.arch ?? hostArch).toLowerCase();
  const artifactPath = resolve(options.artifactPath);
  const manifestText = await boundedText(
    resolve(options.manifestPath),
    "Release manifest",
  );
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Release manifest is not valid JSON");
  }
  const parsed = installableManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new Error(`Release manifest is invalid: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  const expectedFile = expectedArtifactFile(platform);
  if (
    manifest.build.platform !== platform ||
    manifest.build.arch !== arch
  ) {
    throw new Error(
      `Release target ${manifest.build.platform}/${manifest.build.arch} does not match host ${platform}/${arch}`,
    );
  }
  if (
    manifest.artifact.file !== expectedFile ||
    basename(artifactPath) !== expectedFile
  ) {
    throw new Error(`Release artifact must be named ${expectedFile}`);
  }
  const artifactStat = await regularFile(artifactPath, "Release artifact");
  if (
    artifactStat.size < 1n ||
    artifactStat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    Number(artifactStat.size) !== manifest.artifact.bytes
  ) {
    throw new Error("Release artifact byte length does not match its manifest");
  }
  if (platform !== "win32" && (Number(artifactStat.mode) & 0o111) === 0) {
    throw new Error("Release artifact is not executable");
  }
  const checksum = await boundedText(
    resolve(options.checksumPath),
    "Release checksum",
  );
  const expectedChecksum =
    `${manifest.artifact.sha256}  ${manifest.artifact.file}\n`;
  if (checksum !== expectedChecksum) {
    throw new Error("Release checksum file does not match its manifest");
  }
  const artifactSha256 = await sha256File(artifactPath);
  const artifactAfter = await regularFile(artifactPath, "Release artifact");
  if (
    artifactStat.dev !== artifactAfter.dev ||
    artifactStat.ino !== artifactAfter.ino ||
    artifactStat.size !== artifactAfter.size ||
    artifactStat.mtimeNs !== artifactAfter.mtimeNs
  ) {
    throw new Error("Release artifact changed while it was being verified");
  }
  if (artifactSha256 !== manifest.artifact.sha256) {
    throw new Error("Release artifact SHA-256 does not match its manifest");
  }
  return { artifactPath, manifest };
}

function installationPaths(rawPrefix: string): InstallationPaths {
  if (rawPrefix.trim().length === 0 || rawPrefix.includes("\0")) {
    throw new Error("Install prefix is invalid");
  }
  const prefix = resolve(rawPrefix);
  if (prefix === parse(prefix).root) {
    throw new Error("Install prefix cannot be a filesystem root");
  }
  const managedRoot = join(prefix, "lib", ORGANUM_CODE_PRODUCT);
  return {
    prefix,
    binDirectory: join(prefix, "bin"),
    managedRoot,
    releasesRoot: join(managedRoot, "releases"),
    statePath: join(managedRoot, INSTALL_STATE_FILE),
  };
}

function releaseID(manifest: InstallableReleaseManifest): string {
  return `${manifest.version}--${manifest.artifact.sha256}`;
}

function releaseRecord(
  manifest: InstallableReleaseManifest,
): InstalledRelease {
  const id = releaseID(manifest);
  return {
    id,
    version: manifest.version,
    channel: manifest.channel,
    sourceCommit: manifest.source.commit,
    bun: manifest.build.bun,
    platform: manifest.build.platform,
    arch: manifest.build.arch,
    file: manifest.artifact.file,
    bytes: manifest.artifact.bytes,
    sha256: manifest.artifact.sha256,
    path: join("releases", id, manifest.artifact.file),
  };
}

function recordPath(paths: InstallationPaths, record: InstalledRelease): string {
  const expected = join("releases", record.id, record.file);
  if (record.path !== expected) {
    throw new Error(`Installed release ${record.id} has an invalid path`);
  }
  const path = resolve(paths.managedRoot, record.path);
  const boundary = relative(paths.managedRoot, path);
  if (boundary.startsWith("..") || boundary === "") {
    throw new Error(`Installed release ${record.id} escapes its managed root`);
  }
  return path;
}

function validateState(raw: unknown, paths: InstallationPaths): InstallState {
  const parsed = installStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Install state is invalid: ${parsed.error.message}`);
  }
  const state = parsed.data;
  const ids = new Set<string>();
  for (const release of state.releases) {
    if (ids.has(release.id)) throw new Error("Install state repeats a release id");
    ids.add(release.id);
    if (release.id !== `${release.version}--${release.sha256}`) {
      throw new Error(`Installed release ${release.id} has an invalid id`);
    }
    recordPath(paths, release);
  }
  if (!ids.has(state.active) ||
      (state.previous !== null && !ids.has(state.previous))) {
    throw new Error("Install state references an unknown release");
  }
  return state;
}

async function readState(paths: InstallationPaths): Promise<InstallState | null> {
  try {
    const text = await boundedText(paths.statePath, "Install state");
    return validateState(JSON.parse(text), paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error("Install state is not valid JSON");
    }
    throw error;
  }
}

function findRelease(state: InstallState, id: string): InstalledRelease {
  const release = state.releases.find((candidate) => candidate.id === id);
  if (release === undefined) throw new Error(`Unknown installed release ${id}`);
  return release;
}

async function ensureDirectory(path: string, context: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${context} must be a non-symlink directory`);
  }
}

async function assertPrefixBoundary(
  paths: InstallationPaths,
  allowMissing: boolean,
): Promise<void> {
  try {
    const stat = await lstat(paths.prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Install prefix must be a non-symlink directory");
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertDirectoryBoundary(
  path: string,
  context: string,
  allowMissing: boolean,
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${context} must be a non-symlink directory`);
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertOwnedLayout(paths: InstallationPaths): Promise<void> {
  await assertPrefixBoundary(paths, false);
  await assertDirectoryBoundary(
    dirname(paths.managedRoot),
    "Install library directory",
    false,
  );
  await assertDirectoryBoundary(
    paths.managedRoot,
    "Managed install root",
    false,
  );
  await assertDirectoryBoundary(
    paths.releasesRoot,
    "Managed releases root",
    false,
  );
  await assertDirectoryBoundary(
    paths.binDirectory,
    "Install binary directory",
    false,
  );
}

async function assertFreshOwnership(
  paths: InstallationPaths,
  file: string,
): Promise<void> {
  await assertPrefixBoundary(paths, true);
  await assertDirectoryBoundary(
    dirname(paths.managedRoot),
    "Install library directory",
    true,
  );
  await assertDirectoryBoundary(
    paths.binDirectory,
    "Install binary directory",
    true,
  );
  try {
    const stat = await lstat(paths.managedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Managed install root must be a non-symlink directory");
    }
    if ((await readdir(paths.managedRoot)).length > 0) {
      throw new Error("Refusing to adopt a nonempty unmanaged install root");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await lstat(join(paths.binDirectory, file));
    throw new Error("Refusing to replace an unmanaged organum-code executable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await ensureDirectory(dirname(path), "Install metadata directory");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeState(
  paths: InstallationPaths,
  state: InstallState,
): Promise<void> {
  validateState(state, paths);
  await writeAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function verifyInstalledFile(
  path: string,
  record: InstalledRelease,
  context: string,
): Promise<void> {
  const stat = await regularFile(path, context);
  if (
    stat.size !== BigInt(record.bytes) ||
    await sha256File(path) !== record.sha256
  ) {
    throw new Error(`${context} does not match install state`);
  }
}

function activePath(paths: InstallationPaths, state: InstallState): string {
  return join(
    paths.binDirectory,
    findRelease(state, state.active).file,
  );
}

async function verifyCurrent(
  paths: InstallationPaths,
  state: InstallState,
): Promise<void> {
  const active = findRelease(state, state.active);
  await verifyInstalledFile(
    recordPath(paths, active),
    active,
    "Stored release artifact",
  );
  await verifyInstalledFile(
    activePath(paths, state),
    active,
    "Active installed executable",
  );
}

async function copyVerified(
  source: string,
  destination: string,
  expectedSha256: string,
): Promise<void> {
  await ensureDirectory(dirname(destination), "Install destination");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    if (hostPlatform !== "win32") await chmod(temporary, 0o755);
    if (await sha256File(temporary) !== expectedSha256) {
      throw new Error("Installed copy failed SHA-256 verification");
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function archiveBundle(
  paths: InstallationPaths,
  bundle: VerifiedReleaseBundle,
  record: InstalledRelease,
): Promise<boolean> {
  const destination = recordPath(paths, record);
  try {
    await verifyInstalledFile(destination, record, "Stored release artifact");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyVerified(bundle.artifactPath, destination, record.sha256);
  return true;
}

async function activate(
  paths: InstallationPaths,
  prior: InstallState | null,
  next: InstallState,
): Promise<void> {
  const release = findRelease(next, next.active);
  const source = recordPath(paths, release);
  const destination = join(paths.binDirectory, release.file);
  if (prior !== null) await verifyCurrent(paths, prior);
  else {
    try {
      await lstat(destination);
      throw new Error("Refusing to replace an unmanaged organum-code executable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await copyVerified(source, destination, release.sha256);
  try {
    await writeState(paths, next);
  } catch (error) {
    if (prior === null) {
      await rm(destination, { force: true });
    } else {
      const old = findRelease(prior, prior.active);
      await copyVerified(
        recordPath(paths, old),
        join(paths.binDirectory, old.file),
        old.sha256,
      );
    }
    throw error;
  }
}

export async function installRelease(
  prefix: string,
  bundlePaths: ReleaseBundlePaths,
): Promise<InstallState> {
  const paths = installationPaths(prefix);
  const bundle = await verifyReleaseBundle(bundlePaths);
  await assertPrefixBoundary(paths, true);
  if (await readState(paths) !== null) {
    throw new Error("Organum Code is already installed in this prefix");
  }
  const record = releaseRecord(bundle.manifest);
  await assertFreshOwnership(paths, record.file);
  const archived = await archiveBundle(paths, bundle, record);
  const state: InstallState = {
    schema: INSTALL_STATE_SCHEMA,
    product: ORGANUM_CODE_PRODUCT,
    generation: 1,
    active: record.id,
    previous: null,
    releases: [record],
  };
  try {
    await activate(paths, null, state);
    return state;
  } catch (error) {
    if (archived) await rm(recordPath(paths, record), { force: true });
    throw error;
  }
}

export async function upgradeRelease(
  prefix: string,
  bundlePaths: ReleaseBundlePaths,
): Promise<InstallState> {
  const paths = installationPaths(prefix);
  await assertOwnedLayout(paths);
  const prior = await readState(paths);
  if (prior === null) throw new Error("Organum Code is not installed in this prefix");
  await verifyCurrent(paths, prior);
  const bundle = await verifyReleaseBundle(bundlePaths);
  const record = releaseRecord(bundle.manifest);
  const sameVersion = prior.releases.find(
    (candidate) => candidate.version === record.version,
  );
  if (sameVersion !== undefined && sameVersion.id !== record.id) {
    throw new Error(
      `Release version ${record.version} is already bound to different bytes`,
    );
  }
  const sameRelease = prior.releases.find(
    (candidate) => candidate.id === record.id,
  );
  if (
    sameRelease !== undefined &&
    JSON.stringify(sameRelease) !== JSON.stringify(record)
  ) {
    throw new Error(`Release ${record.id} has conflicting provenance`);
  }
  if (prior.active === record.id) return prior;
  const archived = await archiveBundle(paths, bundle, record);
  const releases = prior.releases.some((candidate) => candidate.id === record.id)
    ? prior.releases
    : [...prior.releases, record];
  const next: InstallState = {
    ...prior,
    generation: prior.generation + 1,
    active: record.id,
    previous: prior.active,
    releases,
  };
  try {
    await activate(paths, prior, next);
    return next;
  } catch (error) {
    if (archived) await rm(recordPath(paths, record), { force: true });
    throw error;
  }
}

export async function rollbackRelease(prefix: string): Promise<InstallState> {
  const paths = installationPaths(prefix);
  await assertOwnedLayout(paths);
  const prior = await readState(paths);
  if (prior === null) throw new Error("Organum Code is not installed in this prefix");
  await verifyCurrent(paths, prior);
  if (prior.previous === null) {
    throw new Error("No previous Organum Code release is available");
  }
  const next: InstallState = {
    ...prior,
    generation: prior.generation + 1,
    active: prior.previous,
    previous: prior.active,
  };
  await activate(paths, prior, next);
  return next;
}

export async function inspectInstallation(
  prefix: string,
): Promise<InstallState | null> {
  const paths = installationPaths(prefix);
  await assertPrefixBoundary(paths, true);
  const state = await readState(paths);
  if (state !== null) {
    await assertOwnedLayout(paths);
    await verifyCurrent(paths, state);
  }
  return state;
}

async function assertExactEntries(
  directory: string,
  expected: readonly string[],
  context: string,
): Promise<void> {
  const actual = (await readdir(directory)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} contains unregistered entries`);
  }
}

async function verifyUninstallInventory(
  paths: InstallationPaths,
  state: InstallState,
): Promise<void> {
  await assertExactEntries(
    paths.managedRoot,
    [INSTALL_STATE_FILE, "releases"],
    "Managed install root",
  );
  await assertExactEntries(
    paths.releasesRoot,
    state.releases.map((release) => release.id),
    "Managed releases root",
  );
  for (const release of state.releases) {
    await assertExactEntries(
      dirname(recordPath(paths, release)),
      [release.file],
      `Stored release ${release.id}`,
    );
  }
}

export async function uninstallRelease(prefix: string): Promise<void> {
  const paths = installationPaths(prefix);
  await assertOwnedLayout(paths);
  const state = await readState(paths);
  if (state === null) throw new Error("Organum Code is not installed in this prefix");
  await verifyCurrent(paths, state);
  for (const release of state.releases) {
    await verifyInstalledFile(
      recordPath(paths, release),
      release,
      `Stored release ${release.id}`,
    );
  }
  await verifyUninstallInventory(paths, state);
  await rm(activePath(paths, state));
  for (const release of state.releases) {
    const path = recordPath(paths, release);
    await rm(path);
    await rmdir(dirname(path));
  }
  await rm(paths.statePath);
  await rmdir(paths.releasesRoot);
  await rmdir(paths.managedRoot);
  await rmdir(dirname(paths.managedRoot)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    },
  );
  await rmdir(paths.binDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
}
