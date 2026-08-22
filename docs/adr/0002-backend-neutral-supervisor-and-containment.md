# ADR 0002: backend-neutral supervisor and mandatory containment

- Status: accepted
- Date: 2026-07-21
- Supersedes: OpenCode를 제품 정체성으로 둔 초기 아키텍처 부분
- Preserves: Organum CLI 계약, R1~R7 조율 규율, 기존 OpenCode identity mapping과 측정 자료

## Context

Organum Code의 첫 구현은 OpenCode `1.18.3` first-party plugin으로 RFP R1~R7과 P2.4/P2.5/P3.1을
검증했다. 이 구현은 조율 능력을 모델 가중치와 분리할 수 있다는 제품 명제를 실증했지만, OpenCode
permission과 plugin hook을 host security boundary로 취급할 수는 없다.

2026-07-21 현재 checkout과 설치 binary를 대상으로 다음을 직접 확인했다.

1. launcher는 선택한 provider key를 OpenCode child 환경에 전달한다.
2. plugin `shell.env` hook은 그 key를 제거하지 않으며 모델 shell의 `HOME`을 host home으로 복원한다.
3. password 없이 실행한 OpenCode `serve`는 스스로 `server is unsecured`라고 경고한다.
4. 인증 없이 session을 만든 뒤 `/session/:id/shell`을 호출해 dummy
   `ORGANUM_CODE_API_KEY`를 읽을 수 있었다. 실제 secret이나 외부 provider는 사용하지 않았다.
5. 같은 서버는 임의 public origin에는 CORS header를 주지 않았지만 `localhost`와
   `https://*.opencode.ai` origin을 허용했다. 따라서 과거의 전면 wildcard CORS는 현재 설치판에서
   재현되지 않았어도, 인증 없는 local API와 child secret exposure는 별개의 현재 문제다.
6. raw Organum/storage 차단과 role별 Bash permission은 명령 문자열과 tool hook에 의존한다. Python,
   간접 shell, 별도 executable 또는 session shell API에 대한 OS 경계가 아니다.

위 1~4는 전환 전 direct-key launcher의 재현 근거다. 현재 기본 CLI는 upstream key 대신 scoped broker
capability를 OpenCode/Claude child에 전달한다. `ORGANUM_CODE_BROKER=0`에서만 과거 direct-key 경로가
명시적으로 남아 있다. 다만 outer OS containment가 없으므로 same-user Keychain/file/process 접근과
OpenCode control-plane 문제는 여전히 이 ADR의 P0 blocker다.

현재 구현의 config 격리, project plugin 차단, read-only config sealing, share/autoupdate/models fetch
비활성화, selected-env allowlist는 공급망과 우발적 노출을 줄이는 유효한 방어다. 그러나 filesystem,
network, process, credential의 강제 격리를 대신하지 않는다.

OpenCode의 과거 unauthenticated server RCE는 `<1.0.216`에 영향을 주고 `1.0.216`에서 패치됐으므로
그 CVE 자체가 설치된 `1.18.3`에 해당한다고 주장하지 않는다. 다만 OpenCode 공식 이슈도 Bash가 같은
OS 권한을 상속하며 hard filesystem boundary가 없다는 문제를 명시한다. compaction 뒤 지시·문맥 유실
문제 또한 upstream에서 별도 개선 과제로 추적됐다.

## Decision

### Product position

Organum Code는 **OpenCode용 plugin 제품이 아니다**. 여러 코딩 하네스/TUI를 Organum의 identity,
routing, bounded context, durable publish/handoff, measurement 계약에 연결하는 backend-neutral actor
runtime이다.

OpenCode는 첫 번째이자 현재 가장 많이 검증된 adapter다. Claude Code, Codex, Pi와 이후 검증되는 다른
TUI를 같은 pool의 backend로 수용한다. backend 하나의 내부 API, prompt 형식, session DB 또는 permission
모델을 공통 계약으로 승격하지 않는다.

### Trust boundary

```text
                  trusted Organum Code supervisor
        ┌────────────────────────────────────────────────┐
        │ identity/root binding · Organum CLI adapter    │
        │ bounded goal/field · admission ledger          │
        │ publish/handoff closure · observation          │
        │ provider credential broker · backend control   │
        └───────────────┬────────────────────────────────┘
                        │ authenticated typed RPC/MCP
                        │ bounded context + receipts only
                        ▼
        ┌────────────────────────────────────────────────┐
        │ mandatory OS containment gate                  │
        │ workspace-scoped FS · protected .git           │
        │ isolated HOME/config · network allowlist       │
        │ no provider/Organum/host credential            │
        │                                                │
        │   OpenCode | Claude Code | Codex | Pi | ...    │
        │                 backend adapter                 │
        └────────────────────────────────────────────────┘
```

