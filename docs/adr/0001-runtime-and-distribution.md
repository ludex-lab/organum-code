# ADR 0001: Runtime and distribution

- Status: Accepted
- Date: 2026-07-17

## Context

Organum Code must provide an OpenCode-native plugin, a provider/config launcher, and later an
optional live bridge. It should reach production without requiring users to assemble a JavaScript
runtime, while keeping Organum's Python implementation and Grok Build's Rust implementation behind
public process or HTTP contracts.

The first spike used TypeScript compiled with `tsc` and executed on Node.js. That established the
configuration contract but did not decide the production runtime or release format.

OpenCode develops and packages with Bun, loads JavaScript/TypeScript plugins inside its Bun runtime,
and distributes a standalone executable. Bun can compile TypeScript into standalone executables for
macOS, Linux, and Windows.

## Decision

1. TypeScript is the primary implementation language for Organum Code.
2. Bun `1.3.14` is the pinned canonical development, test, build, and release runtime.
   `.bun-version`, `packageManager`, and the executable runtime guard must agree exactly.
3. Production CLI releases are standalone Bun executables. End users do not need Bun or Node.js.
4. The OpenCode plugin is TypeScript executed by OpenCode's embedded Bun runtime. Plugin code must
   remain compatible with Bun `1.3.11` until the supported OpenCode range moves past it.
5. Shared code uses standards and Node-compatible APIs where practical. Node.js 20+ remains a
   temporary compatibility test, not a production runtime dependency.
6. Runtime package installation is forbidden in the product launch path. First-party plugin,
   profiles, and prompts will be pinned build inputs or embedded assets.
7. Organum is consumed only through its public CLI, HTTP, and event contracts. Its Python modules and
   SQLite files are not imported.
8. Grok Build remains an external Rust host and reference implementation. Its internal crates are not
   linked.
9. Rust will be reconsidered only if Organum Code starts owning a durable daemon, a security boundary,
   or measured concurrency/process-supervision workloads that Bun cannot satisfy reliably.

## Production gates

- Bun and dependency lock versions are exact and reproducible.
- Bun-native tests and Node compatibility tests both pass during the transition.
- A standalone executable can launch, validate configuration, supervise OpenCode, propagate exit
  status, and clean temporary state.
- CI covers macOS, Linux, and Windows. Release CI must additionally cover supported CPU architectures.
- Release binaries have checksums; macOS and Windows binaries are signed before public distribution.
- No API key is serialized into configuration, reports, logs, or binary assets.
- The product performs no package-manager or auto-update network operation at runtime.

## Consequences

The launcher and plugin can share TypeScript contracts and release as a self-contained product. We
accept Bun runtime and code-signing behavior as production dependencies and must test them explicitly.
We avoid the cost of a Rust/TypeScript FFI or sidecar split while the durable source of truth remains
in Organum rather than Organum Code.

Node compatibility may be removed after the standalone Bun distribution and OpenCode plugin path have
been stable across the supported platform matrix. A change to Rust or another runtime requires a new
ADR and evidence from the production gates above.

## References

- [Bun standalone executable documentation](https://bun.sh/docs/bundler/executables)
- [Bun Node.js compatibility status](https://bun.sh/docs/runtime/nodejs-compat)
- [OpenCode development and standalone build](https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md)
- [OpenCode plugin runtime](https://opencode.ai/docs/plugins/)
