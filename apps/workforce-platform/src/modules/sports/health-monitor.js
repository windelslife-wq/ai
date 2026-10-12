/**
 * Provider health monitor — the port of `Aegis\Sports\ProviderHealthMonitor`.
 *
 * Legacy's contract, which is the whole design: *"Derives the provider status from
 * OBSERVED data only — health observations, sync-run history, and recency — and
 * computes a 0..1 reliability score used by the Data Quality Engine. **Never
 * invents a status: with no observations the status is UNKNOWN.**"*
 *
 * That last sentence is why this class exists separately from a provider's own
 * `health()`. A provider's self-report says what it believes about one call; what
 * an operator needs is what the platform has actually experienced, over time, from
 * the outside. Deriving it means a provider that has never been called reports
 * `UNKNOWN` rather than `OFFLINE` (which would imply a failure nobody witnessed) or
 * `ONLINE` (which would be a fabrication).
 *
 * The precedence in `assess` is the accumulated judgement of the legacy module and
 * is preserved in order, because each rule exists to stop a specific false reading:
 *
 *  1. **Nothing observed at all** → `UNKNOWN`. Not a guess in either direction.
 *  2. **A terminal self-report within the last 30 minutes wins outright.** An
 *     authentication error or a rate limit is not fixed by falling back to another
 *     provider, so it must not be averaged away by older successful runs.
 *  3. **A failure within the last 5 minutes** → that failure's status if terminal,
 *     else `DEGRADED`. Recent evidence beats history.
 *  4. **Stale by more than 6 hours on both channels** → `OFFLINE`, but only when
 *     there is also no recent sync run: a provider nobody has asked for six hours
 *     is not the same as one that has been failing for six hours, and the sync
 *     history is what tells them apart.
 *  5. **An error rate at or above 50% across runs** → `DEGRADED`.
 *  6. **The latest observation says `ONLINE`** → `ONLINE`, and this is the only
 *     branch that earns the recency boost on reliability.
 *  7. Otherwise `DEGRADED` — *"no recent ONLINE observation"*. The fallback is
 *     pessimistic, which is the conservative direction for a data source.
 *
 * Timestamps are formatted with legacy's `gmdate('c')` shape (`+00:00`, second
 * precision) for the same reason the normalizer uses it: this function is pure, and
 * keeping it byte-identical to PHP is what makes it eligible for the differential
 * harness (divergence SP-1).
 *
 * **The row shapes are snake_case** — `observed_at`, `started_at`, `status` —
 * because they are repository rows, not normalized payloads. This module reads what
 * the database stores, and `OddsFreshnessEngine` already accepts both key shapes for
 * the same reason.
 */

import { formatGmdateC, parseStrictInstant } from "../../lib/php-date.js";
import { FAILURE_STATUSES, PROVIDER_STATUS, TERMINAL_STATUSES } from "./provider-error.js";

/** No observation older than this counts as evidence the provider is up. */
export const STALE_AFTER_SECONDS = 6 * 3600;
/** A sync-run error rate at or above this is DEGRADED. */
export const DEGRADED_ERROR_RATE = 0.5;
/** How recent a failure must be to override the run history. */
export const RECENT_FAILURE_WINDOW_SECONDS = 300;
/** How recent a terminal self-report must be to win outright. */
export const TERMINAL_REPORT_WINDOW_SECONDS = 1800;

/** Parse a stored timestamp into epoch seconds, or `null` when it is absent or unparseable. */
function toSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = parseStrictInstant(typeof value === "string" ? value.trim() : value);
  return date === null ? null : Math.floor(date.getTime() / 1000);
}

function isRecent(value, nowSeconds, windowSeconds) {
  const at = toSeconds(value);
  return at !== null && nowSeconds - at <= windowSeconds;
}

/**
 * PHP's `sprintf('%.0f', …)` — round half away from zero, then no decimals.
 *
 * @param {number} value
 * @returns {string}
 */
function percent(value) {
  if (!Number.isFinite(value)) return "0";
  return String(Math.sign(value) * Math.floor(Math.abs(value) + 0.5));
}

/**
 * Reliability in `[0, 1]` derived from sync-run history.
 *
 * With no runs at all the answer depends on `boost`: `0.5` when the latest
 * observation said `ONLINE` (a provider that just answered is probably fine even
 * with no run history) and `0.0` otherwise (no evidence, no credit). The `0.95`
 * factor on the unboosted path means a perfect run history still cannot claim a
 * reliability of exactly `1.0` — matching legacy, and appropriate for a score that
 * gates whether a fixture is eligible to be staked on.
 *
 * @param {Array<Record<string, unknown>>} jobRuns
 * @param {boolean} [boost]
 * @returns {number}
 */
function reliabilityFromRuns(jobRuns, boost = false) {
  let success = 0;
  let total = 0;
  for (const run of jobRuns) {
    const status = run?.status ?? "";
    if (status === "COMPLETED") {
      success += 1;
      total += 1;
    } else if (status === "FAILED") {
      total += 1;
    }
  }
  if (total === 0) return boost ? 0.5 : 0.0;
  const value = (success / total) * (boost ? 1.0 : 0.95);
  const clamped = Math.min(1.0, value);
  return (Math.sign(clamped) * Math.floor(Math.abs(clamped) * 10_000 + 0.5)) / 10_000;
}

