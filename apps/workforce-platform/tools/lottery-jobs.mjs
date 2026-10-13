#!/usr/bin/env node
/**
 * The lottery cron (row 15, slice 5 of docs/migration/UNFINISHED_MODULES.md).
 *
 * The Node entry point the host's cron calls for the lottery jobs, replacing
 * legacy's `php index.php tools lottery-cron [job]`. One invocation runs all
 * seven jobs in legacy's order — sync, health, statistics, systems, tickets,
 * backtests, cleanup — or one named job. Every job is idempotent by execution
 * key on the lottery's own job-run table (`wf_lottery_sync_runs`): the day's
 * sync and each strategy's backtest run at most once per date (a re-run
 * reports ALREADY_RUN or skips, and a failed run's key still blocks the
 * window), and the `systems` job IS the consumer for the queued background
 * builds the API creates when a pool exceeds the synchronous limit.
 *
 * cPanel → Cron Jobs (legacy ran the lottery jobs inside its single `tools
 * cron` sweep; on this host they get their own line so the lottery log is
 * separate from the sports log):
 *
 *   30 5 * * * cd /home/USER/apps/workforce-platform && /usr/local/bin/node tools/lottery-jobs.mjs --json >> /home/USER/logs/workforce-lottery-cron.log 2>&1
 *
 * Use the absolute `node` path — cron does not inherit an interactive shell's
 * PATH — and `cd` first, because `loadConfig` resolves relative storage paths
 * against the working directory. Like the sports cron there is no dry run: the
 * execution keys are the safety, and pointing cron at this file cannot
 * double-write however often it fires.
 *
 * Usage:
 *   node tools/lottery-jobs.mjs                      # run all seven jobs for today
 *   node tools/lottery-jobs.mjs --job systems        # run one job
 *   node tools/lottery-jobs.mjs --date 2026-10-13    # run for a specific day
 *   node tools/lottery-jobs.mjs --json               # one JSON document on stdout
 *   node tools/lottery-jobs.mjs --now 2026-10-13T05:30:00Z   # fixed clock, for tests
 *
 * Exit: 0 when every job answered OK / ALREADY_RUN / SKIPPED (all facts about
 * the schedule, not failures); 1 when any job FAILED or the run was refused.
 * A cron that exits 0 while one of its jobs is broken is how a job stops
 * running and nobody notices for a month.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";
import { buildApp } from "../src/app.js";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

/** Same flag grammar as `tools/sports-jobs.mjs`. */
function parseFlags(entries) {
  const flags = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.startsWith("--")) continue;
    const [name, inline] = entry.slice(2).split("=");
    const next = entries[index + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return flags;
}

/**
 * Run the lottery cron.
 *
 * Builds the service graph through `buildApp` rather than constructing the
 * lottery service here: the jobs drive the same sync, check, backtest and
 * system services the HTTP surface wires, and a second hand-rolled wiring in a
 * tool is a wiring that drifts. `buildApp` performs no writes and never
 * listens, so this is construction only.
 *
 * @param {{config: object, job?: string|null, date?: string|null, now?: number|null, logger?: object}} options
 * @returns {Promise<{adapter: string, summary: object, failed: string[]}>}
 */
export async function runLotteryJobs({ config, job = null, date = null, now = null, logger = SILENT }) {
  const { store, pool, adapter } = await createStoreFor({ config, logger });
  try {
    const readiness = await store.readiness();
    if (!readiness.database) {
      throw new Error(
        `The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); `
        + "refusing to run the lottery cron against a store that cannot answer",
      );
    }
    const app = await buildApp({ config, store, logger: false, adapter });
    if (!app.lottery?.cron) {
      throw new Error("This host has no lottery repository, so there is no lottery cron to run");
    }
    // F-44's lesson from the sports CLI: `--now` must actually drive the jobs'
    // clock, not just decorate the report. The pinned cron is rebuilt by the
    // SAME factory over the SAME service graph and store.
    const timestamp = now === null || now === undefined ? null : Number(now);
    const cron = timestamp === null
      ? app.lottery.cron
      : (await import("../src/modules/lottery/cron.js")).createLotteryCronService({ lottery: app.lottery, store, now: () => timestamp });
    const summary = job
      ? { [job]: await cron.run(job, date ?? undefined) }
      : await cron.runAll(date ?? undefined);
    const failed = Object.entries(summary)
      .filter(([, entry]) => (entry?.status ?? "FAILED") === "FAILED")
      .map(([name]) => name);
    return { adapter, summary, failed, timestamp };
  } finally {
    await store.close?.();
    await pool?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flags = parseFlags(process.argv.slice(2));
  const asJson = flags.has("json");
  const known = new Set(["job", "date", "json", "now"]);
  const unknown = [...flags.keys()].filter((name) => !known.has(name));

  // Only reached on failure, so it goes to stderr with the error: stdout stays empty
  // (or, under --json, holds exactly one document) for anything parsing it.
  const usage = () => {
    console.error("Usage: node tools/lottery-jobs.mjs [--job NAME] [--date YYYY-MM-DD] [--now ISO] [--json]");
    console.error("Jobs: sync, health, statistics, systems, tickets, backtests, cleanup");
  };

  try {
    if (unknown.length) throw new Error(`unknown flag --${unknown[0]}`);
    if (flags.has("job") && !["sync", "health", "statistics", "systems", "tickets", "backtests", "cleanup"].includes(String(flags.get("job")))) {
      throw new Error(`--job must be one of sync, health, statistics, systems, tickets, backtests, cleanup, received ${String(flags.get("job")).slice(0, 40)}`);
    }
    if (flags.has("date") && !/^\d{4}-\d{2}-\d{2}$/.test(String(flags.get("date")))) {
      throw new Error("--date must be YYYY-MM-DD");
    }
    let now = null;
    if (flags.has("now")) {
      now = Date.parse(String(flags.get("now")));
      if (Number.isNaN(now)) throw new Error("--now must be an ISO-8601 instant");
    }
    const config = loadConfig(process.env);
    const result = await runLotteryJobs({ config, job: flags.has("job") ? String(flags.get("job")) : null, date: flags.has("date") ? String(flags.get("date")) : null, now });

    if (asJson) {
      console.log(JSON.stringify({ ok: result.failed.length === 0, ...result }, null, 2));
    } else {
      for (const [name, entry] of Object.entries(result.summary)) {
        const status = entry?.status ?? "FAILED";
        console.log(`${status.padEnd(20)} ${name}${entry?.note ? ` — ${entry.note}` : ""}${entry?.error ? ` — ${entry.error}` : ""}`);
      }
    }
    process.exitCode = result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    usage();
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
