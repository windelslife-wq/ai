/**
 * Typed API client for the workspace SPA.
 *
 * Every non-2xx answer becomes an `ApiError` carrying the server's `code`, the
 * field-level `details` when validation failed, and `retryAfter` when the server
 * said to wait — so a view can render "email is already taken" or "try again in
 * 42s" instead of a generic "Request failed". The CSRF token is held here and
 * attached to every unsafe method; a 401 clears the session state exactly once.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor({ status, code, message, details = null, retryAfter = 0 }) {
    super(message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code || "UNKNOWN";
    this.details = details;
    this.retryAfter = retryAfter;
  }

  get isAuthFailure() {
    return this.status === 401;
  }

  get isPermissionFailure() {
    return this.status === 403;
  }

  /** The first field-level problem, for inline form errors. */
  fieldMessage(field) {
    const issue = (this.details || []).find((entry) => entry.field === field || entry.field === `body.${field}`);
    return issue ? issue.message : null;
  }
}

let csrfToken = "";
let onUnauthorized = null;

export function setCsrfToken(token) {
  csrfToken = token || "";
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function parseError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const error = new ApiError({
    status: response.status,
    code: payload?.error?.code,
    message: payload?.error?.message,
    details: payload?.error?.details || null,
    retryAfter: Number(response.headers.get("retry-after") || payload?.error?.retryAfter || 0),
  });
  if (error.isAuthFailure && onUnauthorized) onUnauthorized(error);
  return error;
}

export async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  const requestHeaders = new Headers(headers);
  if (body !== undefined && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  if (unsafe && csrfToken && !requestHeaders.has("x-csrf-token")) requestHeaders.set("x-csrf-token", csrfToken);

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    credentials: "include",
    signal,
  });

  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw await parseError(response);
  return data;
}

export const endpoints = {
  me: () => api("/api/v1/auth/me"),
  csrf: () => api("/api/v1/auth/csrf"),
  login: (payload) => api("/api/v1/auth/login", { method: "POST", body: payload }),
  register: (payload) => api("/api/v1/auth/register", { method: "POST", body: payload }),
  logout: () => api("/api/v1/auth/logout", { method: "POST", body: {} }),
  ready: () => api("/api/v1/health/ready"),
  status: () => api("/api/v1/system/status"),
  features: () => api("/api/v1/system/features"),
  account: () => api("/api/v1/account"),
  sessions: () => api("/api/v1/account/sessions"),
  revokeSessions: () => api("/api/v1/account/sessions", { method: "DELETE" }),
  activity: (query = "") => api(`/api/v1/account/activity${query}`),
  updateProfile: (payload) => api("/api/v1/account/profile", { method: "PUT", body: payload }),
  updateUsername: (payload) => api("/api/v1/account/username", { method: "PATCH", body: payload }),
  updateEmail: (payload) => api("/api/v1/account/email", { method: "PATCH", body: payload }),
  changePassword: (payload) => api("/api/v1/account/password", { method: "PUT", body: payload }),
  adminUsers: (query = "") => api(`/api/v1/admin/users${query}`),
  adminCreateUser: (payload) => api("/api/v1/admin/users", { method: "POST", body: payload }),
  adminSetUserStatus: (userId, payload) => api(`/api/v1/admin/users/${userId}/status`, { method: "PATCH", body: payload }),
  adminRoles: () => api("/api/v1/admin/roles"),
  adminInquiries: (query = "") => api(`/api/v1/admin/inquiries${query}`),
  // Console screens (Phase 27). Each of these binds to a route that already
  // existed and was tested before the screen did — the screens add no surface,
  // and none of them can reach one that is not listed in `GET /api/v1/system/routes`.
  notifications: (query = "") => api(`/api/v1/notifications${query}`),
  markNotificationRead: (notificationId) => api(`/api/v1/notifications/${notificationId}/read`, { method: "POST", body: {} }),
  markAllNotificationsRead: () => api("/api/v1/notifications/read-all", { method: "POST", body: {} }),
  audit: (query = "") => api(`/api/v1/admin/audit${query}`),
  optimizePortfolio: (payload) => api("/api/v1/portfolio/optimize", { method: "POST", body: payload }),
  // Sports console (Phase 28). The reads are all `sports.view`; the two writes are
  // the human-in-the-loop controls legacy's console carried, under their own
  // permissions. No other sports mutation has a client call at all.
  sportsStatus: (query = "") => api(`/api/v1/sports/status${query}`),
  sportsProviders: (query = "") => api(`/api/v1/sports/providers${query}`),
  sportsSyncRuns: (query = "") => api(`/api/v1/sports/sync-runs${query}`),
  sportsMatches: (query = "") => api(`/api/v1/sports/matches${query}`),
  sportsPredictions: (query = "") => api(`/api/v1/sports/predictions${query}`),
  sportsTickets: (query = "") => api(`/api/v1/sports/tickets${query}`),
  sportsDailyTickets: (query = "") => api(`/api/v1/sports/daily-tickets${query}`),
  sportsPerformance: (query = "") => api(`/api/v1/sports/performance${query}`),
  sportsModels: () => api("/api/v1/sports/models"),
  sportsCalibrations: (query = "") => api(`/api/v1/sports/calibrations${query}`),
  sportsDecideTicket: (ticketId, payload) => api(`/api/v1/sports/tickets/${ticketId}/decision`, { method: "POST", body: payload }),
  sportsSettleTicket: (ticketId, payload) => api(`/api/v1/sports/tickets/${ticketId}/settle`, { method: "POST", body: payload }),
  // Lottery console (Phase 28). `status` needs only a session, as legacy's did; the
  // reads need `lottery.view`, the probe and sync need `lottery.manage`, and the
  // ticket check is a `lottery.view` POST (a record read, not managed ingestion).
  lotteryStatus: () => api("/api/v1/lottery/status"),
  lotteryHealth: () => api("/api/v1/lottery/health"),
  lotteryProviders: () => api("/api/v1/lottery/providers"),
  lotteryDraws: (query = "") => api(`/api/v1/lottery/draws${query}`),
  lotteryStatistics: (kind, query = "") => api(`/api/v1/lottery/statistics/${kind}${query}`),
  lotteryDecisions: (query = "") => api(`/api/v1/lottery/ai-decisions${query}`),
  lotteryTickets: (query = "") => api(`/api/v1/lottery/tickets${query}`),
  lotteryPerformance: () => api("/api/v1/lottery/performance"),
  lotteryModels: () => api("/api/v1/lottery/models"),
  lotteryJobs: (query = "") => api(`/api/v1/lottery/jobs${query}`),
  lotteryCheckTicket: (ticketId) => api(`/api/v1/lottery/tickets/${ticketId}/check`, { method: "POST", body: {} }),
  lotteryProbe: () => api("/api/v1/lottery/providers/check", { method: "POST", body: {} }),
  lotterySync: (payload = {}) => api("/api/v1/lottery/sync", { method: "POST", body: payload }),
};
