#!/usr/bin/env node
/**
 * Scheduled operations (row 19 of docs/migration/UNFINISHED_MODULES.md).
 *
 * The Node entry point the host's cron calls, replacing legacy's
 * `php index.php tools cron`. One invocation runs two sweeps under one
 * `wf_job_locks` row (migration 010):
 *
 *   1. the portfolio risk sweep — every paper account across every owner, with
 *      edge-triggered `PORTFOLIO_RISK` alerts;
 *   2. stale execution-proposal expiry — proposals whose approval window lapsed.
 *
 * then records one `system.job.run` audit event as the system actor.
 *
 * cPanel → Cron Jobs (every minute, matching the legacy schedule):
 *
 *   * * * * * cd /home/USER/apps/workforce-platform && /usr/local/bin/node tools/scheduled-jobs.mjs --apply >> /home/USER/logs/workforce-cron.log 2>&1
 *
 * Use the absolute `node` path — cron does not inherit an interactive shell's PATH —
 * and `cd` first, because `loadConfig` resolves relative storage paths against the
 * working directory. `--apply` is what makes it run for real; without it the job
 * measures and writes nothing, which is why an operator can point cron at this file
 * first and watch a log before anything is expired.
 *
 * Usage:
 *   node tools/scheduled-jobs.mjs                     # dry run — measures, writes nothing
 *   node tools/scheduled-jobs.mjs --apply             # run for real, under the lock
 *   node tools/scheduled-jobs.mjs --apply --json      # one JSON document on stdout
 *   node tools/scheduled-jobs.mjs --holder web-1      # name this worker in the lock row
 *   node tools/scheduled-jobs.mjs --lock-ttl-ms 600000
 *   node tools/scheduled-jobs.mjs --account-limit 500 --proposal-limit 200
 *   node tools/scheduled-jobs.mjs --now 2026-10-11T00:00:00.000Z   # fixed clock, for tests
 *
 * A dry run is the default for the same reason it is in `prune-analysis-runs.mjs`:
 * this job writes. It expires proposals an operator was about to approve, publishes
 * notifications, and rewrites the transition memory that decides what counts as a new
 * alert. None of that is irreversible the way a delete is, but all of it is visible to
 * other people, so measuring first is the default.
 *
 * Exit: 0 the run completed, or was skipped because another run holds the lock (a
 * normal outcome for an every-minute schedule whose previous run is still going);
 * 1 refused, failed, or completed with any stage error. A partial failure exits 1
 * even though other stages succeeded — a cron that exits 0 while one of its two jobs
 * is broken is how a job stops running and nobody notices for a month.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";
import { buildApp } from "../src/app.js";
import {
  OPERATIONS_JOB_NAME,
  DEFAULT_ACCOUNT_LIMIT,
  DEFAULT_PROPOSAL_LIMIT,
  DEFAULT_LOCK_TTL_MS,
} from "../src/jobs/scheduled.js";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };

/** Same flag grammar as `tools/backup.mjs` and `tools/prune-analysis-runs.mjs`. */
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

