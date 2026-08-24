# 우리학교 모의투자 작업 하네스 (AI 전용 — 모든 모델이 동일 품질을 내기 위한 규약)

> **이 파일은 meta_harness 스타터킷을 프로젝트에 맞게 채운 버전이다.** 플레이스홀더 없이 전부 채워져 있어야 한다 (Task 1 설치 완료 상태).

우리학교 모의투자 — 초등 교실용 국내 주식 모의투자 PWA. 스택: 순수 Node.js 서버(프레임워크 없음, 의존성은 pg 하나) + 순수 JS/HTML/CSS PWA 프론트엔드 + Postgres.

장애·침해 의심 시 필독: `docs/security/INCIDENT_RESPONSE_RUNBOOK.md`

## 0. 오케스트레이션 원칙 (토큰·품질 최적화)

- **메인 모델(너) = 계획·브리프 작성·검증·통합·커밋만.** 대량 구현은 서브에이전트에 위임.
- **검증 통과 판정·설계 결정·도메인 정확성 판단·커밋은 절대 위임하지 않는다.**
- 에이전트 위임 시 **`docs/agent-brief-template.md`의 8요소 브리프** 필수. 요약하지 말고 템플릿 복붙 + 델타만.
- 소유 경계·순차 파일·핸드오프 = `.claude/agents/README.md`가 정본. 서로 다른 파일만 만지면 병렬, 공유 파일은 순차.
- 에이전트가 중간에 죽으면: 남긴 파일을 `git status`로 확인 → "기존 산출물 검수부터"를 지시하는 이어받기 에이전트 재가동.
- 모델 배정: 설계·검수·승인 = 최상위 모델 / 대량 저작·배선 = 중간 모델 / 커밋·최종 판단 = 메인.
- **규모 있는 작업(파일 3개 이상·새 기능·구조 변경)은 코드 전에 계획서 먼저**: `docs/plan-template.md` → 사용자 승인 → 실행.
- 버그·장애는 `debug` 스킬(재현 없이 수정 금지), 새 로직 구현은 `tdd` 스킬(RED 확인 후 구현) 규율 적용.

## 2. 불변식 (가능한 한 테스트로 강제 — 위반 = 실패)

> 새 규칙이 생기면 항상 물어라: "이걸 테스트로 만들 수 있나?" (HARNESS.md §4)

- 금액은 항상 원화 정수(KRW integer). 부동소수점 잔액 연산 금지.
- 시세 정본은 금융위원회 주식시세정보의 일별 OHLCV다. 하루 1회 새 자료를 확인하며, 기준일 다음 영업일 오후 1시 이후 반영될 수 있다. 시간봉·장중 실시간 시세로 표현하지 않는다.
- 종목 차트는 공식 일별 OHLCV를 사용한 최근 30·90·180일 범위의 일봉만 제공하며 휴장일에는 봉을 만들지 않는다.
- 학생 상태 변경은 반드시 `applyTrade` / `applyCorporateActions` / `applyTeacherCommands`를 통해서만 — 트랜잭션 안에서 `SELECT ... FOR UPDATE` 후 저장.
- npm 의존성은 `pg` 하나만. 새 의존성 추가 금지 — Node 내장(crypto/http/fs)으로 해결.
- 모든 사용자 노출 문자열은 한국어. 클라이언트 렌더링 시 `esc()` 이스케이프 필수(innerHTML 삽입 전).
- 비밀 비교는 항상 timing-safe (`crypto.timingSafeEqual` 계열). `===` 비교 금지.
- 닉네임에 연속 숫자 3자리 이상 금지(개인정보 보호) — 클라이언트·서버 양쪽 검증.

## 3. 검증 루프 (커밋 전 필수, 순서대로)

```
node scripts/syntax-check.mjs
node scripts/check-kr-only.mjs
node scripts/check-placeholders.mjs
node scripts/smoke-auth.mjs        (Task 2 이후 존재; DB 불필요)
node scripts/smoke-server.mjs      (Task 5 이후 존재; DATABASE_URL 필요 — 없으면 skip 출력)
```
- **테스트 수 기준선: 기준선 없음 — 테스트 프레임워크 없음. 위 스크립트가 게이트.**
- 상세 설계는 `docs/verification-loop.md`. 로컬 hooks·CI로의 게이트 승격 = `docs/automation-gates.md`.

## 5. 불변 결정 (사용자가 명시 — 되돌리지 말 것)

> 정본 = `docs/decisions-log.md` (템플릿: docs/decisions-log-template.md). 아래는 최상위 요약.

- 학생 상태는 서버측 Postgres JSONB가 정본 (2026-08).
- 거래 시장은 국내 주식 전용이며 금융위원회 일별 OHLCV를 하루 1회 확인 (2026-08).
- 종목 차트는 최근 30·90·180일 범위의 일봉으로 제공 (2026-08).
- 의존성은 pg 하나만 (2026-08).
- JWT_SECRET 운영 중 회전 금지 — 전 사용자 로그아웃됨 (2026-08).

## 6. 데이터·개인정보 불변 결정

- 닉네임 외 실명·학번 등 개인정보를 서버에 저장하지 않는다. 분석 DB 없음.
- 실제 API 키·비밀번호·학생 데이터·Postgres 접속정보·시세 캐시는 Git 및 배포 ZIP에 포함하지 않는다. 운영 값은 Railway Variables에서만 관리한다.
- 장애·침해 의심 시 필독: `docs/security/INCIDENT_RESPONSE_RUNBOOK.md`.

## 7. 환경·커밋 규약

- 환경: Windows + PowerShell. 커밋 메시지에 큰따옴표 금지(인자 깨짐) — 단따옴표 here-string `@'...'@` 사용, 닫는 `'@`는 0열.
- 커밋 메시지 한국어 또는 영어, 말미에 공동저자 트레일러 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `git add -A` 금지 — 명시 경로만 add.
- 커밋 금지 대상: `.env*`(`.env.example` 제외), `ADMIN_PASSWORD.txt`, `PUBLIC_DATA_KEY.txt`, 학생 데이터, 시세 캐시, `runtime/`, `node_modules/`, 로그.
- 매 버전은 §3 테스트와 비밀값 역검색·추적 파일·ZIP 포함 목록 보안검사를 모두 통과한 뒤 출시한다. 통과한 출시 파일만 명시적으로 스테이징하고 `main`에 fast-forward 푸시한다.
- 사용자가 직접 할 일이 생기면 코드가 아니라 `docs/USER-TODO.md`에 추가.
- 합리화 방지표(`docs/rationalization-guardrails.md`)에 실패를 기록하는 것이 하네스 유지보수의 전부다.

## 8. 자주 쓰는 사실 (세션 간 재발견 방지)

> 세션에서 힘들게 알아낸 사실("이 파일이 정본이다", "이 명령은 이렇게 해야 동작한다")을 여기 축적한다.
> 오래돼 틀려진 항목은 지운다. 이 절이 커지면 도메인별 docs로 분리.

- server.js가 라우팅·거래로직 전부를 가진 정본. lib/db.js가 스키마 정본(부팅 시 CREATE TABLE IF NOT EXISTS).
- 시세는 `data/stock-universe.json`(커밋됨) + 금융위원회 일별 OHLCV 런타임 캐시. 캐시는 Git/ZIP 제외 대상이다.
