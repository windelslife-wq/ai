/**
 * Lead Discovery provider boundary and Google Places (New) Text Search adapter.
 *
 * Ported 1:1 from:
 * - `application/libraries/LeadDiscovery/LeadDiscoveryProvider.php`
 * - `application/libraries/LeadDiscovery/ProviderException.php`
 * - `application/libraries/LeadDiscovery/GooglePlacesProvider.php`
 * - `application/libraries/LeadDiscovery/ProviderRegistry.php`
 *
 * No business records are ever fabricated when `GOOGLE_PLACES_API_KEY` is unconfigured
 * or when the upstream Google Places endpoint is unavailable.
 */

export const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
export const GOOGLE_PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.types,places.nationalPhoneNumber,places.websiteUri,places.location";

export class ProviderException extends Error {
  constructor(message, httpStatus = 503, retryable = false) {
    super(message);
    this.name = "ProviderException";
    this.httpStatus = Number(httpStatus) || 503;
    this.retryable = Boolean(retryable);
  }
}

export function normalizeGooglePlacesResponse(payload) {
  const places = Array.isArray(payload?.places) ? payload.places : [];
  const out = [];
  for (const p of places) {
    const sourceId = String(p?.id ?? "");
    if (sourceId === "") continue;
    const types = Array.isArray(p?.types) ? p.types.map((t) => String(t)) : [];
    out.push({
      sourceId,
      name: String(p?.displayName?.text ?? "Unnamed business"),
      category: types.slice(0, 3).join(", ") || null,
      address: p?.formattedAddress ?? null,
      phone: p?.nationalPhoneNumber ?? null,
      website: p?.websiteUri ?? null,
      latitude: p?.location?.latitude !== undefined && p?.location?.latitude !== null ? Number(p.location.latitude) : null,
      longitude: p?.location?.longitude !== undefined && p?.location?.longitude !== null ? Number(p.location.longitude) : null,
      metadata: {
        provider: "Google Places",
        types,
      },
    });
  }
  return out;
}

export function createGooglePlacesProvider({
  apiKey = "",
  timeoutSeconds = 12,
  maxAttempts = 2,
  transport = null,
} = {}) {
  const key = String(apiKey ?? "").trim();
  const timeoutMs = Math.max(1, Number(timeoutSeconds) || 12) * 1000;
  const attempts = Math.max(1, Number(maxAttempts) || 2);

  function name() {
    return "google_places";
  }

  function healthCheck() {
    return key !== ""
      ? { status: "IMPLEMENTED", detail: "Google Places Text Search configured" }
      : { status: "DISABLED", detail: "GOOGLE_PLACES_API_KEY is not configured" };
  }

  async function post(payload) {
    if (typeof transport === "function") {
      return transport(payload, { apiKey: key, url: GOOGLE_PLACES_URL, fieldMask: GOOGLE_PLACES_FIELD_MASK, timeoutMs });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let bodyText;
    try {
      response = await fetch(GOOGLE_PLACES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
        },
        body: payload,
        signal: controller.signal,
      });
      bodyText = await response.text();
    } catch {
      throw new ProviderException("Google Places request timed out or could not connect", 503, true);
    } finally {
      clearTimeout(timer);
    }
    let decoded;
    try {
      decoded = JSON.parse(bodyText);
    } catch {
      throw new ProviderException("Google Places returned an invalid response", 502, true);
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new ProviderException("Google Places returned an invalid response", 502, true);
    }
    const status = Number(response.status) || 0;
    if (status >= 400 || decoded.error !== undefined) {
      const message = String(decoded.error?.message ?? "Google Places request failed");
      throw new ProviderException(message, status || 502, status === 429 || status >= 500);
    }
    return decoded;
  }

  async function searchBusinesses(input = {}) {
    const health = healthCheck();
    if (health.status !== "IMPLEMENTED") {
      throw new ProviderException(health.detail, 503);
    }
    const query = String(input?.query ?? "").trim();
    if (query === "") {
      throw new ProviderException("search query is required", 400);
    }
    const maxResultCount = Math.min(20, Math.max(1, Number.parseInt(input?.limit ?? 20, 10) || 20));
    const payload = JSON.stringify({ textQuery: query, maxResultCount });
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const decoded = await post(payload);
        return normalizeGooglePlacesResponse(decoded);
      } catch (error) {
        const wrapped = error instanceof ProviderException
          ? error
          : new ProviderException(String(error?.message || "Google Places request failed"), 503, false);
        lastError = wrapped;
        if (!wrapped.retryable || attempt === attempts) throw wrapped;
      }
    }
    throw lastError || new ProviderException("Google Places request failed");
  }

  return Object.freeze({ name, healthCheck, searchBusinesses });
}

export function createLeadProviderRegistry(providers = []) {
  const byName = new Map();
  for (const provider of providers) {
    byName.set(provider.name(), provider);
  }
  return Object.freeze({
    health() {
      return [...byName.values()].map((provider) => ({
        name: provider.name(),
        ...provider.healthCheck(),
      }));
    },
    get(name) {
      const found = byName.get(String(name ?? ""));
      if (!found) {
        throw new ProviderException(`Provider '${name}' is planned and not active in this release`, 422);
      }
      return found;
    },
  });
}
