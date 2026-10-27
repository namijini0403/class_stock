'use strict';

// All selected accounts and the retry receipt commit together.
async function applyTeacherBatch(db, { actor, ids, amount, reason, requestId, classCode, initialCash }, applyState) {
  const fingerprint = JSON.stringify({ ids: classCode ? [] : [...ids].sort(), amount, reason, classCode: classCode || null });
  return db.withTransaction(async client => {
    if (requestId) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [actor.id + ':' + requestId]);
      const prior = await client.query('SELECT fingerprint, response FROM teacher_batches WHERE actor_id=$1 AND request_id=$2', [actor.id, requestId]);
      if (prior.rows.length) {
        if (prior.rows[0].fingerprint !== fingerprint) throw Object.assign(new Error('같은 지급 요청의 내용이 변경되었습니다. 새로 요청하세요.'), { status: 409 });
        return prior.rows[0].response;
      }
    }
    if (classCode) {
      if (amount <= 0 || (actor.role !== 'admin' && actor.classCode !== classCode)) throw Object.assign(new Error('학급 전체 지급 권한과 금액을 확인하세요.'), { status: 403 });
      const cls=await client.query('SELECT initial_cash FROM classes WHERE code=$1 FOR UPDATE',[classCode]);
      if (!cls.rows.length) throw Object.assign(new Error('학급을 찾을 수 없습니다.'), { status: 404 });
      const startingCash=Number(cls.rows[0].initial_cash ?? initialCash)+amount;
      if (!Number.isSafeInteger(startingCash)) throw Object.assign(new Error('초기 자본금 범위를 초과합니다.'), { status: 400 });
      await client.query('UPDATE classes SET initial_cash=$2 WHERE code=$1',[classCode,startingCash]);
      ids=(await client.query('SELECT id FROM students WHERE class_code=$1 ORDER BY id',[classCode])).rows.map(r=>r.id);
    }
    const { rows } = await client.query('SELECT id, class_code, state FROM students WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    if (rows.length !== ids.length || rows.some(row => actor.role !== 'admin' && row.class_code !== actor.classCode)) {
      throw Object.assign(new Error('선택한 학생이 삭제되었거나 관리 권한이 없습니다. 명단을 새로 불러오세요. 지급은 반영되지 않았습니다.'), { status: 403 });
    }
    const results = [];
    for (const row of rows) results.push(await applyState(row, client));
    const response = { ok: true, count: results.length, results, includesFutureStudents: Boolean(classCode) };
    if (requestId) await client.query('INSERT INTO teacher_batches (actor_id, request_id, fingerprint, response) VALUES ($1,$2,$3,$4)', [actor.id, requestId, fingerprint, JSON.stringify(response)]);
    await client.query('INSERT INTO audit_log (id, action, actor_id, actor_name, details) VALUES ($1,$2,$3,$4,$5)', [require('crypto').randomUUID(), 'COMMAND_CREATE', actor.id, actor.name, JSON.stringify({ amount, reason, requestId, classCode, includesFutureStudents: Boolean(classCode), count: results.length, commands: results })]);
    return response;
  });
}

module.exports = { applyTeacherBatch };