/** A bounded positive integer flag, or `fallback` when absent. */
function intFlag(flags, name, fallback, { min = 1, max = 5_000 } = {}) {
  if (!flags.has(name)) return fallback;
  const value = Number(flags.get(name));
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Run — or with `apply` false, measure — the scheduled operations job.
 *
 * Builds the service graph through `buildApp` rather than constructing each service
 * here: the job needs the paper, execution, notification and market-data services
 * wired exactly as the HTTP surface wires them, and a second hand-rolled wiring in a
 * tool is a wiring that drifts. `buildApp` performs no writes and never listens, so
 * this is construction only.
 *
 * @param {{config: object, apply?: boolean, holder?: string|null, lockTtlMs?: number,
 *   accountLimit?: number, proposalLimit?: number, now?: number|null, logger?: object}} options
 * @returns {Promise<object>} the job summary plus `adapter`
 */
export async function runScheduledJobs({
  config,
  apply = false,
  holder = null,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  accountLimit = DEFAULT_ACCOUNT_LIMIT,
  proposalLimit = DEFAULT_PROPOSAL_LIMIT,
  now = null,
  logger = SILENT,
}) {
  const { store, pool, adapter } = await createStoreFor({ config, logger });
  try {
    const readiness = await store.readiness();
    if (!readiness.database) {
      throw new Error(
        `The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); `
        + "refusing to run scheduled jobs against a store that cannot answer",
      );
    }
    const app = await buildApp({ config, store, logger: false, adapter });
    const result = await app.jobs.runOperations({
      holder,
      lockTtlMs,
      accountLimit,
      proposalLimit,
      timestamp: now === null || now === undefined ? null : Number(now),
      dryRun: !apply,
    });
    return { adapter, ...result };
  } finally {
    await store.close?.();
    await pool?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flags = parseFlags(process.argv.slice(2));
  const asJson = flags.has("json");
  const apply = flags.has("apply");
  const known = new Set(["apply", "json", "holder", "lock-ttl-ms", "account-limit", "proposal-limit", "now"]);
  const unknown = [...flags.keys()].filter((name) => !known.has(name));

  // Only reached on failure, so it goes to stderr with the error: stdout stays empty
  // (or, under --json, holds exactly one document) for anything parsing it.
  const usage = () => {
    console.error("Usage: node tools/scheduled-jobs.mjs [--apply] [--holder NAME] [--lock-ttl-ms N] [--account-limit N] [--proposal-limit N] [--now ISO] [--json]");
    console.error("Without --apply this measures and writes nothing — no lock, no expiry, no alerts.");
  };

  try {
    if (unknown.length) throw new Error(`unknown flag --${unknown[0]}`);
    const config = loadConfig(process.env);

    const holder = flags.has("holder") ? String(flags.get("holder")).slice(0, 120) : `cron#${process.pid}`;
    if (!holder.trim()) throw new Error("--holder must not be empty");
    const lockTtlMs = intFlag(flags, "lock-ttl-ms", DEFAULT_LOCK_TTL_MS, { min: 5_000, max: 3_600_000 });
    const accountLimit = intFlag(flags, "account-limit", DEFAULT_ACCOUNT_LIMIT, { min: 1, max: 5_000 });
    const proposalLimit = intFlag(flags, "proposal-limit", DEFAULT_PROPOSAL_LIMIT, { min: 1, max: 500 });
    let now = null;
    if (flags.has("now")) {
      now = Date.parse(String(flags.get("now")));
      if (Number.isNaN(now)) throw new Error("--now must be an ISO-8601 instant");
    }

    const result = await runScheduledJobs({ config, apply, holder, lockTtlMs, accountLimit, proposalLimit, now });

    if (asJson) {
      console.log(JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2));
    } else if (result.skipped) {
      // Not an error: an every-minute cron whose previous run is still going will
      // skip, and the log should read as a fact rather than a failure.
      console.log(`SKIPPED — ${OPERATIONS_JOB_NAME} is already running`);
      console.log(`  held by  : ${result.lock?.holder ?? "unknown"}`);
      console.log(`  reason   : ${result.lock?.reason ?? "another holder owns the lock"}`);
      console.log(`  adapter  : ${result.adapter}${result.crossProcessSafety ? "" : " (no cross-process safety — this lock is single-process only; use MySQL for real cron)"}`);
    } else {
      const mode = result.dryRun ? "DRY RUN" : "APPLIED";
      console.log(`${mode} — ${OPERATIONS_JOB_NAME} at ${result.ranAt}, adapter ${result.adapter}`);
      if (result.lock?.acquired) {
        console.log(`  lock     : held by ${result.lock.holder} for ${result.lock.ttlMs} ms, released ${result.lock.released ? "yes" : "NO"}`);
        if (!result.lock.released) console.log(`  warning  : ${result.lock.reason}`);
      }
      if (!result.crossProcessSafety && !result.dryRun) {
        console.log("  warning  : this adapter's lock is single-process only — cron on shared hosting needs MySQL to be safe against overlap");
      }
      if (result.risk) {
        const risk = result.risk;
        console.log(`  accounts : ${risk.accountsScanned} scanned across ${risk.owners} owner(s)${risk.exhausted ? "" : " (account ceiling reached — raise --account-limit)"}`);
        console.log(`  alerts   : ${risk.alerts} active (${risk.codes.length ? risk.codes.join(", ") : "none"})`);
        if (result.dryRun) {
          console.log(`  would    : raise ${risk.wouldRaise}, clear ${risk.wouldClear} — nothing audited, notified or persisted`);
        } else {
          console.log(`  changes  : raised ${risk.raised}, cleared ${risk.cleared}`);
        }
        if (!risk.memoryReadable) {
          console.log("  warning  : the transition memory could not be read, so every active alert counts as new and alerts already sent will be sent again");
        } else if (risk.firstRun) {
          console.log("  note     : first run — no transition memory existed yet, so this run establishes the baseline");
        }
        if (risk.unclassifiedCodes?.length) {
          console.log(`  warning  : breach code(s) not classified in src/jobs/scheduled.js, defaulted to warning severity — ${risk.unclassifiedCodes.join(", ")}`);
        }
        for (const failure of risk.scanFailures || []) {
          console.log(`  warning  : ${failure.accountIds.length} account(s) of owner ${failure.owner ?? "none"} could not be scanned — ${failure.reason}`);
        }
      }
      if (result.proposals) {
        const proposals = result.proposals;
        console.log(`  proposals: ${proposals.scanned} pending, ${proposals.staleFound} past the approval window`);
        if (result.dryRun) {
          console.log(`  would    : expire ${proposals.wouldExpireIds?.length ?? 0} (re-run with --apply to expire them)`);
        } else {
          console.log(`  expired  : ${proposals.expiredIds.length}${proposals.expiredIds.length ? ` — ${proposals.expiredIds.join(", ")}` : ""}`);
          if (proposals.alreadyExpired) console.log(`  note     : ${proposals.alreadyExpired} were already expired by another run`);
        }
        if (!proposals.exhausted) console.log("  warning  : the proposal ceiling was reached and more remain; run again to finish");
        for (const failure of proposals.failures || []) {
          console.log(`  warning  : proposal ${failure.proposalId} — ${failure.reason}`);
        }
      }
      for (const error of result.errors) console.log(`  error    : ${error.stage} — ${error.reason}`);
      if (!apply) console.log("Dry run: nothing was expired, notified, audited or persisted. Re-run with --apply.");
    }
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  } catch (error) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else {
      console.error(`Scheduled jobs failed: ${error.message}`);
      usage();
    }
    process.exitCode = 1;
  }
}
