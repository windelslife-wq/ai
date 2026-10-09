import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/db/store.js";

test("database readiness requires every ordered Node identity migration and reports the adapter", async () => {
  const calls = [];
  const pool = {
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT 1")) return [[{ healthy: 1 }], []];
      return [[{ migration_name: "001_platform_foundation" }], []];
    },
  };
  const readiness = await createStore(pool).readiness();
  assert.deepEqual(readiness, { database: true, schema: false, adapter: "mysql", detail: null });
  assert.match(calls[1].sql, /IN \(\?, \?, \?, \?, \?\)/);
  assert.deepEqual(calls[1].values, [
    "001_platform_foundation",
    "002_identity_import_fields",
    "003_account_management",
    "004_public_site",
    "005_analysis_runs",
  ]);
});

test("database outage is reported as an unreachable adapter, never as a healthy database", async () => {
  const refused = new Error("connect ECONNREFUSED 127.0.0.1:3306");
  refused.code = "ECONNREFUSED";
  const pool = { async execute() { throw refused; } };
  const readiness = await createStore(pool).readiness();
  assert.deepEqual(readiness, { database: false, schema: false, adapter: "mysql", detail: "unreachable" });
  assert.equal(JSON.stringify(readiness).includes("3306"), false);
});

test("user lookup normalizes identifiers and uses bound parameters", async () => {
  let query;
  const pool = {
    async execute(sql, values) {
      query = { sql, values };
      return [[{ id: 9, username: "alice" }], []];
    },
  };
  const user = await createStore(pool).findUserByIdentifier("  ALICE@example.test ");
  assert.equal(user.id, 9);
  assert.deepEqual(query.values, ["alice@example.test", "alice@example.test", "alice@example.test"]);
  assert.match(query.sql, /username_normalized = \? OR email_normalized = \? OR legacy_uid = \?/);
});

test("session rehydration returns profile data and a deduplicated permission set", async () => {
  const pool = {
    async execute() {
      return [[
        { user_id: 9, legacy_uid: "000009", username: "alice", email: "alice@example.test", display_name: "Alice", profile_image: null, permission_key: "trading.view" },
        { user_id: 9, legacy_uid: "000009", username: "alice", email: "alice@example.test", display_name: "Alice", profile_image: null, permission_key: "trading.view" },
        { user_id: 9, legacy_uid: "000009", username: "alice", email: "alice@example.test", display_name: "Alice", profile_image: null, permission_key: "sports.view" },
      ], []];
    },
  };
  const session = await createStore(pool).findSession("a".repeat(64));
  assert.deepEqual(session.user, {
    id: 9,
    legacyUid: "000009",
    username: "alice",
    email: "alice@example.test",
    displayName: "Alice",
    profileImage: null,
  });
  assert.deepEqual(session.permissions, ["trading.view", "sports.view"]);
});

test("admin user list limit is bounded before interpolation", async () => {
  let sql;
  const pool = {
    async query(statement) { sql = statement; return [[], []]; },
  };
  await createStore(pool).listUsers("1; DROP TABLE wf_users");
  assert.match(sql, /LIMIT 100$/);
  assert.doesNotMatch(sql, /DROP TABLE/);
});
