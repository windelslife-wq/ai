/**
 * Analysis-run SQL for the MySQL/MariaDB adapter (Phase 5).
 *
 * Same rules as `account-repository.js` and `site-repository.js`: every value is
 * bound, and LIMIT is coerced to a bounded integer before interpolation because
 * mysql2 does not bind it reliably in a `LIMIT` clause.
 *
 * The save is an upsert. The legacy repository did a `SELECT COUNT(*)` and then an
 * `INSERT` or `UPDATE`; `ON DUPLICATE KEY UPDATE` is the same semantics in one
 * round trip and without the read/write race two workers could hit. Run ids are
 * UUIDv4, so a duplicate key means the same run was persisted twice — updating is
 * correct, and silently inserting a second copy would not be.
 *
 * `confidence` is declared DECIMAL(5,4) and the pool is configured with
 * `decimalNumbers: false`, so the driver returns it as a string. It is converted
 * here, at the boundary, because a history row that reports `"0.7200"` instead of
 * `0.72` is a payload change no caller asked for.
 */

import { assertIsoCutoff } from "../persistence/contract.js";

/**
 * Retention deletes run in batches rather than as one statement (risk R-27).
 *
 * This is shared hosting: a single `DELETE` that matches a year of runs would hold
 * locks and grow the undo log for as long as it took, on a server other tenants
 * are using. Bounding each statement keeps every delete short, and the loop stops
 * as soon as a batch comes back partly empty, which is the signal that nothing
 * matching is left.
 */
function boundedBatch(value, fallback = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 5_000);
}

function boundedLimit(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
}

function summaryRow(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    bias: row.bias,
    confidence: Number(row.confidence),
    regime: row.regime,
    recommendation: row.recommendation,
    synthetic: Boolean(Number(row.synthetic)),
    source: row.source,
    completedAt: row.completed_at,
  };
}

export function createAnalysisRepository(pool) {
  return {
    async saveAnalysisRun(run) {
      await pool.execute(
        `INSERT INTO wf_analysis_runs
           (id, symbol, timeframe, bias, confidence, regime, recommendation, synthetic, source, completed_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           symbol = VALUES(symbol),
           timeframe = VALUES(timeframe),
           bias = VALUES(bias),
           confidence = VALUES(confidence),
           regime = VALUES(regime),
           recommendation = VALUES(recommendation),
           synthetic = VALUES(synthetic),
           source = VALUES(source),
           completed_at = VALUES(completed_at),
           payload = VALUES(payload)`,
        [
          run.id,
          run.symbol,
          run.timeframe,
          run.bias,
          run.confidence,
          run.regime,
          run.recommendation,
          run.synthetic ? 1 : 0,
          run.source,
          run.completedAt,
          JSON.stringify(run.payload ?? null),
        ],
      );
      return { id: run.id, completedAt: run.completedAt };
    },

    async listAnalysisRuns({ limit = 20 } = {}) {
      const bounded = boundedLimit(limit);
      const [rows] = await pool.query(
        `SELECT id, symbol, timeframe, bias, confidence, regime, recommendation, synthetic, source, completed_at
           FROM wf_analysis_runs
          ORDER BY completed_at DESC, id ASC
          LIMIT ${bounded}`,
      );
      return rows.map(summaryRow);
    },

    /**
     * Report on — and optionally delete — every run completed before `beforeIso`
     * (risk R-27).
     *
     * `payload` is a LONGTEXT copy of the whole run (agents, debate transcript,
     * scenarios, setup, risk decision, provenance), so the table grows without bound
     * and nothing else in the platform ever removes a row. Retention is an operator
     * decision taken outside a request, which is why this is a repository method
     * driven by `tools/prune-analysis-runs.mjs` and not a route: there is no HTTP
     * surface that can delete analysis history.
     *
     * The measurement query always runs, in both modes, so a dry run reports exactly
     * what an apply would remove — including how much disk comes back, which is the
     * whole point of the exercise.
     *
     * The comparison is textual, so the cutoff is validated by `assertIsoCutoff`
     * before it reaches a query. `ORDER BY` is included in the delete because
     * `DELETE … LIMIT` without it is non-deterministic, and statement-based
     * replication logs a non-deterministic delete as unsafe.
     *
     * @param {string} beforeIso ISO-8601 UTC instant; rows strictly older are removed.
     * @param {{dryRun?: boolean, batchSize?: number, maxBatches?: number}} [options]
     * @returns {Promise<{matching: number, deleted: number, payloadBytes: number,
     *   oldest: string|null, newest: string|null, cutoff: string, batches: number,
     *   exhausted: boolean, dryRun: boolean}>} `exhausted: false` means `maxBatches`
     *   was reached and matching rows remain.
     */
    async pruneAnalysisRuns(beforeIso, { dryRun = false, batchSize = 500, maxBatches = 1_000 } = {}) {
      const cutoff = assertIsoCutoff(beforeIso);
      const [[measured]] = await pool.execute(
        `SELECT COUNT(*) AS total,
                MIN(completed_at) AS oldest,
                MAX(completed_at) AS newest,
                COALESCE(SUM(LENGTH(payload)), 0) AS payload_bytes
           FROM wf_analysis_runs
          WHERE completed_at < ?`,
        [cutoff],
      );
      const report = {
        matching: Number(measured?.total ?? 0),
        deleted: 0,
        payloadBytes: Number(measured?.payload_bytes ?? 0),
        oldest: measured?.oldest ?? null,
        newest: measured?.newest ?? null,
        cutoff,
        batches: 0,
        exhausted: true,
        dryRun: Boolean(dryRun),
      };
      if (dryRun || report.matching === 0) return report;

      const batch = boundedBatch(batchSize);
      const ceiling = Number.isSafeInteger(Number(maxBatches)) ? Math.max(1, Number(maxBatches)) : 1_000;
      while (report.batches < ceiling) {
        const [result] = await pool.query(
          `DELETE FROM wf_analysis_runs
            WHERE completed_at < ?
            ORDER BY completed_at ASC
            LIMIT ${batch}`,
          [cutoff],
        );
        const affected = Number(result?.affectedRows ?? 0);
        report.deleted += affected;
        report.batches += 1;
        if (affected < batch) break;
        if (report.batches === ceiling) report.exhausted = false;
      }
      return report;
    },

    async findAnalysisRun(id) {
      const [rows] = await pool.execute("SELECT payload FROM wf_analysis_runs WHERE id = ? LIMIT 1", [String(id)]);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].payload);
      } catch {
        // A payload that will not parse is a corrupt row, not a missing run: the
        // distinction matters because a 404 would tell the caller the run never
        // happened.
        const error = new Error(`Analysis run ${id} has an unreadable payload`);
        error.statusCode = 500;
        throw error;
      }
    },
  };
}
