# Offline release bundle

Status: deterministic local archive and runtime-free initial bootstrap implemented
for the `0.1.0-preview.1` internal preview on 2026-08-22. No archive is uploaded,
published, signed, notarized, or presented as a public release.

## Archive identity

```text
organum-code-v<version>-<platform>-<arch>.tar
organum-code-v<version>-<platform>-<arch>.tar.sha256
```

The uncompressed USTAR archive is used uniformly on macOS, Linux, and Windows
for this preview foundation. It avoids platform-dependent compression metadata
and is byte-deterministic for identical input files. The root directory and all
entry metadata are frozen; timestamps, uid/gid variation, and absolute build
paths are omitted.

Build an archive only from a clean source commit:

```bash
bun run build:bundle-local
```

The generator requires the release manifest commit to equal `HEAD`. It emits an
external archive checksum but performs no network or publication operation.

## Archive contents

Every archive has one rooted directory containing:

```text
organum-code[.exe]
organum-code[.exe].release.json
organum-code[.exe].sha256
bundle.json
install.sh
install.ps1
README.txt
```

`bundle.json` is `organum-code/release-archive/v1`. It binds the release
identity and digest, size, and mode of every payload other than itself. The
adjacent archive checksum binds the final tar bytes.

## Runtime-free initial installation

After independently verifying the archive checksum and extracting with `tar`,
choose one explicit absolute prefix:

```bash
./install.sh /absolute/install/prefix
```

or in PowerShell:

```powershell
./install.ps1 C:\absolute\install\prefix
```

Both scripts contain no Bun, Node.js, package-manager, network, shell-profile,
or privilege-escalation step. They run the bundled standalone executable's
`release install` command. That command reuses the strict manifest/checksum,
host target, non-symlink, unmanaged-path, and content-addressed install-ledger
checks described in
[`release-installation-lifecycle.md`](./release-installation-lifecycle.md).

CI generates and extracts the archive on macOS, Ubuntu, and Windows, invokes the
native bootstrap for that OS, runs the installed executable, and verifies its
managed status. Source tests independently assert tar determinism and the exact
rooted entry list.

## Remaining distribution gates

This slice establishes offline packaging integrity, not authenticity or public
availability. The following remain outside it:

- LGPL object/relink obligations for the self-contained Bun executable;
- a trusted public checksum delivery channel (staged artifacts already receive
  GitHub Sigstore build provenance);
- macOS signing/notarization and Windows signing;
- compressed/native platform packages and shell `PATH` integration;
- public download, upgrade bootstrap, forced-interruption recovery, and release
  rollback operations;
- retained multi-architecture artifacts and reproducibility comparison across
  independent builders.

Until those gates close, the tar is an internal CI/staging artifact only.
