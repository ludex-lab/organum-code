# Standalone release installation lifecycle

Status: explicit local-prefix lifecycle implemented for the
`0.1.0-preview.1` internal preview on 2026-08-22. This is staging and CI
infrastructure, not a public installer, auto-updater, signing claim, or release
publication path.

## Managed layout

For an operator-selected absolute prefix, the manager owns only these paths:

```text
<prefix>/bin/organum-code[.exe]
<prefix>/lib/organum-code/install-state.json
<prefix>/lib/organum-code/releases/<version>--<sha256>/organum-code[.exe]
```

The install state is a bounded `organum-code/install-state/v1` ledger. It binds
the active and immediately previous release to version, clean source commit,
canonical Bun runtime, platform, architecture, byte length, and SHA-256. Release
directories are content-addressed by the full artifact digest.

The manager never edits Organum Code user configuration, provider-key
references, project files, shell profiles, or other files in the prefix.
Uninstall removes only files registered in a valid state ledger and leaves the
prefix itself in place.

## Explicit local operations

First create a clean-commit bundle:

```bash
bun run build:release-local
```

Then use an absolute staging prefix:

```bash
bun ./scripts/manage-release-installation.ts install \
  --prefix /absolute/staging/prefix \
  --artifact ./dist/organum-code \
  --manifest ./dist/organum-code.release.json \
  --checksum ./dist/organum-code.sha256

bun ./scripts/manage-release-installation.ts status \
  --prefix /absolute/staging/prefix

bun ./scripts/manage-release-installation.ts upgrade \
  --prefix /absolute/staging/prefix \
  --artifact /path/to/new/organum-code \
  --manifest /path/to/new/organum-code.release.json \
  --checksum /path/to/new/organum-code.sha256

bun ./scripts/manage-release-installation.ts rollback \
  --prefix /absolute/staging/prefix

bun ./scripts/manage-release-installation.ts uninstall \
  --prefix /absolute/staging/prefix
```

Windows uses the same contract with `organum-code.exe` and an absolute Windows
prefix. The offline archive carries bundle-local `uninstall.sh` and
`uninstall.ps1` entrypoints, so removal does not require Bun or the source tree.
On Windows the helper deliberately invokes the executable retained in the
extracted bundle rather than the installed executable: this avoids asking a
running Windows image to delete itself. Keep the extracted bundle, or
re-download the exact platform bundle, until removal is complete. CI exercises
install, installed-binary `--version`, status, bundle-local uninstall, managed
file absence, and unrelated-prefix preservation on the default macOS, Ubuntu,
and Windows runners. Isolated source tests additionally exercise upgrade and
one-step rollback.

## Fail-closed boundaries

Before activation, the manager requires:

- the exact known manifest schema, product, internal-preview channel, and Bun
  version;
- a full clean source commit and valid semantic version;
- host platform and architecture equality;
- the platform-specific artifact basename, byte length, executable bit on
  Unix, checksum file, and independently recomputed SHA-256;
- regular non-symlink metadata, artifact, install-state, and managed
  directories;
- no unmanaged executable or nonempty unmanaged product root on first install.

An upgrade cannot bind one semantic version to different bytes. Status and all
mutating operations verify the active executable against the ledger. Rollback
swaps the active and previous content-addressed releases. If managed bytes or
state drift, the operation stops instead of overwriting or deleting them.

This provides artifact integrity, not publisher authenticity. Signed manifests,
forced-process-interruption recovery, code signing, notarization, compressed
native packages, and public release delivery remain separate gates. The manager
performs no network request and never enables runtime auto-update.

The standalone product exposes the bounded distribution lifecycle subset as
`organum-code release install|status|uninstall`. The offline POSIX and
PowerShell bootstraps use that path, so end users do not need Bun for initial
installation or removal. Upgrade and rollback remain source/operator-only.
Archive construction and its remaining gates are defined in
[`offline-release-bundle.md`](./offline-release-bundle.md).
