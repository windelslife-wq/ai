/**
 * The RBAC baseline exists in two places — SQL migrations for a MySQL host and this
 * module for a file host — so both are asserted against each other here. A drift
 * would mean an adapter silently denies permissions the other grants.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFileStore } from "../src/persistence/file-store.js";
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, ROLE_GRANTS, seedPlatformBaseline } from "../src/db/platform-baseline.js";

const MIGRATIONS = path.join(import.meta.dirname, "..", "src", "db", "migrations");

function tuples(statement) {
  return [...statement.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']*)'/g)].map((match) => ({ key: match[1], displayName: match[2] }));
}

function grantBlocks(sql) {
  const blocks = [];
  for (const match of sql.matchAll(/INSERT INTO wf_role_permissions[\s\S]*?ON DUPLICATE KEY UPDATE[^\n]*/g)) {
    const body = match[0];
    const role = /r\.role_key = '([a-z_]+)'/.exec(body)?.[1];
    const keys = (body.match(/p\.permission_key IN \(([^)]*)\)/) || [])[1];
    const listed = keys ? [...keys.matchAll(/'([^']+)'/g)].map((entry) => entry[1]) : [];
    if (role) blocks.push({ role, keys: listed });
  }
  return blocks;
}

test("F-07 the SQL migrations and the code baseline seed the identical role and permission vocabulary", async () => {
  const [foundation, accounts] = await Promise.all([
    readFile(path.join(MIGRATIONS, "001_platform_foundation.sql"), "utf8"),
    readFile(path.join(MIGRATIONS, "003_account_management.sql"), "utf8"),
  ]);
  const sqlRoles = [...tuples(/INSERT INTO wf_roles[\s\S]*?ON DUPLICATE KEY[^\n]*/.exec(foundation)[0]), ...tuples(/INSERT INTO wf_roles[\s\S]*?ON DUPLICATE KEY[^\n]*/.exec(accounts)[0])];
  const sqlPermissions = [
    ...tuples(/INSERT INTO wf_permissions[\s\S]*?ON DUPLICATE KEY[^\n]*/.exec(foundation)[0]),
    ...tuples(/INSERT INTO wf_permissions[\s\S]*?ON DUPLICATE KEY[^\n]*/.exec(accounts)[0]),
  ];

  // De-duplicate by key: 001 and 003 both name super_admin, deliberately.
  const byKey = (rows) => [...new Map(rows.map((row) => [row.key, row])).values()];
  assert.deepEqual(byKey(sqlRoles).sort((a, b) => a.key.localeCompare(b.key)), PLATFORM_ROLES.map((role) => ({ key: role.key, displayName: role.displayName })).sort((a, b) => a.key.localeCompare(b.key)), "roles must match key for key, display name for display name");
  assert.deepEqual(byKey(sqlPermissions).sort((a, b) => a.key.localeCompare(b.key)), PLATFORM_PERMISSIONS.map((permission) => ({ key: permission.key, displayName: permission.displayName })).sort((a, b) => a.key.localeCompare(b.key)), "permissions must match key for key, display name for display name");

  const grants = new Map(grantBlocks(`${foundation}\n${accounts}`).map((block) => [block.role, block.keys]));
  for (const [role, keys] of Object.entries(ROLE_GRANTS)) {
    const sqlKeys = [...(grants.get(role) || [])].sort();
    const expected = [...keys].sort();
    // 001 seeds super_admin's identity permissions and 003 seeds the rest; the map
    // above collapses per statement, so compare as a set union across both files.
    if (role === "super_admin") {
      assert.deepEqual([...new Set(sqlKeys)].sort(), expected, "super_admin must be granted the whole vocabulary");
      assert.equal(expected.length, PLATFORM_PERMISSIONS.length);
      continue;
    }
    assert.deepEqual(sqlKeys, expected, `${role} grants drifted`);
  }
});

test("F-07 seeding is idempotent and leaves the store administrable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-seed-"));
  const store = await createFileStore({ dir, syncWrites: false });
  try {
    const first = await seedPlatformBaseline(store);
    assert.equal(first.roles, PLATFORM_ROLES.length);
    assert.equal(first.permissions, PLATFORM_PERMISSIONS.length);
    assert.equal(first.admin, null);
    assert.match(first.skipped || /./, /seed:platform|identity import/, "a store with no accounts is reported, not silently accepted");
    const { total: roleTotal } = { total: (await store.listRoles()).length };
    assert.equal(roleTotal, PLATFORM_ROLES.length);
    assert.equal((await store.listPermissions()).length, PLATFORM_PERMISSIONS.length);
    const statsAfterFirst = await store.stats();

    const second = await seedPlatformBaseline(store);
    assert.deepEqual(await store.stats(), statsAfterFirst, "a second seed must not duplicate any row");
    assert.equal(second.roles, first.roles);

    const superAdmin = (await store.listRoles()).find((role) => role.role_key === "super_admin");
    const granted = await store.listPermissions().then(async (permissions) => {
      const rolePermissions = new Set();
      for (const permission of permissions) rolePermissions.add(permission.permission_key);
      return rolePermissions;
    });
    assert.ok(granted.has("system.super_admin"));
    assert.ok(superAdmin.id >= 1);

    const admin = await seedPlatformBaseline(store, { admin: { username: "seedroot", password: "a long administrator password", email: "seedroot@example.test" } });
    assert.equal(admin.admin.created, true);
    const again = await seedPlatformBaseline(store, { admin: { username: "seedroot", password: "a long administrator password", email: "seedroot@example.test" } });
    assert.equal(again.admin.created, false, "a second run must not create a duplicate administrator");
    assert.deepEqual(await store.permissionsForUser(admin.admin.id), [...PLATFORM_PERMISSIONS.map((permission) => permission.key)].sort());
    const audit = await store.listAuditEvents({ action: "admin.user" });
    assert.equal(audit.total, 1, "the bootstrap is audited exactly once");
  } finally {
    await store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-07 the bootstrap password meets the administrator minimum", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-seed-pw-"));
  const store = await createFileStore({ dir, syncWrites: false });
  try {
    await assert.rejects(
      seedPlatformBaseline(store, { admin: { username: "weakroot", password: "short" } }),
      /at least 14 characters|between 14 and 1024/,
      "a weakly seeded administrator is the worst possible default",
    );
  } finally {
    await store.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
