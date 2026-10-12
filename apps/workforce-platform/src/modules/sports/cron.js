/**
 * The sports cron — the port of legacy `Aegis\Sports\SportsCronService` (row 19 of
 * `docs/migration/UNFINISHED_MODULES.md`).
 *
 * Nine idempotent jobs over the sports module's own services: fixtures, odds and
 * results syncs; the quality recalculation; the daily ticket; the settlement sweep;
 * the performance snapshotter; the provider-health and model-drift monitoring; and
 * the retention cleanup. Legacy ran them from `php index.php tools sports-cron [job]`;
 * this port runs them from `tools/sports-jobs.mjs` (`npm run sports:jobs`) — CLI only,
 * like every scheduled job on this platform. There is no HTTP route, and adding one
 * would contradict the `scheduledJobs` ledger label, which says why.
 *
 * Idempotency, adapted to this platform's schema (one divergence, recorded in the
 * phase record): legacy marked "already ran" with a unique `wf_job_runs.execution_key`
 * row per window. This schema has no job-run table — the arbiter the platform already
 * trusts is a `wf_job_locks` row (migration 010), so each window-locked job takes a
 * lock named `sports.<job>.<date>[.<hour>]` — dots, because `assertJobName` refuses
 * colons — whose EXPIRY IS THE WINDOW: a re-run in the same window finds the lock
 * unexpired and reports `DUPLICATE_SKIPPED`, exactly legacy's answer; the next
 * window's run finds it expired, takes it over, and runs.
 * The lock is deliberately not released at the end of the run — it is the marker, not
 * a mutex. The three sync jobs need none of this: their per-provider execution keys
 * already arbitrate inside the sync service, as they do in legacy.
 *
 * One legacy bug is NOT carried, and it is a pending user decision (DV-24, recorded in
 * the phase record): legacy's `JOBS` list names `cleanup` and `jobCleanup()` exists,
 * but `run()`'s match has no `'cleanup'` arm — so every legacy `runAll` ends with
 * `cleanup: FAILED` and a spurious `SPORTS_JOB_FAILED` audit event. The port routes
 * the job its own class defines, because the documented intent (the method, its
 * retention comment, and its place in `JOBS`) is that cleanup runs.
 *
 * Honesty boundaries, unchanged from the slices the jobs are made of: the sync jobs
 * call configured providers only (a default host registers none and the job reports
 * `SKIPPED` — "no providers configured; nothing synchronized (nothing fabricated)");
 * the quality job's reliability comes from STORED observations, not a live probe (the
 * cron-side extension of SP-10); the ticket job inherits DV-20/21/23; the settlement
 * sweep settles records only; and a snapshot is a measured report over attested
 * records, labelled DEMO/SANDBOX by the report itself.
 */

import { assessProviderHealth } from "./health-monitor.js";
import { assessQuality } from "./quality.js";

export const SPORTS_JOBS = Object.freeze([
  "fixtures",
  "odds",
  "results",
  "quality",
  "ticket",
  "settlement",
  "performance",
  "monitoring",
  "cleanup",
]);

/** How long a window's marker lock outlives its run, per cadence. */
const HOURLY_LOCK_TTL_MS = 3_600_000;
const DAILY_LOCK_TTL_MS = 24 * HOURLY_LOCK_TTL_MS;

