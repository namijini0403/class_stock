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
  HISTORY_MAX_CONCURRENCY, HISTORY_QUEUE_LIMIT, HISTORY_DAILY_BUDGET, HISTORY_CACHE_LIMIT,
} = require(path.join(ROOT, 'lib/market-data.js'));
const { msUntilNextKstRefresh, shouldForceInitialKstRefresh } = require(path.join(ROOT, 'lib/daily-refresh.js'));
assert.equal(MARKET_RETRY_MS, 30 * 60 * 1000, '시세 공급자 오류 재시도는 30분 간격이어야 합니다.');
assert.equal(HISTORY_RETRY_MS, MARKET_RETRY_MS, '일봉 오류 재시도도 같은 제한 간격을 사용해야 합니다.');
assert.equal(HISTORY_MAX_CONCURRENCY, 2, '일봉 공급자 동시 호출 상한은 2여야 합니다.');
assert.equal(HISTORY_QUEUE_LIMIT, 20, '일봉 공급자 대기열은 제한된 요청 수만 받아야 합니다.');
assert.equal(HISTORY_DAILY_BUDGET, 4000, '일봉 호출은 공공데이터 일일 한도보다 낮은 내부 예산으로 보호해야 합니다.');
assert.equal(HISTORY_CACHE_LIMIT, 512, '일봉 메모리 캐시는 제한된 종목 수만 보관해야 합니다.');
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
try {
  const chartUniverse = new StockUniverse(path.join(chartTempDir, 'universe.json'), [
    { code: '005930', name: '삼성전자', market: 'KOSPI' },
  ]);
  const chartService = new MarketDataService({ dataDir: chartTempDir, universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const requestedUrls = [];
  const compactDay = (compact, offset) => {
    const date = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)) + offset));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  };
  let historyFetchCount = 0;
  globalThis.fetch = async (input) => {
    historyFetchCount++;
    const requestUrl = new URL(String(input));
    requestedUrls.push(requestUrl);
    await new Promise((resolve) => setImmediate(resolve));
    const end = requestUrl.searchParams.get('endBasDt');
    const first = compactDay(end, -3), middle = compactDay(end, -2), last = compactDay(end, -1);
    const historyRows = [
      { srtnCd: '005930', itmsNm: '삼성전자', mrktCtg: 'KOSPI', basDt: last, mkp: '120', hipr: '135', lopr: '115', clpr: '130', trqu: '30' },
      { srtnCd: '005930', itmsNm: '삼성전자', mrktCtg: 'KOSPI', basDt: first, mkp: '100', hipr: '110', lopr: '95', clpr: '105', trqu: '10', vs: '5', fltRt: '5' },
      { srtnCd: '005930', itmsNm: '삼성전자', mrktCtg: 'KOSPI', basDt: middle, mkp: '105', hipr: '125', lopr: '100', clpr: '115', trqu: '20', vs: '10', fltRt: '9.52' },
      { srtnCd: '000660', itmsNm: '다른 종목', mrktCtg: 'KOSPI', basDt: middle, mkp: '1', hipr: '2', lopr: '1', clpr: '2', trqu: '1' },
      { srtnCd: '005930', itmsNm: '잘못된 시장', mrktCtg: 'NYSE', basDt: middle, mkp: '1', hipr: '2', lopr: '1', clpr: '2', trqu: '1' },
      { srtnCd: '005930', itmsNm: '잘못된 날짜', mrktCtg: 'KOSPI', basDt: '20260230', mkp: '1', hipr: '2', lopr: '1', clpr: '2', trqu: '1' },
      { srtnCd: '005930', itmsNm: '잘못된 OHLC', mrktCtg: 'KOSPI', basDt: middle, mkp: '120', hipr: '110', lopr: '100', clpr: '115', trqu: '1' },
      { srtnCd: '005930', itmsNm: '삼성전자', mrktCtg: 'KOSPI', basDt: middle, mkp: '105', hipr: '130', lopr: '100', clpr: '120', trqu: '25' },
    ];
    return {
      ok: true,
      json: async () => ({ response: { header: { resultCode: '00' }, body: { totalCount: historyRows.length, items: { item: historyRows } } } }),
    };
  };

  const [firstChart, concurrentChart] = await Promise.all([
    chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 }),
    chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 }),
  ]);
  assert.equal(historyFetchCount, 1, '같은 종목의 동시 일봉 요청은 외부 호출 하나로 합쳐야 합니다.');
  assert.equal(requestedUrls[0].searchParams.get('likeSrtnCd'), '005930', '공급자 요청은 정확한 국내 종목코드로 좁혀야 합니다.');
  assert.match(requestedUrls[0].searchParams.get('beginBasDt') || '', /^\d{8}$/);
  assert.match(requestedUrls[0].searchParams.get('endBasDt') || '', /^\d{8}$/);
  assert.equal(firstChart.interval, '1d');
  assert.equal(firstChart.kind, 'daily-ohlcv');
  assert.equal(firstChart.periodBasis, 'calendar-days');
  assert.equal(firstChart.timezone, 'Asia/Seoul');
  assert.equal(firstChart.delayed, true);
  assert.equal(firstChart.refreshMs, DAY_MS);
  assert.deepEqual(firstChart.bars.map((bar) => bar.date), [...firstChart.bars.map((bar) => bar.date)].sort(), '일봉은 날짜 오름차순이어야 합니다.');
  assert.equal(firstChart.bars.length, 3, '정확한 종목·국내 시장·정상 OHLCV만 남겨야 합니다.');
  assert.equal(firstChart.bars[1].close, 120, '같은 날짜의 마지막 정상 행 하나만 남겨야 합니다.');
  assert.equal(firstChart.bars[1].change, 15, '등락값이 없으면 이전 종가로 계산해야 합니다.');
  assert.ok(Math.abs(firstChart.bars[1].changeRate - (15 / 105 * 100)) < 1e-9, '등락률이 없으면 이전 종가로 계산해야 합니다.');
  assert.deepEqual(concurrentChart.bars, firstChart.bars);

  const cachedChart = await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 30 });
  assert.equal(historyFetchCount, 1, '24시간 안의 같은 종목 일봉은 메모리 캐시를 사용해야 합니다.');
  assert.equal(cachedChart.cached, true);
  chartService.historyCache.get('005930').updatedAt = Date.now() - DAY_MS - 1;
  chartService.fetchKrHistory = async () => firstChart.bars.slice(-1);
  const partialChart = await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 });
  assert.equal(partialChart.stale, true, '일봉 수가 갑자기 줄어든 응답에는 마지막 정상 일봉을 사용해야 합니다.');
  assert.match(partialChart.error, /일봉 수가 비정상적으로 줄었습니다/);
  assert.deepEqual(partialChart.bars, firstChart.bars, '부분 일봉 응답이 마지막 정상 OHLCV를 덮으면 안 됩니다.');

  chartService.historyAttemptAt.set('005930', Date.now() - HISTORY_RETRY_MS - 1);
  const regressiveBars = firstChart.bars.map((bar) => ({
    ...bar,
    date: new Date(Date.parse(`${bar.date}T00:00:00.000Z`) - 10 * DAY_MS).toISOString().slice(0, 10),
  }));
  chartService.fetchKrHistory = async () => regressiveBars;
  const regressiveChart = await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 });
  assert.equal(regressiveChart.stale, true, '기준일이 역행한 일봉 응답에는 마지막 정상 일봉을 사용해야 합니다.');
  assert.match(regressiveChart.error, /일봉 기준일이 마지막 정상 기준일보다 이전/);
  assert.deepEqual(regressiveChart.bars, firstChart.bars, '기준일이 역행한 일봉 응답이 정상 캐시를 덮으면 안 됩니다.');

  chartService.historyAttemptAt.set('005930', Date.now() - HISTORY_RETRY_MS - 1);
  let historyFailureCalls = 0;
  chartService.fetchKrHistory = async () => { historyFailureCalls++; throw new Error('의도한 일봉 갱신 실패'); };
  const staleChart = await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 });
  assert.equal(staleChart.stale, true, '만료 뒤 공급자 장애에는 마지막 정상 일봉임을 표시해야 합니다.');
  assert.equal(staleChart.fallbackUsed, true);
  assert.match(staleChart.error, /의도한 일봉 갱신 실패/);
  assert.equal(staleChart.asOfDate, firstChart.asOfDate, 'fallback에서도 마지막 정상 기준일을 보존해야 합니다.');
  assert.deepEqual(staleChart.bars, firstChart.bars, 'fallback이 마지막 정상 OHLCV를 바꾸면 안 됩니다.');
  const staleChartAgain = await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 });
  assert.equal(historyFailureCalls, 1, '일봉 갱신 실패 직후 공급자 호출을 반복하면 안 됩니다.');
  assert.equal(staleChartAgain.stale, true);
  assert.deepEqual(staleChartAgain.bars, firstChart.bars);
  chartService.historyAttemptAt.set('005930', Date.now() - HISTORY_RETRY_MS - 1);
  await chartService.dailyChart(chartUniverse.lookup('005930'), { days: 190 });
  assert.equal(historyFailureCalls, 2, '일봉 갱신 실패 뒤 30분이 지나면 제한된 재시도를 허용해야 합니다.');

  const limiterService = new MarketDataService({ dataDir: path.join(chartTempDir, 'limiter'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  let activeHistoryCalls = 0, maxActiveHistoryCalls = 0;
  limiterService.fetchKrHistory = async () => {
    activeHistoryCalls++;
    maxActiveHistoryCalls = Math.max(maxActiveHistoryCalls, activeHistoryCalls);
    await new Promise((resolve) => setImmediate(resolve));
    activeHistoryCalls--;
    return firstChart.bars;
  };
  await Promise.all(['100001', '100002', '100003'].map((code) => limiterService.dailyChart({ code, name: code, market: 'KOSPI' }, { days: 365 })));
  assert.equal(maxActiveHistoryCalls, HISTORY_MAX_CONCURRENCY, '서로 다른 일봉 요청도 공급자 동시 호출 상한을 넘으면 안 됩니다.');
  assert.equal(limiterService.historyActive, 0, '일봉 공급자 작업이 끝나면 활성 슬롯을 모두 반환해야 합니다.');
  assert.equal(limiterService.historyQueue.length, 0, '일봉 공급자 작업이 끝나면 대기열이 비어야 합니다.');

  const overloadedService = new MarketDataService({ dataDir: path.join(chartTempDir, 'overloaded'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  overloadedService.historyActive = HISTORY_MAX_CONCURRENCY;
  overloadedService.historyQueue = Array.from({ length: HISTORY_QUEUE_LIMIT }, () => () => {});
  await assert.rejects(
    () => overloadedService.withHistoryProviderSlot(async () => true),
    (error) => error?.code === 'HISTORY_QUEUE_FULL' && error?.statusCode === 503,
    '일봉 공급자 대기열 상한을 넘으면 즉시 서비스 과부하로 거부해야 합니다.',
  );

  const budgetService = new MarketDataService({ dataDir: path.join(chartTempDir, 'budget'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  await budgetService.withHistoryProviderSlot(async () => true);
  budgetService.historyBudgetUsed = HISTORY_DAILY_BUDGET;
  budgetService.fetchKrHistory = async () => firstChart.bars;
  await assert.rejects(
    () => budgetService.dailyChart({ code: '100004', name: '호출예산', market: 'KOSPI' }, { days: 365 }),
    /일일 호출 보호 한도/,
    '내부 일일 호출 예산을 넘으면 공공데이터를 더 호출하면 안 됩니다.',
  );

  for (let index = 0; index <= HISTORY_CACHE_LIMIT; index++) {
    const code = String(100000 + index).padStart(6, '0');
    chartService.rememberHistory(code, { bars: firstChart.bars, updatedAt: Date.now() });
  }
  assert.equal(chartService.historyCache.size, HISTORY_CACHE_LIMIT, '일봉 캐시 종목 수는 메모리 상한을 넘으면 안 됩니다.');
  assert.equal(chartService.historyCache.has('100000'), false, '일봉 캐시 상한에서는 가장 오래 사용하지 않은 종목부터 제거해야 합니다.');
  assert.equal(chartService.historyCache.has(String(100000 + HISTORY_CACHE_LIMIT)), true, '가장 최근 일봉 캐시는 보존해야 합니다.');
  chartService.historyAttemptAt.set('100001', Date.now());
  chartService.historyErrors.set('100001', '이전 오류');
  const generationBeforeInvalidation = chartService.historyGeneration;
  chartService.invalidateHistoryCache();
  assert.equal(chartService.historyGeneration, generationBeforeInvalidation + 1, '새 일별 시세 확인 뒤 일봉 캐시 세대를 바꿔야 합니다.');
  assert.equal(chartService.historyCache.size, HISTORY_CACHE_LIMIT, '새 일별 시세 확인 뒤에도 장애 fallback용 마지막 정상 일봉은 보존해야 합니다.');
  assert.ok([...chartService.historyCache.values()].every((entry) => entry.updatedAt === 0), '오전에 채운 일봉은 즉시 만료시켜 다음 요청이 새 자료를 확인해야 합니다.');
  assert.equal(chartService.historyAttemptAt.size, 0, '일봉 캐시 무효화 뒤 과거 시도 시각을 남기면 안 됩니다.');
  assert.equal(chartService.historyErrors.size, 0, '일봉 캐시 무효화 뒤 과거 오류를 남기면 안 됩니다.');
  const fallbackCode = String(100000 + HISTORY_CACHE_LIMIT);
  chartService.fetchKrHistory = async () => { throw new Error('무효화 직후 공급자 실패'); };
  const fallbackAfterInvalidation = await chartService.dailyChart({ code: fallbackCode, name: fallbackCode, market: 'KOSPI' }, { days: 365 });
  assert.equal(fallbackAfterInvalidation.stale, true, '공개 시각 뒤 새 일봉 조회가 실패해도 마지막 정상 차트를 표시해야 합니다.');
  assert.match(fallbackAfterInvalidation.error, /무효화 직후 공급자 실패/);
  assert.deepEqual(fallbackAfterInvalidation.bars, firstChart.bars, '일봉 무효화는 장애 fallback 자료를 삭제하면 안 됩니다.');

  const invalidationService = new MarketDataService({ dataDir: path.join(chartTempDir, 'invalidation'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  let releaseInflightHistory;
  invalidationService.fetchKrHistory = async () => new Promise((resolve) => { releaseInflightHistory = () => resolve(firstChart.bars); });
  const invalidatedInflight = invalidationService.dailyChart(chartUniverse.lookup('005930'), { days: 365 });
  await new Promise((resolve) => setImmediate(resolve));
  invalidationService.invalidateHistoryCache();
  releaseInflightHistory();
  await assert.rejects(
    () => invalidatedInflight,
    (error) => error?.code === 'HISTORY_CACHE_INVALIDATED' && error?.statusCode === 503,
    '공개 시각 경계 전에 시작한 일봉 응답이 무효화 뒤 캐시를 다시 채우면 안 됩니다.',
  );
  assert.equal(invalidationService.historyErrors.size, 0, '캐시 세대 변경은 30분 공급자 오류로 기록하면 안 됩니다.');
  invalidationService.fetchKrHistory = async () => firstChart.bars;
  const refreshedAfterInvalidation = await invalidationService.dailyChart(chartUniverse.lookup('005930'), { days: 365 });
  assert.equal(refreshedAfterInvalidation.stale, false, '캐시 무효화 직후 다시 요청하면 새 일봉을 받을 수 있어야 합니다.');

  const queuedInvalidationService = new MarketDataService({ dataDir: path.join(chartTempDir, 'queued-invalidation'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  const releaseQueuedProviders = [];
  let queuedProviderStarts = 0;
  queuedInvalidationService.fetchKrHistory = async () => {
    const index = queuedProviderStarts++;
    if (index < HISTORY_MAX_CONCURRENCY) await new Promise((resolve) => releaseQueuedProviders.push(resolve));
    return firstChart.bars;
  };
  const queuedResults = ['200001', '200002', '200003'].map((code) => queuedInvalidationService
    .dailyChart({ code, name: code, market: 'KOSPI' }, { days: 365 })
    .then((value) => ({ value }), (error) => ({ error })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queuedInvalidationService.historyQueue.length, 1, '캐시 경계 검사 전에 세 번째 공급자 요청이 대기 중이어야 합니다.');
  queuedInvalidationService.invalidateHistoryCache();
  for (const release of releaseQueuedProviders) release();
  const [oldActiveOne, oldActiveTwo, queuedAfterInvalidation] = await Promise.all(queuedResults);
  assert.equal(oldActiveOne.error?.code, 'HISTORY_CACHE_INVALIDATED', '공개 시각 전에 시작한 첫 공급자 응답은 버려야 합니다.');
  assert.equal(oldActiveTwo.error?.code, 'HISTORY_CACHE_INVALIDATED', '공개 시각 전에 시작한 둘째 공급자 응답은 버려야 합니다.');
  assert.equal(queuedAfterInvalidation.value?.stale, false, '공개 시각 뒤 실제 호출을 시작한 대기 요청은 새 세대 결과로 사용해야 합니다.');
  assert.equal(queuedInvalidationService.historyActive, 0, '캐시 경계 처리 뒤 공급자 슬롯을 모두 반환해야 합니다.');
  assert.equal(queuedInvalidationService.historyQueue.length, 0, '캐시 경계 처리 뒤 공급자 대기열이 비어야 합니다.');

  const noKeyService = new MarketDataService({ dataDir: path.join(chartTempDir, 'no-key'), universe: chartUniverse, serviceKey: '' });
  await assert.rejects(() => noKeyService.fetchKrHistory('005930'), /PUBLIC_DATA_SERVICE_KEY/, '서비스키 없이 공급자 일봉을 호출하면 안 됩니다.');
  const invalidCodeService = new MarketDataService({ dataDir: path.join(chartTempDir, 'invalid-code'), universe: chartUniverse, serviceKey: 'TEST_KEY' });
  await assert.rejects(() => invalidCodeService.fetchKrHistory('ABC123'), /6자리/, '비국내 종목코드로 일봉을 조회하면 안 됩니다.');
} finally {
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
assert.ok(serverSource.includes('marketData.dailyChart(stock,{days})'), '일봉 차트 API는 검증된 국내 종목으로 시세 모듈을 호출해야 합니다.');
assert.ok(serverSource.includes("periodBasis:'calendar-days'"), '일봉 조회 기간이 달력일 기준임을 응답에 밝혀야 합니다.');
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
