/**
 * Password hashing and legacy-hash compatibility.
 *
 * The PHP application stored bcrypt digests produced by `password_hash(...,
 * PASSWORD_DEFAULT)` with the `$2y$` identifier. `bcryptjs` verifies `$2a/$2b/$2y`
 * but emits `$2b$`, which PHP's `crypt()` does not recognise. Two consequences
 * are handled here:
 *
 *  1. verification normalizes a `$2y$` digest to `$2b$` before comparing, so an
 *     imported legacy hash still logs in (unchanged behaviour);
 *  2. new and re-hashed digests are re-labelled to `$2y$`, so a hash produced by
 *     Node remains verifiable by the still-authoritative PHP application during
 *     side-by-side operation.
 *
 * Lazy rehash: when a legacy digest verifies and is weaker than the current cost
 * (or carries the legacy prefix), the login route re-hashes it with the current
 * cost and writes it back — no forced password reset, no lockout.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const BCRYPT_COST = 12;
// A process-local random hash keeps unknown-user and malformed-hash checks on the
// same bcrypt path, so timing does not reveal whether an identifier exists.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString("base64url"), BCRYPT_COST);
const BCRYPT_HASH = /^\$2([aby])\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export function isSupportedHash(value) {
  return typeof value === "string" && BCRYPT_HASH.test(value);
}

function toBcryptJs(hash) {
  return hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
}

/** bcrypt digests are written back with the PHP-compatible `$2y$` identifier. */
function toPortableHash(hash) {
  return hash.startsWith("$2b$") ? `$2y$${hash.slice(4)}` : hash;
}

export function hashCost(storedHash) {
  const match = typeof storedHash === "string" ? BCRYPT_HASH.exec(storedHash) : null;
  return match ? Number.parseInt(match[2], 10) : null;
}

/**
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, storedHash) {
  return (await inspectPassword(password, storedHash)).valid;
}

/**
 * @returns {Promise<{valid: boolean, needsRehash: boolean, reason: string|null}>}
 */
export async function inspectPassword(password, storedHash) {
  const supported = isSupportedHash(storedHash);
  const candidate = supported ? toBcryptJs(storedHash) : DUMMY_HASH;
  let valid = false;
  try {
    valid = await bcrypt.compare(String(password ?? ""), candidate);
  } catch {
    valid = false;
  }
  if (!supported) return { valid: false, needsRehash: false, reason: "unsupported-hash" };
  const cost = hashCost(storedHash);
  // A digest is rewritten only when it is genuinely weaker or non-portable:
  // below the current cost, or not carrying the `$2y$` identifier PHP can verify.
  // Re-hashing a current digest would rewrite the row on every single login.
  const lowCost = cost === null || cost < BCRYPT_COST;
  const legacyPrefix = !storedHash.startsWith("$2y$");
  const needs = lowCost || legacyPrefix;
  const reason = lowCost ? "low-cost" : legacyPrefix ? "legacy-prefix" : null;
  return { valid, needsRehash: valid && needs, reason: valid && needs ? reason : null };
}

export async function hashPassword(password, { minLength, cost = BCRYPT_COST } = {}) {
  const minimum = minLength ?? 12;
  if (typeof password !== "string" || password.length < minimum || password.length > 1024) {
    throw new Error(`Password must contain between ${minimum} and 1024 characters`);
  }
  return toPortableHash(await bcrypt.hash(password, cost));
}

export const PASSWORD_COST = BCRYPT_COST;
