# Bun source installation

This is the public preview installation channel for macOS and Windows while
native standalone signing is deferred. Organum Code itself ships no downloaded
native executable through this channel. The installed command is a small source
entrypoint executed by the user's Bun runtime.

## Prerequisite

Install Bun from its official distribution and confirm the exact supported
runtime:

```console
bun --version
1.3.14
```

## Install

The public preview is installed from its immutable Git tag:

```console
bun add --global github:ludex-lab/organum-code#v0.1.0-preview.1
organum-code --version
```

Expected output:

```text
organum-code 0.1.0-preview.1
```

If Bun reports that its global bin directory is absent from `PATH`, follow the
path instruction printed by Bun and open a new terminal. Do not download or run
an unsigned `organum-code` `.exe` or macOS standalone for this channel.

## Upgrade and uninstall

Preview upgrades are explicit and version-pinned. Remove the installed version,
then install the newly announced tag:

```console
bun remove --global organum-code
bun add --global github:ludex-lab/organum-code#NEW_VERSION_TAG
```

Uninstall removes the global source package and its command shim:

```console
bun remove --global organum-code
```

Organum Code runtime state and provider credentials are deliberately not deleted
by package uninstall. They remain under their documented user-scoped locations
so removal never guesses ownership of unrelated user data.

## Trust boundary

- Bun is the runtime and creates the platform command shim.
- `ludex-lab/organum-code` is the source authority.
- the version tag and public-cut manifest bind the installed source revision;
- no Apple Developer ID or Windows Authenticode claim is made for Organum Code;
- the signed standalone candidate workflow remains dormant until platform
  identities are deliberately provisioned.
