import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "../src/security/passwords.js";

test("password verification supports PHP bcrypt hashes and ignores malformed stored hashes", async () => {
  const phpStyleHash = await bcrypt.hash("migrated password", 4).then((hash) => hash.replace("$2b$", "$2y$"));
  assert.equal(await verifyPassword("migrated password", phpStyleHash), true);
  assert.equal(await verifyPassword("incorrect", phpStyleHash), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("new password hashes use bcrypt cost 12 and enforce a minimum length", async () => {
  const hash = await hashPassword("a long enough password");
  assert.match(hash, /^\$2[ab]\$12\$/);
  assert.equal(await verifyPassword("a long enough password", hash), true);
  await assert.rejects(hashPassword("short"), /between 12 and 1024/);
});
