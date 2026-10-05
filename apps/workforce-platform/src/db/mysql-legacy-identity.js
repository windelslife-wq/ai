const OPTIONAL_USER_COLUMNS = ["username", "user_uid", "profile_image", "last_login_at"];
const REQUIRED_USER_COLUMNS = ["id", "email", "password_hash", "display_name", "active", "created_at", "updated_at"];
const ALL_USER_COLUMNS = ["id", "email", "password_hash", "display_name", "active", "created_at", "updated_at", ...OPTIONAL_USER_COLUMNS];

export async function readLegacyIdentitySnapshot(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();

    const [userColumns] = await connection.query("SHOW COLUMNS FROM `users`");
    const available = new Set(userColumns.map((column) => column.Field));
    const missing = REQUIRED_USER_COLUMNS.filter((column) => !available.has(column));
    if (missing.length) throw new Error(`Legacy users table is missing required identity columns: ${missing.join(", ")}`);
    const selectedUserColumns = ALL_USER_COLUMNS.filter((column) => available.has(column));
    const userSql = `SELECT ${selectedUserColumns.map((column) => `\`${column}\``).join(", ")} FROM users ORDER BY id ASC`;
    const [users] = await connection.query(userSql);
    const [roles] = await connection.query("SELECT id, code, name FROM roles ORDER BY id ASC");
    const [permissions] = await connection.query("SELECT id, code, name FROM permissions ORDER BY id ASC");
    const [userRoles] = await connection.query("SELECT user_id, role_id FROM user_roles ORDER BY user_id, role_id");
    const [rolePermissions] = await connection.query("SELECT role_id, permission_id FROM role_permissions ORDER BY role_id, permission_id");

    await connection.commit();
    return { users, roles, permissions, userRoles, rolePermissions };
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

export async function findLegacyIdentityTargetConflicts(pool, plan) {
  const conflicts = [];
  for (const user of plan.users) {
    const [rows] = await pool.execute(
      `SELECT id, legacy_user_id FROM wf_users
        WHERE legacy_user_id = ? OR username_normalized = ? OR email_normalized = ?
           OR (? IS NOT NULL AND legacy_uid = ?)`,
      [user.legacyUserId, user.usernameNormalized, user.emailNormalized, user.legacyUid, user.legacyUid],
    );
    if (rows.length) conflicts.push(user.legacyUserId);
  }
  return conflicts;
}

export function createMysqlLegacyIdentityTarget(pool) {
  return {
    async transaction(operation) {
      const connection = await pool.getConnection();
      let transactionOpen = false;
      try {
        await connection.beginTransaction();
        transactionOpen = true;
        const tx = {
          async assertImportCanStart(importKey) {
            const [rows] = await connection.execute(
              "SELECT import_key FROM wf_data_imports WHERE import_key = ? LIMIT 1 FOR UPDATE",
              [importKey],
            );
            if (rows.length) throw new Error(`Import ${importKey} has already completed; replay is disabled`);
            const [existingUsers] = await connection.execute(
              "SELECT id FROM wf_users ORDER BY id ASC LIMIT 1 FOR UPDATE",
            );
            if (existingUsers.length) {
              throw new Error("Node identity target is not empty; the one-time legacy import requires an empty user table");
            }
          },

          async upsertRole(role) {
            await connection.execute(
              `INSERT INTO wf_roles (role_key, display_name, created_at)
               VALUES (?, ?, UTC_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE role_key = VALUES(role_key)`,
              [role.key, role.name],
            );
            const [rows] = await connection.execute("SELECT id FROM wf_roles WHERE role_key = ? LIMIT 1", [role.key]);
            if (!rows.length) throw new Error("Unable to resolve imported role");
            return rows[0].id;
          },

          async upsertPermission(permission) {
            await connection.execute(
              `INSERT INTO wf_permissions (permission_key, display_name, created_at)
               VALUES (?, ?, UTC_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE permission_key = VALUES(permission_key)`,
              [permission.key, permission.name],
            );
            const [rows] = await connection.execute(
              "SELECT id FROM wf_permissions WHERE permission_key = ? LIMIT 1",
              [permission.key],
            );
            if (!rows.length) throw new Error("Unable to resolve imported permission");
            return rows[0].id;
          },

          async grantRolePermission(roleId, permissionId) {
            await connection.execute(
              `INSERT INTO wf_role_permissions (role_id, permission_id, created_at)
               VALUES (?, ?, UTC_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
              [roleId, permissionId],
            );
          },

          async upsertUser(user) {
            const [mappedRows] = await connection.execute(
              "SELECT id FROM wf_users WHERE legacy_user_id = ? LIMIT 1 FOR UPDATE",
              [user.legacyUserId],
            );
            const [collisions] = await connection.execute(
              `SELECT id FROM wf_users
                WHERE username_normalized = ? OR email_normalized = ?
                   OR (? IS NOT NULL AND legacy_uid = ?)
                LIMIT 1 FOR UPDATE`,
              [user.usernameNormalized, user.emailNormalized, user.legacyUid, user.legacyUid],
            );
            if (mappedRows.length || collisions.length) {
              throw new Error(`Legacy user ${user.legacyUserId} conflicts with an existing Node identity; resolve it explicitly before import`);
            }

            const [result] = await connection.execute(
              `INSERT INTO wf_users
                (legacy_user_id, legacy_uid, username, username_normalized, email, email_normalized,
                 password_hash, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [user.legacyUserId, user.legacyUid, user.username, user.usernameNormalized, user.email,
                user.emailNormalized, user.passwordHash, user.status, user.createdAt, user.updatedAt],
            );
            const targetId = result.insertId;
            await connection.execute(
              `INSERT INTO wf_user_profiles (user_id, display_name, profile_image, last_login_at)
               VALUES (?, ?, ?, ?)`,
              [targetId, user.displayName, user.profileImage, user.lastLoginAt],
            );
            return targetId;
          },

          async assignUserRole(userId, roleId) {
            await connection.execute(
              `INSERT INTO wf_user_roles (user_id, role_id, created_at)
               VALUES (?, ?, UTC_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
              [userId, roleId],
            );
          },

          async recordImport({ importKey, sourceChecksum, summary }) {
            await connection.execute(
              `INSERT INTO wf_data_imports (import_key, source_checksum, summary_json, completed_at)
               VALUES (?, ?, ?, UTC_TIMESTAMP(3))`,
              [importKey, sourceChecksum, JSON.stringify(summary)],
            );
          },
        };
        const result = await operation(tx);
        await connection.commit();
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) {
          try { await connection.rollback(); } catch {}
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
