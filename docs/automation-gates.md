# 자동화 게이트 예시 (hooks + CI)

> 문서 규칙은 잊히고, 자동 게이트는 잊혀도 안전하다 (HARNESS.md §4). 두 층을 갖춘다:
> **hooks** = 로컬, AI 작업 중 즉시 개입 / **CI** = 원격, 푸시·PR 시 최종 방벽.

## 1. Claude Code hooks (.claude/settings.json)

자주 쓰는 패턴 3가지 — 프로젝트에 맞게 명령만 교체해 settings.json에 추가.
⚠️ **아래는 설명용 jsonc(주석 포함)다 — 실제 settings.json은 주석을 허용하지 않으므로 `//` 줄을 전부 제거하고 붙여넣어라.**

```jsonc
{
  "hooks": {
    // ① 커밋 금지 파일 보호: 스테이징에 금지 경로가 들어오면 비영(非零) 종료로 차단
    //    (별도 스크립트 불필요 — 인라인 한 줄. {{금지패턴}}만 교체: 예 ^(참고문제|유형소스)/)
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "git diff --cached --name-only | grep -E '{{금지패턴}}' && echo '커밋 금지 파일이 스테이징됨' && exit 2 || exit 0"
        }]
      }
    ],
    // ② 편집 직후 즉시 타입체크: 깨진 상태로 다음 작업 진행 방지
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "{{예: npx tsc --noEmit -p . 2>&1 | tail -5}}"
        }]
      }
    ],
    // ③ 세션 종료 시 임시 파일 잔존 경고 (zztmp_* 청소 규약 — verification-loop.md §6)
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "{{예: git status --short | grep zztmp_ && echo '임시 파일 잔존!' || true}}"
        }]
      }
    ]
  }
}
```

주의: hooks는 **AI가 아니라 하네스(도구 층)가 실행**한다 — "AI에게 매번 하라고 시키기"보다 확실하다. 단 hook 명령이 느리면 전체 작업이 느려지므로 타입체크류는 증분·tail로 가볍게.

## 2. CI 게이트 (GitHub Actions 예시 — `.github/workflows/gate.yml`)

```yaml
name: gate
on:
  push: { branches: [main] }
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci

      # CLAUDE.md §3 검증 루프와 동일 순서 — 로컬 게이트의 원격 사본
      - name: 타입체크
        run: {{npx tsc --noEmit -p client && npx tsc --noEmit -p server}}
      - name: 전체 테스트
        run: {{npx vitest run}}
      - name: 빌드
        run: {{npm run build}}

      # 보안 게이트 (packs/security-privacy 병용 시)
      # ⚠️ gitleaks는 GITHUB_TOKEN env 필수 + 이력 전체 스캔엔 checkout에 fetch-depth: 0 필요 (조직 계정은 라이선스 키 별도)
      - name: 비밀 스캔
        uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
      - name: 커밋 금지 파일 침입 검사
        run: "! git ls-files | grep -E '{{예: ^(참고문제|유형소스)/}}'"
      - name: RLS 정책 존재 검사   # 새 테이블에 ENABLE ROW LEVEL SECURITY 누락 적발
        run: {{예: node scripts/check-rls.mjs server/sql/*.sql}}
```

## 3. 게이트 승격 규칙

- 로컬 검증 루프(§3)에서 **두 번 이상 사람이 놓친 항목**은 CI로 승격.
- CI에서 잡힌 실패는 합리화 방지표에 기록 — "왜 로컬에서 안 잡혔나"가 다음 hook 후보다.