/**
 * Derive a provider's status from observations.
 *
 * @param {Record<string, unknown>} provider the `sports_data_sources` row; unused by
 *   the derivation itself and kept in the signature for parity, because a future
 *   rule may need to know whether the provider is `enabled`
 * @param {Array<Record<string, unknown>>} health **newest-first** `sports_provider_health` rows
 * @param {Array<Record<string, unknown>>} jobRuns **newest-first** `sports_sync_runs` rows for this provider
 * @param {number|null} [nowSeconds] epoch seconds, injectable for tests
 * @returns {{status: string, reliability: number, detail: string, checkedAt: string}}
 */
export function assessProviderHealth(provider, health, jobRuns, nowSeconds = null) {
  const now = nowSeconds === null || nowSeconds === undefined ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  const checkedAt = formatGmdateC(new Date(now * 1000));
  const healthRows = Array.isArray(health) ? health : [];
  const runs = Array.isArray(jobRuns) ? jobRuns : [];

  const report = (status, reliability, detail) => ({ status, reliability, detail, checkedAt });

  // 1. Nothing observed at all.
  if (healthRows.length === 0 && runs.length === 0) {
    return report(PROVIDER_STATUS.UNKNOWN, 0.0, "no observations yet");
  }

  const latest = healthRows[0] ?? null;

  // The most recent failure the history actually contains. Scanning for it rather
  // than reading `latest` is what lets an older failure still explain a current
  // degradation when the newest row is something else.
  let lastFailure = null;
  for (const row of healthRows) {
    const at = toSeconds(row?.observed_at ?? null);
    if (at !== null && at <= now && FAILURE_STATUSES.includes(row?.status)) {
      lastFailure = { at, status: row.status };
      break;
    }
  }

  // 2. A terminal self-report wins outright — fallback cannot fix a credential or a
  //    rate limit, so neither may be averaged away by older successes.
  if (latest !== null && TERMINAL_STATUSES.includes(latest.status) && isRecent(latest.observed_at, now, TERMINAL_REPORT_WINDOW_SECONDS)) {
    return report(latest.status, reliabilityFromRuns(runs), `last provider report: ${latest.status}`);
  }

  let successRuns = 0;
  let failRuns = 0;
  let lastSync = null;
  for (const run of runs) {
    const at = toSeconds(run?.started_at ?? null);
    if (at !== null && at <= now && lastSync === null) lastSync = at;
    const status = run?.status ?? "";
    if (status === "COMPLETED") successRuns += 1;
    else if (status === "FAILED") failRuns += 1;
  }
  const total = successRuns + failRuns;
  const errorRate = total > 0 ? failRuns / total : null;

  // 3. A very recent failure overrides the run history.
  if (lastFailure !== null && now - lastFailure.at <= RECENT_FAILURE_WINDOW_SECONDS) {
    const status = TERMINAL_STATUSES.includes(lastFailure.status) ? lastFailure.status : PROVIDER_STATUS.DEGRADED;
    const since = formatGmdateC(new Date(lastFailure.at * 1000));
    return report(status, reliabilityFromRuns(runs), `failing since ${since} (${lastFailure.status})`);
  }

  // 4. Stale on BOTH channels. Requiring the sync history to be stale too is what
  //    distinguishes "nobody has asked this provider for six hours" from "this
  //    provider has been failing for six hours".
  const latestAt = latest === null ? null : toSeconds(latest.observed_at);
  const latestStale = latest !== null && (latestAt === null || now - latestAt > STALE_AFTER_SECONDS);
  const syncStale = lastSync === null || now - lastSync > STALE_AFTER_SECONDS;
  if (latestStale && syncStale) {
    return report(
      PROVIDER_STATUS.OFFLINE,
      reliabilityFromRuns(runs),
      `no successful observation within ${STALE_AFTER_SECONDS}s`,
    );
  }

  // 5. A high error rate across runs.
  if (errorRate !== null && errorRate >= DEGRADED_ERROR_RATE) {
    return report(
      PROVIDER_STATUS.DEGRADED,
      reliabilityFromRuns(runs),
      `error rate ${percent(errorRate * 100)}% over ${total} runs`,
    );
  }

  // 6. The latest observation says ONLINE — the only branch that earns the boost.
  if (latest !== null && latest.status === PROVIDER_STATUS.ONLINE) {
    return report(PROVIDER_STATUS.ONLINE, reliabilityFromRuns(runs, true), "last observation ONLINE");
  }

  // 7. Pessimistic by default.
  return report(PROVIDER_STATUS.DEGRADED, reliabilityFromRuns(runs), "no recent ONLINE observation");
}

/**
 * The provider health monitor, as an object — the shape legacy's `SportsIntelligence`
 * holds. Stateless: every call takes its observations as arguments, so two callers
 * with different histories get different answers from the same instance and nothing
 * is cached that could go stale.
 *
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createProviderHealthMonitor() {
  return Object.freeze({
    assess: assessProviderHealth,
    STALE_AFTER_SECONDS,
    DEGRADED_ERROR_RATE,
  });
}
