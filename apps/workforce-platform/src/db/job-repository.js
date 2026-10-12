/**
 * MySQL/MariaDB repository for scheduled-job coordination locks (row 19).
 *
 * Migration `010_job_locks.sql` explains why this is a table rather than MySQL
 * `GET_LOCK()`. What follows is the acquisition protocol, which is the part that
 * has to be right:
 *
 *   1. Try to **take over an expired lock** with a conditional UPDATE
 *      (`WHERE job_name = ? AND expires_at <= ?`).
 *   2. If that affected no row, try to **INSERT**. The primary key is the arbiter:
 *      two concurrent acquirers with no existing row both reach the INSERT and
 *      exactly one loses with `ER_DUP_ENTRY`.
 *   3. Either way, **read the row back and confirm the holder is us** before
 *      reporting success.
 *
 * Step 3 is not decoration. MySQL reports `affectedRows` as *changed* rows, so an
 * UPDATE that matches a row but writes identical values reports 0 — and more
 * importantly, a read-back is the only check that cannot be fooled by a lost race
 * between statements. A lock that reports "acquired" while another process holds
 * it is worse than no lock at all, because the job then believes it is alone.
 *
 * Release is **holder-scoped**: `WHERE job_name = ? AND holder = ?`. A process
 * whose lock expired and was taken over by the next cron run must not delete the
 * new holder's row on its way out — that would silently unlock a job that is
 * legitimately still running.
 */

import { assertJobLockHolder, assertJobLockInstant, assertJobName } from "../persistence/contract.js";

/** Duplicate-key detection, matching the platform's existing convention. */
function isDuplicateKey(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const sqlState = String(error?.sqlState ?? error?.sqlstate ?? "");
  return code === "ER_DUP_ENTRY" || sqlState === "23000" || sqlState === "23505";
}

function lockRow(row) {
  if (!row) return null;
  return {
    jobName: String(row.job_name),
    holder: String(row.holder),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
  };
}

/**
 * The state key holding the portfolio-risk monitor's transition memory.
 *
 * Legacy stored this inside the *same* platform-state blob as `tradingMode` and
 * `killSwitch` (`PortfolioRiskMonitor::recordTransitions` wrote
 * `$state['portfolioRisk']` and saved the whole document). This port keeps the same
 * table but a **different `state_key`**, so a cron run can never rewrite the
 * governance row: `wf_trading_state.state_key` is the primary key and
 * `loadTradingState` reads only `'global'`, so the two documents cannot see or
 * clobber each other. A job that overwrote the kill switch while an operator was
 * changing it would be a governance incident, and the separation is what makes that
 * structurally impossible. Recorded as divergence SJ-4.
 */
export const PORTFOLIO_RISK_STATE_KEY = "portfolio-risk";

/** `wf_trading_state.state_key` is VARCHAR(24), so a job state key is bounded. */
function assertStateKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9._-]{0,23}$/.test(key)) {
    throw new TypeError(`job state key must be 1-24 characters of [a-z0-9._-] starting with a letter, received ${JSON.stringify(String(value).slice(0, 40))}`);
  }
  // Refusing the governance key outright: nothing in this repository may write the
  // trading state, which is what keeps the separation above true by construction
  // rather than by convention.
  if (key === "global") {
    throw new TypeError(`"${key}" is the trading-governance state key and is not writable through the job repository`);
  }
  return key;
}

