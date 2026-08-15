#!/usr/bin/env node
// 설치 자가검증: 미기입 {{플레이스홀더}} 잔존 검사 (init-harness §4 / 퀵스타트 자가검증 단계)
// 사용: node scripts/check-placeholders.mjs [대상...]   (기본: CLAUDE.md .claude)
// 종료코드: 잔존 0건=0, 있으면 1 (CI 게이트로도 사용 가능)
//
// 주의: docs/의 *-template.md·agent-brief-template 등은 "복사해 쓰는 영구 템플릿"이라
// {{}}가 남는 게 정상 — 기본 대상에서 제외한다. 검사 대상은 "채워진 상태여야 하는 파일"
// (CLAUDE.md, .claude/ 의 실 에이전트·스킬 정의, 팩 설치로 docs/에 복사·기입된 문서)뿐.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['CLAUDE.md', '.claude'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'templates', 'dist', 'init-harness']); // init-harness: 일회용 설치 스킬 — 본문이 {{}}를 문구로 언급
const EXTS = ['.md', '.json', '.sql', '.yml', '.yaml'];
const isTemplateFile = (name) => name.endsWith('-template.md') || name.endsWith('-template.sql');

const hits = [];
function scanFile(p) {
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    // GitHub Actions의 ${{ ... }} 구문은 플레이스홀더가 아님
    const stripped = line.replace(/\$\{\{[^}]*\}\}/g, '');
    if (stripped.includes('{{')) hits.push(`${p.split(sep).join('/')}:${i + 1}  ${line.trim().slice(0, 80)}`);
  });
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue; }
    if (EXTS.some((e) => name.endsWith(e)) && !isTemplateFile(name)) scanFile(p);
  }
}
for (const t of targets) {
  if (!existsSync(t)) continue;
  statSync(t).isDirectory() ? walk(t) : scanFile(t);
}

if (hits.length) {
  console.error(`미기입 플레이스홀더 ${hits.length}건 — 설치 미완:\n` + hits.join('\n'));
  process.exit(1);
}
console.log(`플레이스홀더 잔존 0건 — 통과 (대상: ${targets.join(', ')})`);
