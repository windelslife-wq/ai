import type { BusinessSearchInput, BusinessSearchResult, Lead, LeadNote, LeadStatus, PipelineSummary, SearchHistory } from "../../../../packages/shared/src/leadDiscovery";

/** Browser-safe default: relative URLs are proxied by Next, never localhost from the user's browser. */
const configuredBaseUrl = process.env.NEXT_PUBLIC_LEAD_API_URL;
// Local development and Arena previews use the Next rewrite. This prevents browser code from ever calling localhost directly.
export const baseUrl = (configuredBaseUrl && !/localhost|127\.0\.0\.1/.test(configuredBaseUrl) ? configuredBaseUrl : "/api/v1/lead-discovery").replace(/\/$/, "");
export type AuthSession = { token: string; refreshToken: string; user: { id: string; email: string; displayName: string | null }; organizationId: string; permissions: string[] };
export type ProviderOption = { name: string; health: { name: string; status: "IMPLEMENTED" | "TESTED" | "DISABLED" | "PLANNED"; detail?: string } };
export type CollectionSummary = { id: string; organizationId: string; name: string; leadCount: number; createdAt: string; updatedAt: string };
export type LeadActivity = { id: string; leadId: string | null; actorId: string | null; type: string; detail: Record<string, unknown>; createdAt: string };
export type LeadDetails = { lead: Lead; notes: LeadNote[]; activity: LeadActivity[] };
export type Duplicate = { id: string; leadAId: string; leadBId: string; leadAName: string; leadBName: string; ruleName: string; confidence: number; status: "open" | "resolved"; createdAt: string };
export type Coverage = { leadCount: number; fields: Array<{ key: string; field: string; coverage: number; missing: number }>; missingField: string | null; missingLeads: Lead[] };
export type SearchHistoryResponse = { history: SearchHistory[] };

type RequestOptions = RequestInit & { token?: string };
const browserToken = (fallback?: string) => typeof window === "undefined" ? fallback : window.localStorage.getItem("lead-api-token") ?? fallback;
const authBase = () => baseUrl.endsWith("/lead-discovery") ? baseUrl.slice(0, -"/lead-discovery".length) : baseUrl;

const authRequest = async (path: string, body: Record<string, string>): Promise<AuthSession> => {
  const response = await fetch(`${authBase()}/auth/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Authentication request failed");
  return payload as AuthSession;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, ...init } = options;
  const send = async (accessToken?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(init.headers ?? {}) },
    });
    return { response, payload: await response.json().catch(() => ({})) };
  };
  let accessToken = browserToken(token);
  let result = await send(accessToken);
  if (result.response.status === 401 && typeof window !== "undefined") {
    const refreshToken = window.localStorage.getItem("lead-refresh-token");
    if (refreshToken) {
      try {
        const session = await authRequest("refresh", { refreshToken });
        window.localStorage.setItem("lead-api-token", session.token);
        window.localStorage.setItem("lead-refresh-token", session.refreshToken);
        accessToken = session.token;
        result = await send(accessToken);
      } catch { window.localStorage.removeItem("lead-api-token"); window.localStorage.removeItem("lead-refresh-token"); }
    }
  }
  if (!result.response.ok) throw new Error(typeof result.payload.error === "string" ? result.payload.error : "Request failed");
  return result.payload as T;
}

export const authApi = {
  login: (email: string, password: string, organizationId?: string) => authRequest("login", { email, password, ...(organizationId ? { organizationId } : {}) }),
  refresh: (refreshToken: string) => authRequest("refresh", { refreshToken }),
  logout: async (refreshToken: string) => { await authRequest("logout", { refreshToken }); },
  me: async (token: string) => {
    const response = await fetch(`${authBase()}/auth/me`, { headers: { authorization: `Bearer ${browserToken(token) ?? ""}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Session expired");
    return payload as { user: { id: string; email: string; displayName: string | null; organizationId: string; permissions: string[] } };
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
  updateStatus: (id: string, status: LeadStatus, token: string) => request<{ ok: true; status: LeadStatus }>(`/leads/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }), token }),
  updateOwner: (id: string, ownerId: string | null, token: string) => request<{ ok: true; ownerId: string | null }>(`/leads/${id}/owner`, { method: "PATCH", body: JSON.stringify({ ownerId }), token }),
};

export const leadPipelineApi = {
  summary: (token: string) => request<PipelineSummary>("/summary", { token }),
  pipeline: (token: string) => request<{ statuses: LeadStatus[]; columns: Record<LeadStatus, Lead[]> }>("/pipeline", { token }),
  notes: (id: string, token: string) => request<{ notes: LeadNote[] }>(`/leads/${id}/notes`, { token }),
  addNote: (id: string, body: string, token: string) => request<LeadNote>(`/leads/${id}/notes`, { method: "POST", body: JSON.stringify({ body }), token }),
  activity: (id: string, token: string) => request<{ activity: LeadActivity[] }>(`/leads/${id}/activity`, { token }),
};

export const collectionsApi = {
  list: (token: string) => request<{ collections: CollectionSummary[] }>("/collections", { token }),
  create: (name: string, token: string) => request<CollectionSummary>("/collections", { method: "POST", body: JSON.stringify({ name }), token }),
  update: (id: string, name: string, token: string) => request<{ ok: true }>(`/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }), token }),
  remove: (id: string, token: string) => request<{ ok: true }>(`/collections/${id}`, { method: "DELETE", token }),
  leads: (id: string, token: string) => request<{ leads: Lead[] }>(`/collections/${id}/leads`, { token }),
  addLeads: (id: string, leadIds: string[], token: string) => request<{ ok: true; added: number }>(`/collections/${id}/leads`, { method: "POST", body: JSON.stringify({ leadIds }), token }),
  removeLead: (id: string, leadId: string, token: string) => request<{ ok: true; removed: number }>(`/collections/${id}/leads/${leadId}`, { method: "DELETE", token }),
};

export const intelligenceApi = {
  history: leadDiscoveryApi.history,
  duplicates: (token: string) => request<{ duplicates: Duplicate[] }>("/duplicates", { token }),
  resolveDuplicate: (candidateId: string, action: "keep_a" | "keep_b" | "merge" | "ignore", token: string) => request<{ ok: true }>("/duplicates/resolve", { method: "POST", body: JSON.stringify({ candidateId, action }), token }),
  exportPreview: (filters: Record<string, unknown>, token: string) => request<{ rows: Record<string, unknown>[]; count: number; csvSafe: boolean }>("/export/preview", { method: "POST", body: JSON.stringify(filters), token }),
  exportJson: (filters: Record<string, unknown>, token: string) => request<{ leads: Lead[]; count: number }>("/export", { method: "POST", body: JSON.stringify(filters), token }),
  exportCsv: async (filters: Record<string, unknown>, token: string): Promise<Blob> => {
    const response = await fetch(`${baseUrl}/export/csv`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${browserToken(token) ?? ""}` }, body: JSON.stringify(filters) });
    if (!response.ok) throw new Error("CSV export failed");
    return response.blob();
  },
};
