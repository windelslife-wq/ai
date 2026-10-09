/**
 * Inquiry references: a ULID-shaped, sortable, 26-character public identifier.
 *
 * A visitor gets this reference in the response and can quote it back; staff use it
 * to find the row without exposing an auto-increment id (which would advertise how
 * many inquiries the platform receives). Implemented here rather than pulled from a
 * package: the platform's runtime dependency budget is `mysql2` and `bcryptjs`.
 *
 * Layout — 10 characters of millisecond timestamp + 16 of randomness, Crockford
 * base32, so references sort chronologically as plain strings.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms, length) {
  let value = ms;
  const out = new Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = ALPHABET[value & 0x1f];
    value = Math.floor(value / 32);
  }
  return out.join("");
}

function encodeRandomness(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) out += ALPHABET[bytes[index] & 0x1f];
  return out;
}

export function newInquiryReference(now = Date.now()) {
  return `${encodeTime(now, 10)}${encodeRandomness(16)}`;
}

export const REFERENCE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
