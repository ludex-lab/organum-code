import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  verifyReleaseBundle,
  type InstallableReleaseManifest,
  type ReleaseBundlePaths,
} from "./release-installation.js";

export const RELEASE_ARCHIVE_SCHEMA =
  "organum-code/release-archive/v1" as const;

interface TarEntry {
  name: string;
  mode: number;
  bytes: number;
  chunks: () => AsyncIterable<Buffer>;
}

export interface ReleaseArchiveResult {
  archivePath: string;
  checksumPath: string;
  archiveFile: string;
  archiveSha256: string;
  archiveBytes: number;
  root: string;
}

export interface CreateReleaseArchiveOptions extends ReleaseBundlePaths {
  outputDirectory: string;
  licensePath: string;
  thirdPartyNoticesPath: string;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function releaseArchiveRoot(
  manifest: InstallableReleaseManifest,
): string {
  return `organum-code-v${manifest.version}-${manifest.build.platform}-${manifest.build.arch}`;
}

export function releaseArchiveFile(
  manifest: InstallableReleaseManifest,
): string {
  return `${releaseArchiveRoot(manifest)}.tar`;
}

export function posixBootstrap(file: string): string {
  return `#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "usage: ./install.sh /absolute/install/prefix" >&2
  exit 64
fi
case "$1" in
  /*) ;;
  *) echo "install prefix must be absolute" >&2; exit 64 ;;
esac
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$bundle_dir/${file}" release install \\
  --prefix "$1" \\
  --artifact "$bundle_dir/${file}" \\
  --manifest "$bundle_dir/${file}.release.json" \\
  --checksum "$bundle_dir/${file}.sha256"
`;
}

export function powershellBootstrap(file: string): string {
  return `param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Prefix
)
$ErrorActionPreference = "Stop"
if (-not [System.IO.Path]::IsPathRooted($Prefix)) {
  Write-Error "install prefix must be absolute"
  exit 64
}
$artifact = Join-Path $PSScriptRoot "${file}"
$manifest = Join-Path $PSScriptRoot "${file}.release.json"
$checksum = Join-Path $PSScriptRoot "${file}.sha256"
& $artifact release install --prefix $Prefix --artifact $artifact --manifest $manifest --checksum $checksum
exit $LASTEXITCODE
`;
}

export function posixUninstallBootstrap(file: string): string {
  return `#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "usage: ./uninstall.sh /absolute/install/prefix" >&2
  exit 64
fi
case "$1" in
  /*) ;;
  *) echo "install prefix must be absolute" >&2; exit 64 ;;
esac
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$bundle_dir/${file}" release uninstall --prefix "$1"
`;
}

export function powershellUninstallBootstrap(file: string): string {
  return `param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Prefix
)
$ErrorActionPreference = "Stop"
if (-not [System.IO.Path]::IsPathRooted($Prefix)) {
  Write-Error "install prefix must be absolute"
  exit 64
}
$artifact = Join-Path $PSScriptRoot "${file}"
& $artifact release uninstall --prefix $Prefix
exit $LASTEXITCODE
`;
}

function bundleReadme(manifest: InstallableReleaseManifest): string {
  const executable = manifest.artifact.file;
  return `Organum Code ${manifest.version} (${manifest.build.platform}/${manifest.build.arch})

Internal preview offline bundle. This bundle does not perform network access,
enable auto-update, or establish publisher authenticity.

Verify the adjacent archive checksum before extraction. After extraction:

POSIX:
  ./install.sh /absolute/install/prefix

PowerShell:
  ./install.ps1 C:\\absolute\\install\\prefix

The bootstrap runs ./${executable} and installs only into the explicit prefix.
Run <prefix>/bin/${executable} --version after installation.

Uninstall from this extracted release bundle:

POSIX:
  ./uninstall.sh /absolute/install/prefix

PowerShell:
  ./uninstall.ps1 C:\\absolute\\install\\prefix

The uninstall bootstrap runs this bundle's executable, verifies the managed
installation ledger and bytes, and removes only registered Organum Code files.
On Windows, do not run uninstall through the installed executable because a
running executable cannot reliably delete itself. Keep this extracted bundle,
or re-download the exact platform bundle, for removal.

LICENSE contains the Organum Code license. THIRD_PARTY_NOTICES.txt contains the
pinned compiler runtime and production dependency notices.
`;
}

function bufferEntry(name: string, body: string, mode: number): TarEntry {
  const buffer = Buffer.from(body, "utf8");
  return {
    name,
    mode,
    bytes: buffer.byteLength,
    chunks: () => Readable.from([buffer]),
  };
}

function octal(value: number, width: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Tar numeric field is invalid");
  }
  const rendered = value.toString(8);
  if (rendered.length > width - 1) throw new Error("Tar numeric field overflow");
  return Buffer.from(`${rendered.padStart(width - 1, "0")}\0`, "ascii");
}

