#!/usr/bin/env node
// 일봉 차트의 순수 계산과 브라우저 연결 계약을 네트워크·DB 없이 검사한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chart = require(path.join(ROOT, 'public/daily-chart.js'));

assert.deepEqual(Object.keys(chart).sort(), [
  'buildChartModel', 'filterBarsByDays', 'normalizeBar', 'normalizeBars', 'selectRecentBars', 'summarizeBars',
].sort(), '일봉 차트 모듈의 공개 경계를 임의로 늘리면 안 됩니다.');

assert.equal(chart.normalizeBar(null), null, '빈 봉은 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-02-30', open: 1, high: 1, low: 1, close: 1 }), null, '실재하지 않는 날짜는 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-08-20', open: 0, high: 2, low: 1, close: 2 }), null, '0원 가격은 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-08-20', open: 3, high: 2, low: 1, close: 2 }), null, '고가가 시가·종가보다 낮은 비정상 봉은 거부해야 합니다.');

const raw = [
  { date: '2026-08-20', open: 1200, high: 1250, low: 1150, close: 1180, volume: 30 },
  { date: '2026-08-18', open: 1000, high: 1100, low: 900, close: 1050, volume: 10 },
  { date: '2026-08-19', open: 1050, high: 1190, low: 1030, close: 1180, volume: 20 },
  { date: '2026-08-19', open: 1060, high: 1210, low: 1040, close: 1200, volume: 25 },
  { date: 'invalid', open: 1, high: 1, low: 1, close: 1, volume: 1 },
];

const bars = chart.normalizeBars(raw);
assert.deepEqual(bars.map((bar) => bar.date), ['2026-08-18', '2026-08-19', '2026-08-20'], '봉은 날짜 오름차순·날짜별 하나여야 합니다.');
assert.equal(bars[1].close, 1200, '같은 날짜가 겹치면 마지막 정상 봉을 사용해야 합니다.');
assert.deepEqual(chart.selectRecentBars(raw, 2).map((bar) => bar.date), ['2026-08-19', '2026-08-20'], '기간 탭은 최신 거래일 봉 수를 기준으로 잘라야 합니다.');
assert.deepEqual(chart.filterBarsByDays(raw, 2).map((bar) => bar.date), ['2026-08-19', '2026-08-20'], '기간 탭은 마지막 봉 날짜 기준 달력일 범위만 보여줘야 합니다.');
const gapBars = [
  { date: '2026-08-14', open: 1000, high: 1100, low: 900, close: 1050, volume: 10 },
  { date: '2026-08-18', open: 1050, high: 1150, low: 1000, close: 1100, volume: 20 },
];
assert.deepEqual(chart.filterBarsByDays(gapBars, 2).map((bar) => bar.date), ['2026-08-18'], '휴장일을 가짜 봉으로 채우거나 달력일 범위 밖 봉을 포함하면 안 됩니다.');

const summary = chart.summarizeBars(raw);
assert.equal(summary.count, 3);
assert.equal(summary.firstDate, '2026-08-18');
assert.equal(summary.lastDate, '2026-08-20');
assert.equal(summary.highest, 1250);
assert.equal(summary.lowest, 900);
assert.equal(summary.change, 130);
assert.ok(Math.abs(summary.changeRate - (130 / 1050 * 100)) < 1e-9);
assert.equal(summary.totalVolume, 65);

const model = chart.buildChartModel(raw, { width: 640, height: 340 });
assert.equal(model.candles.length, 3, '정상 봉마다 캔들 하나를 만들어야 합니다.');
assert.deepEqual(model.candles.map((bar) => bar.direction), ['up', 'up', 'down']);
assert.equal(model.priceTicks.length, 5);
assert.ok(model.dateTicks.length >= 1 && model.dateTicks.length <= 5);
for (const candle of model.candles) {
  for (const key of ['x', 'wickTop', 'wickBottom', 'bodyX', 'bodyY', 'bodyWidth', 'bodyHeight', 'volumeX', 'volumeY', 'volumeWidth', 'volumeHeight']) {
    assert.ok(Number.isFinite(candle[key]), `차트 좌표는 유한수여야 합니다: ${key}`);
  }
  assert.ok(candle.wickTop <= candle.bodyY + candle.bodyHeight, '고가 심지가 캔들 몸통 아래에 있으면 안 됩니다.');
  assert.ok(candle.wickBottom >= candle.bodyY, '저가 심지가 캔들 몸통 위에 있으면 안 됩니다.');
}

const appSource = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const htmlSource = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const workerSource = readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');
assert.match(appSource, /\/api\/chart\?code=.*days=365/, '종목 창을 열 때 180일 탭을 충분히 채울 일봉을 한 번 요청해야 합니다.');
assert.ok(appSource.includes('dailyChartRequestId'), '종목을 빠르게 바꿀 때 이전 차트 응답을 무시하는 경계가 필요합니다.');
assert.ok(appSource.includes('refreshPromise'), '같은 시점의 화면 갱신 요청은 하나로 합쳐야 합니다.');
assert.ok(appSource.includes('dialogGeneration=dailyChartRequestId'), '종목 창을 닫거나 바꾼 뒤 늦은 주문 응답을 현재 창에 반영하면 안 됩니다.');
assert.match(appSource, /<button type="button" class="stock-card/, '종목 카드는 키보드로도 열 수 있는 실제 버튼이어야 합니다.');
assert.match(htmlSource, /<script src="\/daily-chart\.js"><\/script>\s*<script src="\/app\.js"><\/script>/, '차트 계산 모듈은 앱보다 먼저 로드해야 합니다.');
assert.ok(workerSource.includes("'/daily-chart.js'"), '오프라인 셸에 일봉 차트 스크립트를 포함해야 합니다.');

console.log('일봉 차트 검사 통과 (30·90·180일 범위, SVG 계산·연결)');
