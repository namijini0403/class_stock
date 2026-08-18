# 국내 주식 전용·1시간 시세 확인 전환 계획

## 0. 스펙

- **목적**: 기존 Postgres/JWT 기반 온라인 학생 계정 구조를 유지하면서, 거래 가능 시장을 국내 주식으로 한정하고 금융위원회 공공데이터를 1시간마다 확인한다.
- **범위 밖**: 학교 서버 배포 설정 변경, 학생 인증·Postgres 스키마 변경, 학생 상태 형식 변경, 새로운 시세 공급자 추가.
- **제약**: 학생 상태의 정본은 Postgres JSONB이며 기존 인증·거래 트랜잭션·교사 관리 기능을 보존한다. npm 의존성은 `pg` 하나만 유지한다. 비밀키·학생 데이터는 커밋과 배포 ZIP에서 제외한다.
- **성공 기준**:
  - 종목 목록과 검색 결과에 국내 종목만 존재한다.
  - 미국 종목·IEX HIST·USD/KRW 환율 API와 UI가 노출되지 않는다.
  - 공공데이터 확인 주기와 런타임 상태가 환경값과 무관하게 `3,600,000ms`로 고정된다.
  - 기존 인증·Postgres 관련 검증 게이트가 그대로 통과한다.
  - GitHub 원격 최신 `main`의 서버 저장 기능을 보존한 채 fast-forward 푸시된다.
  - 최종 커밋의 추적 파일만 담은 ZIP에 비밀정보·학생 데이터·런타임 캐시가 없다.

## 1. 현황 조사

- 원격 `main`은 로컬 최초 작업 기준보다 16개 커밋 앞서 있으며, Postgres JSONB 학생 상태·JWT 인증·Railway 배포가 구현돼 있다.
- 국내 시세는 이미 `lib/market-data.js`의 금융위원회 공공데이터 경로를 사용한다.
- 미국 기능은 `server.js`, `lib/market-data.js`, `lib/universe.js`, `public/app.js`, `public/index.html`, `public/teacher.js`, `public/teacher.html`, 종목 캐시, 환경 예제와 문서에 분산돼 있다.
- 기존 검증 정본은 `scripts/syntax-check.mjs`, `scripts/check-placeholders.mjs`, `scripts/smoke-auth.mjs`, `scripts/smoke-server.mjs`다.
- `.env`, 관리자 비밀번호, 공공데이터 키, Postgres 학생 데이터, 런타임 캐시는 Git 추적 대상이 아니다.

## 2. 접근

| 안 | 요지 | 장점 | 단점 |
|---|---|---|---|
| A (채택) | `origin/main` 위에 국내 전용 변경만 선별 구현 | 최신 온라인 저장·보안 기능 보존, 원격에 fast-forward 가능 | 구버전 로컬 변경을 그대로 재사용할 수 없어 재검증 필요 |
| B | 구버전 로컬 커밋을 원격에 병합 | 기존 수정 재사용 | 대규모 충돌과 Postgres/JWT 기능 회귀 위험으로 기각 |

## 3. 작업 분해

| # | 작업 | 파일 경계 | 담당 | 검증 방법 | 완료 |
|---|---|---|---|---|---|
| 1 | 국내 전용·1시간 규칙 회귀검사 추가 후 RED 확인 | `scripts/check-kr-only.mjs`, `package.json`, `CLAUDE.md` | 메인 | 기존 코드에서 예상 원인으로 실패 | ☑ |
| 2 | 서버·시세·종목 목록을 국내 전용으로 전환 | `server.js`, `lib/market-data.js`, `lib/universe.js`, `data/stock-universe.json` | 메인 | 회귀검사 GREEN, API 응답 점검 | ☑ |
| 3 | 학생·교사 화면에서 미국·환율 UI 제거 | `public/app.js`, `public/index.html`, `public/teacher.js`, `public/teacher.html`, PWA 파일 | 메인 | DOM ID 정합성·정적 참조 검사 | ☑ |
| 4 | 환경·운영·결정 문서 갱신 | `.env.example`, `README.md`, `CLAUDE.md`, `docs/decisions-log.md`, 본 계획서 | 메인 | 플레이스홀더·문서 내용 점검 | ☑ |
| 5 | 보안·원격·배포 ZIP 감사 | 전체 읽기, 편집 없음 | 읽기 전용 에이전트 + 메인 판정 | 비밀값 역검색, `git archive` 목록 검사 | ☑ |
| 6 | 전체 게이트·런타임 검증, 커밋·푸시·ZIP | 전체 | 메인 | CLAUDE.md §3 순서, 원격 SHA 확인 | ☐ |

## 4. 완료 정의

- [x] 국내 전용 구현 단계와 DB 없는 각 검증 통과
- [x] 구문·국내 전용·플레이스홀더·인증 게이트 통과 (`smoke-server`는 `DATABASE_URL` 부재로 건너뜀)
- [x] 실제 공공데이터 임시 조회에서 국내 2,793개·기준일·1시간 상태 확인
- [x] 문서·결정 로그·계획 상태 갱신
- [ ] GitHub `origin/main`과 로컬 최종 커밋 SHA 일치
- [ ] 최종 ZIP 내용과 SHA-256 검증 완료

## 5. 리스크·롤백

- 최신 원격 온라인 저장 기능이 구버전 코드로 되돌아갈 위험 → `origin/main` 기반 별도 통합 브랜치만 푸시하고, 구버전 수정은 로컬 백업 브랜치에 격리한다.
- 기존 미국 주식 보유 상태가 DB에 남아 있을 가능성 → 상태 원본을 삭제하지 않고 신규 검색·거래·시세 노출만 국내로 제한한다.
- 공공데이터 장애 → 마지막 정상 캐시를 유지하고 매시간 다시 확인한다.
- 롤백: 이번 통합 커밋 하나를 되돌리면 원격 `a6ecce7` 상태로 복귀할 수 있다. 학생 DB 스키마 변경은 하지 않는다.
