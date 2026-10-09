import { createHash } from "node:crypto";
import { createAccountRepository } from "./account-repository.js";
import { createSiteRepository } from "./site-repository.js";

export const REQUIRED_MIGRATIONS = Object.freeze([
  "001_platform_foundation",
  "002_identity_import_fields",
  "003_account_management",
  "004_public_site",
]);

/** Only driver codes are ever reported; never an SQL statement or credential. */
function safeDriverDetail(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (!code) return "unreachable";
  if (code === "ER_ACCESS_DENIED_ERROR") return "access-denied";
  if (code === "ER_BAD_DB_ERROR") return "unknown-database";
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(code)) return "unreachable";
  if (["PROTOCOL_CONNECTION_LOST", "ER_SERVER_SHUTDOWN"].includes(code)) return "disconnected";
  return "error";
}

export function createStore(pool, { requiredMigrations = REQUIRED_MIGRATIONS } = {}) {
  const repository = createAccountRepository(pool);
  const site = createSiteRepository(pool);
  return {
    ...repository,
    ...site,
    adapter: "mysql",
    capabilities: Object.freeze({
      adapter: "mysql",
      sql: true,
      durable: true,
      transactions: true,
      crossProcessSafety: true,
      recommendedForProduction: true,
    }),

    async readiness() {
      try {
        await pool.execute("SELECT 1 AS healthy");
      } catch (error) {
        return { database: false, schema: false, adapter: "mysql", detail: safeDriverDetail(error) };
      }
      try {
        const placeholders = requiredMigrations.map(() => "?").join(", ");
        const [rows] = await pool.execute(
          `SELECT migration_name FROM wf_schema_migrations WHERE migration_name IN (${placeholders})`,
          requiredMigrations,
        );
        return { database: true, schema: rows.length === requiredMigrations.length, adapter: "mysql", detail: null };
      } catch {
        return { database: true, schema: false, adapter: "mysql", detail: "missing-schema" };
      }
    },

    async health() {
      return { adapter: "mysql", pool: { connectionLimit: pool.pool?.config?.connectionLimit ?? null, all: pool.pool?._all?.length ?? null } };
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

    async createSession({ tokenHash, userId, expiresAt, deviceLabel = null, createdAt = null }) {
      await pool.execute(
        `INSERT INTO wf_sessions (token_hash, user_id, expires_at, device_label, created_at)
         VALUES (?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(3)))`,
        [tokenHash, userId, expiresAt, deviceLabel || null, createdAt ? new Date(createdAt) : null],
      );
    },

    async findSession(tokenHash) {
      const [rows] = await pool.execute(
        `SELECT s.user_id, u.legacy_uid, u.username, u.email, up.display_name, up.profile_image, p.permission_key
           FROM wf_sessions s
           JOIN wf_users u ON u.id = s.user_id
           LEFT JOIN wf_user_profiles up ON up.user_id = u.id
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
          displayName: row.display_name,
          profileImage: row.profile_image,
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
        `SELECT u.id, u.legacy_uid, u.username, u.email, u.status, u.created_at,
                up.display_name, up.profile_image, up.last_login_at
           FROM wf_users u
           LEFT JOIN wf_user_profiles up ON up.user_id = u.id
          ORDER BY u.id ASC
          LIMIT ${boundedLimit}`,
      );
      return rows;
    },
  };
}

export function hashFailedLoginIdentifier(identifier) {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
}
