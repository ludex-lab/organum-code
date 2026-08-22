# Runtime verification matrix

Runtime choice is accepted by ADR 0001, but Organum Code is not production-ready until the remaining
platform and release gates pass.

## Local evidence — 2026-07-21, updated 2026-08-07

| Gate | Environment | Result |
|---|---|---|
| Bun version pin | Bun 1.3.14 | pass |
| Dependency lock | text `bun.lock` | pass |
| TypeScript check | Bun 1.3.14 + TypeScript | pass |
| Bun-native unit tests | Bun 1.3.14, 81 isolated source files / 610 tests | pass |
| Node compatibility | Node 22.16.0, all 81 compiled files / 610 tests | pass |
| Standalone compile | macOS arm64 | pass |
| Standalone CLI entrypoint | `organum-code --help` | pass |
| OpenCode subprocess | OpenCode 1.18.3 `--version` | pass |
| Generated config acceptance | OpenCode 1.18.3 source + standalone launch | pass |
| First-party plugin load | source + standalone, OpenCode 1.18.3 | pass |
| Session-aware polling hook | fake join + agora/relay/current-goal, real Organum late-join goal recovery | pass |
| P3.1a home-hub polling | actual Organum join/send/inbox/exact ACK; cell+epoch seam fixtures | pass |
| P3.1b restart dedup | actor ledger persist → simulated process restart → exact ACK → no reinjection; actual Organum | pass |
| P2.4 real Organum closure | temp project, post receipt → status → end/ship | pass |
| P2.4 OpenCode lifecycle | source + standalone `serve`, private text → idle reminder → tool → ship | pass |
| Measurement replay | exact Warren/Organum commits; 1 Solar run; harness 11/11 + joined observatory snapshot | pass; Organum `e850799` identity join verified |
| Solar Open 2 provider core | real endpoint, model/stream/tool/follow-up/delta/recovery/abort/concurrency/Korean coding | pass (partial coverage) |
| Solar Pro 4 transition | exact `/models`, stream, tool/follow-up, installed OpenCode 1.18.3, Claude Code 2.1.221 | pass (bounded transition coverage) |
| OpenCode Zen free catalog | eight exact model IDs (reconciled 2026-08-19), broker/profile/config projection | provider-zero pass; DeepSeek V4 alone has live stream/tool qualification |
| OpenCode `/api` admission | 1.18.3, deterministic ID/replay/conflict, queue/steer admission+promotion | pass |
| OpenCode `/api` configured runtime | secret-free disk projection, v2 custom provider/agent registry, model execution | pass |
| OpenCode `/api` active interrupt | 1.18.3 + isolated 1.18.4/1.18.8; HTTP 204 + active state cleared, provider SSE remains open | **fail** |
| Codex C0 direct Responses | Codex CLI 0.145.0; isolated Responses custom provider → broker → local SSE fixture | pass; 1 admitted request, 0 external provider requests |
| Codex C0 Responses→Chat | exact Codex shell tool → generic bridge → local Chat fixture → tool result → final text | pass; 2 admitted requests, 0 external provider requests |
| Codex + Solar live bridge | exact Codex 0.145.0; real `solar-open2` text and `pwd` tool/result loops | pass; both exit 0, exact markers observed |
| External plugin isolation | project + legacy HOME + XDG sentinels | pass |
| Runtime plugin package install | no manifest, lockfile, or `node_modules` | pass |
| Sealed temp cleanup | SIGINT, exit 130, temp directory removed | pass |
| Binary size | macOS arm64, minified, about 61 MiB | recorded; optimization pending |

Most smoke tests use a dummy API key. The P2.4 lifecycle smoke made successful streaming text/tool
requests only to a local OpenAI-compatible fixture; no external provider or real model endpoint was called.
The session API probe likewise used only loopback transport and recorded no prompt, provider body, response, or key.
Its remaining fail reproduces unchanged on the official `1.18.4` and `1.18.8` arm64 releases and is a provider-transport
cancellation gate, not an external-provider failure. The source/issue audit and posted upstream corroboration are in
[`docs/opencode-provider-cancellation-upstream.md`](./opencode-provider-cancellation-upstream.md).
The separate Solar provider conformance runner used the real Upstage endpoint but retained no key, prompt, response
text, or raw provider body. Its exact-limit, 429, long-edit, retention, and pricing rows remain partial.

## GitHub Actions matrix — 2026-07-25

