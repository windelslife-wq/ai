/**
 * MySQL/MariaDB repository for tickets and the daily ticket run (row 14, slice 4).
 *
 * Migration `013_sports_tickets.sql` explains the schema. This file is the only thing that
 * writes those three tables on MySQL. `src/persistence/file-store.js` implements the same
 * nine methods over the same row shapes, and `sports-rows.js` owns the validation and the
 * shapes, so the two adapters cannot disagree.
 *
 * Three rules, and why:
 *
 *  1. **A ticket is written whole or not at all.** `saveSportsTicket` inserts the ticket and
 *     its selections on one pinned connection inside a transaction. A ticket without its
 *     selections would be a combination with no legs, which is a record that says
 *     something false.
 *  2. **A decision is compare-and-set.** `decideSportsTicket` updates only a row still
 *     `PENDING_USER_APPROVAL`, and reports whether it did. A second approver therefore
 *     cannot overwrite the first, which is the same guarantee calibration decisions have
 *     (SP-28).
 *  3. **The daily run is claimed before any work.** `claimSportsDailyTicketRun` inserts
 *     the RUNNING row and relies on the UNIQUE key on (run_date, configuration_version). A
 *     second request that loses the claim gets `null`, and the service reports
 *     DUPLICATE_SKIPPED. Legacy's `startJobRun` has the same shape.
 */
import {
  assertEnum,
  assertRowId,
  assertRunDate,
  assertText,
  assertTicketId,
  dailyRunRow,
  prepareDailyRunClaim,
  prepareDailyRunFinish,
  prepareSelectionSettlement,
  prepareTicket,
  prepareTicketSettlement,
  ticketRow,
  ticketSelectionRow,
  toInt,
  TICKET_APPROVALS,
  TICKET_STATUSES,
} from "../persistence/sports-rows.js";

const BOUNDED = (limit, fallback = 50) => Math.min(500, Math.max(1, toInt(limit, fallback)));

/** Configuration versions start at 0 (the defaults), so 0 is a valid key here. */
function nonNegativeVersion(value) {
  const version = toInt(value, -1);
  if (version < 0) throw new TypeError(`configuration version must be a non-negative integer, received ${JSON.stringify(value)}`);
  return version;
}

function isDuplicateKey(error) {
  const code = error?.code;
  const sqlState = error?.sqlState;
  return code === "ER_DUP_ENTRY" || sqlState === "23000" || sqlState === "23505";
}

/** The thirteen methods this module adds to the shared store contract. */
export const SPORTS_TICKET_METHODS = Object.freeze([
  "saveSportsTicket",
  "findSportsTicket",
  "listSportsTickets",
  "listSportsTicketSelections",
  "decideSportsTicket",
  "claimSportsDailyTicketRun",
  "finishSportsDailyTicketRun",
  "findSportsDailyTicketRun",
  "listSportsDailyTicketRuns",
  // Settlement (slice 5, migration 014): the only writers of the settlement columns
  // outside the decision path, plus the R-29 recovery for a stuck run's claim.
  "updateSportsTicket",
  "updateSportsTicketSelection",
  "recordSportsTicketOutcome",
  "recoverSportsDailyTicketRuns",
]);

