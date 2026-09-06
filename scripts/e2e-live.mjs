#!/usr/bin/env node
// scripts/e2e-live.mjs — 배포된 서버에 실제 학급 코드로 학생 가입→시세→차트→매수→매도→정리까지 왕복 검증
// 사용(PowerShell):
//   $env:BASE_URL='https://classstock-production.up.railway.app'; $env:CLASS_CODE='26014351'; $env:ADMIN_PASSWORD='...'; node scripts/e2e-live.mjs
// ADMIN_PASSWORD가 없으면 마지막 정리(테스트 학생 삭제)만 건너뛰고 안내를 출력한다.
// 테스트 학생 닉네임은 '점검봇'(연속 숫자 없음). 매수 1주 후 전량 매도하므로 남는 보유 종목은 없다.

const BASE = String(process.env.BASE_URL || '').replace(/\/$/, '');
const CLASS_CODE = String(process.env.CLASS_CODE || '').trim().toUpperCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const NICK = process.env.E2E_NICK || '점검봇';
const PIN = '4826';
if (!BASE || !CLASS_CODE) { console.error('BASE_URL, CLASS_CODE 환경변수가 필요합니다.'); process.exit(2); }

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}

async function main() {
  console.log(`대상: ${BASE} / 학급 ${CLASS_CODE}`);
  const h = await call('/api/health');
  ok(h.status === 200 && h.d.ok === true && h.d.db === true, `health 200/ok/db (status=${h.status}, mode=${h.d.mode})`);
  ok(h.d.mode === 'OFFICIAL_DELAYED_KR', `국내 전용 모드 (mode=${h.d.mode})`);
  const kr = h.d.marketData?.kr || {};
  ok(kr.configured === true, `공공데이터 키 설정됨 (configured=${kr.configured})`);
  ok(Number(kr.count) > 2000, `국내 시세 적재 (count=${kr.count}, asOfDate=${kr.asOfDate}, error=${kr.error || '없음'})`);

  const cfg = await call('/api/config');
  ok(cfg.status === 200 && Array.isArray(cfg.d.popular) && cfg.d.popular.length > 0, `config popular ${cfg.d.popular?.length}종목`);

  const join = await call('/api/auth/join', { method: 'POST', body: { classCode: CLASS_CODE, nickname: NICK, pin: PIN } });
  ok(join.status === 200 && join.d.accessToken, `학생 가입/로그인 (${join.status} ${join.d.error || ''})`);
  if (!join.d.accessToken) return;
  const token = join.d.accessToken;
  const studentId = join.d.studentId;
  console.log(`  학생 ${NICK} (${studentId}) 현금 ${join.d.state?.cash}`);

  const search = await call('/api/stocks?q=' + encodeURIComponent('삼성전자') + '&limit=5');
  const target = (search.d.items || []).find((s) => s.code === '005930') || (search.d.items || [])[0];
  ok(Boolean(target), `종목 검색 (${(search.d.items || []).length}건, 대상=${target?.name} ${target?.code})`);
  if (!target) return;

  const q = await call('/api/quotes?codes=' + target.code);
  const quote = (q.d.quotes || [])[0] || {};
  ok(Number(quote.price) > 0, `시세 (${target.code} ${quote.price}원, 기준일 ${quote.asOfDate}, ${quote.error || ''})`);

  for (const period of ['1m', '1y', '10y']) {
    const c = await call(`/api/chart?code=${target.code}&period=${period}`, { token });
    const bars = c.d.bars || [];
    ok(c.status === 200 && bars.length > 0, `차트 ${period}: ${bars.length}봉 (${c.d.coverageStart}~${c.d.rangeEnd}, partial=${c.d.partial}, ${c.d.error || ''})`);
  }

  const cashBefore = Number(join.d.state?.cash || 0);
  const buy = await call('/api/trade', { method: 'POST', token, body: { side: 'BUY', code: target.code, qty: 1, comment: 'E2E 점검 매수' } });
  ok(buy.status === 200 && buy.d.execution?.price > 0, `매수 1주 (${buy.status} ${buy.d.error || ''} 체결가=${buy.d.execution?.price} 수수료=${buy.d.execution?.fee})`);
  if (buy.status === 200) {
    const cashAfterBuy = Number(buy.d.state.cash);
    const expected = cashBefore - Number(buy.d.execution.price) - Number(buy.d.execution.fee);
    ok(Number.isInteger(cashAfterBuy) && cashAfterBuy === expected, `매수 후 현금 정수·일치 (${cashAfterBuy} == ${expected})`);
    ok(buy.d.state.holdings?.[target.code]?.qty === 1, `보유 1주 반영`);
    const sell = await call('/api/trade', { method: 'POST', token, body: { side: 'SELL', code: target.code, qty: 1, comment: 'E2E 점검 매도' } });
    ok(sell.status === 200 && !sell.d.state?.holdings?.[target.code], `매도 1주 → 보유 없음 (${sell.status} ${sell.d.error || ''})`);
    const over = await call('/api/trade', { method: 'POST', token, body: { side: 'SELL', code: target.code, qty: 1 } });
    ok(over.status === 400, `보유 초과 매도 거부 (${over.status} ${over.d.error || ''})`);
  }
  const me = await call('/api/me', { token });
  ok(me.status === 200 && me.d.state && Number.isInteger(me.d.state.cash), `/api/me 상태 정수 현금 (${me.d.state?.cash})`);
  const badNick = await call('/api/auth/join', { method: 'POST', body: { classCode: CLASS_CODE, nickname: '홍길동123', pin: PIN } });
  ok(badNick.status === 400, `연속 숫자 닉네임 거부 (${badNick.status})`);

  const teacherHtml = await fetch(BASE + '/teacher.html');
  ok(teacherHtml.status === 200 && /style-src 'self'/.test(teacherHtml.headers.get('content-security-policy') || ''), `teacher.html 200 + CSP`);
  const js = await fetch(BASE + '/app.js');
  ok(js.headers.get('cache-control') === 'no-cache', `app.js Cache-Control no-cache (${js.headers.get('cache-control')})`);

  if (!ADMIN_PASSWORD) { console.log(`정리 생략: ADMIN_PASSWORD 없음 — 교사 화면에서 학생 '${NICK}' 삭제 필요`); return; }
  const tl = await call('/api/teacher/login', { method: 'POST', body: { id: 'admin', password: ADMIN_PASSWORD } });
  ok(tl.status === 200 && tl.d.token, `관리자 로그인 (${tl.status} ${tl.d.error || ''})`);
  if (!tl.d.token) return;
  const roster = await call('/api/teacher/students?classCode=' + CLASS_CODE, { token: tl.d.token });
  const mine = (roster.d.students || []).find((s) => s.nickname === NICK);
  ok(roster.status === 200 && mine && Number.isInteger(mine.totalAsset), `명렬표 조회 (${roster.d.students?.length}명, 점검봇 총자산=${mine?.totalAsset})`);
  const del = await call(`/api/teacher/student/${encodeURIComponent(studentId)}/delete`, { method: 'POST', token: tl.d.token, body: { reason: 'E2E 점검 종료' } });
  ok(del.status === 200, `테스트 학생 삭제 (${del.status} ${del.d.error || ''})`);
  const after = await call('/api/me', { token });
  ok(after.status === 401 || after.status === 404, `삭제 후 토큰 무효 (${after.status})`);
}

main().then(() => { console.log(failures ? `\n실패 ${failures}건` : '\n전 항목 통과'); process.exit(failures ? 1 : 0); })
  .catch((e) => { console.error('e2e-live 오류:', e.message); process.exit(1); });
