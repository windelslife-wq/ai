import { authenticatedFetch, baseUrl } from "./leadDiscovery";

export type AdminOverview = { organizationId: string; members: number; leads: number; collections: number; searches: number };
export type AdminUser = { id: string; email: string; displayName: string; active: boolean; role: "owner" | "admin" | "member"; createdAt: string; updatedAt: string };

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  const response = await authenticatedFetch(
    `${baseUrl.replace("/lead-discovery", "/admin")}${path}`,
    { ...options, headers },
    token,
  );
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Administrator request failed";
    throw Object.assign(new Error(message), { statusCode: response.status });
  }
  return payload as T;
}

export const adminApi = {
  overview: (token: string) => request<AdminOverview>("/overview", token),
  users: (token: string) => request<{ users: AdminUser[] }>("/users", token),
  createUser: (input: { email: string; displayName: string; password: string; role: "admin" | "member" }, token: string) => request<{ ok: true; user: AdminUser }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (id: string, input: { active?: boolean; role?: "admin" | "member" }, token: string) => request<{ ok: true }>(`/users/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify(input) }),
};
