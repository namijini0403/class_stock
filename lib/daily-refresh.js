'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function finiteTimestamp(value, fallback = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function targetForKstDate(nowMs = Date.now(), hour = 14, minute = 10) {
  const now = finiteTimestamp(nowMs);
  const kst = new Date(now + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hour, minute) - KST_OFFSET_MS;
}

function msUntilNextKstRefresh(nowMs = Date.now(), hour = 14, minute = 10) {
  const now = finiteTimestamp(nowMs);
  let target = targetForKstDate(now, hour, minute);
  if (target <= now) target += DAY_MS;
  return Math.max(1000, Math.min(DAY_MS, target - now));
}

function shouldForceInitialKstRefresh(updatedAt, nowMs = Date.now(), hour = 14, minute = 10) {
  const now = finiteTimestamp(nowMs);
  const target = targetForKstDate(now, hour, minute);
  return now >= target && finiteTimestamp(updatedAt, 0) < target;
}

module.exports = { DAY_MS, targetForKstDate, msUntilNextKstRefresh, shouldForceInitialKstRefresh };
