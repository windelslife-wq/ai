import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { Database } from "./db.js";
import { LeadOperationalStore, type RedisClient } from "./redis.js";
import { LeadRepository } from "./leadRepository.js";
import { LeadDiscoveryService } from "./leadDiscovery.service.js";
import { LeadDiscoveryProviderRegistry } from "./providers/providerRegistry.js";
import type { LeadDiscoveryProvider } from "./providers/leadDiscoveryProvider.js";
import { LeadPipelineService } from "./leadPipeline/leadPipeline.service.js";
import { LeadCoverageService } from "./quality/leadCoverage.service.js";
import { SearchHistoryService } from "./searchHistory/searchHistory.service.js";
import { GooglePlacesProvider } from "./providers/googlePlaces.js";
import { leadRoutes } from "./routes/leads.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { intelligenceRoutes } from "./routes/intelligence.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { chatRoutes } from "./routes/chat.js";
import { parseAllowedOrigins } from "./config.js";

export async function buildApp(options: {
  db: Database;
  jwtSecret: string;
  redis: RedisClient;
  corsOrigins?: string[];
  providers?: LeadDiscoveryProvider[];
}) {
  const app = Fastify({ logger: true });
  const origins = options.corsOrigins ?? parseAllowedOrigins();
  await app.register(cors, { origin: (origin, callback) => callback(null, !origin || origins.includes(origin.replace(/\/$/, ""))), credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });
  const operational = new LeadOperationalStore(options.redis);
  const providerRegistry = new LeadDiscoveryProviderRegistry();
  for (const provider of options.providers ?? [new GooglePlacesProvider()]) providerRegistry.register(provider);
  app.decorate("db", options.db);
  app.decorate("operational", operational);
  app.decorate("providers", providerRegistry);
  app.decorate("leadDiscovery", new LeadDiscoveryService(providerRegistry, new LeadRepository(options.db), operational));
  app.decorate("leadPipeline", new LeadPipelineService(options.db));
  app.decorate("leadCoverage", new LeadCoverageService(options.db));
  app.decorate("searchHistory", new SearchHistoryService(options.db));
  app.addHook("onRequest", async (request) => {
    const rate = await app.operational.consumeRateLimit(`ip:${request.ip}`, 120, 60_000);
    if (!rate.allowed) throw Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
  });
  await app.register(jwt, { secret: options.jwtSecret });
  app.get("/health", async () => ({ ok: true, service: "lead-discovery-api" }));
  app.get("/ready", async (_request, reply) => { try { await app.db.query("SELECT 1"); return { ok: true, database: "ready", redis: "operational" }; } catch { return reply.code(503).send({ ok: false, database: "unavailable" }); } });
  app.setErrorHandler((error, _request, reply) => {
    const known = error as { statusCode?: unknown; message?: unknown; name?: unknown; code?: unknown; validation?: unknown };
    const validationError = known.name === "ZodError" || known.code === "FST_ERR_VALIDATION";
    const status = validationError ? 400 : typeof known.statusCode === "number" ? known.statusCode : 500;
    reply.code(status).send({ error: status >= 500 ? "internal server error" : typeof known.message === "string" ? known.message : "request failed" });
  });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(chatRoutes, { prefix: "/api/v1/chat" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(leadRoutes, { prefix: "/api/v1/lead-discovery" });
  await app.register(discoveryRoutes, { prefix: "/api/v1/lead-discovery" });
  await app.register(pipelineRoutes, { prefix: "/api/v1/lead-discovery" });
  await app.register(intelligenceRoutes, { prefix: "/api/v1/lead-discovery" });
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    operational: LeadOperationalStore;
    providers: LeadDiscoveryProviderRegistry;
    leadDiscovery: LeadDiscoveryService;
    leadPipeline: LeadPipelineService;
    leadCoverage: LeadCoverageService;
    searchHistory: SearchHistoryService;
  }
}
