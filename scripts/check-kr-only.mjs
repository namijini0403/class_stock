#!/usr/bin/env node
// 국내 주식 전용 시장 구성 회귀 검사. DB와 외부 네트워크 없이 실행한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

const { MarketDataService } = require(path.join(ROOT, 'lib/market-data.js'));
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
  assert.equal(status.kr.refreshMs, 3_600_000, '국내 공공데이터 확인 주기는 1시간이어야 합니다.');

  const clamped = new MarketDataService({ dataDir: path.join(tempDir, 'clamped'), universe: tempUniverse, serviceKey: '', refreshMs: 1 });
  assert.equal(clamped.status().kr.refreshMs, 3_600_000, '1시간보다 짧은 확인 주기는 허용하면 안 됩니다.');
  const fixed = new MarketDataService({ dataDir: path.join(tempDir, 'fixed'), universe: tempUniverse, serviceKey: '', refreshMs: 10_800_000 });
  assert.equal(fixed.status().kr.refreshMs, 3_600_000, '기존 서버 설정이 남아 있어도 확인 주기는 정확히 1시간이어야 합니다.');

  const rows = Array.from({ length: 120 }, (_, index) => ({
    srtnCd: String(index + 1).padStart(6, '0'), itmsNm: `테스트${index + 1}`, mrktCtg: 'KOSPI',
    clpr: '1000', vs: '10', fltRt: '1', basDt: '20260818',
  }));
  const invalidMarketRow = { srtnCd: '777777', itmsNm: '잘못된 거래소 응답', mrktCtg: 'GLOBAL-KOSPI', clpr: '1000', basDt: '20260818' };
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
    marketData.fetchKrDate = async () => { fetchCount++; return [...rows, invalidMarketRow]; };
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 1, '첫 국내 시세 확인은 공공데이터를 한 번 호출해야 합니다.');
    assert.equal(marketData.kr.has('777777'), false, '허용하지 않는 거래소의 공급자 응답은 시세에 저장하면 안 됩니다.');
    assert.equal(tempUniverse.lookup('777777'), null, '허용하지 않는 거래소의 공급자 응답은 종목 목록에 저장하면 안 됩니다.');
    const availableQuote = marketData.quote({ code: '000001', name: '테스트1', market: 'KOSPI', active: true });
    const unavailableQuote = marketData.quote({ code: '999999', name: '미수집', market: 'KOSPI', active: true });
    assert.deepEqual(Object.keys(availableQuote).sort(), availableQuoteFields, '수집된 시세는 국내 전용 허용 필드를 정확히 반환해야 합니다.');
    assert.deepEqual(Object.keys(unavailableQuote).sort(), unavailableQuoteFields, '미수집 시세도 국내 전용 허용 필드를 정확히 반환해야 합니다.');
    fakeNow += 3_599_999;
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 1, '1시간이 되기 전에는 공공데이터를 다시 호출하면 안 됩니다.');
    fakeNow += 1;
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 2, '정확히 1시간이 지나면 공공데이터를 다시 호출해야 합니다.');

    marketData.fetchKrDate = async () => { fetchCount++; await new Promise((resolve) => setImmediate(resolve)); return rows; };
    await Promise.all([marketData.refreshKr(true), marketData.refreshKr(true), marketData.refreshKr(true)]);
    assert.equal(fetchCount, 3, '동시 갱신 요청은 하나의 공공데이터 호출로 합쳐야 합니다.');

    const beforeEntries = JSON.stringify([...marketData.kr.entries()]);
    const beforeCache = readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8');
    marketData.fetchKrDate = async () => { throw new Error('의도한 네트워크 실패'); };
    const failed = await marketData.refreshKr(true);
    assert.match(failed.error, /의도한 네트워크 실패/, '갱신 실패 원인을 상태에 남겨야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '갱신 실패 시 마지막 정상 시세를 보존해야 합니다.');
    assert.equal(readFileSync(path.join(tempDir, 'kr-public-prices.json'), 'utf8'), beforeCache, '갱신 실패 시 마지막 정상 캐시 파일을 보존해야 합니다.');

    marketData.fetchKrDate = async () => [...rows.slice(0, 80), ...rows.slice(0, 40)];
    const duplicated = await marketData.refreshKr(true);
    assert.ok(duplicated.error, '중복 행으로 고유 종목이 크게 줄어든 응답은 거부해야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '중복·부분 응답이 마지막 정상 시세를 덮으면 안 됩니다.');

    marketData.fetchKrDate = async () => rows.slice(0, 100);
    const partial = await marketData.refreshKr(true);
    assert.ok(partial.error, '이전 정상 종목 수보다 크게 줄어든 부분 응답은 거부해야 합니다.');
    assert.equal(JSON.stringify([...marketData.kr.entries()]), beforeEntries, '부분 응답이 마지막 정상 시세를 덮으면 안 됩니다.');

    const fsModule = require('node:fs');
    const realRenameSync = fsModule.renameSync;
    marketData.fetchKrDate = async () => rows;
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
    assert.equal(failureCalls, 1, '실패 직후 비강제 요청도 1시간 동안 외부 조회를 반복하면 안 됩니다.');
    fakeNow += 3_600_000;
    await failingMarket.refreshKr(false);
    assert.equal(failureCalls, 2, '실패 후에도 1시간이 지나면 외부 조회를 다시 시도해야 합니다.');
  } finally {
    Date.now = realDateNow;
    console.warn = realWarn;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const envExample = read('.env.example');
assert.doesNotMatch(envExample, /^PUBLIC_DATA_REFRESH_MS=/m, '고정 1시간 주기를 오래된 서버 환경값이 덮어쓰면 안 됩니다.');
const marketDataSource = read('lib/market-data.js');
const providerUrls = [...marketDataSource.matchAll(/https?:\/\/[^'"\s]+/g)].map((match) => match[0]);
assert.deepEqual(providerUrls, ['https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo'], '시세 공급자는 공공데이터포털 금융위원회 API 하나여야 합니다.');

const serverSource = read('server.js');
assert.match(serverSource, /const PUBLIC_DATA_REFRESH_MS = 60\*60\*1000;/, '서버의 국내 시세 확인 주기는 정확히 1시간이어야 합니다.');
assert.match(serverSource, /setInterval\([^\n]+PUBLIC_DATA_REFRESH_MS\)\.unref\(\)/, '국내 시세 스케줄러가 고정 1시간 상수를 사용해야 합니다.');
assert.ok(serverSource.includes('domesticCorporateActions'), '기업행동은 국내 6자리 코드 허용목록을 거쳐야 합니다.');
assert.ok((serverSource.match(/domesticStateView\(/g) || []).length >= 2, '학생 응답과 교사 자산 요약은 국내 상태 보기만 사용해야 합니다.');
assert.ok(serverSource.includes('if(row) state=(await withStudentState(id,epo,null)).state;'), '기존 학생 로그인 응답도 국내 상태 보기를 사용해야 합니다.');
assert.ok(serverSource.includes('state=domesticStateView(state);'), '신규·기존 학생 로그인 응답에 같은 국내 상태 보기를 적용해야 합니다.');
assert.ok(serverSource.includes('if(!isDomesticTransaction(tx))'), '숨겨진 비국내 거래 기록의 메모를 수정할 수 없어야 합니다.');
assert.ok(serverSource.includes('newCode=changesCode?resolveStockCode(newInput):oldCode'), '코드변경·합병 외 기업행동은 신규 코드를 기존 국내 코드로 고정해야 합니다.');
assert.ok(serverSource.includes('domesticCorporateActions(db.listCorporateActions({limit:Number.MAX_SAFE_INTEGER})).slice(0,500)'), '기업행동은 국내 필터 후 목록 상한을 적용해야 합니다.');
assert.ok(serverSource.includes('db.getCorporateAction(caMatch[1])'), '기업행동 수정은 목록 상한과 무관하게 ID로 직접 조회해야 합니다.');
assert.ok((serverSource.match(/if\(!r\.error\)prices\.clear\(\)/g)||[]).length>=2, '관리자·주기 갱신 실패 시 마지막 정상 가격 캐시를 유지해야 합니다.');
const dbSource = read('lib/db.js');
assert.ok(dbSource.includes('getCorporateAction,'), '기업행동 단건 조회 함수가 DB 경계에 노출되어야 합니다.');

const packageJson = JSON.parse(read('package.json'));
assert.deepEqual(Object.keys(packageJson.dependencies || {}), ['pg'], '운영 의존성은 pg 하나만 유지해야 합니다.');
console.log(`국내 전용 시장 검사 통과 (${universeData.stocks.length.toLocaleString('ko-KR')}개 종목, 1시간 확인)`);
