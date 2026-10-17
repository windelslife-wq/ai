/**
 * The workspace dashboard against the API it reads (row 3, Phase 33).
 *
 * The fifth client contract suite, and the first for a screen that is not a module
 * console: `/app` is the port of legacy's `/dashboard` — the page sign-in lands on —
 * so its subject is not one module's vocabulary but the shell's own honesty rules.
 * Two of its four reads are permissioned, one of its five numbers has no module to
 * come from, and two of its three quick actions have no screen to open here. Each is
 * asserted as what it is, because this page's failure mode is not a wrong number: it
 * is a confident zero and a link that goes nowhere.
 *
 * Hermetic like the console suites (`MARKET_DATA_REAL_PROVIDERS=0`), so the run the
 * activity table renders is synthetic and says so.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DASHBOARD_COPY, DASHBOARD_WINDOWS, GATED_READS, LANGUAGE_NOTE, OPEN_READS, PANEL_FEET,
  PAPER_NOTE, TRADING_READ_PERMISSION, activityRows, alertRows, countLabel,
  dashboardPills, firstWord, kpiCards, quickActions, severityTone,
} from "../client/src/dashboard.js";
import { biasTone } from "../client/src/workforce.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");

const ANALYSIS_ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  RATE_LIMIT_ANALYSIS_RUN_MAX: "10000",
  ANALYSIS_MAX_CONCURRENT_RUNS: "0",
};

async function dashboardInstance(t) {
  const instance = await createFileStoreApp({ configOverrides: { env: ANALYSIS_ENV } });
  t.after(() => instance.cleanup());
  return instance;
}

async function signIn(instance, identifier, password) {
  const response = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return {
    headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken },
    permissions: body.permissions,
  };
}

/**
 * A signed-in member with the `platform_member` role and nothing granted to it. The
 * test seed grants this role no permissions at all, and `system.authenticated` is
 * answered for every signed-in user, so this is exactly the viewer the dashboard has
 * to be honest for: everything except the two governance reads.
 */
