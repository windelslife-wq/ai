/**
 * The Sports Intelligence console (row 3's last entry, Phase 36).
 *
 * Legacy has two screens over one module: `Sports::index` → `views/sports/index.php`
 * ("Sports Intelligence — daily ticket engine") and `Sports::tickets` →
 * `views/sports/tickets.php` ("Sports tickets"). The port puts both on one screen at
 * `/app/sports`, because they read the same five surfaces and differ only in which
 * aggregates they lead with — the dashboard leads with today's intelligence, the
 * tickets screen with the stored ticket table, and both carry the performance panel.
 * Every section below names which of the two legacy pages it comes from.
 *
 * Two rules from every console in this shell apply unchanged:
 *
 *  1. **No number is printed that the server did not send.** The performance panel's
 *     metrics are `null` until a settlement exists, and legacy's own sentence for that
 *     state ("metrics are intentionally unavailable rather than invented") is what this
 *     screen says. The language-learning card elsewhere in the shell renders an em dash
 *     for the same reason.
 *  2. **Nothing is offered that the API would refuse.** The three actions legacy's
 *     console has — approve, reject, settle — are rendered only when the session holds
 *     `sports.approve` / `sports.settle`, and each one is a call to the route that
 *     re-checks it. Approval additionally carries the platform kill switch, which is
 *     why the screen reads and states that state rather than discovering it from a 409.
 *
 * The module is `partial`, and the screen says so with the server's own matrix
 * (`GET /sports/status` → `notPorted`) rather than a client-side paraphrase: stake
 * sizing and the vendor verification are what no slice owns. The two console screens
 * left that matrix in this phase — a list called "not ported" must not contain an
 * entry that says otherwise.
 *
 * Every function here is pure: the view in `views.jsx` binds them to reads, and
 * `test/client_sports_console.test.js` holds them to the legacy text and to the API.
 */

/** Legacy: `Sports::index`/`Sports::tickets` read pages; the module's own read gate. */
export const SPORTS_PERMISSION = "sports.view";
/** Legacy: `Api_sports` writes and the console's ingestion actions. */
export const SPORTS_MANAGE = "sports.manage";
/** Legacy: `Api_sports::decide_ticket` and `Sports::decide` — the human decision. */
export const SPORTS_APPROVE = "sports.approve";
/** Legacy: `Api_sports::verify_result` / `settle` and `Sports::settle`. */
export const SPORTS_SETTLE = "sports.settle";
/** The permission the kill-switch state is read under (`GET /trading/mode`). */
export const TRADING_READ_PERMISSION = "trading.view";
/** `system.super_admin` short-circuits every permission check server-side. */
export const SUPER_ADMIN_PERMISSION = "system.super_admin";

/**
 * Whether the session holds a permission, mirroring the server's rule: `system.super_admin`
 * passes every check (`identity/service.js` → `userHasPermission`, exactly as
 * `Identity::can()` did). A panel that ignored the shortcut would withhold a read the API
 * answers — the same class of error as showing one it refuses.
 */
export function holdsSportsPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(SUPER_ADMIN_PERMISSION);
}

/**
 * The two pages' own words, transcribed. `index.php`'s heading and lede, `tickets.php`'s
 * heading and lede, the two banners, the execution note and the panel titles.
 */
