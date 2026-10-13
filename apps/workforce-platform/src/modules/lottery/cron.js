/**
 * The lottery cron — the port of legacy `Aegis\Lottery\LotteryCronService`
 * (248 lines, row 15 slice 5 of `docs/migration/UNFINISHED_MODULES.md`).
 *
 * Seven idempotent jobs over the lottery module's own service: `sync` (once per
 * day per lottery), `health` (the stale-read-only check), `statistics` (the
 * data-integrity sweep — every stored draw must still satisfy the rules),
 * `systems` (THE consumer for the slice-2 queued background builds), `tickets`
 * (auto post-draw checking of OPEN tickets), `backtests` (one HISTORICAL
 * SIMULATION per strategy per day, baseline included) and `cleanup` (the
 * 90/30-day retention sweep). Legacy ran them from
 * `php index.php tools lottery-cron [job]`; this port runs them from
 * `tools/lottery-jobs.mjs` (`npm run lottery:jobs`) — CLI only, like every
 * scheduled job on this platform. There is no HTTP route, and adding one would
 * contradict the `scheduledJobs` ledger label, which says why.
 *
 * Idempotency is LEGACY'S OWN MECHANISM, not the sports cron's window locks:
 * the lottery repository has a job-run table (`wf_lottery_sync_runs`, migration
 * 016) whose `startJobRun` returns NULL when the execution key already exists,
 * so `sync:EUROMILLIONS:<date>` and `backtest:EUROMILLIONS:<strategy>:<date>`
 * arbitrate themselves — a re-run reports ALREADY_RUN / skips, and a failed
 * run's key still blocks the window exactly as legacy's does. The `systems`
 * queue needs no marker at all: its job runs ARE the queue, flipped RUNNING →
 * OK/FAILED by this consumer (before this slice they sat queued forever —
 * the API note used to say so and no longer does).
 *
 * Honesty boundaries, unchanged from the slices the jobs are made of: the sync
 * job calls the configured provider only (a default host has none and reports
 * SKIPPED_NO_PROVIDER — nothing fabricated); the health job reads stored
 * observations, never a live probe (the cron-side extension of SP-10); the
 * tickets job checks records against stored VERIFIED draws (labels only,
 * never an amount — spec §29); and every backtest report labels itself
 * HISTORICAL SIMULATION with cost/winnings honestly NULL (spec §23–§25).
 */

import { randomUUID } from "node:crypto";
import { BACKTESTER_STRATEGIES } from "./backtester.js";
import { MAX_BACKGROUND_LINES } from "./system.js";
import { createLotteryResultValidator } from "./validator.js";
import { LOTTERY } from "./service.js";

export const LOTTERY_JOBS = Object.freeze([
  "sync",
  "health",
  "statistics",
  "systems",
  "tickets",
  "backtests",
  "cleanup",
]);

/** EuroMillions draws twice a week: 8 days without a successful sync is stale. */
const STALE_AFTER_MS = 8 * 86_400_000;
const JOB_RUN_RETENTION_DAYS = 90;
const HEALTH_RETENTION_DAYS = 30;

/**
 * @param {object} options
 * @param {object} options.lottery the composed lottery service (the same object
 *   the HTTP surface wires — the jobs drive the same sync, check, backtest and
 *   system paths, never a private copy)
 * @param {object} options.store the repository (the job-run table is the arbiter)
 * @param {() => number} [options.now] the clock, injectable for tests
 */
