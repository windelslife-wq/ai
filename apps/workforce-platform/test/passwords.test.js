import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { hashPassword, inspectPassword, verifyPassword } from "../src/security/passwords.js";

test("password verification supports PHP bcrypt hashes and ignores malformed stored hashes", async () => {
  const phpStyleHash = await bcrypt.hash("migrated password", 4).then((hash) => hash.replace("$2b$", "$2y$"));
  assert.equal(await verifyPassword("migrated password", phpStyleHash), true);
  assert.equal(await verifyPassword("incorrect", phpStyleHash), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("new password hashes use the PHP-compatible $2y$ identifier at cost 12", async () => {
  const hash = await hashPassword("a long enough password");
  // $2y$ (not bcryptjs' default $2b$) so the still-authoritative PHP application
  // can verify a Node-produced digest; see src/security/passwords.js.
  assert.match(hash, /^\$2y\$12\$/);
  assert.equal(await verifyPassword("a long enough password", hash), true);
  await assert.rejects(hashPassword("short"), /between 12 and 1024/);
});

test("legacy low-cost digests are flagged for lazy rehash, wrong passwords are not", async () => {
  const legacy = (await bcrypt.hash("legacy password", 10)).replace("$2b$", "$2y$");
  const verified = await inspectPassword("legacy password", legacy);
  assert.equal(verified.valid, true);
  assert.equal(verified.needsRehash, true);
  assert.equal(verified.reason, "low-cost");

  const wrong = await inspectPassword("nope", legacy);
  assert.deepEqual(wrong, { valid: false, needsRehash: false, reason: null });

  const strong = await hashPassword("a long enough password");
  const fresh = await inspectPassword("a long enough password", strong);
  assert.equal(fresh.needsRehash, false);

  const foreignPrefix = await bcrypt.hash("portable password", 12).then((hash) => hash.replace(/^\$2a\$/, "$2b$"));
  const foreign = await inspectPassword("portable password", foreignPrefix);
  assert.equal(foreign.valid, true);
  assert.equal(foreign.needsRehash, true);
  assert.equal(foreign.reason, "legacy-prefix");

  const unsupported = await inspectPassword("whatever", "$5$md5style$notbcrypt");
  assert.deepEqual(unsupported, { valid: false, needsRehash: false, reason: "unsupported-hash" });
});
