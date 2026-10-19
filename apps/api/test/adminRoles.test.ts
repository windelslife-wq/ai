import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";

class TestRedis implements RedisClient {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string, ...args: (string | number)[]) { if (args.includes("NX") && this.values.has(key)) return null; this.values.set(key, value); return "OK"; }
  async incr(key: string) { const next = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(next)); return next; }
  async pexpire() { return 1; }
  async pttl() { return 1000; }
  async del(key: string) { return this.values.delete(key) ? 1 : 0; }
  async eval(_script: string, _keys: number, ...args: string[]) { return this.values.get(args[0] ?? "") === args[1] ? this.del(args[0] ?? "") : 0; }
  async lpush() { return 1; }
  async quit() { return "OK"; }
}

test("admins cannot demote themselves or an organization owner, but can change another admin", async () => {
  const organizationId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const adminId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  const ownerId = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
  const otherAdminId = "6ba7b813-9dad-11d1-80b4-00c04fd430c8";
  const roleByUser = new Map([[adminId, "admin"], [ownerId, "owner"], [otherAdminId, "admin"]]);
  const roleUpdates: unknown[][] = [];
  const db = {
    query: async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith("SELECT role FROM organization_members")) {
        const role = roleByUser.get(String(parameters[1]));
        return { rows: role ? [{ role }] : [] };
      }
      if (sql.startsWith("UPDATE organization_members SET role")) {
        roleUpdates.push(parameters);
        return { rows: [] };
      }
      throw new Error(`unexpected role query: ${sql}`);
    },
    end: async () => undefined,
  };
  const app = await buildApp({ db, redis: new TestRedis(), jwtSecret: "a secure test secret that is longer than thirty two characters" });
  const token = app.jwt.sign({ sub: adminId, organizationId, permissions: ["lead.read", "lead.write", "lead.admin"] });
  const request = (id: string) => app.inject({
    method: "PATCH",
    url: `/api/v1/admin/users/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { role: "member" },
  });

  const selfDemotion = await request(adminId);
  assert.equal(selfDemotion.statusCode, 400);
  assert.match(selfDemotion.json().error, /cannot change your own administrator role/);
  const ownerDemotion = await request(ownerId);
  assert.equal(ownerDemotion.statusCode, 400);
  assert.match(ownerDemotion.json().error, /owner role cannot be changed/);
  assert.equal(roleUpdates.length, 0, "rejected role changes must not reach the UPDATE query");

  const otherAdminDemotion = await request(otherAdminId);
  assert.equal(otherAdminDemotion.statusCode, 200);
  assert.deepEqual(roleUpdates, [["member", organizationId, otherAdminId]]);
  await app.close();
});
