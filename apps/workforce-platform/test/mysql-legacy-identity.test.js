import test from "node:test";
import assert from "node:assert/strict";
import {
  createMysqlLegacyIdentityTarget,
  findLegacyIdentityTargetConflicts,
  readLegacyIdentitySnapshot,
} from "../src/db/mysql-legacy-identity.js";

const requiredColumns = ["id", "email", "password_hash", "display_name", "active", "created_at", "updated_at"];

function sourcePool(columns = [...requiredColumns, "username"]) {
  const state = { queries: [], began: false, committed: false, rolledBack: false, released: false };
  const connection = {
    async query(sql) {
      state.queries.push(sql);
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ") return [[], []];
      if (sql === "SHOW COLUMNS FROM `users`") return [columns.map((Field) => ({ Field })), []];
      if (sql.startsWith("SELECT `id`")) return [[{
        id: 4,
        email: "reader@example.test",
        password_hash: "$2y$10$" + "a".repeat(53),
        display_name: "Reader",
        active: 1,
        created_at: "2026-09-15T10:30:00+00:00",
        updated_at: "2026-09-15T10:30:00+00:00",
        username: "reader",
      }], []];
      if (sql.startsWith("SELECT id, code, name FROM roles")) return [[{ id: 1, code: "user", name: "User" }], []];
      if (sql.startsWith("SELECT id, code, name FROM permissions")) return [[], []];
      if (sql.startsWith("SELECT user_id, role_id FROM user_roles")) return [[{ user_id: 4, role_id: 1 }], []];
      if (sql.startsWith("SELECT role_id, permission_id FROM role_permissions")) return [[], []];
      throw new Error(`Unexpected legacy source query: ${sql}`);
    },
    async beginTransaction() { state.began = true; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() { state.released = true; },
  };
  return { pool: { async getConnection() { return connection; } }, state };
}

test("legacy source reader takes a consistent snapshot and selects only discovered allow-listed columns", async () => {
  const { pool, state } = sourcePool();
  const snapshot = await readLegacyIdentitySnapshot(pool);
  assert.equal(state.began, true);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.released, true);
  assert.equal(snapshot.users[0].id, 4);
  assert.equal(snapshot.users[0].user_uid, undefined);
  assert.ok(state.queries.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
  const userQuery = state.queries.find((sql) => sql.startsWith("SELECT `id`"));
  assert.match(userQuery, /`username`/);
  assert.doesNotMatch(userQuery, /user_uid|profile_image|last_login_at/);
});

test("legacy source reader rolls back and releases when required schema columns are missing", async () => {
  const { pool, state } = sourcePool(["id", "email"]);
  await assert.rejects(readLegacyIdentitySnapshot(pool), /missing required identity columns/);
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
});

test("target preflight reports conflicts without logging target email or username", async () => {
  let params;
  const pool = {
    async execute(_sql, values) {
      params = values;
      return [[{ id: 2, legacy_user_id: null }], []];
    },
  };
  const conflicts = await findLegacyIdentityTargetConflicts(pool, {
    users: [{ legacyUserId: 4, usernameNormalized: "reader", emailNormalized: "reader@example.test", legacyUid: null }],
  });
  assert.deepEqual(conflicts, [4]);
  assert.deepEqual(params, [4, "reader", "reader@example.test", null, null]);
});

function targetPool(execute) {
  const state = { calls: [], began: false, committed: false, rolledBack: false, released: false };
  const connection = {
    async execute(sql, params) {
      state.calls.push({ sql, params });
      return execute(sql, params);
    },
    async beginTransaction() { state.began = true; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() { state.released = true; },
  };
  return { pool: { async getConnection() { return connection; } }, state };
}

test("target transaction rejects an already completed import and rolls back", async () => {
  const { pool, state } = targetPool(async () => [[{ import_key: "legacy_identity_v1" }], []]);
  const target = createMysqlLegacyIdentityTarget(pool);
  await assert.rejects(
    target.transaction((tx) => tx.assertImportCanStart("legacy_identity_v1")),
    /already completed/,
  );
  assert.equal(state.began, true);
  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
  assert.match(state.calls[0].sql, /wf_data_imports/);
});

test("target transaction requires an empty identity table before the import", async () => {
  const { pool, state } = targetPool(async (sql) => {
    if (sql.includes("wf_data_imports")) return [[], []];
    if (sql.includes("FROM wf_users")) return [[{ id: 6 }], []];
    throw new Error(`Unexpected target query: ${sql}`);
  });
  const target = createMysqlLegacyIdentityTarget(pool);
  await assert.rejects(
    target.transaction((tx) => tx.assertImportCanStart("legacy_identity_v1")),
    /requires an empty user table/,
  );
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
  assert.equal(state.calls.length, 2);
});

test("target transaction records the completion checksum in the same transaction", async () => {
  const { pool, state } = targetPool(async () => [[], []]);
  const target = createMysqlLegacyIdentityTarget(pool);
  const summary = { users: 2, roles: 1 };
  const checksum = "a".repeat(64);
  await target.transaction((tx) => tx.recordImport({
    importKey: "legacy_identity_v1",
    sourceChecksum: checksum,
    summary,
  }));
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.released, true);
  assert.match(state.calls[0].sql, /INSERT INTO wf_data_imports/);
  assert.deepEqual(state.calls[0].params, ["legacy_identity_v1", checksum, JSON.stringify(summary)]);
});

test("target identity adapter refuses to update a previously linked legacy account", async () => {
  const { pool, state } = targetPool(async (sql) => {
    if (sql.includes("WHERE legacy_user_id = ?")) return [[{ id: 44 }], []];
    if (sql.includes("WHERE username_normalized = ?")) return [[], []];
    throw new Error(`Unexpected identity write: ${sql}`);
  });
  const target = createMysqlLegacyIdentityTarget(pool);
  await assert.rejects(target.transaction((tx) => tx.upsertUser({
    legacyUserId: 4,
    usernameNormalized: "reader",
    emailNormalized: "reader@example.test",
    legacyUid: null,
  })), /conflicts with an existing Node identity/);
  assert.equal(state.rolledBack, true);
  assert.ok(state.calls.every(({ sql }) => sql.trimStart().startsWith("SELECT")));
});