export function createSportsTicketRepository(executor) {
  const repo = {
    /**
     * Insert a ticket and its selections in one transaction. `built` is the output of
     * `buildTicket`. Returns the stored ticket row.
     */
    async saveSportsTicket(built) {
      const { ticket, selections } = prepareTicket(built ?? {});
      const connection = await executor.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO wf_sports_tickets (
             id, model_version_id, configuration_version, total_odds, selection_count, combined_probability,
             confidence, risk, correlation, data_quality_score, status, approval_status, settlement_status,
             stake, reason, optimization_score, pool_size, decided_by, decided_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ticket.id, ticket.model_version_id, ticket.configuration_version, ticket.total_odds,
            ticket.selection_count, ticket.combined_probability, ticket.confidence, ticket.risk,
            ticket.correlation, ticket.data_quality_score, ticket.status, ticket.approval_status,
            ticket.settlement_status, ticket.stake, ticket.reason, ticket.optimization_score,
            ticket.pool_size, ticket.decided_by, ticket.decided_at, ticket.created_at,
          ],
        );
        for (const s of selections) {
          await connection.execute(
            `INSERT INTO wf_sports_ticket_selections (
               ticket_id, prediction_id, match_id, market, selection, odds, odds_timestamp,
               model_probability, calibrated_probability, expected_value, risk, result, status,
               correlation_reasons
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              s.ticket_id, s.prediction_id, s.match_id, s.market, s.selection, s.odds, s.odds_timestamp,
              s.model_probability, s.calibrated_probability, s.expected_value, s.risk, s.result, s.status,
              s.correlation_reasons,
            ],
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
      return repo.findSportsTicket(ticket.id);
    },

    async findSportsTicket(id) {
      const [rows] = await executor.query("SELECT * FROM wf_sports_tickets WHERE id = ?", [assertTicketId(id)]);
      return ticketRow(rows[0] ?? null);
    },

    async listSportsTickets(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const clauses = [];
      const params = [];
      if (f.approvalStatus !== null && f.approvalStatus !== undefined) {
        clauses.push("approval_status = ?");
        params.push(assertEnum(f.approvalStatus, TICKET_APPROVALS, "filter.approvalStatus"));
      }
      if (f.runDate !== null && f.runDate !== undefined) {
        // Tickets carry no run date of their own: they are linked from the daily run row.
        clauses.push("id IN (SELECT ticket_id FROM wf_sports_daily_tickets WHERE run_date = ? AND ticket_id IS NOT NULL)");
        params.push(assertRunDate(f.runDate));
      }
      if (f.status !== null && f.status !== undefined) {
        // The settlement status, which settlement itself writes — the filter the
        // cron's sweep selects on, exactly as legacy's listTickets(['status' => 'PENDING']) does.
        clauses.push("status = ?");
        params.push(assertText(String(f.status).slice(0, 16), 16, "filter.status"));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_tickets ${where} ORDER BY created_at DESC, id DESC LIMIT ${BOUNDED(limit)}`,
        params,
      );
      return rows.map(ticketRow);
    },

    async listSportsTicketSelections(ticketId) {
      const [rows] = await executor.query(
        "SELECT * FROM wf_sports_ticket_selections WHERE ticket_id = ? ORDER BY id ASC",
        [assertTicketId(ticketId)],
      );
      return rows.map(ticketSelectionRow);
    },

    /**
     * Record a decision on a ticket still awaiting approval. Returns the decided row, or
     * `null` when the ticket is missing or was decided by another request first.
     */
    async decideSportsTicket(id, decision) {
      const ticketId = assertTicketId(id);
      const [result] = await executor.execute(
        `UPDATE wf_sports_tickets
            SET approval_status = ?, status = ?, reason = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND approval_status = 'PENDING_USER_APPROVAL'`,
        [
          assertEnum(decision.approvalStatus, TICKET_APPROVALS, "approval_status"),
          assertEnum(decision.status, TICKET_STATUSES, "status"),
          decision.reason === null || decision.reason === undefined ? null : String(decision.reason).slice(0, 500),
          decision.decidedBy === null || decision.decidedBy === undefined ? null : String(decision.decidedBy).slice(0, 64),
          decision.decidedAt,
          ticketId,
        ],
      );
      if (!result || result.affectedRows !== 1) return null;
      return repo.findSportsTicket(ticketId);
    },

    /**
     * Claim the run for a day and configuration version. Returns the RUNNING row, or `null`
     * when that day and version already has a run, whatever its status.
     */
    async claimSportsDailyTicketRun(input) {
      const row = prepareDailyRunClaim(input ?? {});
      try {
        await executor.execute(
          `INSERT INTO wf_sports_daily_tickets (
             run_date, configuration_version, status, ticket_id, fixtures_read, candidates_evaluated,
             predictions_recorded, rejections, simulated_refused, rejection_summary, message, errors,
             requested_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.run_date, row.configuration_version, row.status, row.ticket_id, row.fixtures_read,
            row.candidates_evaluated, row.predictions_recorded, row.rejections, row.simulated_refused,
            row.rejection_summary, row.message, row.errors, row.requested_by, row.created_at, row.updated_at,
          ],
        );
      } catch (error) {
        if (isDuplicateKey(error)) return null;
        throw error;
      }
      return repo.findSportsDailyTicketRun(row.run_date, row.configuration_version);
    },

    /**
     * Write the outcome of a claimed run. Only a RUNNING row can be finished, so a run is
     * finished once. Returns the finished row, or `null` when it was not RUNNING.
     */
    async finishSportsDailyTicketRun(id, outcome, updatedAt) {
      const runId = assertRowId(id, "daily run id");
      const patch = prepareDailyRunFinish(outcome ?? {}, updatedAt);
      const [result] = await executor.execute(
        `UPDATE wf_sports_daily_tickets
            SET status = ?, ticket_id = ?, fixtures_read = ?, candidates_evaluated = ?,
                predictions_recorded = ?, rejections = ?, simulated_refused = ?, rejection_summary = ?,
                message = ?, errors = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING'`,
        [
          patch.status, patch.ticket_id, patch.fixtures_read, patch.candidates_evaluated,
          patch.predictions_recorded, patch.rejections, patch.simulated_refused, patch.rejection_summary,
          patch.message, patch.errors, patch.updated_at, runId,
        ],
      );
      if (!result || result.affectedRows !== 1) return null;
      const [rows] = await executor.query("SELECT * FROM wf_sports_daily_tickets WHERE id = ?", [runId]);
      return dailyRunRow(rows[0] ?? null);
    },

    async findSportsDailyTicketRun(runDate, configurationVersion) {
      const [rows] = await executor.query(
        "SELECT * FROM wf_sports_daily_tickets WHERE run_date = ? AND configuration_version = ?",
        [assertRunDate(runDate), nonNegativeVersion(configurationVersion)],
      );
      return dailyRunRow(rows[0] ?? null);
    },

    async listSportsDailyTicketRuns(limit = 50) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_daily_tickets ORDER BY run_date DESC, id DESC LIMIT ${BOUNDED(limit)}`,
      );
      return rows.map(dailyRunRow);
    },

    // ── settlement (slice 5) ─────────────────────────────────────────────────
    // Four named-field writes, not arbitrary patches. Settlement is the one second
    // writer of `wf_sports_tickets`, and a patch shape that could carry
    // `approval_status` would let a settlement sweep overwrite a person's decision.

    /** Write the settlement columns of one ticket. Returns the stored row. */
    async updateSportsTicket(id, patch) {
      const ticketId = assertTicketId(id);
      const p = prepareTicketSettlement(patch ?? {});
      await executor.execute(
        `UPDATE wf_sports_tickets
            SET settlement_status = ?, status = ?, total_odds = ?, reason = ?
          WHERE id = ?`,
        [p.settlement_status, p.status, p.total_odds, p.reason, ticketId],
      );
      return repo.findSportsTicket(ticketId);
    },

    /** Write one leg's terminal status. `result` mirrors it, as legacy writes both. */
    async updateSportsTicketSelection(id, patch) {
      const selectionId = assertRowId(id, "selection id");
      const p = prepareSelectionSettlement(patch ?? {});
      await executor.execute(
        `UPDATE wf_sports_ticket_selections SET status = ?, result = ? WHERE id = ?`,
        [p.status, p.result, selectionId],
      );
      const [rows] = await executor.query("SELECT * FROM wf_sports_ticket_selections WHERE id = ?", [selectionId]);
      return ticketSelectionRow(rows?.[0] ?? null);
    },

    /** Store the settled P/L on the ticket. Legacy's `recordTicketOutcome`. */
    async recordSportsTicketOutcome(id, pnl) {
      const ticketId = assertTicketId(id);
      const value = Number(pnl);
      if (!Number.isFinite(value)) throw new TypeError(`pnl must be a finite number, received ${JSON.stringify(pnl)}`);
      await executor.execute(`UPDATE wf_sports_tickets SET pnl = ? WHERE id = ?`, [Number(value.toFixed(4)), ticketId]);
      return repo.findSportsTicket(ticketId);
    },

    /**
     * Release the stuck-run claim (R-29): delete every RUNNING row for a day, returning
     * the rows that were actually removed. A finished run is evidence and cannot match;
     * a run that finishes between the read and the delete is left standing by the CAS.
     */
    async recoverSportsDailyTicketRuns(runDate) {
      const date = assertRunDate(runDate);
      const [stuck] = await executor.query(
        "SELECT * FROM wf_sports_daily_tickets WHERE run_date = ? AND status = 'RUNNING' ORDER BY id ASC",
        [date],
      );
      const removed = [];
      for (const row of stuck ?? []) {
        const [result] = await executor.execute(
          "DELETE FROM wf_sports_daily_tickets WHERE id = ? AND status = 'RUNNING'",
          [assertRowId(row.id, "daily run id")],
        );
        if (result && result.affectedRows === 1) removed.push(dailyRunRow(row));
      }
      return removed;
    },
  };
  return repo;
}
