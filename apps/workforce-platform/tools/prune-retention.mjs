#!/usr/bin/env node
/**
 * The platform's retention policy (row 5; risks R-27 and R-28).
 *
 * One policy, four tables, one command. Each table's window is separate because
 * deleting each row means something different:
 *
 *   wf_analysis_runs   ANALYSIS_RETENTION_DAYS      default 90
 *   wf_notifications   NOTIFICATION_RETENTION_DAYS  default 0 (keep forever)
 *   wf_backtests       BACKTEST_RETENTION_DAYS      default 0 (keep forever)
 *   wf_audit_events    AUDIT_RETENTION_DAYS         default 0 (keep forever)
 *
 * Three rules apply to all four and are asserted by `test/retention.test.js`:
 *
 *  1. **Never from a request.** No HTTP route deletes history; this CLI is the only
 *     caller, exactly as R-27 required for analysis runs.
 *  2. **Dry run by default.** `--apply` is required, and deletion is irreversible.
 *     Take a backup first (`npm run backup`); the tool says so.
 *  3. **0 keeps everything.** A window of zero is the pre-retention behaviour and
 *     must never be read as "delete everything", which is what `now - 0` would do.
 *
 * Each table also carries its own safety guard, in its repository method:
 * notifications prune only rows already READ; backtests never lose the newest
 * report for a (strategy, version), so lifecycle gates cannot be emptied; both
 * text-timestamp tables compare only canonical ISO-8601 rows. Audit events have
 * `DATETIME(3)` and are the security trail — off by default, and the tool warns
 * before applying a window to them.
 *
 * Usage:
 *   node tools/prune-retention.mjs                       # dry run, every window
 *   node tools/prune-retention.mjs --apply               # actually delete
 *   node tools/prune-retention.mjs --target audit        # one table only
 *   node tools/prune-retention.mjs --target audit --days 365
 *   node tools/prune-retention.mjs --audit-days 365 --notification-days 180
 *   node tools/prune-retention.mjs --batch 200           # rows per DELETE
 *   node tools/prune-retention.mjs --now 2026-10-09T00:00:00.000Z   # fixed clock
 *   node tools/prune-retention.mjs --json                # one JSON document
 *
 * Exit: 0 when every requested prune completed, was skipped because its window is
 * off, or had nothing to do; 1 when input was refused or a target failed. An
 * unfinished prune (`maxBatches` reached with rows still matching) exits 0 but
 * warns, because re-running is the remedy and progress was made.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";
import { humanBytes, parseFlags, retentionCutoff } from "./prune-analysis-runs.mjs";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const DEFAULT_BATCH = 500;

/**
 * The four windows, in the order the CLI reports them. `env` is what the human
 * output names when a window is off, so the operator knows which variable to set.
 * `method` is the repository call — the contract names it, so an adapter missing
 * one fails at boot rather than here.
 */
export const RETENTION_TARGETS = Object.freeze([
  {
    key: "analysis",
    flag: "analysis-days",
    label: "analysis runs",
    env: "ANALYSIS_RETENTION_DAYS",
    daysKey: "analysisDays",
    method: "pruneAnalysisRuns",
    bytesKey: "payloadBytes",
  },
  {
    key: "notifications",
    flag: "notification-days",
    label: "read notifications",
    env: "NOTIFICATION_RETENTION_DAYS",
    daysKey: "notificationDays",
    method: "pruneNotifications",
    bytesKey: "bytes",
  },
  {
    key: "backtests",
    flag: "backtest-days",
    label: "backtest reports",
    env: "BACKTEST_RETENTION_DAYS",
    daysKey: "backtestDays",
    method: "pruneBacktests",
    bytesKey: "bytes",
  },
  {
    key: "audit",
    flag: "audit-days",
    label: "audit events",
    env: "AUDIT_RETENTION_DAYS",
    daysKey: "auditDays",
    method: "pruneAuditEvents",
    bytesKey: "bytes",
  },
]);

const TARGET_KEYS = RETENTION_TARGETS.map((target) => target.key);

