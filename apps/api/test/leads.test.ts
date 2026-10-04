import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";
class TestRedis implements RedisClient { private values = new Map<string,string>(); async get(k:string){return this.values.get(k)??null} async set(k:string,v:string,...args:(string|number)[]){if(args.includes("NX")&&this.values.has(k))return null;this.values.set(k,v);return "OK"} async incr(k:string){const n=Number(this.values.get(k)??0)+1;this.values.set(k,String(n));return n} async pexpire(){return 1} async pttl(){return 1000} async del(k:string){return this.values.delete(k)?1:0} async eval(_s:string,_n:number,...args:string[]){return this.values.get(args[0]??"")===args[1]?this.del(args[0]??""):0} async lpush(){return 1} async quit(){return "OK"} }

const organizationId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const userId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
test("Fastify lead route requires JWT and scopes SQL to token organization", async () => {
  let seenParams: unknown[] = [];
  const db = { query: async (_sql: string, params: unknown[] = []) => { seenParams = params; return { rows: [{ id: "6ba7b812-9dad-11d1-80b4-00c04fd430c8", organization_id: organizationId, source: "google_places", source_id: "stable", name: "Lagos Kitchen", category: null, address: null, city: null, region: null, country: null, phone: null, website: null, latitude: null, longitude: null, status: "new", owner_id: null, metadata: {}, created_at: "2026-08-23T00:00:00.000Z", updated_at: "2026-08-23T00:00:00.000Z" }] }; }, end: async () => undefined };
  const app = await buildApp({ db, redis: new TestRedis(), jwtSecret: "a secure test secret that is longer than thirty two characters", corsOrigins: ["https://app.example.test"] });
  const health = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://app.example.test" } });
  assert.equal(health.statusCode, 200); assert.equal(health.headers["access-control-allow-origin"], "https://app.example.test");
  const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/leads" });
  assert.equal(unauthenticated.statusCode, 401);
  const token = app.jwt.sign({ sub: userId, organizationId, permissions: ["lead.read"] });
  const response = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/leads?limit=1", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().leads[0].organizationId, organizationId); assert.equal(seenParams[0], organizationId);
  const pipeline = await app.inject({ method: "GET", url: "/api/v1/lead-discovery/pipeline", headers: { authorization: `Bearer ${token}` } });
  assert.equal(pipeline.statusCode, 200); assert.equal(pipeline.json().columns.new[0].organizationId, organizationId); assert.equal(seenParams[0], organizationId);
  await app.close();
});
