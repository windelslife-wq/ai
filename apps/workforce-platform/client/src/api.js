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
  // A multipart body must keep the browser's own content-type — it carries the
  // boundary — so the JSON default and the stringify step both skip it.
  const multipart = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !multipart && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  if (unsafe && csrfToken && !requestHeaders.has("x-csrf-token")) requestHeaders.set("x-csrf-token", csrfToken);

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : multipart || typeof body === "string" ? body : JSON.stringify(body),
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
  passwordResetRequest: (payload) => api("/api/v1/auth/password-reset-request", { method: "POST", body: payload }),
  passwordResetConfirm: (payload) => api("/api/v1/auth/password-reset-confirm", { method: "POST", body: payload }),
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
  // Multipart (see `api`): the FormData carries its own boundary, and the
  // server sniffs the bytes — the field name `avatar` matches the legacy input.
  uploadAvatar: (formData) => api("/api/v1/account/avatar", { method: "POST", body: formData }),
  removeAvatar: () => api("/api/v1/account/avatar", { method: "DELETE", body: {} }),
  adminUsers: (query = "") => api(`/api/v1/admin/users${query}`),
  adminCreateUser: (payload) => api("/api/v1/admin/users", { method: "POST", body: payload }),
  adminSetUserStatus: (userId, payload) => api(`/api/v1/admin/users/${userId}/status`, { method: "PATCH", body: payload }),
  adminRoles: () => api("/api/v1/admin/roles"),
  adminInquiries: (query = "") => api(`/api/v1/admin/inquiries${query}`),
  adminAudit: (query = "") => api(`/api/v1/admin/audit${query}`),
  // Row 5: the credential-free mail summary and the legacy test send.
  adminMail: () => api("/api/v1/admin/mail"),
  adminTestEmail: (payload) => api("/api/v1/admin/mail/test", { method: "POST", body: payload }),
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
  // AI Workforce console (Phase 32). The analysis routes are session-only — legacy's
  // `Api_controller` guarded them with authentication alone — so these wrappers
  // carry no permission; the two governance writes are `trading.control` on the
  // server and the view renders them disabled without it.
  analysisRun: (payload) => api("/api/v1/analysis/run", { method: "POST", body: payload }),
  analysisHistory: (query = "") => api(`/api/v1/analysis/history${query}`),
  analysisAgents: () => api("/api/v1/analysis/agents"),
  analysisRunDetail: (runId) => api(`/api/v1/analysis/${encodeURIComponent(runId)}`),
  analysisConsensus: (payload) => api("/api/v1/analysis/consensus", { method: "POST", body: payload }),
  candles: (query = "") => api(`/api/v1/market-data/candles${query}`),
  tradingMode: () => api("/api/v1/trading/mode"),
  setTradingMode: (payload) => api("/api/v1/trading/mode", { method: "POST", body: payload }),
  setKillSwitch: (payload) => api("/api/v1/trading/kill-switch", { method: "POST", body: payload }),
  // The paper trading console (Phase 37). Every read is `trading.view` on the server and
  // every mutation is `trading.execute`; the screen checks the same permissions before it
  // offers a control, and the API re-checks them either way. The dashboard's own
  // paper-account count (Phase 33) uses the first of these.
  paperAccounts: (query = "") => api(`/api/v1/paper/accounts${query}`),
  paperAccount: (accountId) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}`),
  paperOrders: (accountId, query = "") => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/orders${query}`),
  paperPositions: (accountId, query = "") => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/positions${query}`),
  paperCreateAccount: (payload) => api("/api/v1/paper/accounts", { method: "POST", body: payload }),
  paperSubmitOrder: (accountId, payload) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/orders`, { method: "POST", body: payload }),
  paperClosePosition: (accountId, positionId) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(positionId)}/close`, { method: "POST", body: {} }),
  paperTick: (accountId) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/tick`, { method: "POST", body: {} }),
  paperDeployments: (accountId) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/deployments`),
  paperDeployStrategy: (accountId, payload) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/deployments`, { method: "POST", body: payload }),
  paperToggleDeployment: (accountId, deploymentId, active) => api(`/api/v1/paper/accounts/${encodeURIComponent(accountId)}/deployments/${encodeURIComponent(deploymentId)}/toggle`, { method: "POST", body: { active } }),
  riskLimits: () => api("/api/v1/risk/limits"),
  updateRiskLimits: (patch) => api("/api/v1/risk/limits/update", { method: "POST", body: patch }),
  portfolioRiskScan: (query = "") => api(`/api/v1/portfolio/risk-scan${query}`),
  // Broker Center (Phase 40, extended): authenticated broker readiness plus MT5 and
  // in-process simulator account/quote reads. There is still no direct broker-order route;
  // proposal submission to the demo bridge is separately permissioned under execution.
  brokers: () => api("/api/v1/brokers"),
  brokerMt5Account: () => api("/api/v1/brokers/mt5/account"),
  brokerMt5Quote: (symbol) => api(`/api/v1/brokers/mt5/quote?symbol=${encodeURIComponent(symbol)}`),
  brokerSimulationAccount: () => api("/api/v1/brokers/simulation/account"),
  brokerSimulationQuote: (symbol) => api(`/api/v1/brokers/simulation/quote?symbol=${encodeURIComponent(symbol)}`),
  // The journal console (Phase 41). Three session-only reads, exactly the guards the
  // strategies module's routes carry; the module's one write (`POST /journal/manual`) is
  // deliberately not wrapped — the screen does not draw it, as legacy's page did not.
  journal: (query = "") => api(`/api/v1/journal${query}`),
  // The query is appended as a suffix rather than written into the template's literal, the
  // same way `backtestHistory` takes its query — the client-route contract reads the literal
  // prefix before `${`, and a `?groupBy=` inside it would look like an unregistered path.
  journalSummary: (groupBy) => api(`/api/v1/journal/analytics/summary${groupBy ? `?groupBy=${encodeURIComponent(groupBy)}` : ""}`),
  journalCalibration: () => api("/api/v1/journal/analytics/calibration"),
  // The Execution Center: proposal/status/automation reads use `trading.view`; proposal,
  // Paper Trading, simulator and request-based automated Paper submissions use
  // `trading.execute`; mode/limit/approval governance uses `trading.control`. The simulator
  // route is owner-scoped and human-approved, and cannot reach a real broker connector.
  executionStatus: () => api("/api/v1/execution/status"),
  executionAutomation: () => api("/api/v1/execution/automation"),
  executionProposals: (query = "") => api(`/api/v1/execution/proposals${query}`),
  executionProposal: (proposalId) => api(`/api/v1/execution/proposals/${encodeURIComponent(proposalId)}`),
  proposeExecution: (payload) => api("/api/v1/execution/proposals", { method: "POST", body: payload }),
  decideExecution: (proposalId, payload) => api(`/api/v1/execution/proposals/${encodeURIComponent(proposalId)}/decision`, { method: "POST", body: payload }),
  submitExecutionPaper: (proposalId) => api(`/api/v1/execution/proposals/${encodeURIComponent(proposalId)}/paper-submit`, { method: "POST", body: {} }),
  submitExecutionSimulator: (proposalId) => api(`/api/v1/execution/proposals/${encodeURIComponent(proposalId)}/simulator-submit`, { method: "POST", body: {} }),
  updateExecutionAutomationLimits: (payload) => api("/api/v1/execution/automation-limits", { method: "PATCH", body: payload }),
  setExecutionMode: (payload) => api("/api/v1/execution/mode", { method: "POST", body: payload }),
  executeAutomatedPaper: (payload) => api("/api/v1/execution/automated-paper", { method: "POST", body: payload }),
  // Sports Intelligence console (Phase 36). Every read here is `sports.view` on the
  // server except the active configuration, which is one of the module's two
  // `sports.manage` reads; the two writes are `sports.approve` (the decision, which also
  // needs a released kill switch) and `sports.settle`. The screen checks the same
  // permissions before offering a control, and the server re-checks them either way.
  sportsStatus: () => api("/api/v1/sports/status"),
  sportsMatches: (query = "") => api(`/api/v1/sports/matches${query}`),
  sportsMatchIntelligence: (matchId) => api(`/api/v1/sports/matches/${encodeURIComponent(matchId)}/intelligence`),
  sportsPredictions: (query = "") => api(`/api/v1/sports/predictions${query}`),
  sportsDailyRuns: (query = "") => api(`/api/v1/sports/daily-tickets${query}`),
  sportsTickets: (query = "") => api(`/api/v1/sports/tickets${query}`),
  sportsTicket: (ticketId) => api(`/api/v1/sports/tickets/${encodeURIComponent(ticketId)}`),
  sportsDecideTicket: (ticketId, payload) => api(`/api/v1/sports/tickets/${encodeURIComponent(ticketId)}/decision`, { method: "POST", body: payload }),
  sportsSettleTicket: (ticketId) => api(`/api/v1/sports/tickets/${encodeURIComponent(ticketId)}/settle`, { method: "POST", body: {} }),
  sportsPerformance: (query = "") => api(`/api/v1/sports/performance${query}`),
  sportsModels: () => api("/api/v1/sports/models"),
  sportsCalibrations: (query = "") => api(`/api/v1/sports/calibrations${query}`),
  sportsSyncRuns: (query = "") => api(`/api/v1/sports/sync-runs${query}`),
  sportsConfiguration: () => api("/api/v1/sports/configuration"),
  notificationInbox: (query = "") => api(`/api/v1/notifications${query}`),
  markNotificationRead: (notificationId) => api(`/api/v1/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", body: {} }),
  markAllNotificationsRead: () => api("/api/v1/notifications/read-all", { method: "POST", body: {} }),
  // The public website assistant (rows 4 and 18 — Phase 43). Public route (`auth: false`,
  // `permission: null`), mounted on both the public pages and the workspace shell and
  // omitted from the auth screens (`EntryLayout`).
  chatRespond: (payload) => api("/api/v1/chat/respond", { method: "POST", body: payload }),
  // Lead Discovery console (row 17 — Phase 45). Every route requires `system.authenticated`
  // on the server and resolves the active workspace via `X-Lead-Organization`.
  leadWorkspaces: (orgId = "") => api("/api/v1/lead-discovery/workspaces", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadProviders: (orgId = "") => api("/api/v1/lead-discovery/providers", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadSearch: (payload, orgId = "") => api("/api/v1/lead-discovery/search", { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leads: (query = "", orgId = "") => api(`/api/v1/lead-discovery/leads${query}`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadDetail: (leadId, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadCollections: (orgId = "") => api("/api/v1/lead-discovery/collections", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadCreateCollection: (payload, orgId = "") => api("/api/v1/lead-discovery/collections", { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadUpdateCollection: (collectionId, payload, orgId = "") => api(`/api/v1/lead-discovery/collections/${encodeURIComponent(collectionId)}`, { method: "PATCH", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadDeleteCollection: (collectionId, orgId = "") => api(`/api/v1/lead-discovery/collections/${encodeURIComponent(collectionId)}`, { method: "DELETE", headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadCollectionLeads: (collectionId, orgId = "") => api(`/api/v1/lead-discovery/collections/${encodeURIComponent(collectionId)}/leads`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadAddCollectionLeads: (collectionId, payload, orgId = "") => api(`/api/v1/lead-discovery/collections/${encodeURIComponent(collectionId)}/leads`, { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadRemoveCollectionLead: (collectionId, leadId, orgId = "") => api(`/api/v1/lead-discovery/collections/${encodeURIComponent(collectionId)}/leads/${encodeURIComponent(leadId)}`, { method: "DELETE", headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadUpdateStatus: (leadId, payload, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}/status`, { method: "PATCH", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadUpdateOwner: (leadId, payload, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}/owner`, { method: "PATCH", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadNotes: (leadId, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}/notes`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadAddNote: (leadId, payload, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}/notes`, { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadActivity: (leadId, orgId = "") => api(`/api/v1/lead-discovery/leads/${encodeURIComponent(leadId)}/activity`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadDuplicates: (orgId = "") => api("/api/v1/lead-discovery/duplicates", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadResolveDuplicate: (payload, orgId = "") => api("/api/v1/lead-discovery/duplicates/resolve", { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadCoverage: (query = "", orgId = "") => api(`/api/v1/lead-discovery/coverage${query}`, { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadHistory: (orgId = "") => api("/api/v1/lead-discovery/history", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadSummary: (orgId = "") => api("/api/v1/lead-discovery/summary", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadPipeline: (orgId = "") => api("/api/v1/lead-discovery/pipeline", { headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadExport: (payload = {}, orgId = "") => api("/api/v1/lead-discovery/export", { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  leadExportPreview: (payload = {}, orgId = "") => api("/api/v1/lead-discovery/export/preview", { method: "POST", body: payload, headers: orgId ? { "X-Lead-Organization": orgId } : {} }),
  // AI Language Learning & AI Teacher console (row 16 — Phase 46).
  langLanguages: () => api("/api/v1/language-learning/languages"),
  langLanguage: (code) => api(`/api/v1/language-learning/languages/${encodeURIComponent(code)}`),
  langDetect: (payload) => api("/api/v1/language-learning/detect", { method: "POST", body: payload }),
  langTranslate: (payload) => api("/api/v1/language-learning/translate", { method: "POST", body: payload }),
  langProfiles: () => api("/api/v1/language-learning/profiles"),
  langCreateProfile: (payload) => api("/api/v1/language-learning/profiles", { method: "POST", body: payload }),
  langProfile: (id) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(id)}`),
  langStartAssessment: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/assessment/start`, { method: "POST", body: {} }),
  langAssessment: (id) => api(`/api/v1/language-learning/assessment/${encodeURIComponent(id)}`),
  langAnswerAssessment: (id, payload) => api(`/api/v1/language-learning/assessment/${encodeURIComponent(id)}/answer`, { method: "POST", body: payload }),
  langGeneratePath: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/path/generate`, { method: "POST", body: {} }),
  langPath: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/path`),
  langStartCheckpoint: (moduleId) => api(`/api/v1/language-learning/modules/${encodeURIComponent(moduleId)}/checkpoint/start`, { method: "POST", body: {} }),
  langSubmitCheckpoint: (moduleId, payload) => api(`/api/v1/language-learning/modules/${encodeURIComponent(moduleId)}/checkpoint/answer`, { method: "POST", body: payload }),
  langProgress: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/progress`),
  langStartLesson: (moduleId) => api(`/api/v1/language-learning/modules/${encodeURIComponent(moduleId)}/lesson/start`, { method: "POST", body: {} }),
  langSubmitLesson: (moduleId, payload) => api(`/api/v1/language-learning/modules/${encodeURIComponent(moduleId)}/lesson/answer`, { method: "POST", body: payload }),
  langConversations: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/conversations`),
  langStartConversation: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/conversations/start`, { method: "POST", body: payload }),
  langConversationTurn: (sessionId, payload) => api(`/api/v1/language-learning/conversations/${encodeURIComponent(sessionId)}/turn`, { method: "POST", body: payload }),
  langWritingTasks: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/writing/tasks`),
  langSubmitWriting: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/writing/submit`, { method: "POST", body: payload }),
  langGrammar: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/grammar`),
  langGrammarSimple: (profileId, ruleId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/grammar/${encodeURIComponent(ruleId)}/simple`),
  langVocabulary: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary`),
  langAddVocabulary: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary/add`, { method: "POST", body: payload }),
  langVocabularyDue: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary/due`),
  langStartVocabularyReview: (profileId, query = "") => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary/review/start${query}`),
  langSubmitVocabularyReview: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary/review/submit`, { method: "POST", body: payload }),
  langVocabularyProgress: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/vocabulary/progress`),
  langListeningExercises: (profileId, query = "") => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/listening/exercises${query}`),
  langSubmitListening: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/listening/attempt`, { method: "POST", body: payload }),
  langSpeakingPrompts: (profileId, query = "") => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/speaking/prompts${query}`),
  langSubmitSpeaking: (profileId, payload) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/speaking/attempt`, { method: "POST", body: payload }),
  langWeaknesses: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/adaptive/weaknesses`),
  langDailyPlan: (profileId, query = "") => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/adaptive/daily-plan${query}`),
  langRegenerateDailyPlan: (profileId, query = "") => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/adaptive/daily-plan${query}`, { method: "POST", body: {} }),
  langRecommendations: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/adaptive/recommendations`),
  langMastery: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/adaptive/mastery`),
  langHistory: (profileId) => api(`/api/v1/language-learning/profiles/${encodeURIComponent(profileId)}/history`),
};
