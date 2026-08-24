#!/usr/bin/env node
// 국내 주식 전용 시장 구성 회귀 검사. DB와 외부 네트워크 없이 실행한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const universeData = JSON.parse(read('data/stock-universe.json'));
assert.ok(universeData.stocks.length >= 2500, '국내 종목 캐시가 비정상적으로 줄어들면 안 됩니다.');
assert.ok(universeData.stocks.every((stock) => /^\d{6}$/.test(stock.code)), '종목 코드는 국내 6자리 코드여야 합니다.');
assert.ok((universeData.retiredStocks || []).every((stock) => /^\d{6}$/.test(stock.code)), '비활성 종목도 국내 6자리 코드여야 합니다.');
const domesticMarkets = new Set(['KOSPI', 'KOSDAQ', 'KONEX']);
const allUniverseStocks = [...universeData.stocks, ...(universeData.retiredStocks || [])];
assert.equal(new Set(allUniverseStocks.map((stock) => stock.code)).size, allUniverseStocks.length, '활성·비활성 종목 코드가 중복되면 안 됩니다.');
assert.deepEqual([...new Set(universeData.stocks.map((stock) => stock.market))].sort(), [...domesticMarkets].sort(), '국내 세 거래소 종목을 모두 포함해야 합니다.');
const requiredStockFields = ['code', 'name', 'market', 'active', 'tradingHalt', 'liquidation', 'isinCd'];
const stockFields = new Set([...requiredStockFields, 'removedAt', 'removedReason']);
for (const stock of allUniverseStocks) {
  assert.ok(domesticMarkets.has(stock.market), `허용하지 않는 거래소가 종목 캐시에 있습니다: ${stock.market}`);
  assert.ok(requiredStockFields.every((key) => Object.hasOwn(stock, key)), `국내 종목 필수 필드가 빠졌습니다: ${stock.code}`);
  assert.ok(Object.keys(stock).every((key) => stockFields.has(key)), `국내 종목 허용 필드가 아닌 값이 있습니다: ${stock.code}`);
}

const { StockUniverse } = require(path.join(ROOT, 'lib/universe.js'));
const domestic = require(path.join(ROOT, 'lib/domestic.js'));
const { isDomesticCode, domesticCorporateActions, domesticStateView } = domestic;
assert.deepEqual(Object.keys(domestic).sort(), ['domesticCorporateActions', 'domesticStateView', 'isDomesticCode', 'isDomesticTransaction', 'normalizeDomesticMarket'], '국내 상태 모듈은 현재 국내 전용 경계만 노출해야 합니다.');
const universe = new StockUniverse(path.join(ROOT, 'data/stock-universe.json'));
assert.equal(universe.search('', { market: 'GLOBAL' }).total, 0, '국내 거래소가 아닌 시장 검색 결과는 0개여야 합니다.');
assert.equal(universe.resolveCode('ABC123'), '', '6자리 숫자가 아닌 코드를 종목 코드로 해석하면 안 됩니다.');
assert.equal(isDomesticCode('005930'), true, '국내 6자리 종목코드를 허용해야 합니다.');
assert.equal(isDomesticCode('ABC123'), false, '숫자 6자리가 아닌 종목코드는 거부해야 합니다.');
assert.equal(isDomesticCode(' 005930 '), false, '공백이 섞인 종목코드는 정규 코드로 허용하면 안 됩니다.');

const rawState = {
  schema: 3,
  accountId: 'student-1',
  grade: '6',
  classNo: '1',
  studentNo: '',
  name: '테스트학생',
  cash: 500000,
  initialCash: 500000,
  teacherNetAdjustments: 1000,
  realizedPnl: 2000,
  totalFees: 300,
  corporateActionsApplied: ['action-1'],
  version: 4,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  metadata: { unexpected: true },
  holdings: {
    '005930': { qty: 2, avgPrice: 70000, name: '삼성전자', status: 'ACTIVE', valuationPrice: 71000, unexpected: true },
    ABC123: { qty: 1, avgPrice: 100, name: '비국내 종목' },
    '999999': { qty: 1, avgPrice: 100, name: '잘못된 거래소 종목', market: 'GLOBAL' },
    ' 000660 ': { qty: 1, avgPrice: 100000, name: '공백 코드' },
  },
  transactions: [
    { id: 'domestic-trade', type: 'TRADE', at: '2026-08-18T01:00:00.000Z', side: 'BUY', code: '005930', name: '삼성전자', market: 'KOSPI', qty: 2, price: 70000, amount: 140000, grossAmount: 140000, fee: 140, feeRate: 0.001, netAmount: -140140, comment: '수업 거래', commentUpdatedAt: '2026-08-18T02:00:00.000Z', quoteSource: 'PUBLIC_DATA_KR', quoteSourceLabel: '공공데이터', quoteAsOfDate: '2026-08-18', unexpected: true },
    { id: 'kosdaq-trade', type: 'TRADE', code: '247540', market: 'kosdaq', price: 100000 },
    { id: 'konex-trade', type: 'TRADE', code: '296520', market: 'KONEX', price: 5000 },
    { id: 'marketless-trade', type: 'TRADE', code: '005930', price: 70000 },
    { id: 'foreign-trade', type: 'TRADE', code: 'ABC123', price: 100 },
    { id: 'invalid-market-trade', type: 'TRADE', code: '999999', market: 'GLOBAL', price: 100 },
    { id: 'domestic-action', type: 'CORPORATE', at: '2026-08-18T03:00:00.000Z', side: 'CODE_CHANGE', code: '005930', newCode: '000660', name: '삼성전자', newName: 'SK하이닉스', qty: 2, price: 0, amount: 0, signedAmount: 0, reason: '수업 기업행동', detail: '코드 변경', corporateActionId: 'action-1', unexpected: true },
    { id: 'foreign-action', type: 'CORPORATE', code: 'ABC123', newCode: '' },
    { id: 'empty-trade', type: 'TRADE', code: '', price: 100 },
    { id: 'empty-action', type: 'CORPORATE', code: '', newCode: '' },
    { id: 'unknown', type: 'UNKNOWN', code: '' },
    { id: 'teacher', type: 'TEACHER', at: '2026-08-18T04:00:00.000Z', side: 'GIVE', name: '교사 지급/차감', code: '', qty: 0, price: 0, amount: 1000, signedAmount: 1000, requestedAmount: 1000, reason: '수업 지원', commandId: 'command-1', teacherName: '담임', unexpected: true },
  ],
};
const rawSnapshot = JSON.stringify(rawState);
const stateView = domesticStateView(rawState);
assert.ok(!('metadata' in stateView), '학생 상태는 신규 국내 전용 스키마의 허용 필드만 반환해야 합니다.');
assert.equal(stateView.updatedAt, rawState.updatedAt, '거래 응답에 필요한 상태 갱신 시각을 보존해야 합니다.');
assert.deepEqual(Object.keys(stateView.holdings), ['005930'], '학생 화면에는 국내 보유 종목만 노출해야 합니다.');
assert.deepEqual(stateView.holdings['005930'], { qty: 2, avgPrice: 70000, name: '삼성전자', status: 'ACTIVE', valuationPrice: 71000 }, '보유 종목은 국내 전용 허용 필드만 보존해야 합니다.');
assert.deepEqual(stateView.transactions.map((tx) => tx.id), ['domestic-trade', 'kosdaq-trade', 'konex-trade', 'domestic-action', 'teacher'], '국내 주식 기록과 교사 기록만 노출해야 합니다.');
assert.deepEqual(stateView.transactions.slice(0, 3).map((tx) => tx.market), ['KOSPI', 'KOSDAQ', 'KONEX'], '국내 거래소 값은 세 가지 정규값으로만 반환해야 합니다.');
assert.ok(!('unexpected' in stateView.transactions[0]), '거래 기록은 유형별 허용 필드만 반환해야 합니다.');
const teacherView = stateView.transactions.find((tx) => tx.type === 'TEACHER');
assert.ok(!('code' in teacherView) && !('market' in teacherView), '교사 지급 기록에 오염된 주식 필드를 노출하면 안 됩니다.');
assert.equal(JSON.stringify(rawState), rawSnapshot, '화면용 국내 상태 생성은 DB 원본을 변경하면 안 됩니다.');
const expectedStateFields = ['schema', 'accountId', 'grade', 'classNo', 'studentNo', 'name', 'cash', 'initialCash', 'teacherNetAdjustments', 'realizedPnl', 'totalFees', 'corporateActionsApplied', 'version', 'createdAt', 'updatedAt'];
assert.deepEqual(Object.keys(stateView).sort(), [...expectedStateFields, 'holdings', 'transactions'].sort(), '학생 상태 최상위 응답도 허용된 현재 필드만 포함해야 합니다.');
for (const field of expectedStateFields) assert.deepEqual(stateView[field], rawState[field], `학생 상태 필드를 보존해야 합니다: ${field}`);
assert.deepEqual(Object.keys(stateView.transactions[0]).sort(), ['id', 'type', 'at', 'side', 'code', 'name', 'market', 'qty', 'price', 'amount', 'grossAmount', 'fee', 'feeRate', 'netAmount', 'comment', 'commentUpdatedAt', 'quoteSource', 'quoteSourceLabel', 'quoteAsOfDate'].sort(), '국내 거래 기록은 현재 허용 필드를 모두 보존해야 합니다.');
assert.deepEqual(Object.keys(stateView.transactions[3]).sort(), ['id', 'type', 'at', 'side', 'code', 'newCode', 'name', 'newName', 'qty', 'price', 'amount', 'signedAmount', 'reason', 'detail', 'corporateActionId'].sort(), '기업행동 기록은 현재 허용 필드를 모두 보존해야 합니다.');
assert.deepEqual(Object.keys(teacherView).sort(), ['id', 'type', 'at', 'side', 'name', 'qty', 'price', 'amount', 'signedAmount', 'requestedAmount', 'reason', 'commandId', 'teacherName'].sort(), '교사 지급 기록은 현재 허용 필드를 모두 보존해야 합니다.');
assert.deepEqual(domesticStateView(stateView), stateView, '국내 상태 투영은 반복 적용해도 결과가 같아야 합니다.');
assert.deepEqual(domesticCorporateActions([
  { id: 'domestic', oldCode: '005930', newCode: '000660' },
  { id: 'domestic-empty', oldCode: '005930', newCode: '' },
  { id: 'invalid-old', oldCode: 'ABC123', newCode: '' },
  { id: 'invalid-new', oldCode: '005930', newCode: 'ABC123' },
  { id: 'spaced-old', oldCode: ' 005930 ', newCode: '000660' },
]).map((action) => action.id), ['domestic', 'domestic-empty'], '기업행동의 기존·신규 코드가 모두 국내 코드여야 합니다.');

