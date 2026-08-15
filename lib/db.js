'use strict';
/**
 * lib/db.js — Postgres 연결 + 부팅 시 스키마 부트스트랩(마이그레이션 도구 없이 운영 단순화)
 * CommonJS, require('pg').Pool 사용.
 *
 * 왜 JSONB 학생 상태이고 정규화된 holdings/transactions 테이블이 아닌가
 * (docs/decisions-log.md 참고): applyTrade·applyCorporateActions·applyTeacherCommands
 * 세 상태 엔진이 상태 객체 전체를 structuredClone으로 소비/반환한다. JSONB 컬럼이면
 * load→apply→save 트랜잭션으로 세 엔진을 그대로 재사용할 수 있다. 정규화하면 세 엔진을
 * 전부 재작성해야 하고 학급 규모(≤ 약 40명, 상태 ≤ 약 1MB, 거래 1500건 상한)에서 얻을
 * 쿼리 이득이 없다. 명렬 요약은 Node에서 최대 한 학급 분 행만으로 계산한다. 단일 행
 * `SELECT ... FOR UPDATE`가 학생별 직렬화를 공짜로 제공한다.
 *
 * settings/corporate_actions는 쓰기 시 DB와 함께 갱신되는 인메모리 캐시를 둔다
 * (getSetting/getEffectiveCorporateActions/listCorporateActions처럼 동기 호출이 필요한
 * 기존 코드가 그대로 동작하도록). 이 캐시는 **단일 인스턴스 전제** — 여러 서버 프로세스가
 * 동시에 뜨면(수평 확장) 캐시가 어긋날 수 있다. 교실 규모 배포에서는 인스턴스 1개면 충분.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;

// ── 쓰기-시 갱신 캐시 (단일 인스턴스 전제 — 위 주석 참고) ─────────────────────────
const settingsCache = new Map();
const corporateActionsCache = new Map(); // id -> camelCase 액션 객체

function actorIdOf(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return actor.id || 'system';
}

function actorNameOf(actor) {
  if (!actor) return 'system';
  if (typeof actor === 'string') return actor;
  return actor.name || actor.id || 'system';
}

function toIso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * 연결 문자열의 호스트명이 localhost/127.0.0.1/::1인지 판정.
 * 자격증명(`user:pass@`) 유무와 무관하게 동작하도록 정규식 대신 URL 파싱을 사용한다
 * (자격증명 없는 `postgres://localhost:5432/db` 형태도 잡아내기 위함 — 코드리뷰 지적사항).
 * IPv6 `::1`은 URL.hostname에서 대괄호로 감싸져(`[::1]`) 반환되므로 벗겨서 비교한다.
 * 파싱 실패 시 안전하게 "로컬 아님"으로 취급(기존 동작 유지 — SSL 활성화 쪽으로 폴백).
 */
function isLocalHost(url) {
  try {
    const hostname = new URL(url).hostname;
    const bare = hostname.replace(/^\[|\]$/g, '');
    return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
  } catch {
    return false;
  }
}

/**
 * 관리형 Postgres(Railway/Supabase 등)는 SSL 연결이 필수다. 로컬(localhost/127.0.0.1/::1)은
 * SSL 미사용. rejectUnauthorized:false — 관리형 경로에서 CA 체인 검증 없이 암호화만
 * (제공자가 TLS를 강제하므로 평문 노출은 없음). 로컬 개발 PG는 SSL 없이 그대로 붙는다.
 * (math_mon server/src/db.ts 패턴 이식)
 */
function poolConfig(url) {
  const isLocal = isLocalHost(url);
  return {
    connectionString: url,
    max: 10,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  };
}

/** idle 커넥션 오류가 unhandled 예외로 프로세스를 죽이는 node-postgres 알려진 동작 방지 */
function attachErrorLogger(p) {
  p.on('error', (err) => console.error('[db] idle client error:', err.message));
  return p;
}

