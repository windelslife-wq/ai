import type { BusinessSearchInput, BusinessSearchResult, Lead, LeadNote, LeadStatus, PipelineSummary, SearchHistory } from "../../../../packages/shared/src/leadDiscovery";

/** Browser-safe default: relative URLs are proxied by Next, never localhost from the user's browser. */
const configuredBaseUrl = process.env.NEXT_PUBLIC_LEAD_API_URL;
// Local development and Arena previews use the Next rewrite. This prevents browser code from ever calling localhost directly.
export const baseUrl = (configuredBaseUrl && !/localhost|127\.0\.0\.1/.test(configuredBaseUrl) ? configuredBaseUrl : "/api/v1/lead-discovery").replace(/\/$/, "");
export type AuthSession = { token: string; refreshToken: string; user: { id: string; email: string; displayName: string | null }; organizationId: string; permissions: string[] };
export type AuthUser = { id: string; email: string; displayName: string | null; organizationId: string; permissions: string[] };
export type ProviderOption = { name: string; health: { name: string; status: "IMPLEMENTED" | "TESTED" | "DISABLED" | "PLANNED"; detail?: string } };
export type CollectionSummary = { id: string; organizationId: string; name: string; leadCount: number; createdAt: string; updatedAt: string };
export type OrganizationMember = { id: string; displayName: string | null; active: boolean };
export type LeadActivity = { id: string; leadId: string | null; actorId: string | null; type: string; detail: Record<string, unknown>; createdAt: string };
export type LeadDetails = { lead: Lead; notes: LeadNote[]; activity: LeadActivity[] };
export type Duplicate = { id: string; leadAId: string; leadBId: string; leadAName: string; leadBName: string; ruleName: string; confidence: number; status: "open" | "resolved"; createdAt: string };
export type Coverage = { leadCount: number; fields: Array<{ key: string; field: string; coverage: number; missing: number }>; missingField: string | null; missingLeads: Lead[] };
export type SearchHistoryResponse = { history: SearchHistory[] };

type RequestOptions = RequestInit & { token?: string };
type ErrorPayload = { error?: unknown };

const authBase = () => baseUrl.endsWith("/lead-discovery") ? baseUrl.slice(0, -"/lead-discovery".length) : baseUrl;
const tokenKey = "lead-api-token";
const refreshKey = "lead-refresh-token";
const browserToken = (fallback?: string) => typeof window === "undefined" ? fallback : window.localStorage.getItem(tokenKey) || fallback;
let refreshInFlight: Promise<AuthSession> | null = null;

class ApiError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ApiError";
  }
}

const errorMessage = (payload: ErrorPayload, fallback: string): string =>
  typeof payload.error === "string" ? payload.error : fallback;

async function authRequest<T>(path: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${authBase()}/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as ErrorPayload;
  if (!response.ok) throw new ApiError(errorMessage(payload, "Authentication request failed"), response.status);
  return payload as T;
}

/**
 * Rotate the browser's one-use refresh token once, even when several dashboard
 * reads receive 401 together. A transient network/5xx failure is propagated and
 * keeps the refresh token so the user can retry; an invalid/expired refresh token
 * clears the unusable local session.
 */
function refreshBrowserSession(): Promise<AuthSession> {
  if (refreshInFlight) return refreshInFlight;
  if (typeof window === "undefined") return Promise.reject(new Error("Session refresh is only available in a browser"));
  const refreshToken = window.localStorage.getItem(refreshKey);
  if (!refreshToken) return Promise.reject(new ApiError("Session expired", 401));

  const rotation = authRequest<AuthSession>("refresh", { refreshToken })
    .then(session => {
      window.localStorage.setItem(tokenKey, session.token);
      window.localStorage.setItem(refreshKey, session.refreshToken);
      return session;
    })
    .catch(error => {
      if (error instanceof ApiError && error.statusCode === 401) {
        window.localStorage.removeItem(tokenKey);
        window.localStorage.removeItem(refreshKey);
      }
      throw error;
    })
    .finally(() => { refreshInFlight = null; });
  refreshInFlight = rotation;
  return rotation;
}

/** Fetch an authenticated API resource, rotating an expired access token once. */
export async function authenticatedFetch(url: string | URL, init: RequestInit = {}, fallbackToken?: string): Promise<Response> {
  const send = (accessToken?: string) => {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    else headers.delete("authorization");
    return fetch(url, { ...init, headers });
  };

  const response = await send(browserToken(fallbackToken));
  if (response.status !== 401 || typeof window === "undefined") return response;

  if (!window.localStorage.getItem(refreshKey)) {
    window.localStorage.removeItem(tokenKey);
    return response;
  }

  // Do not convert a failed refresh into an apparently ordinary API response:
  // network and server failures are surfaced to the caller, while a revoked or
  // expired refresh token clears storage and surfaces its explicit 401 message.
  const session = await refreshBrowserSession();
  return send(session.token);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, ...init } = options;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await authenticatedFetch(`${baseUrl}${path}`, { ...init, headers }, token);
  const payload = await response.json().catch(() => ({})) as ErrorPayload;
  if (!response.ok) throw new ApiError(errorMessage(payload, "Request failed"), response.status);
  return payload as T;
}

