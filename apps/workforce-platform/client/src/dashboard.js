/**
 * The workspace dashboard's own logic (Phase 33, row 3).
 *
 * Plain ESM like the console modules, and for the same reason: `App.jsx` renders
 * it, `test/client_dashboard.test.js` imports it and drives a real server, and
 * nothing here touches JSX or a browser global.
 *
 * This is the port of `Workspace::index` → `views/workspace/index.php`, legacy's
 * `/dashboard` — the page sign-in lands on. Three rules run through it:
 *
 *  1. **Legacy's windows are kept.** The page read `history(6)`,
 *     `array_slice($notes, 0, 6)` and `inbox($userId, false, 8)`; the same
 *     numbers bound the reads here.
 *  2. **A number that has no source is not rendered as zero.** Legacy's language
 *     card counted `$profiles`, which only its language module produced. There is
 *     no Node language module (row 16), so the card says that instead of claiming
 *     an account has none. The paper count is the same class of problem in a
 *     smaller way: legacy counted `paper_accounts.rows` for any signed-in member
 *     with no gate, while `GET /api/v1/paper/accounts` is owner-scoped and needs
 *     `trading.view` — so the card shows the viewer's own accounts and names the
 *     gate it could not read through, rather than a global total it cannot get.
 *  3. **A destination that does not exist is not a link.** Legacy's quick actions
 *     pointed at `/analysis`, `/paper` and `/app/languages/teacher`. Only the
 *     first has a screen in this edition; the other two carry the reason they do
 *     not (F-29 for the paper console, row 16 for language learning) instead of a
 *     link that 404s or a quiet omission.
 */

import { biasTone } from "./workforce.js";

/** Legacy's three windows: `history(6)`, six feed rows, `inbox(..., 8)`. */
export const DASHBOARD_WINDOWS = Object.freeze({ runs: 6, alerts: 6, inbox: 8 });

/**
 * The page's own sentences, verbatim where legacy wrote them. They live here rather
 * than in the JSX so a test can assert the port kept them, and so the two absences
 * the page has to explain are one edit away from their reasons.
 */
export const DASHBOARD_COPY = Object.freeze({
  eyebrow: "WINDELS AI WORKFORCE",
  lede: "Here is the current state of your workspace. Pick a main action below, or continue from a recent activity.",
  summaryTitle: "Workspace summary",
  panelsTitle: "Recent activity & alerts",
  activityTitle: "Recent activity",
  activityEmpty: "No analysis runs stored yet.",
  activityEmptyAction: Object.freeze({ text: "Run your first analysis", to: "/app/analysis" }),
  alertsTitle: "Notifications",
  alertsEmpty: "Nothing in your inbox yet.",
});

/**
 * The two panel feet, in legacy's own words. Until Phase 41 the first one could not use
 * them: `View analytics →` pointed at `/journal`, and there was no journal screen, so the
 * foot said where analytics actually live instead of pretending the destination existed.
 * The journal console landed in Phase 41, so the foot is legacy's again — the last stale
 * "not ported" sentence in the shell's copy, retired with the screen it described.
 */
export const PANEL_FEET = Object.freeze({
  activity: Object.freeze({ text: "View analytics", to: "/app/journal", note: null }),
  alerts: Object.freeze({ text: "Open all alerts", to: "/app/notifications", note: null }),
});

/** The permission the two governance reads need: `GET /trading/mode`, `GET /paper/accounts`. */
export const TRADING_READ_PERMISSION = "trading.view";

/**
 * The two reads the dashboard performs that any signed-in account can ask for:
 * the run history is session-only, and the inbox sits behind
 * `system.authenticated`, which `userHasPermission` answers for every signed-in
 * user regardless of role.
 */
export const OPEN_READS = Object.freeze([
  Object.freeze({ key: "runs", path: "/api/v1/analysis/history", query: `limit=${DASHBOARD_WINDOWS.runs}`, permission: null }),
  Object.freeze({ key: "inbox", path: "/api/v1/notifications", query: `limit=${DASHBOARD_WINDOWS.inbox}`, permission: "system.authenticated" }),
]);

