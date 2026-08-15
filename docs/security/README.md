# 우리학교 모의투자 — 보안 문서 스위트 (목차와 작성 순서)

> **문서 목록이 곧 방법론이다**: 아래 순서대로 채우면 위협 식별 → 데이터 파악 → 통제 설계 → 운영 준비가 자연히 완성된다.
> 각 문서는 짧아도 된다 — 빈 제목만 있는 문서가 "아직 안 한 일"을 드러내는 것 자체가 가치.

## 1단계 — 위협·데이터 파악 (설계 전 필수)

| 문서 | 내용 |
|---|---|
| `THREAT_MODEL_STRIDE.md` | 자산 열거 → STRIDE 6축(위장·변조·부인·정보노출·서비스거부·권한상승)으로 위협 도출 → 완화 매핑 |
| `DATA_CLASSIFICATION.md` | 다루는 모든 데이터를 민감도 등급(공개/내부/민감/규제)으로 분류 + 각 등급의 취급 규칙 |
| `DATA_FLOW_DIAGRAM.md` | 데이터가 어디서 나서 어디로 흐르고 어디 저장되는가 — 신뢰 경계 표시 |

## 2단계 — 통제 설계

| 문서 | 내용 |
|---|---|
| `SECURITY_ARCHITECTURE.md` | 인증·인가·암호화·비밀 관리의 전체 그림 |
| `RBAC_ABAC_MATRIX.md` | 역할×리소스×행위 매트릭스 — "누가 무엇을 할 수 있나"의 정본 (학생/교사/관리자) |
| `AI_DATA_BOUNDARY.md` | AI(LLM)에 어떤 데이터를 보내도 되는가 — 프롬프트에 실을 수 있는 데이터 등급 정의 |
| `API_SECURITY_CHECKLIST.md` | 엔드포인트별 인증·인가·입력검증·율제한 체크 (ASVS L2 기준) |

> **RLS(행 수준 보안) 정책 문서 없음 — 의도적 제외**: 이 프로젝트는 애플리케이션이 단일 서버 역할(하나의 `DATABASE_URL` 접속 계정)로만 Postgres에 접근하며, 사용자별 DB 세션 분리가 없다. 접근 제어는 전부 애플리케이션 계층(`server.js`)에서 수행한다. 따라서 meta_harness의 `rls-policy-template.sql`은 이 프로젝트에 적용하지 않는다.

## 3단계 — 법·동의

> 개인정보 수집이 닉네임뿐이고 별도 동의서·처리방침이 필요한 분석 수집이 없어(§CLAUDE.md 6) 이 단계 문서는 현재 생략한다. 향후 분석 DB나 추가 개인정보 수집이 도입되면 meta_harness `security-doc-suite.md` 3단계(동의서·처리방침·보존기간 정책)를 다시 참조해 작성한다.

## 4단계 — 운영 준비

| 문서 | 내용 |
|---|---|
| `INCIDENT_RESPONSE_RUNBOOK.md` | 침해·장애 대응 절차. **말미에 "증상 → 절 매핑 표"** — 사고 중엔 목차 읽을 시간이 없다. |
| `ENVIRONMENT_SEPARATION.md` | dev/prod 분리 · 시크릿 관리(환경변수만, 코드·문서에 값 비노출) |

## 운영 원칙 (CLAUDE.md에 반영됨)

- **시크릿은 환경변수만** — 코드·커밋·메모리·AI 대화에 값 비노출. 커밋 금지 대상: `.env`, `ADMIN_PASSWORD.txt`, `PUBLIC_DATA_KEY.txt`, `data/server-data.json`.
- 감사는 감사 전용 에이전트(`.claude/agents/security-auditor.md`)가, 수정은 코드 오너(메인 모델)가 — 권한 분리.
- 인시던트 문서는 "증상→절 매핑"이 먼저 (러닝북 패턴, `INCIDENT_RESPONSE_RUNBOOK.md` 참조).

## 심화·특화가 필요할 때

이 스위트는 골격이다. 특정 영역을 깊게 파야 하면 meta_harness `packs/security-privacy/cybersecurity-skills-integration.md`의 스킬 카탈로그(위협모델링·침투테스트·포렌식 등 700+)를 참조해 해당 전문 스킬을 불러 쓴다.
