import { createHash } from "node:crypto";

const FOUNDATION_MIGRATION = "001_platform_foundation";

export function createStore(pool) {
  return {
    async readiness() {
      try {
        await pool.execute("SELECT 1 AS healthy");
      } catch {
        return { database: false, schema: false };
      }
      try {
        const [rows] = await pool.execute(
          "SELECT migration_name FROM wf_schema_migrations WHERE migration_name = ? LIMIT 1",
          [FOUNDATION_MIGRATION],
        );
        return { database: true, schema: rows.length === 1 };
      } catch {
        return { database: true, schema: false };
      }
    },

    async findUserByIdentifier(identifier) {
      const normalized = identifier.trim().toLowerCase();
      const [rows] = await pool.execute(
        `SELECT id, legacy_user_id, legacy_uid, username, email, password_hash, status
           FROM wf_users
          WHERE username_normalized = ? OR email_normalized = ? OR legacy_uid = ?
          LIMIT 1`,
        [normalized, normalized, normalized],
      );
      return rows[0] || null;
    },

    async createSession({ tokenHash, userId, expiresAt }) {
      await pool.execute(
        `INSERT INTO wf_sessions (token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(3))`,
        [tokenHash, userId, expiresAt],
      );
    },

    async findSession(tokenHash) {
      const [rows] = await pool.execute(
        `SELECT s.user_id, u.legacy_uid, u.username, u.email, p.permission_key
           FROM wf_sessions s
           JOIN wf_users u ON u.id = s.user_id
           LEFT JOIN wf_user_roles ur ON ur.user_id = u.id
           LEFT JOIN wf_role_permissions rp ON rp.role_id = ur.role_id
           LEFT JOIN wf_permissions p ON p.id = rp.permission_id
          WHERE s.token_hash = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > UTC_TIMESTAMP(3)
            AND u.status = 'active'`,
        [tokenHash],
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        user: {
          id: row.user_id,
          legacyUid: row.legacy_uid,
          username: row.username,
          email: row.email,
        },
        permissions: [...new Set(rows.map((item) => item.permission_key).filter(Boolean))],
      };
    },

    async revokeSession(tokenHash) {
      await pool.execute(
        `UPDATE wf_sessions
            SET revoked_at = UTC_TIMESTAMP(3)
          WHERE token_hash = ? AND revoked_at IS NULL`,
        [tokenHash],
      );
    },

    async recordAudit({ actorId = null, action, entityType = null, entityId = null, details = {} }) {
      const detailJson = JSON.stringify(details);
      await pool.execute(
        `INSERT INTO wf_audit_events
          (actor_user_id, action_key, entity_type, entity_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [actorId, action, entityType, entityId === null ? null : String(entityId), detailJson],
      );
    },

    async listUsers(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
      const [rows] = await pool.query(
        `SELECT id, legacy_uid, username, email, status, created_at
           FROM wf_users
          ORDER BY id ASC
          LIMIT ${boundedLimit}`,
      );
      return rows;
    },
  };
}

export function hashFailedLoginIdentifier(identifier) {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
}
