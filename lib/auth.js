'use strict';
/**
 * lib/auth.js — JWT (HS256) + scrypt PIN 해시 유틸 (CommonJS, node:crypto만 사용)
 *
 * 토큰 페이로드 규약:
 * - 학생 access:  { sid, cls, epo }                        TTL 3600초 (1시간)
 * - 학생 refresh: { sid, cls, epo, typ:'refresh' }          TTL 2592000초 (30일)
 *                 (남은 시간이 1296000초(15일) 미만이면 재발급하여 롤링)
 * - 교사:         { tid, role, cls, name, typ:'teacher' }   TTL 43200초 (12시간)
 *                 role은 'teacher' 또는 'admin'.
 *                 환경변수 관리자 계정은 { tid:'admin', role:'admin', cls:null }.
 */

const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MIN_SECRET_LEN = 32;

// ── JWT 서명 비밀키 (fail-closed: 운영 환경에서 비밀 누락/취약 시 기동 중단) ──────────
let jwtSecret;
if (process.env.JWT_SECRET) {
  jwtSecret = process.env.JWT_SECRET;
  if (IS_PRODUCTION && jwtSecret.length < MIN_SECRET_LEN) {
    console.error(
      '[auth] 치명적: 운영 환경에서 JWT_SECRET이 없거나 32자 미만입니다. Railway 환경변수를 설정한 뒤 재배포하세요.',
    );
    process.exit(1);
  }
} else if (IS_PRODUCTION) {
  console.error(
    '[auth] 치명적: 운영 환경에서 JWT_SECRET이 없거나 32자 미만입니다. Railway 환경변수를 설정한 뒤 재배포하세요.',
  );
  process.exit(1);
} else {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[auth] (개발 모드) JWT_SECRET 미설정 — 임시 랜덤 키를 사용합니다. 서버 재시작 시 기존 토큰이 모두 무효화됩니다.',
  );
}

// ── Base64url 인코더/디코더 ──────────────────────────────────────────────────
function b64uEncode(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64uDecode(str) {
  const padded = str + '==='.slice((str.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── HS256 JWT ────────────────────────────────────────────────────────────────
const JWT_HEADER = b64uEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function hmac256(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest();
}

/** payload에 iat/exp를 채워 HS256 JWT 문자열을 생성 */
function signToken(payload, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const full = Object.assign({}, payload, { iat: now, exp: now + expiresInSec });
  const headerPayload = `${JWT_HEADER}.${b64uEncode(JSON.stringify(full))}`;
  const sig = b64uEncode(hmac256(headerPayload, jwtSecret));
  return `${headerPayload}.${sig}`;
}

/** 서명(timing-safe) + 만료를 검증하고 payload 객체를 반환. 유효하지 않으면 null */
function verifyToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [header, payloadB64, sigB64] = parts;

    const expected = b64uEncode(hmac256(`${header}.${payloadB64}`, jwtSecret));
    const expectedBuf = Buffer.from(expected, 'utf8');
    const givenBuf = Buffer.from(sigB64, 'utf8');
    if (expectedBuf.length !== givenBuf.length) return null;
    if (!crypto.timingSafeEqual(expectedBuf, givenBuf)) return null;

    const payload = JSON.parse(b64uDecode(payloadB64).toString('utf8'));

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/** 토큰 만료까지 남은 초. 유효하지 않은 토큰이면 0 */
function tokenRemainingSeconds(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(b64uDecode(parts[1]).toString('utf8'));
    if (typeof payload.exp !== 'number') return 0;
    return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}

/**
 * 문자열 timing-safe 비교. 둘 중 하나라도 비어 있거나 길이가 다르면 false
 * (환경 비밀키/비밀번호 비교에 사용 — `===` 타이밍 사이드채널 제거)
 */
function safeEqual(a, b) {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── scrypt PIN 해시 ──────────────────────────────────────────────────────────
function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_VERSION = 'v1';

/** PIN을 scrypt로 해시. 반환값 형식: "v1:salt(hex 16B):hash(hex)" */
async function scryptHash(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${SCRYPT_VERSION}:${salt}:${key.toString('hex')}`;
}

/** PIN이 scrypt 해시("v1:salt:hash")와 일치하는지 timing-safe 검증 */
async function scryptVerify(pin, stored) {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 3 || parts[0] !== SCRYPT_VERSION) return false;
    const [, salt, hashHex] = parts;
    const key = await scryptAsync(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    const storedBuf = Buffer.from(hashHex, 'hex');
    if (key.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(key, storedBuf);
  } catch {
    return false;
  }
}

/**
 * 로그인 실패 잠금 테이블 키 해시. `lockout:<scope>:<identifier>`를 JWT 비밀키로
 * keyed-HMAC — DB에 원문 식별자(반코드:닉네임, 교사 아이디 등)를 저장하지 않기 위함.
 */
function lockoutHash(scope, identifier) {
  return crypto.createHmac('sha256', jwtSecret).update(`lockout:${scope}:${identifier}`).digest('hex');
}

module.exports = {
  signToken,
  verifyToken,
  tokenRemainingSeconds,
  safeEqual,
  scryptHash,
  scryptVerify,
  lockoutHash,
};
