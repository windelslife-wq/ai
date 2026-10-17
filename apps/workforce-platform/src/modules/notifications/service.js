/**
 * Operator notifications (row 5 of `docs/migration/UNFINISHED_MODULES.md`).
 *
 * Ports `application/libraries/Aegis/Notifications/Notifier.php` and the
 * `NotificationRepository` implementation in `application/models/Aegis_model.php`.
 *
 * Two rules carry over unchanged because they are the module's whole behaviour:
 *
 *  - **Dedupe.** While an UNREAD notification with a dedupe key exists, a new
 *    publish with that key is skipped. A recurring risk alert therefore produces
 *    one unread badge until an operator acknowledges it, not one per scan.
 *  - **Broadcast.** A notification with no recipient (`userId: null`) is visible
 *    to every signed-in operator; a targeted one is visible only to its owner
 *    plus everyone reading broadcasts.
 *
 * A notification is evidence about something that already happened. Nothing here
 * can place an order, release the kill switch or change a trading mode, and no
 * publisher in this module is allowed to make a governance decision depend on a
 * notification having been delivered.
 */

import { AppError } from "../../http/errors.js";
import { NOTIFICATION_SEVERITIES, NOTIFICATION_TYPES } from "./contracts.js";

/** Legacy `title VARCHAR(200)`, truncated by `mb_substr` rather than rejected. */
const TITLE_MAX = 200;
/** Legacy `dedupe_key VARCHAR(120)`. */
const DEDUPE_KEY_MAX = 120;
/** Legacy `type VARCHAR(40)`. */
const TYPE_MAX = 40;
/**
 * `detail` is a LONGTEXT column with no legacy bound at all. The bound here is a
 * Node-side addition (divergence NV-1): an unbounded JSON payload attached to a
 * broadcast row is stored once per alert and read back into every operator's
 * inbox, so it is bounded instead of trusted.
 */
const DETAIL_MAX_BYTES = 16_384;
const DETAIL_MAX_DEPTH = 4;
const DETAIL_MAX_ENTRIES = 60;
const INBOX_DEFAULT_LIMIT = 50;
const INBOX_MAX_LIMIT = 200;

function actorIdOf(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.unauthorized("An authenticated user is required", { code: "AUTH_REQUIRED" });
  }
  return id;
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function normalizeType(type) {
  const value = String(type ?? "").trim().toUpperCase();
  if (!value) throw AppError.badRequest("A notification type is required", { code: "INVALID_NOTIFICATION_TYPE" });
  if (value.length > TYPE_MAX) throw AppError.badRequest(`type must be at most ${TYPE_MAX} characters`, { code: "INVALID_NOTIFICATION_TYPE" });
  if (!NOTIFICATION_TYPES.includes(value)) {
    throw AppError.badRequest(`type must be one of: ${NOTIFICATION_TYPES.join(", ")}`, {
      code: "INVALID_NOTIFICATION_TYPE",
      details: { allowed: [...NOTIFICATION_TYPES] },
    });
  }
  return value;
}

/** The legacy repository coerced an unknown severity to `info` instead of failing. */
function normalizeSeverity(severity) {
  const value = String(severity ?? "info").trim().toLowerCase();
  return NOTIFICATION_SEVERITIES.includes(value) ? value : "info";
}

function normalizeTitle(title) {
  const value = String(title ?? "").trim().replace(/\s+/g, " ");
  if (!value) throw AppError.badRequest("A notification title is required", { code: "INVALID_NOTIFICATION_TITLE" });
  // `Array.from` so the cap counts code points, matching `mb_substr` rather than
  // cutting a surrogate pair in half.
  return Array.from(value).slice(0, TITLE_MAX).join("");
}

function normalizeDedupeKey(dedupeKey) {
  if (dedupeKey === null || dedupeKey === undefined) return null;
  const value = String(dedupeKey).trim();
  if (!value) return null;
  if (value.length > DEDUPE_KEY_MAX) {
    throw AppError.badRequest(`dedupeKey must be at most ${DEDUPE_KEY_MAX} characters`, { code: "INVALID_DEDUPE_KEY" });
  }
  return value;
}

/**
 * Copies only JSON-native values out of a caller's payload, to a bounded depth
 * and size. Functions, symbols, class instances with getters and circular
 * references are dropped rather than throwing on `JSON.stringify`, and anything
 * that does not fit is replaced by a truncation marker that says so — a detail
 * object that silently lost fields would be worse than one that admits it.
 */
