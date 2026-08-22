# Protocol contract

## Provider 입력 계약

현재 launcher가 요구하는 최소 입력은 다음 세 값이다.

1. API key가 들어 있는 환경 변수
2. OpenAI-compatible base URL
3. provider가 실제로 받는 model ID

기본 protocol은 `/v1/chat/completions` 계열의 `@ai-sdk/openai-compatible`이다.
`ORGANUM_CODE_PROTOCOL=responses`이면 `@ai-sdk/openai`를 선택한다. 실제 endpoint의 protocol과 tool-call
형상은 generic conformance runner로 검증하고 provider별 demo 승격 전에 machine report를 남긴다.

API 키는 legacy OpenCode 설정에서 `{env:VARIABLE_NAME}`으로만 참조한다. v2 disk projection에는 env 이름만
기록한다. `config` 명령, `OPENCODE_CONFIG_CONTENT`, 임시 `opencode.json`에는 실제 값이 없어야 한다.

## OpenCode 설정 계약

초기 OpenCode `1.17.20` `debug config` 검증 뒤, 2026-07-19 로컬 `1.18.3` source/standalone
실행으로 다음 설정과 plugin 경계를 다시 확인했다.

- custom `@ai-sdk/openai-compatible` provider 수용
- `enabled_providers`에 custom provider 지정
- `provider/model` 기본 model과 small model 선택
- 세 primary agent와 `default_agent` 선택
- role별 permission object 수용
- `{env:NAME}` API key 치환

launcher는 global 설정을 수정하지 않는다. 실행마다 다음 환경을 child process에만 준다.

- `OPENCODE_CONFIG_DIR=<새 임시 디렉터리>`
- `OPENCODE_CONFIG_CONTENT=<생성 JSON>`
- `<OPENCODE_CONFIG_DIR>/opencode.json=<secret-free v2 호환 projection>`

## First-party plugin loading 계약

OpenCode `--pure`는 first-party local file을 포함한 모든 external plugin을 끈다. 따라서
bundled plugin이 켜진 기본 모드는 `--pure`를 전달하지 않고 다음 경계를 함께 적용한다.