export function createSportsCronService({ sports, store = null, now = () => Date.now(), actorId = "system" } = {}) {
  if (!sports) throw new TypeError("createSportsCronService requires the sports service");
  if (!store) {
    // Every window-locked job and the audit trail need a repository. A host without
    // one has nothing to sweep, snapshot or prune — and pretending otherwise would
    // fabricate results.
    throw new TypeError("createSportsCronService requires a store");
  }

  const nowMs = () => Number(now());

  /** `YYYY-MM-DD` for an epoch-ms instant, UTC. */
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (date, days) => ymd(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);

  /**
   * Run one window-locked job body. `DUPLICATE_SKIPPED` when this window's marker is
   * still held — legacy's answer when the execution key already exists — with the
   * holder named, so the cron log says who owns the window rather than looking idle.
   *
   * @returns {Promise<{skipped: boolean, result: object}>}
   */
  async function withWindowLock(jobName, key, ttlMs, body) {
    const acquired = await store.acquireJobLock(key, {
      holder: `sports-cron#${process.pid}`,
      nowIso: new Date(nowMs()).toISOString(),
      expiresAt: new Date(nowMs() + ttlMs).toISOString(),
    });
    if (!acquired.acquired) {
      return {
        skipped: true,
        result: { status: "DUPLICATE_SKIPPED", executionKey: key, reason: acquired.reason },
      };
    }
    // Deliberately no release — not even on failure. The lock IS the window's
    // "already ran" marker: legacy's execution-key row also persisted when a job
    // threw, so a re-run in the same window found the key and skipped. Releasing
    // would turn the marker into a mutex and let one window run twice.
    return { skipped: false, result: await body() };
  }

  /** Legacy's `combine()`: a job's status is COMPLETED, PARTIAL (any FAILED) or SKIPPED (nothing to do). */
  function combine(label, results, summary, { processed = 0, created = 0, errors = [] } = {}) {
    const values = Object.values(results);
    const status = values.length === 0 ? "SKIPPED" : values.some((r) => r === "FAILED") ? "PARTIAL" : "COMPLETED";
    return { status, label, results, summary, processed, created, errors };
  }

  // ── the sync jobs ─────────────────────────────────────────────────────────────

  /** Every registered provider, fixtures for the day plus thirteen more. */
  async function jobFixtures(date) {
    const from = date;
    const to = addDays(date, 13);
    const providers = sports.providers.all();
    const results = {};
    for (const provider of providers) {
      const outcome = await sports.sync({
        jobType: "FIXTURES",
        providerId: provider.id(),
        executionKey: `fixtures:${from}:${to}:${provider.id()}`,
        query: { from, to },
      });
      results[provider.id()] = outcome.status;
    }
    // Legacy passes the "no providers" sentence as this job's summary UNCONDITIONALLY,
    // so its audit reads "no providers configured" even on a day three providers
    // synced — the same bug class as the missing cleanup arm. The port says it only
    // when it is true (DV-25, pending user confirmation).
    return combine(
      "FIXTURES_SYNC",
      results,
      providers.length === 0
        ? "no providers configured; nothing synchronized (nothing fabricated)"
        : `${providers.length} provider(s) synced`,
    );
  }

  /** Odds for today's and tomorrow's scheduled matches, plus everything live. */
  async function jobOdds(date) {
    const scheduled = await store.listSportsMatches(
      { from: `${date}T00:00:00.000Z`, to: `${addDays(date, 1)}T00:00:00.000Z`, status: "SCHEDULED" },
      500,
    );
    const live = await store.listSportsMatches({ status: "LIVE" }, 200);
    const providers = await store.listSportsProviders();
    const results = {};
    let processed = 0;
    let created = 0;
    const errors = [];
    for (const match of [...scheduled, ...live]) {
      const provider = await providerFor(providers, match.provider_id);
      if (!provider) continue;
      const outcome = await sports.sync({
        jobType: "ODDS",
        providerId: provider.id(),
        executionKey: `odds:${match.id}:${date}:${provider.id()}`,
        fixtureExternalId: String(match.external_id),
      });
      results[String(match.id)] = outcome.status;
      processed += 1;
      if (outcome.status === "COMPLETED") created += Number(outcome.created ?? 0);
      if (outcome.status === "FAILED") errors.push((outcome.errors ?? []).join("; "));
    }
    return combine("ODDS_SYNC", results, `${Object.keys(results).length} match(es) synced`, { processed, created, errors });
  }

  /** Results for the last two days' matches that have no stored result yet. */
  async function jobResults(date) {
    const since = `${addDays(date, -2)}T00:00:00.000Z`;
    const matches = await store.listSportsMatches({ from: since, to: `${date}T23:59:59.000Z` }, 500);
    const providers = await store.listSportsProviders();
    const results = {};
    let processed = 0;
    const errors = [];
    for (const match of matches) {
      const stored = await store.findSportsResultByMatch(match.id).catch(() => null);
      if (stored !== null) continue;
      const provider = await providerFor(providers, match.provider_id);
      if (!provider) continue;
      const outcome = await sports.sync({
        jobType: "RESULTS",
        providerId: provider.id(),
        executionKey: `results:${match.id}:${date}:${provider.id()}`,
        fixtureExternalId: String(match.external_id),
      });
      results[String(match.id)] = outcome.status;
      processed += 1;
      if (outcome.status === "FAILED") errors.push((outcome.errors ?? []).join("; "));
    }
    return combine("RESULTS_SYNC", results, `${Object.keys(results).length} match(es) checked`, { processed, created: processed, errors });
  }

  /** The stored provider row for a match's provider id, as a registered provider object. */
  async function providerFor(storedProviders, providerId) {
    const row = storedProviders.find((candidate) => Number(candidate.id) === Number(providerId));
    if (!row) return null;
    return sports.providers.provider(row.provider_code) ?? null;
  }

  // ── the window-locked jobs ────────────────────────────────────────────────────

  /**
   * Re-assess data quality for every scheduled and live match. Reliability comes from
   * the provider's STORED observations (the newest assessment), never a live probe —
   * the cron-side extension of SP-10: a scheduled job must not turn into an outbound
   * vendor call just because the clock fired.
   */
  async function jobQuality(date) {
    const hour = new Date(nowMs()).toISOString().slice(11, 13);
    const key = `sports.quality.${date}.${hour}`;
    const { skipped, result } = await withWindowLock("sports.quality", key, HOURLY_LOCK_TTL_MS, async () => {
      const scheduled = await store.listSportsMatches(
        { from: `${date}T00:00:00.000Z`, to: `${addDays(date, 1)}T00:00:00.000Z`, status: "SCHEDULED" },
        500,
      );
      const live = await store.listSportsMatches({ status: "LIVE" }, 200);
      const matches = [...scheduled, ...live];
      const providers = await store.listSportsProviders();
      let updated = 0;
      const errors = [];
      for (const match of matches) {
        try {
          const payload = match.payload && typeof match.payload === "object" ? match.payload : {};
          const matchArr = {
            ...match,
            externalId: match.external_id,
            homeTeam: match.home_team,
            awayTeam: match.away_team,
            kickoff: match.kickoff_at,
            context: payload.context ?? null,
            sourceTimestamp: match.source_timestamp,
          };
          const odds = await store.latestSportsOdds(match.id, "TOTAL_GOALS", "OVER_1_5");
          const providerRow = providers.find((candidate) => Number(candidate.id) === Number(match.provider_id)) ?? null;
          // STORED reliability: the newest health assessment on record. A provider
          // with no observations derives to 0, which is what "nothing witnessed"
          // scores — never a fabricated 0.9.
          let reliability = 0.0;
          if (providerRow) {
            const health = await store.latestSportsHealth(Number(providerRow.id));
            if (health && health.provider_reliability_score !== null && health.provider_reliability_score !== undefined) {
              reliability = Number(health.provider_reliability_score) / 100;
            }
          }
          const quality = assessQuality(matchArr, {
            oddsAvailable: odds !== null,
            recentFormAvailable: !empty(matchArr?.context?.recentForm),
            providerReliability: reliability,
            dataAgeSeconds: odds ? ageOf(odds.observed_at) : ageOf(match.source_timestamp),
            maxAgeSeconds: 3600,
          });
          await store.saveSportsQuality(match.id, quality);
          updated += 1;
        } catch (error) {
          errors.push(String(error?.message ?? error).slice(0, 200));
        }
      }
      await store.recordAudit({
        actorId: null,
        action: "sports.quality.recalc",
        entityType: "sports_match",
        entityId: null,
        details: {
          message: `Data quality recalculated for ${updated} active match(es)`,
          matches: matches.length,
          errors,
        },
      });
      return { status: "COMPLETED", matches: matches.length, updated, errors };
    });
    return result;
  }

  /** The daily ticket, through the same service the HTTP route uses (DV-20/21/23 inherit). */
  async function jobTicket(date) {
    const result = await sports.tickets.runDaily({ date, actorId });
    return {
      status: result.status,
      ticketId: result.ticketId ?? null,
      message: result.message ?? null,
      errors: result.errors ?? [],
    };
  }

  /** Settle every PENDING ticket once per hour; idempotent underneath besides. */
  async function jobSettlement(date) {
    const hour = new Date(nowMs()).toISOString().slice(11, 13);
    const key = `sports.settlement.${date}.${hour}`;
    const { skipped, result } = await withWindowLock("sports.settlement", key, HOURLY_LOCK_TTL_MS, async () => {
      const tickets = await store.listSportsTickets({ status: "PENDING" }, 200);
      let settled = 0;
      let stillPending = 0;
      const errors = [];
      for (const ticket of tickets) {
        try {
          const outcome = await sports.settlement.settlePending(ticket.id);
          if ((outcome?.status ?? "PENDING") !== "PENDING") settled += 1;
          else stillPending += 1;
        } catch (error) {
          errors.push(String(error?.message ?? error).slice(0, 200));
        }
      }
      await store.recordAudit({
        actorId: null,
        action: "sports.settlement.sweep",
        entityType: "sports_ticket",
        entityId: null,
        details: {
          message: `Settlement sweep: ${settled} ticket(s) finalized, ${stillPending} still pending verified results`,
          settled,
          pending: stillPending,
          errors,
        },
      });
      return { status: "COMPLETED", settled, pending: stillPending, errors };
    });
    return result;
  }

  /**
   * Snapshot the measured performance report for the four legacy windows, one row per
   * (hour, window), replacing on a re-run. This is the writer migration 015's table
   * was waiting for — and the reason 014 refused to create the table early.
   */
  async function jobPerformance(date) {
    const hour = new Date(nowMs()).toISOString().slice(11, 13);
    const key = `sports.performance.${date}.${hour}`;
    const { skipped, result } = await withWindowLock("sports.performance", key, HOURLY_LOCK_TTL_MS, async () => {
      const asOf = `${date}T${hour}:00:00.000Z`;
      let snapshots = 0;
      const errors = [];
      for (const window of ["7", "30", "90", "ALL"]) {
        try {
          const filter = window === "ALL"
            ? {}
            : { from: `${addDays(date, window === "7" ? -6 : -Number(window))}T00:00:00.000Z`, to: `${date}T23:59:59.000Z` };
          const report = await sports.performanceReport(filter);
          await store.saveSportsPerformanceSnapshot({ asOf, window, payload: report });
          snapshots += 1;
        } catch (error) {
          errors.push(String(error?.message ?? error).slice(0, 200));
        }
      }
      return { status: "COMPLETED", snapshots, errors };
    });
    return result;
  }

  /** Provider health from stored observations, plus the model drift monitor. */
  async function jobMonitoring(date) {
    const hour = new Date(nowMs()).toISOString().slice(11, 13);
    const key = `sports.monitoring.${date}.${hour}`;
    const { skipped, result } = await withWindowLock("sports.monitoring", key, HOURLY_LOCK_TTL_MS, async () => {
      const stored = await store.listSportsProviders();
      const healthReports = {};
      for (const providerRow of stored) {
        const healthRows = await store.listSportsHealth(Number(providerRow.id), 20);
        const runRows = await store.listSportsSyncRuns({ providerId: Number(providerRow.id) }, 100);
        const report = assessProviderHealth(providerRow, healthRows, runRows, Math.floor(nowMs() / 1000));
        healthReports[String(providerRow.provider_code ?? providerRow.id)] = report;
      }
      const drift = await sports.drift.monitor();
      await store.recordAudit({
        actorId: null,
        action: "sports.monitoring",
        entityType: "sports_provider",
        entityId: null,
        details: {
          message: `Provider health + model drift monitoring: ${drift.warnings} drift warning(s)`,
          providers: healthReports,
          driftWarnings: drift.warnings,
        },
      });
      return { status: "COMPLETED", providers: healthReports, driftWarnings: drift.warnings };
    });
    return result;
  }

  /**
   * Retention: the operational history a cron accumulates is pruned at 90 days —
   * health observations only, because predictions, tickets and results are decision
   * history and are kept forever (legacy's own comment). The `wf_job_runs` half of
   * legacy's cleanup has no counterpart here: this schema has no job-run table, the
   * window markers are `wf_job_locks` rows that expire by construction, and audit
   * retention is a platform-wide decision (R-27's open half), not this job's to make.
   */
  async function jobCleanup(date) {
    const key = `sports.cleanup.${date}`;
    const { skipped, result } = await withWindowLock("sports.cleanup", key, DAILY_LOCK_TTL_MS, async () => {
      const cutoff = new Date(nowMs() - 90 * 86_400_000).toISOString();
      await store.pruneSportsHealth(cutoff);
      await store.recordAudit({
        actorId: null,
        action: "sports.data.cleanup",
        entityType: "sports_provider_health",
        entityId: null,
        details: { message: "Retention cleanup applied (90-day operational history)", cutoff },
      });
      return { status: "COMPLETED", cutoff };
    });
    return result;
  }

  /** Legacy's `ageOf`: seconds since a stored instant; an unparseable one is infinitely old. */
  function ageOf(value) {
    if (!value) return Number.MAX_SAFE_INTEGER;
    const at = Date.parse(String(value));
    return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor((nowMs() - at) / 1000));
  }

  /**
   * Run every job in legacy's order. One job failing never aborts the sweep: its
   * summary entry says FAILED with the error, and the failure is audited — the exact
   * shape legacy's `runAll` catches into.
   */
  async function runAll(options = {}) {
    const date = assertDate(options.date ?? ymd(nowMs()));
    const summary = {};
    for (const job of SPORTS_JOBS) {
      try {
        summary[job] = await run(job, { date, actorId: options.actorId ?? actorId });
      } catch (error) {
        summary[job] = { status: "FAILED", error: String(error?.message ?? error).slice(0, 300) };
        await store.recordAudit({
          actorId: null,
          action: "sports.job.failed",
          entityType: "sports_cron",
          entityId: job,
          details: { job, message: `Sports job ${job} failed: ${String(error?.message ?? error)}` },
        });
      }
    }
    await store.recordAudit({
      actorId: null,
      action: "sports.cron.run",
      entityType: "sports_cron",
      entityId: null,
      details: {
        message: `Sports scheduled jobs: ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([job, entry]) => [job, entry.status ?? "FAILED"])))}`,
        jobs: summary,
      },
    });
    return summary;
  }

  /** Run one job by name. An unknown name is refused with legacy's message. */
  async function run(job, options = {}) {
    const date = assertDate(options.date ?? ymd(nowMs()));
    const actor = options.actorId ?? actorId;
    switch (job) {
      case "fixtures": return jobFixtures(date);
      case "odds": return jobOdds(date);
      case "results": return jobResults(date);
      case "quality": return jobQuality(date);
      case "ticket": return jobTicket(date);
      case "settlement": return jobSettlement(date);
      case "performance": return jobPerformance(date);
      case "monitoring": return jobMonitoring(date);
      case "cleanup": return jobCleanup(date); // DV-24: legacy's match arm is missing; the port routes the job its own class defines.
      default: throw new TypeError(`unknown sports job: ${String(job).slice(0, 40)}`);
    }
  }

  return Object.freeze({ runAll, run, jobs: SPORTS_JOBS });
}

/** `YYYY-MM-DD`, refused rather than normalized — the daily-run date rule. */
function assertDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`date must be YYYY-MM-DD, received ${JSON.stringify(text.slice(0, 40))}`);
  }
  const at = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text) {
    throw new TypeError(`date must be a real calendar day, received ${JSON.stringify(text)}`);
  }
  return text;
}

/** Legacy's `empty()` for the one field the quality gate reads. */
function empty(value) {
  return value === undefined || value === null || value === "" || value === 0
    || (Array.isArray(value) && value.length === 0);
}
