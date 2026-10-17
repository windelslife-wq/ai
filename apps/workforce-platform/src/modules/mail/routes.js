/**
 * The administrator mail surface (row 5).
 *
 * Two routes, both `system.super_admin` only, which is what guarded the legacy
 * panel (`Admin::requireAdmin()`). There is no route that changes the SMTP
 * configuration: it lives in the server environment, exactly as
 * `Aegis\Mailer` required, and a web form that can rewrite credentials is a
 * liability the legacy application never shipped.
 *
 *  - `GET  /api/v1/admin/mail`      — the credential-free `configSummary()` the
 *    panel renders, plus whether the platform can send at all.
 *  - `POST /api/v1/admin/mail/test` — the legacy test send, audited as
 *    `ADMIN_TEST_EMAIL` with `{to, ok}` exactly as `Admin::test_email` emitted it.
 *
 * A refused send is a successful request: `{ok: false, message}` with status 200.
 * The message is the legacy sentence, and a person reads it in the panel. A 4xx
 * would tell the browser the form was malformed when the server, or its
 * configuration, is what refused.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { INVALID_RECIPIENT_MESSAGE, TEST_EMAIL_BODY } from "./contracts.js";

export function mailRoutes(app, { store, config, mail }) {
  const authenticate = createAuthenticator({ store, config });
  const superAdminOnly = requirePermission("system.super_admin", config);
  superAdminOnly.permission = "system.super_admin";

  app.get("/admin/mail", { preHandler: [authenticate, superAdminOnly] }, async () => {
    const summary = mail.configSummary();
    return {
      summary,
      transport: summary.enabled ? "smtp" : "none",
      // The one sentence a reader needs when nothing is configured. It names the
      // two variables, because "mail is off" without the remedy is a shrug.
      note: summary.enabled
        ? "Outbound mail is configured from the server environment. Credentials are never shown here; only whether they are set."
        : "Outbound email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server to send.",
      variants: ["html", "plain"],
    };
  });

  app.post("/admin/mail/test", {
    preHandler: [authenticate, superAdminOnly],
    bodySchema: TEST_EMAIL_BODY,
    // One send opens a TCP connection and waits for a remote server; five a minute
    // is generous for an operator testing a configuration and bounded for a host.
    config: { rateLimit: { max: 5, windowMs: 60_000 } },
  }, async (request) => {
    if (!mail) throw AppError.unavailable("Outbound mail is not configured on this server", { retryAfter: 30 });
    const { to, variant } = request.body;
    if (!mail.isEmailAddress(to)) throw AppError.badRequest(INVALID_RECIPIENT_MESSAGE, { code: "INVALID_RECIPIENT" });

    const result = await mail.sendTest({ to, variant });
    await store?.recordAudit({
      actorId: request.auth.user.id,
      action: "ADMIN_TEST_EMAIL",
      entityType: "mail",
      entityId: null,
      details: { to, ok: result.ok },
    });
    return {
      ok: result.ok,
      message: result.message,
      variant,
      summary: mail.configSummary(),
      audited: Boolean(store),
    };
  });
}
