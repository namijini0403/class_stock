#!/usr/bin/env node
// scripts/smoke-auth.mjs — lib/auth.js 순수 로직 스모크 테스트 (DB 불필요)
// 사용: node scripts/smoke-auth.mjs
import { createRequire } from 'node:module';

// lib/auth.js는 모듈 로드 시점에 JWT_SECRET을 읽으므로 require보다 먼저 설정한다.
process.env.JWT_SECRET = 'a'.repeat(32);

const require = createRequire(import.meta.url);
const { signToken, verifyToken, tokenRemainingSeconds, safeEqual, scryptHash, scryptVerify, lockoutHash } =
  require('../lib/auth.js');

function fail(msg) {
  console.error(`smoke-auth FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  // 1) sign/verify 왕복
  const token = signToken({ sid: 'student-1', cls: 'TIGER5', epo: 0 }, 3600);
  const payload = verifyToken(token);
  if (!payload || payload.sid !== 'student-1' || payload.cls !== 'TIGER5') {
    fail('sign/verify 왕복 실패');
  }
  const remaining = tokenRemainingSeconds(token);
  if (!(typeof remaining === 'number' && remaining > 0 && remaining <= 3600)) {
    fail('tokenRemainingSeconds 값이 올바르지 않음');
  }

  // 2) 변조된 토큰 → null (payload 세그먼트를 건드려 서명 불일치를 유발)
  const parts = token.split('.');
  const tampered = `${parts[0]}.${parts[1]}zz.${parts[2]}`;
  if (verifyToken(tampered) !== null) fail('변조 토큰이 거부되지 않음');

  // 3) 만료된 토큰 → null / 남은시간 0
  const expired = signToken({ sid: 'x' }, -10);
  if (verifyToken(expired) !== null) fail('만료 토큰이 거부되지 않음');
  if (tokenRemainingSeconds(expired) !== 0) fail('만료 토큰의 남은시간이 0이 아님');

  // 4) scryptHash/scryptVerify 왕복 + 오답 PIN
  const hash = await scryptHash('1234');
  if (typeof hash !== 'string' || !hash.startsWith('v1:') || hash.split(':').length !== 3) {
    fail('scryptHash 형식이 올바르지 않음');
  }
  if ((await scryptVerify('1234', hash)) !== true) fail('scryptVerify 정상 PIN이 거부됨');
  if ((await scryptVerify('9999', hash)) !== false) fail('scryptVerify 오답 PIN이 통과됨');

  // 5) safeEqual 참/거짓
  if (safeEqual('abc', 'abc') !== true) fail('safeEqual 동일값이 false');
  if (safeEqual('abc', 'abd') !== false) fail('safeEqual 다른값이 true');
  if (safeEqual('', 'abc') !== false) fail('safeEqual 빈 문자열 처리 실패');
  if (safeEqual('abc', '') !== false) fail('safeEqual 빈 문자열 처리 실패(2)');
  if (safeEqual(null, 'abc') !== false) fail('safeEqual null 처리 실패');

  // 6) lockoutHash — 결정적이고 scope별로 다름
  const h1 = lockoutHash('student', 'TIGER5:파랑고래');
  const h2 = lockoutHash('student', 'TIGER5:파랑고래');
  const h3 = lockoutHash('teacher', 'TIGER5:파랑고래');
  if (h1 !== h2) fail('lockoutHash가 결정적이지 않음');
  if (h1 === h3) fail('lockoutHash가 scope를 반영하지 않음');
  if (!/^[0-9a-f]{64}$/.test(h1)) fail('lockoutHash가 hex sha256 다이제스트 형식이 아님');

  console.log('smoke-auth OK');
}

main().catch((err) => {
  console.error('smoke-auth FAIL:', (err && err.stack) || err);
  process.exit(1);
});
