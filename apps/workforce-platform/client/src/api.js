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
  adminAudit: (query = "") => api(`/api/v1/admin/audit${query}`),
  optimizePortfolio: (payload) => api("/api/v1/portfolio/optimize", { method: "POST", body: payload }),
  lotteryStatus: () => api("/api/v1/lottery/status"),
  lotteryLotteries: () => api("/api/v1/lottery/lotteries"),
  lotteryRules: () => api("/api/v1/lottery/rules"),
  lotteryDraws: (query = "") => api(`/api/v1/lottery/draws${query}`),
  lotteryDraw: (drawId) => api(`/api/v1/lottery/draws/${encodeURIComponent(drawId)}`),
  lotteryStatistics: (kind, query = "") => api(`/api/v1/lottery/statistics/${encodeURIComponent(kind)}${query}`),
  lotteryProviders: () => api("/api/v1/lottery/providers"),
  lotteryHealth: () => api("/api/v1/lottery/health"),
  lotteryJobs: (query = "") => api(`/api/v1/lottery/jobs${query}`),
  lotteryAnalyze: (query = "") => api(`/api/v1/lottery/analyze${query}`),
  lotteryCombinations: (query = "") => api(`/api/v1/lottery/combinations${query}`),
  lotteryCombination: (combinationId) => api(`/api/v1/lottery/combinations/${encodeURIComponent(combinationId)}`),
  lotteryDecisions: (query = "") => api(`/api/v1/lottery/ai-decisions${query}`),
  lotteryDecision: (decisionId) => api(`/api/v1/lottery/ai-decisions/${encodeURIComponent(decisionId)}`),
  lotteryGenerate: (payload) => api("/api/v1/lottery/generate", { method: "POST", body: payload }),
  lotteryDiversity: (payload) => api("/api/v1/lottery/diversity", { method: "POST", body: payload }),
  lotterySystem: (payload) => api("/api/v1/lottery/system", { method: "POST", body: payload }),
  lotterySystemBuild: (payload) => api("/api/v1/lottery/system-build", { method: "POST", body: payload }),
  lotteryTickets: (query = "") => api(`/api/v1/lottery/tickets${query}`),
  lotteryTicket: (ticketId) => api(`/api/v1/lottery/tickets/${encodeURIComponent(ticketId)}`),
  lotteryCreateTicket: (payload) => api("/api/v1/lottery/tickets", { method: "POST", body: payload }),
  lotteryCheckTicket: (ticketId) => api(`/api/v1/lottery/tickets/${encodeURIComponent(ticketId)}/check`, { method: "POST", body: {} }),
  lotteryDeleteTicket: (ticketId) => api(`/api/v1/lottery/tickets/${encodeURIComponent(ticketId)}/delete`, { method: "POST", body: {} }),
  lotteryBacktest: (payload) => api("/api/v1/lottery/backtest", { method: "POST", body: payload }),
  lotteryBacktestCompare: (payload) => api("/api/v1/lottery/backtest-compare", { method: "POST", body: payload }),
  lotteryBacktests: (query = "") => api(`/api/v1/lottery/backtests${query}`),
  lotteryBacktestDetail: (backtestId) => api(`/api/v1/lottery/backtests/${encodeURIComponent(backtestId)}`),
  lotteryModels: () => api("/api/v1/lottery/models"),
  lotteryPerformance: () => api("/api/v1/lottery/performance"),
  lotteryCheckProvider: () => api("/api/v1/lottery/providers/check", { method: "POST", body: {} }),
  lotterySync: (payload = {}) => api("/api/v1/lottery/sync", { method: "POST", body: payload }),
  // Strategy Lab (Phase 31). The module's routes are session-only — no permission —
  // which is legacy's own guard (`Api_controller`, no `PUBLIC_ACTIONS` entry), so
  // the console passes no permission to the route table either. The sign-off route
  // is the one exception and needs `trading.control`; the server checks it.
  strategies: () => api("/api/v1/strategies"),
  strategyDetail: (strategyId, query = "") => api(`/api/v1/strategies/${encodeURIComponent(strategyId)}${query}`),
  strategyTransition: (strategyId, payload) => api(`/api/v1/strategies/${encodeURIComponent(strategyId)}/status`, { method: "POST", body: payload }),
  strategySignOff: (strategyId, payload) => api(`/api/v1/strategies/${encodeURIComponent(strategyId)}/sign-off`, { method: "POST", body: payload }),
  strategyOptimize: (strategyId, payload) => api(`/api/v1/strategies/${encodeURIComponent(strategyId)}/optimize`, { method: "POST", body: payload }),
  runBacktest: (payload) => api("/api/v1/backtesting/run", { method: "POST", body: payload }),
  backtestHistory: (query = "") => api(`/api/v1/backtesting/results${query}`),
  backtestResult: (backtestId) => api(`/api/v1/backtesting/results/${encodeURIComponent(backtestId)}`),
  notificationInbox: (query = "") => api(`/api/v1/notifications${query}`),
  markNotificationRead: (notificationId) => api(`/api/v1/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", body: {} }),
  markAllNotificationsRead: () => api("/api/v1/notifications/read-all", { method: "POST", body: {} }),
};
