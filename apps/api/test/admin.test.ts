import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";

class R implements RedisClient { private values = new Map<string, string>(); async get(key: string) { return this.values.get(key) ?? null; } async set(key: string, value: string, ...args: (string | number)[]) { if (args.includes("NX") && this.values.has(key)) return null; this.values.set(key, value); return "OK"; } async incr(key: string) { const next = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(next)); return next; } async pexpire() { return 1; } async pttl() { return 1000; } async del(key: string) { return this.values.delete(key) ? 1 : 0; } async eval(_script: string, _keys: number, ...args: string[]) { return this.values.get(args[0] ?? "") === args[1] ? this.del(args[0] ?? "") : 0; } async lpush() { return 1; } async quit() { return "OK"; } }
const org = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const admin = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

test("admin routes expose organization-scoped user controls only to administrators", async () => {
  const db = { query: async (sql: string) => {
    if (sql.includes("COUNT(*)") && sql.includes("organization_members")) return { rows: [{ total: 2 }] };
    if (sql.includes("COUNT(*)") && sql.includes("FROM leads")) return { rows: [{ total: 4 }] };
    if (sql.includes("COUNT(*)") && sql.includes("FROM collections")) return { rows: [{ total: 1 }] };
    if (sql.includes("COUNT(*)") && sql.includes("search_history")) return { rows: [{ total: 3 }] };
    if (sql.includes("SELECT u.id")) return { rows: [{ id: admin, email: "admin@example.test", display_name: "Admin", active: true, role: "owner", created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z" }] };
    throw new Error(`unexpected admin query: ${sql}`);
  }, end: async () => undefined };
  const app = await buildApp({ db, redis: new R(), jwtSecret: "a secure test secret that is longer than thirty two characters" });
  const elevated = app.jwt.sign({ sub: admin, organizationId: org, permissions: ["lead.read", "lead.write", "lead.admin"] });
  const ordinary = app.jwt.sign({ sub: admin, organizationId: org, permissions: ["lead.read"] });
  const forbidden = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { authorization: `Bearer ${ordinary}` } });
  assert.equal(forbidden.statusCode, 403);
  const overview = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { authorization: `Bearer ${elevated}` } });
  assert.equal(overview.statusCode, 200); assert.equal(overview.json().leads, 4); assert.equal(overview.json().organizationId, org);
  const users = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { authorization: `Bearer ${elevated}` } });
  assert.equal(users.statusCode, 200); assert.equal(users.json().users[0].email, "admin@example.test");
  await app.close();
});
