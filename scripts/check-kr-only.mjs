#!/usr/bin/env node
// 국내 주식 전용 시장 구성 회귀 검사. DB와 외부 네트워크 없이 실행한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const universeData = JSON.parse(read('data/stock-universe.json'));
assert.ok(universeData.stocks.length > 100, '국내 종목 캐시에 충분한 종목이 있어야 합니다.');
assert.ok(universeData.stocks.every((stock) => /^\d{6}$/.test(stock.code)), '종목 코드는 국내 6자리 코드여야 합니다.');
assert.ok((universeData.retiredStocks || []).every((stock) => /^\d{6}$/.test(stock.code)), '비활성 종목도 국내 6자리 코드여야 합니다.');
const obsoleteMarketKeys = [
  ['country'].join(''), ['currency'].join(''), ['display', 'Code'].join(''), ['symbol'].join(''),
  ['native', 'Price'].join(''), ['native', 'Change'].join(''), ['f', 'x', 'Rate'].join(''),
];
for (const stock of [...universeData.stocks, ...(universeData.retiredStocks || [])]) {
  for (const key of obsoleteMarketKeys) assert.ok(!(key in stock), `종목 캐시에 다중시장 필드가 남았습니다: ${key}`);
}

const { StockUniverse } = require(path.join(ROOT, 'lib/universe.js'));
const { isDomesticCode, domesticCorporateActions, domesticStateView } = require(path.join(ROOT, 'lib/domestic.js'));
const universe = new StockUniverse(path.join(ROOT, 'data/stock-universe.json'));
assert.equal(universe.search('', { market: 'GLOBAL' }).total, 0, '국내 거래소가 아닌 시장 검색 결과는 0개여야 합니다.');
assert.equal(universe.resolveCode('ABC123'), '', '6자리 숫자가 아닌 코드를 종목 코드로 해석하면 안 됩니다.');
assert.equal(isDomesticCode('005930'), true, '국내 6자리 종목코드를 허용해야 합니다.');
assert.equal(isDomesticCode('ABC123'), false, '숫자 6자리가 아닌 종목코드는 거부해야 합니다.');
assert.equal(isDomesticCode(' 005930 '), false, '공백이 섞인 종목코드는 정규 코드로 허용하면 안 됩니다.');

const rawState = {
  cash: 500000,
  metadata: { [obsoleteMarketKeys[0]]: 'OTHER', nested: { [obsoleteMarketKeys[6]]: 1 } },
  holdings: {
    '005930': { qty: 2, avgPrice: 70000, name: '삼성전자', country: 'KR', currency: 'KRW', displayCode: '005930' },
    ABC123: { qty: 1, avgPrice: 100, name: '비국내 종목', currency: 'OTHER' },
    '999999': { qty: 1, avgPrice: 100, name: '잘못된 거래소 종목', market: 'GLOBAL' },
    ' 000660 ': { qty: 1, avgPrice: 100000, name: '공백 코드' },
  },
  transactions: [
    { id: 'domestic-trade', type: 'TRADE', code: '005930', price: 70000, [obsoleteMarketKeys[4]]: 70000, [obsoleteMarketKeys[6]]: 1 },
    { id: 'foreign-trade', type: 'TRADE', code: 'ABC123', price: 100 },
    { id: 'invalid-market-trade', type: 'TRADE', code: '999999', market: 'GLOBAL', price: 100 },
    { id: 'domestic-action', type: 'CORPORATE', code: '005930', newCode: '000660' },
    { id: 'foreign-action', type: 'CORPORATE', code: 'ABC123', newCode: '' },
    { id: 'empty-trade', type: 'TRADE', code: '', price: 100 },
    { id: 'empty-action', type: 'CORPORATE', code: '', newCode: '' },
    { id: 'unknown', type: 'UNKNOWN', code: '' },
    { id: 'teacher', type: 'TEACHER', code: 'ABC123', market: 'GLOBAL', signedAmount: 1000 },
  ],
};
const rawSnapshot = JSON.stringify(rawState);
const stateView = domesticStateView(rawState);
assert.deepEqual(Object.keys(stateView.holdings), ['005930'], '학생 화면에는 국내 보유 종목만 노출해야 합니다.');
assert.deepEqual(stateView.transactions.map((tx) => tx.id), ['domestic-trade', 'domestic-action', 'teacher'], '국내 주식 기록과 교사 기록만 노출해야 합니다.');
const teacherView = stateView.transactions.find((tx) => tx.type === 'TEACHER');
assert.ok(!('code' in teacherView) && !('market' in teacherView), '교사 지급 기록에 오염된 주식 필드를 노출하면 안 됩니다.');
assert.equal(JSON.stringify(rawState), rawSnapshot, '화면용 국내 상태 생성은 DB 원본을 변경하면 안 됩니다.');
for (const key of obsoleteMarketKeys) assert.ok(!JSON.stringify(stateView).includes(`\"${key}\"`), `학생 응답에 다중시장 필드가 남았습니다: ${key}`);
assert.deepEqual(domesticCorporateActions([
  { id: 'domestic', oldCode: '005930', newCode: '000660' },
  { id: 'domestic-empty', oldCode: '005930', newCode: '' },
  { id: 'invalid-old', oldCode: 'ABC123', newCode: '' },
  { id: 'invalid-new', oldCode: '005930', newCode: 'ABC123' },
  { id: 'invalid-market', oldCode: '999999', newCode: '', market: 'GLOBAL' },
  { id: 'spaced-old', oldCode: ' 005930 ', newCode: '000660' },
]).map((action) => action.id), ['domestic', 'domestic-empty'], '기업행동의 기존·신규 코드가 모두 국내 코드여야 합니다.');

