/**
 * The role and permission baseline, in code.
 *
 * Migrations 001 and 003 seed the same matrix in SQL for a MySQL host, and
 * `tools/seed-platform.mjs` seeds it through the repository contract for a file
 * host (and is idempotent on either). `test/platform_baseline.test.js` asserts the
 * SQL and this list agree, so the vocabulary can never drift apart per adapter.
 *
 * The keys and display names are copied from the legacy application
 * (`tools/rbac.php`), which remains authoritative until every module is ported.
 */

export const SUPER_ADMIN_PERMISSION = "system.super_admin";

export const PLATFORM_ROLES = Object.freeze([
  { key: "super_admin", displayName: "Super administrator" },
  { key: "sports_admin", displayName: "Sports administrator" },
  { key: "sports_viewer", displayName: "Sports viewer" },
  { key: "trading_operator", displayName: "Trading operator (control + execution)" },
  { key: "trading_viewer", displayName: "Trading viewer (read-only)" },
  { key: "lottery_admin", displayName: "Lottery administrator" },
  { key: "lottery_viewer", displayName: "Lottery viewer" },
  { key: "platform_member", displayName: "Platform member" },
  // Present in the legacy schema since 001; kept so an imported row still resolves.
  { key: "user", displayName: "User" },
]);

export const PLATFORM_PERMISSIONS = Object.freeze([
  { key: "identity.users.view", displayName: "View user accounts" },
  { key: "identity.users.manage", displayName: "Manage user accounts" },
  { key: "system.health.view", displayName: "View system health" },
  { key: "system.super_admin", displayName: "Full platform administration" },
  { key: "system.authenticated", displayName: "Signed-in member baseline" },
  { key: "sports.view", displayName: "View sports intelligence" },
  { key: "sports.manage", displayName: "Manage sports providers and configuration" },
  { key: "sports.approve", displayName: "Approve sports tickets" },
  { key: "sports.settle", displayName: "Override sports settlements" },
  { key: "trading.view", displayName: "View trading status, proposals and executions" },
  { key: "trading.control", displayName: "Kill switch, trading mode, risk and automation limits" },
  { key: "trading.execute", displayName: "Propose, approve and route trades through the Execution Supervisor" },
  { key: "lottery.view", displayName: "View lottery intelligence (draws, statistics, tickets, performance)" },
  { key: "lottery.manage", displayName: "Manage lottery providers, data sync and configuration" },
]);

/**
 * Which permissions each role holds. `super_admin` additionally short-circuits
 * every check in `userHasPermission`, exactly like `Identity::can()` did, so the
 * entry below lists the full vocabulary for auditing rather than for matching.
 */
export const ROLE_GRANTS = Object.freeze({
  super_admin: PLATFORM_PERMISSIONS.map((permission) => permission.key),
  sports_admin: ["sports.view", "sports.manage", "sports.approve", "sports.settle"],
  sports_viewer: ["sports.view"],
  trading_operator: ["trading.view", "trading.control", "trading.execute"],
  trading_viewer: ["trading.view"],
  lottery_admin: ["lottery.view", "lottery.manage"],
  lottery_viewer: ["lottery.view"],
  platform_member: ["trading.view", "sports.view", "lottery.view"],
  user: [],
});

/**
 * Idempotent baseline seed through the repository contract, plus an optional
 * first-administrator bootstrap for a host that has no imported identity.
 *
 * @returns {Promise<{roles: number, permissions: number, grants: number, admin: object|null, skipped: string|null}>}
 */
export async function seedPlatformBaseline(store, { admin = null, logger = console } = {}) {
  let roles = 0;
  let permissions = 0;
  let grants = 0;

  const roleByName = new Map();
  for (const role of PLATFORM_ROLES) {
    const existing = (await store.listRoles()).find((entry) => entry.role_key === role.key);
    const record = existing || (await store.ensureRole(role.key, role.displayName));
    roleByName.set(role.key, record);
    roles += 1;
  }
  const permissionByName = new Map();
  for (const permission of PLATFORM_PERMISSIONS) {
    const existing = (await store.listPermissions()).find((entry) => entry.permission_key === permission.key);
    const record = existing || (await store.ensurePermission(permission.key, permission.displayName));
    permissionByName.set(permission.key, record);
    permissions += 1;
  }

  const superAdminRole = roleByName.get("super_admin");
  for (const [roleKey, keys] of Object.entries(ROLE_GRANTS)) {
    const role = roleByName.get(roleKey);
    if (!role) continue;
    for (const key of keys) {
      const permission = permissionByName.get(key);
      if (!permission) throw new Error(`Baseline references an unknown permission: ${key}`);
      await store.grantRolePermission(role.id, permission.id);
      if (roleKey !== "super_admin" || permission.key !== SUPER_ADMIN_PERMISSION) grants += 1;
    }
  }

  let adminResult = null;
  let skipped = null;
  if (admin) {
    const existingAdmin = await store.findUserByIdentifier(admin.username);
    if (existingAdmin) {
      await store.assignRole(existingAdmin.id, superAdminRole.id);
      adminResult = { id: existingAdmin.id, username: existingAdmin.username, created: false };
    } else {
      const { hashPassword } = await import("../security/passwords.js");
      const passwordHash = await hashPassword(admin.password, { minLength: 14 });
      const created = await store.createUser({
        username: admin.username,
        email: admin.email || null,
        passwordHash,
        displayName: admin.displayName || admin.username,
        status: "active",
      });
      await store.assignRole(created.id, superAdminRole.id);
      await store.recordAudit({
        actorId: created.id,
        action: "admin.user.bootstrap",
        entityType: "identity",
        entityId: created.id,
        details: { method: "seed-platform", role: "super_admin" },
      });
      adminResult = { id: created.id, username: created.username, created: true };
      logger.warn?.({ message: `Bootstrapped the first administrator account "${created.username}". Change its password after the first sign-in.` });
    }
  } else if (await hasSuperAdmin(store) === false) {
    // A host with accounts but no administrator is a dead end: nothing can be
    // administered. Say so instead of reporting a clean seed.
    skipped = "no account holds system.super_admin; pass --admin-username and --admin-password (or run the legacy identity import) to create one";
  }

  return { roles, permissions, grants, admin: adminResult, skipped };
}

async function hasSuperAdmin(store) {
  let users = [];
  try {
    users = await store.listUsers(100);
  } catch {
    return true; // An adapter that cannot list users is not a state to report on.
  }
  for (const user of users) {
    const permissions = await store.permissionsForUser(user.id);
    if (permissions.includes(SUPER_ADMIN_PERMISSION)) return true;
  }
  return false;
}
