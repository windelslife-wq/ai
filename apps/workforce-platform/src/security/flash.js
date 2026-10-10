/**
 * One-shot, signed flash messages for the progressive-enhancement form path.
 *
 * The legacy PHP site used session flashdata (`set_flashdata` → `redirect('/contact')`).
 * This platform does not create an anonymous session for a public form submission —
 * that would be a stateful, unauthenticated write per request — so the notice travels
 * in a short-lived cookie instead:
 *
 *  - signed with `SESSION_SECRET` (HMAC-SHA256) and length-verified, so a visitor
 *    cannot forge or extend a message;
 *  - expired after two minutes and cleared by the page that renders it, so it is
 *    genuinely one-shot;
 *  - `HttpOnly` + `SameSite=Strict`: the browser needs to send it back, script does
 *    not need to read it;
 *  - a page rendered *with* a flash is `no-store`, because a shared cache that kept
 *    one visitor's notice could revalidate it into another visitor's browser.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const FLASH_COOKIE = "wf_flash";
const FLASH_TTL_MS = 120_000;
const TONES = new Set(["ok", "error"]);

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeFlash({ tone, message }, secret, { now = Date.now() } = {}) {
  if (!TONES.has(tone)) throw new Error(`Unknown flash tone: ${tone}`);
  const payload = Buffer.from(JSON.stringify({ tone, message: String(message).slice(0, 400), expiresAt: now + FLASH_TTL_MS }), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** @returns {{tone: string, message: string}|null} null when absent, forged, malformed or expired. */
export function decodeFlash(value, secret, { now = Date.now() } = {}) {
  if (typeof value !== "string") return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || !TONES.has(parsed.tone) || typeof parsed.message !== "string") return null;
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) return null;
  return { tone: parsed.tone, message: parsed.message };
}

export function readFlashCookie(header, cookieName = FLASH_COOKIE) {
  if (typeof header !== "string") return null;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(cookieName.length + 1);
  // base64url payload + "." + base64url signature, both bounded.
  return /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function flashCookie(value, { secure, cookieName = FLASH_COOKIE }) {
  const parts = [`${cookieName}=${value}`, "Path=/", `Max-Age=${Math.ceil(FLASH_TTL_MS / 1000)}`, "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function expiredFlashCookie({ secure, cookieName = FLASH_COOKIE }) {
  const parts = [`${cookieName}=`, "Path=/", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
