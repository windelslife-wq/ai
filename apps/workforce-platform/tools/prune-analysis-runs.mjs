#!/usr/bin/env node
/**
 * Analysis-run retention (risk R-27).
 *
 * `wf_analysis_runs.payload` holds a LONGTEXT copy of an entire run — every agent
 * verdict, the debate transcript, scenarios, the setup, the risk decision and the
 * data provenance — so a decision can be re-read later without re-deriving it from
 * market data that no longer exists. Nothing else in the platform ever deletes a
 * row, so the table grows for the life of the deployment, on shared hosting where
 * disk is not elastic. This tool is the only thing that shrinks it.
 *
 * It is a cron/operator tool and never a route: a session-scoped HTTP API with a
 * delete verb over the audit copy of what a user was shown is not a trade worth
 * making. There is deliberately no `DELETE /api/v1/analysis/...`.
 *
 * Usage:
 *   node tools/prune-analysis-runs.mjs                  # dry run — measures, deletes nothing
 *   node tools/prune-analysis-runs.mjs --apply          # actually delete
 *   node tools/prune-analysis-runs.mjs --days 30        # override ANALYSIS_RETENTION_DAYS
 *   node tools/prune-analysis-runs.mjs --batch 200      # MySQL rows per DELETE (lock duration)
 *   node tools/prune-analysis-runs.mjs --now 2026-10-09T00:00:00.000Z   # fixed clock, for tests
 *   node tools/prune-analysis-runs.mjs --json           # one JSON document on stdout
 *
 * A dry run is the default because deletion here is irreversible and the thing being
 * deleted is evidence. Take a backup first (`npm run backup`); the tool says so.
 *
 * Exit: 0 the prune completed or there was nothing to do (including retention being
 * disabled); 1 refused or failed. An unfinished prune — `maxBatches` reached with
 * rows still matching — exits 0 but warns, because re-running is the remedy and
 * progress was made.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const DAY_MS = 86_400_000;
const DEFAULT_BATCH = 500;

/** Same flag grammar as `tools/backup.mjs`: `--name value`, `--name=value`, `--flag`. */
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

/** A byte count an operator can read at a glance, because that is the whole point. */
export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The cutoff instant for a retention window, or `null` when retention is off.
 *
 * `0` days means "keep everything" — the pre-R-27 behaviour — and must never be
 * read as "delete everything", which is what a naive `now - 0` would produce.
 *
 * @param {{retentionDays: number, now?: number}} options
 * @returns {string|null} ISO-8601 UTC, the form `assertIsoCutoff` requires.
 */
export function retentionCutoff({ retentionDays, now = Date.now() }) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Number(now) - days * DAY_MS).toISOString();
}

/**
 * Measure — and with `apply`, delete — the runs older than the retention window.
 *
 * @param {{config: object, apply?: boolean, days?: number|null, batch?: number, now?: number}} options
 * @returns {Promise<object>} the adapter's report plus `adapter`, `retentionDays`,
 *   `apply` and, when retention is disabled, `skipped`.
 */
export async function pruneAnalysisRuns({ config, apply = false, days = null, batch = DEFAULT_BATCH, now = Date.now() }) {
  const retentionDays = days === null || days === undefined ? config.analysis.retentionDays : Number(days);
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`retention days must be 0 or a positive integer, received ${JSON.stringify(days ?? config.analysis.retentionDays)}`);
  }
  const cutoff = retentionCutoff({ retentionDays, now });
  if (cutoff === null) {
    return {
      adapter: config.database ? "mysql" : config.storage?.adapter ?? "unknown",
      retentionDays,
      apply: Boolean(apply),
      skipped: "ANALYSIS_RETENTION_DAYS=0 keeps analysis runs forever; pass --days N to prune anyway",
      matching: 0,
      deleted: 0,
      payloadBytes: 0,
      oldest: null,
      newest: null,
      cutoff: null,
      batches: 0,
      exhausted: true,
      dryRun: !apply,
    };
  }

  const { store, pool, adapter } = await createStoreFor({ config, logger: SILENT });
  try {
    const readiness = await store.readiness();
    if (!readiness.database) {
      throw new Error(`The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); refusing to prune against a store that cannot answer`);
    }
    const report = await store.pruneAnalysisRuns(cutoff, { dryRun: !apply, batchSize: batch });
    return { adapter, retentionDays, apply: Boolean(apply), ...report };
  } finally {
    await store.close?.();
    await pool?.end?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flags = parseFlags(process.argv.slice(2));
  const asJson = flags.has("json");
  const apply = flags.has("apply");
  const known = new Set(["apply", "days", "batch", "now", "json"]);
  const unknown = [...flags.keys()].filter((name) => !known.has(name));

  // Only ever reached on failure, so it goes to stderr with the error: stdout stays
  // empty (or, under --json, holds exactly one document) for anything parsing it.
  const usage = () => {
    console.error("Usage: node tools/prune-analysis-runs.mjs [--days N] [--batch N] [--now ISO] [--apply] [--json]");
    console.error("Without --apply this measures and deletes nothing. Take a backup first: npm run backup");
  };

  try {
    if (unknown.length) throw new Error(`unknown flag --${unknown[0]}`);
    const config = loadConfig(process.env);

    const days = flags.has("days") ? Number(flags.get("days")) : null;
    if (days !== null && (!Number.isFinite(days) || days < 0)) throw new Error("--days must be 0 or a positive number of days");
    const batch = flags.has("batch") ? Number(flags.get("batch")) : DEFAULT_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 5_000) throw new Error("--batch must be an integer between 1 and 5000");
    let now = Date.now();
    if (flags.has("now")) {
      now = Date.parse(String(flags.get("now")));
      if (Number.isNaN(now)) throw new Error("--now must be an ISO-8601 instant");
    }

    const result = await pruneAnalysisRuns({ config, apply, days, batch, now });

    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else if (result.skipped) {
      console.log(`Retention is off: ${result.skipped}`);
    } else {
      const mode = result.dryRun ? "DRY RUN" : "APPLIED";
      console.log(`${mode} — keep ${result.retentionDays} day(s), cutoff ${result.cutoff}, adapter ${result.adapter}`);
      if (result.matching === 0) {
        console.log("No analysis runs are older than the cutoff; nothing to do.");
      } else {
        console.log(`  matching : ${result.matching} run(s) older than the cutoff`);
        console.log(`  oldest   : ${result.oldest}`);
        console.log(`  newest   : ${result.newest}`);
        console.log(`  payload  : ${humanBytes(result.payloadBytes)} of stored run data`);
        if (result.dryRun) {
          console.log(`  deleted  : 0 (dry run — re-run with --apply to delete these ${result.matching} run(s))`);
          console.log("Deletion is irreversible and removes evidence. Take a backup first: npm run backup");
        } else {
          console.log(`  deleted  : ${result.deleted} run(s) in ${result.batches} batch(es)`);
          if (result.deleted !== result.matching) {
            console.log(`  warning  : measured ${result.matching} but deleted ${result.deleted} — rows were added or removed while pruning`);
          }
        }
        if (!result.exhausted) console.log("  warning  : the batch ceiling was reached and matching rows remain; run again to finish");
      }
    }
    process.exitCode = 0;
  } catch (error) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else {
      console.error(`Analysis-run prune failed: ${error.message}`);
      usage();
    }
    process.exitCode = 1;
  }
}