async function bootstrap() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      grade TEXT NOT NULL DEFAULT '',
      class_no TEXT NOT NULL DEFAULT '',
      initial_cash BIGINT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS students (
      id UUID PRIMARY KEY,
      class_code TEXT NOT NULL REFERENCES classes(code),
      nickname TEXT NOT NULL,
      pin_scrypt TEXT NOT NULL,
      token_epoch INT NOT NULL DEFAULT 0,
      state JSONB NOT NULL,
      state_version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (class_code, nickname)
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id UUID PRIMARY KEY,
      login_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      pw_scrypt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'teacher',
      class_code TEXT REFERENCES classes(code),
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS teacher_commands (
      id UUID PRIMARY KEY,
      student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      amount BIGINT NOT NULL,
      applied_amount BIGINT,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'APPLIED',
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL DEFAULT '',
      reversal_of UUID,
      reversed_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS teacher_commands_student_idx
      ON teacher_commands(student_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS corporate_actions (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      old_code TEXT NOT NULL DEFAULT '',
      new_code TEXT NOT NULL DEFAULT '',
      old_name TEXT NOT NULL DEFAULT '',
      new_name TEXT NOT NULL DEFAULT '',
      ratio_num DOUBLE PRECISION NOT NULL DEFAULT 1,
      ratio_den DOUBLE PRECISION NOT NULL DEFAULT 1,
      settlement_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      cash_per_old_share DOUBLE PRECISION NOT NULL DEFAULT 0,
      effective_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'MANUAL',
      source_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_by_name TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT 'system',
      actor_name TEXT NOT NULL DEFAULT 'system',
      details JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS login_lockouts (
      scope TEXT NOT NULL,
      account_hash TEXT NOT NULL,
      fail_count INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, account_hash)
    );
  `);
}

async function loadSettingsCache() {
  settingsCache.clear();
  const r = await pool.query('SELECT key, value FROM settings');
  for (const row of r.rows) settingsCache.set(row.key, row.value);
}

function rowToAction(row) {
  return {
    id: row.id,
    type: row.type,
    oldCode: row.old_code,
    newCode: row.new_code,
    oldName: row.old_name,
    newName: row.new_name,
    ratioNum: Number(row.ratio_num),
    ratioDen: Number(row.ratio_den),
    settlementPrice: Number(row.settlement_price),
    cashPerOldShare: Number(row.cash_per_old_share),
    effectiveDate: row.effective_date,
    note: row.note,
    source: row.source,
    sourceKey: row.source_key,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function loadCorporateActionsCache() {
  corporateActionsCache.clear();
  const r = await pool.query(
    `SELECT id, type, old_code, new_code, old_name, new_name, ratio_num, ratio_den,
            settlement_price, cash_per_old_share, effective_date, note, source, source_key,
            status, created_by, created_by_name, created_at, updated_at
     FROM corporate_actions`,
  );
  for (const row of r.rows) corporateActionsCache.set(row.id, rowToAction(row));
}

/**
 * Postgres 연결 초기화 + 스키마 부트스트랩 + settings/corporate_actions 캐시 적재.
 * DATABASE_URL이 없으면 즉시 종료(fail-closed) — v3부터 앱은 모든 모드에서 Postgres가
 * 필요하다(로컬 수업용은 로컬/Docker/Railway Postgres를 가리키도록 문서화, Task 9 README).
 */
async function init() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL이 설정되지 않았습니다. Postgres 연결 문자열을 .env 또는 환경변수로 설정하세요.');
    process.exit(1);
  }

  pool = attachErrorLogger(new Pool(poolConfig(process.env.DATABASE_URL)));

  await bootstrap();
  await loadSettingsCache();
  await loadCorporateActionsCache();

  console.log('[db] 스키마 준비 완료');
}

/** 원시 쿼리 실행 (풀에서 커넥션을 빌려 자동 반환) */
function query(text, params) {
  return pool.query(text, params);
}

/** BEGIN/COMMIT/ROLLBACK으로 감싸 fn(client)를 트랜잭션 안에서 실행 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ROLLBACK 자체 실패는 무시 — 원래 오류를 그대로 전파 */
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── settings (쓰기-시 갱신 캐시) ────────────────────────────────────────────────
/** 캐시에서 동기 조회 — tradeFeeRate() 같은 기존 sync 호출자 호환용 */
function getSetting(key, fallback = null) {
  return settingsCache.has(key) ? settingsCache.get(key) : fallback;
}

async function setSetting(key, value, actor) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actorIdOf(actor)],
  );
  settingsCache.set(key, value);
  return value;
}

// ── corporate actions (쓰기-시 갱신 캐시) ───────────────────────────────────────
/** JsonStore.addCorporateAction과 동일한 시맨틱 — DB에 쓰고 캐시도 갱신 */
async function addCorporateAction(action, actor) {
  const id = (action && action.id) || crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const rec = {
    id,
    type: String((action && action.type) || ''),
    oldCode: String((action && action.oldCode) || ''),
    newCode: String((action && action.newCode) || ''),
    oldName: String((action && action.oldName) || '').slice(0, 80),
    newName: String((action && action.newName) || '').slice(0, 80),
    ratioNum: Number((action && action.ratioNum) || 1),
    ratioDen: Number((action && action.ratioDen) || 1),
    settlementPrice: Number((action && action.settlementPrice) || 0),
    cashPerOldShare: Number((action && action.cashPerOldShare) || 0),
    effectiveDate: String((action && action.effectiveDate) || nowIso.slice(0, 10)),
    note: String((action && action.note) || '').slice(0, 200),
    source: String((action && action.source) || 'MANUAL'),
    sourceKey: String((action && action.sourceKey) || ''),
    status: String((action && action.status) || 'ACTIVE'),
    createdBy: actorIdOf(actor),
    createdByName: actorNameOf(actor),
  };

  await pool.query(
    `INSERT INTO corporate_actions
       (id, type, old_code, new_code, old_name, new_name, ratio_num, ratio_den,
        settlement_price, cash_per_old_share, effective_date, note, source, source_key,
        status, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      rec.id, rec.type, rec.oldCode, rec.newCode, rec.oldName, rec.newName,
      rec.ratioNum, rec.ratioDen, rec.settlementPrice, rec.cashPerOldShare,
      rec.effectiveDate, rec.note, rec.source, rec.sourceKey, rec.status,
      rec.createdBy, rec.createdByName,
    ],
  );

  const full = Object.assign({}, rec, { createdAt: nowIso, updatedAt: null });
  corporateActionsCache.set(id, full);
  await audit('CORPORATE_ACTION_CREATE', actor, {
    id: rec.id, type: rec.type, oldCode: rec.oldCode, newCode: rec.newCode,
  });
  return full;
}

/** JsonStore.upsertAutoCorporateAction과 동일한 시맨틱 (자동 종목감지 파이프라인용) */
async function upsertAutoCorporateAction(action) {
  if (!action || action.type === 'NEW_LISTING') return null;
  if (action.sourceKey) {
    for (const a of corporateActionsCache.values()) {
      if (a.sourceKey === action.sourceKey) return a;
    }
  }
  return addCorporateAction(
    Object.assign({}, action, {
      source: 'AUTO',
      status: action.requiresReview ? 'PENDING_REVIEW' : 'ACTIVE',
      note:
        action.type === 'REMOVED'
          ? '공식 종목 마스터에서 사라져 거래를 자동 차단했습니다. 합병·코드변경·상장폐지 여부는 관리자 확인이 필요합니다.'
          : action.note || '',
    }),
    { id: 'system', name: '자동 종목감지' },
  );
}

/** 캐시에서 동기 조회, effectiveDate desc → createdAt desc 정렬 후 limit */
function listCorporateActions({ limit = 500 } = {}) {
  return Array.from(corporateActionsCache.values())
    .sort(
      (a, b) =>
        String(b.effectiveDate).localeCompare(String(a.effectiveDate)) ||
        String(b.createdAt).localeCompare(String(a.createdAt)),
    )
    .slice(0, limit);
}

/** 캐시에서 동기 조회 — corporateTradeBlockReason처럼 매 시세 조회마다 호출되는 경로용 */
function getEffectiveCorporateActions() {
  const today = new Date().toISOString().slice(0, 10);
  return Array.from(corporateActionsCache.values())
    .filter((a) => a.status === 'ACTIVE' && String(a.effectiveDate || '') <= today)
    .sort(
      (a, b) =>
        String(a.effectiveDate).localeCompare(String(b.effectiveDate)) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    );
}

async function updateCorporateAction(id, patch, actor) {
  const existing = corporateActionsCache.get(id);
  if (!existing) throw new Error('기업행동 기록을 찾을 수 없습니다.');

  const next = Object.assign({}, existing);
  for (const k of ['status', 'settlementPrice', 'cashPerOldShare', 'note', 'ratioNum', 'ratioDen', 'newCode', 'newName']) {
    if (patch && k in patch) next[k] = patch[k];
  }
  const updatedAtIso = new Date().toISOString();

  await pool.query(
    `UPDATE corporate_actions SET
       status = $2, settlement_price = $3, cash_per_old_share = $4, note = $5,
       ratio_num = $6, ratio_den = $7, new_code = $8, new_name = $9, updated_at = $10
     WHERE id = $1`,
    [id, next.status, next.settlementPrice, next.cashPerOldShare, next.note, next.ratioNum, next.ratioDen, next.newCode, next.newName, updatedAtIso],
  );

  next.updatedAt = updatedAtIso;
  corporateActionsCache.set(id, next);
  await audit('CORPORATE_ACTION_UPDATE', actor, { id, patch });
  return next;
}

// ── 감사 로그 ────────────────────────────────────────────────────────────────
/** fire-and-forget INSERT — 실패해도 절대 throw하지 않음(호출부에서 await 안 해도 안전) */
async function audit(action, actor, details = {}) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO audit_log (id, action, actor_id, actor_name, details) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(), action, actorIdOf(actor), actorNameOf(actor), JSON.stringify(details || {})],
    );
  } catch (err) {
    console.warn('[db] audit insert 실패:', err.message);
  }
}

