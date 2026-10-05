import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  applyLegacyIdentityPlan,
  createLegacyIdentityPlan,
  summarizeLegacyIdentityPlan,
} from "../src/db/legacy-identity.js";

const passwordHash = (await bcrypt.hash("legacy account password", 4)).replace("$2b$", "$2y$");
const timestamp = "2026-09-15T10:30:00+00:00";

function fixture(overrides = {}) {
  return {
    users: [{
      id: 41,
      email: "ADMIN@example.test",
      password_hash: passwordHash,
      display_name: "Operations Admin",
      active: 1,
      created_at: timestamp,
      updated_at: timestamp,
      last_login_at: null,
      username: "ops_admin",
      user_uid: "000041",
      profile_image: "uploads/avatar-41.png",
    }],
    roles: [{ id: 2, code: "super_admin", name: "Super administrator" }],
    permissions: [{ id: 3, code: "system.super_admin", name: "Full platform administration" }],
    userRoles: [{ user_id: 41, role_id: 2 }],
    rolePermissions: [{ role_id: 2, permission_id: 3 }],
    ...overrides,
  };
}

function makeFakeTarget() {
  const state = {
    roles: new Map(),
    permissions: new Map(),
    grants: new Set(),
    users: new Map(),
    profiles: new Map(),
    assignments: new Set(),
    imports: new Map(),
    transactions: 0,
  };
  const target = {
    async transaction(operation) {
      state.transactions += 1;
      const tx = {
        async assertImportCanStart(key) {
          if (state.imports.has(key)) throw new Error("Import already completed");
        },
        async upsertRole(role) {
          if (!state.roles.has(role.key)) state.roles.set(role.key, state.roles.size + 1);
          return state.roles.get(role.key);
        },
        async upsertPermission(permission) {
          if (!state.permissions.has(permission.key)) state.permissions.set(permission.key, state.permissions.size + 1);
          return state.permissions.get(permission.key);
        },
        async grantRolePermission(roleId, permissionId) { state.grants.add(`${roleId}:${permissionId}`); },
        async upsertUser(user) {
          if (!state.users.has(user.legacyUserId)) state.users.set(user.legacyUserId, state.users.size + 1);
          const targetId = state.users.get(user.legacyUserId);
          state.profiles.set(targetId, { displayName: user.displayName, profileImage: user.profileImage, lastLoginAt: user.lastLoginAt });
          return targetId;
        },
        async assignUserRole(userId, roleId) { state.assignments.add(`${userId}:${roleId}`); },
        async recordImport(record) { state.imports.set(record.importKey, record); },
      };
      return operation(tx);
    },
  };
  return { target, state };
}

test("legacy identity plan preserves bcrypt hashes, profile fields, roles and permission grants", () => {
  const plan = createLegacyIdentityPlan(fixture());
  assert.equal(plan.users[0].legacyUserId, 41);
  assert.equal(plan.users[0].emailNormalized, "admin@example.test");
  assert.equal(plan.users[0].usernameNormalized, "ops_admin");
  assert.equal(plan.users[0].legacyUid, "000041");
  assert.equal(plan.users[0].passwordHash, passwordHash);
  assert.equal(plan.users[0].displayName, "Operations Admin");
  assert.equal(plan.users[0].profileImage, "uploads/avatar-41.png");
  assert.equal(plan.users[0].createdAt.toISOString(), "2026-09-15T10:30:00.000Z");
  assert.deepEqual(summarizeLegacyIdentityPlan(plan), {
    users: 1,
    activeUsers: 1,
    inactiveUsers: 0,
    roles: 1,
    permissions: 1,
    rolePermissionGrants: 1,
    userRoleAssignments: 1,
  });
  assert.equal(JSON.stringify(summarizeLegacyIdentityPlan(plan)).includes(passwordHash), false);
});

test("legacy identity plan uses stable usernames for pre-username records and keeps inactive users", () => {
  const source = fixture({
    users: [{
      id: 7,
      email: "old@example.test",
      password_hash: passwordHash,
      display_name: "Old Account",
      active: 0,
      created_at: timestamp,
      updated_at: timestamp,
      username: null,
      user_uid: null,
      profile_image: null,
    }],
    userRoles: [],
  });
  const plan = createLegacyIdentityPlan(source);
  assert.equal(plan.users[0].username, "legacy_7");
  assert.equal(plan.users[0].legacyUid, null);
  assert.equal(plan.users[0].status, "inactive");
  assert.equal(summarizeLegacyIdentityPlan(plan).inactiveUsers, 1);
});

test("legacy identity plan rejects normalized collisions and unsupported password hashes", () => {
  const duplicate = fixture({ users: [
    ...fixture().users,
    { ...fixture().users[0], id: 42, username: "other_user", user_uid: "000042" },
  ] });
  assert.throws(() => createLegacyIdentityPlan(duplicate), /duplicate normalized email/);
  assert.throws(() => createLegacyIdentityPlan(fixture({ users: [{ ...fixture().users[0], password_hash: "plaintext" }] })), /unsupported password hash/);
  assert.throws(() => createLegacyIdentityPlan(fixture({ users: [] })), /contains no users/);
});

test("legacy identity plan rejects dangling role/user relationships instead of dropping grants", () => {
  assert.throws(() => createLegacyIdentityPlan(fixture({ userRoles: [{ user_id: 999, role_id: 2 }] })), /references a missing row/);
  assert.throws(() => createLegacyIdentityPlan(fixture({ rolePermissions: [{ role_id: 2, permission_id: 999 }] })), /references a missing row/);
});

test("identity import applies once, records a checksum, and refuses an unsafe replay", async () => {
  const plan = createLegacyIdentityPlan(fixture());
  const { target, state } = makeFakeTarget();
  const first = await applyLegacyIdentityPlan(target, plan);
  assert.deepEqual(first, summarizeLegacyIdentityPlan(plan));
  await assert.rejects(applyLegacyIdentityPlan(target, plan), /already completed/);
  assert.equal(state.transactions, 2);
  assert.equal(state.users.size, 1);
  assert.equal(state.roles.size, 1);
  assert.equal(state.permissions.size, 1);
  assert.equal(state.grants.size, 1);
  assert.equal(state.assignments.size, 1);
  assert.equal(state.imports.size, 1);
  assert.equal(state.imports.get("legacy_identity_v1").sourceChecksum, plan.sourceChecksum);
  assert.equal(state.profiles.get(1).displayName, "Operations Admin");
});