/** The CLI's `--days` shorthand is only unambiguous when one target was chosen. */
function resolveDays(target, { config, days, overrides }) {
  if (overrides.has(target.key)) return overrides.get(target.key);
  if (days !== null) return days;
  return config.retention[target.daysKey];
}

/**
 * Apply one window. Split out from the CLI so tests can drive it without a
 * subprocess and assert the same report the terminal prints.
 *
 * @param {{store: object, adapter: string, config: object, apply?: boolean,
 *   targets?: string[], days?: number|null, overrides?: Map<string, number>,
 *   batch?: number, now?: number}} options
 */
export async function pruneRetention({
  store,
  adapter,
  config,
  apply = false,
  targets = TARGET_KEYS,
  days = null,
  overrides = new Map(),
  batch = DEFAULT_BATCH,
  now = Date.now(),
}) {
  const requested = targets.map((key) => RETENTION_TARGETS.find((target) => target.key === key));
  const unknown = targets.filter((key) => !TARGET_KEYS.includes(key));
  if (unknown.length) throw new Error(`unknown retention target ${JSON.stringify(unknown[0])}; expected one of ${TARGET_KEYS.join(", ")}`);

  const report = {
    adapter,
    apply: Boolean(apply),
    dryRun: !apply,
    now: new Date(now).toISOString(),
    targets: {},
    totals: { matching: 0, deleted: 0, bytes: 0 },
  };

  for (const target of requested) {
    const windowDays = resolveDays(target, { config, days, overrides });
    if (!Number.isFinite(windowDays) || windowDays < 0) {
      throw new Error(`${target.env} must be 0 or a positive integer, received ${JSON.stringify(windowDays)}`);
    }
    const cutoff = retentionCutoff({ retentionDays: windowDays, now });
    if (cutoff === null) {
      report.targets[target.key] = {
        target: target.key,
        retentionDays: 0,
        cutoff: null,
        skipped: `${target.env}=0 keeps ${target.label} forever; pass --${target.flag} N to prune anyway`,
        matching: 0,
        deleted: 0,
        bytes: 0,
      };
      continue;
    }
    const method = store?.[target.method];
    if (typeof method !== "function") {
      throw new Error(`the ${adapter} store does not implement ${target.method}(); refusing to report a prune that cannot run`);
    }
    const result = await method.call(store, cutoff, { dryRun: !apply, batchSize: batch });
    report.targets[target.key] = { target: target.key, retentionDays: windowDays, ...result };
    report.totals.matching += Number(result.matching ?? 0);
    report.totals.deleted += Number(result.deleted ?? 0);
    report.totals.bytes += Number(result[target.bytesKey] ?? 0);
  }
  return report;
}