function sanitizeDetail(detail, { maxBytes = DETAIL_MAX_BYTES, maxDepth = DETAIL_MAX_DEPTH, maxEntries = DETAIL_MAX_ENTRIES } = {}) {
  let truncated = false;
  let entries = 0;

  function walk(value, depth) {
    if (value === null || value === undefined) return null;
    const kind = typeof value;
    if (kind === "string") return value;
    if (kind === "number") return Number.isFinite(value) ? value : null;
    if (kind === "boolean") return value;
    if (kind === "bigint") return value.toString();
    if (kind !== "object") return null;
    if (depth >= maxDepth) {
      truncated = true;
      return "[truncated: nested deeper than the notification detail limit]";
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        entries += 1;
        if (entries > maxEntries) {
          truncated = true;
          out.push("[truncated: too many entries]");
          break;
        }
        out.push(walk(item, depth + 1));
      }
      return out;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      entries += 1;
      if (entries > maxEntries) {
        truncated = true;
        out[key] = "[truncated: too many entries]";
        break;
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  }

  const source = detail && typeof detail === "object" ? detail : {};
  const result = walk(source, 0);
  const payload = result && typeof result === "object" ? result : {};
  // Depth and entry caps alone cannot bound the serialized size: one long string
  // fits inside both. The final check is on the bytes that will actually be stored.
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes) {
    return { detail: { truncated: true, reason: `detail exceeded ${maxBytes} bytes and was not stored` }, truncated: true };
  }
  if (truncated) return { detail: { ...payload, truncated: true }, truncated: true };
  return { detail: payload, truncated: false };
}

/** The API shape: camelCase, like every other ported Node module. */
function notificationView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    broadcast: row.user_id === null || row.user_id === undefined,
    type: String(row.type),
    severity: String(row.severity),
    title: String(row.title),
    detail: row.detail && typeof row.detail === "object" ? structuredClone(row.detail) : {},
    dedupeKey: row.dedupe_key ?? null,
    readAt: row.read_at ?? null,
    unread: row.read_at === null || row.read_at === undefined,
    createdAt: String(row.created_at),
  };
}

