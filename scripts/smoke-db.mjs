#!/usr/bin/env node
// scripts/smoke-db.mjs — lib/db.js 부트스트랩 + 기본 CRUD 스모크 테스트 (DATABASE_URL 필요)
// DATABASE_URL이 없으면 조용히 건너뛴다(이 환경에는 로컬 Postgres/Docker가 없음).
// 사용: $env:DATABASE_URL='postgres://...'; node scripts/smoke-db.mjs
import { createRequire } from 'node:module';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL 없음 — smoke-db 건너뜀');
    process.exit(0);
  }

  const require = createRequire(import.meta.url);
  const db = require('../lib/db.js');

  await db.init();

  // settings write-through 캐시 왕복
  const key = `smoke-db:${Date.now()}`;
  const value = { ok: true, ts: Date.now() };
  await db.setSetting(key, value, { id: 'smoke-db', name: 'smoke-db' });
  const read = db.getSetting(key, null);
  if (!read || read.ok !== true) {
    console.error('smoke-db FAIL: settings write/read 불일치');
    process.exit(1);
  }

  // 8개 테이블 전부 존재 확인
  const tables = [
    'classes',
    'students',
    'teachers',
    'teacher_commands',
    'corporate_actions',
    'settings',
    'audit_log',
    'login_lockouts',
  ];
  const r = await db.query(
    `SELECT ${tables.map((t, i) => `to_regclass('public.${t}') AS t${i}`).join(', ')}`,
  );
  const row = r.rows[0];
  const missing = tables.filter((t, i) => !row[`t${i}`]);
  if (missing.length) {
    console.error('smoke-db FAIL: 테이블 누락 —', missing.join(', '));
    process.exit(1);
  }

  console.log('smoke-db OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke-db FAIL:', (err && err.stack) || err);
  process.exit(1);
});
