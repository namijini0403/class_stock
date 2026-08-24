(function exposeDailyChart(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyChart = api;
})(typeof window !== 'undefined' ? window : null, function dailyChartFactory() {
  'use strict';

  const PERIODS = Object.freeze({
    '1m': Object.freeze({ key: '1m', label: '1개월', months: 1 }),
    '3m': Object.freeze({ key: '3m', label: '3개월', months: 3 }),
    '6m': Object.freeze({ key: '6m', label: '6개월', months: 6 }),
    '1y': Object.freeze({ key: '1y', label: '1년', months: 12 }),
    '3y': Object.freeze({ key: '3y', label: '3년', months: 36 }),
    '5y': Object.freeze({ key: '5y', label: '5년', months: 60 }),
    '10y': Object.freeze({ key: '10y', label: '10년', months: 120 }),
  });

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dateParts(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day, timestamp };
  }

  function dateValue(value) {
    return dateParts(value)?.timestamp ?? null;
  }

  function dateText(timestamp) {
    const date = new Date(timestamp);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function periodSpec(period) {
    return PERIODS[String(period || '')] || null;
  }

  function rangeStartForPeriod(rangeEnd, period) {
    const anchor = dateParts(rangeEnd), spec = periodSpec(period);
    if (!anchor || !spec) return '';
    const absoluteMonth = anchor.year * 12 + (anchor.month - 1) - spec.months;
    const year = Math.floor(absoluteMonth / 12);
    const monthIndex = absoluteMonth - year * 12;
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return dateText(Date.UTC(year, monthIndex, Math.min(anchor.day, lastDay)));
  }

  function formatDateTick(value, period) {
    const parts = dateParts(value);
    if (!parts) return String(value || '');
    return PERIODS[period]?.months >= 12
      ? `${String(parts.year).slice(2)}.${String(parts.month).padStart(2, '0')}`
      : `${String(parts.month).padStart(2, '0')}.${String(parts.day).padStart(2, '0')}`;
  }

  function reusableCoverageMonths(meta, requestedPeriod) {
    const spec = periodSpec(requestedPeriod);
    if (!spec || meta?.partial) return 0;
    return spec.months;
  }

  function rangeAvailability(meta, selectedPeriod, firstDisplayedDate) {
    const selectedStart = rangeStartForPeriod(meta?.rangeEnd, selectedPeriod);
    const first = dateParts(firstDisplayedDate);
    const start = dateParts(selectedStart);
    const delayedStartDays = first && start ? Math.max(0, Math.round((first.timestamp - start.timestamp) / 86400000)) : 0;
    return {
      selectedStart,
      coverageStart: dateParts(meta?.coverageStart) ? String(meta.coverageStart) : '',
      firstDisplayedDate: first ? String(firstDisplayedDate) : '',
      delayedStartDays,
      historyLimited: delayedStartDays > 7,
      partial: Boolean(meta?.partial),
    };
  }

  function normalizeBar(source) {
    if (!source || typeof source !== 'object') return null;
    const date = String(source.date || source.asOfDate || '').trim();
    if (dateValue(date) === null) return null;
    const open = finiteNumber(source.open), high = finiteNumber(source.high), low = finiteNumber(source.low);
    const close = finiteNumber(source.close ?? source.price), rawVolume = finiteNumber(source.volume);
    if (![open, high, low, close].every((value) => value !== null && value > 0)) return null;
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;
    return { date, open, high, low, close, volume: rawVolume !== null && rawVolume > 0 ? rawVolume : 0 };
  }

  function normalizeBars(input) {
    const byDate = new Map();
    for (const source of Array.isArray(input) ? input : []) {
      const bar = normalizeBar(source);
      if (bar) byDate.set(bar.date, bar);
    }
    return [...byDate.values()].sort((a, b) => dateValue(a.date) - dateValue(b.date));
  }

  function filterBarsByRange(input, period, rangeEnd) {
    const bars = normalizeBars(input);
    if (!bars.length || !periodSpec(period)) return [];
    const suppliedRangeEnd = rangeEnd !== null && rangeEnd !== undefined && String(rangeEnd).trim() !== '';
    if (suppliedRangeEnd && dateValue(String(rangeEnd)) === null) return [];
    const anchor = suppliedRangeEnd ? String(rangeEnd) : bars[bars.length - 1].date;
    const start = rangeStartForPeriod(anchor, period);
    return bars.filter((bar) => bar.date >= start && bar.date <= anchor);
  }

  function aggregateNormalizedBars(bars, maximum) {
    const limit = Math.max(1, Math.floor(finiteNumber(maximum) || 1));
    const bucketCount = Math.min(bars.length, limit);
    const output = [];
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const startIndex = Math.floor(bucket * bars.length / bucketCount);
      const endIndex = Math.floor((bucket + 1) * bars.length / bucketCount);
      const first = bars[startIndex], last = bars[endIndex - 1];
      let high = first.high, low = first.low, volume = 0;
      for (let index = startIndex; index < endIndex; index++) {
        const bar = bars[index];
        high = Math.max(high, bar.high);
        low = Math.min(low, bar.low);
        volume += bar.volume;
      }
      output.push({
        date: last.date,
        startDate: first.date,
        endDate: last.date,
        sourceCount: endIndex - startIndex,
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
      });
    }
    return output;
  }

  function aggregateBars(input, maximum) {
    return aggregateNormalizedBars(normalizeBars(input), maximum);
  }

  function summarizeNormalizedBars(bars) {
    if (!bars.length) return null;
    const first = bars[0], last = bars[bars.length - 1];
    const change = last.close - first.close;
    return {
      count: bars.length,
      firstDate: first.date,
      lastDate: last.date,
      firstClose: first.close,
      lastClose: last.close,
      highest: Math.max(...bars.map((bar) => bar.high)),
      lowest: Math.min(...bars.map((bar) => bar.low)),
      change,
      changeRate: first.close > 0 ? change / first.close * 100 : 0,
      totalVolume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    };
  }

  function summarizeBars(input) {
    return summarizeNormalizedBars(normalizeBars(input));
  }

  function buildChartModel(input, options) {
    const sourceBars = normalizeBars(input);
    if (!sourceBars.length) return null;
    const opts = options || {};
    const width = Math.max(320, finiteNumber(opts.width) || 640);
    const height = Math.max(240, finiteNumber(opts.height) || 340);
    const left = 68, right = 14, top = 18, bottom = 28, volumeHeight = 62, gap = 20;
    const plotWidth = width - left - right;
    const priceBottom = height - bottom - volumeHeight - gap;
    const priceHeight = priceBottom - top;
    const volumeTop = priceBottom + gap;
    const requestedMaximum = finiteNumber(opts.maxCandles);
    const maximum = Math.max(1, Math.floor(requestedMaximum || plotWidth / 2.2));
    const bars = aggregateNormalizedBars(sourceBars, maximum);
    const rawHigh = Math.max(...sourceBars.map((bar) => bar.high));
    const rawLow = Math.min(...sourceBars.map((bar) => bar.low));
    const rawRange = rawHigh - rawLow;
    const padding = rawRange > 0 ? rawRange * 0.07 : Math.max(rawHigh * 0.02, 1);
    const priceMax = rawHigh + padding;
    const priceMin = Math.max(0, rawLow - padding);
    const priceRange = Math.max(priceMax - priceMin, 1);
    const maxVolume = Math.max(1, ...bars.map((bar) => bar.volume));
    const step = plotWidth / bars.length;
    const candleWidth = Math.min(11, Math.max(1, step * 0.62));
    const yForPrice = (price) => top + (priceMax - price) / priceRange * priceHeight;

    const candles = bars.map((bar, index) => {
      const x = left + step * (index + 0.5);
      const openY = yForPrice(bar.open), closeY = yForPrice(bar.close);
      const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
      const bodyY = bodyHeight === 1.5 ? (openY + closeY) / 2 - bodyHeight / 2 : Math.min(openY, closeY);
      return {
        ...bar,
        x,
        wickTop: yForPrice(bar.high),
        wickBottom: yForPrice(bar.low),
        bodyX: x - candleWidth / 2,
        bodyY,
        bodyWidth: candleWidth,
        bodyHeight,
        volumeX: x - candleWidth / 2,
        volumeY: volumeTop + volumeHeight * (1 - bar.volume / maxVolume),
        volumeWidth: candleWidth,
        volumeHeight: volumeHeight * bar.volume / maxVolume,
        direction: bar.close > bar.open ? 'up' : bar.close < bar.open ? 'down' : 'flat',
      };
    });

    const priceTicks = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      return { value: priceMax - priceRange * ratio, y: top + priceHeight * ratio };
    });
    const desiredDateTicks = Math.min(5, bars.length);
    const dateIndexes = desiredDateTicks === 1
      ? [0]
      : [...new Set(Array.from({ length: desiredDateTicks }, (_, index) => Math.round(index * (bars.length - 1) / (desiredDateTicks - 1))))];
    const dateTicks = dateIndexes.map((index) => ({ date: bars[index].endDate, x: candles[index].x }));

    return {
      width,
      height,
      layout: { left, right, top, bottom, plotWidth, priceBottom, priceHeight, volumeTop, volumeHeight },
      priceMin,
      priceMax,
      maxVolume,
      candles,
      priceTicks,
      dateTicks,
      summary: summarizeNormalizedBars(sourceBars),
      sourceCount: sourceBars.length,
      renderedCount: bars.length,
      aggregated: bars.length < sourceBars.length,
    };
  }

  return Object.freeze({ PERIODS, periodSpec, rangeStartForPeriod, formatDateTick, reusableCoverageMonths, rangeAvailability, normalizeBar, normalizeBars, filterBarsByRange, aggregateBars, summarizeBars, buildChartModel });
});