- dependency-free JS source를 임시 `OPENCODE_CONFIG_DIR/plugins/`에 배치
- HOME, USERPROFILE, APPDATA, LOCALAPPDATA와 XDG config를 임시 layout으로 격리
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`로 project config/plugin discovery 차단
- 두 OpenCode config directory를 read-only로 만들어 dependency installer의 writability
  gate에서 종료
- plugin을 명시적으로 끄면 `--pure`를 다시 사용

OpenCode `1.18.3` 실제 binary에서 source와 standalone launcher가 같은 plugin marker를
생성하는 동안 project, legacy `~/.opencode`, XDG global sentinel plugin은 실행되지 않았다.
실행 중 config tree에는 package manifest, lockfile, `node_modules`가 생성되지 않았고 종료 후
임시 directory가 삭제됐다. 같은 실행에서 system hook이 root-derived fake Organum join과
agora/relay polling까지 수행했다. 상세 내용은
[`plugin-packaging.md`](./plugin-packaging.md)에 있다.

같은 config와 packaging 계약은 Bun `1.3.14` standalone binary에서도 검증했다. binary는 macOS arm64에서
OpenCode `1.18.3`의 실제 `--version` child process를 실행하고 exit code를 전달했다. 다른
운영체제의 결과는 CI 실행 전까지 검증 완료로 간주하지 않는다.

## Organum 조율 CLI 계약

2026-07-18 organum main `1e504dd`의 0.2.0 공개 계약을
[`native-harness-requirements-answers.md`](./native-harness-requirements-answers.md)에서 수신했다.
P2.1 adapter는 human-readable stdout을 파싱하지 않고 처음부터 다음 UTF-8 JSON만 소비한다.

| 명령 | JSON 결과 |
|---|---|
| `join --json` | `{cell,role,started,charter,goal,inbox,alarms}` |
| `agora read --json` | 비소비 field item 배열 |
| `agora goal --json` | cursor-independent current goal full envelope 또는 `null` |
| `relay inbox --json` | 비소비 field item 배열 |
| `agora post --json` | `{file,from_id}` |
| `relay send --json` | `{file,from_id}` |
| `session status --json` | session object 또는 `null` |

field item의 필수 shape는
`{file,from,from_id,to,topic,thread,in_reply_to,idem,ts,escalate,body}`다. adapter는 각 필드의
runtime type을 검증하며 envelope에 새 필드가 추가되는 것은 허용한다.

모든 identity-bearing 명령은 `--for <canonical-cell>`을 쓴다. 게시 가독성이 필요하면
`--from "<display label>"`을 함께 전달하지만 identity나 self-exclusion에는 사용하지 않는다. post/send
본문은 process argv가 아니라 stdin으로 보낸다. Organum subprocess 환경은 PATH/locale/temp와 저장해 둔
host HOME 계열만 재구성하며 provider API key나 다른 parent credential을 상속하지 않는다.

post/send는 다음 64자 hex를 `--idem-key`로 사용한다.

```text
sha256("organum-code/publish/v1\0" + canonicalCell + "\0" + turnID + "\0" + exactContent)
```

같은 actor의 timeout 재시도는 같은 key와 content로 순차 수행한다. 성공은 exit code만이 아니라 반환된
`file`이 안전한 envelope 파일명이고 `from_id`가 요청 identity와 같은 때에만 인정한다.

`agora read`/`relay inbox`는 비소비이므로 client-side bounding이 cursor를 전진시키지 않는다. raw JSON
subprocess cap은 4 MiB, model-facing 기본 view는 item 20개·item 2 KiB, project card 포함 전체 8 KiB다.
source domain + file로 message ID를 분리하고 system packet에 실제 포함된 ID만 stage한다. OpenCode의
successful text completion 뒤에만 root-local seen으로 승격하므로 provider 실패 전에는 숨기지 않는다.
relay file ACK는 model semantic 처리와 durable ACK를 결합하는 후속 hardening이며 아직 호출하지 않는다.

단, 현재 public view는 최근 200개 hard horizon이다. 200개를 넘는 unread를 엄밀히 무손실이라고 부를 수
없으므로, backlog 4의 pagination/`--since`는 saturation이 관측되면 correctness 요구로 승격한다.

Organum `8721171`은 backlog 5를 닫았다. `join --json.goal`은 pre-existing goal도 포함하는 최신
`topic:goal` full envelope 배열 또는 `[]`이고, `agora goal --for <cell> --json`은 같은 정본을 cursor와
무관하게 envelope 또는 `null`로 반환한다. adapter는 `file/from/from_id/topic/ts/thread/body`를 보존하고
정확히 한 건의 완전한 envelope만 R2 canonical로 분류한다. legacy `{from,body}`, partial envelope, 여러
canonical 후보는 `unverified`다. turn refresh 실패 시 마지막 canonical goal을 `stale`로 유지한다.
정확한 semantics와 acceptance test 및 소비 결과는
[`backlog-5-current-goal-contract-request.md`](./backlog-5-current-goal-contract-request.md)에 있다.

model shell에서 raw `organum` 명령은 role별 bash permission과 plugin hook으로 deny한다. 이는 행동
정책이지 Python·간접 실행을 막는 OS security boundary가 아니다. project config/plugin discovery는 계속
차단하지만 explicit `ORGANUM_CODE_PROJECT_CONTRACT`, root instruction file, package/pytest 선언에서 2 KiB
command card를 만들고 executable 존재와 Python `PYTHONPATH`를 표면화한다. 강제 격리의 정본은
[`ADR 0002`](./adr/0002-backend-neutral-supervisor-and-containment.md)다.

## P2.4 publication 계약

first-party plugin protocol 10은 Zod schema 기반 `organum_publish`와 `organum_handoff`를 model에 노출하고,
persona/workspace hub registration과 dual-source polling/semantic ACK를 추가한다.
완료된 substantive text는 root별 `output_pending`을 만들며, OpenCode child도 같은 root identity와 원래
obligation turn을 공유한다.

`organum_publish`는 Agora post 또는 addressed relay send를 실행하고 `{file,from_id}`를 검증한 durable
evidence를 반환한다. `organum_handoff`는 다음 순서를 바꾸지 않는다.

```text
post/send --idem-key → receipt 검증 → session status → session end --ship <receipt.file>
```

timeout retry는 원래 turn과 exact body/routing을 유지한다. 변경된 intent는 conflict이며, 같은 root의
동시 동일 요청은 하나의 in-flight operation으로 수렴한다. end 응답을 잃은 뒤 status가 `null`이면 이미
종료된 것으로 수렴하고 non-idempotent end를 반복하지 않는다.

지속형 TUI/`serve`에서 미게시 idle은 정확히 한 번 close-out prompt를 받고, 다음 idle은
`nonconformant` note로 닫힌다. assistant output을 자동 게시하지 않는다. OpenCode `run` one-shot은 upstream
teardown race 때문에 idle prompt delivery를 보장하지 않으며, 따라서 그 표면에서는 initial turn의 직접
handoff만 성공이다. 자세한 state/evidence는
[`p2.4-publication-state-machine.md`](./p2.4-publication-state-machine.md)에 있다.

Protocol 6은 body를 생략한 명시적 handoff도 수렴시킨다. 먼저 같은 root에서 나온 grounded ordinary-text
report를 사용하고, 없으면 성공한 declared command와 실제 read 경로만으로 evidence-only report를 만든다.
모델 reasoning은 게시하지 않으며 reproduction 또는 inspected file이 없으면 fail-closed다. shipped 뒤에는
추가 tool 실행을 terminal guard가 거부한다.

Protocol 8은 home-hub semantic admission의 exact `{file,event_id,to_id,to_epoch}` target만 actor-owned
`ORGANUM_CODE_STATE_DIR`에 기록한다. nonempty completion 뒤 record가 먼저 durable해져야 seen/ACK로 승격하며,
restart는 현재 join의 exact cell+nonempty epoch scope만 inbox보다 먼저 복구한다. body는 저장하지 않고 corrupt,
missing, mismatched epoch/state는 ACK하지 않는다. 자세한 순서와 sequential-restart 보장 한계는
[`p3.1b-restart-dedup-result.md`](./p3.1b-restart-dedup-result.md)에 있다.

Protocol 9는 OpenCode organism-cast lane을 위해 project 밖 private receipt에 root session, canonical
cell, `native-coordination-delivery/v1` 보존 카운터, publication 요약만 원자적으로 기록한다. receipt와
`ORGANUM_BENCH_OOB_LOG`/`ORGANUM_BENCH_ORIGIN`은 plugin-owned Organum adapter에는 전달되지만 OpenCode가
만드는 model shell 환경에서는 빈 값으로 덮어쓴다.

Protocol 9의 recalibration correction은 `ORGANUM_BENCH_SEED_BODY_FILE`/`_SENDER`/`_TOPIC`/`_THREAD`를
all-or-none lane 봉투로 검증해 OpenCode plugin process와 그 process가 소유한 Organum adapter까지만 전달한다.
`ORGANUM_BENCH_ORIGIN=lane`, 같은 run directory의 OOB log와 seed body, canonical sender 및 bounded
topic/thread가 필수이며 model shell에서는 OOB pair와 seed 4종 모두 빈 값이다. receipt의 `exposed_items`는
turn별 packet 노출 수의 누적합(미admit 재노출도 재계수), `admitted_items`는 nonempty completion 또는
첫 `tool.execute.before`에서 최신 staged packet 중 새로 admit된 message ID의 누적합이다. tool hook은
permission/execution보다 먼저 발생하므로 이후 거부된 tool call도 그 turn의 system packet을 모델이 소비한
증거이며, 병렬 tool call은 같은 staged packet을 한 번만 admit한다. 따라서 multi-turn gate는
`polls == prepared_turns >= 1`, `1 <= admitted_turns <= prepared_turns`, `admitted_items >= 1`,
`exposed_items >= admitted_items`를 사용하며 single-turn fixture의 `1/1/1/5/5` 등식을 일반화하지 않는다.

Protocol 10은 배포 bundle 전용 entrypoint에서 `OrganumCodePlugin` 함수 하나만 export한다. OpenCode가
module의 모든 함수 export를 각각 plugin으로 초기화하므로, source factory와 production alias가 함께
노출되어 발생하던 root join/poll 2중 실행과 publication/receipt last-writer-wins race를 차단한다.

로컬 `organum --version`은 아직 `0.1.3`을 출력하지만 위 신규 flags를 help에 노출한다. release version이
올라가기 전까지 doctor는 semver가 아니라 `--json`, `--idem-key`, 분리된 `--for`/`--from` capability를
probe한다.

## provider capability gate

실제 Upstage `solar-open2` endpoint에서 다음 core 항목은 secret-free JSON report로 통과했다.

- model listing과 exact model ID
- non-stream/stream 및 finish reason/reasoning field
- 단일 tool call, tool result 후속, streaming 14-fragment delta 조립
- invalid argument/schema recovery
- cancel/abort, client timeout, 2-way concurrency, 한국어 structured coding
- oversized output 요청의 server rejection과 약 800 KiB context 수용

실제 429/retry-after, exact context/output limit, parallel tools, 장문 edit, 계정별 retention/price는 partial
coverage다. 상세와 machine report는
[`provider-conformance-solar-open2.md`](./provider-conformance-solar-open2.md)에 있다.

위 결과와 뒤이은 `solar-pro4` 전환은 모두 당시 Upstage 실행의 역사적 provenance다.
`solar-pro4`는 인증된 `/models`, SSE text, 단일 tool call과 tool-result 후속, 설치된 OpenCode
`1.18.3` 및 Claude Code `2.1.221`의 bounded live gate를 통과했지만, 2026-08-10 결정으로 신규
provider-active 경로에서는 retired 상태다. 현재 configurator 기본값은 OpenCode Zen의 exact
`deepseek-v4-flash-free`이며 범위와 migration 경계는
[`free-api-continuation-2026-08-10.md`](./free-api-continuation-2026-08-10.md)에 기록한다.

OpenCode `1.18.3`에서 durable session admission의 `queue`, `steer`, idempotent message ID, admission과
promotion event, v2 custom provider/agent registry와 configured model execution은 loopback probe를 통과했다.
legacy `OPENCODE_CONFIG_CONTENT`와 v2 file config의 차이는 secret-free disk projection으로 닫았다. 그러나
active interrupt 뒤 provider HTTP stream cancellation은 실패한다. 따라서
[`opencode-session-api-probe.md`](./opencode-session-api-probe.md)의 전체 gate가 PASS하기 전에는 live bridge를
제품 기본 경로로 취급하지 않는다.
