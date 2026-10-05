import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

// A process-local random hash keeps unknown-user and malformed-hash checks on the same bcrypt path.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString("base64url"), 10);

function supportedBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(value);
}

export async function verifyPassword(password, storedHash) {
  const supported = supportedBcryptHash(storedHash);
  const candidate = supported && storedHash.startsWith("$2y$")
    ? `$2b$${storedHash.slice(4)}`
    : supported ? storedHash : DUMMY_HASH;
  let valid = false;
  try {
    valid = await bcrypt.compare(password, candidate);
  } catch {
    valid = false;
  }
  return supported && valid;
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Password must contain between 12 and 1024 characters");
  }
  return bcrypt.hash(password, 12);
}
