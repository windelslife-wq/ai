/**
 * Operator notification routes.
 *
 * Ports the three legacy JSON endpoints behind `application/config/routes.php`
 * lines 212–214 (`api/notifications`, `api/notifications/read-all`,
 * `api/notifications/(:any)/read`) served by `Api_system`.
 *
 * Every route requires the `system.authenticated` baseline permission, exactly as
 * the legacy controller did — an operator's own unread alerts are not a
 * privileged surface, and there is deliberately no route here that can *publish*
 * a notification over HTTP. Publishing stays internal to the platform, so no
 * caller can inject an alert that looks like it came from the risk engine.
 *
 * The legacy server-rendered console (`/notifications`,
 * `views/notifications/index.php`) is not ported here; it belongs to the
 * shared-app-shell workstream (row 3 of UNFINISHED_MODULES.md).
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { createNotificationService } from "./service.js";
import { EMPTY_BODY, INBOX_QUERY, NOTIFICATION_PARAMS } from "./contracts.js";

export function notificationRoutes(app, { store, config, service = null, log = app.log }) {
  const notifications = service || createNotificationService({ store, log });
  const authenticate = createAuthenticator({ store, config });
  const guard = requirePermission("system.authenticated", config);
  guard.permission = "system.authenticated";
  const member = [authenticate, guard];
  const actorOf = (request) => request.auth?.user?.id ?? null;

  app.get("/notifications", { preHandler: member, querySchema: INBOX_QUERY }, async (request) => notifications.inbox(actorOf(request), request.query));

  app.post("/notifications/:notificationId/read", {
    preHandler: member,
    paramsSchema: NOTIFICATION_PARAMS,
    bodySchema: EMPTY_BODY,
  }, async (request) => {
    // The legacy endpoint answered 404 for a row that did not exist, was already
    // read, or belonged to someone else — one indistinguishable answer, so this
    // route cannot be used to discover which notification ids exist.
    const read = await notifications.markRead(request.params.notificationId, actorOf(request));
    if (!read) throw AppError.notFound("notification not found or already read", { code: "NOTIFICATION_NOT_FOUND" });
    return { ok: true };
  });

  app.post("/notifications/read-all", {
    preHandler: member,
    bodySchema: EMPTY_BODY,
  }, async (request) => ({ ok: true, markedRead: await notifications.markAllRead(actorOf(request)) }));
}