export function createLotteryCronService({ lottery, store, now = () => Date.now() } = {}) {
  if (!lottery) throw new TypeError("createLotteryCronService requires the lottery service");
  if (!store) {
    // Every job and the audit trail need a repository. A host without one has
    // nothing to sweep, build or prune — and pretending otherwise would
    // fabricate results.
    throw new TypeError("createLotteryCronService requires a store");
  }

  const nowMs = () => Number(now());
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Every cron audit is the SYSTEM actor (actorId null, the slice-1 lowercase
  // divergence kept) — legacy passes the actor NAME 'system' where this store
  // wants an id.
  const emit = (action, message, details = {}) => lottery.recordAudit(null, action, message, details);

  /**
   * Run every job in legacy's order. One failing job never aborts the sweep:
   * its summary entry becomes `{status: "FAILED", error}` (message truncated
   * to legacy's 300 chars) and the failure is audited. The whole run is
   * audited once at the end with the status map, as legacy's is.
   */
  async function runAll(date = null) {
    const day = date ?? ymd(nowMs());
    const summary = {};
    for (const job of LOTTERY_JOBS) {
      try {
        summary[job] = await run(job, day);
      } catch (error) {
        summary[job] = { status: "FAILED", error: String(error?.message ?? error).slice(0, 300) };
        await emit("lottery.job.failed", `Lottery job ${job} failed: ${String(error?.message ?? error)}`, { job });
      }
    }
    const statuses = Object.fromEntries(Object.entries(summary).map(([job, entry]) => [job, entry?.status ?? "FAILED"]));
    await emit("lottery.cron.run", `Lottery scheduled jobs: ${JSON.stringify(statuses)}`, summary);
    return summary;
  }

  /** Run one named job. An unknown name is legacy's own refusal. */
  async function run(job, date = null) {
    const day = date ?? ymd(nowMs());
    switch (job) {
      case "sync":
        return jobSync(day);
      case "health":
        return jobHealth();
      case "statistics":
        return jobStatistics();
      case "systems":
        return jobSystems();
      case "tickets":
        return jobTickets();
      case "backtests":
        return jobBacktests(day);
      case "cleanup":
        return jobCleanup();
      default:
        throw new TypeError(`unknown lottery job: ${job}`);
    }
  }

  async function jobSync(date) {
    // Once per day per lottery: the same execution key on a second run is a no-op.
    const run = await store.startLotteryJobRun({
      id: randomUUID(),
      jobType: "sync",
      executionKey: `sync:${LOTTERY}:${date}`,
    });
    if (run === null) {
      return { status: "ALREADY_RUN", note: `sync already completed for ${date} (idempotent)` };
    }
    const result = await lottery.sync(100);
    const status = result?.status === "NO_PROVIDER" ? "SKIPPED_NO_PROVIDER" : "OK";
    await store.finishLotteryJobRun(String(run.id), {
      status,
      processed: (result?.imported ?? 0) + (result?.unchanged ?? 0) + (result?.failed ?? 0),
      created: result?.imported ?? 0,
      updated: result?.corrected ?? 0,
      errors: result?.errors ?? [],
    });
    return { ...result, status };
  }

  /** Read-only: live provider state vs the stored observation's freshness. No writes. */
  async function jobHealth() {
    const health = await lottery.providerHealth();
    const live = health?.live ?? {};
    let stale = false;
    if (health?.latest?.last_success_at) {
      const age = Math.trunc((nowMs() - Date.parse(String(health.latest.last_success_at))) / 1000);
      stale = age > STALE_AFTER_MS / 1000;
    }
    const liveState = live.state ?? "OFFLINE";
    const status = liveState === "ONLINE" ? (stale ? "DEGRADED" : "ONLINE") : liveState === "UNCONFIGURED" ? "OFFLINE" : "DEGRADED";
    return {
      status,
      provider: health?.provider ?? "unconfigured",
      stale,
      liveState: live.state ?? null,
    };
  }

  /**
   * Data-integrity sweep (named `statistics` in legacy's JOBS list, kept):
   * every stored draw must carry the full rule shape (5 mains in range, 2
   * stars in range, no duplicates) and a source. Violations are audited — the
   * fix path is manual correction, never silent rewriting of verified data.
   */
  async function jobStatistics() {
    const rules = await lottery.resolvedRules();
    const validator = createLotteryResultValidator(rules);
    const draws = await store.listLotteryDraws({ lotteryCode: LOTTERY }, 100_000, "ASC");
    const violations = [];
    for (const d of draws) {
      const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
      const check = validator.validate({
        externalId: d.external_id,
        drawDate: d.draw_date,
        main: payload.main ?? null,
        stars: payload.stars ?? null,
        source: d.source,
        sourceTimestamp: d.source_timestamp,
      });
      if (!check.valid) {
        violations.push({ drawId: Number(d.id), externalId: String(d.external_id), errors: check.errors });
      }
    }
    if (violations.length > 0) {
      await emit(
        "lottery.integrity.violations",
        `${violations.length} stored draw(s) violate the rules — manual correction required`,
        { violations: violations.slice(0, 20) },
      );
    }
    return { status: "OK", drawsChecked: draws.length, violations: violations.length, detail: violations.slice(0, 10) };
  }

  /**
   * Background system builds (spec §18): process queued `system` job runs —
   * execution-key idempotent, a pool is built at most once. Each build saves
   * one SYSTEM combination row with the full line set.
   */
  async function jobSystems() {
    const pending = (await store.listLotteryJobRuns("system", 50)).filter((r) => (r?.status ?? "") === "RUNNING");
    let built = 0;
    let failed = 0;
    for (const run of pending) {
      const payload = run.payload && typeof run.payload === "object" ? run.payload : null;
      if (!payload || !Array.isArray(payload.mains) || !Array.isArray(payload.stars)) {
        await store.finishLotteryJobRun(String(run.id), { status: "FAILED", processed: 0, created: 0, updated: 0, errors: ["invalid system payload"] });
        failed += 1;
        continue;
      }
      try {
        const active = await lottery.engines();
        const mains = payload.mains.map((value) => Math.trunc(Number(value)));
        const stars = payload.stars.map((value) => Math.trunc(Number(value)));
        const lines = active.systemBuilder.allLines(mains, stars);
        if (lines.length > MAX_BACKGROUND_LINES) {
          await store.finishLotteryJobRun(String(run.id), {
            status: "FAILED",
            processed: lines.length,
            created: 0,
            updated: 0,
            errors: [`system exceeds ${MAX_BACKGROUND_LINES} lines — reduce the pool`],
          });
          failed += 1;
          continue;
        }
        const plan = active.systemBuilder.plan(mains, stars);
        await lottery.saveSystem(plan, lines, "system");
        await store.finishLotteryJobRun(String(run.id), { status: "OK", processed: lines.length, created: 1, updated: 0, errors: [] });
        built += 1;
      } catch (error) {
        await store.finishLotteryJobRun(String(run.id), {
          status: "FAILED",
          processed: 0,
          created: 0,
          updated: 0,
          errors: [String(error?.message ?? error).slice(0, 300)],
        });
        failed += 1;
      }
    }
    return { status: "OK", built, failed, pending: pending.length };
  }

  /**
   * Auto post-draw ticket checking (spec §29/§40): every OPEN ticket whose
   * draw date is on or before the latest stored VERIFIED draw gets compared
   * (idempotent — CHECKED tickets are never re-checked; ARCHIVED tickets are
   * never touched). System-scoped: the cron may read every user's tickets.
   */
  async function jobTickets() {
    const draws = await store.listLotteryDraws({ lotteryCode: LOTTERY, verificationStatus: "VERIFIED" }, 1);
    if (draws.length === 0) {
      return { status: "OK", attempted: 0, checked: 0, note: "no stored VERIFIED draw" };
    }
    let attempted = 0;
    let checked = 0;
    for (const t of await store.listAllLotteryTickets(500)) {
      if ((t?.status ?? "") !== "OPEN") continue;
      if (t.draw_date && String(t.draw_date) > String(draws[0].draw_date)) continue; // future-dated: wait for its draw
      attempted += 1;
      const result = await lottery.checkTicket(Number(t.id), null, "system");
      if (result && typeof result === "object" && result.status === "CHECKED") checked += 1;
    }
    return { status: "OK", attempted, checked };
  }

  /**
   * Strategy performance (spec §40): one backtest per strategy per day,
   * execution-key idempotent — re-running the same day never creates duplicate
   * backtest rows or job runs. The random baseline runs every day.
   */
  async function jobBacktests(date) {
    let ran = 0;
    let skipped = 0;
    for (const strategy of BACKTESTER_STRATEGIES) {
      const key = `backtest:${LOTTERY}:${strategy}:${date}`;
      if ((await store.findLotteryJobRunByKey(key)) !== null) {
        skipped += 1;
        continue;
      }
      const run = await store.startLotteryJobRun({
        id: randomUUID(),
        jobType: "backtest",
        payload: { strategy },
        executionKey: key,
      });
      if (run === null) {
        skipped += 1;
        continue;
      }
      try {
        const report = await lottery.backtest(strategy, 1, 0);
        await store.finishLotteryJobRun(String(run.id), {
          status: "OK",
          processed: Number(report.period.drawsTested),
          created: 1,
          updated: 0,
          errors: [],
        });
        ran += 1;
      } catch (error) {
        await store.finishLotteryJobRun(String(run.id), {
          status: "FAILED",
          processed: 0,
          created: 0,
          updated: 0,
          errors: [String(error?.message ?? error).slice(0, 300)],
        });
        await emit("lottery.backtest.failed", `Scheduled backtest ${strategy} failed: ${String(error?.message ?? error)}`, { strategy });
      }
    }
    return { status: "OK", ran, skipped };
  }

  async function jobCleanup() {
    const runCutoff = new Date(nowMs() - JOB_RUN_RETENTION_DAYS * 86_400_000).toISOString();
    const healthCutoff = new Date(nowMs() - HEALTH_RETENTION_DAYS * 86_400_000).toISOString();
    // Legacy stamps these cutoffs in `Y-m-d H:i:s`; this platform's timestamps
    // are canonical UTC (`...Z`, divergence LT-1), and both adapters compare
    // text — so the cutoffs are canonical too (the R-27 rule the retention
    // sweep already follows: one format, or the comparison silently lies).
    await store.deleteOldLotteryJobRuns(runCutoff);
    await store.deleteOldLotteryHealth(healthCutoff);
    return { status: "OK", runCutoff, healthCutoff };
  }

  return Object.freeze({ runAll, run, jobs: LOTTERY_JOBS });
}
