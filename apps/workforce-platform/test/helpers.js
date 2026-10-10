import bcrypt from "bcryptjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { assertIsoCutoff } from "../src/persistence/contract.js";
import { buildApp } from "../src/app.js";
import { createFileStore } from "../src/persistence/file-store.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * A real, validated configuration (same loader as production) with the durable
 * file adapter pointed at a throwaway directory.
 */
export function testConfig(overrides = {}) {
  const directory = overrides.__directory;
  const env = {
    NODE_ENV: "test",
    WF_APP_ROOT: directory || REPOSITORY_ROOT,
    STORAGE_ADAPTER: "file",
    STORAGE_DIR: path.join(directory || REPOSITORY_ROOT, "store"),
    UPLOAD_DIR: path.join(directory || REPOSITORY_ROOT, "uploads"),
    SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
    SESSION_TTL_SECONDS: "1800",
    LOG_LEVEL: "silent",
    ...overrides.env,
  };
  delete env.__directory;
  const config = loadConfig(env);
  return Object.freeze({ ...config, ...overrides.config });
}

/** Exported for the original auth tests, which assert against a plain config object. */
export const TEST_CONFIG = testConfig();

/**
 * Legacy-style in-memory store used by the original HTTP/auth tests. It speaks
 * exactly the repository contract the MySQL and file adapters implement, so a
 * route change cannot silently depend on adapter-specific behaviour.
 */
export async function createTestApp({ permissions = ["identity.users.view"], readiness = { database: true, schema: true, adapter: "test" }, publicDir } = {}) {
  const passwordHash = await bcrypt.hash("Correct horse battery staple", 4);
  const user = {
    id: 7,
    legacy_uid: "123456",
    username: "alice",
    email: "alice@example.test",
    password_hash: passwordHash,
    status: "active",
  };
  const sessions = new Map();
  const audits = [];
  const inquiries = [];
  const analysisRuns = new Map();
  const passwordUpdates = [];
  const store = {
    adapter: "test",
    capabilities: Object.freeze({ adapter: "test", sql: false, durable: false, transactions: false, crossProcessSafety: false, recommendedForProduction: false }),
    async readiness() { return readiness; },
    async findUserByIdentifier(identifier) {
      return ["alice", "alice@example.test", "123456"].includes(identifier.toLowerCase()) ? user : null;
    },
    async findUserById(id) { return Number(id) === user.id ? user : null; },
    async permissionsForUser() { return [...permissions]; },
    async usernameTaken(username, excludeId = null) {
      return String(username) === user.username && Number(excludeId) !== user.id;
    },
    async emailTaken(email, excludeId = null) {
      return String(email) === user.email && Number(excludeId) !== user.id;
    },
    async updateUser(id, patch) {
      if (patch.passwordHash) user.password_hash = patch.passwordHash;
      return { ...user };
    },
    async updatePasswordHash(id, passwordHash) {
      passwordUpdates.push({ id, passwordHash });
      user.password_hash = passwordHash;
      return { id, updated: true };
    },
    async createSession(session) { sessions.set(session.tokenHash, { ...session, revoked: false }); },
    async findSession(tokenHash) {
      const saved = sessions.get(tokenHash);
      if (!saved || saved.revoked || saved.expiresAt <= new Date()) return null;
      return {
        user: { id: user.id, legacyUid: user.legacy_uid, username: user.username, email: user.email, displayName: "Alice", profileImage: null },
        permissions,
      };
    },
    async updateSessionExpiry(tokenHash, expiresAt, deviceLabel) {
      const saved = sessions.get(tokenHash);
      if (!saved) return null;
      saved.expiresAt = new Date(expiresAt);
      saved.deviceLabel = deviceLabel ?? saved.deviceLabel ?? null;
      return { expiresAt: saved.expiresAt.toISOString(), deviceLabel: saved.deviceLabel };
    },
    async revokeSession(tokenHash) {
      const saved = sessions.get(tokenHash);
      if (saved) saved.revoked = true;
    },
    async listSessions(userId) {
      return [...sessions.entries()]
        .filter(([, saved]) => String(saved.userId) === String(userId) && !saved.revoked && saved.expiresAt > new Date())
        .map(([tokenHash, saved]) => ({ id: tokenHash.slice(0, 12), createdAt: saved.createdAt?.toISOString?.() ?? null, expiresAt: saved.expiresAt.toISOString(), deviceLabel: saved.deviceLabel ?? null, current: false }));
    },
    async revokeAllSessions(userId, exceptTokenHash = null) {
      let revoked = 0;
      for (const [tokenHash, saved] of sessions) {
        if (String(saved.userId) !== String(userId) || saved.revoked) continue;
        if (exceptTokenHash && tokenHash === exceptTokenHash) continue;
        saved.revoked = true;
        revoked += 1;
      }
      return revoked;
    },
    async recordAudit(event) { audits.push(event); },
    async listAuditEvents() { return { total: audits.length, events: audits.map((event, index) => ({ id: index + 1, action: event.action, createdAt: new Date().toISOString(), ...event })) }; },
    async recordContactInquiry(inquiry) {
      const id = inquiries.length + 1;
      const record = { id, status: "new", createdAt: new Date().toISOString(), ...inquiry };
      inquiries.push(record);
      return { id, reference: record.reference, createdAt: record.createdAt };
    },
    async pageContactInquiries({ limit = 25, offset = 0, search = null, sort = "createdAt", direction = "desc" } = {}) {
      let rows = [...inquiries];
      if (search) {
        const term = String(search).toLowerCase();
        rows = rows.filter((row) => row.name.toLowerCase().includes(term) || row.email.toLowerCase().includes(term));
      }
      const column = { id: "id", createdAt: "createdAt", name: "name", email: "email" }[sort] || "createdAt";
      const factor = direction === "asc" ? 1 : -1;
      rows.sort((a, b) => (String(a[column]).localeCompare(String(b[column])) || a.id - b.id) * factor);
      return { total: rows.length, inquiries: rows.slice(offset, offset + limit) };
    },
    /**
     * Mirrors the durable adapters: `saveAnalysisRun` upserts by id, the listing
     * returns summaries newest first with no payload, `findAnalysisRun` returns the
     * stored payload (or null), which is what the route serves, and
     * `pruneAnalysisRuns` deletes rows strictly older than a validated ISO-8601 UTC
     * cutoff and reports the same shape both adapters report (risk R-27).
     */
    async saveAnalysisRun({ id, symbol, timeframe, bias, confidence, regime, recommendation, synthetic, source, completedAt, payload }) {
      analysisRuns.set(String(id), {
        id: String(id), symbol, timeframe, bias, confidence: Number(confidence), regime, recommendation,
        synthetic: Boolean(synthetic), source, completedAt, payload: payload ?? null,
      });
      return { id: String(id), completedAt };
    },
    async pruneAnalysisRuns(beforeIso, { dryRun = false } = {}) {
      const cutoff = assertIsoCutoff(beforeIso);
      const doomed = [...analysisRuns.values()]
        .filter((row) => String(row.completedAt) < cutoff)
        .sort((a, b) => (String(a.completedAt).localeCompare(String(b.completedAt)) || String(a.id).localeCompare(String(b.id))));
      const report = {
        matching: doomed.length,
        deleted: 0,
        payloadBytes: doomed.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.payload ?? null), "utf8"), 0),
        oldest: doomed.length ? String(doomed[0].completedAt) : null,
        newest: doomed.length ? String(doomed[doomed.length - 1].completedAt) : null,
        cutoff,
        batches: 0,
        exhausted: true,
        dryRun: Boolean(dryRun),
      };
      if (dryRun || doomed.length === 0) return report;
      for (const row of doomed) analysisRuns.delete(String(row.id));
      report.deleted = doomed.length;
      report.batches = 1;
      return report;
    },
    async listAnalysisRuns({ limit = 20 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      return [...analysisRuns.values()]
        .sort((a, b) => (String(b.completedAt).localeCompare(String(a.completedAt)) || String(a.id).localeCompare(String(b.id))))
        .slice(0, bounded)
        .map(({ payload, ...summary }) => summary);
    },
    async findAnalysisRun(id) {
      return analysisRuns.get(String(id))?.payload ?? null;
    },
    async listUsers() { return [{ id: 7, username: user.username, email: user.email, status: user.status }]; },
    async pageUsers() { return { total: 1, users: [{ id: 7, username: user.username, email: user.email, status: user.status }] }; },
    async listRoles() { return [{ id: 1, role_key: "platform_member", display_name: "Platform member" }]; },
    async listPermissions() { return [{ id: 1, permission_key: "identity.users.view", display_name: "identity.users.view" }]; },
  };
  const config = testConfig();
  const app = await buildApp({ config, store, logger: false, publicDir });
  return { app, store, sessions, audits, inquiries, analysisRuns, user, passwordUpdates };
}

