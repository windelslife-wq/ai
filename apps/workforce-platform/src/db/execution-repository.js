/**
 * MySQL/MariaDB repository for the paper-only execution proposal workflow.
 *
 * Every lookup binds both proposal id and owner id, and joins the account owner
 * as a second boundary. Decisions and paper-route claims are compare-and-set
 * updates so a proposal cannot be decided or submitted twice across workers.
 * This repository deliberately has no broker-order or live-execution method.
 */

function boundedLimit(value, fallback = 100, ceiling = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

function decodeJson(raw, fallback, label) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`The persisted execution proposal ${label} is unreadable`);
    error.statusCode = 500;
    throw error;
  }
}

function proposalRow(row) {
  if (!row) return null;
  return {
    id: String(row.proposal_id),
    owner_user_id: Number(row.owner_user_id),
    account_id: Number(row.account_id),
    status: String(row.status),
    intent: decodeJson(row.intent_json, {}, "intent"),
    checks: decodeJson(row.checks_json, [], "checks"),
    result: decodeJson(row.result_json, null, "result"),
    decision_by_user_id: row.decision_by_user_id === null || row.decision_by_user_id === undefined ? null : Number(row.decision_by_user_id),
    decision_reason: row.decision_reason ?? null,
    decided_at: row.decided_at ?? null,
    paper_order_id: row.paper_order_id === null || row.paper_order_id === undefined ? null : Number(row.paper_order_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function createExecutionRepository(executor) {
  return {
    async createExecutionProposal(record) {
      await executor.execute(
        `INSERT INTO wf_execution_proposals
           (proposal_id, owner_user_id, account_id, status, intent_json, checks_json,
            result_json, decision_by_user_id, decision_reason, decided_at, paper_order_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        [
          String(record.id), Number(record.owner_user_id), Number(record.account_id), String(record.status),
          JSON.stringify(record.intent), JSON.stringify(record.checks),
          record.result === null || record.result === undefined ? null : JSON.stringify(record.result),
          String(record.created_at), String(record.updated_at),
        ],
      );
      return this.findExecutionProposal(record.id, record.owner_user_id);
    },

    async findExecutionProposal(id, ownerUserId) {
      const [rows] = await executor.execute(
        `SELECT p.*
           FROM wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
          WHERE p.proposal_id = ? AND p.owner_user_id = ? AND a.owner_user_id = ?
          LIMIT 1`,
        [String(id), Number(ownerUserId), Number(ownerUserId)],
      );
      return proposalRow(rows[0] || null);
    },

    async listExecutionProposals(ownerUserId, { status = null, limit = 100 } = {}) {
      const clauses = ["p.owner_user_id = ?", "a.owner_user_id = ?"];
      const values = [Number(ownerUserId), Number(ownerUserId)];
      if (status) {
        clauses.push("p.status = ?");
        values.push(String(status));
      }
      const bounded = boundedLimit(limit, 100, 500);
      const [rows] = await executor.query(
        `SELECT p.*
           FROM wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY p.created_at DESC, p.proposal_id DESC
          LIMIT ${bounded}`,
        values,
      );
      return rows.map(proposalRow);
    },

    /** Close an unreviewed proposal after its fixed four-hour approval window. */
    async expireExecutionProposal(id, ownerUserId, updatedAt) {
      const [result] = await executor.execute(
        `UPDATE wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
            SET p.status = 'EXPIRED', p.updated_at = ?
          WHERE p.proposal_id = ? AND p.owner_user_id = ? AND a.owner_user_id = ?
            AND p.status = 'PENDING_APPROVAL'`,
        [String(updatedAt), String(id), Number(ownerUserId), Number(ownerUserId)],
      );
      return Number(result.affectedRows) === 1;
    },

    /**
     * Every pending proposal across **all** owners, for the scheduled expiry job.
     *
     * This is a separate method rather than `listExecutionProposals(null)`. Passing
     * `null` here would bind `Number(null)` — zero — and silently match nothing, so
     * "all owners" had to be spelled out; and widening the owner-scoped method to
     * treat a missing owner as "no filter" would turn one forgotten argument at an
     * HTTP call site into a platform-wide read of every operator's proposals. The
     * same reasoning as divergence AV-1's read of `userId: null` in Phase 10: an
     * existing "do not filter" sentinel is a trap, so a privileged scope gets its
     * own name that cannot be reached by accident.
     *
     * There is deliberately **no** matching all-owners write method. Expiry stays
     * on the existing owner-bound transactional path (`expireExecutionProposal`
     * inside `withPaperTransaction`), which the scheduled job reaches by reading
     * each proposal's owner off the row it just listed. Keeping the write
     * owner-bound is what preserves the account-revision invariant, the
     * `PROPOSAL_EXPIRED` notification and the audit event — and it keeps this
     * store's public execution contract read-only, as it has been since Phase 8A.
     *
     * The staleness cutoff is deliberately NOT pushed into SQL. The platform rule
     * (`isProposalStale`) treats an **unparseable** `created_at` as stale, and a
     * VARCHAR `created_at <= ?` comparison would instead sort garbage like
     * `not-a-date` *after* a real instant and exclude it — so SQL and the file
     * adapter would disagree about exactly the malformed rows that most need
     * expiring. The predicate stays in the job layer, where both adapters run the
     * same code. Recorded as divergence SJ-2.
     */
    async listExecutionProposalsAllOwners({ status = null, limit = 100 } = {}) {
      const clauses = [];
      const values = [];
      if (status) {
        clauses.push("p.status = ?");
        values.push(String(status));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const bounded = boundedLimit(limit, 100, 500);
      const [rows] = await executor.query(
        `SELECT p.*
           FROM wf_execution_proposals p
           ${where}
          ORDER BY p.created_at ASC, p.proposal_id ASC
          LIMIT ${bounded}`,
        values,
      );
      return rows.map(proposalRow);
    },

    /** One-time owner-bound human decision; false means the state already moved. */
    async decideExecutionProposal(id, ownerUserId, { status, decisionByUserId, reason, decidedAt, updatedAt }) {
      const [result] = await executor.execute(
        `UPDATE wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
            SET p.status = ?, p.decision_by_user_id = ?, p.decision_reason = ?,
                p.decided_at = ?, p.updated_at = ?
          WHERE p.proposal_id = ? AND p.owner_user_id = ? AND a.owner_user_id = ?
            AND p.status = 'PENDING_APPROVAL'`,
        [String(status), Number(decisionByUserId), String(reason), String(decidedAt), String(updatedAt), String(id), Number(ownerUserId), Number(ownerUserId)],
      );
      return Number(result.affectedRows) === 1;
    },

    /** Atomically reserve an approved proposal for one paper submission attempt. */
    async claimExecutionProposal(id, ownerUserId, updatedAt) {
      const [result] = await executor.execute(
        `UPDATE wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
            SET p.status = 'PAPER_SUBMITTING', p.updated_at = ?
          WHERE p.proposal_id = ? AND p.owner_user_id = ? AND a.owner_user_id = ?
            AND p.status = 'APPROVED'`,
        [String(updatedAt), String(id), Number(ownerUserId), Number(ownerUserId)],
      );
      return Number(result.affectedRows) === 1;
    },

    /** Finalize only the submission attempt which successfully claimed the row. */
    async completeExecutionProposal(id, ownerUserId, { status, paperOrderId = null, result: outcome = null, updatedAt }) {
      const [update] = await executor.execute(
        `UPDATE wf_execution_proposals p
           JOIN wf_paper_accounts a ON a.id = p.account_id
            SET p.status = ?, p.paper_order_id = ?, p.result_json = ?, p.updated_at = ?
          WHERE p.proposal_id = ? AND p.owner_user_id = ? AND a.owner_user_id = ?
            AND p.status = 'PAPER_SUBMITTING'`,
        [String(status), paperOrderId === null ? null : Number(paperOrderId), outcome === null ? null : JSON.stringify(outcome), String(updatedAt), String(id), Number(ownerUserId), Number(ownerUserId)],
      );
      if (Number(update.affectedRows) !== 1) return null;
      return this.findExecutionProposal(id, ownerUserId);
    },
  };
}