`.github/workflows/ci.yml` defines Bun-native source tests on macOS/Linux,
compiled Node compatibility tests on every OS, and Bun-owned typecheck, build,
standalone compilation, and standalone smoke on every OS.
[Run 30155577772](https://github.com/JihoonJeong/organum-code/actions/runs/30155577772)
passed the current split-source matrix on all configured operating systems:

- macOS latest — Bun source + compiled Node pass
- Ubuntu latest — Bun source + compiled Node pass
- Windows latest — compiled Node pass

The Windows gate also verifies that generated-plugin freshness is line-ending invariant, native path/PATHEXT and
cross-drive containment fixtures do not assume POSIX, and the durable hub ledger can atomically persist/recover.
The 2026-07-25 Windows 2025 runner image exposed a Bun `1.3.14`
`node:test` discovery defect: independently imported source modules were
reported as `test() inside another test()` before most tests executed. This is
not treated as product evidence. The Windows lane now compiles first and runs
the same complete test list through Node 22; Bun still performs dependency
installation, generated-plugin/type checking, compilation, standalone build,
and standalone smoke there. macOS and Ubuntu retain both Bun-source and
compiled-Node suites.

The 2026-08-07 local correction replaces Bun's whole-directory discovery with
one process per source test file, preventing cross-file loopback-port and
`node:test` discovery interference. The compiled Node runner now derives its
manifest from every `tests/*.test.ts` file, rejects missing or stale compiled
counterparts, and runs all 81 files. Build also copies test fixtures into
`dist/tests/fixtures`; this closes the previous compiled-suite fixture gap.
The first feature-branch CI run made the newly included cases observable:
Ubuntu passed; macOS exceeded Bun's implicit five-second per-test timeout on a
valid lost-response retry; Windows exposed unsupported directory `fsync`,
POSIX-shebang fixtures, and POSIX-fixed path assertions. The follow-up keeps
file `fsync` plus atomic rename, omits only unsupported Windows directory sync,
uses a bounded 30-second source-test timeout, resolves platform paths, and
marks the two shebang-only fixtures skipped on Windows. The next branch run
passed macOS and Ubuntu; all eight remaining Windows failures came from the two
equivalent parent-directory sync sites in the subprocess adapter CLI. Those
sites now use the same Windows-only omission while retaining file sync and
atomic rename/link. Consult the branch run history for the final remote
conclusion.

The merged main run `31182156789` then reproduced a Bun/Linux-only provider-zero
subprocess timeout. Early corrections around broker port allocation and local
HTTP pooling appeared locally stable, but independent PR runs moved the timeout
between different fault cases. A CI-only stage trace plus a rerun of PR run
`31185492154` finally failed synchronously in Bun's `node:child_process.spawn`
compatibility path, before the child entered the supervisor CLI. The earlier
product-runtime changes were therefore reverted. Source tests now invoke Bun
children through native `Bun.spawn`, pass canonical control input directly,
and expose the private frame stream as raw FD 3 from a mode-0600 temporary file
that is removed after the child exits. The compiled Node suite retains
`node:child_process.spawn`. This isolates the runtime-specific harness boundary
without changing broker startup, fetch behavior, provider-attempt semantics,
or production evidence rules. Remote qualification of the final correction is
recorded on its PR rather than inferred from the earlier green attempts.

The privileged symlink fixture is registered only on non-Windows runners; the
implementation uses the same `lstat` rejection on Windows, but privileged Windows symlink behavior remains an
unverified release gate. Passing one default runner per operating system does not establish support for every CPU
architecture.

## Production release gates still pending

`0.1.0-preview.1` local standalone identity and clean-commit SHA-256 manifest
generation are implemented and exercised in the three-OS CI matrix. This is
artifact-integrity plumbing only; CI does not retain, sign, or publish release
artifacts.

The same matrix now installs each verified bundle into an isolated absolute
prefix, runs the installed binary, verifies status, and uninstalls it. Source
tests cover upgrade, one-step rollback, byte/version rebinding refusal, and
tamper-closed removal. This remains a local staging lifecycle rather than an
end-user installer or auto-update path.

CI also builds one deterministic platform-named USTAR archive, verifies its
external SHA-256, extracts it, and performs initial installation through
`install.sh` on POSIX or `install.ps1` on Windows. Those bootstraps execute only
the bundled standalone and require no Bun/Node runtime.

- Linux x64/arm64 and musl runtime smoke tests
- macOS x64 and arm64 release artifacts
- Windows x64 and arm64 release artifacts
- older x64 baseline CPU decision
- macOS signing, notarization, and Bun JIT entitlement verification
- Windows code signing
- retained multi-platform checksum/provenance set and reproducibility comparison
- compressed/native platform packages and public installer delivery
- forced-process-interruption recovery for install-state transitions
- long-running signal, cancellation, crash, and temporary-state tests
- actual provider exact limits, 429/retry-after, long-edit quality, and account-policy confirmation
- Windows permission semantics for sealed config directories
- OpenCode compatibility pin and startup capability failure mode