export const authApi = {
  login: (email: string, password: string, organizationId?: string) => authRequest<AuthSession>("login", { email, password, ...(organizationId ? { organizationId } : {}) }),
  refresh: (refreshToken: string) => authRequest<AuthSession>("refresh", { refreshToken }),
  logout: async (refreshToken: string): Promise<void> => { await authRequest<{ ok: true }>("logout", { refreshToken }); },
  me: async (token: string) => {
    const response = await authenticatedFetch(`${authBase()}/auth/me`, {}, token);
    const payload = await response.json().catch(() => ({})) as ErrorPayload & { user?: AuthUser };
    if (!response.ok) throw new ApiError(errorMessage(payload, "Session expired"), response.status);
    return payload as { user: AuthUser };
  },
};

export const leadDiscoveryApi = {
  providers: (token: string) => request<{ providers: ProviderOption[] }>("/providers", { token }),
  search: (input: BusinessSearchInput, token: string) => request<BusinessSearchResult & { providerDuplicateRows?: number }>("/search", { method: "POST", body: JSON.stringify(input), token }),
  history: (token: string) => request<SearchHistoryResponse>("/history", { token }),
};

export const leadApi = {
  list: (token: string, filters: { status?: LeadStatus; q?: string; country?: string; category?: string; ownerId?: string } = {}) => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null && value !== "") as Array<[string, string]>).toString();
    return request<{ leads: Lead[]; count: number }>(`/leads${query ? `?${query}` : ""}`, { token });
  },
  detail: (id: string, token: string) => request<LeadDetails>(`/leads/${encodeURIComponent(id)}`, { token }),
  coverage: (token: string, missing?: string) => request<Coverage>(`/coverage${missing ? `?missing=${encodeURIComponent(missing)}` : ""}`, { token }),
  updateStatus: (id: string, status: LeadStatus, token: string) => request<{ ok: true; status: LeadStatus }>(`/leads/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }), token }),
  updateOwner: (id: string, ownerId: string | null, token: string) => request<{ ok: true; ownerId: string | null }>(`/leads/${encodeURIComponent(id)}/owner`, { method: "PATCH", body: JSON.stringify({ ownerId }), token }),
};

export const leadPipelineApi = {
  summary: (token: string) => request<PipelineSummary>("/summary", { token }),
  pipeline: (token: string) => request<{ statuses: LeadStatus[]; columns: Record<LeadStatus, Lead[]> }>("/pipeline", { token }),
  notes: (id: string, token: string) => request<{ notes: LeadNote[] }>(`/leads/${encodeURIComponent(id)}/notes`, { token }),
  addNote: (id: string, body: string, token: string) => request<LeadNote>(`/leads/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ body }), token }),
  activity: (id: string, token: string) => request<{ activity: LeadActivity[] }>(`/leads/${encodeURIComponent(id)}/activity`, { token }),
};

export const membersApi = {
  list: (token: string) => request<{ members: OrganizationMember[] }>("/members", { token }),
};

export const collectionsApi = {
  list: (token: string) => request<{ collections: CollectionSummary[] }>("/collections", { token }),
  create: (name: string, token: string) => request<CollectionSummary>("/collections", { method: "POST", body: JSON.stringify({ name }), token }),
  update: (id: string, name: string, token: string) => request<{ ok: true }>(`/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }), token }),
  remove: (id: string, token: string) => request<{ ok: true }>(`/collections/${encodeURIComponent(id)}`, { method: "DELETE", token }),
  leads: (id: string, token: string) => request<{ leads: Lead[] }>(`/collections/${encodeURIComponent(id)}/leads`, { token }),
  addLeads: (id: string, leadIds: string[], token: string) => request<{ ok: true; added: number }>(`/collections/${encodeURIComponent(id)}/leads`, { method: "POST", body: JSON.stringify({ leadIds }), token }),
  removeLead: (id: string, leadId: string, token: string) => request<{ ok: true; removed: number }>(`/collections/${encodeURIComponent(id)}/leads/${encodeURIComponent(leadId)}`, { method: "DELETE", token }),
};

export const intelligenceApi = {
  history: leadDiscoveryApi.history,
  duplicates: (token: string) => request<{ duplicates: Duplicate[] }>("/duplicates", { token }),
  resolveDuplicate: (candidateId: string, action: "keep_a" | "keep_b" | "merge" | "ignore", token: string) => request<{ ok: true }>("/duplicates/resolve", { method: "POST", body: JSON.stringify({ candidateId, action }), token }),
  exportPreview: (filters: Record<string, unknown>, token: string) => request<{ rows: Record<string, unknown>[]; count: number; csvSafe: boolean }>("/export/preview", { method: "POST", body: JSON.stringify(filters), token }),
  exportJson: (filters: Record<string, unknown>, token: string) => request<{ leads: Lead[]; count: number }>("/export", { method: "POST", body: JSON.stringify(filters), token }),
  exportCsv: async (filters: Record<string, unknown>, token: string): Promise<Blob> => {
    const response = await authenticatedFetch(`${baseUrl}/export/csv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(filters),
    }, token);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as ErrorPayload;
      throw new ApiError(errorMessage(payload, "CSV export failed"), response.status);
    }
    return response.blob();
  },
};
