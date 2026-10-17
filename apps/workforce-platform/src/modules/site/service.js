/**
 * Public-site service: contact intake and the documents that describe it.
 *
 * Legacy parity (`Site::contact_submit`): the inquiry is validated, written to the
 * audit trail with the visitor's name, email and a 2000-character message excerpt,
 * and — only if the host enabled mail — copied to the operator. This port does all
 * three. The copy is `Site::tryMail` verbatim: it goes to `VP_MAIL_FROM` with the
 * visitor's address as Reply-To, and a send that fails never fails the intake —
 * the inquiry is already stored and audited, and the receipt says what happened.
 *
 * A host with no SMTP configuration therefore gets the legacy sentence ("Outgoing
 * email is disabled…") and `sent: false`, never a claim of delivery.
 *
 * The client address is stored hashed, keyed with `SESSION_SECRET`, so an inquiry
 * row can be correlated with abuse without keeping a raw IP next to a name.
 */

import { createHmac } from "node:crypto";
import { AppError } from "../../http/errors.js";
import { CONTACT_INVALID_MESSAGE } from "./contracts.js";
import { newInquiryReference } from "./reference.js";
import { escapeHtml } from "./render.js";

export const CONTACT_ACTION = "CONTACT_INQUIRY";


/**
 * `Site::tryMail`, ported: mail a copy of an inquiry to the configured sender.
 *
 * Three properties are deliberate.
 *  - It never throws. The inquiry is already stored and audited; a mail outage is
 *    reported, not turned into a failed submission.
 *  - It is a no-op when mail is disabled or no sender is configured, exactly the
 *    two early returns the PHP method had.
 *  - The visitor's address goes in `Reply-To`, so the operator can answer the
 *    message from their mail client.
 */
async function copyToOperator({ name, email, message, mail }) {
  if (!mail || !mail.enabled()) {
    return {
      sent: false,
      // Legacy's exact sentence, shared with `Mailer::send()`.
      reason: "Outgoing email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server to send.",
    };
  }
  const summary = mail.configSummary();
  const to = summary.fromEmail;
  if (!to) {
    return { sent: false, reason: "No VP_MAIL_FROM address is configured on the server." };
  }
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#0f172a">'
    + '<h2 style="color:#2563eb">New contact message — WINDELS AI WORKFORCE</h2>'
    + `<p><b>From:</b> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>`
    + '<hr style="border:0;border-top:1px solid #e2e8f0">'
    + `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`
    + "</div>";
  const text = `New contact message — WINDELS AI WORKFORCE\n\nFrom: ${name} <${email}>\n\n${message}`;
  try {
    const result = await mail.send({
      to,
      subject: "WINDELS AI WORKFORCE contact form",
      html,
      text,
      replyTo: email,
      replyName: name,
    });
    return { sent: result.ok, reason: result.message };
  } catch (error) {
    // A transport that throws is still a failed copy, never a failed submission.
    return { sent: false, reason: `The contact copy could not be sent: ${error?.message ?? "unknown error"}` };
  }
}

export function createSiteService({ store, config, mail = null }) {
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
        mail: await copyToOperator({ name, email, message, mail }),
        // Legacy's wording, kept because it is true in both states: "If outbound
        // mail is configured, a copy was sent to the site operator."
        notice: "Thank you. Your message was recorded. If outbound mail is configured, a copy was sent to the site operator.",
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
