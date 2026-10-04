import { baseUrl } from "./leadDiscovery";
import { getAccessToken } from "./session";

export type AdminOverview = { organizationId: string; members: number; leads: number; collections: number; searches: number };
export type AdminUser = { id: string; email: string; displayName: string; active: boolean; role: "owner" | "admin" | "member"; createdAt: string; updatedAt: string };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl.replace("/lead-discovery", "/admin")}${path}`, { ...options, headers: { "content-type": "application/json", authorization: `Bearer ${getAccessToken()}`, ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Administrator request failed");
  return payload as T;
}

export const adminApi = {
  overview: (token: string) => request<AdminOverview>("/overview", { headers: { authorization: `Bearer ${token}` } }),
  users: (token: string) => request<{ users: AdminUser[] }>("/users", { headers: { authorization: `Bearer ${token}` } }),
  createUser: (input: { email: string; displayName: string; password: string; role: "admin" | "member" }, token: string) => request<{ ok: true; user: AdminUser }>("/users", { method: "POST", body: JSON.stringify(input), headers: { authorization: `Bearer ${token}` } }),
  updateUser: (id: string, input: { active?: boolean; role?: "admin" | "member" }, token: string) => request<{ ok: true }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(input), headers: { authorization: `Bearer ${token}` } }),
};
