import { createHash } from "node:crypto";
import { BusinessSearchInputSchema, type ParsedBusinessSearchInput } from "../../../packages/shared/src/leadDiscovery.js";
import { LeadRepository } from "./leadRepository.js";
import type { LeadPrincipal } from "./auth.js";
import type { LeadOperationalStore } from "./redis.js";
import type { DiscoveredBusiness } from "./providers/leadDiscoveryProvider.js";
import { LeadDiscoveryProviderRegistry } from "./providers/providerRegistry.js";

/** End-to-end discovery orchestration: validate, provider, normalize, persist, dedupe and ledger. */
export class LeadDiscoveryService {
  constructor(
    private readonly providers: LeadDiscoveryProviderRegistry,
    private readonly leads: LeadRepository,
    private readonly operational: LeadOperationalStore,
  ) {}

  async search(principal: LeadPrincipal, rawInput: unknown) {
    const input = BusinessSearchInputSchema.parse(rawInput);
    const provider = this.providers.get(input.provider);
    if (!provider) throw Object.assign(new Error(`provider ${input.provider} is not available`), { statusCode: 422 });
    const started = performance.now();
    const cacheKey = this.cacheKey(input);
    const lock = await this.operational.acquireLock(`search:${principal.organizationId}:${cacheKey}`, 30_000);
    if (!lock) throw Object.assign(new Error("an identical search is already in progress"), { statusCode: 409 });
    try {
      const cached = await this.operational.getCached<DiscoveredBusiness[]>(cacheKey);
      const businesses = cached ?? await provider.searchBusinesses(input);
      if (!cached) await this.operational.cache(cacheKey, businesses, 300_000);
      const unique = new Map<string, DiscoveredBusiness>();
      for (const business of businesses) if (!unique.has(`${provider.name}:${business.sourceId}`)) unique.set(`${provider.name}:${business.sourceId}`, business);
      const providerDuplicates = businesses.length - unique.size;
      const saved = await Promise.all([...unique.values()].map(business => this.leads.upsertDiscovery(principal.organizationId, provider.name, business)));
      const created = saved.filter(item => item.created).length;
      await Promise.all(saved.flatMap(item => [
        this.leads.recordActivity(principal.organizationId, principal.sub, item.lead.id, "LEAD_DISCOVERED", { provider: provider.name, sourceId: item.lead.sourceId }),
        ...(item.created ? [this.leads.recordActivity(principal.organizationId, principal.sub, item.lead.id, "LEAD_CREATED", { provider: provider.name })] : []),
      ]));
      const candidateCounts = await Promise.all(saved.map(async item => {
        const count = await this.leads.detectSecondaryDuplicates(item.lead);
        if (count > 0) await this.leads.recordActivity(principal.organizationId, principal.sub, item.lead.id, "DUPLICATE_DETECTED", { candidates: count });
        return count;
      }));
      const candidateCount = candidateCounts.reduce((sum, count) => sum + count, 0);
      const duplicatesDetected = businesses.length - created + candidateCount;
      await this.leads.recordSearch({
        organizationId: principal.organizationId, userId: principal.sub, query: input.query, provider: provider.name,
        filters: { country: input.country ?? null, category: input.category ?? null, limit: input.limit },
        resultsReturned: businesses.length, newLeadsCreated: created, duplicatesDetected, durationMs: Math.round(performance.now() - started),
      });
      return {
        provider: provider.name, providerStatus: provider.health().status, results: saved.map(item => item.lead),
        newLeadsCreated: created, duplicatesDetected, duplicateCandidatesCreated: candidateCount,
        providerDuplicateRows: providerDuplicates,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "discovery failed";
      try {
        await this.leads.recordSearch({
          organizationId: principal.organizationId, userId: principal.sub, query: input.query, provider: provider.name,
          filters: { country: input.country ?? null, category: input.category ?? null, limit: input.limit },
          resultsReturned: 0, newLeadsCreated: 0, duplicatesDetected: 0, errors: message,
          durationMs: Math.round(performance.now() - started),
        });
      } catch { /* preserve the provider/database error; the ledger failure is observable in application logs */ }
      throw error;
    } finally { await lock.release(); }
  }

  private cacheKey(input: ParsedBusinessSearchInput): string {
    return createHash("sha256").update(JSON.stringify({ provider: input.provider, query: input.query, limit: input.limit, country: input.country ?? null, category: input.category ?? null })).digest("hex");
  }
}