function tarHeader(entry: TarEntry): Buffer {
  if (
    Buffer.byteLength(entry.name, "utf8") > 100 ||
    entry.name.startsWith("/") ||
    entry.name.includes("\0") ||
    entry.name.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`Tar entry path is unsafe or too long: ${entry.name}`);
  }
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  octal(entry.mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(entry.bytes, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 4, "ascii");
  header.write("root", 297, 4, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii");
  checksum.copy(header, 148);
  return header;
}

async function* tarStream(entries: readonly TarEntry[]) {
  for (const entry of entries) {
    yield tarHeader(entry);
    let observed = 0;
    for await (const chunk of entry.chunks()) {
      observed += chunk.byteLength;
      if (observed > entry.bytes) throw new Error(`Tar entry grew: ${entry.name}`);
      yield chunk;
    }
    if (observed !== entry.bytes) throw new Error(`Tar entry size drifted: ${entry.name}`);
    const padding = (512 - (entry.bytes % 512)) % 512;
    if (padding > 0) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1_024);
}

async function replaceText(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function createReleaseArchive(
  options: CreateReleaseArchiveOptions,
): Promise<ReleaseArchiveResult> {
  const bundle = await verifyReleaseBundle(options);
  const manifest = bundle.manifest;
  const root = releaseArchiveRoot(manifest);
  const archiveFile = releaseArchiveFile(manifest);
  const outputDirectory = resolve(options.outputDirectory);
  const archivePath = resolve(outputDirectory, archiveFile);
  if (dirname(archivePath) !== outputDirectory) {
    throw new Error("Release archive escaped its output directory");
  }
  const manifestBody = await readFile(resolve(options.manifestPath), "utf8");
  const checksumBody = await readFile(resolve(options.checksumPath), "utf8");
  const licenseBody = await readFile(resolve(options.licensePath), "utf8");
  const thirdPartyNoticesBody = await readFile(
    resolve(options.thirdPartyNoticesPath),
    "utf8",
  );
  const posix = posixBootstrap(manifest.artifact.file);
  const powershell = powershellBootstrap(manifest.artifact.file);
  const posixUninstall = posixUninstallBootstrap(manifest.artifact.file);
  const powershellUninstall = powershellUninstallBootstrap(
    manifest.artifact.file,
  );
  const readme = bundleReadme(manifest);
  const contentManifest = `${JSON.stringify({
    schema: RELEASE_ARCHIVE_SCHEMA,
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    source: manifest.source,
    build: manifest.build,
    root,
    payloads: [
      { file: manifest.artifact.file, bytes: manifest.artifact.bytes, sha256: manifest.artifact.sha256, mode: "0755" },
      { file: `${manifest.artifact.file}.release.json`, bytes: Buffer.byteLength(manifestBody), sha256: sha256(manifestBody), mode: "0644" },
      { file: `${manifest.artifact.file}.sha256`, bytes: Buffer.byteLength(checksumBody), sha256: sha256(checksumBody), mode: "0644" },
      { file: "install.sh", bytes: Buffer.byteLength(posix), sha256: sha256(posix), mode: "0755" },
      { file: "install.ps1", bytes: Buffer.byteLength(powershell), sha256: sha256(powershell), mode: "0644" },
      { file: "uninstall.sh", bytes: Buffer.byteLength(posixUninstall), sha256: sha256(posixUninstall), mode: "0755" },
      { file: "uninstall.ps1", bytes: Buffer.byteLength(powershellUninstall), sha256: sha256(powershellUninstall), mode: "0644" },
      { file: "README.txt", bytes: Buffer.byteLength(readme), sha256: sha256(readme), mode: "0644" },
      { file: "LICENSE", bytes: Buffer.byteLength(licenseBody), sha256: sha256(licenseBody), mode: "0644" },
      { file: "THIRD_PARTY_NOTICES.txt", bytes: Buffer.byteLength(thirdPartyNoticesBody), sha256: sha256(thirdPartyNoticesBody), mode: "0644" },
    ],
  }, null, 2)}\n`;
  const prefix = `${root}/`;
  const artifactStat = await lstat(bundle.artifactPath, { bigint: true });
  const entries: TarEntry[] = [
    {
      name: `${prefix}${manifest.artifact.file}`,
      mode: 0o755,
      bytes: manifest.artifact.bytes,
      chunks: () => createReadStream(bundle.artifactPath),
    },
    bufferEntry(`${prefix}${manifest.artifact.file}.release.json`, manifestBody, 0o644),
    bufferEntry(`${prefix}${manifest.artifact.file}.sha256`, checksumBody, 0o644),
    bufferEntry(`${prefix}bundle.json`, contentManifest, 0o644),
    bufferEntry(`${prefix}install.sh`, posix, 0o755),
    bufferEntry(`${prefix}install.ps1`, powershell, 0o644),
    bufferEntry(`${prefix}uninstall.sh`, posixUninstall, 0o755),
    bufferEntry(`${prefix}uninstall.ps1`, powershellUninstall, 0o644),
    bufferEntry(`${prefix}README.txt`, readme, 0o644),
    bufferEntry(`${prefix}LICENSE`, licenseBody, 0o644),
    bufferEntry(`${prefix}THIRD_PARTY_NOTICES.txt`, thirdPartyNoticesBody, 0o644),
  ];
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const temporary = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await pipeline(Readable.from(tarStream(entries)), createWriteStream(temporary, { flags: "wx", mode: 0o644 }));
    const after = await lstat(bundle.artifactPath, { bigint: true });
    if (
      artifactStat.dev !== after.dev ||
      artifactStat.ino !== after.ino ||
      artifactStat.size !== after.size ||
      artifactStat.mtimeNs !== after.mtimeNs ||
      await sha256File(bundle.artifactPath) !== manifest.artifact.sha256
    ) {
      throw new Error("Release artifact changed while the archive was being created");
    }
    await rename(temporary, archivePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const archiveStat = await lstat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await replaceText(checksumPath, `${archiveSha256}  ${basename(archivePath)}\n`);
  return {
    archivePath,
    checksumPath,
    archiveFile,
    archiveSha256,
    archiveBytes: archiveStat.size,
    root,
  };
}
