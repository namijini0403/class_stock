#!/usr/bin/env node
// scripts/smoke-server.mjs — server.js 부팅 + 학생/교사 API 왕복 스모크 테스트 (DATABASE_URL 필요)
// DATABASE_URL이 없으면 조용히 건너뛴다(이 환경에는 로컬 Postgres/Docker가 없음).
// 사용: $env:DATABASE_URL='postgres://...'; node scripts/smoke-server.mjs
//
// 흐름: 서버 기동 → 관리자 로그인 → 학급(SMOKE1) 생성 → 학생 가입 → GET /api/me →
//       교사 지급(+5000) → GET /api/me로 현금 증가 + TEACHER 거래 기록 확인 →
//       GET /api/teacher/students로 명렬표 요약(cash 포함) 확인 →
//       PIN 재설정(token_epoch 증가) → 새 PIN으로 재로그인 확인 → 서버 종료.
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

    // 일봉 차트는 학생 로그인과 국내 코드·기간 검증을 통과해야만 공급자를 호출한다.
    const chartNoAuth = await fetch(`${baseUrl}/api/chart?code=005930&days=190`);
    if (chartNoAuth.status !== 401) throw new Error(`미인증 일봉 요청이 거부되지 않음 (status ${chartNoAuth.status})`);
    const chartBadCode = await fetch(`${baseUrl}/api/chart?code=ABC123&days=190`, { headers: { Authorization: `Bearer ${studentToken}` } });
    if (chartBadCode.status !== 400) throw new Error(`비국내 일봉 코드가 거부되지 않음 (status ${chartBadCode.status})`);
    const chartBadDays = await fetch(`${baseUrl}/api/chart?code=005930&days=0`, { headers: { Authorization: `Bearer ${studentToken}` } });
    if (chartBadDays.status !== 400) throw new Error(`잘못된 일봉 기간이 거부되지 않음 (status ${chartBadDays.status})`);

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

    // 7) GET /api/teacher/students?classCode=SMOKE1 — 명렬표 요약(cash 포함)에 가입 학생이 있는지 확인
    const rosterRes = await fetch(`${baseUrl}/api/teacher/students?classCode=${classCode}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const rosterBody = await rosterRes.json();
    if (!rosterRes.ok || !Array.isArray(rosterBody.students)) {
      throw new Error('명렬표 조회 실패: ' + JSON.stringify(rosterBody));
    }
    const rosterEntry = rosterBody.students.find((s) => s.studentId === studentId);
    if (!rosterEntry || typeof rosterEntry.cash !== 'number') {
      throw new Error('명렬표에서 가입 학생 cash 필드를 찾지 못함: ' + JSON.stringify(rosterBody));
    }
    if (rosterEntry.cash !== initialCash + 5000) {
      throw new Error(`명렬표 cash가 기대와 다름 (기대 ${initialCash + 5000}, 실제 ${rosterEntry.cash})`);
    }

    // 8) PIN 재설정 — token_epoch가 증가해 구 토큰은 즉시 무효화됨
    const resetRes = await fetch(`${baseUrl}/api/teacher/student/${studentId}/reset-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ pin: '5678' }),
    });
    const resetBody = await resetRes.json();
    if (!resetRes.ok || !resetBody.ok) throw new Error('PIN 재설정 실패: ' + JSON.stringify(resetBody));

    // 9) 구 학생 토큰은 이제 거부되어야 함(token_epoch 불일치)
    const meAfterReset = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${studentToken}` } });
    if (meAfterReset.status !== 401) {
      throw new Error(`PIN 재설정 후 구 토큰이 여전히 통과함 (status ${meAfterReset.status})`);
    }

    // 10) 새 PIN으로 재가입(=로그인) — 기존 상태를 그대로 이어받는지 확인
    const rejoinRes = await fetch(`${baseUrl}/api/auth/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classCode, nickname: '스모크학생', pin: '5678' }),
    });
    const rejoinBody = await rejoinRes.json();
    if (!rejoinRes.ok || !rejoinBody.accessToken || rejoinBody.studentId !== studentId) {
      throw new Error('새 PIN 재가입 실패: ' + JSON.stringify(rejoinBody));
    }
    if (Number(rejoinBody.state?.cash) !== initialCash + 5000) {
      throw new Error('새 PIN 재가입 후 state가 이전 상태를 이어받지 못함: ' + JSON.stringify(rejoinBody.state));
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