export function createJobRepository(executor) {
  return {
    /**
     * Load a job's persisted state document, or `null` if it has never run.
     *
     * An unreadable document is returned as `null` rather than thrown: the caller
     * (the portfolio-risk monitor) treats "no previous alert keys" as "every alert
     * is new", which re-notifies once and then re-establishes the baseline. Losing
     * the memory is self-healing; refusing to scan is not.
     */
    async loadJobState(stateKey) {
      const [rows] = await executor.execute(
        `SELECT state_json, updated_at
           FROM wf_trading_state
          WHERE state_key = ?
          LIMIT 1`,
        [assertStateKey(stateKey)],
      );
      const row = rows?.[0];
      if (!row) return null;
      let parsed = null;
      try {
        parsed = JSON.parse(row.state_json);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return { ...parsed, updatedAt: row.updated_at };
    },

    /**
     * Persist a job's state document under its own key.
     *
     * `updated_by_user_id` is left NULL: this row is written by a scheduled job
     * running as the system actor, and Phase 10's audit attribution reports a NULL
     * actor as `kind: "system"` rather than borrowing an operator's identity.
     */
    async saveJobState(stateKey, state, { updatedAt = new Date().toISOString() } = {}) {
      const key = assertStateKey(stateKey);
      const { updatedAt: _ignored, ...stateJson } = state && typeof state === "object" ? state : {};
      await executor.execute(
        `INSERT INTO wf_trading_state (state_key, state_json, updated_by_user_id, updated_at)
         VALUES (?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE
           state_json = VALUES(state_json),
           updated_by_user_id = NULL,
           updated_at = VALUES(updated_at)`,
        [key, JSON.stringify(stateJson), String(updatedAt)],
      );
      return { ...stateJson, updatedAt: String(updatedAt) };
    },

    /**
     * Read one lock, or `null` when the job has never run.
     *
     * Deliberately exposes **expired** locks too: whether a lock is live is a
     * question about `expires_at` and the current instant, and answering it here
     * would bake a second clock into the storage layer. Callers compare.
     */
    async findJobLock(jobName) {
      const [rows] = await executor.query(
        `SELECT job_name, holder, acquired_at, expires_at
           FROM wf_job_locks
          WHERE job_name = ?
          LIMIT 1`,
        [assertJobName(jobName)],
      );
      return lockRow(rows?.[0] ?? null);
    },

    /**
     * Every lock row, for the operator question "what is holding what".
     * Bounded: this table has one row per named job, so it cannot grow without a
     * code change adding a job.
     */
    async listJobLocks(limit = 100) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      const [rows] = await executor.query(
        `SELECT job_name, holder, acquired_at, expires_at
           FROM wf_job_locks
          ORDER BY job_name ASC
          LIMIT ${bounded}`,
      );
      return rows.map(lockRow);
    },

    /**
     * Attempt to acquire `jobName` for `holder` until `expiresAt`.
     *
     * @param {string} jobName
     * @param {{holder: string, nowIso: string, expiresAt: string}} options
     *   Both instants are canonical UTC (`…Z`) and are compared as strings, which
     *   is chronologically correct for a fixed-width canonical instant and cannot
     *   be reordered by the connection's `time_zone`.
     * @returns {Promise<{acquired: boolean, lock: object|null, reason: string}>}
     *   Never throws for "someone else holds it" — that is an expected outcome and
     *   the caller reports it. `reason` is always populated so a skipped run says
     *   why in the cron log instead of looking like a no-op.
     */
    async acquireJobLock(jobName, { holder, nowIso, expiresAt }) {
      const name = assertJobName(jobName);
      const owner = assertJobLockHolder(holder);
      // Both instants go through the shared validators, so a `+01:00` offset is
      // refused rather than compared as text against `…Z` rows — see
      // `assertJobLockInstant` for why that would break mutual exclusion.
      const now = assertJobLockInstant(nowIso, "nowIso");
      const expiry = assertJobLockInstant(expiresAt, "expiresAt");
      if (expiry <= now) {
        throw new TypeError("a lock must expire after the instant it is acquired at");
      }

      // 1. Take over an expired lock, if any.
      const [stolen] = await executor.execute(
        `UPDATE wf_job_locks
            SET holder = ?, acquired_at = ?, expires_at = ?
          WHERE job_name = ? AND expires_at <= ?`,
        [owner, now, expiry, name, now],
      );
      const stole = Number(stolen?.affectedRows ?? 0) === 1;

      if (!stole) {
        // 2. No expired row to take: try to create one. The primary key decides.
        try {
          await executor.execute(
            `INSERT INTO wf_job_locks (job_name, holder, acquired_at, expires_at)
             VALUES (?, ?, ?, ?)`,
            [name, owner, now, expiry],
          );
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          // A live holder got there first. Read it so the log can name who.
          const existing = await this.findJobLock(name);
          return {
            acquired: false,
            lock: existing,
            reason: existing
              ? `held by ${existing.holder} until ${existing.expiresAt}`
              : "held by another process",
          };
        }
      }

      // 3. Confirm we are the holder. This is what makes the result trustworthy
      //    rather than inferred from an affected-row count.
      const lock = await this.findJobLock(name);
      if (!lock || lock.holder !== owner) {
        return {
          acquired: false,
          lock,
          reason: lock ? `held by ${lock.holder} until ${lock.expiresAt}` : "the lock row vanished before it could be confirmed",
        };
      }
      return { acquired: true, lock, reason: stole ? "took over an expired lock" : "acquired" };
    },

    /**
     * Release a lock, but only one's own.
     *
     * @returns {Promise<boolean>} `false` when the row is gone or belongs to
     *   someone else — both mean "do not proceed as though you still hold it", and
     *   the caller reports it rather than treating it as success.
     */
    async releaseJobLock(jobName, holder) {
      const [result] = await executor.execute(
        `DELETE FROM wf_job_locks WHERE job_name = ? AND holder = ?`,
        [assertJobName(jobName), assertJobLockHolder(holder)],
      );
      return Number(result?.affectedRows ?? 0) === 1;
    },

    /**
     * Extend a held lock's expiry, for a job that is making progress through
     * batches and must not be taken over mid-run.
     *
     * Holder-scoped for the same reason as release: extending someone else's lock
     * would be indistinguishable from stealing it.
     *
     * @returns {Promise<boolean>} `false` when the lock is no longer ours, which
     *   the caller must treat as "stop working" — another run has taken over.
     */
    async extendJobLock(jobName, holder, expiresAt) {
      const [result] = await executor.execute(
        `UPDATE wf_job_locks SET expires_at = ? WHERE job_name = ? AND holder = ?`,
        [assertJobLockInstant(expiresAt, "expiresAt"), assertJobName(jobName), assertJobLockHolder(holder)],
      );
      return Number(result?.affectedRows ?? 0) === 1;
    },
  };
}
