# 구현 아키텍처

> **2026-07-21 accepted direction:** Organum Code는 backend-neutral supervisor이며 OpenCode는 첫
> adapter다. 조율/credential/ledger를 supervisor가 소유하고 모든 TUI backend를 mandatory OS
> containment 뒤에 둔다. 현재 OpenCode launcher는 P0 secret/control-plane gate를 통과하지 못했다.
> 아래 “현재 구현”은 이미 검증된 adapter의 현상 기술이지 목표 trust boundary가 아니다. 결정과
> conformance는 [`ADR 0002`](./adr/0002-backend-neutral-supervisor-and-containment.md)를 따른다.

## 목표 trust boundary

```text
trusted supervisor
  ├─ Organum identity/poll/admission/publication
  ├─ provider credential broker
  └─ authenticated bounded backend port
                  │
                  ▼
mandatory OS containment
  └─ native adapter or ACP client adapter
       └─ OpenCode | Claude Code | Grok Build | Gemini CLI | Pi | other
       isolated HOME/config, scoped worktree, protected .git,
       no raw secret/Organum state, brokered network only
```

Backend adapter는 root lineage, turn-boundary context injection, typed publish/handoff, lifecycle events,
resume/interrupt를 번역한다. plugin, MCP, JSONL, JSON-RPC, hooks, RPC는 backend별 구현 세부다. 기존
OpenCode `oc-...` identity는 관측 join을 보존하기 위해 변경하지 않으며 새 backend는 별도 frozen
namespace를 추가한다.

ACP를 구현한 backend에는 reusable stdio JSON-RPC client adapter를 우선한다. 현재 공통 ACP v1 transport와
initialize/session new·load/prompt/cancel/update 계약을 구현했다. 실제 Grok Build `0.2.111`에서
provider request 0의 initialize→new→same-ID load와 fake-provider prompt→update→cancel→provider abort,
brokered Solar Open 2의 title+main 실호출이 통과했다. client-provided MCP는 공통 control seam이지만,
Grok ACP에서는 supervisor-owned authenticated loopback MCP로 bounded context와
`organum_publish`/`organum_handoff`를 연결했다. 실제 `0.2.111` provider-zero 프로세스가 MCP
initialize/list→`search_tool` discovery→`use_tool` handoff→publish/status/end를 거쳐 `shipped`로 닫혔다.
ACP permission은 별도 supervisor broker가 exact bound session, active turn, qualified Organum tool과
공통 publication parser를 다시 검증한 뒤에만 terminal presenter로 보낸다. presenter는
`allow_once`/deny만 제공하며 noninteractive·malformed·concurrent 요청은 fail-closed한다.
승인된 exact operation+payload는 in-memory one-shot grant가 되고 MCP wrapper가 publication 전에
소비한다. 권한 요청을 생략한 direct MCP call, payload substitution과 replay는 Organum에 닿기 전에 막힌다.
`organum-code grok acp "<prompt>"`는 이 구성요소와 broker, contained Grok process, Organum adapter,
timeout/signal cleanup을 한 supervisor lifecycle로 소유한다. exit 0은 `end_turn`과 durable `shipped`가
함께 성립할 때만 허용한다. interactive TUI hook, provider credential, compaction 규율과 다른 backend identity는 여전히
별도 capability다. Claude direct adapter 뒤 Grok Build를 첫 ACP target으로 검증하는 근거는
[`backend-candidate-pool.md`](./backend-candidate-pool.md)에 있으며 현재 범위와 열린 gate는
[`acp-client-spike.md`](./acp-client-spike.md), 권한 계약은
[`acp-permission-policy.md`](./acp-permission-policy.md)에 있다.

Grok ACP는 workspace 밖 private actor runtime의 `sessions/`를 process restart 사이에 보존한다. config는
launch 직전에 secret-free 내용으로 원자 교체하고 process 동안 immutable이며, exact runtime은 single-owner
lock으로 동시 실행을 fail-closed한다. actual restart/load/history replay 통과 뒤 Grok identity를
`grok-` + `SHA-256("organum-code/grok-acp-root/v1" + NUL + exact session ID)` 앞 35 hex로 동결했다.
`--actor`/`ORGANUM_CODE_ACTOR`가 있으면 supervisor가 workspace fingerprint×profile×backend×actor별
private runtime을 자동 할당한다. profile은 launch policy이고 actor는 restart handle이므로 서로 독립이다.
actor를 생략한 일반 launch는 계속 ephemeral이다.
hub persona가 있는 ACP run은 restart-safe semantic ACK를 위해 named actor를 필수로 하며 ledger는 backend
runtime의 sibling supervisor scope에 둔다. runtime의 backend/workspace binding이 현재 run과 다르면 launch
전에 fail-closed한다.
ACP handoff 뒤 `shipped`/`nonconformant` root는 terminal이며, 후속 작업은 새 ACP session을 요구한다.
이전 durable receipt가 새 turn의 성공 증거로 재사용되지는 않는다.

