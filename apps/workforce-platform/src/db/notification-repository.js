/**
 * MySQL/MariaDB repository for operator notifications.
 *
 * Ports the legacy anonymous `NotificationRepository` in
 * `application/models/Aegis_model.php` statement for statement, with the same
 * rules as `site-repository.js`: every value is bound, and LIMIT is coerced to a
 * bounded integer before interpolation because mysql2 does not bind it reliably.
 *
 * Visibility is the legacy rule and nothing else: a signed-in operator sees
 * broadcast rows (`user_id IS NULL`) plus their own; an unauthenticated caller
 * sees broadcasts only. `read_at` is global to the row (see migration 009).
 *
 * There is no HTTP delete and no per-row delete: notifications are operator
 * evidence. The one erasing path is `pruneNotifications`, driven only by
 * `npm run prune:retention`, and it is deliberately narrow — a row is eligible
 * only once it has been READ and is older than `NOTIFICATION_RETENTION_DAYS`.
 * An unread alert is somebody's to-do item, and an unread row is also what
 * suppresses a duplicate publish, so deleting it would lose both.
 */

import { assertIsoCutoff } from "../persistence/contract.js";
import { deleteInBatches, ISO_TEXT_LIKE, pruneReport } from "./retention.js";

function boundedLimit(value, fallback = 50, ceiling = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

function decodeDetail(raw) {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    // The legacy reader used `json_decode(...) ?: []`, so a stored `null`,
    // `false` or `0` detail also degrades to an empty object rather than
    // surfacing a scalar where callers expect a structured payload.
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Unlike an execution proposal, an unreadable notification detail must not
    // take the whole inbox down with it: the title, severity and timestamps are
    // still the operator's evidence. The raw text is dropped, never echoed.
    return {};
  }
}

function notificationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    type: String(row.type),
    severity: String(row.severity),
    title: String(row.title),
    detail: decodeDetail(row.detail_json),
    dedupe_key: row.dedupe_key ?? null,
    read_at: row.read_at ?? null,
    created_at: String(row.created_at),
  };
}

/** `(user_id IS NULL OR user_id = ?)` for a signed-in operator, `user_id IS NULL` otherwise. */
function visibility(userId) {
  return userId === null || userId === undefined
    ? { clause: "user_id IS NULL", values: [] }
    : { clause: "(user_id IS NULL OR user_id = ?)", values: [Number(userId)] };
}

export function createNotificationRepository(pool) {
  return {
    async createNotification({ userId = null, type, severity, title, detail = {}, dedupeKey = null, createdAt }) {
      const [result] = await pool.execute(
        `INSERT INTO wf_notifications
           (user_id, type, severity, title, detail_json, dedupe_key, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          userId === null || userId === undefined ? null : Number(userId),
          String(type),
          String(severity),
          String(title),
          JSON.stringify(detail ?? {}),
          dedupeKey === null || dedupeKey === undefined ? null : String(dedupeKey),
          String(createdAt),
        ],
      );
      return notificationRow({
        id: result.insertId,
        user_id: userId ?? null,
        type,
        severity,
        title,
        detail_json: JSON.stringify(detail ?? {}),
        dedupe_key: dedupeKey ?? null,
        read_at: null,
        created_at: createdAt,
      });
    },

    /** Broadcast plus the caller's own rows, newest first. */
    async listNotifications(userId = null, { unreadOnly = false, limit = 50 } = {}) {
      const scope = visibility(userId);
      const bounded = boundedLimit(limit, 50, 200);
      const [rows] = await pool.query(
        `SELECT *
           FROM wf_notifications
          WHERE ${scope.clause}${unreadOnly ? " AND read_at IS NULL" : ""}
          ORDER BY created_at DESC, id DESC
          LIMIT ${bounded}`,
        scope.values,
      );
      return rows.map(notificationRow);
    },

    /**
     * Idempotent single-row read. Returns false when the row does not exist, is
     * already read, or is not visible to this caller — the legacy repository
     * answered the same way through `affected_rows() > 0`.
     */
    async markNotificationRead(id, userId = null, readAt) {
      const scope = visibility(userId);
      const [result] = await pool.execute(
        `UPDATE wf_notifications
            SET read_at = ?
          WHERE id = ? AND read_at IS NULL AND ${scope.clause}`,
        [String(readAt), Number(id), ...scope.values],
      );
      return Number(result.affectedRows) > 0;
    },

    async markAllNotificationsRead(userId = null, readAt) {
      const scope = visibility(userId);
      const [result] = await pool.execute(
        `UPDATE wf_notifications
            SET read_at = ?
          WHERE read_at IS NULL AND ${scope.clause}`,
        [String(readAt), ...scope.values],
      );
      return Number(result.affectedRows);
    },

    async countUnreadNotifications(userId = null) {
      const scope = visibility(userId);
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS unread FROM wf_notifications WHERE read_at IS NULL AND ${scope.clause}`,
        scope.values,
      );
      return Number(rows[0]?.unread ?? 0);
    },


    /**
     * Retention for `wf_notifications` (row 5, `NOTIFICATION_RETENTION_DAYS`).
     *
     * Three conditions, all deliberate:
     *  - `read_at IS NOT NULL` — unread rows are never eligible;
     *  - `created_at < ?` — strictly older, so a row on the boundary survives;
     *  - `created_at LIKE ?` — only canonical ISO-8601 text is ever compared, so a
     *    malformed import cannot sort itself into the delete set.
     *
     * The default window is 0 (keep forever). Measurement and deletion share the
     * same predicate. Read rows are small, but `bytes` still reports the stored
     * title, detail and dedupe key so the CLI can say what was reclaimed.
     */
    async pruneNotifications(beforeIso, { dryRun = false, batchSize = 500, maxBatches = 1_000 } = {}) {
      const cutoff = assertIsoCutoff(beforeIso);
      const where = "read_at IS NOT NULL AND created_at < ? AND created_at LIKE ?";
      const values = [cutoff, ISO_TEXT_LIKE];
      const [[measured]] = await pool.execute(
        `SELECT COUNT(*) AS total,
                MIN(created_at) AS oldest,
                MAX(created_at) AS newest,
                COALESCE(SUM(LENGTH(title) + LENGTH(detail_json) + LENGTH(COALESCE(dedupe_key, ''))), 0) AS bytes
           FROM wf_notifications
          WHERE ${where}`,
        values,
      );
      const report = {
        ...pruneReport({ cutoff, dryRun }),
        matching: Number(measured?.total ?? 0),
        oldest: measured?.oldest ?? null,
        newest: measured?.newest ?? null,
        bytes: Number(measured?.bytes ?? 0),
      };
      return deleteInBatches(report, { batchSize, maxBatches }, async (batch) => {
        const [result] = await pool.query(
          `DELETE FROM wf_notifications
            WHERE ${where}
            ORDER BY created_at ASC, id ASC
            LIMIT ${batch}`,
          values,
        );
        return Number(result?.affectedRows ?? 0);
      });
    },

    /**
     * True when an UNREAD row already carries this dedupe key. Scoped exactly as
     * the legacy `hasUnreadDedupe` was — globally, not per recipient — because a
     * broadcast alert must not be re-raised per operator.
     */
    async hasUnreadNotificationDedupe(dedupeKey) {
      const [rows] = await pool.execute(
        "SELECT COUNT(*) AS matches FROM wf_notifications WHERE dedupe_key = ? AND read_at IS NULL LIMIT 1",
        [String(dedupeKey)],
      );
      return Number(rows[0]?.matches ?? 0) > 0;
    },
  };
}
