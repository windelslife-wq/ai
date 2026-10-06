import bcrypt from "bcryptjs";
import { buildApp } from "../src/app.js";

export const TEST_CONFIG = Object.freeze({
  mode: "test",
  production: false,
  host: "0.0.0.0",
  port: 3000,
  logLevel: "silent",
  database: { host: "localhost", port: 3306, database: "test", user: "test", password: "test", connectionLimit: 1 },
  sessionSecret: "test-session-secret-with-at-least-32-bytes-long",
  sessionTtlSeconds: 1800,
  cookieName: "wf_session",
  secureCookie: false,
  trustProxy: false,
  publicBaseUrl: null,
});

export async function createTestApp({ permissions = ["identity.users.view"], readiness = { database: true, schema: true }, publicDir } = {}) {
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
  const store = {
    async readiness() { return readiness; },
    async findUserByIdentifier(identifier) {
      return ["alice", "alice@example.test", "123456"].includes(identifier.toLowerCase()) ? user : null;
    },
    async createSession(session) { sessions.set(session.tokenHash, { ...session, revoked: false }); },
    async findSession(tokenHash) {
      const saved = sessions.get(tokenHash);
      if (!saved || saved.revoked || saved.expiresAt <= new Date()) return null;
      return {
        user: { id: user.id, legacyUid: user.legacy_uid, username: user.username, email: user.email },
        permissions,
      };
    },
    async revokeSession(tokenHash) {
      const saved = sessions.get(tokenHash);
      if (saved) saved.revoked = true;
    },
    async recordAudit(event) { audits.push(event); },
    async listUsers() { return [{ id: 7, username: user.username, email: user.email, status: user.status }]; },
  };
  const app = await buildApp({ config: TEST_CONFIG, store, logger: false, publicDir });
  return { app, store, sessions, audits, user };
}
