import test from "node:test";
import assert from "node:assert/strict";
import { LeadDiscoveryService } from "../src/leadDiscovery.service.js";
import { LeadDiscoveryProviderRegistry } from "../src/providers/providerRegistry.js";
import type { LeadDiscoveryProvider } from "../src/providers/leadDiscoveryProvider.js";
import { LeadRepository } from "../src/leadRepository.js";
import { LeadOperationalStore, type RedisClient } from "../src/redis.js";

class RedisStub implements RedisClient {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string, ...args: (string | number)[]) { if (args.includes("NX") && this.values.has(key)) return null; this.values.set(key, value); return "OK"; }
  async incr(key: string) { const value = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(value)); return value; }
  async pexpire() { return 1; }
  async pttl() { return 1000; }
  async del(key: string) { return this.values.delete(key) ? 1 : 0; }
  async eval(_script: string, _keys: number, ...args: string[]) { return this.values.get(args[0] ?? "") === args[1] ? this.del(args[0] ?? "") : 0; }
  async lpush() { return 1; }
  async quit() { return "OK"; }
}

const organizationId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const userId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const leadId = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
const row = (inserted: boolean) => ({ id: leadId, organization_id: organizationId, source: "test", source_id: "source-1", name: "Test Business", category: "restaurant", address: "1 Main Street", city: "Lagos", region: "Lagos", country: "Nigeria", phone: null, website: null, latitude: 6.45, longitude: 3.39, status: "new", owner_id: null, metadata: {}, created_at: "2026-08-23T00:00:00.000Z", updated_at: "2026-08-23T00:00:00.000Z", inserted });

test("LeadDiscoveryService persists once and reuses Redis search cache on repeat searches", async () => {
  let providerCalls = 0; let upserts = 0; let histories = 0;
  const provider: LeadDiscoveryProvider = { name: "test_provider", health: () => ({ name: "test_provider", status: "TESTED" }), searchBusinesses: async () => { providerCalls += 1; return [{ sourceId: "source-1", name: "Test Business", category: "restaurant", address: "1 Main Street", city: "Lagos", region: "Lagos", country: "Nigeria", phone: null, website: null, latitude: 6.45, longitude: 3.39, metadata: { provider: "test" } }]; } };
  const db = { query: async (sql: string) => {
    const statement = sql.trimStart();
    if (statement.startsWith("INSERT INTO leads")) { upserts += 1; return { rows: [row(upserts === 1)] }; }
    if (statement.startsWith("SELECT id,name,address,phone,website")) return { rows: [] };
    if (statement.startsWith("INSERT INTO search_history")) { histories += 1; return { rows: [] }; }
    if (statement.startsWith("INSERT INTO lead_activities")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }, end: async () => undefined };
  const registry = new LeadDiscoveryProviderRegistry(); registry.register(provider);
  const service = new LeadDiscoveryService(registry, new LeadRepository(db), new LeadOperationalStore(new RedisStub()));
  const principal = { sub: userId, organizationId, permissions: ["lead.read", "lead.write"] };
  const first = await service.search(principal, { query: "Test businesses in Lagos", provider: "test_provider", limit: 20 });
  const second = await service.search(principal, { query: "Test businesses in Lagos", provider: "test_provider", limit: 20 });
  assert.equal(providerCalls, 1);
  assert.equal(upserts, 2);
  assert.equal(histories, 2);
  assert.equal(first.newLeadsCreated, 1);
  assert.equal(second.newLeadsCreated, 0);
  assert.equal(first.results[0]?.city, "Lagos");
});

test("provider registry exposes only registered provider health", () => {
  const registry = new LeadDiscoveryProviderRegistry();
  registry.register({ name: "configured", health: () => ({ name: "configured", status: "IMPLEMENTED" }), searchBusinesses: async () => [] });
  assert.deepEqual(registry.health(), [{ name: "configured", status: "IMPLEMENTED" }]);
  assert.equal(registry.get("missing"), undefined);
});