export const SPORTS_COPY = Object.freeze({
  eyebrow: "Sports intelligence",
  title: "Sports Intelligence — daily ticket engine",
  lede: "Daily ticket research from stored fixtures, odds and settled results. With no provider the module stays DISABLED_NO_PROVIDER and fabricates nothing.",
  ticketsTitle: "Sports tickets",
  ticketsLede: "Generated tickets, approval state and stored settlements. Approve, reject and settle stay permission-gated. This deployment has no external bookmaker.",
  todayTitle: (date) => `Today's intelligence — ${date}`,
  performanceTitle: "30-day performance (stored settlements only)",
  ticketsPerformanceTitle: "Performance (all stored settlements)",
  modelsTitle: "Models & calibration",
  systemTitle: "System",
  todayTicketTitle: "Today's ticket",
  ticketsTableTitle: "Tickets",
  runsTitle: "Daily ticket runs",
  boundaryTitle: "Not ported",
  ticketsLink: "Ticket console & history →",
  demoBanner: "SANDBOX / DEMO DATA — sports figures are simulated, not real-world performance.",
  noProviderBanner: "DISABLED_NO_PROVIDER — no sports data provider is configured. No fixtures, odds, predictions or tickets are fabricated; configure a provider (environment-only credentials) to enable the pipeline.",
  executionNote: "Approval is recorded with the acting identity. There is no external execution connector — approval never places a bet.",
  decisionNotice: (approved) => `Ticket ${approved ? "approved" : "rejected"} and audited — no external execution exists in this deployment.`,
  settlementNotice: (settlement) => `Ticket settlement: ${settlement?.status ?? "PENDING"} (effective odds ${settlement?.effectiveOdds ?? "n/a"}, P/L ${settlement?.pnl ?? "n/a"})`,
  approveLabel: "Approve (sports.approve)",
  rejectLabel: "Reject",
  settleLabel: "Settle from verified results (sports.settle)",
  settleRowLabel: "settle",
  approveRowLabel: "approve",
  rejectRowLabel: "reject",
  rejectConfirm: "Reject this ticket?",
});

/**
 * The kill-switch refusal, verbatim from `Api_sports::decide_ticket` (409) and
 * `Sports::decide`'s flash. The string is duplicated here rather than imported because
 * the client bundle cannot import a server module; `test/client_sports_console.test.js`
 * asserts it is the string `src/modules/sports/routes.js` throws, so the two cannot
 * drift apart silently.
 */
export const KILL_SWITCH_MESSAGE = "kill switch is ACTIVE — approving new tickets is blocked until it is released (settlement remains available)";

/** The screen's own lead-in for the same refusal, in the console's voice. */
export const KILL_SWITCH_NOTICE = "Refused: platform kill switch is ACTIVE — release it before approving sports tickets (settlement remains available).";

/**
 * `Sports::decide` reads the state server-side; this screen reads `GET /trading/mode`
 * under `trading.view`, which a `sports_viewer` role does not carry. When it cannot be
 * read the screen says which gate stood there instead of guessing the switch is off.
 */
export function killSwitchStateText(state, permissions = []) {
  if (!holdsSportsPermission(permissions, TRADING_READ_PERMISSION)) return `requires ${TRADING_READ_PERMISSION}`;
  if (!state || typeof state !== "object") return "not read";
  return state.killSwitch?.active === true ? "ACTIVE" : "released";
}

/**
 * The banner to show when approval is blocked, or `null` when nothing is known to block
 * it. An unread state is deliberately not a banner: a warning the screen cannot support
 * is a claim, and the API refuses the approval regardless of what the browser believed.
 */
export function killSwitchNotice(state, permissions = []) {
  if (!holdsSportsPermission(permissions, TRADING_READ_PERMISSION)) return null;
  if (state?.killSwitch?.active !== true) return null;
  // Both sentences, because they are different sentences: the console's flash is what a
  // reader needs, and the API's is what the next click will actually be answered with.
  return { tone: "warn", text: KILL_SWITCH_NOTICE, api: KILL_SWITCH_MESSAGE };
}

/** Legacy's empty states, kept as written rather than paraphrased. */
export const SPORTS_EMPTY = Object.freeze({
  fixtures: "No scheduled fixtures stored for today.",
  performance: "No settled tickets or selections yet — metrics are intentionally unavailable rather than invented.",
  models: "No model versions recorded yet.",
  providers: "No providers registered.",
  noRun: "No daily run recorded for today yet.",
  noTickets: "No tickets generated yet.",
  noRuns: "No daily runs recorded yet.",
  noSyncs: "No sync runs recorded.",
});

/**
 * What each read in the console asks for.
 *
 * The bounds are the console's own, and they are the API's bounds rather than larger
 * ones: `limit` is capped at 200 on almost every sports read, so asking for more would
 * be asking for a refusal. Legacy had the same shape — `dashboard()` read 50 fixtures,
 * 500 predictions and 8 sync runs, and printed the counts it had read.
 */