async function addUnprivilegedMember(instance) {
  const role = (await instance.store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const user = await instance.store.createUser({
    username: "member",
    email: "member@example.test",
    passwordHash: await hashPassword("Correct horse battery staple", { minLength: 14 }),
    displayName: "Plain Member",
  });
  await instance.store.assignRole(user.id, role.id);
  return signIn(instance, "member", "Correct horse battery staple");
}

const get = (instance, url, headers) => instance.app.inject({ method: "GET", url, headers: headers || instance.headers });
const post = (instance, url, payload, headers) => instance.app.inject({ method: "POST", url, headers: headers || instance.headers, payload });

// ------------------------------------------------------ the page's own vocabulary

test("the dashboard's windows, actions and cards are the ones views/workspace/index.php used", () => {
  // `Workspace::index` read `history(6)`, sliced the eight-row inbox down to six and
  // fetched eight; the port's windows are those three numbers and nothing else.
  assert.deepEqual({ ...DASHBOARD_WINDOWS }, { runs: 6, alerts: 6, inbox: 8 });

  const actions = quickActions();
  assert.deepEqual(actions.map((action) => action.label), ["Run AI analysis", "Paper trading", "Learn a language"]);
  assert.deepEqual(actions.map((action) => action.to), ["/app/analysis", "/app/paper", null], "the analysis and paper actions have screens; the language row does not");

  const cards = kpiCards({ permissions: [], runs: { runs: [] }, unread: 0, accounts: { accounts: [] } });
  assert.deepEqual(cards.map((card) => card.label), ["AI workforce runs", "Language profiles", "Paper accounts", "Unread alerts"]);
  assert.deepEqual(
    cards.map((card) => card.trend),
    ["Recent analyses stored", "Not in this edition", "Your simulation accounts", "Awaiting your review"],
    "legacy's four card captions",
  );

  // The page's own sentences, kept verbatim where legacy wrote them.
  assert.equal(DASHBOARD_COPY.eyebrow, "WINDELS AI WORKFORCE");
  assert.equal(DASHBOARD_COPY.lede, "Here is the current state of your workspace. Pick a main action below, or continue from a recent activity.");
  assert.equal(DASHBOARD_COPY.summaryTitle, "Workspace summary");
  assert.equal(DASHBOARD_COPY.panelsTitle, "Recent activity & alerts");
  assert.equal(DASHBOARD_COPY.activityEmpty, "No analysis runs stored yet.");
  assert.equal(DASHBOARD_COPY.activityEmptyAction.to, "/app/analysis");
  assert.equal(DASHBOARD_COPY.alertsEmpty, "Nothing in your inbox yet.");
  assert.equal(PANEL_FEET.alerts.text, "Open all alerts");
  assert.equal(PANEL_FEET.alerts.to, "/app/notifications");
  assert.equal(PANEL_FEET.activity.to, "/app/analysis");
  assert.match(PANEL_FEET.activity.note, /\/journal/, "the foot says where legacy's link went instead of pretending it exists");

  // The greeting is legacy's rule: the first word of the display name, `Member` when
  // there is no name to take one from.
  assert.equal(firstWord("Root Admin"), "Root");
  assert.equal(firstWord("  Ada  Lovelace "), "Ada");
  assert.equal(firstWord(""), "Member");
  assert.equal(firstWord(null), "Member");
  assert.equal(countLabel(1, "paper account"), "1 paper account");
  assert.equal(countLabel(3, "paper account"), "3 paper accounts");
  assert.equal(countLabel(null, "paper account"), "0 paper accounts");
});

// --------------------------------------------------------------- the honesty rules

test("a number with no source is named, not rendered as zero", () => {
  const gated = dashboardPills({ permissions: [], state: null, accounts: null });
  assert.deepEqual(
    gated.map((pill) => pill.text),
    ["Trading state needs trading.view", "Paper accounts need trading.view", "Language learning not ported"],
    "a viewer who cannot read the governance state is told which gate stood there",
  );
  for (const pill of gated) assert.ok(!/\b0\b/.test(pill.text), `no fabricated zero in "${pill.text}"`);

  const released = dashboardPills({
    permissions: [TRADING_READ_PERMISSION],
    state: { tradingMode: "PAPER_TRADING", killSwitch: { active: false } },
    accounts: { accounts: [{}, {}] },
  });
  assert.deepEqual(released.map((pill) => pill.text), ["Mode PAPER_TRADING", "2 paper accounts", "Language learning not ported"]);

  const engaged = dashboardPills({
    permissions: [TRADING_READ_PERMISSION],
    state: { tradingMode: "PAPER_TRADING", killSwitch: { active: true } },
    accounts: { accounts: [{}] },
  });
  assert.deepEqual(engaged.map((pill) => pill.text), ["Kill switch active", "1 paper account", "Language learning not ported"]);
  assert.deepEqual(engaged[0].tone, "badge-amber");
  assert.equal(engaged[1].tone, "badge-gray");
  assert.equal(engaged[2].tone, "badge-muted", "the one pill with no module behind it is the muted one");
  assert.ok(!engaged.some((pill) => /PAPER_TRADING/.test(pill.text)), "the kill switch replaces the mode, as it did on the page");

  // A read that failed is named as unread rather than defaulted to a mode.
  assert.equal(dashboardPills({ permissions: [TRADING_READ_PERMISSION], state: null, accounts: null })[0].text, "Trading state unread");
  assert.equal(dashboardPills({ permissions: [TRADING_READ_PERMISSION], state: null, accounts: null })[1].text, "Paper accounts unread");

  const unread = kpiCards({ permissions: [], runs: null, unread: null, accounts: null });
  const language = unread.find((card) => card.key === "languages");
  assert.equal(language.value, "—");
  assert.equal(language.to, null);
  assert.match(language.note, /row 16/);
  assert.equal(language.note, LANGUAGE_NOTE);
  const accounts = unread.find((card) => card.key === "accounts");
  assert.equal(accounts.value, "—");
  assert.match(accounts.note, /trading\.view/);
  assert.equal(unread.find((card) => card.key === "runs").value, "—");
  assert.equal(unread.find((card) => card.key === "alerts").value, "—");

  const read = kpiCards({ permissions: [TRADING_READ_PERMISSION], runs: { runs: [{}, {}] }, unread: 3, accounts: { accounts: [{}] } });
  assert.equal(read.find((card) => card.key === "runs").value, "2");
  assert.match(read.find((card) => card.key === "runs").note, /not a lifetime total/, "the count is the window, and says so");
  assert.equal(read.find((card) => card.key === "alerts").value, "3");
  assert.match(read.find((card) => card.key === "accounts").note, /owner-scoped/, "the count is the viewer's, not the table's");
  assert.match(read.find((card) => card.key === "accounts").note, /\/app\/paper/, "and the note says where to read the accounts it counts");
  assert.equal(read.find((card) => card.key === "accounts").to, "/app/paper");
});

test("a destination this edition does not have is not offered as a link", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const declared = new Set([...app.matchAll(/path:\s*"(\/app[^"]*)"/g)].map((match) => match[1]));
  assert.ok(declared.size >= 10, `expected the shell's declared surfaces, found ${declared.size}`);

  const destinations = [
    ...quickActions().map((action) => ({ ...action, from: "quick action" })),
    ...kpiCards({ permissions: [], runs: null, unread: 0, accounts: null }).map((card) => ({ ...card, from: "KPI card" })),
    { ...PANEL_FEET.activity, from: "activity foot" },
    { ...PANEL_FEET.alerts, from: "alerts foot" },
  ];
  for (const entry of destinations) {
    if (entry.to) {
      assert.ok(declared.has(entry.to), `${entry.from} → ${entry.to} must be a declared route`);
    } else {
      assert.ok(typeof entry.note === "string" && entry.note.length > 40, `${entry.from} with no destination must say why`);
    }
  }

  // The premises of the two notes, checked against the router itself. The paper console
  // arrived in Phase 37, so its note no longer states a gap — it links, and what it links
  // to has to be a declared route.
  assert.ok(declared.has("/app/paper"), "the paper console is declared, so its card and quick action open it");
  assert.ok(!declared.has("/app/journal"), "the activity foot's premise: there is no journal route");
  assert.ok(!/F-29/.test(PAPER_NOTE), "F-29 counted the paper screen as absent; the note must not keep saying so");
  assert.match(PAPER_NOTE, /kill switch/);
  assert.match(LANGUAGE_NOTE, /row 16/);
});

// ------------------------------------------------------------------- the row shapes

test("the activity table and the alert feed print what the API sends, and nothing it does not", () => {
  const payload = {
    runs: [
      { id: "r1", symbol: "BTCUSDT", timeframe: "1h", bias: "BULLISH", confidence: 0.55, completedAt: "2026-10-16T12:57:15.000Z", synthetic: true },
      { id: "r2", symbol: "EURUSD", timeframe: "4h", bias: "BEARISH", confidence: 0.4, completedAt: "2026-10-16T09:00:00.000Z", synthetic: false },
      { id: "r3", symbol: "XAUUSD", timeframe: "15m", bias: null, confidence: null, completedAt: "2026-10-16T08:00:00.000Z" },
    ],
  };
  const rows = activityRows(payload);
  assert.deepEqual(Object.keys(rows[0]), ["id", "symbol", "timeframe", "bias", "tone", "completed", "synthetic"]);
  assert.equal(rows[0].completed, "2026-10-16 12:57", "legacy's `substr(completed_at, 0, 16)`, with the T the API sends");
  assert.equal(rows[0].tone, biasTone("BULLISH"));
  assert.equal(rows[0].tone, "badge-green");
  assert.equal(rows[1].tone, "badge-red");
  assert.equal(rows[0].synthetic, true);
  assert.equal(rows[1].synthetic, false);
  assert.equal(rows[2].bias, "—", "a missing bias is an em dash, never a guess");
  assert.equal(rows[2].tone, "badge-gray");
  assert.deepEqual(activityRows(null), []);
  assert.deepEqual(activityRows({ runs: "not-an-array" }), []);

  const notifications = Array.from({ length: 8 }, (unused, index) => ({
    id: index + 1,
    type: "KILL_SWITCH",
    severity: index === 0 ? "critical" : index === 1 ? "warning" : "info",
    title: index === 4 ? null : `Alert ${index}`,
    createdAt: `2026-10-1${index}T09:0${index}:00.000Z`,
    unread: index % 2 === 0,
  }));
  const alerts = alertRows({ notifications });
  assert.equal(alerts.length, DASHBOARD_WINDOWS.alerts, "the page fetched eight and printed six");
  assert.equal(alertRows({ notifications }, DASHBOARD_WINDOWS.inbox).length, 8);
  assert.equal(alerts[0].tone, "badge-red");
  assert.equal(alerts[1].tone, "badge-amber");
  assert.equal(alerts[2].tone, "badge-gray");
  assert.equal(alerts[0].time, "2026-10-10 09:00");
  assert.equal(alerts[4].title, "KILL_SWITCH", "`title ?? type` is PHP's null-coalescing: a null title falls back to the type");
  assert.equal(alertRows({ notifications: [{ ...notifications[2], title: "" }] })[0].title, "", "an empty title stays empty, as `??` left it");
  assert.equal(alertRows({ notifications: [{ id: 9, type: "SYSTEM_ALERT", severity: "info", title: null, createdAt: "2026-10-10T09:00:00.000Z" }] })[0].title, "SYSTEM_ALERT");
  assert.equal(alertRows({})[0], undefined);
  assert.deepEqual(alertRows(null), []);
  assert.equal(severityTone("critical"), "badge-red");
  assert.equal(severityTone("WARNING"), "badge-amber");
  assert.equal(severityTone(undefined), "badge-gray");
});

// --------------------------------------------------------------- reads and routes

test("the four reads are the routes the server registers, with the permissions it enforces", async (t) => {
  const instance = await dashboardInstance(t);
  const inventory = (await get(instance, "/api/v1/system/routes")).json().routes;

  for (const read of [...OPEN_READS, ...GATED_READS]) {
    const route = inventory.find((entry) => entry.method === "GET" && entry.path === read.path);
    assert.ok(route, `${read.path} must be registered`);
    assert.equal(route.permission, read.permission, `${read.path} is declared with the wrong permission`);
    assert.equal(route.auth, true, `${read.path} needs a session`);
  }
  assert.deepEqual(GATED_READS.map((read) => read.permission), [TRADING_READ_PERMISSION, TRADING_READ_PERMISSION]);
  assert.equal(TRADING_READ_PERMISSION, "trading.view");
  // The inbox is behind the baseline permission every signed-in user holds; the run
  // history is behind the session alone. Neither is a module permission.
  assert.equal(OPEN_READS.find((read) => read.key === "inbox").permission, "system.authenticated");
  assert.equal(OPEN_READS.find((read) => read.key === "runs").permission, null);
  assert.equal(DASHBOARD_WINDOWS.runs, Number(new URL(`http://x/?${OPEN_READS[0].query}`).searchParams.get("limit")));
  assert.equal(DASHBOARD_WINDOWS.inbox, Number(new URL(`http://x/?${OPEN_READS[1].query}`).searchParams.get("limit")));
});

// ------------------------------------------------------------------------ behaviour

test("against the running API: a member reads what the dashboard shows, and the gate is named rather than passed", async (t) => {
  const instance = await dashboardInstance(t);
  instance.headers = (await signIn(instance, "rootadmin", "Root administrator pass")).headers;

  // A stored run for the activity table — the dashboard's own fixture path is the
  // console's run endpoint, so the row it renders is one an operator can produce.
  const run = await post(instance, "/api/v1/analysis/run", { symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" });
  assert.equal(run.statusCode, 200, run.body);

  const history = await get(instance, `/api/v1/analysis/history?limit=${DASHBOARD_WINDOWS.runs}`);
  assert.equal(history.statusCode, 200);
  const rows = activityRows(history.json());
  assert.ok(rows.length >= 1, "the run just stored must appear in the dashboard's window");
  assert.equal(rows[0].symbol, "BTCUSDT");
  assert.equal(rows[0].timeframe, "1h");
  assert.match(rows[0].completed, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(rows[0].synthetic, true, "a hermetic run is synthetic, and the row says so");

  // The inbox: a broadcast row with a critical severity, written the way the platform
  // writes one (an empty title is refused by the service, so `??` only answers for
  // rows written outside it).
  await instance.store.createNotification({
    userId: null, type: "KILL_SWITCH", severity: "critical", title: "Kill switch engaged",
    detail: {}, dedupeKey: "dashboard-test:kill-switch", createdAt: "2026-10-16T09:00:00.000Z",
  });
  const inbox = await get(instance, `/api/v1/notifications?limit=${DASHBOARD_WINDOWS.inbox}`);
  assert.equal(inbox.statusCode, 200);
  const inboxBody = inbox.json();
  assert.equal(typeof inboxBody.unread, "number");
  const alerts = alertRows(inboxBody);
  assert.equal(alerts[0].title, "Kill switch engaged");
  assert.equal(alerts[0].tone, "badge-red");
  assert.equal(alerts[0].unread, true);

  // The two governance reads answer for a viewer who holds `trading.view`, and the
  // pills/cards then show the server's own state.
  const state = await get(instance, "/api/v1/trading/mode");
  assert.equal(state.statusCode, 200, state.body);
  const accounts = await get(instance, "/api/v1/paper/accounts");
  assert.equal(accounts.statusCode, 200, accounts.body);
  assert.ok(Array.isArray(accounts.json().accounts));
  const permissions = ["trading.view"];
  const pills = dashboardPills({ permissions, state: state.json(), accounts: accounts.json() });
  assert.equal(pills[0].text, state.json().killSwitch.active ? "Kill switch active" : `Mode ${state.json().tradingMode}`);
  assert.equal(pills[1].text, countLabel(accounts.json().accounts.length, "paper account"));
  const cards = kpiCards({ permissions, runs: history.json(), unread: inboxBody.unread, accounts: accounts.json() });
  assert.equal(cards.find((card) => card.key === "runs").value, String(rows.length));
  assert.equal(cards.find((card) => card.key === "accounts").value, String(accounts.json().accounts.length));
  assert.equal(cards.find((card) => card.key === "alerts").value, String(inboxBody.unread));

  // The member with nothing granted: the same two session reads answer, the two
  // governance reads are refused, and the screen has something to say about it.
  const member = await addUnprivilegedMember(instance);
  assert.deepEqual(member.permissions, [], "the seeded member role grants nothing but the signed-in baseline");
  assert.equal((await get(instance, "/api/v1/analysis/history?limit=6", member.headers)).statusCode, 200);
  assert.equal((await get(instance, "/api/v1/notifications?limit=8", member.headers)).statusCode, 200);
  const refusedState = await get(instance, "/api/v1/trading/mode", member.headers);
  assert.equal(refusedState.statusCode, 403, refusedState.body);
  assert.equal(refusedState.json().error.code, "PERMISSION_DENIED");
  assert.equal((await get(instance, "/api/v1/paper/accounts", member.headers)).statusCode, 403);

  const memberPills = dashboardPills({ permissions: member.permissions, state: null, accounts: null });
  assert.deepEqual(memberPills.map((pill) => pill.text), ["Trading state needs trading.view", "Paper accounts need trading.view", "Language learning not ported"]);
  const memberCards = kpiCards({ permissions: member.permissions, runs: null, unread: null, accounts: null });
  assert.equal(memberCards.find((card) => card.key === "accounts").value, "—");
  // The card still opens the console for a session that cannot read the count: the shell's
  // own route gate names the missing permission, which is more use than a card that is
  // silently not a link. The note carries the same sentence the pill does.
  assert.equal(memberCards.find((card) => card.key === "accounts").to, "/app/paper");
  assert.match(memberCards.find((card) => card.key === "accounts").note, /needs trading\.view/);
});

// -------------------------------------------------------------------- the screen

test("the screen: /app is declared, session-only, and renders the dashboard", async (t) => {
  const instance = await dashboardInstance(t);
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");

  const route = app.match(/\{[^{}]*path:\s*"\/app"[^{}]*\}/);
  assert.ok(route, "/app must be a declared exact-path route");
  assert.match(route[0], /requiresAuth:\s*true/);
  assert.ok(!/permission:/.test(route[0]), "legacy's `App_Controller` required a session and nothing else — the screen must not invent a permission");
  assert.match(app, /workspace:\s*<WorkspaceOverview/, "the route must resolve to a view, or it renders blank");
  assert.match(app, /WorkspaceOverview[\s\S]{0,400}<WorkspaceDashboard/, "the dashboard is what the signed-in home renders");
  assert.match(app, /export function WorkspaceDashboard|WorkspaceDashboard,/, "the dashboard is imported from the views module");
  assert.match(views, /export function WorkspaceDashboard\(\{ user, permissions \}\)/);
  assert.match(views, /from "\.\/dashboard\.js"/);

  // The claim this page used to make about the trading mode is gone: the mode is
  // real now, and the readiness strip states the edition's posture instead.
  assert.ok(!/Not enabled in this shell/.test(app), "the stale trading-mode claim must be gone");
  assert.match(app, /Simulation only · no live route/);

  // A bookmarked `/app` reaches the shell — which needs the built client, since
  // `public/app/` is generated and git-ignored.
  assert.ok(existsSync(path.resolve(CLIENT, "..", "..", "public", "app", "index.html")), "the built SPA shell is required: npm run build:client");
  const html = await instance.app.inject({ method: "GET", url: "/app", headers: { accept: "text/html" } });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);

  // And the dashboard is inside the bundle the shell serves.
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, `the shell must reference the built bundle, found ${html.body.length} bytes`);
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  assert.match(bundle, /WINDELS AI WORKFORCE/, "the dashboard's eyebrow is in the built bundle");
  assert.match(bundle, /Language learning not ported/);
  assert.match(bundle, /paper accounts/, "the pluralised paper count");
});

// ------------------------------------------------- the absences the page explains

test("the two absences the page explains are the ledger's and the router's own", async (t) => {
  const instance = await dashboardInstance(t);
  instance.headers = (await signIn(instance, "rootadmin", "Root administrator pass")).headers;

  const modules = (await get(instance, "/api/v1/system/status")).json().modules;
  const language = modules.find((module) => module.key === "languageLearning");
  const paper = modules.find((module) => module.key === "paperTrading");
  assert.equal(language.state, "not-ported", "the language card's premise: there is no Node module to count profiles from");
  assert.equal(paper.state, "ported", "the paper note's premise: the module is ported, and now screened");

  const routes = (await get(instance, "/api/v1/system/routes")).json().routes;
  assert.ok(routes.some((route) => route.path.startsWith("/api/v1/paper/")), "the paper note names a surface that exists");
  assert.ok(!routes.some((route) => route.path.startsWith("/api/v1/lang") || route.path.startsWith("/api/v1/languages")), "and no language surface exists to link to");

  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const declared = new Set([...app.matchAll(/path:\s*"(\/app[^"]*)"/g)].map((match) => match[1]));
  // `/app/sports` left this list in Phase 36: F-29 counted the sports screens as absent,
  // and that count is what this assertion was about — the console exists now, so keeping
  // the path here would pin a screen as missing after it shipped.
  // `/app/risk` left this list in Phase 38, for the reason `/app/paper` left it in 37 and
  // `/app/sports` in 36. `/app/execution` left it in Phase 39.
  // `/app/brokers` left this list in Phase 40, so the only screen F-29 still counts as absent
  // is the journal (row 18).
  for (const missing of ["/app/journal"]) {
    assert.ok(!declared.has(missing), `${missing} is named as an open screen in F-29 and must not be declared here`);
  }
  for (const landed of ["/app/sports", "/app/paper", "/app/risk", "/app/execution", "/app/brokers"]) {
    assert.ok(declared.has(landed), `${landed} is declared, and the F-29 list above is about the screens still absent`);
  }
  // The module counts are untouched by this phase: the dashboard is a screen for the
  // shell, not a promotion for a module.
  assert.equal(modules.filter((module) => module.state === "ported").length, 10);
  assert.equal(modules.filter((module) => module.state === "partial").length, 5);
});
