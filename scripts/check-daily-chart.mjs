#!/usr/bin/env node
// 일봉 차트의 달력 기간, 장기 OHLCV 집계와 브라우저 연결 계약을 네트워크·DB 없이 검사한다.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chart = require(path.join(ROOT, 'public/daily-chart.js'));

assert.deepEqual(Object.keys(chart).sort(), [
  'PERIODS', 'aggregateBars', 'buildChartModel', 'filterBarsByRange', 'formatDateTick',
  'normalizeBar', 'normalizeBars', 'periodSpec', 'rangeAvailability', 'rangeStartForPeriod',
  'reusableCoverageMonths', 'summarizeBars',
].sort(), '일봉 차트 모듈의 공개 경계를 임의로 늘리면 안 됩니다.');

const expectedPeriods = [
  ['1m', '1개월', 1], ['3m', '3개월', 3], ['6m', '6개월', 6], ['1y', '1년', 12],
  ['3y', '3년', 36], ['5y', '5년', 60], ['10y', '10년', 120],
];
assert.deepEqual(Object.keys(chart.PERIODS), expectedPeriods.map(([key]) => key));
for (const [key, label, months] of expectedPeriods) assert.deepEqual(chart.periodSpec(key), { key, label, months });
assert.equal(chart.periodSpec('invalid'), null);

assert.equal(chart.rangeStartForPeriod('2024-03-31', '1m'), '2024-02-29', '윤년 월말은 2월 29일로 clamp해야 합니다.');
assert.equal(chart.rangeStartForPeriod('2023-03-31', '1m'), '2023-02-28', '평년 월말은 2월 28일로 clamp해야 합니다.');
assert.equal(chart.rangeStartForPeriod('2024-02-29', '1y'), '2023-02-28', '윤일에서 1년을 빼도 실재하는 날짜여야 합니다.');
assert.equal(chart.rangeStartForPeriod('2026-08-24', '10y'), '2016-08-24');
assert.equal(chart.rangeStartForPeriod('invalid', '1m'), '');
assert.equal(chart.formatDateTick('2026-08-24', '6m'), '08.24');
assert.equal(chart.formatDateTick('2026-08-24', '1y'), '26.08');
assert.equal(chart.formatDateTick('2016-08-24', '10y'), '16.08');
assert.equal(chart.reusableCoverageMonths({ partial: false }, '1y'), 12);
assert.equal(chart.reusableCoverageMonths({ partial: true, coverageStart: '2016-08-24' }, '1y'), 0, '부분 1년 응답을 서버의 더 넓은 coverage만 보고 장기 완전 캐시로 취급하면 안 됩니다.');
assert.equal(chart.reusableCoverageMonths({ partial: false }, 'invalid'), 0);
assert.deepEqual(chart.rangeAvailability({ rangeEnd: '2026-08-30', coverageStart: '2026-07-30', partial: false }, '1m', '2026-08-03'), {
  selectedStart: '2026-07-30', coverageStart: '2026-07-30', firstDisplayedDate: '2026-08-03', delayedStartDays: 4, historyLimited: false, partial: false,
}, '월초 휴장 뒤 첫 거래일을 신규 상장·제공 이력 부족으로 단정하면 안 됩니다.');
assert.equal(chart.rangeAvailability({ rangeEnd: '2026-08-30', coverageStart: '2026-07-30', partial: false }, '1m', '2026-08-20').historyLimited, true);

assert.equal(chart.normalizeBar(null), null, '빈 봉은 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-02-30', open: 1, high: 1, low: 1, close: 1 }), null, '실재하지 않는 날짜는 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-08-20', open: 0, high: 2, low: 1, close: 2 }), null, '0원 가격은 거부해야 합니다.');
assert.equal(chart.normalizeBar({ date: '2026-08-20', open: 3, high: 2, low: 1, close: 2 }), null, '고가가 시가·종가보다 낮은 비정상 봉은 거부해야 합니다.');

const raw = [
  { date: '2026-08-24', open: 1200, high: 1250, low: 1150, close: 1180, volume: 30 },
  { date: '2026-07-24', open: 1000, high: 1100, low: 900, close: 1050, volume: 10 },
  { date: '2026-08-21', open: 1050, high: 1190, low: 1030, close: 1180, volume: 20 },
  { date: '2026-08-21', open: 1060, high: 1210, low: 1040, close: 1200, volume: 25 },
  { date: '2026-08-25', open: 1180, high: 1200, low: 1170, close: 1190, volume: 40 },
  { date: 'invalid', open: 1, high: 1, low: 1, close: 1, volume: 1 },
];

