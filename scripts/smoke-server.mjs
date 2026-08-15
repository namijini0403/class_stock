#!/usr/bin/env node
// scripts/smoke-server.mjs — server.js 부팅 + 학생/교사 API 왕복 스모크 테스트 (DATABASE_URL 필요)
// DATABASE_URL이 없으면 조용히 건너뛴다(이 환경에는 로컬 Postgres/Docker가 없음).
// 사용: $env:DATABASE_URL='postgres://...'; node scripts/smoke-server.mjs
//
// 흐름: 서버 기동 → 관리자 로그인 → 학급(SMOKE1) 생성 → 학생 가입 → GET /api/me →
//       교사 지급(+5000) → GET /api/me로 현금 증가 + TEACHER 거래 기록 확인 → 서버 종료.
// 시세 소스가 환경 의존적이므로 /api/trade는 스모크하지 않는다.

import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error(`smoke-server FAIL: ${msg}`);
  process.exitCode = 1;
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return true;
    } catch {
      // 서버가 아직 리슨 전 — 재시도
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL 없음 — smoke-server 건너뜀');
    process.exit(0);
  }

  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const ADMIN_PASSWORD = 'adminpass1';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_PASSWORD,
      NODE_ENV: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childOutput = '';
  child.stdout.on('data', (d) => { childOutput += d.toString(); });
  child.stderr.on('data', (d) => { childOutput += d.toString(); });

  const killChild = () => {
    try { child.kill(); } catch { /* 이미 종료됨 */ }
  };

  try {
    const up = await waitForHealth(baseUrl);
    if (!up) {
      fail('서버가 /api/health에 응답하지 않음\n--- child output ---\n' + childOutput);
      killChild();
      process.exit(1);
    }

    // 1) 관리자 로그인
    const loginRes = await fetch(`${baseUrl}/api/teacher/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'admin', password: ADMIN_PASSWORD }),
    });
    const loginBody = await loginRes.json();
    if (!loginRes.ok || !loginBody.token) throw new Error('관리자 로그인 실패: ' + JSON.stringify(loginBody));
    const adminToken = loginBody.token;

    // 2) 학급 생성
    const classCode = 'SMOKE1';
    const classRes = await fetch(`${baseUrl}/api/admin/classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ code: classCode, name: '스모크 테스트반', grade: '1', classNo: '1', initialCash: 1000000 }),
    });
    const classBody = await classRes.json();
    if (!classRes.ok || !classBody.ok) throw new Error('학급 생성 실패: ' + JSON.stringify(classBody));

    // 3) 학생 가입
    const joinRes = await fetch(`${baseUrl}/api/auth/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classCode, nickname: '스모크학생', pin: '1234' }),
    });
    const joinBody = await joinRes.json();
    if (!joinRes.ok || !joinBody.accessToken || !joinBody.studentId) {
      throw new Error('학생 가입 실패: ' + JSON.stringify(joinBody));
    }
    const studentId = joinBody.studentId;
    const studentToken = joinBody.accessToken;
    const initialCash = Number(joinBody.state?.cash);
    if (!Number.isFinite(initialCash)) throw new Error('가입 응답에 state.cash가 없음: ' + JSON.stringify(joinBody));

    // 4) GET /api/me (가입 직후)
    const meRes1 = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${studentToken}` } });
    const meBody1 = await meRes1.json();
    if (!meRes1.ok || !meBody1.state) throw new Error('GET /api/me 실패: ' + JSON.stringify(meBody1));
    if (Number(meBody1.state.cash) !== initialCash) throw new Error('GET /api/me의 초기 현금이 가입 응답과 다름');

    // 5) 교사 지급 +5000
    const cmdRes = await fetch(`${baseUrl}/api/teacher/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ studentIds: [studentId], amount: 5000, reason: '스모크 테스트 지급' }),
    });
    const cmdBody = await cmdRes.json();
    if (!cmdRes.ok || !cmdBody.ok || cmdBody.count !== 1) throw new Error('교사 지급 실패: ' + JSON.stringify(cmdBody));
    if (!cmdBody.results || cmdBody.results[0]?.appliedAmount !== 5000) {
      throw new Error('교사 지급 appliedAmount가 5000이 아님: ' + JSON.stringify(cmdBody));
    }

    // 6) GET /api/me — 현금 +5000 및 TEACHER 거래 기록 확인
    const meRes2 = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${studentToken}` } });
    const meBody2 = await meRes2.json();
    if (!meRes2.ok || !meBody2.state) throw new Error('GET /api/me(2차) 실패: ' + JSON.stringify(meBody2));
    if (Number(meBody2.state.cash) !== initialCash + 5000) {
      throw new Error(`현금이 +5000 반영되지 않음 (기대 ${initialCash + 5000}, 실제 ${meBody2.state.cash})`);
    }
    const teacherTx = (meBody2.state.transactions || []).find((t) => t.type === 'TEACHER');
    if (!teacherTx || Number(teacherTx.signedAmount) !== 5000) {
      throw new Error('TEACHER 거래 기록을 찾지 못함: ' + JSON.stringify(meBody2.state.transactions));
    }

    console.log('smoke-server OK');
  } catch (err) {
    fail((err && err.stack) || err);
  } finally {
    killChild();
  }
}

main().catch((err) => {
  console.error('smoke-server FAIL:', (err && err.stack) || err);
  process.exit(1);
});
