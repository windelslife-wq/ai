/**
 * Outbound mail (row 5), ported from `application/libraries/Aegis/Mailer.php`.
 *
 * The legacy class had exactly three jobs, and they are the three methods here:
 *
 *  - `configSummary()` — a credential-free description of the SMTP settings, the
 *    only mail state an administrator is ever shown. The password exists in this
 *    object and never appears in a summary, a log line, an error or an API body.
 *  - `send()` — one message, with legacy's refusals in legacy's order and
 *    legacy's words. The order matters: an invalid recipient is refused before
 *    the transport is even considered, which is what makes the form's validation
 *    message identical to the PHP one.
 *  - `sendTest()` — the self-contained test message the administrator panel sends.
 *
 * The transport is injected. Production builds one SMTP client per send from
 * `config.mail`; tests inject a fake, so no test can reach a real server and no
 * assertion depends on one being reachable.
 *
 * Nothing here claims a notification was emailed. The notifier still stores and
 * reads alert rows in-product; mail is used only by the administrator test send
 * and by the contact-form copy, exactly as the legacy application used it.
 */

import { isEmailAddress } from "../../mail/mime.js";
import { createSmtpTransport } from "../../mail/smtp-transport.js";

/** Legacy's sentences, verbatim — the API returns these to a person. */
export const MAIL_MESSAGES = Object.freeze({
  invalidRecipient: "The recipient address is not a valid email.",
  disabled: "Outgoing email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server to send.",
  noCredentials: "SMTP username/password are not configured in the server environment.",
  noSender: "No VP_MAIL_FROM address is configured on the server.",
  starttls: "The SMTP server does not offer STARTTLS; refusing to send over an unencrypted connection.",
  authUnsupported: "The SMTP server offers no supported authentication mechanism.",
  connection: "Could not connect to the SMTP host/port — check host, port (465 SSL / 587 TLS), that outbound SMTP is allowed by the network/firewall, and that the username/password are correct.",
  transport: "See the server error log for the full SMTP transcript.",
});

const CONNECTION_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH",
  "EAI_AGAIN", "EPIPE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const MAX_MESSAGE_BYTES = 512 * 1024;

/** Replace the configured credentials anywhere they might have been echoed. */
function scrub(text, { user, pass }) {
  let cleaned = String(text ?? "");
  if (pass) cleaned = cleaned.split(pass).join("[redacted]");
  if (user) cleaned = cleaned.split(user).join("[redacted-user]");
  return cleaned;
}

/**
 * Turn a transport failure into legacy's short, safe sentence.
 *
 * CodeIgniter's `shortError` inspected its debug transcript for connection
 * markers and a `4xx`/`5xx` code. The same three cases are recognised here from
 * the error and from the SMTP transcript, which is more reliable than string
 * matching a debugger dump.
 */
export function shortError(error, transcript = []) {
  if (error?.code === "STARTTLS_UNAVAILABLE") return MAIL_MESSAGES.starttls;
  if (error?.code === "AUTH_UNSUPPORTED") return MAIL_MESSAGES.authUnsupported;
  if (CONNECTION_CODES.has(String(error?.code ?? ""))) return MAIL_MESSAGES.connection;
  const rejection = [...transcript].reverse().find((line) => /^[245]\d{2}[ -]/.test(line));
  if (rejection) return `SMTP responded "${rejection.slice(0, 180)}".`;
  const tail = transcript.slice(-4).join(" ").trim();
  return tail ? tail.slice(0, 200) : MAIL_MESSAGES.transport;
}

const escapeHtmlText = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * @param {{config: object, log?: object|null, transportFactory?: Function,
 *   now?: () => number}} options
 */
