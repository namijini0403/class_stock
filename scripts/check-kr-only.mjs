#!/usr/bin/env node
// 국내 주식 전용 시장 구성 회귀 검사. DB와 외부 네트워크 없이 실행한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const universeData = JSON.parse(read('data/stock-universe.json'));
assert.ok(universeData.stocks.length > 100, '국내 종목 캐시에 충분한 종목이 있어야 합니다.');
assert.ok(universeData.stocks.every((stock) => stock.country === 'KR'), '종목 캐시에는 국내 종목만 있어야 합니다.');
assert.ok(universeData.stocks.every((stock) => stock.currency === 'KRW'), '종목 통화는 모두 KRW여야 합니다.');
assert.ok(universeData.stocks.every((stock) => /^\d{6}$/.test(stock.code)), '종목 코드는 국내 6자리 코드여야 합니다.');
assert.ok((universeData.retiredStocks || []).every((stock) => stock.country === 'KR'), '비활성 종목 캐시에도 미국 종목이 없어야 합니다.');

const { StockUniverse, parseNasdaqListed, parseOtherListed } = require(path.join(ROOT, 'lib/universe.js'));
const universe = new StockUniverse(path.join(ROOT, 'data/stock-universe.json'));
assert.equal(universe.search('', { market: 'US' }).total, 0, '미국 시장 검색 결과는 0개여야 합니다.');
assert.equal(universe.resolveCode('AAPL'), '', '미국 티커는 국내 종목 코드로 해석하면 안 됩니다.');
assert.equal(parseNasdaqListed, undefined, '미국 Nasdaq 종목 파서는 노출하면 안 됩니다.');
assert.equal(parseOtherListed, undefined, '미국 기타 거래소 종목 파서는 노출하면 안 됩니다.');