/**
 * Builds the same application on top of the real durable file adapter, so the
 * new account tests exercise actual persistence, not a mock.
 */
export async function createFileStoreApp({ publicDir, configOverrides = {}, seed = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "windels-file-store-"));
  const config = testConfig({ __directory: directory, ...configOverrides });
  const store = await createFileStore({ dir: path.join(directory, "store"), logger: { warn() {} } });
  if (seed) await seedFileStore(store);
  const app = await buildApp({ config, store, logger: false, publicDir, adapter: "file" });
  return {
    app,
    config,
    store,
    directory,
    async cleanup() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function seedFileStore(store) {
  await store.ensureRole("super_admin", "Super administrator");
  await store.ensureRole("platform_member", "Platform member");
  for (const key of ["identity.users.view", "identity.users.manage", "system.health.view", "system.super_admin", "trading.view", "sports.view", "lottery.view"]) {
    await store.ensurePermission(key, key);
  }
  const roles = await store.listRoles();
  const permissions = await store.listPermissions();
  const superAdmin = roles.find((role) => role.role_key === "super_admin");
  for (const permission of permissions) await store.grantRolePermission(superAdmin.id, permission.id);
  await store.createUser({ username: "rootadmin", email: "root@example.test", passwordHash: await bcrypt.hash("Root administrator pass", 4), displayName: "Root Admin" });
  await store.assignRole(1, superAdmin.id);
  return { roles, permissions };
}

export function cookieFrom(response) {
  const value = response.headers["set-cookie"];
  if (Array.isArray(value)) return value[0]?.split(";")[0] || "";
  return value?.split(";")[0] || "";
}