export const SPORTS_WINDOWS = Object.freeze({
  /** `dashboard()` read today's scheduled fixtures with limit 50. */
  scheduledFixtures: 50,
  /** `dashboard()` read all LIVE fixtures with limit 50. */
  liveFixtures: 50,
  /** `dashboard()` read today's predictions with limit 500; the API's own cap is 200. */
  predictions: 200,
  /** The upcoming table shows the first 25 fixtures; quality is assessed per row shown. */
  listedFixtures: 25,
  /** `tickets.php` read `listTickets([], 100)`. */
  tickets: 100,
  /** `tickets.php` read `listDailyTickets(30)`. */
  dailyRuns: 30,
  /** `dashboard()` sliced the stored job runs to 8. */
  syncRuns: 8,
  /** Legacy's own window for the dashboard's performance panel: today and the 29 before. */
  performanceDays: 30,
});

/**
 * Every read the console makes, with the permission the server enforces on it. The paths
 * are the registered route paths (`/api/v1/system/routes`), so a read that was never
 * declared fails the suite by name rather than at runtime.
 */
export const SPORTS_READS = Object.freeze([
  { key: "status", method: "GET", path: "/api/v1/sports/status", permission: SPORTS_PERMISSION, section: "System" },
  { key: "scheduled", method: "GET", path: "/api/v1/sports/matches", permission: SPORTS_PERMISSION, section: "Today's intelligence" },
  { key: "live", method: "GET", path: "/api/v1/sports/matches", permission: SPORTS_PERMISSION, section: "Today's intelligence" },
  { key: "intelligence", method: "GET", path: "/api/v1/sports/matches/:matchId/intelligence", permission: SPORTS_PERMISSION, section: "Today's intelligence" },
  { key: "predictions", method: "GET", path: "/api/v1/sports/predictions", permission: SPORTS_PERMISSION, section: "Today's intelligence" },
  { key: "performance", method: "GET", path: "/api/v1/sports/performance", permission: SPORTS_PERMISSION, section: "Performance" },
  { key: "models", method: "GET", path: "/api/v1/sports/models", permission: SPORTS_PERMISSION, section: "Models & calibration" },
  { key: "calibrations", method: "GET", path: "/api/v1/sports/calibrations", permission: SPORTS_PERMISSION, section: "Models & calibration" },
  { key: "dailyRuns", method: "GET", path: "/api/v1/sports/daily-tickets", permission: SPORTS_PERMISSION, section: "Daily ticket runs" },
  { key: "tickets", method: "GET", path: "/api/v1/sports/tickets", permission: SPORTS_PERMISSION, section: "Tickets" },
  { key: "ticket", method: "GET", path: "/api/v1/sports/tickets/:ticketId", permission: SPORTS_PERMISSION, section: "Today's ticket" },
  { key: "syncRuns", method: "GET", path: "/api/v1/sports/sync-runs", permission: SPORTS_PERMISSION, section: "System" },
  // The two reads the module gates behind `sports.manage`, not `sports.view`: the active
  // configuration and its version history. The screen asks for neither unless the session
  // carries that permission, and the System panel says so when it does not.
  { key: "configuration", method: "GET", path: "/api/v1/sports/configuration", permission: SPORTS_MANAGE, section: "System" },
]);

/** The two actions legacy's tickets screen carries, plus the state read they need. */
export const SPORTS_WRITES = Object.freeze([
  {
    key: "decision",
    method: "POST",
    path: "/api/v1/sports/tickets/:ticketId/decision",
    permission: SPORTS_APPROVE,
    label: "Approve / Reject",
    legacy: "Sports::decide → sports->governance->decide()",
    guard: "the platform kill switch must be released",
  },
  {
    key: "settle",
    method: "POST",
    path: "/api/v1/sports/tickets/:ticketId/settle",
    permission: SPORTS_SETTLE,
    label: "Settle",
    legacy: "Sports::settle → sports->settlement->settlePending()",
    guard: null,
  },
  // The state read behind the approval guard and the System panel's mode card. It is a
  // read, and it lives here because it is the *other* permission the action depends on.
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: TRADING_READ_PERMISSION, label: "Trading state", legacy: "Platform::state()", guard: null },
]);

/**
 * What the module still does not have, in the console's terms — the sentences the
 * boundary panel adds to the server's own `notPorted` matrix.
 */