const {
  MarketDataService, DAY_MS, MARKET_RETRY_MS, HISTORY_RETRY_MS,
  HISTORY_PERIODS, DEFAULT_HISTORY_PERIOD, HISTORY_ROWS_PER_PAGE, HISTORY_MAX_CALENDAR_ROWS, HISTORY_MAX_PAGES, HISTORY_HEAD_OVERLAP_DAYS,
  HISTORY_MAX_CONCURRENCY, HISTORY_QUEUE_LIMIT, HISTORY_DAILY_BUDGET, HISTORY_CACHE_LIMIT, HISTORY_CACHE_BAR_LIMIT, historyRange,
} = require(path.join(ROOT, 'lib/market-data.js'));
const { msUntilNextKstRefresh, shouldForceInitialKstRefresh } = require(path.join(ROOT, 'lib/daily-refresh.js'));
assert.equal(MARKET_RETRY_MS, 30 * 60 * 1000, '시세 공급자 오류 재시도는 30분 간격이어야 합니다.');
assert.equal(HISTORY_RETRY_MS, MARKET_RETRY_MS, '일봉 오류 재시도도 같은 제한 간격을 사용해야 합니다.');
assert.equal(HISTORY_MAX_CONCURRENCY, 2, '일봉 공급자 동시 호출 상한은 2여야 합니다.');
assert.equal(HISTORY_QUEUE_LIMIT, 20, '일봉 공급자 대기열은 제한된 요청 수만 받아야 합니다.');
assert.equal(HISTORY_DAILY_BUDGET, 4000, '일봉 호출은 공공데이터 일일 한도보다 낮은 내부 예산으로 보호해야 합니다.');
assert.deepEqual(HISTORY_PERIODS, { '1m':1, '3m':3, '6m':6, '1y':12, '3y':36, '5y':60, '10y':120 }, '일봉 기간 화이트리스트를 임의로 넓히면 안 됩니다.');
assert.equal(DEFAULT_HISTORY_PERIOD, '1m', '기본 일봉 기간은 1개월이어야 합니다.');
assert.equal(HISTORY_ROWS_PER_PAGE, 500);
assert.equal(HISTORY_MAX_CALENDAR_ROWS, 3654);
assert.equal(HISTORY_MAX_PAGES, 8);
assert.equal(HISTORY_HEAD_OVERLAP_DAYS, 20);
assert.equal(HISTORY_CACHE_LIMIT, 64, '일봉 메모리 캐시는 최대 64종목만 보관해야 합니다.');
assert.equal(HISTORY_CACHE_BAR_LIMIT, 100000, '일봉 메모리 캐시는 총 봉 수도 제한해야 합니다.');
assert.deepEqual(historyRange('1m',Date.parse('2026-03-31T03:00:00.000Z')), {period:'1m',months:1,beginBasDt:'20260228',endBasDt:'20260401',requestedRangeStart:'2026-02-28',rangeEnd:'2026-03-31',calendarRows:32}, '월말은 이전 달 마지막 날로 clamp해야 합니다.');
assert.equal(historyRange('1y',Date.parse('2028-02-29T03:00:00.000Z')).beginBasDt, '20270228', '윤일에서 1년 전은 2월 말일이어야 합니다.');
assert.equal(historyRange('10y',Date.parse('2021-03-01T03:00:00.000Z')).calendarRows, 3654, '10년 범위의 윤일 포함 절대 상한을 허용해야 합니다.');
assert.throws(() => historyRange('11y'), /지원하지 않는/, '화이트리스트 밖 기간은 거부해야 합니다.');
const schedulerNow = Date.parse('2026-08-24T05:30:00.000Z'); // 한국시간 14:30
const schedulerPreviousSuccess = Date.parse('2026-08-23T06:00:00.000Z'); // 전날 한국시간 15:00
assert.equal(msUntilNextKstRefresh(Date.parse('2026-08-24T04:59:00.000Z'), 14, 10), 11 * 60 * 1000, '14:10 전에는 당일 공개 확인 시각까지 기다려야 합니다.');
assert.equal(msUntilNextKstRefresh(schedulerNow, 14, 10), (23 * 60 + 40) * 60 * 1000, '14:10 뒤에는 다음 날 공개 확인 시각을 예약해야 합니다.');
assert.equal(shouldForceInitialKstRefresh(schedulerPreviousSuccess, schedulerNow, 14, 10), true, '전날 15시 성공 뒤 다음 날 14:30에 재시작해도 당일 갱신을 건너뛰면 안 됩니다.');
assert.equal(shouldForceInitialKstRefresh(Date.parse('2026-08-24T05:15:00.000Z'), schedulerNow, 14, 10), false, '당일 공개 확인 시각 뒤 이미 성공했다면 재시작 직후 중복 강제 호출하면 안 됩니다.');
const tempDir = mkdtempSync(path.join(tmpdir(), 'class-stock-kr-check-'));
try {
  const invalidUniverseFile = path.join(tempDir, 'invalid-universe.json');
  writeFileSync(invalidUniverseFile, JSON.stringify({
    source: 'INVALID_INPUT_TEST',
    stocks: [
      { code: '005930', name: '삼성전자', market: 'KOSPI' },
      { code: 'ABC123', name: '비국내 종목', market: 'GLOBAL' },
      { code: '999999', name: '잘못된 거래소 종목', market: 'GLOBAL' },
    ],
    retiredStocks: [
      { code: '005930', name: '삼성전자 구형 중복', market: 'KOSPI' },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI' },
      { code: 'XYZ789', name: '비국내 비활성 종목', market: 'GLOBAL' },
      { code: '888888', name: '잘못된 거래소 비활성 종목', market: 'GLOBAL' },
    ],
  }), 'utf8');
  const invalidUniverse = new StockUniverse(invalidUniverseFile);
  assert.deepEqual(invalidUniverse.stocks.map((stock) => stock.code), ['005930'], '유효하지 않은 입력의 비국내 활성 종목을 로드하면 안 됩니다.');
  assert.deepEqual([...invalidUniverse.retired.keys()], ['000660'], '유효하지 않은 입력의 비국내 비활성 종목을 로드하면 안 됩니다.');
  assert.equal(invalidUniverse.lookup('ABC123'), null, '비국내 종목은 직접 조회할 수 없어야 합니다.');

  const eventFile = path.join(tempDir, 'event-universe.json');
  const eventStocks = [
    { code: '005930', name: '삼성전자', market: 'KOSPI' },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  ];
  const eventUniverse = new StockUniverse(eventFile, eventStocks);
  const removed = eventUniverse.replaceStocks(eventStocks.slice(0, 1), { source: 'TEST', updatedAt: '2026-08-18T00:00:00.000Z' });
  assert.ok(removed.some((event) => event.type === 'REMOVED' && event.oldCode === '000660'), '사라진 국내 종목은 REMOVED 이벤트를 만들어야 합니다.');
  const restored = eventUniverse.replaceStocks(eventStocks, { source: 'TEST', updatedAt: '2026-08-19T00:00:00.000Z' });
  assert.ok(restored.some((event) => event.type === 'RESTORED' && event.oldCode === '000660'), '다시 나타난 국내 종목은 RESTORED 이벤트를 만들어야 합니다.');

  const tempUniverse = new StockUniverse(path.join(tempDir, 'universe.json'), [
    { code: '005930', name: '삼성전자', market: 'KOSPI' },
  ]);
  const cacheDir = path.join(tempDir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const cacheUniverse = new StockUniverse(path.join(cacheDir, 'universe.json'), eventStocks);
  const cacheItems = Array.from({ length: 120 }, (_, index) => ({
    code: String(index + 1).padStart(6, '0'), name: `캐시종목${index + 1}`, market: 'KOSPI', price: 1000,
    change: 10, changeRate: 1, asOfDate: '2026-08-18', updatedAt: 1_000,
  }));
  cacheItems.push({ code: '777777', name: '잘못된 거래소 캐시', market: 'GLOBAL-KOSPI', price: 1000 });
  writeFileSync(path.join(cacheDir, 'kr-public-prices.json'), JSON.stringify({ meta: { updatedAt: 1_000 }, items: cacheItems }), 'utf8');
  const cacheService = new MarketDataService({ dataDir: cacheDir, universe: cacheUniverse, serviceKey: '' });
  const cachedQuote = cacheService.quote({ code: '000001', name: '캐시종목1', market: 'KOSPI', active: true });
  const availableQuoteFields = ['active', 'asOfDate', 'attribution', 'change', 'changeRate', 'code', 'delayed', 'high', 'isinCd', 'liquidation', 'listedShares', 'low', 'market', 'marketCap', 'name', 'open', 'price', 'source', 'sourceLabel', 'tradeValue', 'tradingHalt', 'updatedAt', 'volume'];
  const unavailableQuoteFields = ['active', 'asOfDate', 'change', 'changeRate', 'code', 'delayed', 'market', 'name', 'price', 'source', 'sourceLabel', 'status', 'tradingHalt', 'updatedAt'];
  assert.deepEqual(Object.keys(cachedQuote).sort(), availableQuoteFields, '국내 캐시 시세는 현재 허용 필드를 정확히 반환해야 합니다.');
  assert.equal(cacheUniverse.lookup('777777'), null, '허용하지 않는 거래소의 캐시 종목은 로드하면 안 됩니다.');

  const marketData = new MarketDataService({
    dataDir: tempDir,
    universe: tempUniverse,
    serviceKey: '',
    refreshMs: 3_600_000,
  });
  const status = marketData.status();
  assert.deepEqual(Object.keys(status), ['kr'], '시세 상태에는 국내 시장만 있어야 합니다.');
  assert.equal(status.kr.refreshMs, 86_400_000, '국내 공공데이터 확인 주기는 하루여야 합니다.');

  const clamped = new MarketDataService({ dataDir: path.join(tempDir, 'clamped'), universe: tempUniverse, serviceKey: '', refreshMs: 1 });
  assert.equal(clamped.status().kr.refreshMs, 86_400_000, '하루보다 짧은 확인 주기는 허용하면 안 됩니다.');
  const fixed = new MarketDataService({ dataDir: path.join(tempDir, 'fixed'), universe: tempUniverse, serviceKey: '', refreshMs: 10_800_000 });
  assert.equal(fixed.status().kr.refreshMs, 86_400_000, '기존 서버 설정이 남아 있어도 확인 주기는 정확히 하루여야 합니다.');

  const rows = Array.from({ length: 120 }, (_, index) => ({
    srtnCd: String(index + 1).padStart(6, '0'), itmsNm: `테스트${index + 1}`, mrktCtg: 'KOSPI',
    clpr: '1000', vs: '10', fltRt: '1', basDt: '20260818',
  }));
  const invalidMarketRow = { srtnCd: '777777', itmsNm: '잘못된 거래소 응답', mrktCtg: 'GLOBAL-KOSPI', clpr: '1000', basDt: '20260818' };
  const rowsForDate = (basDt, source = rows) => source.map((row) => ({ ...row, basDt }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ response: { header: { resultCode: '00' }, body: { totalCount: 120, items: { item: rows.slice(0, 100) } } } }),
  });
  try {
    await assert.rejects(() => marketData.fetchKrDate('20260818'), /누락|부족/, '공공데이터 totalCount보다 실제 행이 적으면 응답을 거부해야 합니다.');
  } finally {
    globalThis.fetch = realFetch;
  }
  let fetchCount = 0;
  let fakeNow = 2_000_000_000_000;
  const realDateNow = Date.now;
  const realWarn = console.warn;
  Date.now = () => fakeNow;
  console.warn = () => {};
  try {
    marketData.serviceKey = 'TEST_KEY';
    marketData.fetchKrDate = async (basDt) => { fetchCount++; return rowsForDate(basDt, [...rows, invalidMarketRow]); };
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 1, '첫 국내 시세 확인은 공공데이터를 한 번 호출해야 합니다.');
    assert.equal(marketData.kr.has('777777'), false, '허용하지 않는 거래소의 공급자 응답은 시세에 저장하면 안 됩니다.');
    assert.equal(tempUniverse.lookup('777777'), null, '허용하지 않는 거래소의 공급자 응답은 종목 목록에 저장하면 안 됩니다.');
    const availableQuote = marketData.quote({ code: '000001', name: '테스트1', market: 'KOSPI', active: true });
    const unavailableQuote = marketData.quote({ code: '999999', name: '미수집', market: 'KOSPI', active: true });
    assert.deepEqual(Object.keys(availableQuote).sort(), availableQuoteFields, '수집된 시세는 국내 전용 허용 필드를 정확히 반환해야 합니다.');
    assert.deepEqual(Object.keys(unavailableQuote).sort(), unavailableQuoteFields, '미수집 시세도 국내 전용 허용 필드를 정확히 반환해야 합니다.');

    const eventRetryDir = path.join(tempDir, 'event-retry');
    const eventRetryUniverse = new StockUniverse(path.join(eventRetryDir, 'universe.json'), []);
    eventRetryUniverse.setStocks(
      [
        ...rows.slice(1).map((row) => ({ code: row.srtnCd, name: row.itmsNm, market: 'KOSPI' })),
        { code: '999999', name: '제외 예정', market: 'KOSPI' },
      ],
      'TEST_CONFIRMED',
      '2026-08-20T05:10:00.000Z',
      [{ code: '000001', name: '테스트1', market: 'KOSPI', active: false, removedAt: '2026-08-19T05:10:00.000Z' }],
    );
    let eventRecordAttempts = 0, firstEventBatch = [], simulatedDbInsertCount = 0;
    const simulatedDbSourceKeys = new Set();
    const eventRetryService = new MarketDataService({
      dataDir: eventRetryDir,
      universe: eventRetryUniverse,
      serviceKey: 'TEST_KEY',
      recordEvents: async (events) => {
        eventRecordAttempts++;
        if (!firstEventBatch.length) firstEventBatch = events.map((event) => event.sourceKey);
        for (const event of events) {
          if (!simulatedDbSourceKeys.has(event.sourceKey)) { simulatedDbSourceKeys.add(event.sourceKey); simulatedDbInsertCount++; }
          if (eventRecordAttempts === 1) throw new Error('의도한 기업행동 DB 부분 기록 실패');
        }
      },
    });
    const eventRetryStart = fakeNow;
    eventRetryService.fetchKrDate = async (basDt) => rowsForDate(basDt);
    const eventRecordFailed = await eventRetryService.refreshKr(true);
    assert.match(eventRecordFailed.error, /의도한 기업행동 DB 부분 기록 실패/, '기업행동 DB 부분 기록 실패를 시세 갱신 성공으로 처리하면 안 됩니다.');
    assert.deepEqual(firstEventBatch.map((key) => key.split(':')[0]).sort(), ['REMOVED', 'RESTORED'], '부분 기록 재시도 검사는 목록 제외와 복구를 모두 포함해야 합니다.');
    assert.equal(eventRetryUniverse.lookup('000001').active, false, '기업행동 DB 기록 전에 복구 종목을 활성화하면 재시도 이벤트가 사라집니다.');
    assert.equal(eventRetryUniverse.lookup('999999').active, true, '기업행동 DB 기록 전에 제외 종목을 비활성화하면 재시도 이벤트가 사라집니다.');
    assert.equal(eventRetryService.kr.size, 0, '기업행동 DB 기록 실패 전에 새 시세 메모리를 확정하면 안 됩니다.');
    assert.equal(existsSync(path.join(eventRetryDir, 'kr-public-prices.json')), false, '기업행동 DB 기록 실패 전에 새 시세 캐시를 확정하면 안 됩니다.');
    fakeNow += DAY_MS;
    const eventRecordRetried = await eventRetryService.refreshKr(true);
    assert.equal(eventRecordRetried.error, '', '기업행동 DB가 회복되면 같은 시세 갱신을 다시 완료해야 합니다.');
    assert.equal(eventRecordAttempts, 2, '기업행동 DB 기록 실패 뒤 동일 이벤트 묶음을 재시도해야 합니다.');
    assert.deepEqual(eventRecordRetried.events.map((event) => event.sourceKey), firstEventBatch, '기업행동 재시도는 최초와 같은 멱등 키를 사용해야 합니다.');
    assert.equal(simulatedDbInsertCount, 2, '자정을 넘긴 부분 재시도에서도 같은 기업행동을 중복 삽입하면 안 됩니다.');
    assert.equal(eventRetryUniverse.lookup('000001').active, true, '기업행동 기록 성공 뒤 복구 종목을 활성화해야 합니다.');
    assert.equal(eventRetryUniverse.lookup('999999').active, false, '기업행동 기록 성공 뒤 제외 종목을 비활성화해야 합니다.');
    assert.equal(eventRetryService.kr.size, 120, '기업행동 기록 성공 뒤 새 시세를 확정해야 합니다.');
    fakeNow = eventRetryStart;

    fakeNow += 86_399_999;
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 1, '하루가 되기 전에는 공공데이터를 다시 호출하면 안 됩니다.');
    fakeNow += 1;
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 2, '정확히 하루가 지나면 공공데이터를 다시 호출해야 합니다.');

    marketData.fetchKrDate = async (basDt) => { fetchCount++; await new Promise((resolve) => setImmediate(resolve)); return rowsForDate(basDt); };
    await Promise.all([marketData.refreshKr(true), marketData.refreshKr(true), marketData.refreshKr(true)]);
    assert.equal(fetchCount, 3, '동시 갱신 요청은 하나의 공공데이터 호출로 합쳐야 합니다.');

    const beforeEntries = JSON.stringify([...marketData.kr.entries()]);
    const beforeCache = readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8');
    const latestFakeNow = fakeNow;
    fakeNow -= DAY_MS;
    marketData.fetchKrDate = async (basDt) => rowsForDate(basDt);
    const regressive = await marketData.refreshKr(true);
    assert.match(regressive.error, /기준일이 마지막 정상 기준일보다 이전/, '과거 기준일 응답은 마지막 정상 시세를 덮지 못해야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '기준일이 역행한 응답에도 마지막 정상 시세를 보존해야 합니다.');
    assert.equal(readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8'), beforeCache, '기준일이 역행한 응답에도 마지막 정상 캐시 파일을 보존해야 합니다.');
    fakeNow = latestFakeNow;
    marketData.fetchKrDate = async () => { throw new Error('의도한 네트워크 실패'); };
    const failed = await marketData.refreshKr(true);
    assert.match(failed.error, /의도한 네트워크 실패/, '갱신 실패 원인을 상태에 남겨야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '갱신 실패 시 마지막 정상 시세를 보존해야 합니다.');
    assert.equal(readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8'), beforeCache, '갱신 실패 시 마지막 정상 캐시 파일을 보존해야 합니다.');

    marketData.fetchKrDate = async (basDt) => rowsForDate(basDt, [...rows.slice(0, 80), ...rows.slice(0, 40)]);
    const duplicated = await marketData.refreshKr(true);
    assert.ok(duplicated.error, '중복 행으로 고유 종목이 크게 줄어든 응답은 거부해야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '중복·부분 응답이 마지막 정상 시세를 덮으면 안 됩니다.');

    marketData.fetchKrDate = async (basDt) => rowsForDate(basDt, rows.slice(0, 100));
    const partial = await marketData.refreshKr(true);
    assert.ok(partial.error, '이전 정상 종목 수보다 크게 줄어든 부분 응답은 거부해야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '부분 응답이 마지막 정상 시세를 덮으면 안 됩니다.');

    const fsModule = require('node:fs');
    const realRenameSync = fsModule.renameSync;
    marketData.fetchKrDate = async (basDt) => rowsForDate(basDt);
    fsModule.renameSync = () => { throw new Error('의도한 디스크 교체 실패'); };
    try {
      const diskFailed = await marketData.refreshKr(true);
      assert.match(diskFailed.error, /의도한 디스크 교체 실패/, '캐시 파일 교체 실패를 상태에 남겨야 합니다.');
      assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '캐시 파일 교체 실패 시 마지막 정상 메모리 시세를 보존해야 합니다.');
      assert.equal(readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8'), beforeCache, '캐시 파일 교체 실패 시 마지막 정상 파일을 보존해야 합니다.');
    } finally {
      fsModule.renameSync = realRenameSync;
    }

    const emptyUniverse = new StockUniverse(path.join(tempDir, 'empty-universe.json'), eventStocks);
    const failingMarket = new MarketDataService({ dataDir: path.join(tempDir, 'failing'), universe: emptyUniverse, serviceKey: 'TEST_KEY' });
    let failureCalls = 0;
    failingMarket.fetchKrDate = async () => { failureCalls++; throw new Error('계속 실패'); };
    await failingMarket.refreshKr(false);
    await failingMarket.refreshKr(false);
    assert.equal(failureCalls, 1, '실패 직후 비강제 요청이 외부 조회를 반복하면 안 됩니다.');
    fakeNow += MARKET_RETRY_MS - 1;
    await failingMarket.refreshKr(false);
    assert.equal(failureCalls, 1, '오류 재시도 간격 직전에는 외부 조회를 반복하면 안 됩니다.');
    fakeNow += 1;
    await failingMarket.refreshKr(false);
    assert.equal(failureCalls, 2, '실패 뒤 30분이 지나면 제한된 외부 조회를 다시 시도해야 합니다.');
  } finally {
    Date.now = realDateNow;
    console.warn = realWarn;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const chartTempDir = mkdtempSync(path.join(tmpdir(), 'class-stock-chart-check-'));
const chartRealFetch = globalThis.fetch;
const realDateNow = Date.now;
try {
  const chartUniverse = new StockUniverse(path.join(chartTempDir, 'universe.json'), [
    { code: '005930', name: '삼성전자', market: 'KOSPI' },
  ]);
  const fixedNow = Date.parse('2026-08-24T03:00:00.000Z');
  Date.now = () => fixedNow;

  const compactDay = (compact, offset) => {
    const date = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)) + offset));
    return String(date.getUTCFullYear()) + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0');
  };
  const historyRow = (code, compact, index = 0) => ({
    srtnCd: code,
    itmsNm: '테스트종목',
    mrktCtg: 'KOSPI',
    basDt: compact,
    mkp: String(1000 + index),
    hipr: String(1010 + index),
    lopr: String(990 + index),
    clpr: String(1005 + index),
    trqu: String(100 + index),
  });
  const pagedMock = (total, mutate = null) => {
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input)), page = Number(url.searchParams.get('pageNo'));
      calls.push({ page, url });
      const begin = url.searchParams.get('beginBasDt');
      const offset = (page - 1) * HISTORY_ROWS_PER_PAGE;
      const count = Math.min(HISTORY_ROWS_PER_PAGE, Math.max(0, total - offset));
      let spec = {
        ok: true,
        status: 200,
        total,
        header: { resultCode: '00' },
        items: Array.from({ length: count }, (_, local) => historyRow('005930', compactDay(begin, offset + local), offset + local)),
      };
      if (mutate) spec = { ...spec, ...(mutate({ ...spec, page, begin, offset, url }) || {}) };
      return {
        ok: spec.ok,
        status: spec.status,
        json: async () => ({
          response: {
            header: spec.header,
            body: { totalCount: spec.total, pageNo: page, numOfRows: HISTORY_ROWS_PER_PAGE, items: { item: spec.items } },
          },
        }),
      };
    };
    return calls;
  };

  const tenYearRange = historyRange('10y', Date.parse('2021-03-01T03:00:00.000Z'));
  for (const [total, expectedPages] of [[0, 1], [500, 1], [501, 2], [2501, 6], [3654, 8]]) {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'pages-' + total), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    const calls = pagedMock(total);
    const bars = await service.fetchKrHistory('005930', tenYearRange);
    assert.equal(bars.length, total, '정상 다중 페이지 행 수를 모두 반환해야 합니다: ' + total);
    assert.deepEqual(calls.map((call) => call.page), Array.from({ length: expectedPages }, (_, index) => index + 1), '필요한 페이지를 정확히 한 번씩 요청해야 합니다: ' + total);
    assert.equal(service.historyBudgetUsed, expectedPages, '논리 요청이 아니라 실제 페이지 수를 예산으로 계산해야 합니다: ' + total);
  }

  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'too-many'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    const calls = pagedMock(3655);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /응답 범위/, '10년 달력일 수보다 많은 행은 첫 페이지 뒤 즉시 거부해야 합니다.');
    assert.equal(calls.length, 1);
    assert.equal(service.historyBudgetUsed, 1);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'http-error'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(501, ({ page }) => page === 2 ? { ok: false, status: 503 } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /2페이지 HTTP 503/);
    assert.equal(service.historyBudgetUsed, 2, '첫 응답 뒤 계산한 남은 페이지 예산은 공급자 호출 전에 선예약해야 합니다.');
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'header-error'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(501, ({ page }) => page === 2 ? { header: { resultCode: '05', resultMsg: 'TIMEOUT' } } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /TIMEOUT/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'total-change'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(501, ({ page }) => page === 2 ? { total: 500 } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /totalCount가 페이지마다/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'empty-middle'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(1001, ({ page }) => page === 2 ? { items: [] } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /2페이지 응답 누락/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'repeated-page'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(1000, ({ page, begin }) => page === 2 ? {
      items: Array.from({ length: 500 }, (_, index) => historyRow('005930', compactDay(begin, index), index)),
    } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /페이지가 반복/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'duplicate-date'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(501, ({ page, begin }) => page === 2 ? { items: [historyRow('005930', begin, 500)] } : null);
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /날짜가 중복/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'bad-row'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    pagedMock(1, ({ items }) => ({ items: [{ ...items[0], srtnCd: '000660' }] }));
    await assert.rejects(() => service.fetchKrHistory('005930', tenYearRange), /잘못된 종목코드/);
  }
  {
    const service = new MarketDataService({ dataDir: path.join(chartTempDir, 'budget'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
    service.reserveHistoryBudget(HISTORY_DAILY_BUDGET - 1);
    const calls = pagedMock(501);
    await assert.rejects(
      () => service.fetchKrHistory('005930', tenYearRange),
      (error) => error?.code === 'HISTORY_DAILY_BUDGET' && error?.statusCode === 503,
      '남은 페이지를 선예약할 수 없으면 두 번째 페이지 전에 503으로 중단해야 합니다.',
    );
    assert.equal(calls.length, 1);
    assert.equal(service.historyBudgetUsed, HISTORY_DAILY_BUDGET);
  }

  const simpleBars = (segment) => {
    const length = Math.max(1, Math.round((Date.UTC(
      Number(segment.endBasDt.slice(0, 4)), Number(segment.endBasDt.slice(4, 6)) - 1, Number(segment.endBasDt.slice(6, 8)),
    ) - Date.UTC(
      Number(segment.beginBasDt.slice(0, 4)), Number(segment.beginBasDt.slice(4, 6)) - 1, Number(segment.beginBasDt.slice(6, 8)),
    )) / DAY_MS));
    const offsets = [...new Set([0, Math.floor((length - 1) / 2), length - 1])];
    return offsets.map((offset) => ({
      date: compactDay(segment.beginBasDt, offset).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      open: 1000 + offset,
      high: 1010 + offset,
      low: 990 + offset,
      close: 1005 + offset,
      volume: 100 + offset,
      change: 999,
      changeRate: 999,
    }));
  };

  const coverageService = new MarketDataService({ dataDir: path.join(chartTempDir, 'coverage'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const coverageCalls = [];
  coverageService.fetchKrHistory = async (code, segment) => {
    coverageCalls.push({ code, ...segment });
    return simpleBars(segment);
  };
  const oneYear = await coverageService.dailyChart(chartUniverse.lookup('005930'), { period: '1y' });
  assert.equal(oneYear.period, '1y');
  assert.equal(oneYear.months, 12);
  assert.equal(oneYear.periodBasis, 'calendar-period');
  assert.equal(oneYear.requestedRangeStart, '2025-08-24');
  assert.equal(oneYear.rangeEnd, '2026-08-24');
  assert.equal(oneYear.coverageStart, oneYear.requestedRangeStart);
  assert.equal(oneYear.partial, false);
  assert.equal(coverageCalls.length, 1);

  const tenYear = await coverageService.dailyChart(chartUniverse.lookup('005930'), { period: '10y' });
  assert.equal(coverageCalls.length, 2, '1년 뒤 10년 조회는 빠진 과거 구간만 한 번 확장해야 합니다.');
  assert.equal(coverageCalls[1].beginBasDt, '20160824');
  assert.equal(coverageCalls[1].endBasDt, '20250824');
  assert.equal(tenYear.coverageStart, '2016-08-24');
  assert.equal(tenYear.partial, false);
  const callsBeforeShorter = coverageCalls.length;
  const oneMonthFromWideCache = await coverageService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  assert.equal(coverageCalls.length, callsBeforeShorter, '10년 cache가 있으면 1개월 요청은 공급자를 호출하지 않아야 합니다.');
  assert.equal(oneMonthFromWideCache.partial, false);
  for (let index = 1; index < coverageService.historyCache.get('005930').bars.length; index++) {
    const bars = coverageService.historyCache.get('005930').bars;
    assert.equal(bars[index].change, bars[index].close - bars[index - 1].close, '병합한 전체 일봉에서 변화량을 다시 계산해야 합니다.');
  }

  const beforeInvalidation = structuredClone(coverageService.historyCache.get('005930'));
  coverageService.invalidateHistoryCache();
  assert.equal(coverageService.historyCache.get('005930').coverageStart, beforeInvalidation.coverageStart, '일일 무효화는 과거 coverage를 지우면 안 됩니다.');
  assert.deepEqual(coverageService.historyCache.get('005930').bars, beforeInvalidation.bars, '일일 무효화는 마지막 정상 bars를 보존해야 합니다.');
  assert.equal(coverageService.historyCache.get('005930').headUpdatedAt, 0);
  const afterHead = await coverageService.dailyChart(chartUniverse.lookup('005930'), { period: '10y' });
  assert.equal(coverageCalls.length, callsBeforeShorter + 1);
  assert.equal(coverageCalls.at(-1).kind, 'head');
  assert.equal(coverageCalls.at(-1).beginBasDt, '20260805', '최근 head 갱신은 오늘을 포함한 20일만 겹쳐 받아야 합니다.');
  assert.equal(afterHead.coverageStart, '2016-08-24');
  assert.equal(afterHead.partial, false);
  assert.equal(afterHead.bars[0].date, tenYear.bars[0].date, 'head 갱신이 과거 10년 bars를 삭제하면 안 됩니다.');

  const denseHeadBars = Array.from({ length: 10 }, (_, index) => ({
    date: compactDay('20260815', index).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    open: 1000 + index,
    high: 1010 + index,
    low: 990 + index,
    close: 1005 + index,
    volume: 100 + index,
    change: index ? 1 : 0,
    changeRate: index ? 1 / (1004 + index) * 100 : 0,
  }));
  const denseEntry = () => ({
    bars: structuredClone(denseHeadBars),
    coverageStart: '2026-07-24',
    coverageEndExclusive: '2026-08-25',
    headUpdatedAt: fixedNow,
    updatedAt: fixedNow,
  });
  const partialHeadService = new MarketDataService({ dataDir: path.join(chartTempDir, 'partial-head'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  partialHeadService.rememberHistory('005930', denseEntry());
  partialHeadService.invalidateHistoryCache();
  const partialHeadSnapshot = structuredClone(partialHeadService.historyCache.get('005930'));
  partialHeadService.fetchKrHistory = async () => [...denseHeadBars.slice(0, 6), denseHeadBars.at(-1)];
  const partialHeadFallback = await partialHeadService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  assert.equal(partialHeadFallback.stale, true);
  assert.equal(partialHeadFallback.partial, false, '완성된 기존 coverage를 쓰는 stale fallback은 부분 기간으로 표시하면 안 됩니다.');
  assert.match(partialHeadFallback.error, /겹침 구간 수가 비정상적으로 줄었습니다/);
  assert.deepEqual(partialHeadService.historyCache.get('005930'), partialHeadSnapshot, '80% 미만 head 응답은 cache를 조금도 바꾸면 안 됩니다.');

  const regressiveHeadService = new MarketDataService({ dataDir: path.join(chartTempDir, 'regressive-head'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  regressiveHeadService.rememberHistory('005930', denseEntry());
  regressiveHeadService.invalidateHistoryCache();
  const regressiveHeadSnapshot = structuredClone(regressiveHeadService.historyCache.get('005930'));
  regressiveHeadService.fetchKrHistory = async () => denseHeadBars.slice(0, 9);
  const regressiveHeadFallback = await regressiveHeadService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  assert.equal(regressiveHeadFallback.stale, true);
  assert.match(regressiveHeadFallback.error, /마지막 정상 기준일보다 이전입니다/);
  assert.deepEqual(regressiveHeadService.historyCache.get('005930'), regressiveHeadSnapshot, '기준일이 역행한 head 응답은 cache를 조금도 바꾸면 안 됩니다.');

  const concurrentService = new MarketDataService({ dataDir: path.join(chartTempDir, 'concurrent'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const concurrentSegments = [];
  let releaseFirstSegment;
  concurrentService.fetchKrHistory = async (code, segment) => {
    concurrentSegments.push({ code, ...segment });
    if (concurrentSegments.length === 1) await new Promise((resolve) => { releaseFirstSegment = resolve; });
    return simpleBars(segment);
  };
  const shortPromise = concurrentService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  await new Promise((resolve) => setImmediate(resolve));
  const longPromise = concurrentService.dailyChart(chartUniverse.lookup('005930'), { period: '10y' });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstSegment();
  const [, concurrentLong] = await Promise.all([shortPromise, longPromise]);
  assert.equal(concurrentSegments.length, 2, '동시 짧은·긴 요청은 종목 단위로 직렬화하고 빠진 과거 범위만 이어 받아야 합니다.');
  assert.equal(concurrentSegments[1].kind, 'older');
  assert.equal(concurrentLong.coverageStart, '2016-08-24');
  assert.equal(concurrentService.historyActive, 0);
  assert.equal(concurrentService.historyQueue.length, 0);

  const partialService = new MarketDataService({ dataDir: path.join(chartTempDir, 'partial'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  partialService.fetchKrHistory = async (code, segment) => simpleBars(segment);
  const normalShort = await partialService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  const shortSnapshot = structuredClone(partialService.historyCache.get('005930'));
  partialService.fetchKrHistory = async () => { throw new Error('의도한 10년 확장 실패'); };
  const partialLong = await partialService.dailyChart(chartUniverse.lookup('005930'), { period: '10y' });
  assert.equal(partialLong.stale, true);
  assert.equal(partialLong.partial, true, '짧은 cache만 있는 10년 fallback은 부분 응답임을 밝혀야 합니다.');
  assert.match(partialLong.error, /의도한 10년 확장 실패/);
  assert.deepEqual(partialService.historyCache.get('005930'), shortSnapshot, '실패한 범위의 일부 행은 cache에 병합하면 안 됩니다.');
  const shortAfterLongFailure = await partialService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  assert.equal(shortAfterLongFailure.partial, false, '긴 범위 실패가 이미 완성된 짧은 범위 제공을 막으면 안 됩니다.');
  assert.deepEqual(shortAfterLongFailure.bars, normalShort.bars);

  const emptyService = new MarketDataService({ dataDir: path.join(chartTempDir, 'empty'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  emptyService.fetchKrHistory = async () => [];
  const emptyChart = await emptyService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  assert.equal(emptyChart.partial, false, 'total=0도 성공적으로 확인한 coverage여야 합니다.');
  assert.deepEqual(emptyChart.bars, []);
  assert.equal(emptyChart.availableFrom, '');

  const limiterService = new MarketDataService({ dataDir: path.join(chartTempDir, 'limiter'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  let activeHistoryCalls = 0, maxActiveHistoryCalls = 0;
  limiterService.fetchKrHistory = async (code, segment) => {
    activeHistoryCalls++;
    maxActiveHistoryCalls = Math.max(maxActiveHistoryCalls, activeHistoryCalls);
    await new Promise((resolve) => setImmediate(resolve));
    activeHistoryCalls--;
    return simpleBars(segment);
  };
  await Promise.all(['100001', '100002', '100003'].map((code) => limiterService.dailyChart({ code, name: code, market: 'KOSPI' }, { period: '1m' })));
  assert.equal(maxActiveHistoryCalls, HISTORY_MAX_CONCURRENCY, '서로 다른 종목도 공급자 동시 호출 상한을 넘으면 안 됩니다.');

  const overloadedService = new MarketDataService({ dataDir: path.join(chartTempDir, 'overloaded'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  overloadedService.historyActive = HISTORY_MAX_CONCURRENCY;
  overloadedService.historyQueue = Array.from({ length: HISTORY_QUEUE_LIMIT }, () => () => {});
  await assert.rejects(
    () => overloadedService.withHistoryProviderSlot(async () => true),
    (error) => error?.code === 'HISTORY_QUEUE_FULL' && error?.statusCode === 503,
  );

  const retryStatusService = new MarketDataService({ dataDir: path.join(chartTempDir, 'retry-status'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  retryStatusService.fetchKrHistory = async () => { const error = new Error('의도한 예산 실패'); error.code = 'HISTORY_DAILY_BUDGET'; error.statusCode = 503; throw error; };
  await assert.rejects(() => retryStatusService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' }), (error) => error?.statusCode === 503);
  await assert.rejects(() => retryStatusService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' }), (error) => error?.statusCode === 503, '30분 재시도 억제 응답도 원래 503 상태를 보존해야 합니다.');

  const lruService = new MarketDataService({ dataDir: path.join(chartTempDir, 'lru'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const tinyBar = { date: '2026-08-24', open: 1, high: 1, low: 1, close: 1, volume: 0, change: 0, changeRate: 0 };
  for (let index = 0; index <= HISTORY_CACHE_LIMIT; index++) {
    const code = String(100000 + index);
    lruService.rememberHistory(code, { bars: [tinyBar], coverageStart: '2026-07-24', coverageEndExclusive: '2026-08-25', headUpdatedAt: fixedNow, updatedAt: fixedNow });
  }
  assert.equal(lruService.historyCache.size, HISTORY_CACHE_LIMIT);
  assert.equal(lruService.historyCache.has('100000'), false);
  const barCapService = new MarketDataService({ dataDir: path.join(chartTempDir, 'bar-cap'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const manyBars = Array(60000).fill(tinyBar);
  barCapService.rememberHistory('100001', { bars: manyBars, coverageStart: 'x', coverageEndExclusive: 'y', headUpdatedAt: fixedNow, updatedAt: fixedNow });
  barCapService.rememberHistory('100002', { bars: manyBars, coverageStart: 'x', coverageEndExclusive: 'y', headUpdatedAt: fixedNow, updatedAt: fixedNow });
  assert.equal(barCapService.historyCache.has('100001'), false, '총 봉 수 상한을 넘으면 가장 오래된 종목을 제거해야 합니다.');
  assert.equal(barCapService.historyBarCount, 60000);

  const invalidationService = new MarketDataService({ dataDir: path.join(chartTempDir, 'invalidation'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  let releaseInflightHistory;
  invalidationService.fetchKrHistory = async (code, segment) => {
    await new Promise((resolve) => { releaseInflightHistory = resolve; });
    return simpleBars(segment);
  };
  const invalidatedInflight = invalidationService.dailyChart(chartUniverse.lookup('005930'), { period: '1m' });
  await new Promise((resolve) => setImmediate(resolve));
  invalidationService.invalidateHistoryCache();
  releaseInflightHistory();
  await assert.rejects(
    () => invalidatedInflight,
    (error) => error?.code === 'HISTORY_CACHE_INVALIDATED' && error?.statusCode === 503,
    '공개 시각 전에 시작한 공급자 응답은 cache에 반영하면 안 됩니다.',
  );

  const queuedService = new MarketDataService({ dataDir: path.join(chartTempDir, 'queued-invalidation'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const releases = [];
  let providerStarts = 0;
  queuedService.fetchKrHistory = async (code, segment) => {
    const index = providerStarts++;
    if (index < HISTORY_MAX_CONCURRENCY) await new Promise((resolve) => releases.push(resolve));
    return simpleBars(segment);
  };
  const queuedResults = ['200001', '200002', '200003'].map((code) => queuedService
    .dailyChart({ code, name: code, market: 'KOSPI' }, { period: '1m' })
    .then((value) => ({ value }), (error) => ({ error })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queuedService.historyQueue.length, 1);
  queuedService.invalidateHistoryCache();
  for (const release of releases) release();
  const [oldOne, oldTwo, queuedAfter] = await Promise.all(queuedResults);
  assert.equal(oldOne.error?.code, 'HISTORY_CACHE_INVALIDATED');
  assert.equal(oldTwo.error?.code, 'HISTORY_CACHE_INVALIDATED');
  assert.equal(queuedAfter.value?.stale, false, '무효화 뒤 실제 시작한 대기 요청은 새 generation 결과로 받아야 합니다.');

  const noKeyService = new MarketDataService({ dataDir: path.join(chartTempDir, 'no-key'), universe: chartUniverse, serviceKey: '' });
  await assert.rejects(() => noKeyService.fetchKrHistory('005930', tenYearRange), /PUBLIC_DATA_SERVICE_KEY/);
  const invalidCodeService = new MarketDataService({ dataDir: path.join(chartTempDir, 'invalid-code'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  await assert.rejects(() => invalidCodeService.fetchKrHistory('ABC123', tenYearRange), /6자리/);
} finally {
  Date.now = realDateNow;
  globalThis.fetch = chartRealFetch;
  rmSync(chartTempDir, { recursive: true, force: true });
}


const envExample = read('.env.example');
assert.doesNotMatch(envExample, /^PUBLIC_DATA_REFRESH_MS=/m, '고정 하루 주기를 오래된 서버 환경값이 덮어쓰면 안 됩니다.');
const marketDataSource = read('lib/market-data.js');
const providerUrls = [...marketDataSource.matchAll(/https?:\/\/[^'"\s]+/g)].map((match) => match[0]);
assert.deepEqual(providerUrls, ['https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo'], '시세 공급자는 공공데이터포털 금융위원회 API 하나여야 합니다.');
assert.ok(marketDataSource.indexOf('await this.recordEvents(replacement.events)') < marketDataSource.indexOf('writeJsonAtomic(this.krFile'), '기업행동 DB 기록은 새 시세 캐시 확정보다 먼저 완료해야 합니다.');
const universeSource = read('lib/universe.js');
assert.ok(universeSource.includes('planReplacement(') && universeSource.includes('applyReplacement('), '종목 변경은 DB 기록 전 계획과 기록 후 확정의 두 단계여야 합니다.');

const serverSource = read('server.js');
assert.match(serverSource, /const PUBLIC_DATA_REFRESH_MS = 24\*60\*60\*1000;/, '서버의 국내 시세 확인 주기는 정확히 하루여야 합니다.');
assert.ok(serverSource.includes("missing.push('PUBLIC_DATA_SERVICE_KEY')"), 'Railway 운영 모드는 국내 공공데이터 키가 없으면 기동을 중단해야 합니다.');
assert.ok(serverSource.includes('recordEvents:recordUniverseEvents'), '종목 변경 이벤트는 시세·종목 캐시 확정 전에 DB에 기록하도록 주입해야 합니다.');
assert.doesNotMatch(serverSource, /if\((?:r|kr)\.events\)await recordUniverseEvents/, '시세 확정 뒤 기업행동을 기록하면 DB 실패 시 이벤트를 재생성할 수 없습니다.');
assert.ok(serverSource.includes('const PUBLIC_DATA_REFRESH_HOUR_KST=14;') && serverSource.includes('const PUBLIC_DATA_REFRESH_MINUTE_KST=10;'), '국내 시세는 공공데이터 공개 뒤 한국시간 14:10에 확인해야 합니다.');
assert.ok(serverSource.includes('setTimeout(async()=>') && serverSource.includes('msUntilNextPublicDataRefresh()'), '국내 시세 스케줄러는 다음 한국시간 공개 시각을 다시 계산해야 합니다.');
assert.ok(serverSource.includes("result.configured&&result.error?MARKET_RETRY_MS:msUntilNextPublicDataRefresh()"), '설정된 공급자 오류는 30분 뒤 제한적으로 재시도해야 합니다.');
assert.ok(serverSource.includes('shouldForceInitialKstRefresh(updatedAt,Date.now()'), '공개 시각 뒤 재시작할 때 당일 갱신 누락 여부를 확인해야 합니다.');
assert.doesNotMatch(serverSource, /setInterval\([^\n]+PUBLIC_DATA_REFRESH_MS/, '고정 interval로 재시작 시각에 따라 일별 갱신이 밀리면 안 됩니다.');
assert.ok(serverSource.includes("url.pathname==='/api/chart'"), '학생용 일봉 차트 API가 있어야 합니다.');
assert.ok(serverSource.includes('const auth=getStudentAuth(req);'), '공공데이터 호출량을 보호하도록 일봉 차트 API는 학생 로그인을 요구해야 합니다.');
const chartStudentLimit = "if(!rateLimitOk('chart:student:'+auth.sid,30,60000))";
const chartIpLimit = "if(!rateLimitOk('chart:ip:'+clientIp(req),120,60000))";
const chartGlobalLimit = "if(!rateLimitOk('chart:global',120,60000))";
assert.ok(serverSource.includes(chartStudentLimit), '일봉 차트 API는 학생별 요청 제한을 적용해야 합니다.');
assert.ok(serverSource.includes(chartIpLimit), '일봉 차트 API는 IP별 요청 제한도 적용해야 합니다.');
assert.ok(serverSource.includes(chartGlobalLimit), '일봉 차트 API는 서버 전체 요청 제한도 적용해야 합니다.');
assert.ok(serverSource.indexOf(chartStudentLimit) < serverSource.indexOf(chartIpLimit) && serverSource.indexOf(chartIpLimit) < serverSource.indexOf(chartGlobalLimit), '학생 한도 초과 요청이 IP·전체 버킷을 소모하지 않도록 순서대로 즉시 거부해야 합니다.');
assert.ok(serverSource.includes('marketData.dailyChart(stock,{period})'), '일봉 차트 API는 검증된 국내 종목과 기간으로 시세 모듈을 호출해야 합니다.');
assert.ok(serverSource.includes("periodBasis:'calendar-period'"), '일봉 조회 기간이 달력 월·년 기준임을 응답에 밝혀야 합니다.');
assert.ok(serverSource.includes("url.searchParams.has('days')") && serverSource.includes("url.searchParams.get('period')"), '옛 days 계약은 거부하고 period 화이트리스트만 받아야 합니다.');
assert.ok(serverSource.includes('domesticCorporateActions'), '기업행동은 국내 6자리 코드 허용목록을 거쳐야 합니다.');
assert.ok((serverSource.match(/domesticStateView\(/g) || []).length >= 2, '학생 응답과 교사 자산 요약은 국내 상태 보기만 사용해야 합니다.');
assert.ok(serverSource.includes('if(row) state=(await withStudentState(id,epo,null)).state;'), '기존 학생 로그인 응답도 국내 상태 보기를 사용해야 합니다.');
assert.ok(serverSource.includes('state=domesticStateView(state);'), '신규·기존 학생 로그인 응답에 같은 국내 상태 보기를 적용해야 합니다.');
assert.ok(serverSource.includes('if(!isDomesticTransaction(tx))'), '숨겨진 비국내 거래 기록의 메모를 수정할 수 없어야 합니다.');
assert.ok(serverSource.includes('newCode=changesCode?resolveStockCode(newInput):oldCode'), '코드변경·합병 외 기업행동은 신규 코드를 기존 국내 코드로 고정해야 합니다.');
assert.ok(serverSource.includes('domesticCorporateActions(db.listCorporateActions({limit:Number.MAX_SAFE_INTEGER})).slice(0,500)'), '기업행동은 국내 필터 후 목록 상한을 적용해야 합니다.');
assert.ok(serverSource.includes('db.getCorporateAction(caMatch[1])'), '기업행동 수정은 목록 상한과 무관하게 ID로 직접 조회해야 합니다.');
assert.ok(serverSource.includes('if(!r.error){prices.clear();marketData.invalidateHistoryCache();}') && serverSource.includes('if(!kr.error){prices.clear();marketData.invalidateHistoryCache();}'), '관리자·주기 갱신 성공 때만 가격·오전 일봉 캐시를 비워야 합니다.');
assert.ok(serverSource.includes('const status=e.statusCode===503?503:502;'), '공급자 대기열·일일 예산 과부하는 일시적 서비스 불가로 응답해야 합니다.');
const dbSource = read('lib/db.js');
assert.ok(dbSource.includes('getCorporateAction,'), '기업행동 단건 조회 함수가 DB 경계에 노출되어야 합니다.');

const packageJson = JSON.parse(read('package.json'));
assert.deepEqual(Object.keys(packageJson.dependencies || {}), ['pg'], '운영 의존성은 pg 하나만 유지해야 합니다.');
console.log(`국내 전용 시장 검사 통과 (${universeData.stocks.length.toLocaleString('ko-KR')}개 종목, 하루 1회 확인)`);
