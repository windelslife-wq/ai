/**
 * Public-site service: contact intake and the documents that describe it.
 *
 * Legacy parity (`Site::contact_submit`): the inquiry is validated, written to the
 * audit trail with the visitor's name, email and a 2000-character message excerpt,
 * and — only if the host enabled mail — copied to the operator. This port keeps the
 * storage and audit behaviour and states the mail situation honestly: the Node
 * platform has no mail transport yet (the same reason password-reset delivery is
 * deferred), so the receipt always reports `sent: false` with the reason instead of
 * implying a delivery that did not happen.
 *
 * The client address is stored hashed, keyed with `SESSION_SECRET`, so an inquiry
 * row can be correlated with abuse without keeping a raw IP next to a name.
 */

import { createHmac } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { CONTACT_INVALID_MESSAGE } from "./contracts.js";
import { newInquiryReference } from "./reference.js";

export const CONTACT_ACTION = "CONTACT_INQUIRY";

export function createSiteService({ store, config }) {
  function clientFingerprint(clientIp) {
    return createHmac("sha256", config.sessionSecret).update(`contact:${clientIp || "unknown"}`).digest("hex");
  }

  return {
    /**
     * @returns {Promise<{id: number, recorded: boolean, mail: {sent: boolean, reason: string}}>}
     */
    async submitContact({ name, email, message, clientIp = null, userAgent = null, requestId = null }) {
      if (!store) {
        // No storage means the inquiry cannot be recorded, and a 200 here would be
        // a lie. 503 + Retry-After is the platform's dependency-failure contract.
        throw AppError.unavailable("Contact intake is unavailable: no storage adapter is configured", { retryAfter: 30 });
      }
      const inquiry = await store.recordContactInquiry({
        reference: newInquiryReference(),
        name,
        email,
        message,
        clientFingerprint: clientFingerprint(clientIp),
        userAgent: userAgent ? String(userAgent).slice(0, 254) : null,
        requestId,
      });
      await store.recordAudit({
        actorId: null,
        action: CONTACT_ACTION,
        entityType: "site",
        entityId: inquiry.id,
        details: {
          // The legacy audit entry carried the message body; keeping it means an
          // operator can answer an inquiry from the audit trail alone.
          name,
          email,
          message: message.slice(0, 2_000),
          inquiryId: inquiry.id,
        },
      });
      return {
        id: inquiry.id,
        recorded: true,
        reference: inquiry.reference,
        mail: {
          sent: false,
          reason: "This platform has no outbound mail transport yet. The inquiry is stored and audited; nothing was emailed.",
        },
        notice: "Thank you. Your message was recorded. No outbound mail is configured on this platform, so nothing was emailed.",
      };
    },

    /** The legacy rejection text, reused by both the JSON and the form endpoints. */
    invalidMessage: CONTACT_INVALID_MESSAGE,

    async listInquiries(query) {
      if (!store) throw AppError.unavailable("Contact intake is unavailable: no storage adapter is configured", { retryAfter: 30 });
      return store.pageContactInquiries(query);
    },
  };
}
