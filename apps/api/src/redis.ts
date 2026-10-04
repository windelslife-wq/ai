import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

/** Operational Redis interface: never use it as the permanent lead database. */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  lpush(key: string, value: string): Promise<number>;
  quit(): Promise<unknown>;
}
export function createRedis(url = process.env.REDIS_URL): RedisClient {
  if (!url) throw new Error("REDIS_URL is required for the Lead Discovery API operational layer");
  const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  return { get: key => client.get(key), set: (key, value, ...args) => client.set(key, value, ...(args as never[])), incr: key => client.incr(key), pexpire: (key, milliseconds) => client.pexpire(key, milliseconds), pttl: key => client.pttl(key), del: key => client.del(key), eval: (script, count, ...args) => client.eval(script, count, ...args), lpush: (key, value) => client.lpush(key, value), quit: () => client.quit() };
}

export class LeadOperationalStore {
  constructor(private readonly redis: RedisClient, private readonly prefix = "lead-discovery") {}
  private key(key: string) { return `${this.prefix}:${key}`; }
  async getCached<T>(key: string): Promise<T | null> { const raw = await this.redis.get(this.key(`cache:${key}`)); return raw ? JSON.parse(raw) as T : null; }
  async cache<T>(key: string, value: T, ttlMs: number): Promise<void> { await this.redis.set(this.key(`cache:${key}`), JSON.stringify(value), "PX", ttlMs); }
  async enqueueSearch(input: unknown): Promise<string> { const id = randomUUID(); const job = { id, state: "queued", input, createdAt: new Date().toISOString() }; await this.redis.set(this.key(`search:${id}`), JSON.stringify(job), "PX", 86_400_000); await this.redis.lpush(this.key("search-queue"), id); return id; }
  async consumeRateLimit(scope: string, max: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
    const key = this.key(`rate:${scope}`); const used = await this.redis.incr(key); if (used === 1) await this.redis.pexpire(key, windowMs); const ttl = Math.max(0, await this.redis.pttl(key)); return { allowed: used <= max, remaining: Math.max(0, max - used), retryAfterMs: ttl };
  }
  async acquireLock(name: string, ttlMs: number): Promise<{ token: string; release: () => Promise<boolean> } | null> {
    const key = this.key(`lock:${name}`); const token = randomUUID(); const acquired = await this.redis.set(key, token, "PX", ttlMs, "NX"); if (acquired !== "OK") return null;
    return { token, release: async () => (await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token)) === 1 };
  }
}
