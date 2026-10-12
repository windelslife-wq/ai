/**
 * MySQL/MariaDB repository for the measured half of sports intelligence
 * (row 14, slice 5, migration 014): prediction outcomes, settled selections,
 * model-metrics snapshots and stored backtests.
 *
 * `listSportsPredictionOutcomes` is the read every measured number in the module
 * derives from — legacy's `predictionOutcomes`: a prediction joined to its match and
 * to a **VERIFIED, FINISHED** result. The join is the honesty mechanism: a prediction
 * whose result is unverified has no outcome, and nothing downstream may invent one.
 *
 * `listSportsSettledSelections` is legacy's `settledSelections`: every ticket leg
 * joined to its ticket, match and model version, with the ticket's odds, stake, P/L
 * and the leg's `_settled` flag. Legacy reads the ticket's `pnl` with one `findTicket`
 * per selection; the join carries the same column (`ticket_pnl`) so the metric code
 * needs no N+1 reads. The values are the same; the reads are fewer — recorded as a
 * port-side note, not a divergence.
 */

import {
  backtestRow,
  modelMetricsRow,
  prepareBacktest,
  prepareModelMetrics,
  predictionOutcomeRow,
  settledSelectionRow,
  toInt,
} from "../persistence/sports-rows.js";
import { assertIsoCutoff } from "../persistence/contract.js";

const BOUNDED = (limit, fallback = 200) => Math.min(5000, Math.max(1, toInt(limit, fallback)));

/** The seven methods this module adds to the shared store contract. */
export const SPORTS_ANALYTICS_METHODS = Object.freeze([
  "listSportsPredictionOutcomes",
  "listSportsSettledSelections",
  "saveSportsModelMetrics",
  "listSportsModelMetrics",
  "saveSportsBacktest",
  "findSportsBacktest",
  "listSportsBacktests",
]);