const { MarketDataService } = require(path.join(ROOT, 'lib/market-data.js'));
const tempDir = mkdtempSync(path.join(tmpdir(), 'class-stock-kr-check-'));
try {
  const mixedFile = path.join(tempDir, 'mixed-universe.json');
  writeFileSync(mixedFile, JSON.stringify({
    source: 'LEGACY_MIXED_CACHE',
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
  const mixedUniverse = new StockUniverse(mixedFile);
  assert.deepEqual(mixedUniverse.stocks.map((stock) => stock.code), ['005930'], '혼합 캐시의 비국내 활성 종목을 로드하면 안 됩니다.');
  assert.deepEqual([...mixedUniverse.retired.keys()], ['000660'], '혼합 캐시의 비국내 비활성 종목을 로드하면 안 됩니다.');
  assert.equal(mixedUniverse.lookup('ABC123'), null, '비국내 종목은 직접 조회할 수 없어야 합니다.');

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
  const oldCacheDir = path.join(tempDir, 'old-cache');
  mkdirSync(oldCacheDir, { recursive: true });
  const oldCacheUniverse = new StockUniverse(path.join(oldCacheDir, 'universe.json'), eventStocks);
  const oldCacheItems = Array.from({ length: 120 }, (_, index) => ({
    code: String(index + 1).padStart(6, '0'), name: `과거캐시${index + 1}`, market: 'KOSPI', price: 1000,
    change: 10, changeRate: 1, asOfDate: '2026-08-18', updatedAt: 1_000,
    [obsoleteMarketKeys[0]]: 'KR', [obsoleteMarketKeys[1]]: 'KRW', [obsoleteMarketKeys[4]]: 1000, [obsoleteMarketKeys[6]]: 1,
  }));
  oldCacheItems.push({ code: '777777', name: '잘못된 거래소 캐시', market: 'GLOBAL-KOSPI', price: 1000 });
  writeFileSync(path.join(oldCacheDir, 'kr-public-prices.json'), JSON.stringify({ meta: { updatedAt: 1_000 }, items: oldCacheItems }), 'utf8');
  const oldCacheService = new MarketDataService({ dataDir: oldCacheDir, universe: oldCacheUniverse, serviceKey: '' });
  const cleanedCachedQuote = oldCacheService.quote({ code: '000001', name: '과거캐시1', market: 'KOSPI', active: true });
  for (const key of obsoleteMarketKeys) assert.ok(!(key in cleanedCachedQuote), `기존 국내 캐시를 읽을 때 다중시장 필드를 제거해야 합니다: ${key}`);
  assert.equal(oldCacheUniverse.lookup('777777'), null, '허용하지 않는 거래소의 캐시 종목은 로드하면 안 됩니다.');

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
    for (const quote of [availableQuote, unavailableQuote]) {
      for (const key of obsoleteMarketKeys) assert.ok(!(key in quote), `시세 응답에 다중시장 필드가 남았습니다: ${key}`);
    }
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

function filesystemFiles() {
  const found = [];
  const excludedDirectories = new Set(['.git', 'node_modules', 'runtime']);
  function walk(absolute, relative = '') {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || entry.name.endsWith('-hist-inbox')) continue;
        walk(path.join(absolute, entry.name), nextRelative);
        continue;
      }
      if (entry.name === '.env' || (entry.name.startsWith('.env.') && entry.name !== '.env.example')) continue;
      if (['ADMIN_PASSWORD.txt', 'PUBLIC_DATA_KEY.txt', 'startup-log.txt'].includes(entry.name) || entry.name.endsWith('.log')) continue;
      if (/^data\/(?:server-data|[^/]+-prices)\.json$/.test(nextRelative)) continue;
      found.push(nextRelative);
    }
  }
  walk(ROOT);
  return found;
}
function projectFiles() {
  if (process.env.KR_ONLY_SCAN_FILESYSTEM === '1') return filesystemFiles();
  try {
    const gitArgs = ['-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, 'ls-files'];
    const tracked = execFileSync('git', [...gitArgs, '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean);
    const untracked = execFileSync('git', [...gitArgs, '--others', '--exclude-standard', '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  } catch {
    return filesystemFiles();
  }
}
const currentFiles = projectFiles();
const textExtensions = new Set(['', '.cmd', '.css', '.example', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.webmanifest']);
const forbiddenPatterns = [
  new RegExp(`(^|[^A-Za-z0-9])${['U', 'S'].join('')}([^A-Za-z0-9]|$)`, 'i'),
  new RegExp(['U', 'S', 'D'].join(''), 'i'),
  new RegExp(['I', 'E', 'X'].join(''), 'i'),
  new RegExp(['N', 'A', 'S', 'D', 'A', 'Q'].join(''), 'i'),
  new RegExp(['N', 'Y', 'S', 'E'].join(''), 'i'),
  new RegExp(`(^|[^A-Za-z0-9])${['F', 'X'].join('')}([^A-Za-z0-9]|$)`, 'i'),
  new RegExp(['refresh', 'U', 's'].join(''), 'i'),
  new RegExp(['enable', 'U', 's'].join(''), 'i'),
  new RegExp(['load', 'U', 's'].join(''), 'i'),
  new RegExp(['market', 'U', 'S'].join(''), 'i'),
  new RegExp(['u', 's', 'Market'].join(''), 'i'),
  new RegExp(['U', 's', 'Quote'].join(''), 'i'),
  new RegExp(['U', 's', 'Symbol'].join(''), 'i'),
  new RegExp(['u', 's', 'd', 'Krw'].join(''), 'i'),
  new RegExp(['f', 'x', 'Mode'].join(''), 'i'),
  new RegExp(['f', 'x', 'Rate'].join(''), 'i'),
  new RegExp(['f', 'x', 'Auto'].join(''), 'i'),
  new RegExp(['f', 'x', 'Cache'].join(''), 'i'),
  new RegExp(['auto', 'F', 'x'].join(''), 'i'),
  new RegExp(['refresh', 'F', 'x'].join(''), 'i'),
  new RegExp(['save', 'F', 'x'].join(''), 'i'),
  new RegExp(['enable', 'F', 'x'].join(''), 'i'),
  new RegExp(['f', 'x', 'Settings'].join(''), 'i'),
  new RegExp(['exchange', 'Rate'].join(''), 'i'),
  new RegExp(['foreign', 'Market'].join(''), 'i'),
  new RegExp(['A', 'A', 'P', 'L'].join(''), 'i'),
  new RegExp(['M', 'S', 'F', 'T'].join(''), 'i'),
  new RegExp(['T', 'S', 'L', 'A'].join(''), 'i'),
  new RegExp(['A', 'M', 'E', 'X'].join(''), 'i'),
  new RegExp(['A', 'm', 'e', 'r', 'i', 'c', 'a'].join(''), 'i'),
  new RegExp(['U', 'nited ', 'S', 'tates'].join(''), 'i'),
  new RegExp(['D', 'o', 'l', 'l', 'a', 'r'].join(''), 'i'),
  new RegExp(['미', '국'].join('')),
  new RegExp(['환', '율'].join('')),
  new RegExp(['달', '러'].join('')),
];
for (const relative of currentFiles) {
  for (const pattern of forbiddenPatterns) assert.doesNotMatch(relative, pattern, `추적 파일명에 삭제 대상 시장 참조가 남았습니다: ${relative}`);
  if (!textExtensions.has(path.extname(relative).toLowerCase())) continue;
  const content = read(relative);
  for (const pattern of forbiddenPatterns) assert.doesNotMatch(content, pattern, `${relative}에 삭제 대상 시장 참조가 남았습니다.`);
}
for (const file of ['server.js', 'lib/market-data.js', 'lib/universe.js', 'public/app.js']) {
  const content = read(file);
  for (const key of obsoleteMarketKeys) assert.ok(!content.includes(key), `${file}에 다중시장 필드가 남았습니다: ${key}`);
}

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
