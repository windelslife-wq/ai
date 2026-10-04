import type { ParsedBusinessSearchInput, ProviderHealth } from "../../../../packages/shared/src/leadDiscovery.js";
import type { DiscoveredBusiness, LeadDiscoveryProvider } from "./leadDiscoveryProvider.js";

/** Google Places Text Search adapter. It fails explicitly; it never fabricates businesses. */
export class GooglePlacesProvider implements LeadDiscoveryProvider {
  readonly name = "google_places";

  constructor(
    private readonly apiKey = process.env.GOOGLE_PLACES_API_KEY,
    private readonly timeoutMs = 12_000,
    private readonly attempts = 2,
  ) {}

  health(): ProviderHealth {
    return this.apiKey
      ? { name: this.name, status: "IMPLEMENTED", detail: "Google Places Text Search configured" }
      : { name: this.name, status: "DISABLED", detail: "GOOGLE_PLACES_API_KEY is not configured" };
  }

  /** Backwards-compatible shorthand for existing consumers. */
  async search(query: string, limit: number): Promise<DiscoveredBusiness[]> {
    return this.searchBusinesses({ query, provider: this.name, limit });
  }

  async searchBusinesses(input: ParsedBusinessSearchInput): Promise<DiscoveredBusiness[]> {
    if (!this.apiKey) throw Object.assign(new Error("Google Places is disabled: configure GOOGLE_PLACES_API_KEY"), { statusCode: 503 });
    let last: Error | undefined;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try { return await this.request(input); }
      catch (error) {
        last = error instanceof Error ? error : new Error("Google Places request failed");
        const retryable = (last as Error & { retryable?: boolean }).retryable === true;
        if (!retryable || attempt === this.attempts - 1) throw last;
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw last ?? new Error("Google Places request failed");
  }

  private async request(input: ParsedBusinessSearchInput): Promise<DiscoveredBusiness[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const query = [input.query, input.category, input.country].filter(Boolean).join(", ");
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey!,
          "x-goog-fieldmask": "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.types,places.nationalPhoneNumber,places.websiteUri,places.location",
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: input.limit }),
      });
      const payload = await response.json() as { places?: Array<Record<string, unknown>>; error?: { message?: string } };
      if (!response.ok || payload.error) {
        const error = Object.assign(new Error(payload.error?.message ?? "Google Places request failed"), {
          statusCode: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
        throw error;
      }
      return (payload.places ?? []).flatMap(place => this.normalize(place));
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw Object.assign(new Error("Google Places request timed out"), { statusCode: 504, retryable: true });
      throw error;
    } finally { clearTimeout(timeout); }
  }

  private normalize(place: Record<string, unknown>): DiscoveredBusiness[] {
    const sourceId = typeof place.id === "string" ? place.id.trim() : "";
    if (!sourceId) return [];
    const display = place.displayName as { text?: unknown } | undefined;
    const location = place.location as { latitude?: unknown; longitude?: unknown } | undefined;
    const components = Array.isArray(place.addressComponents) ? place.addressComponents : [];
    const component = (types: string[]): string | null => {
      const found = components.find(item => {
        const row = item as { types?: unknown };
        const componentTypes = Array.isArray(row.types) ? row.types.filter((value): value is string => typeof value === "string") : [];
        return types.some(type => componentTypes.includes(type));
      }) as { longText?: unknown; shortText?: unknown } | undefined;
      return typeof found?.longText === "string" ? found.longText : typeof found?.shortText === "string" ? found.shortText : null;
    };
    const types = Array.isArray(place.types) ? place.types.filter((value): value is string => typeof value === "string") : [];
    return [{
      sourceId,
      name: typeof display?.text === "string" && display.text.trim() ? display.text.trim() : "Unnamed business",
      category: types.slice(0, 3).join(", ") || null,
      address: typeof place.formattedAddress === "string" ? place.formattedAddress : null,
      city: component(["locality", "postal_town", "administrative_area_level_2"]),
      region: component(["administrative_area_level_1"]),
      country: component(["country"]),
      phone: typeof place.nationalPhoneNumber === "string" ? place.nationalPhoneNumber : null,
      website: this.safeUrl(place.websiteUri),
      latitude: typeof location?.latitude === "number" && Number.isFinite(location.latitude) ? location.latitude : null,
      longitude: typeof location?.longitude === "number" && Number.isFinite(location.longitude) ? location.longitude : null,
      metadata: { provider: "Google Places", types },
    }];
  }

  private safeUrl(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; }
    catch { return null; }
  }
}

export type { DiscoveredBusiness } from "./leadDiscoveryProvider.js";
