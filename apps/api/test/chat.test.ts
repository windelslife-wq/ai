import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";

class R implements RedisClient { private values = new Map<string, string>(); async get(k: string) { return this.values.get(k) ?? null; } async set(k: string, v: string, ...args: (string | number)[]) { if (args.includes("NX") && this.values.has(k)) return null; this.values.set(k, v); return "OK"; } async incr(k: string) { const n = Number(this.values.get(k) ?? 0) + 1; this.values.set(k, String(n)); return n; } async pexpire() { return 1; } async pttl() { return 1000; } async del(k: string) { return this.values.delete(k) ? 1 : 0; } async eval(_script: string, _keys: number, ...args: string[]) { return this.values.get(args[0] ?? "") === args[1] ? this.del(args[0] ?? "") : 0; } async lpush() { return 1; } async quit() { return "OK"; } }

test("public website chat responds without authentication using grounded fallback guidance", async () => {
  const db = { query: async () => ({ rows: [] }), end: async () => undefined };
  const app = await buildApp({ db, redis: new R(), jwtSecret: "a secure test secret that is longer than thirty two characters" });
  const response = await app.inject({ method: "POST", url: "/api/v1/chat/respond", payload: { message: "How do I export leads?" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().provider, "local-guide");
  assert.match(response.json().message, /export/i);
  const invalid = await app.inject({ method: "POST", url: "/api/v1/chat/respond", payload: { message: "" } });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});
