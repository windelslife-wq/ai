import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";

class TestRedis implements RedisClient {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value); return "OK";
  }
  async incr(key: string) { const next = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(next)); return next; }
  async pexpire() { return 1; }
  async pttl() { return 1000; }
  async del(key: string) { return this.values.delete(key) ? 1 : 0; }
  async eval(_script: string, _keys: number, ...args: string[]) { return this.values.get(args[0] ?? "") === args[1] ? this.del(args[0] ?? "") : 0; }
  async lpush() { return 1; }
  async quit() { return "OK"; }
}

test("organization member picker is read-authorized, scoped, and does not return email addresses", async () => {
  const organizationId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const userId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  let queryParameters: unknown[] = [];
  const db = {
    query: async (sql: string, parameters: unknown[] = []) => {
      assert.match(sql, /organization_members/);
      queryParameters = parameters;
      return { rows: [
        { id: userId, display_name: "Team Member", active: true, email: "private@example.test" },
        { id: "6ba7b812-9dad-11d1-80b4-00c04fd430c8", display_name: null, active: false, email: "inactive@example.test" },
      ] };
    },
    end: async () => undefined,
  };
  const app = await buildApp({ db, redis: new TestRedis(), jwtSecret: "a secure test secret that is longer than thirty two characters" });
  const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/members" });
  assert.equal(unauthenticated.statusCode, 401);
  const reader = app.jwt.sign({ sub: userId, organizationId, permissions: ["lead.read"] });
  const response = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/members", headers: { authorization: `Bearer ${reader}` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(queryParameters, [organizationId]);
  assert.deepEqual(response.json().members, [
    { id: userId, displayName: "Team Member", active: true },
    { id: "6ba7b812-9dad-11d1-80b4-00c04fd430c8", displayName: null, active: false },
  ]);
  assert.equal(JSON.stringify(response.json()).includes("private@example.test"), false);
  const forbidden = app.jwt.sign({ sub: userId, organizationId, permissions: [] });
  const denied = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/members", headers: { authorization: `Bearer ${forbidden}` } });
  assert.equal(denied.statusCode, 403);
  await app.close();
});