/** One target block in the human output. */
function printTarget(key, result, target, { dryRun }) {
  if (result.skipped) {
    console.log(`${key.padEnd(14)} retention off — ${result.skipped}`);
    return;
  }
  if (result.matching === 0) {
    console.log(`${key.padEnd(14)} keep ${String(result.retentionDays).padStart(3)} day(s) — nothing older than ${result.cutoff}`);
    return;
  }
  console.log(`${key.padEnd(14)} keep ${String(result.retentionDays).padStart(3)} day(s) — ${result.matching} ${target.label} older than ${result.cutoff}`);
  console.log(`${" ".repeat(15)}oldest   : ${result.oldest}`);
  console.log(`${" ".repeat(15)}newest   : ${result.newest}`);
  console.log(`${" ".repeat(15)}stored   : ${humanBytes(result[target.bytesKey])}`);
  if (dryRun) {
    console.log(`${" ".repeat(15)}deleted  : 0 (dry run — re-run with --apply to delete these ${result.matching})`);
  } else {
    console.log(`${" ".repeat(15)}deleted  : ${result.deleted} in ${result.batches} batch(es)`);
    if (result.deleted !== result.matching) {
      console.log(`${" ".repeat(15)}warning  : measured ${result.matching} but deleted ${result.deleted} — rows changed while pruning`);
    }
    if (!result.exhausted) console.log(`${" ".repeat(15)}warning  : the batch ceiling was reached and matching rows remain; run again to finish`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flags = parseFlags(process.argv.slice(2));
  const asJson = flags.has("json");
  const apply = flags.has("apply");
  const known = new Set(["apply", "target", "days", "batch", "now", "json", ...RETENTION_TARGETS.map((target) => target.flag)]);
  const unknown = [...flags.keys()].filter((name) => !known.has(name));

  const usage = () => {
    console.error("Usage: node tools/prune-retention.mjs [--target analysis|notifications|backtests|audit] [--days N] [--batch N] [--now ISO] [--apply] [--json]");
    console.error("Per-table overrides: --analysis-days N --notification-days N --backtest-days N --audit-days N");
    console.error("Without --apply this measures and deletes nothing. Take a backup first: npm run backup");
  };

  try {
    if (unknown.length) throw new Error(`unknown flag --${unknown[0]}`);

    const targets = flags.has("target")
      ? String(flags.get("target")).split(",").map((name) => name.trim()).filter(Boolean)
      : [...TARGET_KEYS];
    if (targets.length === 0) throw new Error("--target must name at least one table");
    const unknownTarget = targets.find((name) => !TARGET_KEYS.includes(name));
    if (unknownTarget) throw new Error(`unknown retention target --target ${unknownTarget}; expected one of ${TARGET_KEYS.join(", ")}`);

    const days = flags.has("days") ? Number(flags.get("days")) : null;
    if (days !== null && (!Number.isFinite(days) || days < 0)) throw new Error("--days must be 0 or a positive number of days");
    if (days !== null && targets.length !== 1) {
      throw new Error("--days needs exactly one --target; use --<table>-days for per-table windows");
    }

    const overrides = new Map();
    for (const target of RETENTION_TARGETS) {
      const flag = target.flag;
      if (!flags.has(flag)) continue;
      const value = Number(flags.get(flag));
      if (!Number.isFinite(value) || value < 0) throw new Error(`--${flag} must be 0 or a positive number of days`);
      overrides.set(target.key, value);
    }

    const batch = flags.has("batch") ? Number(flags.get("batch")) : DEFAULT_BATCH;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 5_000) throw new Error("--batch must be an integer between 1 and 5000");
    let now = Date.now();
    if (flags.has("now")) {
      now = Date.parse(String(flags.get("now")));
      if (Number.isNaN(now)) throw new Error("--now must be an ISO-8601 instant");
    }

    const config = loadConfig(process.env);
    const { store, pool, adapter } = await createStoreFor({ config, logger: SILENT });
    let report;
    try {
      const readiness = await store.readiness();
      if (!readiness.database) {
        throw new Error(`The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); refusing to prune against a store that cannot answer`);
      }
      report = await pruneRetention({ store, adapter, config, apply, targets, days, overrides, batch, now });
    } finally {
      await store.close?.();
      await pool?.end?.();
    }

    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    } else {
      const mode = report.dryRun ? "DRY RUN" : "APPLIED";
      console.log(`${mode} — adapter ${report.adapter}, ${targets.length} table(s), clock ${report.now}`);
      console.log("");
      for (const target of RETENTION_TARGETS) {
        const result = report.targets[target.key];
        if (result) printTarget(target.key, result, target, { dryRun: report.dryRun });
      }
      if (report.dryRun && report.totals.matching > 0) {
        console.log("");
        console.log(`Deletion is irreversible and removes evidence. Take a backup first: npm run backup`);
      }
      if (report.apply && report.targets.audit && !report.targets.audit.skipped && report.targets.audit.matching > 0) {
        console.log("");
        console.log("Note: the audit trail is security evidence. A deleted event cannot be re-attributed.");
      }
    }
    process.exitCode = 0;
  } catch (error) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else {
      console.error(`Retention prune failed: ${error.message}`);
      usage();
    }
    process.exitCode = 1;
  }
}