const bars = chart.normalizeBars(raw);
assert.deepEqual(bars.map((bar) => bar.date), ['2026-07-24', '2026-08-21', '2026-08-24', '2026-08-25'], '봉은 날짜 오름차순·날짜별 하나여야 합니다.');
assert.equal(bars[1].close, 1200, '같은 날짜가 겹치면 마지막 정상 봉을 사용해야 합니다.');
assert.deepEqual(chart.filterBarsByRange(raw, '1m', '2026-08-24').map((bar) => bar.date), ['2026-07-24', '2026-08-21', '2026-08-24'], '응답 rangeEnd를 기준으로 달력 기간을 자르고 미래 봉을 제외해야 합니다.');
assert.deepEqual(chart.filterBarsByRange(raw, '1m', 'invalid'), [], '잘못된 응답 rangeEnd를 마지막 봉으로 조용히 대체하면 안 됩니다.');
assert.deepEqual(chart.filterBarsByRange(raw, 'invalid', '2026-08-24'), []);

const baseTime = Date.UTC(2016, 0, 1);
const longBars = Array.from({ length: 2500 }, (_, index) => {
  const date = new Date(baseTime + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const open = 1000 + index, close = open + (index % 3) - 1;
  return { date, open, high: Math.max(open, close) + 10 + index % 7, low: Math.min(open, close) - 8 - index % 5, close, volume: index + 1 };
});
const aggregated = chart.aggregateBars(longBars, 113);
assert.equal(aggregated.length, 113, '장기 일봉은 지정한 최대 구간 수로 집계해야 합니다.');
assert.equal(aggregated.reduce((sum, bar) => sum + bar.sourceCount, 0), longBars.length, '모든 원본 봉이 정확히 한 구간에 포함되어야 합니다.');
assert.equal(aggregated[0].open, longBars[0].open, '첫 시가를 보존해야 합니다.');
assert.equal(aggregated.at(-1).close, longBars.at(-1).close, '마지막 종가를 보존해야 합니다.');
assert.equal(Math.max(...aggregated.map((bar) => bar.high)), Math.max(...longBars.map((bar) => bar.high)), '전체 최고가를 보존해야 합니다.');
assert.equal(Math.min(...aggregated.map((bar) => bar.low)), Math.min(...longBars.map((bar) => bar.low)), '전체 최저가를 보존해야 합니다.');
assert.equal(aggregated.reduce((sum, bar) => sum + bar.volume, 0), longBars.reduce((sum, bar) => sum + bar.volume, 0), '거래량 합계를 보존해야 합니다.');
assert.ok(aggregated.every((bar) => bar.startDate <= bar.endDate && bar.sourceCount >= 1));

for (const width of [320, 640]) {
  const model = chart.buildChartModel(longBars, { width, height: 340 });
  const expectedMaximum = Math.floor(model.layout.plotWidth / 2.2);
  assert.equal(model.sourceCount, 2500);
  assert.ok(model.renderedCount <= expectedMaximum, `${width}px 차트의 렌더 봉 수가 폭 기반 상한을 넘으면 안 됩니다.`);
  assert.equal(model.candles.length, model.renderedCount);
  assert.equal(model.summary.count, 2500, '요약은 묶기 전 원본 일봉 기준이어야 합니다.');
  assert.equal(model.summary.highest, Math.max(...longBars.map((bar) => bar.high)));
  assert.equal(model.summary.lowest, Math.min(...longBars.map((bar) => bar.low)));
  assert.equal(model.aggregated, true);
  assert.ok(model.dateTicks.length >= 1 && model.dateTicks.length <= 5);
  for (const candle of model.candles) {
    for (const key of ['x', 'wickTop', 'wickBottom', 'bodyX', 'bodyY', 'bodyWidth', 'bodyHeight', 'volumeX', 'volumeY', 'volumeWidth', 'volumeHeight']) {
      assert.ok(Number.isFinite(candle[key]), `차트 좌표는 유한수여야 합니다: ${key}`);
    }
    assert.ok(candle.wickTop <= candle.bodyY + candle.bodyHeight);
    assert.ok(candle.wickBottom >= candle.bodyY);
  }
}

const smallModel = chart.buildChartModel(raw, { width: 640, height: 340 });
assert.equal(smallModel.aggregated, false);
assert.equal(smallModel.sourceCount, smallModel.renderedCount);

const appSource = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const htmlSource = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const styleSource = readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const workerSource = readFileSync(path.join(ROOT, 'public/service-worker.js'), 'utf8');
assert.equal((htmlSource.match(/data-chart-period=/g) || []).length, 7, '기간 버튼은 정확히 7개여야 합니다.');
for (const [key, label] of expectedPeriods) {
  assert.match(htmlSource, new RegExp(`data-chart-period="${key}"[^>]*>${label}<\\/button>`), `${label} 버튼과 기간 키가 연결되어야 합니다.`);
}
assert.equal((htmlSource.match(/data-chart-period="[^"]+"[^>]*aria-pressed="true"/g) || []).length, 1, '초기 활성 기간은 하나여야 합니다.');
assert.match(htmlSource, /class="daily-chart-ranges" role="group" aria-label="일봉 차트 기간"/);
assert.ok(htmlSource.includes('수정주가·투자수익률이 아닙니다.'));
assert.ok(htmlSource.includes('휴장일에는 봉이 없고'));
assert.ok(appSource.includes("selectDailyChartPeriod('1m',{requestPeriod:'1y'"), '첫 화면은 1개월을 선택하되 1년 자료를 미리 받아야 합니다.');
assert.match(appSource, /\/api\/chart\?code=.*period=\$\{encodeURIComponent\(period\)\}/, '새 period API 계약을 사용해야 합니다.');
assert.ok(appSource.includes('dailyChartPipelines') && appSource.includes('dailyChartPending'), '같은 종목의 장기 요청을 직렬화·재사용해야 합니다.');
assert.ok(appSource.includes('tradeDialogGeneration') && appSource.includes('dailyChartFetchId'), '주문 모달 세대와 차트 요청 세대를 분리해야 합니다.');
assert.ok(appSource.includes("data?.periodBasis!=='calendar-period'") && appSource.includes('reusableCoverageMonths'), '달력 응답을 검증하고 부분 응답을 전체 기간 캐시로 취급하면 안 됩니다.');
assert.ok(appSource.includes('휴장일·상장일·공공데이터 제공 이력에 따라 시작일이 다를 수 있음') && appSource.includes('coverageStart'), '기간 시작 공백과 부분 coverage를 사실대로 구분해야 합니다.');
assert.match(appSource, /DAILY_CHART_CLIENT_CACHE_MS=10\*60\*1000/, '14:10 서버 갱신을 하루 동안 가리지 않도록 브라우저 캐시는 짧아야 합니다.');
assert.match(appSource, /dailyChartLoading\|\|!dailyChartBars\.length/);
assert.match(appSource, /!dailyChartLoading&&dailyChartBars\.length/, '장기 범위 로딩 중 resize가 이전 봉을 새 기간으로 다시 그리면 안 됩니다.');
assert.ok((appSource.match(/showDailyChartEmpty\(/g) || []).length >= 5, '선택 범위가 비면 이전 차트·메타를 지우고 현재 빈 상태를 표시해야 합니다.');
assert.ok(appSource.includes('candle.startDate') && appSource.includes('candle.sourceCount'), '묶음 tooltip에 날짜 범위와 거래일 수를 표시해야 합니다.');
assert.match(styleSource, /grid-auto-flow:column/);
assert.match(styleSource, /overflow-x:auto/);
assert.match(styleSource, /\.daily-chart-range\{[^}]*min-width:48px[^}]*height:42px/);
assert.match(htmlSource, /<script src="\/daily-chart\.js"><\/script>\s*<script src="\/app\.js"><\/script>/, '차트 계산 모듈은 앱보다 먼저 로드해야 합니다.');
assert.ok(workerSource.includes("'/daily-chart.js'"), '오프라인 셸에 일봉 차트 스크립트를 포함해야 합니다.');

console.log('일봉 차트 검사 통과 (1개월~10년, 달력 범위·장기 OHLCV 집계·접근성 연결)');
