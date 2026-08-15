#!/usr/bin/env node
// 커밋 전 게이트: 프로젝트 핵심 파일에 대해 `node --check` 구문 검사를 실행한다.
// 사용: node scripts/syntax-check.mjs [--quiet]
// --quiet: 통과 시 아무것도 출력하지 않는다 (PostToolUse hook용).
// 존재하지 않는 파일은 건너뛴다 (아직 만들어지지 않은 lib/db.js 등에 대비).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const quiet = process.argv.includes('--quiet');

const libFiles = existsSync('lib')
  ? readdirSync('lib').filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)
  : [];

const targets = [
  'server.js',
  ...libFiles,
  'public/app.js',
  'public/teacher.js',
  'public/service-worker.js',
].filter((f) => existsSync(f));

const failures = [];
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, stderr: result.stderr });
}

if (failures.length) {
  console.error(`구문 오류 ${failures.length}건:`);
  for (const f of failures) console.error(`- ${f.file}\n${f.stderr}`);
  process.exit(1);
}

if (!quiet) console.log(`구문 검사 통과 (${targets.length}개 파일)`);
