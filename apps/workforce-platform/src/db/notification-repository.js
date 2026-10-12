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
 * There is no delete method. Notifications are operator evidence, and the
 * legacy application never offered a way to erase them; retention is a separate
 * decision (cf. R-27/R-28 for `wf_analysis_runs` and `wf_backtests`).
 */

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
