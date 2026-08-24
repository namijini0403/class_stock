(function exposeDailyChart(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyChart = api;
})(typeof window !== 'undefined' ? window : null, function dailyChartFactory() {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dateValue(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return timestamp;
  }

  function normalizeBar(source) {
    if (!source || typeof source !== 'object') return null;
    const date = String(source.date || source.asOfDate || '').trim();
    if (dateValue(date) === null) return null;
    const open = finiteNumber(source.open), high = finiteNumber(source.high), low = finiteNumber(source.low);
    const close = finiteNumber(source.close ?? source.price), rawVolume = finiteNumber(source.volume);
    if (![open, high, low, close].every((value) => value !== null && value > 0)) return null;
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;
    return {
      date,
      open,
      high,
      low,
      close,
      volume: rawVolume !== null && rawVolume > 0 ? rawVolume : 0,
    };
  }

  function normalizeBars(input) {
    const byDate = new Map();
    for (const source of Array.isArray(input) ? input : []) {
      const bar = normalizeBar(source);
      if (bar) byDate.set(bar.date, bar);
    }
    return [...byDate.values()].sort((a, b) => dateValue(a.date) - dateValue(b.date));
  }

  function selectRecentBars(input, count) {
    const bars = normalizeBars(input);
    const limit = Math.max(1, Math.floor(finiteNumber(count) || 1));
    return bars.slice(-limit);
  }

  function filterBarsByDays(input, days) {
    const bars = normalizeBars(input);
    if (!bars.length) return [];
    const range = Math.max(1, Math.floor(finiteNumber(days) || 1));
    const lastDay = dateValue(bars[bars.length - 1].date);
    const cutoff = lastDay - (range - 1) * DAY_MS;
    return bars.filter((bar) => dateValue(bar.date) >= cutoff);
  }

  function summarizeBars(input) {
    const bars = normalizeBars(input);
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

  function buildChartModel(input, options) {
    const bars = normalizeBars(input);
    if (!bars.length) return null;
    const opts = options || {};
    const width = Math.max(320, finiteNumber(opts.width) || 640);
    const height = Math.max(240, finiteNumber(opts.height) || 340);
    const left = 68, right = 14, top = 18, bottom = 28, volumeHeight = 62, gap = 20;
    const plotWidth = width - left - right;
    const priceBottom = height - bottom - volumeHeight - gap;
    const priceHeight = priceBottom - top;
    const volumeTop = priceBottom + gap;
    const rawHigh = Math.max(...bars.map((bar) => bar.high));
    const rawLow = Math.min(...bars.map((bar) => bar.low));
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
    const dateTicks = dateIndexes.map((index) => ({ date: bars[index].date, x: candles[index].x }));

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
      summary: summarizeBars(bars),
    };
  }

  return Object.freeze({ normalizeBar, normalizeBars, selectRecentBars, filterBarsByDays, summarizeBars, buildChartModel });
});
