/**
 * A backup you cannot restore is a file, not a backup (audit finding F-02).
 * These tests drive the real tool against the real file adapter: take a backup,
 * destroy the store, restore it, and require the state to be byte-identical in
 * meaning (checksum) and usable (sign in).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import bcrypt from "bcryptjs";
import { createFileStore } from "../src/persistence/file-store.js";
import { createBackup, restoreBackup, verifyBackup, buildMysqldumpArgs } from "../tools/backup.mjs";
import { testConfig } from "./helpers.js";

async function tempApp() {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-backup-"));
  const config = testConfig({ __directory: directory });
  return { config, directory, storeDir: config.storage.fileDir };
}

test("F-13 a file-store backup verifies, and restores an identical store after the original is deleted", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  const created = await store.createUser({ username: "persisted", email: "persisted@example.test", passwordHash: await bcrypt.hash("a long enough password", 4), displayName: "Persisted" });
  await store.createSession({ tokenHash: "b".repeat(64), userId: created.id, expiresAt: new Date(Date.now() + 600_000).toISOString(), deviceLabel: "studio" });
  await store.recordAudit({ actorId: created.id, action: "identity.test", entityType: "identity", entityId: created.id, details: { n: 1 } });
  await store.setAvatarPath(created.id, "/api/v1/files/avatars/u1_deadbeefdeadbeefdeadbeefdeadbeef.png");
  // Uploads live outside the store directory and must travel with it.
  await mkdir(config.uploads.dir, { recursive: true });
  await writeFile(path.join(config.uploads.dir, "u1_deadbeefdeadbeefdeadbeefdeadbeef.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const checksumBefore = await store.checksum();
  await store.close();

  const result = await createBackup({ config, destination: path.join(directory, "backups") });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, "file");
  const manifest = JSON.parse(await readFile(path.join(result.backupDir, "manifest.json"), "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("store/windels-store.jsonl"), paths.join(","));
  assert.ok(paths.includes("uploads/u1_deadbeefdeadbeefdeadbeefdeadbeef.png"), "avatar bytes must be in the backup");
  assert.equal(manifest.adapter, "file");
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal((await verifyBackup({ backupDir: result.backupDir })).ok, true);

  await rm(storeDir, { recursive: true, force: true });
  await rm(config.uploads.dir, { recursive: true, force: true });

  const restored = await restoreBackup({ config, backupDir: result.backupDir });
  assert.equal(restored.ok, true);
  assert.equal(restored.checksum, checksumBefore, "the restored store must be identical, not merely present");
  assert.equal((await stat(path.join(config.uploads.dir, "u1_deadbeefdeadbeefdeadbeefdeadbeef.png"))).size, 4, "the avatar bytes come back too");

  const reopened = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => reopened.close());
  const user = await reopened.findUserByIdentifier("persisted");
  assert.equal(user.username, "persisted");
  assert.equal(user.email, "persisted@example.test");
  assert.match(user.password_hash, /^\$2[aby]\$0?4\$/, "a digest written by the test harness comes back byte-for-byte, not re-hashed");
  const session = await reopened.findSession("b".repeat(64));
  assert.equal(session.user.displayName, "Persisted", "the profile row travels with the user row");
  assert.equal((await reopened.listSessions(created.id))[0].deviceLabel, "studio", "sessions and their device labels survive a restore");
  assert.equal((await reopened.listAuditEvents({ userId: created.id })).total, 1, "the audit trail is part of the backup, not an afterthought");
  assert.equal(await reopened.findAvatarPath(created.id), "/api/v1/files/avatars/u1_deadbeefdeadbeefdeadbeefdeadbeef.png");
});

test("F-13 a restore refuses to overwrite a non-empty store unless forced", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  await store.createUser({ username: "first", email: "first@example.test", passwordHash: "$2y$12$x", displayName: "First" });
  await store.close();
  const { backupDir } = await createBackup({ config, destination: path.join(directory, "backups") });

  // Write something new, then require the refusal.
  const store2 = await createFileStore({ dir: storeDir, syncWrites: false });
  await store2.createUser({ username: "second", email: "second@example.test", passwordHash: "$2y$12$y", displayName: "Second" });
  await store2.close();

  await assert.rejects(restoreBackup({ config, backupDir }), /already holds \d+ file\(s\)/);
  assert.ok((await readdir(storeDir)).length > 0, "the refusal must not have touched anything");

  const forced = await restoreBackup({ config, backupDir, force: true });
  assert.equal(forced.ok, true);
  const after = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => after.close());
  assert.equal(await after.findUserByIdentifier("second"), null, "a forced restore replaces the state, as documented");
  assert.equal((await after.findUserByIdentifier("first")).username, "first");
});

test("F-13 a damaged backup is refused before anything is overwritten", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  await store.createUser({ username: "tampered", email: "tampered@example.test", passwordHash: "$2y$12$z", displayName: "T" });
  await store.close();
  const { backupDir } = await createBackup({ config, destination: path.join(directory, "backups") });
  const logPath = path.join(backupDir, "store", "windels-store.jsonl");
  await writeFile(logPath, `${await readFile(logPath, "utf8")}{"op":"forged"}\n`, "utf8");

  const damaged = await verifyBackup({ backupDir });
  assert.equal(damaged.ok, false);
  assert.match(damaged.problems.join("\n"), /size \d+ does not match the recorded/);
  await assert.rejects(restoreBackup({ config, backupDir }), /Refusing to restore an unverifiable backup/);
});

test("F-13 MySQL dumps use the host tool and never put the password in argv", () => {
  const args = buildMysqldumpArgs({ host: "db.internal", port: 3306, user: "wf_admin", password: "hunter2", name: "wf_prod" });
  assert.ok(args.includes("--single-transaction"), "a consistent non-locking snapshot is the only safe dump on a live shop");
  assert.ok(args.includes("--no-tablespaces"), "without this, a shared host aborts the dump on information_schema privileges");
  assert.ok(args.includes("--routines") && args.includes("--triggers"), "routines and triggers are part of the schema");
  assert.ok(args.includes("wf_prod"));
  assert.equal(args.some((entry) => entry.includes("hunter2")), false, "a secret in argv is readable by any process on the host");
  assert.equal(args.some((entry) => entry === "-p" || entry.startsWith("--password")), false);
  assert.ok(args.some((entry) => entry.startsWith("--defaults-extra-file=")) === false, "the defaults file is added by the caller, next to the spawn");
});