The supervisor, not a backend plugin, owns Organum CLI access, hub/state paths, semantic ACK state and real
provider credentials. A backend receives only its worktree, a disposable home/config, a bounded coordination
packet, typed tools and a narrow authenticated control/provider endpoint.

Containment failure is fatal. A warning followed by an unsandboxed run is not allowed in production mode.

### Backend port

Each backend adapter must translate the following backend-neutral operations without leaking backend-native
types into the coordination core.

- inspect exact backend name/version and declared capabilities
- launch/resume/stop one root session in a fixed worktree
- map root/child lineage to a stable backend root ID
- inject a bounded, sticky coordination packet at a defined turn boundary
- expose typed `publish` and terminal `handoff` operations
- observe user prompt, assistant completion, tool lifecycle, idle/end and compaction when available
- admit queued coordination input and report durable versus model-visible states separately
- request interruption and prove provider/tool cancellation before advertising live steering
- project only the minimum environment/config required by that backend

Native hooks, plugins, MCP, JSONL, JSON-RPC and RPC modes are adapter implementations, not product contracts.
A backend that cannot guarantee typed publication or stable root identity can run only in an explicitly degraded
evaluation profile; it is not production-conformant.

ACP is the preferred reusable control transport when a backend implements it. One ACP client adapter may cover
Grok Build, Gemini CLI and later conformant agents, while native adapters continue to provide interactive TUI
hooks where needed. ACP standardizes session/prompt/cancel/update transport; it does not standardize provider
security, root identity derivation, compaction semantics or durable Organum publication.

### Identity compatibility

The frozen OpenCode mapping remains unchanged:

```text
SHA-256("organum-code/opencode-root/v1" + NUL + exact OpenCode root session ID)
→ oc-<36 lowercase hex>
```

Changing this would split existing Organum field, observatory and bench attribution. New backends receive an
additive, backend-namespaced derivation contract. The exact prefix/domain for each new adapter must be frozen
with the matching Organum observation adapter before release; OpenCode identities are not migrated in place.

## Mandatory conformance gate

Every backend, including OpenCode, must pass the same machine-testable gate.

| ID | Required invariant |
|---|---|
| S1 secret | model tools and backend-exposed local APIs cannot read provider, SCM, SSH, cloud or control-plane credentials |
| S2 read | direct and indirect execution cannot read outside explicit project/runtime allow roots |
| S3 write | writes stay inside the assigned worktree; `.git`, agent config, hooks and supervisor state are read-only or absent |
| S4 network | spawned tools have no outbound network except explicitly brokered destinations; arbitrary loopback/private access is denied |
| S5 control | local HTTP/WebSocket/RPC endpoints require an unguessable capability or authenticated local transport and restrictive origins |
| S6 supply chain | project/global plugins and runtime installs/updates are disabled unless pinned and explicitly admitted |
| S7 cancellation | interrupt closes provider transport and prevents late tool/result admission |
| S8 context | root identity, current goal and publish obligation survive resume, interruption and compaction tests |
| S9 closure | substantive success requires one durable, idempotent Organum receipt and terminal handoff state |
| S10 typed product surface | the real native product path discovers and calls only the supervisor-owned bounded publication tools; output-marker parsing is not the product contract |

S1–S9 are the common security, lifecycle, continuity, and closure invariants.
S10 is the product-surface adoption gate for that contract. The gate includes
adversarial commands such as indirect Python/subprocess execution, absolute executable paths,
redirection, variable expansion, symlink traversal, control API calls and attempted network bypass. String
matching is never the pass criterion.

## Backend pool

### OpenCode — adapter 1, currently contained-fixture only

OpenCode remains useful because its plugin hooks and session API already passed the RFP coordination closure and
Solar dogfood. It does **not** pass S1/S2/S4/S5/S7 in the current Organum Code launcher. Until containment and
credential brokerage pass, do not use the adapter with a real provider key or a sensitive host/worktree.

### Claude Code — immediate operational fallback

Claude Code has interactive CLI plus stream-JSON automation, MCP custom tools, lifecycle hooks, resumable
sessions and native sandbox settings. Current official docs describe OS-enforced Bash isolation through Seatbelt
or bubblewrap, `failIfUnavailable`, filesystem/network rules and an option to disable unsandboxed retries. It is
therefore the first practical fallback adapter. It remains provider-specific and its built-in file tools have a
different boundary from sandboxed Bash, so it still runs behind the Organum Code conformance gate.