export function createMailService({ config, log = null, transportFactory = createSmtpTransport, now = () => Date.now() }) {
  /**
   * `config.mail` is the loaded block. A caller that hands in a partial object —
   * the HTTP tests build config by hand — gets a disabled mailer rather than a
   * boot failure: "no transport" is a state, not a misconfiguration.
   */
  const settings = Object.freeze({
    enabled: false, host: "", port: 587, crypto: "tls", user: "", pass: "",
    fromEmail: "", fromName: "WINDELS AI WORKFORCE", replyTo: "", timeoutMs: 10_000,
    ...(config && typeof config === "object" ? config : {}),
  });

  function currentTransport() {
    return transportFactory({
      host: settings.host,
      port: settings.port,
      crypto: settings.crypto,
      user: settings.user,
      pass: settings.pass,
      timeoutMs: settings.timeoutMs,
    });
  }

  /** Legacy `Mailer::enabled()`. */
  function enabled() {
    return settings.enabled === true && String(settings.host ?? "").trim() !== "";
  }

  /** Legacy `Mailer::configSummary()` — same keys, same credential-free shape. */
  function configSummary() {
    return {
      enabled: enabled(),
      protocol: enabled() ? "smtp" : "disabled",
      host: settings.host ?? "",
      port: Number(settings.port ?? 0),
      crypto: String(settings.crypto ?? "").toLowerCase(),
      fromEmail: settings.fromEmail ?? "",
      fromName: settings.fromName ?? "",
      usernameConfigured: String(settings.user ?? "").trim() !== "",
      passwordConfigured: String(settings.pass ?? "").trim() !== "",
    };
  }

  /**
   * Send one message. Resolves `{ok, message}`; never throws and never leaks a
   * credential. Legacy's checks run in legacy's order.
   */
  async function send({ to, subject, html, text = "", replyTo = null, replyName = "" }) {
    const recipient = String(to ?? "").trim();
    if (!isEmailAddress(recipient)) return { ok: false, message: MAIL_MESSAGES.invalidRecipient };
    if (!enabled()) return { ok: false, message: MAIL_MESSAGES.disabled };
    if (!configSummary().usernameConfigured || !configSummary().passwordConfigured) {
      return { ok: false, message: MAIL_MESSAGES.noCredentials };
    }
    if (!isEmailAddress(String(settings.fromEmail ?? ""))) return { ok: false, message: MAIL_MESSAGES.noSender };
    if (typeof html !== "string" || html === "") return { ok: false, message: "A message needs a body." };
    if (Buffer.byteLength(html, "utf8") + Buffer.byteLength(String(text ?? ""), "utf8") > MAX_MESSAGE_BYTES) {
      return { ok: false, message: "The message is too large to send." };
    }

    let result;
    try {
      result = await currentTransport().send({
        from: settings.fromEmail,
        fromName: settings.fromName,
        to: recipient,
        subject,
        html,
        text,
        replyTo: replyTo && isEmailAddress(replyTo) ? replyTo : null,
        replyName,
        now: now(),
      });
    } catch (error) {
      // A transport factory that throws is still a failed send, not a 500: the
      // caller shows the same refusal a server rejection would produce.
      result = { ok: false, error, transcript: [] };
    }

    if (result?.ok) {
      log?.info?.({ to: recipient }, "outbound mail accepted");
      return { ok: true, message: `Message accepted for delivery to ${recipient}.` };
    }

    // The transcript can contain the username in an EHLO line and the base64
    // token in an AUTH line; both are scrubbed before anything is logged.
    const transcript = (result?.transcript ?? []).map((line) => scrub(line, settings));
    const reason = scrub(shortError(result?.error, transcript), settings);
    log?.warn?.({ code: result?.error?.code ?? "SMTP_SEND_FAILED" }, "outbound mail was not accepted");
    return { ok: false, message: `The SMTP server did not accept the message. ${reason}` };
  }

  /**
   * The administrator panel's test message, verbatim from `Mailer::sendTest`:
   * the same subject, the same four summary rows, and the same "if you can read
   * this, HTML email works" line.
   */
  async function sendTest({ to, variant = "html" }) {
    const summary = configSummary();
    const isHtml = variant !== "plain";
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#0f172a">`
      + `<h2 style="color:#2563eb;margin:0 0 8px">WINDELS AI WORKFORCE — test email</h2>`
      + "<p>This confirms outbound email is working from your WINDELS AI WORKFORCE installation.</p>"
      + `<table style="border-collapse:collapse;font-size:13px;color:#334155">`
      + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Protocol</td><td>${escapeHtmlText(summary.protocol)}</td></tr>`
      + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Host</td><td>${escapeHtmlText(summary.host)}</td></tr>`
      + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">Port / TLS</td><td>${escapeHtmlText(String(summary.port))} / ${escapeHtmlText(String(summary.crypto).toUpperCase() || "—")}</td></tr>`
      + `<tr><td style="padding:3px 12px 3px 0;color:#64748b">From</td><td>${escapeHtmlText(summary.fromEmail)} (${escapeHtmlText(summary.fromName)})</td></tr>`
      + "</table>"
      + `<p style="margin-top:16px;color:#64748b;font-size:12px">Sent at ${new Date(now()).toISOString().replace("T", " ").slice(0, 19)} UTC. If you can read this, HTML email works.</p>`
      + "</div>";
    const text = "WINDELS AI WORKFORCE — test email\n\n"
      + "This confirms outbound email is working from your WINDELS AI WORKFORCE installation.\n\n"
      + `Protocol: ${summary.protocol}\nHost: ${summary.host}\nPort/TLS: ${summary.port} / ${String(summary.crypto).toUpperCase()}\n`
      + `From: ${summary.fromEmail} (${summary.fromName})\n\n`
      + `Sent at ${new Date(now()).toISOString().replace("T", " ").slice(0, 19)} UTC.`;
    return send({
      to,
      subject: `WINDELS AI WORKFORCE — test email (${variant})`,
      html: isHtml ? html : text,
      text,
    });
  }

  return Object.freeze({
    enabled,
    configSummary,
    send,
    sendTest,
    // Exposed so the contact-form copy and tests share one address rule.
    isEmailAddress,
  });
}