현재 first-run configurator는 provider/model/secret reference/default backend를 사용자 config에 저장하고,
설치된 Claude Code·OpenCode·Grok Build를 탐지·선택한다. API key 값은 config에 저장하지 않는다. 상세는
[`first-run-configurator.md`](./first-run-configurator.md)에 있다.

현재 broker는 환경변수·macOS Keychain·workspace 밖 private dotenv를 supervisor-only source로 읽고,
backend에는 random loopback capability만 투영한다. OpenCode/Grok 계열은 Chat Completions/Responses를,
Claude Code는 Messages↔Chat Completions 변환을 사용한다. 실제 Claude fake-Solar tool loop에서 upstream
env key 비노출은 통과했다. 다만 source 파일/Keychain에 대한 same-user 직접 접근은 OS containment가
막아야 하므로 전체 S1 완료로 간주하지 않는다. 상세는
[`inference-broker.md`](./inference-broker.md)를 따른다.

## 현재 구현

```text
provider API key (env / Keychain / private dotenv)
        + base URL + exact model ID
                    │
                    ▼
        supervisor-only secret loader
                    │
                    ▼
 authenticated fixed-model loopback broker
                    │ scoped capability only
                    │
                    ▼
       backend-specific provider projection
   OpenCode native | Claude Messages bridge
                    │
                    ▼
      sealed temporary config directory
         + embedded first-party plugin
                    │
                    ▼
       isolated backend HOME/config process
                    │ first provider turn
                    ▼
       exact root session → canonical cell
                    │ join --json once/root
                    ▼
       bounded sticky system context (≤8 KiB)
                    │ substantive completion
                    ▼
    durable hub semantic-admission ledger
       exact cell + epoch + event target
                    │ ACK/restart recovery
                    ▼
      root publish/handoff state machine
        idem receipt → status → end --ship
```

`src/actor-runtime.ts`는 user-state root 아래에 workspace fingerprint, profile, backend, actor로 scope된
private runtime과 secret-free binding을 만든다. 같은 binding은 process restart에서 같은 경로로 수렴하고,
같은 cwd의 다른 actor/profile은 분리된다. workspace 내부 state, symlink, group/other-readable path,
binding 변조는 fail-closed다. persistent Grok launcher의 exclusive owner lock이 실제 동시 process를
직렬화한다.

`src/provider-profile.ts`는 provider metadata를 정규화하고 `src/provider-secret.ts`는 환경변수,
명시적 private dotenv 또는 macOS Keychain에서 키를 supervisor memory로 읽는다. 키 값은 profile이나
생성 설정에 저장하지 않는다. `src/inference-broker.ts`는 fixed destination/model/limits와 random session
capability를 제공하고 실제 upstream auth는 outbound request에만 붙인다. OpenCode와 Claude child에는
upstream key 대신 capability만 전달된다. 그러나 same-user backend가 원본 Keychain/file/process를 직접
읽는 경로는 outer OS sandbox 전까지 미검증이다.

`src/opencode-config.ts`는 OpenAI-compatible provider와 세 primary role을 생성한다. model과
role은 독립적으로 결합하며, 같은 brain을 implementer·reviewer·researcher 어느 역할로도
실행할 수 있다.

`scripts/build-first-party-plugin.ts`는 실제 identity/CLI/bootstrap/context 모듈과
`src/opencode-plugin-entry.ts`를 외부 package import가 없는 단일 JS artifact로 bundle한다. 배포
entrypoint는 OpenCode가 초기화할 함수 export를 정확히 하나로 제한한다.
`src/plugin-package.ts`는 생성 artifact를 executable 안에 포함하고 실행마다 임시
`OPENCODE_CONFIG_DIR/plugins/organum-code.js`로 푼다. config layout을
완성한 뒤 OpenCode가 찾는 config directory를 read-only로 봉인한다. OpenCode `v1.18.3`의
dependency installer는 directory가 writable하지 않으면 즉시 반환하므로 runtime package
install이 발생하지 않는다.

