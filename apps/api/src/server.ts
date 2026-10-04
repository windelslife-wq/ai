import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { createRedis } from "./redis.js";
import { requireProductionConfig } from "./config.js";

requireProductionConfig();
const jwtSecret = process.env.LEAD_JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error("LEAD_JWT_SECRET must be at least 32 characters");
const db = createDatabase(); const redis = createRedis();
const app = await buildApp({ db, redis, jwtSecret });
const shutdown = async () => { await app.close(); await Promise.all([db.end(), redis.quit()]); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