/** The two the router refuses without the permission above. */
export const GATED_READS = Object.freeze([
  Object.freeze({ key: "state", path: "/api/v1/trading/mode", permission: TRADING_READ_PERMISSION }),
  Object.freeze({ key: "accounts", path: "/api/v1/paper/accounts", permission: TRADING_READ_PERMISSION }),
]);

/** What the language card says instead of a count no module can answer (row 16). */
export const LANGUAGE_NOTE = "Language learning is not ported in this edition (row 16), so there is no profile count to show.";

/**
 * What the paper destinations say now that the console exists (Phase 37). Until that phase
 * this note said the API was ported and the screen was not (F-29, which was true when it
 * was written); a note that keeps saying it after `/app/paper` ships sends a reader to
 * re-port a screen they can already open.
 */
export const PAPER_NOTE = "Every order passes the kill switch, trading mode and Risk Engine; `POST /api/v1/paper/…` never leaves the process. The console at `/app/paper` reads `GET /api/v1/paper/accounts`.";

/** `Welcome`'s greeting: the first word of the display name, `Member` when unset. */
export function firstWord(name, fallback = "Member") {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0];
}

/** Legacy's pluralisation: `N paper account` + `s` unless N is 1. */
export function countLabel(count, singular, plural = `${singular}s`) {
  const value = Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * The hero's status pills, in legacy's order: the trading state (the kill switch
 * replaces the mode while it is engaged, exactly as the page did), the paper
 * account count, and the language profile count that becomes a statement.
 *
 * `state` is the `GET /trading/mode` payload and `accounts` the
 * `GET /paper/accounts` payload; both are null when the viewer lacks
 * `trading.view` or the read failed, and a refused read is named as such.
 */
export function dashboardPills({ permissions = [], state = null, accounts = null } = {}) {
  const canRead = permissions.includes(TRADING_READ_PERMISSION);
  const pills = [];

  if (!canRead) {
    pills.push({ key: "state", tone: "badge-muted", text: "Trading state needs trading.view" });
  } else if (state?.killSwitch?.active === true) {
    pills.push({ key: "state", tone: "badge-amber", text: "Kill switch active" });
  } else if (state?.tradingMode) {
    pills.push({ key: "state", tone: "badge-gray", text: `Mode ${state.tradingMode}` });
  } else {
    pills.push({ key: "state", tone: "badge-muted", text: "Trading state unread" });
  }

  const accountCount = Array.isArray(accounts?.accounts) ? accounts.accounts.length : null;
  if (!canRead) {
    // One pill carries the permission, not two: both governance reads sit behind it.
    pills.push({ key: "accounts", tone: "badge-muted", text: "Paper accounts need trading.view" });
  } else if (accountCount === null) {
    pills.push({ key: "accounts", tone: "badge-muted", text: "Paper accounts unread" });
  } else {
    pills.push({ key: "accounts", tone: "badge-gray", text: countLabel(accountCount, "paper account") });
  }

  // No module, no count: legacy printed `N language profile(s)` from its own
  // language service, which this edition does not have (row 16).
  pills.push({ key: "languages", tone: "badge-muted", text: "Language learning not ported" });
  return pills;
}

/**
 * Legacy's three quick actions in its order. `to` is null where this edition has
 * no screen to open, and `note` is the reason — never a silent omission.
 */
export function quickActions() {
  return [
    { key: "analysis", label: "Run AI analysis", to: "/app/analysis", note: "Legacy's `/analysis` page." },
    { key: "paper", label: "Paper trading", to: "/app/paper", note: PAPER_NOTE },
    { key: "languages", label: "Learn a language", to: null, note: LANGUAGE_NOTE },
  ];
}

/**
 * Legacy's four KPI cards: AI workforce runs, language profiles, paper accounts,
 * unread alerts. Each card carries a value plus the caveat its number needs.
 */
export function kpiCards({ permissions = [], runs = null, unread = null, accounts = null } = {}) {
  const canRead = permissions.includes(TRADING_READ_PERMISSION);
  const runCount = Array.isArray(runs?.runs) ? runs.runs.length : null;
  const accountCount = Array.isArray(accounts?.accounts) ? accounts.accounts.length : null;
  // `null` is "not read", which is not the same as zero: `Number(null)` is 0 and
  // finite, so a null would otherwise become a confident "0 unread alerts".
  const unreadCount = unread === null || unread === undefined || unread === ""
    ? null
    : (Number.isFinite(Number(unread)) ? Math.trunc(Number(unread)) : null);

  return [
    {
      key: "runs",
      label: "AI workforce runs",
      value: runCount === null ? "—" : String(runCount),
      trend: "Recent analyses stored",
      note: runCount === null
        ? "The run history could not be read."
        : `The ${DASHBOARD_WINDOWS.runs} most recent stored runs, as the legacy page counted them — not a lifetime total.`,
      to: "/app/analysis",
    },
    {
      key: "languages",
      label: "Language profiles",
      value: "—",
      trend: "Not in this edition",
      note: LANGUAGE_NOTE,
      to: null,
    },
    {
      key: "accounts",
      label: "Paper accounts",
      value: accountCount === null ? "—" : String(accountCount),
      trend: "Your simulation accounts",
      note: !canRead
        ? "Reading paper accounts needs trading.view."
        : accountCount === null
          ? "The account list could not be read."
          : "Counted from GET /api/v1/paper/accounts, which is owner-scoped — legacy counted every row in the table. The console at /app/paper opens the accounts this counts.",
      to: "/app/paper",
    },
    {
      key: "alerts",
      label: "Unread alerts",
      value: unreadCount === null ? "—" : String(unreadCount),
      trend: "Awaiting your review",
      note: unreadCount === null
        ? "The inbox could not be read."
        : "The server's own unread count, which is not narrowed by the feed's page size.",
      to: "/app/notifications",
    },
  ];
}

/** The recent-activity table: Symbol, Timeframe, Bias, Completed (legacy's four columns). */
export function activityRows(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    id: run?.id ?? "",
    symbol: run?.symbol ?? "",
    timeframe: run?.timeframe ?? "",
    bias: String(run?.bias ?? "—"),
    tone: biasTone(run?.bias),
    completed: String(run?.completedAt ?? "").slice(0, 16).replace("T", " "),
    synthetic: run?.synthetic === true,
  }));
}