export function createNotificationService({ store = null, log = null, now = () => Date.now() } = {}) {
  function requireStore() {
    if (
      !store
      || typeof store.createNotification !== "function"
      || typeof store.listNotifications !== "function"
      || typeof store.countUnreadNotifications !== "function"
    ) {
      throw AppError.unavailable("Notifications require a configured persistence adapter", {
        code: "NOTIFICATION_STORE_UNAVAILABLE",
        retryAfter: 30,
      });
    }
  }

  /**
   * Publish one notification. Returns `{ created: false, deduped: true }` when an
   * unread row already carries the same dedupe key, exactly as the legacy
   * `Notifier::notify()` did.
   *
   * Never throws for a storage failure the caller cannot act on: publishers are
   * governance code, and losing an alert must not roll back the decision that
   * caused it. A failed write is logged and reported as `created: false`.
   */
  async function notify(type, severity, title, detail = {}, dedupeKey = null, userId = null) {
    requireStore();
    const normalizedType = normalizeType(type);
    const normalizedTitle = normalizeTitle(title);
    const normalizedDedupeKey = normalizeDedupeKey(dedupeKey);
    const recipient = userId === null || userId === undefined ? null : actorIdOf(userId);
    const { detail: safeDetail, truncated } = sanitizeDetail(detail);

    if (normalizedDedupeKey !== null && await store.hasUnreadNotificationDedupe(normalizedDedupeKey)) {
      return { created: false, deduped: true, notification: null };
    }

    const createdAt = isoNow(now);
    try {
      const saved = await store.createNotification({
        userId: recipient,
        type: normalizedType,
        severity: normalizeSeverity(severity),
        title: normalizedTitle,
        detail: safeDetail,
        dedupeKey: normalizedDedupeKey,
        createdAt,
      });
      return { created: true, deduped: false, truncated, notification: notificationView(saved) };
    } catch (error) {
      // Reported honestly rather than swallowed: the caller sees `created: false`
      // with the reason, and the log keeps the detail.
      log?.error?.({ err: error, notificationType: normalizedType }, "Failed to persist an operator notification");
      return {
        created: false,
        deduped: false,
        notification: null,
        error: {
          code: "NOTIFICATION_PERSISTENCE_FAILED",
          message: "The notification was not stored; the action that triggered it still completed",
        },
      };
    }
  }

  /** The inbox: unread count plus a page of visible notifications, newest first. */
  async function inbox(userId = null, { unread = null, unreadOnly = null, limit = INBOX_DEFAULT_LIMIT, severity = null, type = null } = {}) {
    requireStore();
    const reader = userId === null || userId === undefined ? null : actorIdOf(userId);
    const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || INBOX_DEFAULT_LIMIT, 1), INBOX_MAX_LIMIT);
    // The route query key is `unread` — the legacy parameter name, which
    // `Api_system::notifications()` read as `$this->input->get('unread') === '1'`.
    // `unreadOnly` is accepted too so a service caller can use the internal
    // vocabulary without silently getting an unfiltered page.
    const wantUnread = Boolean(unread ?? unreadOnly);
    // The unread badge counts everything visible, independent of the page filters,
    // matching the legacy `inbox()` which always reported `repo->unreadCount()`.
    const unreadCount = await store.countUnreadNotifications(reader);
    const rows = await store.listNotifications(reader, { unreadOnly: wantUnread, limit: bounded });
    const wantedSeverity = severity === null || severity === undefined ? null : normalizeSeverity(severity);
    const wantedType = type === null || type === undefined ? null : String(type).trim().toUpperCase();
    const notifications = rows
      .filter((row) => (wantedSeverity ? row.severity === wantedSeverity : true))
      .filter((row) => (wantedType ? String(row.type).toUpperCase() === wantedType : true))
      .map(notificationView);
    return {
      unread: unreadCount,
      notifications,
      returned: notifications.length,
      limit: bounded,
      unreadOnly: wantUnread,
      ...(wantedSeverity ? { severity: wantedSeverity } : {}),
      ...(wantedType ? { type: wantedType } : {}),
    };
  }

  /**
   * Mark one notification read. Returns `false` — which the route turns into a
   * 404 — when the row does not exist, is already read, or is not visible to this
   * caller, exactly as `affected_rows() > 0` did in the legacy repository.
   */
  async function markRead(notificationId, userId = null) {
    requireStore();
    const reader = actorIdOf(userId);
    const id = Number(notificationId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw AppError.badRequest("notificationId must be a positive integer", { code: "INVALID_NOTIFICATION_ID" });
    }
    const readAt = isoNow(now);
    const updated = await store.markNotificationRead(id, reader, readAt);
    if (updated) {
      await store.recordAudit({
        actorId: reader,
        action: "notification.read",
        entityType: "notification",
        entityId: String(id),
        details: { notificationId: id, readAt },
      });
    }
    return updated;
  }

  /** Mark every visible unread notification read; returns how many changed. */
  async function markAllRead(userId = null) {
    requireStore();
    const reader = actorIdOf(userId);
    const readAt = isoNow(now);
    const markedRead = await store.markAllNotificationsRead(reader, readAt);
    if (markedRead > 0) {
      await store.recordAudit({
        actorId: reader,
        action: "notification.read-all",
        entityType: "notification",
        entityId: null,
        details: { markedRead, readAt },
      });
    }
    return markedRead;
  }

  /** What `/api/v1/system/status` and `/system/features` report about this module. */
  function statusSnapshot() {
    return {
      available: true,
      storeConfigured: Boolean(store && typeof store.createNotification === "function"),
      types: [...NOTIFICATION_TYPES],
      severities: [...NOTIFICATION_SEVERITIES],
      dedupe: "An unread notification suppresses a new publish with the same dedupe key",
      broadcast: "A notification with no recipient is visible to every signed-in operator",
      readStateScope: "global",
      deliveryChannels: [],
      emailDeliveryAvailable: false,
      // True whether or not SMTP is configured: the mail transport ported in row 5
      // serves the administrator test send and the contact-form copy. No publisher
      // in this module is wired to it, so no alert is ever emailed.
      reason: "Notifications are stored and read in-product only. Outbound SMTP, when configured, is used only by the administrator test send and the contact-form copy, so nothing here claims to have delivered an alert to a device or an inbox.",
    };
  }

  return Object.freeze({
    notify,
    inbox,
    markRead,
    markAllRead,
    statusSnapshot,
    // Exported so the parity tests and future publishers share one vocabulary.
    types: NOTIFICATION_TYPES,
    severities: NOTIFICATION_SEVERITIES,
  });
}