`src/opencode-launcher.ts`는 legacy 설정을 `OPENCODE_CONFIG_CONTENT`로, v2 설정을 secret-free
`OPENCODE_CONFIG_DIR/opencode.json`으로 함께 주입한다. `--pure`는 모든 external plugin을 끄므로 bundled
plugin이 켜진 기본 모드에서는 사용하지 않는다. 대신
isolated HOME/XDG config와 `OPENCODE_DISABLE_PROJECT_CONFIG=1`을 사용해 user global/project
plugin discovery를 차단한다. child 종료 전 권한을 복원하고 임시 디렉터리를 제거한다. 부모
shell의 credential 확산을 줄이기 위해 기본 시스템 환경, broker token,
사용자가 명시적으로 allowlist한 변수만 child에 전달한다. unsafe `ORGANUM_CODE_BROKER=0` 호환 모드에서만
선택 provider key가 직접 전달된다. 복원된 host `HOME`과 same-user 파일 접근은 아직 강제 격리되지 않는다.

plugin의 `experimental.chat.system.transform` hook은 session이 있는 provider turn마다 exact parent chain을
해석한다. root당 `join --json`은 한 번으로 수렴하고, 동일 root의 child는 같은 canonical cell을 쓴다.
charter, goal 상태, onboarding inbox, actor/presence health는 UTF-8 기준 hard cap 8 KiB의 sticky system
block으로 주입한다. root lookup이나 join 계약이 실패하면 provider turn도 fail-closed다. session ID가 없는
OpenCode 내부 agent-generation hook은 가짜 peer를 만들지 않고 건너뛴다.

`src/organum-identity.ts`와 `src/organum-cli.ts`에는 Phase 2의 source-side 기반이 있다. 전자는 정확한
OpenCode root session ID를 39자 canonical Organum cell로 mapping하고 publish idempotency key를 만든다.
후자는 organum 0.2.0의 JSON join/read/status/post/send 계약을 runtime 검증하며 typed subprocess,
canonical `--for`, optional display `--from`, bounded read view를 제공한다. hub opt-in join의 additive
persona/workspace/nonempty registration epoch echo도 fail-closed로 검증한다.

`src/opencode-session.ts`는 OpenCode `context.sessionID`에서 `parentID` chain을 따라 exact root를 찾는다.
directory별 성공 cache를 두되 cycle, depth overflow, mismatched lookup, cancellation은 실패로 처리한다.
`src/coordination-bootstrap.ts`는 root별 join을 한 번으로 수렴시키고 child가 같은 cell을 공유하게 한다.
join 실패는 재시도할 수 있지만 같은 root의 role/persona/workspace 선언 변경은 conflict다. 현재 platform의
summary-only goal이나 goal 부재는 canonical로 추정하지 않고 `degraded`로 표시한다. Organum `8721171`의
full `file/from/from_id/topic/ts/thread/body` envelope는 정확히 한 건일 때만 R2 `ready`로 판정한다.

`src/coordination-polling.ts`는 provider turn마다 non-consuming agora/relay JSON view, persona registration이
있는 경우 bounded home-hub inbox page, cursor-independent `agora goal --json`을 병렬로 읽고 source domain을
포함한 deterministic message ID를 만든다. hub delivery는 join echo의 exact cell+epoch를 전달 직전에 다시
검증하고 `home-hub:event_id`로 local namespace와 분리한다. current goal은
플랫폼의 `(ts, mtime, file)` 결정을 그대로 소비하며 field 파일명으로 재추정하지 않는다. 실패한 source는
last-known snapshot을 `stale`로 유지하며 다음 turn에 재시도한다. system packet에 실제 포함된 ID만 stage하고
nonempty `experimental.text.complete` 뒤에만 root-local seen으로 승격하므로 provider 실패 전에 메시지를 잃지
않는다. hub item은 이 semantic admission 뒤에만 exact file/event/cell/epoch ACK하며, 일시 실패는 다음 poll
전에 재시도한다. `src/hub-admission-ledger.ts`는 ACK 전에 body 없는 최소 target metadata를 actor-owned state에
원자적으로 설치한다. 새 plugin process는 현재 cell+epoch record를 hub inbox보다 먼저 복구해 seen/pending ACK를
재구성하므로 ACK-failure restart에서 같은 event를 model에 재주입하지 않는다. corrupt/missing state는 hub를
fail-closed하며 다른 local source는 계속 poll한다. 정확한 보장 범위는
[`p3.1b-restart-dedup-result.md`](./p3.1b-restart-dedup-result.md)에 있다.
200개 public horizon 도달은 backlog 4 correctness blocker로 prompt health에 표시한다.

