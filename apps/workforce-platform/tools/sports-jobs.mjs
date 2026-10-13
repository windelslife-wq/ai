#!/usr/bin/env node
/**
 * The sports cron (row 19 of docs/migration/UNFINISHED_MODULES.md).
 *
 * The Node entry point the host's cron calls for the sports jobs, replacing legacy's
 * `php index.php tools sports-cron [job]`. One invocation runs all nine jobs in
 * legacy's order — fixtures, odds, results, quality, ticket, settlement, performance,
 * monitoring, cleanup — or one named job. Every job is idempotent: the sync jobs by
 * their per-provider execution keys, the rest by a `wf_job_locks` row whose expiry IS
 * the window (an hour for the hourly jobs, the day for cleanup), so a re-run inside
 * the same window reports DUPLICATE_SKIPPED and a cron schedule that fires twice
 * cannot double-write.
 *
 * cPanel → Cron Jobs (legacy scheduled the sports jobs inside its single `tools cron`
 * sweep; on this host they get their own line so the sports log is separate):
 *
 *   0 * * * * cd /home/USER/apps/workforce-platform && /usr/local/bin/node tools/sports-jobs.mjs --json >> /home/USER/logs/workforce-sports-cron.log 2>&1
 *
 * Use the absolute `node` path — cron does not inherit an interactive shell's PATH —
 * and `cd` first, because `loadConfig` resolves relative storage paths against the
 * working directory. Unlike the operations cron (`tools/scheduled-jobs.mjs`) there is
 * no dry run: legacy's sports jobs have no measure-only form (a sync either fetches
 * or does not), so the idempotency keys are the safety, and pointing cron at this file
 * cannot double-write however often it fires.
 *
 * Usage:
 *   node tools/sports-jobs.mjs                      # run all nine jobs for today
 *   node tools/sports-jobs.mjs --job settlement     # run one job
 *   node tools/sports-jobs.mjs --date 2026-10-11    # run for a specific day
 *   node tools/sports-jobs.mjs --json               # one JSON document on stdout
 *   node tools/sports-jobs.mjs --now 2026-10-12T13:00:00Z   # fixed clock, for tests
 *
 * Exit: 0 when every job COMPLETED (or was DUPLICATE_SKIPPED/SKIPPED — both are facts
 * about the schedule, not failures); 1 when any job FAILED or the run was refused.
 * A cron that exits 0 while one of its jobs is broken is how a job stops running and
 * nobody notices for a month.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";
import { buildApp } from "../src/app.js";
import { createSportsCronService, SPORTS_JOBS } from "../src/modules/sports/cron.js";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

/** Same flag grammar as `tools/scheduled-jobs.mjs`. */
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
 * Run the sports cron.
 *
 * Builds the service graph through `buildApp` rather than constructing the sports
 * service here: the jobs drive the same sync, ticket, settlement, drift and
 * measurement services the HTTP surface wires, and a second hand-rolled wiring in a
 * tool is a wiring that drifts. `buildApp` performs no writes and never listens, so
 * this is construction only.
 *
 * @param {{config: object, job?: string|null, date?: string|null, now?: number|null, logger?: object}} options
 * @returns {Promise<{adapter: string, summary: object, failed: string[]}>}
 */
export async function runSportsJobs({ config, job = null, date = null, now = null, logger = SILENT }) {
  const { store, pool, adapter } = await createStoreFor({ config, logger });
  try {
    const readiness = await store.readiness();
    if (!readiness.database) {
      throw new Error(
        `The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); `
        + "refusing to run the sports cron against a store that cannot answer",
      );
    }
    const app = await buildApp({ config, store, logger: false, adapter });
    if (!app.sports?.cron) {
      throw new Error("This host has no sports repository, so there is no sports cron to run");
    }
    // F-44: `--now` must actually drive the jobs' clock, not just decorate the
    // report — the original draft parsed it and ran on the wall clock, so a test
    // pinning the cutoff caught cleanup pruning at "now" instead of the requested
    // instant. The pinned cron is built by the SAME factory over the SAME service
    // graph and store, so this is a clock, not a second wiring.
    const timestamp = now === null || now === undefined ? null : Number(now);
    const cron = timestamp === null
      ? app.sports.cron
      : createSportsCronService({ sports: app.sports, store, now: () => timestamp });
    const summary = job
      ? { [job]: await cron.run(job, { date: date ?? undefined }) }
      : await cron.runAll({ date: date ?? undefined });
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
    console.error("Usage: node tools/sports-jobs.mjs [--job NAME] [--date YYYY-MM-DD] [--now ISO] [--json]");
    console.error(`Jobs: ${SPORTS_JOBS.join(", ")}`);
  };

  try {
    if (unknown.length) throw new Error(`unknown flag --${unknown[0]}`);
    if (flags.has("job") && !SPORTS_JOBS.includes(String(flags.get("job")))) {
      throw new Error(`--job must be one of ${SPORTS_JOBS.join(", ")}, received ${String(flags.get("job")).slice(0, 40)}`);
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
    const result = await runSportsJobs({ config, job: flags.has("job") ? String(flags.get("job")) : null, date: flags.has("date") ? String(flags.get("date")) : null, now });

    if (asJson) {
      console.log(JSON.stringify({ ok: result.failed.length === 0, ...result }, null, 2));
    } else {
      for (const [name, entry] of Object.entries(result.summary)) {
        const status = entry?.status ?? "FAILED";
        console.log(`${status.padEnd(18)} ${name}${entry?.summary ? ` — ${entry.summary}` : ""}${entry?.error ? ` — ${entry.error}` : ""}`);
      }
    }
    process.exitCode = result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    usage();
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