const { MarketDataService } = require(path.join(ROOT, 'lib/market-data.js'));
const tempDir = mkdtempSync(path.join(tmpdir(), 'class-stock-kr-check-'));
try {
  const mixedFile = path.join(tempDir, 'mixed-universe.json');
  writeFileSync(mixedFile, JSON.stringify({
    source: 'LEGACY_MIXED_CACHE',
    stocks: [
      { code: '005930', name: '삼성전자', market: 'KOSPI', country: 'KR', currency: 'KRW' },
      { code: 'US:OLD:AAPL', name: 'Apple', market: 'NASDAQ', country: 'US', currency: 'USD' },
    ],
    retiredStocks: [
      { code: '005930', name: '삼성전자 구형 중복', market: 'KOSPI', country: 'KR', currency: 'KRW' },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI', country: 'KR', currency: 'KRW' },
      { code: 'US:OLD:MSFT', name: 'Microsoft', market: 'NASDAQ', country: 'US', currency: 'USD' },
    ],
  }), 'utf8');
  const mixedUniverse = new StockUniverse(mixedFile);
  assert.deepEqual(mixedUniverse.stocks.map((stock) => stock.code), ['005930'], '구형 혼합 캐시의 미국 활성 종목을 로드하면 안 됩니다.');
  assert.deepEqual([...mixedUniverse.retired.keys()], ['000660'], '구형 혼합 캐시의 미국 비활성 종목을 로드하면 안 됩니다.');
  assert.equal(mixedUniverse.lookup('US:OLD:AAPL'), null, '구형 미국 종목은 직접 조회할 수 없어야 합니다.');

  const eventFile = path.join(tempDir, 'event-universe.json');
  const eventStocks = [
    { code: '005930', name: '삼성전자', market: 'KOSPI', country: 'KR', currency: 'KRW' },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', country: 'KR', currency: 'KRW' },
  ];
  const eventUniverse = new StockUniverse(eventFile, eventStocks);
  const removed = eventUniverse.replaceMarket('KR', eventStocks.slice(0, 1), { source: 'TEST', updatedAt: '2026-08-18T00:00:00.000Z' });
  assert.ok(removed.some((event) => event.type === 'REMOVED' && event.oldCode === '000660'), '사라진 국내 종목은 REMOVED 이벤트를 만들어야 합니다.');
  const restored = eventUniverse.replaceMarket('KR', eventStocks, { source: 'TEST', updatedAt: '2026-08-19T00:00:00.000Z' });
  assert.ok(restored.some((event) => event.type === 'RESTORED' && event.oldCode === '000660'), '다시 나타난 국내 종목은 RESTORED 이벤트를 만들어야 합니다.');

  const tempUniverse = new StockUniverse(path.join(tempDir, 'universe.json'), [
    { code: '005930', name: '삼성전자', market: 'KOSPI', country: 'KR', currency: 'KRW' },
  ]);
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
    marketData.fetchKrDate = async () => { fetchCount++; return rows; };
    await marketData.refreshKr(false);
    assert.equal(fetchCount, 1, '첫 국내 시세 확인은 공공데이터를 한 번 호출해야 합니다.');
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
for (const key of ['US_SYMBOL_REFRESH_MS', 'USD_KRW_RATE', 'FX_MODE', 'FX_AUTO_URL', 'FX_CACHE_MS']) {
  assert.doesNotMatch(envExample, new RegExp(`^${key}=`, 'm'), `${key} 설정은 제거되어야 합니다.`);
}

const forbiddenByFile = new Map([
  ['server.js', ['US_SYMBOL_REFRESH_MS', 'USD_KRW_RATE', 'FX_AUTO_URL', 'refreshUsSymbols', 'refreshAutoFx', '/api/admin/market-data/reload-us', '/api/admin/settings/fx', 'US:NAS:']],
  ['lib/market-data.js', ['IEX_HIST', 'iex-us-prices.json']],
  ['lib/universe.js', ['NASDAQ_LISTED_URL', 'refreshUsSymbols', "market==='US'"]],
  ['public/app.js', ['IEX_HIST', 'usdKrwRate', 'fmtUsd', 'priceSecondary', "country==='US'"]],
  ['public/teacher.js', ['reloadUsMarket', 'saveFx', 'refreshFx']],
  ['public/index.html', ['value="US"', 'IEX Exchange HIST', 'USD/KRW']],
  ['public/teacher.html', ['reloadUsMarketBtn', 'fxMode', 'usdKrwRate']],
]);
for (const [file, tokens] of forbiddenByFile) {
  const content = read(file);
  for (const token of tokens) assert.ok(!content.includes(token), `${file}에 미국/환율 참조가 남았습니다: ${token}`);
}

const serverSource = read('server.js');
assert.match(serverSource, /const PUBLIC_DATA_REFRESH_MS = 60\*60\*1000;/, '서버의 국내 시세 확인 주기는 정확히 1시간이어야 합니다.');
assert.match(serverSource, /setInterval\([^\n]+PUBLIC_DATA_REFRESH_MS\)\.unref\(\)/, '국내 시세 스케줄러가 고정 1시간 상수를 사용해야 합니다.');
assert.ok(serverSource.includes("!isLegacyUsCode(a.oldCode)&&!isLegacyUsCode(a.newCode)"), '레거시 기업행동은 기존·신규 코드 모두 국내여야 합니다.');
assert.ok((serverSource.match(/if\(!r\.error\)prices\.clear\(\)/g)||[]).length>=2, '관리자·주기 갱신 실패 시 마지막 정상 가격 캐시를 유지해야 합니다.');

assert.equal(existsSync(path.join(ROOT, 'tools/iex-hist-import.mjs')), false, 'IEX 변환 도구는 제거되어야 합니다.');
const packageJson = JSON.parse(read('package.json'));
assert.deepEqual(Object.keys(packageJson.dependencies || {}), ['pg'], '운영 의존성은 pg 하나만 유지해야 합니다.');
console.log(`국내 전용 시장 검사 통과 (${universeData.stocks.length.toLocaleString('ko-KR')}개 종목, 1시간 확인)`);
