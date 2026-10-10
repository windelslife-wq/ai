/**
 * Candle normalization, validation and the deterministic math the synthetic
 * provider needs.
 *
 * Ported from `application/libraries/Aegis/CandleNormalizer.php` and the three
 * `MathUtils` functions it depends on (`hashString`, `seededRandom`,
 * `gaussian`). The rules are preserved exactly — dropping non-positive or
 * non-finite rows, clamping high/low around the open/close body, sorting,
 * de-duplicating, counting gaps, and the `ok` threshold — because every layer
 * downstream reads `validation` to decide whether a series may be analysed at
 * all. A normalizer that quietly repaired bad data would let an analysis run on
 * a series no provider actually served.
 */

import { timeframeMs } from "./timeframes.js";

const MAX_ISSUES = 20;

function toFiniteNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {Array<object>} raw provider rows, untrusted
 * @param {string} timeframe one of the declared timeframes
 * @returns {{candles: Array<object>, validation: object}}
 */
export function normalizeCandles(raw, timeframe) {
  const rows = Array.isArray(raw) ? raw : [];
  const issues = [];
  const clean = [];

  for (const candle of rows) {
    if (!candle || typeof candle !== "object") continue;
    const open = toFiniteNumber(candle.open);
    const high = toFiniteNumber(candle.high);
    const low = toFiniteNumber(candle.low);
    const close = toFiniteNumber(candle.close);
    const volume = toFiniteNumber(candle.volume);
    const timestamp = toFiniteNumber(candle.timestamp);
    if (open === null || high === null || low === null || close === null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    if (volume === null || volume < 0) continue;
    if (timestamp === null || timestamp <= 0) continue;

    // Repair the envelope only where it is self-contradictory: a high below the
    // body or a low above it is a provider artefact, not a market fact.
    let repairedHigh = high;
    let repairedLow = low;
    const bodyMax = Math.max(open, close);
    const bodyMin = Math.min(open, close);
    if (repairedHigh < bodyMax) {
      repairedHigh = bodyMax;
      issues.push("high clamped below close/open body");
    }
    if (repairedLow > bodyMin) {
      repairedLow = bodyMin;
      issues.push("low clamped above close/open body");
    }

    clean.push({
      timestamp: Math.trunc(timestamp),
      open,
      high: repairedHigh,
      low: repairedLow,
      close,
      volume,
    });
  }

  clean.sort((a, b) => a.timestamp - b.timestamp);

  const deduped = [];
  for (const candle of clean) {
    const last = deduped[deduped.length - 1];
    if (last && last.timestamp === candle.timestamp) {
      issues.push("duplicate candle dropped");
      continue;
    }
    deduped.push(candle);
  }

  const interval = timeframeMs(timeframe);
  let gaps = 0;
  for (let index = 1; index < deduped.length; index += 1) {
    if (deduped[index].timestamp - deduped[index - 1].timestamp > interval * 1.5) gaps += 1;
  }

  const ok = deduped.length >= 30 && gaps <= Math.max(2, Math.floor(deduped.length * 0.1));

  return {
    candles: deduped,
    validation: {
      ok,
      droppedCount: rows.length - deduped.length,
      gapCount: gaps,
      expectedIntervalMs: interval,
      coveredIntervalMs: deduped.length > 1 ? deduped[deduped.length - 1].timestamp - deduped[0].timestamp : 0,
      minTimestamp: deduped.length ? deduped[0].timestamp : 0,
      maxTimestamp: deduped.length ? deduped[deduped.length - 1].timestamp : 0,
      issues: issues.slice(0, MAX_ISSUES),
    },
  };
}

/* ------------------------------------------------------------------ math */

/**
 * FNV-1a over the string, 32-bit, returned signed — including the legacy
 * high-bit quirk: `MathUtils::hashString` clears bit 31 after every multiply
 * step, so the same quirk is reproduced here rather than "fixed". Changing it
 * would change every synthetic series the platform has ever produced.
 */
export function hashString(value) {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 16777619) >>> 0;
    // The legacy branch `if ($h & 0x80000000)` recomputes bit 31 as
    // `(~($h ^ 0x7FFFFFFF)) & 0x80000000`, which is always 0 when bit 31 is set —
    // so the multiply result always has bit 31 cleared. Reproduced, not "fixed":
    // the seed of every synthetic series depends on it.
    if (hash & 0x80000000) hash &= 0x7fffffff;
  }
  // PHP's `$h | 0` is a no-op on a 64-bit non-negative int, so the faithful
  // return is unsigned: only the empty string keeps the FNV offset basis
  // (2166136261) instead of being truncated to a negative int32.
  return hash >>> 0;
}

/** Deterministic xorshift32 PRNG: unsigned state, output divided by 2^32. */
export function seededRandom(seed) {
  let state = (seed === 0 ? 1 : seed) >>> 0;
  return function next() {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    return state / 4294967296;
  };
}

/** Box-Muller transform over the injected PRNG. */
export function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
