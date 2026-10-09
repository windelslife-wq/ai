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
