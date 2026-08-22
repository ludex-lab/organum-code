# Public cut 정책

## 저장소 모델

- private development source of truth: `JihoonJeong/organum-code`
- public cut target: `ludex-lab/organum-code`
- public product site: `https://ludex-lab.github.io/organum/`

두 저장소에서 독립적으로 개발하지 않는다. 변경은 private에서 만들고 검증한 뒤 whitelist export로만
public cut에 전달한다. public repo의 수정이 필요하면 먼저 private source에 반영한다.

Inspector·Hub·Code의 제품 소개와 매뉴얼 진입점은 기존 Organum 홈페이지가
공동 소유한다. Code용 GitHub Pages를 따로 만들지 않는다. 다만 Code의
source cut·GitHub Releases·issue tracker는 `ludex-lab/organum-code`에 두어 Python
패키지 `organum`과 바이너리 릴리스 주기를 분리한다.

## 라이선스

공개 source cut은 MIT License로 배포한다.

- SPDX identifier: `MIT`
- copyright: `Copyright (c) 2026 Jihoon Jeong`
- package metadata: `"license": "MIT"`

MIT는 organum-code가 직접 작성한 source와 문서에 적용한다. provider model, OpenCode, Bun runtime 및
그 밖의 third-party component의 권리까지 재허가하지 않는다.

## 공개 whitelist

초기 public cut 후보는 다음과 같다.

- `src/`
- 공개 가능한 `tests/`
- `scripts/` 중 build·smoke·public export 도구
- `package.json`, `bun.lock`, `tsconfig.json`, `.bun-version`, `.gitignore`
- `README.md`, `LICENSE`
- 사용자용 manual과 공개 architecture/protocol 문서
- public source/release CI와 cut provenance manifest

다음은 기본 비공개다.

- `HANDOFF.md`
- native-harness RFP, 플랫폼 회신 및 내부 wiring 결정 원문
- raw dogfood/eval transcript와 미공개 benchmark 결과
- provider access profile, credential, endpoint별 비공개 계약
- 내부 계획·감사·의사결정 기록
- `.organum`, `.organum-code` 및 local runtime state

export는 기본 dry-run이어야 하고 whitelist에 없는 경로를 복사하지 않는다. `--apply`도 파일 복사까지만
수행하며 public repo의 add/commit/push는 사람이 diff를 검토한 뒤 별도로 한다.

public cut의 `package.json`·`README.md`·CI는 private 개발 표면을 그대로 복사하지
않고 `packaging/public-cut/`의 전용 템플릿을 쓴다. 이로써 internal probe·회람·
benchmark 문구가 일반 사용자 표면에 우연히 노출되는 것을 막는다.

## Release gate

source cut의 MIT와 standalone executable의 재배포 의무는 별도다. Bun runtime은 MIT 외에도 정적으로
연결된 LGPL 및 여러 third-party component를 명시하므로 binary release 전 다음을 수행한다.

1. dependency와 embedded runtime license inventory 생성
2. `THIRD_PARTY_NOTICES`와 필요한 license text 포함
   - Bun 1.3.14 공식 고지는 SHA-256으로 고정한다.
   - production dependency metadata/version/license가 lock graph와 다르면
     archive 생성을 실패시킨다.
3. 각 binary archive에 완전한 JavaScriptCore LGPL v2 원문, Bun license,
   `RELINKING.md`, content-addressed `relink.json`을 포함한다. Bun/WebKit 및
   license byte가 고정값과 다르면 archive 생성을 실패시킨다.
4. public cut manifest와 정확히 같은 tracked file만 담은 deterministic source
   archive와 checksum을 생성한다. binary의 `relink.json`은 그 source archive
   이름과 exact public commit을 가리켜야 한다.
5. 공개 전 `Stage Release Artifacts` workflow에서 source와
   macOS/Linux/Windows archive, checksum, GitHub Sigstore provenance를 생성한다.
6. LGPL source/relink offer는 binary와 같은 public Release page에서 익명으로
   제공하고 최종 distribution review를 거친다.
7. artifact별 checksum, source revision, build provenance와 platform signing
   결과를 기록한다.
8. gate를 통과하지 못한 platform binary는 release하지 않음

이 문서는 법률 자문을 대신하지 않는다. dependency 또는 build 방식이 바뀌면 release마다 다시 검토한다.