export function createSportsAnalyticsRepository(executor) {
  const repo = {
    /**
     * Predictions that have a verified finished result, with the binary outcome for
     * the market they predicted. Rows for markets the engine cannot score are excluded
     * here (never guessed downstream), matching legacy's `predictionOutcomes`.
     *
     * `modelVersionId` filters to one model version; `null` is every version, which is
     * what the calibration fit reads. The upper bound of 5000 is stated by the caller
     * via `truncated`, so a fit on a large sample knows its sample was cut.
     */
    async listSportsPredictionOutcomes(modelVersionId = null, limit = 5000) {
      const bounded = BOUNDED(limit, 5000);
      const clauses = ["r.verified = 1", "r.status = 'FINISHED'", "r.home_score IS NOT NULL", "r.away_score IS NOT NULL"];
      const params = [];
      if (modelVersionId !== null && modelVersionId !== undefined) {
        clauses.push("p.model_version_id = ?");
        params.push(toInt(modelVersionId));
      }
      const [rows] = await executor.query(
        `SELECT p.*, m.competition AS league, r.home_score, r.away_score
           FROM wf_sports_predictions p
           JOIN wf_sports_matches m ON m.id = p.match_id
           JOIN wf_sports_results r ON r.match_id = p.match_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY p.created_at ASC, p.id ASC
          LIMIT ${bounded}`,
        params,
      );
      const out = [];
      for (const row of rows ?? []) {
        const mapped = predictionOutcomeRow(row);
        if (mapped !== null) out.push(mapped);
      }
      return out;
    },

    /**
     * Every ticket leg joined to its ticket, match and model version, with `_settled`
     * naming whether the leg is terminal. Filter keys, all optional: `from` / `to`
     * (the TICKET's created_at), `market` (the leg's), `modelVersionId` (the TICKET's).
     * The same four filters legacy applies.
     */
    async listSportsSettledSelections(filter = {}, limit = 5000) {
      const f = filter && typeof filter === "object" ? filter : {};
      const clauses = [];
      const params = [];
      if (f.from !== null && f.from !== undefined && String(f.from).trim() !== "") {
        clauses.push("t.created_at >= ?");
        params.push(assertIsoCutoff(String(f.from).trim()));
      }
      if (f.to !== null && f.to !== undefined && String(f.to).trim() !== "") {
        clauses.push("t.created_at <= ?");
        params.push(assertIsoCutoff(String(f.to).trim()));
      }
      if (f.market !== null && f.market !== undefined && String(f.market).trim() !== "") {
        clauses.push("s.market = ?");
        params.push(String(f.market).slice(0, 40));
      }
      if (f.modelVersionId !== null && f.modelVersionId !== undefined) {
        clauses.push("t.model_version_id = ?");
        params.push(toInt(f.modelVersionId));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT s.*, t.total_odds AS ticket_odds, t.settlement_status AS ticket_status,
                t.stake AS ticket_stake, t.pnl AS ticket_pnl, t.created_at AS ticket_created_at,
                m.competition, m.kickoff_at, mv.model_name, mv.model_version
           FROM wf_sports_ticket_selections s
           JOIN wf_sports_tickets t ON t.id = s.ticket_id
           LEFT JOIN wf_sports_matches m ON m.id = s.match_id
           LEFT JOIN wf_sports_model_versions mv ON mv.id = t.model_version_id
           ${where}
          ORDER BY s.id ASC
          LIMIT ${BOUNDED(limit, 5000)}`,
        params,
      );
      return (rows ?? []).map(settledSelectionRow);
    },

    /** Append one measured snapshot. Append-only: history is the evidence. */
    async saveSportsModelMetrics(input) {
      const row = prepareModelMetrics(input ?? {});
      await executor.execute(
        `INSERT INTO wf_sports_model_metrics (
           model_version_id, window_days, sample_type, predictions, settled,
           accuracy, brier, ece, win_rate, roi, max_drawdown, computed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.model_version_id, row.window_days, row.sample_type, row.predictions, row.settled,
          row.accuracy, row.brier, row.ece, row.win_rate, row.roi, row.max_drawdown, row.computed_at,
        ],
      );
    },

    /** Measured snapshots, newest first. Filter keys: `modelVersionId`, `windowDays`, `sampleType`. */
    async listSportsModelMetrics(filter = {}, limit = 100) {
      const f = filter && typeof filter === "object" ? filter : {};
      const clauses = [];
      const params = [];
      if (f.modelVersionId !== null && f.modelVersionId !== undefined) {
        clauses.push("model_version_id = ?");
        params.push(toInt(f.modelVersionId));
      }
      if (f.windowDays !== null && f.windowDays !== undefined) {
        clauses.push("window_days = ?");
        params.push(toInt(f.windowDays));
      }
      if (f.sampleType !== null && f.sampleType !== undefined) {
        clauses.push("sample_type = ?");
        params.push(String(f.sampleType).slice(0, 16));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_model_metrics ${where}
          ORDER BY computed_at DESC, id DESC
          LIMIT ${BOUNDED(limit, 100)}`,
        params,
      );
      return (rows ?? []).map(modelMetricsRow);
    },

    /** Store one backtest report whole. The id was generated by the caller. */
    async saveSportsBacktest(input) {
      const row = prepareBacktest(input ?? {});
      await executor.execute(
        `INSERT INTO wf_sports_backtests (id, created_at, created_by, params, report, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, row.created_at, row.created_by, row.params, row.report, row.status],
      );
      return repo.findSportsBacktest(row.id);
    },

    async findSportsBacktest(id) {
      const backtestId = String(id ?? "");
      if (!/^bt_[0-9a-f]{16}$/.test(backtestId)) {
        throw new TypeError(`backtest id must be 'bt_' and 16 hex characters, received ${JSON.stringify(backtestId.slice(0, 40))}`);
      }
      const [rows] = await executor.query("SELECT * FROM wf_sports_backtests WHERE id = ?", [backtestId]);
      return backtestRow(rows?.[0] ?? null);
    },

    async listSportsBacktests(limit = 20) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_backtests ORDER BY created_at DESC, id DESC LIMIT ${BOUNDED(limit, 20)}`,
      );
      return (rows ?? []).map(backtestRow);
    },
  };
  return repo;
}
