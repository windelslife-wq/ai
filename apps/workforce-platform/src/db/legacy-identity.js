import { createHash } from "node:crypto";

const LEGACY_IDENTITY_IMPORT_KEY = "legacy_identity_v1";
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;
const KEY = /^[a-z][a-z0-9_.-]{0,95}$/;

function rows(snapshot, key) {
  if (!snapshot || !Array.isArray(snapshot[key])) throw new Error(`Legacy identity snapshot is missing the ${key} table rows`);
  return snapshot[key];
}

function id(value, context) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${context} has an invalid legacy ID`);
  return parsed;
}

function text(value, context, maxLength) {
  if (typeof value !== "string") throw new Error(`${context} must be text`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) throw new Error(`${context} is empty or too long`);
  return cleaned;
}

function dateValue(value, context, nullable = false) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (value === null || value === undefined || value === "") throw new Error(`${context} is required`);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${context} is invalid`);
    return new Date(value.getTime());
  }
  let raw = String(value).trim();
  if (!raw) {
    if (nullable) return null;
    throw new Error(`${context} is required`);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) raw = raw.replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += "Z";
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${context} is invalid`);
  return parsed;
}

function activeValue(value, legacyUserId) {
  if (value === true || value === 1 || value === "1") return "active";
  if (value === false || value === 0 || value === "0") return "inactive";
  throw new Error(`Legacy user ${legacyUserId} has an invalid active flag`);
}

function ensureUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (value === null || value === undefined) continue;
    if (seen.has(value)) throw new Error(`Legacy identity data contains a duplicate ${label}`);
    seen.add(value);
  }
}

export function createLegacyIdentityPlan(snapshot) {
  const sourceUsers = rows(snapshot, "users");
  if (!sourceUsers.length) throw new Error("The legacy identity source contains no users; refusing an empty import");

  const users = sourceUsers.map((row) => {
    const legacyUserId = id(row.id, "Legacy user");
    const email = text(row.email, `Legacy user ${legacyUserId} email`, 254);
    if (!email.includes("@") || /\s/.test(email)) throw new Error(`Legacy user ${legacyUserId} has an invalid email`);
    const normalizedEmail = email.toLowerCase();
    const usernameValue = row.username === null || row.username === undefined ? "" : String(row.username).trim().toLowerCase();
    const username = usernameValue || `legacy_${legacyUserId}`;
    if (!USERNAME.test(username)) throw new Error(`Legacy user ${legacyUserId} has an invalid username`);
    const uidValue = row.user_uid === null || row.user_uid === undefined || row.user_uid === ""
      ? null
      : String(row.user_uid).trim();
    if (uidValue !== null && !/^\d{6}$/.test(uidValue)) throw new Error(`Legacy user ${legacyUserId} has an invalid six-digit User ID`);
    const passwordHash = text(row.password_hash, `Legacy user ${legacyUserId} password hash`, 255);
    if (!BCRYPT_HASH.test(passwordHash)) throw new Error(`Legacy user ${legacyUserId} has an unsupported password hash; refusing a lockout-prone import`);
    const sourceDisplayName = row.display_name === null || row.display_name === undefined || row.display_name === ""
      ? `User ${legacyUserId}`
      : text(String(row.display_name), `Legacy user ${legacyUserId} display name`, 120);
    const profileImage = row.profile_image === null || row.profile_image === undefined || row.profile_image === ""
      ? null
      : text(String(row.profile_image), `Legacy user ${legacyUserId} profile image`, 255);

    return {
      legacyUserId,
      legacyUid: uidValue,
      username,
      usernameNormalized: username,
      email,
      emailNormalized: normalizedEmail,
      displayName: sourceDisplayName,
      profileImage,
      passwordHash,
      status: activeValue(row.active, legacyUserId),
      createdAt: dateValue(row.created_at, `Legacy user ${legacyUserId} created_at`),
      updatedAt: dateValue(row.updated_at, `Legacy user ${legacyUserId} updated_at`),
      lastLoginAt: dateValue(row.last_login_at, `Legacy user ${legacyUserId} last_login_at`, true),
    };
  });

  ensureUnique(users, "legacyUserId", "user ID");
  ensureUnique(users, "usernameNormalized", "normalized username");
  ensureUnique(users, "emailNormalized", "normalized email");
  ensureUnique(users, "legacyUid", "six-digit User ID");

  const sourceRoles = rows(snapshot, "roles");
  const roleIds = new Map();
  const roles = sourceRoles.map((row) => {
    const sourceId = id(row.id, "Legacy role");
    const key = text(row.code, `Legacy role ${sourceId} code`, 64);
    const name = text(row.name, `Legacy role ${sourceId} name`, 120);
    if (!KEY.test(key)) throw new Error(`Legacy role ${sourceId} has an invalid code`);
    if (roleIds.has(sourceId)) throw new Error("Legacy identity data contains a duplicate role ID");
    roleIds.set(sourceId, key);
    return { sourceId, key, name };
  });
  ensureUnique(roles, "key", "role code");

  const sourcePermissions = rows(snapshot, "permissions");
  const permissionIds = new Map();
  const permissions = sourcePermissions.map((row) => {
    const sourceId = id(row.id, "Legacy permission");
    const key = text(row.code, `Legacy permission ${sourceId} code`, 96);
    const name = text(row.name, `Legacy permission ${sourceId} name`, 160);
    if (!KEY.test(key)) throw new Error(`Legacy permission ${sourceId} has an invalid code`);
    if (permissionIds.has(sourceId)) throw new Error("Legacy identity data contains a duplicate permission ID");
    permissionIds.set(sourceId, key);
    return { sourceId, key, name };
  });
  ensureUnique(permissions, "key", "permission code");

  const userIds = new Set(users.map((user) => user.legacyUserId));
  const rolePermissions = rows(snapshot, "rolePermissions").map((row) => {
    const roleId = id(row.role_id, "Legacy role-permission relation");
    const permissionId = id(row.permission_id, "Legacy role-permission relation");
    const roleKey = roleIds.get(roleId);
    const permissionKey = permissionIds.get(permissionId);
    if (!roleKey || !permissionKey) throw new Error("Legacy role-permission relation references a missing row");
    return { roleKey, permissionKey };
  });
  const userRoles = rows(snapshot, "userRoles").map((row) => {
    const userId = id(row.user_id, "Legacy user-role relation");
    const roleId = id(row.role_id, "Legacy user-role relation");
    const roleKey = roleIds.get(roleId);
    if (!userIds.has(userId) || !roleKey) throw new Error("Legacy user-role relation references a missing row");
    return { legacyUserId: userId, roleKey };
  });

  const rolePermissionKeys = new Set();
  for (const relation of rolePermissions) {
    const key = `${relation.roleKey}\0${relation.permissionKey}`;
    if (rolePermissionKeys.has(key)) throw new Error("Legacy identity data contains a duplicate role-permission grant");
    rolePermissionKeys.add(key);
  }
  const userRoleKeys = new Set();
  for (const relation of userRoles) {
    const key = `${relation.legacyUserId}\0${relation.roleKey}`;
    if (userRoleKeys.has(key)) throw new Error("Legacy identity data contains a duplicate user-role assignment");
    userRoleKeys.add(key);
  }

  const checksum = createHash("sha256")
    .update(JSON.stringify({ users, roles, permissions, rolePermissions, userRoles }))
    .digest("hex");
  return { users, roles, permissions, rolePermissions, userRoles, sourceChecksum: checksum };
}

export function summarizeLegacyIdentityPlan(plan) {
  return Object.freeze({
    users: plan.users.length,
    activeUsers: plan.users.filter((user) => user.status === "active").length,
    inactiveUsers: plan.users.filter((user) => user.status === "inactive").length,
    roles: plan.roles.length,
    permissions: plan.permissions.length,
    rolePermissionGrants: plan.rolePermissions.length,
    userRoleAssignments: plan.userRoles.length,
  });
}

export async function applyLegacyIdentityPlan(target, plan) {
  return target.transaction(async (tx) => {
    await tx.assertImportCanStart(LEGACY_IDENTITY_IMPORT_KEY);
    const roleIds = new Map();
    for (const role of plan.roles) roleIds.set(role.key, await tx.upsertRole(role));

    const permissionIds = new Map();
    for (const permission of plan.permissions) {
      permissionIds.set(permission.key, await tx.upsertPermission(permission));
    }
    for (const grant of plan.rolePermissions) {
      await tx.grantRolePermission(roleIds.get(grant.roleKey), permissionIds.get(grant.permissionKey));
    }

    const targetUserIds = new Map();
    for (const user of plan.users) targetUserIds.set(user.legacyUserId, await tx.upsertUser(user));
    for (const assignment of plan.userRoles) {
      await tx.assignUserRole(targetUserIds.get(assignment.legacyUserId), roleIds.get(assignment.roleKey));
    }

    const summary = summarizeLegacyIdentityPlan(plan);
    await tx.recordImport({
      importKey: LEGACY_IDENTITY_IMPORT_KEY,
      sourceChecksum: plan.sourceChecksum,
      summary,
    });
    return summary;
  });
}
