#!/usr/bin/env node
// PreToolUse(Bash) hook: 금지 파일이 git 스테이징에 올라와 있으면 커밋을 막는다.
// 종료코드 2 = block (Claude Code hook 규약), 0 = 통과.
import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' });
const staged = (result.stdout || '').split('\n').filter(Boolean);

const FORBIDDEN = /ADMIN_PASSWORD\.txt|PUBLIC_DATA_KEY\.txt|data\/(?:server-data\.json|kr-public-prices\.json(?:\..*)?)$|(^|\/)runtime\/|(^|\/)node_modules\/|startup-log\.txt|\.log$/;
const hits = staged.filter((p) => FORBIDDEN.test(p) || (/(^|\/)\.env(?:\.|$)/.test(p) && p !== '.env.example'));

if (hits.length) {
  console.error(`금지 파일이 스테이징되어 있습니다: ${hits.join(', ')}`);
  process.exit(2);
}
process.exit(0);