The 2026-07-21 dummy-provider spike on Claude Code `2.1.216` passed Anthropic Messages tool round-trip,
stream-JSON, a client-chosen session UUID and provider cancellation. It also proved that a model-controlled Bash
tool can observe `ANTHROPIC_API_KEY` inherited by the CLI. The direct-key launch path therefore fails S1 exactly
as designed; Claude remains first only behind the credential broker. See
[`claude-code-capability-spike.md`](../claude-code-capability-spike.md).

The 2026-07-22 `2.1.217` revalidation passed the fake-upstream tool loop inside the mandatory macOS gate and a
real `solar-open2` benchmark passed 21/21. During closure, an apostrophe-plus-backtick prompt exposed a shared
double-shell argv corruption bug. The gate now keeps the generated Seatbelt profile but executes the resolved
backend with exact argv and no shell. The provider-zero argv probe and full containment fixture pass after the fix.

### Codex — strong sandbox/control-plane reference

Codex exposes stable `exec --json` and an app-server JSON-RPC surface with streamed events and approvals. Its
local CLI applies OS-level sandboxing to spawned commands, defaults command network off, protects `.git`, and
supports authenticated app-server transports. It is a strong second adapter/reference, although its model and
authentication surface is not a generic OpenAI-compatible provider slot.

### Pi — provider-neutral adapter spike

Pi offers extensions that can replace built-in tools, `--no-builtin-tools`, RPC mode and an official example
wrapping Bash with `@anthropic-ai/sandbox-runtime`. It is the best small provider-neutral spike. Extensions and
packages themselves execute with host privileges unless the whole process is contained, so Pi does not remove
the need for this ADR's outer gate.

### Grok Build — first ACP target

Grok Build now publishes its Apache-2.0 Rust harness and supports native ACP, headless JSONL, lifecycle hooks,
MCP and custom OpenAI Chat Completions/Responses/Anthropic Messages models. That makes it a strong second Solar
Open 2 harness and the first target for a reusable ACP adapter. Its sandbox is off by default, macOS child-network
blocking is a no-op, hooks fail open, and its public tree is a periodic monorepo export. It enters only through
the same S1~S10 gate. Exact findings and the G0 spike are in
[`backend-candidate-pool.md`](../backend-candidate-pool.md).

### Deep Code CLI — direct Chat Completions candidate

Deep Code CLI is an MIT community project optimized for DeepSeek V4, not an established official DeepSeek
distribution. It accepts arbitrary OpenAI-compatible Chat Completions models, has MCP and persistent UUID
sessions, and is therefore a useful small-body Solar experiment. Its defaults enable broad permissions,
telemetry, hosted web search and npm update checks; `-p` still requires an interactive TTY, and no stable external
root/session control contract is admitted. The native launcher uses a disposable HOME, a secret-free deny-first
settings file, a broker capability in place of the upstream key and the mandatory outer gate. Actual `0.1.34`
completed a contained `solar-open2` hidden-canary Read/tool-result loop after stripping its nonstandard DeepSeek
request controls. The common S8 gate now freezes and restores a supervisor-owned `deep-...` root independently
of the CLI's internal UUID, and the common S9 gate closes an explicit handoff intent through the actual Organum
CLI. S10 adds an immutable stdio-to-authenticated-HTTP MCP bridge and proves one typed native headless
`organum_handoff`. S11 discovers one unambiguous native UUID, resumes it across a second process, and requires
the provider to observe prior native history. The named-actor CLI now owns stable Organum join/checkpoint/MCP
wiring; common supervisor presentation of every native approval remains pending. See
[`deepcode-cli-spike.md`](../deepcode-cli-spike.md).

### Later candidates

Crush is multi-provider and exposes MCP, hooks and a shared `serve` backend, but its hooks are preliminary and
its own documentation treats project config as trusted code because shell expansion can execute during load.
It can enter the pool only behind the same isolated-config and OS containment tests. Gemini CLI, Goose and other
TUI candidates are evaluated by conformance rather than brand or feature count.

## Initial containment implementation

Use `@anthropic-ai/sandbox-runtime` as the first cross-platform spike, not as an unquestioned permanent
dependency. It is Apache-2.0 and wraps arbitrary processes with Seatbelt on macOS and bubblewrap on Linux; Windows
support is currently alpha. Pin the exact package and checksum, vendor no remote install step into runtime, and
run our own escape/conformance suite. Platform release is fail-closed when the required primitive is unavailable.

The provider broker keeps the real key outside the backend environment. It issues a session-scoped capability,
fixes provider/model/base URL, enforces request and cost limits, and exposes only the transport required for
inference. The backend and its shell never receive the upstream credential. The control endpoint uses a distinct
capability and cannot be reached by arbitrary browser origins or unrelated local processes.