// ── 인증 무차별 대입 잠금 (DB 영속, math_mon server/src/index.ts 패턴 이식) ────────
// 원문 식별자 미저장(accountHash만). scope: 'student' | 'teacher'.
// 15분 윈도우 내 10회 실패 시 15분 잠금.
const LOCKOUT_MAX_FAILS = 10;

/** 잠겨 있으면 {locked:true, remainingSec}, 아니면 {locked:false, remainingSec:0} */
async function checkLockout(scope, accountHash) {
  const r = await pool.query(
    `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int AS remaining
     FROM login_lockouts WHERE scope = $1 AND account_hash = $2 AND locked_until > now()`,
    [scope, accountHash],
  );
  const remaining = r.rows[0] ? Number(r.rows[0].remaining) : 0;
  return { locked: remaining > 0, remainingSec: remaining };
}

/** 인증 실패 1건 기록 — 15분 윈도우 내 누적, MAX_FAILS 도달 시 15분 잠금. 멱등 upsert */
async function recordAuthFail(scope, accountHash) {
  await pool.query(
    `INSERT INTO login_lockouts (scope, account_hash, fail_count, last_failed_at, locked_until)
     VALUES ($1, $2, 1, now(), NULL)
     ON CONFLICT (scope, account_hash) DO UPDATE SET
       fail_count = CASE WHEN login_lockouts.last_failed_at < now() - interval '15 minutes'
                         THEN 1 ELSE login_lockouts.fail_count + 1 END,
       locked_until = CASE WHEN (CASE WHEN login_lockouts.last_failed_at < now() - interval '15 minutes'
                                      THEN 1 ELSE login_lockouts.fail_count + 1 END) >= $3
                           THEN now() + interval '15 minutes' ELSE NULL END,
       last_failed_at = now()`,
    [scope, accountHash, LOCKOUT_MAX_FAILS],
  );
}

/** 인증 성공 시 잠금/실패 기록 제거 */
async function clearAuthFail(scope, accountHash) {
  await pool.query('DELETE FROM login_lockouts WHERE scope = $1 AND account_hash = $2', [scope, accountHash]);
}

module.exports = {
  init,
  query,
  withTransaction,
  getSetting,
  setSetting,
  addCorporateAction,
  updateCorporateAction,
  upsertAutoCorporateAction,
  listCorporateActions,
  getEffectiveCorporateActions,
  audit,
  checkLockout,
  recordAuthFail,
  clearAuthFail,
};
