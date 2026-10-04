import type { ProviderHealth } from "../../../../packages/shared/src/leadDiscovery.js";
import type { LeadDiscoveryProvider } from "./leadDiscoveryProvider.js";

/** Provider registry keeps discovery orchestration independent from vendors. */
export class LeadDiscoveryProviderRegistry {
  private readonly providers = new Map<string, LeadDiscoveryProvider>();

  register(provider: LeadDiscoveryProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): LeadDiscoveryProvider | undefined {
    return this.providers.get(name);
  }

  list(): LeadDiscoveryProvider[] {
    return [...this.providers.values()];
  }

  health(): ProviderHealth[] {
    return this.list().map(provider => provider.health());
  }
}
