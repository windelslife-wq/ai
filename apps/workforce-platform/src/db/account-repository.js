/**
 * Account-management SQL for the MySQL/MariaDB adapter.
 *
 * Every statement is parameterized. Sort and filter column names are resolved
 * through allow-lists and never interpolated from client input; LIMIT/OFFSET are
 * coerced to bounded integers before interpolation (mysql2 does not bind them
 * reliably as placeholders in `LIMIT`).
 */

const SORT_COLUMNS = Object.freeze({
  id: "u.id",
  username: "u.username",
  email: "u.email",
  status: "u.status",
  createdAt: "u.created_at",
  lastLogin: "up.last_login_at",
});

const AUDIT_SORT_COLUMNS = Object.freeze({ id: "id", createdAt: "created_at", action: "action_key" });

function boundedInteger(value, { fallback, min = 1, max = 200 }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function directionOf(value) {
  return String(value).toLowerCase() === "desc" ? "DESC" : "ASC";
}

/** `LIKE` wildcards in a search term are escaped; the term stays a bound value. */
function likeTerm(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`).slice(0, 80)}%`;
}

export function createAccountRepository(pool) {
  const api = {
    async pageUsers({ limit = 25, offset = 0, search = null, status = null, sort = "id", direction = "asc" } = {}) {
      const boundedLimit = boundedInteger(limit, { fallback: 25, max: 200 });
      const boundedOffset = boundedInteger(offset, { fallback: 0, min: 0, max: 1_000_000 });
      const orderBy = SORT_COLUMNS[sort] || SORT_COLUMNS.id;
      const where = [];
      const values = [];
      if (search) {
        where.push("(LOWER(u.username) LIKE ? OR LOWER(COALESCE(u.email, '')) LIKE ? OR u.legacy_uid LIKE ?)");
        const term = likeTerm(String(search).toLowerCase());
        values.push(term, term, term);
      }
      if (status) {
        where.push("u.status = ?");
        values.push(status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[countRow]] = await pool.query(
        `SELECT COUNT(*) AS total FROM wf_users u ${clause}`,
        values,
      );
      const [rows] = await pool.query(
        `SELECT u.id, u.legacy_uid, u.username, u.email, u.status, u.created_at,
                up.display_name, up.profile_image, up.last_login_at
           FROM wf_users u
           LEFT JOIN wf_user_profiles up ON up.user_id = u.id
          ${clause}
          ORDER BY ${orderBy} ${directionOf(direction)}, u.id ASC
          LIMIT ${boundedLimit} OFFSET ${boundedOffset}`,
        values,
      );
      return {
        total: Number(countRow?.total ?? 0),
        users: rows.map((row) => ({
          id: row.id,
          legacyUid: row.legacy_uid ?? null,
          username: row.username,
          email: row.email ?? null,
          status: row.status,
          displayName: row.display_name || row.username,
          avatar: row.profile_image ? { url: row.profile_image } : null,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at ?? null,
        })),
      };
    },

    async findUserById(id) {
      const [rows] = await pool.execute(
        `SELECT id, legacy_user_id, legacy_uid, username, email, password_hash, status, created_at, updated_at
           FROM wf_users WHERE id = ? LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async usernameTaken(username, excludeId = null) {
      const [rows] = await pool.execute(
        excludeId
          ? "SELECT id FROM wf_users WHERE username_normalized = ? AND id <> ? LIMIT 1"
          : "SELECT id FROM wf_users WHERE username_normalized = ? LIMIT 1",
        excludeId ? [String(username).toLowerCase(), excludeId] : [String(username).toLowerCase()],
      );
      return Boolean(rows.length);
    },

    async emailTaken(email, excludeId = null) {
      const [rows] = await pool.execute(
        excludeId
          ? "SELECT id FROM wf_users WHERE email_normalized = ? AND id <> ? LIMIT 1"
          : "SELECT id FROM wf_users WHERE email_normalized = ? LIMIT 1",
        excludeId ? [String(email).toLowerCase(), excludeId] : [String(email).toLowerCase()],
      );
      return Boolean(rows.length);
    },

    /**
     * Inserts a user and (when supplied) a display name in one transaction,
     * allocating a unique six-digit ID with bounded retries — the legacy
     * `createUser` behaviour ported without its race conditions.
     */
    async createUser({ username, email = null, passwordHash, displayName = null, status = "active", legacyUserId = null, legacyUid = null, avatarPath = null }) {
      const normalizedUsername = String(username).trim().toLowerCase();
      const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const uid = await allocateUniqueUid(connection, legacyUid);
        const [result] = await connection.execute(
          `INSERT INTO wf_users
             (legacy_user_id, legacy_uid, username, username_normalized, email, email_normalized, password_hash, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
          [legacyUserId, uid, normalizedUsername, normalizedUsername, normalizedEmail, normalizedEmail, passwordHash, status],
        );
        const userId = result.insertId;
        await connection.execute(
          `INSERT INTO wf_user_profiles (user_id, display_name, profile_image, last_login_at)
           VALUES (?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), profile_image = VALUES(profile_image)`,
          [userId, displayName || normalizedUsername, avatarPath],
        );
        await connection.commit();
        const [rows] = await connection.query(
          `SELECT id, legacy_user_id, legacy_uid, username, email, status, created_at, updated_at
             FROM wf_users WHERE id = ? LIMIT 1`,
          [userId],
        );
        return rows[0] ? { ...rows[0], password_hash: passwordHash } : { id: userId, username: normalizedUsername, email: normalizedEmail, status, password_hash: passwordHash };
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },

    /**
     * Partial update. Only the declared columns can be written, and each one is
     * whitelisted rather than built from the caller's key names.
     */
    async updateUser(id, patch) {
      const assignments = [];
      const values = [];
      if (patch.username !== undefined) {
        assignments.push("username = ?", "username_normalized = ?");
        values.push(String(patch.username).trim(), String(patch.username).trim().toLowerCase());
      }
      if (patch.email !== undefined) {
        const email = patch.email === null ? null : String(patch.email).trim().toLowerCase();
        assignments.push("email = ?", "email_normalized = ?");
        values.push(email, email);
      }
      if (patch.passwordHash !== undefined) {
        assignments.push("password_hash = ?");
        values.push(patch.passwordHash);
      }
      if (patch.status !== undefined) {
        assignments.push("status = ?");
        values.push(patch.status);
      }
      if (patch.lastLoginAt !== undefined) {
        await pool.execute(
          `INSERT INTO wf_user_profiles (user_id, display_name, profile_image, last_login_at)
           VALUES (?, '', NULL, ?)
           ON DUPLICATE KEY UPDATE last_login_at = VALUES(last_login_at)`,
          [id, patch.lastLoginAt],
        );
      }
      if (patch.displayName !== undefined) {
        await pool.execute(
          `INSERT INTO wf_user_profiles (user_id, display_name, profile_image)
           VALUES (?, ?, NULL)
           ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
          [id, patch.displayName],
        );
      }
      if (patch.profileImage !== undefined) {
        await pool.execute(
          `INSERT INTO wf_user_profiles (user_id, display_name, profile_image)
           VALUES (?, '', ?)
           ON DUPLICATE KEY UPDATE profile_image = VALUES(profile_image)`,
          [id, patch.profileImage],
        );
      }
      if (!assignments.length) return this.findUserById(id);
      await pool.execute(`UPDATE wf_users SET ${assignments.join(", ")}, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`, [...values, id]);
      return api.findUserById(id);
    },

    async setUserStatus(id, active) {
      await pool.execute("UPDATE wf_users SET status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [active ? "active" : "disabled", id]);
      return { id, status: active ? "active" : "disabled" };
    },

    async updatePasswordHash(id, passwordHash) {
      await pool.execute("UPDATE wf_users SET password_hash = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [passwordHash, id]);
      return { id, updated: true };
    },

    async listRoles() {
      const [rows] = await pool.execute("SELECT id, role_key, display_name FROM wf_roles ORDER BY role_key ASC");
      return rows;
    },

    async listPermissions() {
      const [rows] = await pool.execute("SELECT id, permission_key, display_name FROM wf_permissions ORDER BY permission_key ASC");
      return rows;
    },

    async permissionsForUser(userId) {
      const [rows] = await pool.execute(
        `SELECT DISTINCT p.permission_key
           FROM wf_user_roles ur
           JOIN wf_role_permissions rp ON rp.role_id = ur.role_id
           JOIN wf_permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = ?
          ORDER BY p.permission_key ASC`,
        [userId],
      );
      return rows.map((row) => row.permission_key);
    },

    async ensureRole(roleKey, displayName) {
      await pool.execute(
        `INSERT INTO wf_roles (role_key, display_name, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
        [roleKey, displayName || roleKey],
      );
      const [rows] = await pool.execute("SELECT id, role_key, display_name FROM wf_roles WHERE role_key = ? LIMIT 1", [roleKey]);
      return rows[0];
    },

    async ensurePermission(permissionKey, displayName) {
      await pool.execute(
        `INSERT INTO wf_permissions (permission_key, display_name, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
        [permissionKey, displayName || permissionKey],
      );
      const [rows] = await pool.execute("SELECT id, permission_key, display_name FROM wf_permissions WHERE permission_key = ? LIMIT 1", [permissionKey]);
      return rows[0];
    },

    async grantRolePermission(roleId, permissionId) {
      await pool.execute(
        `INSERT INTO wf_role_permissions (role_id, permission_id, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
        [roleId, permissionId],
      );
    },

    async assignRole(userId, roleId) {
      await pool.execute(
        `INSERT INTO wf_user_roles (user_id, role_id, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)`,
        [userId, roleId],
      );
    },

    async setRoles(userId, roleKeys) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute("DELETE FROM wf_user_roles WHERE user_id = ?", [userId]);
        for (const roleKey of roleKeys) {
          const [rows] = await connection.execute("SELECT id FROM wf_roles WHERE role_key = ? LIMIT 1", [roleKey]);
          if (!rows.length) throw new Error(`Unknown role: ${roleKey}`);
          await connection.execute(
            `INSERT INTO wf_user_roles (user_id, role_id, created_at) VALUES (?, ?, UTC_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)`,
            [userId, rows[0].id],
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
      return api.permissionsForUser(userId);
    },

    async rolesForUser(userId) {
      const [rows] = await pool.execute(
        `SELECT r.role_key FROM wf_user_roles ur JOIN wf_roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.role_key ASC`,
        [userId],
      );
      return rows.map((row) => row.role_key);
    },

    async listSessions(userId) {
      const [rows] = await pool.execute(
        `SELECT SUBSTRING(token_hash, 1, 12) AS id, created_at, expires_at, device_label
           FROM wf_sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
          ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        deviceLabel: row.device_label ?? null,
        current: false,
      }));
    },

    async revokeAllSessions(userId, exceptTokenHash = null) {
      const [result] = exceptTokenHash
        ? await pool.execute(
          `UPDATE wf_sessions SET revoked_at = UTC_TIMESTAMP(3)
            WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
          [userId, exceptTokenHash],
        )
        : await pool.execute(
          `UPDATE wf_sessions SET revoked_at = UTC_TIMESTAMP(3)
            WHERE user_id = ? AND revoked_at IS NULL`,
          [userId],
        );
      return result?.affectedRows ?? 0;
    },

    async updateSessionExpiry(tokenHash, expiresAt, deviceLabel = null) {
      await pool.execute(
        `UPDATE wf_sessions
            SET expires_at = ?, device_label = COALESCE(?, device_label)
          WHERE token_hash = ? AND revoked_at IS NULL`,
        [expiresAt, deviceLabel, tokenHash],
      );
      return { expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt, deviceLabel };
    },

    async listAuditEvents({ userId = null, limit = 50, offset = 0, action = null, sort = "createdAt", direction = "desc" } = {}) {
      const boundedLimit = boundedInteger(limit, { fallback: 50, max: 200 });
      const boundedOffset = boundedInteger(offset, { fallback: 0, min: 0, max: 1_000_000 });
      const orderBy = AUDIT_SORT_COLUMNS[sort] || AUDIT_SORT_COLUMNS.createdAt;
      const where = [];
      const values = [];
      if (userId !== null) {
        where.push("actor_user_id = ?");
        values.push(userId);
      }
      if (action) {
        where.push("(action_key = ? OR action_key LIKE ?)");
        values.push(action, likeTerm(`${action}.`));
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM wf_audit_events ${clause}`, values);
      const [rows] = await pool.query(
        `SELECT id, action_key, entity_type, entity_id, detail_json, created_at
           FROM wf_audit_events
          ${clause}
          ORDER BY ${orderBy} ${directionOf(direction)}, id DESC
          LIMIT ${boundedLimit} OFFSET ${boundedOffset}`,
        values,
      );
      return {
        total: Number(countRow?.total ?? 0),
        events: rows.map((row) => ({
          id: row.id,
          action: row.action_key,
          entityType: row.entity_type,
          entityId: row.entity_id,
          details: safeParseJson(row.detail_json),
          createdAt: row.created_at,
        })),
      };
    },

    async setAvatarPath(userId, avatarPath) {
      await pool.execute(
        `INSERT INTO wf_user_profiles (user_id, display_name, profile_image)
         VALUES (?, '', ?)
         ON DUPLICATE KEY UPDATE profile_image = VALUES(profile_image)`,
        [userId, avatarPath],
      );
    },

    async findAvatarPath(userId) {
      const [rows] = await pool.execute("SELECT profile_image FROM wf_user_profiles WHERE user_id = ? LIMIT 1", [userId]);
      return rows[0]?.profile_image ?? null;
    },
  };
  return api;
}

async function allocateUniqueUid(connection, preferred = null) {
  const candidates = [];
  if (preferred) candidates.push(String(preferred));
  for (let attempt = 0; attempt < 25; attempt += 1) candidates.push(String(Math.floor(Math.random() * 900_000) + 100_000));
  for (const candidate of candidates) {
    const [rows] = await connection.execute("SELECT legacy_uid FROM wf_users WHERE legacy_uid = ? LIMIT 1", [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error("Unable to allocate a unique six-digit user ID");
}

function safeParseJson(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return { raw: "unreadable" };
  }
}

export const testables = { boundedInteger, likeTerm, SORT_COLUMNS };