`src/coordination-context.ts`는 field를 direct → active thread → goal → recency 순으로 최대 20개,
item 2 KiB, project card를 포함한 전체 system block 8 KiB 안에 넣고 원본 envelope ID와
truncation/omission을 남긴다. `src/project-contract.ts`는 명시적 project contract를 최우선으로, 아니면
root `AGENTS.md`/`CONTRACT.md`/`CLAUDE.md`와 package/pytest 선언을 안전하게 읽는다. command executable과
`PYTHONPATH`를 확인한 2 KiB card를 주입한다. model shell의 raw `organum` 명령은 role permission에서 deny다.
summary-only/partial/multiple goal은 호환 경로에서 계속 `degraded/unverified`다. full envelope의
`from_id/thread`도 2 KiB goal view 안에 보존한다.

`src/coordination-publish.ts`는 substantive text를 root-scoped `output_pending` obligation으로 만들고
`organum_publish`/`organum_handoff` 호출만 durable evidence로 승격한다. publish intent는 원래 turn과 exact
body/routing에 고정되며 같은 요청의 동시 호출과 timeout retry는 하나의 Organum idem key로 수렴한다.
terminal handoff는 receipt 검증 뒤에만 status를 확인하고 `session end --ship`을 호출한다. end 응답 손실은
재시도 status가 `null`인 경우에만 이미 닫힌 것으로 조정한다.

first-party plugin은 지속형 OpenCode session의 첫 미게시 idle에 generic close-out prompt를 한 번 넣고,
다음 idle에도 receipt가 없으면 nonconformant note를 남긴다. 내용을 자동 게시하거나 무한 재프롬프트하지
않는다. OpenCode `run` one-shot은 upstream teardown race로 idle 재프롬프트를 보장하지 못하므로 강한 gate는
TUI/`serve`에 두고, one-shot 미게시 종료는 성공으로 간주하지 않는다. 상세 계약은
[`p2.4-publication-state-machine.md`](./p2.4-publication-state-machine.md)에 있다.

`src/cli.ts`는 `doctor`, secret-free `config`, OpenCode 인자 전달을 제공한다. `src/main.ts`는
Bun source 실행, `tsc` Node 호환 build, standalone Bun binary가 공유하는 단일 entrypoint다.

Production build는 Bun `1.3.14`로 runtime을 포함한 standalone executable을 만든다. 이는
사용자 시스템에 Bun이나 Node.js가 설치되어 있음을 전제하지 않는다. OpenCode 자체는 별도
host executable이며 Organum Code가 fork하거나 embed하지 않는다.

## OpenCode 동작 기본값

- implementer: 현재 worktree file edit 허용, 일반 shell은 ask, 일부 read/test/build 명령만
  allow, 파괴적 Git·shell과 push는 deny
- reviewer: edit deny, read-only shell 일부만 allow
- researcher: edit deny, 외부 조사와 일반 shell은 ask
- 공통: external directory deny, subagent task deny, share disabled, autoupdate disabled

이 permission은 모델 행동 유도와 approval 정책이지 security boundary가 아니다. write 가능한 여러
peer cell에는 별도 Git worktree가 필요하고, production 실행에는 ADR 0002의 OS containment와
credential broker가 추가로 필수다.

## 아직 구현하지 않은 경계

- mandatory OS containment conformance와 authenticated backend control channel
- Claude Code Organum MCP/publication adapter와 Grok ACP의 real-Solar product replay
- same-user Keychain/dotenv/supervisor-process 접근 차단
- OpenCode password 없는 local session API 차단과 broker-only network
- provider exact limits/실제 429/장문 edit 및 account-policy coverage 확장
- OpenCode `/api/session/:id/interrupt` provider-transport cancellation 해소
- model-facing bounded drill-down tools와 local relay semantic ACK
- same-binding concurrent process owner lease/lock과 old-epoch actor-ledger GC
- Organum relay/home-hub에서 OpenCode active session으로 전달하는 live bridge

OpenCode `1.18.3`의 legacy/v2 config consumer 차이는 secret-free disk projection으로 닫혔고, v2 registry와
configured model execution도 통과했다. 그러나 active interrupt 뒤 provider SSE connection이 닫히지 않는다.
live bridge는 이 transport seam이 닫히기 전까지 제품 기본 경로가 아니다. 상세는
[`opencode-session-api-probe.md`](./opencode-session-api-probe.md)에 있다.

실제 Solar Open 2 endpoint의 non-stream/stream/tool/follow-up/delta/recovery/abort/concurrency/한국어 coding
core conformance는 통과했다. provider 쪽 남은 partial coverage는
[`provider-conformance-solar-open2.md`](./provider-conformance-solar-open2.md)에 기록한다.

이 기능들은 [`HANDOFF.md`](../HANDOFF.md)의 Phase 0~3 순서대로 추가한다. Organum 내부 Python
모듈이나 SQLite에는 직접 결합하지 않는다. Packaging의 상세 evidence와 남은 platform gate는
[`plugin-packaging.md`](./plugin-packaging.md)에 있다.
