/**
 * Public-site API endpoints: contact intake and the administrator view of it.
 *
 * The HTML form at `/contact` posts here when script is available; the no-script
 * path posts to `/contact/submit` (see `documents.js`) and both go through the same
 * service, so there is one intake rule and one audit entry per message.
 *
 * `GET /admin/inquiries` is gated on `system.super_admin` rather than
 * `identity.users.view`: an inquiry row holds a visitor's name and email address,
 * and the legacy platform exposed it only through the administrator audit trail.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { CONTACT_SUBMIT, INQUIRY_LIST_QUERY } from "./contracts.js";
import { createSiteService } from "./service.js";

export function siteRoutes(app, { store, config, mail = null }) {
  const service = createSiteService({ store, config, mail });
  const authenticate = createAuthenticator({ store, config });
  const superAdminOnly = requirePermission("system.super_admin", config);
  superAdminOnly.permission = "system.super_admin";

  app.post("/site/contact", {
    bodySchema: CONTACT_SUBMIT,
    // A public, unauthenticated write: tighter than the general API limit and
    // documented in .env.example (CONTACT_MAX_PER_HOUR / CONTACT_WINDOW_MS).
    config: { rateLimit: { max: config.site.contact.maxPerWindow, windowMs: config.site.contact.windowMs } },
  }, async (request) => service.submitContact({
    ...request.body,
    clientIp: request.clientAddress,
    userAgent: request.headers["user-agent"] || null,
    requestId: request.requestId || null,
  }));

  app.get("/admin/inquiries", {
    preHandler: [authenticate, superAdminOnly],
    querySchema: INQUIRY_LIST_QUERY,
  }, async (request) => {
    if (!store) throw AppError.unavailable("Contact intake is unavailable: no storage adapter is configured", { retryAfter: 30 });
    const { total, inquiries } = await service.listInquiries(request.query);
    return {
      total,
      limit: request.query.limit,
      offset: request.query.offset,
      inquiries,
      mail: mail && mail.enabled()
        ? { transport: "smtp", note: "A copy of each new inquiry is emailed to the configured sender (VP_MAIL_FROM). Delivery failures are recorded on the receipt and never fail the intake." }
        : { transport: "none", note: "Outbound email is disabled, so inquiries are stored and audited only. Set VP_SMTP_ENABLED=1 and VP_SMTP_HOST to copy them to the operator." },
    };
  });
}
