import type { FastifyInstance } from "fastify";
import { requireLeadAccess } from "../auth.js";

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/providers", async request => {
    await requireLeadAccess(request);
    return { providers: app.providers.list().map(provider => ({ name: provider.name, health: provider.health() })) };
  });

  app.post("/search", async request => {
    const principal = await requireLeadAccess(request);
    if (!principal.permissions.includes("lead.write")) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const rate = await app.operational.consumeRateLimit(`organization:${principal.organizationId}:search`, 30, 60_000);
    if (!rate.allowed) throw Object.assign(new Error("search rate limit exceeded"), { statusCode: 429 });
    return app.leadDiscovery.search(principal, request.body);
  });
}