/** Severity → the badge language the inbox already uses. */
export function severityTone(severity) {
  const value = String(severity ?? "").toLowerCase();
  if (value === "critical") return "badge-red";
  if (value === "warning") return "badge-amber";
  return "badge-gray";
}

/**
 * The notification feed: legacy printed `$n['title'] ?? $n['type'] ?? 'Notice'`
 * and the first sixteen characters of the timestamp, six rows deep.
 *
 * That is PHP's null-coalescing, kept here as `??` and not widened to "falsy": an
 * empty title passes through empty, exactly as it did there. In practice the
 * notifier refuses a blank title (`INVALID_NOTIFICATION_TITLE`), so the fallback
 * only ever answers for a row written outside the service — which is the legacy
 * data this shape has to survive.
 */
export function alertRows(payload, limit = DASHBOARD_WINDOWS.alerts) {
  const rows = Array.isArray(payload?.notifications) ? payload.notifications : [];
  const bounded = Math.max(0, Math.trunc(Number(limit) || 0));
  return rows.slice(0, bounded).map((row) => ({
    id: row?.id ?? "",
    title: String(row?.title ?? row?.type ?? "Notice"),
    type: String(row?.type ?? ""),
    severity: String(row?.severity ?? "info"),
    tone: severityTone(row?.severity),
    time: String(row?.createdAt ?? "").slice(0, 16).replace("T", " "),
    unread: row?.unread === true,
  }));
}
