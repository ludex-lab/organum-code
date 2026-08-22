# Organum Code

Organum Code is a backend-neutral supervised coding runtime. It connects signed
Organum Hub messages to coding backends while keeping admission, credentials,
process lifecycle, bounded delivery, and durable handoff under a supervisor-owned
boundary.

This repository is the curated public source and release surface. Development
takes place in a private source-of-truth repository and reaches this repository
only through a reviewed, content-addressed public cut.

## Current status

The current identity is `0.1.0-preview.1` / `internal-preview`. Source and
release-installation foundations are available, but there is not yet a public
binary release. Do not treat source archives or unreviewed CI artifacts as an
installer.

When the first public preview is ready, release assets will be downloadable
without repository access, Git, Bun, Node.js, or Python. The release notes will
provide platform-specific archive names, SHA-256 checksums, provenance, and
installation instructions.

Organum Code is installed separately from the Python `organum` package. The
shared product homepage for Organum Inspector, Organum Hub, and Organum Code is
[the Organum site](https://ludex-lab.github.io/organum/).

## Build from source

Source builds require the exact Bun version in `.bun-version`.

```bash
bun install --frozen-lockfile
bun run check
bun run test:release
bun run build:bundle-local
bun run smoke:release-archive
```

These commands produce a local staging bundle; they do not publish it or assert
publisher authenticity. See:

- [preview release identity](docs/v0.1-preview-release.md)
- [offline release bundle](docs/offline-release-bundle.md)
- [installation lifecycle](docs/release-installation-lifecycle.md)
- [public cut and binary release policy](docs/public-cut-policy.md)

## License

Organum Code source in this cut is released under the [MIT License](LICENSE).
Third-party components and embedded runtimes retain their own licenses. Staged
archives include generated notices, complete pinned Bun/JavaScriptCore license
text, relinking instructions, and an exact public source-archive binding.
The unsigned 3OS staging path and exact public source/relink kit are qualified.
Public binary release still requires final distribution review and the
fail-closed signed candidate path in
[public distribution cut](docs/public-distribution-cut.md).