export const SPORTS_RESIDUAL = Object.freeze([
  "No stake is sized from bankroll or edge: the configured fixed stake is recorded on each ticket, as legacy records it, and settlement's P/L is computed on that number.",
  "No provider has been verified against a real vendor; the sandbox is the only provider the tests exercise, and sandbox fixtures never reach a ticket.",
  "Nothing is executed. There is no external bookmaker connector, no order path and no live route; a ticket is a record a person approves.",
]);

/* ------------------------------------------------------------------ formatting */

const EM_DASH = "—";

export function emDash() {
  return EM_DASH;
}

function finite(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

/** Legacy's `number_format($v, $digits)`, with `—` where the value is not a number. */
export function numberText(value, digits = 2) {
  const number = finite(value);
  if (number === null) return EM_DASH;
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A count: an integer, and never a decimal point. */
export function countText(value) {
  const number = finite(value);
  return number === null ? EM_DASH : number.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** A share as a percentage. `digits` follows legacy's `number_format($v * 100, $n)`. */
export function percentText(value, digits = 1) {
  const number = finite(value);
  return number === null ? EM_DASH : `${numberText(number * 100, digits)}%`;
}

/** Legacy's `number_format($v, 0) . '%'` — the confidence cells. */
export function confidenceText(value) {
  const number = finite(value);
  return number === null ? EM_DASH : `${numberText(number, 0)}%`;
}

/** Legacy's `substr($iso, 0, 16)` — the mono cells that print a UTC instant. */
export function instantText(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return text ? text.slice(0, 16) : EM_DASH;
}

/** Legacy's `mb_substr($message, 0, 120)` in the daily-run table. */
export function shortText(value, length = 120) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length > length ? text.slice(0, length) : text;
}

/** Legacy's `($x ?? null) !== null` test, kept so the view cannot print a null as a zero. */
export function present(value) {
  return value !== null && value !== undefined && value !== "";
}

/* ------------------------------------------------------------------------ dates */

/** The UTC day legacy's `gmdate('Y-m-d')` produces, from a `Date`. */
export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dayToDate(day) {
  const parsed = new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Legacy's `$today . ' -29 days'`, as a UTC day. */
export function daysBefore(day, days) {
  const parsed = dayToDate(day);
  if (parsed === null) return null;
  parsed.setUTCDate(parsed.getUTCDate() - Number(days));
  return utcDay(parsed);
}

/**
 * The window legacy reads today's fixtures with: `T00:00:00+00:00` to `T23:59:59+00:00`.
 * The port's end bound is the same second at millisecond precision, because the
 * repository canonicalizes every bound to milliseconds before comparing text.
 */
export function dayWindow(day) {
  return { day, from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
}

/** `dashboard()`'s performance window: today and the 29 days before it. */
export function performanceWindow(day) {
  return { day, from: `${daysBefore(day, SPORTS_WINDOWS.performanceDays - 1)}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
}

/* ----------------------------------------------------------------- today's board */

/**
 * `dashboard()`'s `todayIntelligence`, composed from the reads this port has.
 *
 * Legacy read it server-side in one call; here it is three — today's scheduled fixtures,
 * every LIVE fixture, and the stored predictions — and the screen names those sources
 * rather than presenting the aggregate as one.
 *
 * Two things legacy's version did that this one must say out loud instead of reproducing
 * silently:
 *
 *  - **`live` was not a today's-window read.** `listMatches(['status' => 'LIVE'], 50)`
 *    has no date bound, so a LIVE fixture from last month counts in the Live card. The
 *    port keeps the same read (the API has no window for a status-only filter here) and
 *    labels the card "Live (all stored live fixtures)".
 *  - **The prediction counts are of the page that was read.** Legacy's read filtered
 *    `created_at` between the day's bounds server-side; this port's `GET /sports/predictions`
 *    has no instant filter, so the newest `limit` rows are read and attributed to a day
 *    here. When that page is full the counts are a floor, and `predictionsTruncated` says so.
 *
 * @param {{day: string, scheduled?: object|null, live?: object|null, predictions?: object|null}} input
 */
export function todayIntelligence({ day, scheduled = null, live = null, predictions = null } = {}) {
  const upcoming = Array.isArray(scheduled?.matches) ? scheduled.matches : [];
  const liveMatches = Array.isArray(live?.matches) ? live.matches : [];
  const page = Array.isArray(predictions?.predictions) ? predictions.predictions : [];
  const forDay = page.filter((row) => utcDayOf(row?.created_at) === day);
  const undated = page.filter((row) => utcDayOf(row?.created_at) === null).length;

  const qualified = forDay.filter((row) => String(row?.decision ?? "") === "PREDICTION_READY");
  const rejected = forDay.filter((row) => String(row?.decision ?? "") !== "PREDICTION_READY");
  const confidences = forDay.map((row) => finite(row?.confidence)).filter((value) => value !== null);
  const distribution = { LOW: 0, MEDIUM: 0, HIGH: 0, REJECTED: 0 };
  for (const row of forDay) {
    // Legacy's own rule, kept exactly: a row with no risk is counted as REJECTED, and a
    // risk name the page does not know gets its own bucket rather than being folded into
    // one of the four — `riskMeters` renders those extra buckets too, so the bars add up
    // to what was counted instead of to 100% of a subset.
    const risk = String(row?.risk ?? "REJECTED");
    distribution[risk] = (distribution[risk] ?? 0) + 1;
  }

  return Object.freeze({
    date: day,
    upcomingCount: upcoming.length,
    upcoming,
    liveCount: liveMatches.length,
    liveMatches,
    predictionsRead: page.length,
    predictionsForDay: forDay.length,
    predictionsUndated: undated,
    predictionsTruncated: page.length >= SPORTS_WINDOWS.predictions,
    qualifiedPredictions: qualified.length,
    rejectedPredictions: rejected.length,
    // Legacy: `round(sum / count, 2)`, over every prediction of the day that carries one.
    averageConfidence: confidences.length
      ? Math.round((confidences.reduce((total, value) => total + value, 0) / confidences.length) * 100) / 100
      : null,
    riskDistribution: distribution,
  });
}

function utcDayOf(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : utcDay(parsed);
}

/**
 * Legacy's four risk meters, plus one bar per risk name the four do not cover.
 *
 * Rendered only when at least one prediction was counted — `array_sum($risk) > 0` was the
 * condition on the page, and four empty bars are a picture of nothing that reads as a
 * picture of zero risk. Legacy's own colours are kept: green, amber, red and muted.
 */
export function riskMeters(distribution = {}) {
  const known = [
    { key: "LOW", fill: "meter-green" },
    { key: "MEDIUM", fill: "meter-amber" },
    { key: "HIGH", fill: "meter-red" },
    { key: "REJECTED", fill: "meter-muted" },
  ];
  const count = (key) => Number(distribution?.[key]) || 0;
  const extra = Object.keys(distribution && typeof distribution === "object" ? distribution : {})
    .filter((key) => !known.some((entry) => entry.key === key) && count(key) > 0)
    .map((key) => ({ key, fill: "meter-sky" }));
  const rows = [...known, ...extra];
  const total = rows.reduce((sum, entry) => sum + count(entry.key), 0);
  if (total <= 0) return [];
  return rows.map((entry) => ({
    key: entry.key,
    label: `Risk ${entry.key}`,
    count: count(entry.key),
    fill: entry.fill,
    percent: Math.round((100 * count(entry.key)) / Math.max(1, total)),
  }));
}

/** The quality object inside an intelligence response, or null when it was not assessed. */
export function qualityFromIntelligence(payload) {
  const quality = payload?.evaluation?.factors?.quality;
  if (!quality || !Number.isFinite(Number(quality.score))) return null;
  return { band: String(quality.band ?? "UNKNOWN"), score: Number(quality.score) };
}

/**
 * The upcoming table. Legacy printed the latest *stored* quality row per fixture, or
 * "not assessed" when there was none; this port has no read for stored quality rows, so
 * the column comes from `GET /sports/matches/:matchId/intelligence`, which re-assesses
 * quality on every call (divergence F-38 — the sync stays the only writer of quality
 * rows). The panel states that, and the assessment is fetched for the rows shown rather
 * than for every fixture the read returned.
 *
 * @param {{matches?: object[], quality?: Record<string, object|null>, assessed?: string[]}} input
 */
export function upcomingRows({ matches = [], quality = {}, assessed = [] } = {}) {
  const assessedSet = new Set(assessed.map((id) => String(id)));
  const rows = matches.map((match) => {
    const id = match?.id;
    const score = quality[String(id)] ?? null;
    return {
      key: String(id),
      kickoff: instantText(match?.kickoff_at),
      match: `${match?.home_team ?? "?"} vs ${match?.away_team ?? "?"}`,
      competition: match?.competition ?? "",
      assessed: assessedSet.has(String(id)),
      quality: score,
      qualityText: score ? `${score.band} · ${Math.trunc(score.score)}` : "not assessed",
    };
  });
  return Object.freeze({
    rows: rows.slice(0, SPORTS_WINDOWS.listedFixtures),
    total: rows.length,
    shown: Math.min(rows.length, SPORTS_WINDOWS.listedFixtures),
    assessed: assessedSet.size,
  });
}

/* -------------------------------------------------------------------- performance */

function toneFor(value, { negative = "down", positive = "up" } = {}) {
  const number = finite(value);
  if (number === null) return "";
  return number >= 0 ? positive : negative;
}

/**
 * The performance panels. Two shapes, because legacy had two: the dashboard's
 * "30-day performance (stored settlements only)" with nine cards including Brier and ECE
 * from the calibration block, and the tickets page's "Performance (all stored
 * settlements)" with eight, including `Avg EV / selection`.
 *
 * Every metric is printed only when the server sent a number. When there is nothing
 * settled, `dataAvailable` is false and the panel shows legacy's own sentence.
 */
export function performanceCards(perf, { kind = "window" } = {}) {
  const available = perf?.dataAvailable === true;
  const cards = kind === "window"
    ? [
      { key: "settledTickets", label: "Settled tickets", value: countText(perf?.settledTickets), tone: "" },
      { key: "winRate", label: "Win rate", value: percentText(perf?.winRate), tone: "" },
      { key: "roi", label: "ROI", value: percentText(perf?.roi), tone: toneFor(perf?.roi) },
      { key: "profitLoss", label: "Profit / loss", value: numberText(perf?.profitLoss, 2), tone: toneFor(perf?.profitLoss) },
      { key: "maxDrawdown", label: "Max drawdown", value: numberText(perf?.maxDrawdown, 2), tone: "" },
      { key: "averageOdds", label: "Avg odds", value: numberText(perf?.averageOdds, 2), tone: "" },
      { key: "modelAccuracy", label: "Model accuracy", value: percentText(perf?.modelAccuracy), tone: "" },
      { key: "brier", label: "Brier", value: numberText(perf?.calibration?.brier, 3), tone: "" },
      { key: "ece", label: "ECE", value: numberText(perf?.calibration?.ece, 3), tone: "" },
    ]
    : [
      { key: "totalTickets", label: "Tickets", value: countText(perf?.totalTickets), tone: "" },
      { key: "settledTickets", label: "Settled", value: countText(perf?.settledTickets), tone: "" },
      { key: "wonLost", label: "Won / lost", value: `${countText(perf?.won)} / ${countText(perf?.lost)}`, tone: "" },
      { key: "winRate", label: "Win rate", value: percentText(perf?.winRate), tone: "" },
      { key: "roi", label: "ROI", value: percentText(perf?.roi), tone: toneFor(perf?.roi) },
      { key: "profitLoss", label: "Profit / loss", value: numberText(perf?.profitLoss, 2), tone: toneFor(perf?.profitLoss) },
      { key: "modelAccuracy", label: "Model accuracy", value: percentText(perf?.modelAccuracy), tone: "" },
      { key: "expectedValue", label: "Avg EV / selection", value: numberText(perf?.expectedValue, 3), tone: "" },
    ];
  return Object.freeze({
    cards,
    dataAvailable: available,
    demoBanner: typeof perf?.demoBanner === "string" ? perf.demoBanner : "",
    emptyNote: available ? "" : SPORTS_EMPTY.performance,
    sources: [SPORTS_READS.find((read) => read.key === "performance").path],
  });
}

/* ------------------------------------------------------------------ the ticket view */

/**
 * `dashboard()`'s `ticketEngine` block: the day's run, the ticket it produced and the
 * legs. `engineLabel` is legacy's `configuration.engine_mode` badge; the configuration
 * read is `sports.manage`, so without that permission the badge says which permission it
 * needs rather than showing a mode the screen did not read.
 */
export function ticketView({ run = null, ticket = null, selections = [], matches = [], engineMode = null, canReadConfiguration = false } = {}) {
  const names = new Map();
  for (const match of matches) {
    if (match?.id === undefined || match?.id === null) continue;
    names.set(String(match.id), `${match.home_team ?? "?"} vs ${match.away_team ?? "?"}`);
  }
  const legs = (Array.isArray(selections) ? selections : []).map((selection) => ({
    key: String(selection?.id ?? `${selection?.prediction_id}-${selection?.selection}`),
    matchLabel: names.get(String(selection?.match_id)) ?? "",
    selection: selection?.selection ?? "?",
    market: selection?.market ?? "",
    odds: numberText(selection?.odds, 2),
    calibratedProbability: numberText(selection?.calibrated_probability, 3),
    expectedValue: numberText(selection?.expected_value, 3),
    expectedValueTone: toneFor(selection?.expected_value),
    status: selection?.status ?? "PENDING",
  }));

  return Object.freeze({
    run,
    ticket,
    legs,
    status: run?.status ?? null,
    message: run?.message ?? "",
    noRun: run === null ? SPORTS_EMPTY.noRun : (ticket === null ? SPORTS_EMPTY.noTickets : ""),
    engineLabel: canReadConfiguration
      ? (engineMode ?? "not read")
      : `requires ${SPORTS_MANAGE}`,
    cards: [
      { key: "totalOdds", label: "Total odds", value: numberText(ticket?.total_odds, 2), tone: "" },
      { key: "selectionCount", label: "Selections", value: countText(ticket?.selection_count), tone: "" },
      { key: "confidence", label: "Confidence", value: confidenceText(ticket?.confidence), tone: "" },
      { key: "stake", label: "Stake", value: numberText(ticket?.stake, 2), tone: "" },
    ],
    pendingApproval: String(ticket?.approval_status ?? "") === "PENDING_USER_APPROVAL",
    pendingSettlement: String(ticket?.settlement_status ?? "") === "PENDING",
    externalExecution: false,
  });
}

/** Legacy's approval badge is `b-gray` on every row; the port's tone keeps that. */
export function approvalTone(status) {
  const value = String(status ?? "");
  if (value === "APPROVED_NOT_EXECUTED") return "badge-green";
  if (value === "REJECTED") return "badge-red";
  return "badge-gray";
}

/** Legacy: WON green, LOST red, anything else gray. */
export function settlementTone(status) {
  const value = String(status ?? "");
  if (value === "WON") return "badge-green";
  if (value === "LOST") return "badge-red";
  return "badge-gray";
}

/** Legacy: LOW green, HIGH red, everything else violet. */
export function riskTone(risk) {
  const value = String(risk ?? "");
  if (value === "LOW") return "badge-green";
  if (value === "HIGH") return "badge-red";
  return "badge-violet";
}

/** Legacy: PENDING_USER_APPROVAL and APPROVED violet, anything else gray. */
export function runStatusTone(status) {
  return ["PENDING_USER_APPROVAL", "APPROVED"].includes(String(status ?? "")) ? "badge-violet" : "badge-gray";
}

/** The tickets table, formatted; the view decides which controls the session may see. */
export function ticketRows(tickets = []) {
  return (Array.isArray(tickets) ? tickets : []).map((ticket) => ({
    id: ticket?.id ?? "",
    createdAt: instantText(ticket?.created_at),
    odds: numberText(ticket?.total_odds, 2),
    selectionCount: countText(ticket?.selection_count),
    confidence: present(ticket?.confidence) ? numberText(ticket.confidence, 0) : EM_DASH,
    risk: ticket?.risk ?? EM_DASH,
    riskTone: riskTone(ticket?.risk),
    approvalStatus: ticket?.approval_status ?? EM_DASH,
    approvalTone: approvalTone(ticket?.approval_status),
    settlementStatus: ticket?.settlement_status ?? "PENDING",
    settlementTone: settlementTone(ticket?.settlement_status),
    pnl: present(ticket?.pnl) ? numberText(ticket.pnl, 2) : EM_DASH,
    pnlTone: toneFor(ticket?.pnl),
    decidable: String(ticket?.approval_status ?? "") === "PENDING_USER_APPROVAL",
    settleable: String(ticket?.settlement_status ?? "") === "PENDING",
  }));
}

/** The daily-runs table. `date` is the run's `run_date`, which is the UTC day of the run. */
export function dailyRunRows(runs = []) {
  return (Array.isArray(runs) ? runs : []).map((run) => ({
    key: String(run?.id ?? run?.run_date ?? ""),
    date: run?.run_date ?? EM_DASH,
    status: run?.status ?? EM_DASH,
    statusTone: runStatusTone(run?.status),
    ticketId: run?.ticket_id || EM_DASH,
    evaluated: countText(run?.candidates_evaluated),
    recorded: countText(run?.predictions_recorded),
    rejections: countText(run?.rejections),
    message: shortText(run?.message),
  }));
}

/** The System panel's sync table: job, start instant and status, as the page printed them. */
export function syncRunRows(runs = []) {
  return (Array.isArray(runs) ? runs : []).map((run) => ({
    key: String(run?.id ?? run?.execution_key ?? ""),
    jobType: run?.job_type ?? run?.jobType ?? "?",
    startedAt: instantText(run?.started_at ?? run?.created_at),
    status: run?.status ?? "RUNNING",
    executionKey: String(run?.execution_key ?? ""),
  }));
}

/**
 * The provider health table. `derivedStatus` is the monitor's own answer and `UNKNOWN` is
 * what it says when it has witnessed nothing — the port never upgrades an UNKNOWN to a
 * green dot, which is the same rule legacy's page had (its dot class fell through to
 * "down") and the one the status route's docblock makes explicit.
 */
export function providerRows(providers = []) {
  return (Array.isArray(providers) ? providers : []).map((provider) => ({
    key: String(provider?.id ?? provider?.provider_code ?? provider?.display_name ?? "?"),
    code: provider?.provider_code ?? provider?.id ?? provider?.display_name ?? "?",
    status: String(provider?.derivedStatus ?? "UNKNOWN"),
    reliability: present(provider?.reliability) ? numberText(provider.reliability, 2) : EM_DASH,
    detail: provider?.detail ?? "",
    simulated: provider?.simulated === true,
    enabled: provider?.enabled === true,
  }));
}

/**
 * Legacy's health dot: `up` for ONLINE, `synth` for DEGRADED, `down` for everything else
 * — including UNKNOWN, which is what the monitor answers when it has witnessed nothing.
 * Expressed in the shell's badge vocabulary rather than as three dot classes.
 */
export function providerTone(derivedStatus) {
  const value = String(derivedStatus ?? "UNKNOWN");
  if (value === "ONLINE") return "badge-live";
  if (value === "DEGRADED") return "badge-amber";
  return "badge-muted";
}

/** `dashboard()`'s models block: the versions it listed, and the approved calibrations. */
export function modelPanel({ models = null, calibrations = null } = {}) {
  const versions = Array.isArray(models?.models) ? models.models : [];
  const approved = (Array.isArray(calibrations?.calibrations) ? calibrations.calibrations : [])
    .filter((row) => String(row?.status ?? "") === "APPROVED");
  return Object.freeze({
    rows: versions.map((version) => ({
      key: String(version?.id ?? `${version?.model_name}-${version?.model_version}`),
      model: version?.model_name ?? "",
      version: version?.model_version ?? "",
      features: version?.feature_version ?? "",
      calibration: version?.calibration_version || EM_DASH,
      status: version?.status ?? "",
    })),
    versions: versions.length,
    approvedCalibrations: approved.length,
    note: `${approved.length} approved calibration version${approved.length === 1 ? "" : "s"}. A calibration is only usable after administrator approval — until then ticket-grade decisions report MODEL_NOT_CALIBRATED.`,
  });
}

/**
 * The boundary panel: the server's `notPorted` matrix, the console's own residual
 * sentences, and the two console screens that left the matrix in this phase.
 */
export function boundaryPanel(notPorted = []) {
  return Object.freeze({
    rows: (Array.isArray(notPorted) ? notPorted : []).map((entry) => ({
      key: entry?.area ?? "",
      area: entry?.area ?? "",
      legacy: entry?.legacy ?? "",
      state: entry?.state ?? "not ported",
      detail: entry?.detail ?? "",
    })),
    residual: SPORTS_RESIDUAL,
  });
}