The first broker implementation now supports environment, explicit private dotenv and macOS Keychain sources;
fixed Chat Completions/Responses proxying; and a Claude Messages↔Chat Completions bridge. Actual Claude Code
`2.1.216` completed a fake Solar tool loop without receiving `UPSTAGE_API_KEY`. This closes direct child
environment/config disclosure, not same-user access to the original Keychain/file/process source. Full S1 still
depends on the outer OS containment gate. See [`inference-broker.md`](../inference-broker.md).

The first macOS outer-process spike now pins Sandbox Runtime `0.0.50` and passes an actual Seatbelt fixture for
workspace-only writes, direct/Python/symlink outside-read denial, `.git` and immutable-config denial, exact
broker-port networking, other-loopback/public-network denial and a temporary Keychain canary. The generated
profile required fail-closed hardening: its default Keychain Mach grants are explicitly denied and its read
section is converted from global-allow/root-deny to `deny default` plus explicit allow roots. Backend launcher
wiring remains open, especially for OpenCode whose Organum/hub/ledger ownership must first leave the plugin
process. See [`macos-containment-spike.md`](../macos-containment-spike.md).

## Consequences

- The coordination bootstrap now depends on the backend-neutral `RootSessionResolver` rather than
  `OpenCodeRootSessionResolver`. OpenCode retains its compatible parent-chain implementation; direct-root
  backends receive a separate resolver.
- `src/opencode-plugin.ts` becomes a thin adapter. Organum CLI, hub admission ledger and publication ownership
  move to the supervisor side of the boundary.
- `provider-profile.ts` remains generic input validation; each backend separately declares whether it can use a
  profile. Not every brain must run on every TUI.
- OpenCode-specific source, fixtures and identity evidence remain as adapter evidence rather than being renamed
  away.
- The existing Solar measurement remains valid evidence for the OpenCode adapter's coordination effect; it is
  not evidence that the host boundary was safe.
- Public messaging must say “multiple coding harness/TUI backends; OpenCode adapter available,” not “OpenCode
  layer” or “safe OpenCode wrapper.”

## Next implementation order

1. **Done through S10 for the exact macOS native cohort:** extract the minimum generic session topology port
   while preserving the frozen OpenCode identity, close common S1–S6 containment and S7 cancellation, then
   restore supervisor root identity, canonical goal and pending publication state into fresh backend bodies,
   require explicit intent → idempotent Organum receipt → terminal `shipped` closure, then replace the
   qualification marker with each real native product's typed MCP path.
   **Open:** reusable long-lived interactive lifecycle ownership, OpenCode re-admission, and Linux/Windows containment.
2. **Done for current Claude transport/containment gate:** Claude Code `2.1.216` direct inherited API-key
   visibility failed S1, so direct-key launch remains forbidden. The broker removes the upstream key; `2.1.217`
   now passes fake-upstream tools and actual Solar 21/21 inside shell-free outer containment.
3. **Partial:** loopback brokerage, canonical launcher projection and the macOS Seatbelt fixture pass. Actual
   Grok, Deep Code and Claude Solar loops are green. Move Organum/hub/ledger ownership
   fully to the supervisor before re-admitting OpenCode. Linux/Windows remain fail-closed and unimplemented.
4. **Partial:** the reusable ACP client and Grok Build product runner are implemented. Deep Code now passes
   common cancellation, supervisor-root continuity, and the explicit-intent S9 adapter gate after its Solar
   streamed Read loop. Its exact native headless path also passes S10 typed publication through the immutable
   bridge. Native history resume and reusable long-lived interactive lifecycle ownership are not admitted.
5. Re-admit OpenCode only inside the containment gate with random server auth and no backend-visible credential.
6. Add Gemini CLI, Pi, Codex, Goose and later candidates through ACP or their stronger native surface; compare
   outcome and containment separately.

## Primary references

- [OpenCode unauthenticated server advisory GHSA-vxw4-wv6m-9hhh](https://github.com/anomalyco/opencode/security/advisories/GHSA-vxw4-wv6m-9hhh)
- [OpenCode compaction update issue #4102](https://github.com/anomalyco/opencode/issues/4102)
- [OpenCode per-agent filesystem boundary request #5529](https://github.com/anomalyco/opencode/issues/5529)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Grok Build source](https://github.com/xai-org/grok-build)
- [Grok Build ACP/headless contract](https://docs.x.ai/build/cli/headless-scripting)
- [Agent Client Protocol registry](https://agentclientprotocol.com/get-started/registry)
- [Pi extension examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md)
- [Pi sandbox extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
