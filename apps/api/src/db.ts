import { Pool, type PoolConfig } from "pg";

/** PostgreSQL is the only source of truth for leads. Redis is operational-only. */
export interface Database { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void>; }
export function createDatabase(config: PoolConfig = { connectionString: process.env.DATABASE_URL }): Pool {
  if (!config.connectionString) throw new Error("DATABASE_URL is required for the Lead Discovery API");
  return new Pool(config);
}
