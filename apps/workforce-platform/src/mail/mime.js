/**
 * Message construction for outbound mail (row 5).
 *
 * The legacy application sent through CodeIgniter's Email library with
 * `mailtype: html` and `set_alt_message()`, which produces a
 * `multipart/alternative` message: an HTML part and a plain-text fallback. This
 * module builds exactly that, without a dependency, because the deployment
 * target is a cPanel host and the platform's Node tree deliberately carries only
 * `mysql2` and `bcryptjs`.
 *
 * Everything here is deterministic except the boundary, the Message-ID and the
 * clock, each of which can be supplied for a test. Header values are encoded as
 * RFC 2047 encoded-words when they are not ASCII, so the em dash in the test
 * subject survives; display names are quoted and escaped.
 *
 * Header injection is refused, not silently repaired, for the two fields a
 * request can influence (`to`, `replyTo`): both are validated as bare addresses,
 * and the patterns forbid whitespace, CR and LF outright. Subject and display
 * names come from code or configuration and are flattened to one line.
 */

import { randomUUID } from "node:crypto";
import { FIELD_FORMATS } from "../http/validate.js";

/** RFC 5321 path limit; also the practical bound for a header address. */
const MAX_ADDRESS_LENGTH = 320;

/** The same email pattern every route validates against — one definition. */
export function isEmailAddress(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ADDRESS_LENGTH
    && FIELD_FORMATS.email.test(value);
}

/** Collapse a header value to one line. */
function oneLine(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

const ASCII = /^[\x20-\x7E]*$/;

/**
 * RFC 2047 encoded-word for a header that is not plain ASCII. Base64 is used
 * rather than quoted-printable because it has no line-length ambiguity.
 */
export function encodeHeaderText(value) {
  const text = oneLine(value);
  if (ASCII.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** `"Display Name" <address>` with quoting and encoded-word handling. */
export function formatAddress(address, displayName = "") {
  if (!isEmailAddress(address)) throw new TypeError(`not an email address: ${JSON.stringify(address)}`);
  const name = oneLine(displayName);
  if (!name) return `<${address}>`;
  const encoded = ASCII.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeHeaderText(name);
  return `${encoded} <${address}>`;
}

/** Base64 with CRLF line breaks, as MIME requires. */
function base64Body(text) {
  const encoded = Buffer.from(String(text).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  return encoded.replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build the DATA payload for one message.
 *
 * @param {{from: string, fromName?: string, to: string, subject: string,
 *   html: string, text?: string, replyTo?: string|null, replyName?: string|null,
 *   now?: number, messageId?: string, boundary?: string}} message
 * @returns {{payload: string, boundary: string, messageId: string}}
 */
export function buildMessage({
  from,
  fromName = "",
  to,
  subject,
  html,
  text = "",
  replyTo = null,
  replyName = "",
  now = Date.now(),
  messageId = null,
  boundary = null,
}) {
  if (!isEmailAddress(from)) throw new TypeError("the envelope sender is not a valid email address");
  if (!isEmailAddress(to)) throw new TypeError("the recipient is not a valid email address");
  if (!oneLine(subject)) throw new TypeError("a message needs a subject");
  if (typeof html !== "string" || html === "") throw new TypeError("a message needs an HTML body");

  const marker = boundary || `----wf-${randomUUID()}`;
  const domain = from.split("@")[1] || "localhost";
  const id = messageId || `<${randomUUID()}@${domain}>`;
  const headers = [
    `From: ${formatAddress(from, fromName)}`,
    `To: ${formatAddress(to)}`,
    ...(replyTo && isEmailAddress(replyTo) ? [`Reply-To: ${formatAddress(replyTo, replyName)}`] : []),
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${new Date(now).toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${marker}"`,
  ];

  const parts = [];
  if (text) {
    parts.push(
      `--${marker}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(text),
    );
  }
  parts.push(
    `--${marker}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(html),
    `--${marker}--`,
    "",
  );

  return { payload: `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, boundary: marker, messageId: id };
}
