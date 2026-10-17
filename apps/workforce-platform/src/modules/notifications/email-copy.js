/**
 * The email COPY of one stored operator notification (row 5, Phase 49; DV-28).
 *
 * Everything here is pure: given a notification that is already persisted, build the
 * subject and both message bodies, or mask an address for the audit trail. Three rules
 * keep the copy honest:
 *
 *  - **It says it is a copy.** The in-product inbox is the channel of record; the
 *    email is evidence transport. The body says so, and it carries no action links —
 *    an email that could "approve" something would be pretending a control surface
 *    exists outside the signed-in workspace, which is exactly the class of claim the
 *    rest of this platform works to prevent.
 *  - **It is bounded.** The subject is one line; the detail render is capped and says
 *    when it was cut, so a worst-case notification cannot produce a worst-case email.
 *  - **It leaks nothing by accident.** Severity, type, title and detail are escaped
 *    before they touch HTML, and the audit trail sees masked addresses only.
 */

/** Escape a value for HTML text context. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collapse to one printable line for the subject and headings. */
function oneLine(value, max = 480) {
  return Array.from(String(value ?? "").replace(/[\r\n\s]+/g, " ").trim()).slice(0, max).join("");
}

/**
 * Mask an address for the audit trail: `operator@example.com` → `o***@example.com`.
 * The domain is left whole on purpose — an operator auditing delivery needs to know
 * delivery went to the right organisation, not just to some address.
 */
export function maskEmail(address) {
  const value = String(address ?? "");
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  return `${value[0]}***@${value.slice(at + 1)}`;
}

/** The detail render's byte cap, after which the marker says it was cut. */
export const DETAIL_RENDER_MAX_CHARS = 4000;

function renderDetail(detail) {
  const payload = detail && typeof detail === "object" && Object.keys(detail).length > 0
    ? JSON.stringify(detail, null, 2)
    : "";
  if (payload === "") return { json: "{}", truncated: false };
  if (payload.length <= DETAIL_RENDER_MAX_CHARS) return { json: payload, truncated: false };
  return { json: `${payload.slice(0, DETAIL_RENDER_MAX_CHARS)}\n[truncated: detail exceeded ${DETAIL_RENDER_MAX_CHARS} characters and was not fully rendered]`, truncated: true };
}

const SUBJECT_PREFIX = "WINDELS AI WORKFORCE";

/**
 * Build the email copy of one stored notification.
 *
 * @param {{type: string, severity: string, title: string, detail?: object, createdAt: string}} notification
 * @returns {{subject: string, html: string, text: string, detailTruncated: boolean}}
 */
export function buildNotificationEmail(notification, { fromName = SUBJECT_PREFIX } = {}) {
  const severity = String(notification.severity ?? "info").toUpperCase();
  const type = String(notification.type ?? "");
  const title = oneLine(notification.title ?? "");
  const subject = oneLine(`[${severity}] ${title}${type ? ` — ${type}` : ""}`, 200);
  const { json, truncated } = renderDetail(notification.detail ?? {});
  const createdLine = `Stored at ${String(notification.createdAt ?? "")} UTC.`;
  const disclaimer = "This is a copy of an in-product operator notification for WINDELS AI WORKFORCE operators. The workspace inbox is the channel of record; no action is possible from this email, and a delivery failure never changes the stored alert or the decision that produced it.";

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a">`
    + `<h2 style="color:#b45309;margin:0 0 8px">${escapeHtml(fromName)} — operator alert (${escapeHtml(severity)})</h2>`
    + `<table style="border-collapse:collapse;font-size:13px;color:#334155">`
    + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Type</td><td>${escapeHtml(type)}</td></tr>`
    + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Severity</td><td>${escapeHtml(severity)}</td></tr>`
    + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Title</td><td><b>${escapeHtml(title)}</b></td></tr>`
    + `</table>`
    + `<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(json)}</pre>`
    + `<p style="margin-top:16px;color:#64748b;font-size:12px">${escapeHtml(createdLine)} ${escapeHtml(disclaimer)}</p>`
    + `</div>`;

  const text = `${fromName} — operator alert (${severity})\n\n`
    + `Type: ${type}\n`
    + `Severity: ${severity}\n`
    + `Title: ${title}\n\n`
    + `${json}\n\n`
    + `${createdLine} ${disclaimer}\n`;

  return { subject, html, text, detailTruncated: truncated };
}
