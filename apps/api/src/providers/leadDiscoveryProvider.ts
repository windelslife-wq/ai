import type { ParsedBusinessSearchInput, ProviderHealth } from "../../../../packages/shared/src/leadDiscovery.js";

export type DiscoveredBusiness = {
  sourceId: string;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  metadata: Record<string, unknown>;
};

export interface LeadDiscoveryProvider {
  readonly name: string;
  health(): ProviderHealth;
  searchBusinesses(input: ParsedBusinessSearchInput): Promise<DiscoveredBusiness[]>;
}
