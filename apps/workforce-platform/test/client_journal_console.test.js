/**
 * The journal console against the API it reads (row 18, Phase 41).
 *
 * `views/journal/index.php` → `Journal::index` is legacy's one page over the journal: five
 * group switches, the six overall figures with their per-group table, the newest 200 entries
 * and the confidence-calibration meters. The port serves it from the strategies module's four
 * journal routes and this suite holds the screen to the three things every console suite holds
 * its screen to:
 *
 *  1. **The copy is legacy's.** Every heading, label, empty state and table header in
 *     `client/src/journal.js` is asserted against `views/journal/index.php`, with the sentences
 *     this port adds kept in a separate object so a legacy claim cannot become the port's own.
 *  2. **The figures are the server's, formatted as the PHP formatted them.** `journalTotals`,
 *     `journalGroupRows` and `journalCalibrationRows` only format; the suite drives the live
 *     endpoints over seeded rows and asserts the screen's cells against the same response.
 *  3. **The guard is legacy's.** All four routes are session-only — `Journal` extended
 *     `App_Controller` and `Api_journal` extended `Api_controller`, neither of which required a
 *     permission — so a signed-in account with no permissions reads all three surfaces, and the
 *     module's one write is the CSRF-gated manual route the screen does not draw.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp` with
 * `MARKET_DATA_REAL_PROVIDERS=0`, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  JOURNAL_COPY, JOURNAL_GROUPS, JOURNAL_PORT_COPY, JOURNAL_READS, JOURNAL_WINDOWS, JOURNAL_WRITE,
  SOURCE_TONES, journalCalibrationRows, journalCount, journalEntryRows, journalGroupRows,
  journalNote, journalNumber, journalPercent, journalTime, journalTone, journalTotals,
  journalVerdict, overallHeading, sourceTone,
} from "../client/src/journal.js";
import { PANEL_FEET } from "../client/src/dashboard.js";
import { GROUP_KEYS, NO_CONFIDENCE_NOTE, CALIBRATION_VERDICTS } from "../src/modules/strategies/journal-analytics.js";
import { JOURNAL_LIMIT_DEFAULT, JOURNAL_LIMIT_MAX } from "../src/modules/strategies/contracts.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_VIEW = path.join(REPO, "application", "views", "journal", "index.php");
const SERVICE = path.resolve(import.meta.dirname, "..", "src", "modules", "strategies", "service.js");

const view = () => readFileSync(LEGACY_VIEW, "utf8");
/** Legacy's prose with its inline markup and entities resolved, so a sentence compares whole. */
const plain = (text) => text
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, " ");

const JOURNAL_ENV = { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "1" };

async function instance(t) {
  const app = await createFileStoreApp({ configOverrides: { env: JOURNAL_ENV } });
  t.after(() => app.cleanup());
  return app;
}

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { cookie: cookieFrom(response), headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken } };
}

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });

/** A role carrying exactly the permissions named. */
async function roleSession(app, store, { username, phrase, permissions }) {
  const role = await store.ensureRole(`${username}_role`, `${username} role`);
  for (const key of ["system.authenticated", ...permissions]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  const user = await store.createUser({
    username, email: `${username}@example.test`, passwordHash: await hashPassword(phrase), displayName: username,
  });
  await store.assignRole(user.id, role.id);
  return signIn(app, username, phrase);
}

/** A closed journal row, shaped like the repository's and legacy's own. */
function entry({ id, pnl, confidence = null, source = "backtest", symbol = "EURUSD", strategy = "trend-following", minutes = 0, exit = true, direction = "LONG" }) {
  const at = (offset) => new Date(Date.UTC(2026, 9, 1, 10, minutes + offset)).toISOString();
  return {
    id: id ?? `journal-${Math.random().toString(16).slice(2)}`,
    source,
    symbol,
    market: "forex",
    strategy,
    strategy_version: "1.0.0",
    direction,
    entry_time: at(0),
    entry_price: 1.075,
    exit_time: exit ? at(30) : null,
    exit_price: exit ? 1.09 : null,
    position_size: 1000,
    stop_loss: 1.07,
    take_profit: 1.1,
    fees: 0,
    slippage: 0,
    pnl,
    pnl_pct: 1.0,
    r_multiple: pnl === null ? null : pnl / 10,
    reason: "thesis",
    ai_confidence: confidence,
    confidence_source: confidence === null ? null : "strategy",
    agent_consensus: null,
    risk_score: null,
    execution_time: at(0),
  };
}

/* ------------------------------------------------------------------ the page's words */

test("the headings, labels, headers and empty states are the legacy page's own words", () => {
  const page = plain(view());
  const controllerOnly = new Set(["eyebrow"]);
  for (const [key, value] of Object.entries(JOURNAL_COPY).filter(([, value]) => typeof value === "string")) {
    // The heading interpolates its count and `open` sits inside a PHP ternary; both are
    // asserted separately below.
    if (controllerOnly.has(key) || key === "overallTitle" || key === "open") continue;
    assert.ok(page.includes(value), `${key} must be the legacy page's own string: ${JSON.stringify(value)}`);
  }
  assert.ok(page.includes(`${JOURNAL_COPY.overallTitle} (`), "the overall heading is legacy's, with its count appended");
  for (const group of JOURNAL_GROUPS) {
    assert.ok(page.includes(group.label), `${group.key}'s switch label is the page's: ${group.label}`);
    // The keys live inside the `foreach` array, so they are asserted against the raw PHP.
    assert.ok(view().includes(`'${group.key}' =>`), `${group.key} is one of the five keys the page offers`);
  }
  for (const header of JOURNAL_COPY.entryHeaders) {
    // Some headers carry `class="num"`; the label is what the port must keep.
    assert.match(view(), new RegExp(`<th[^>]*>${header}</th>`), `the entries table header ${header} is the page's`);
  }
  // `open` is inside a PHP ternary, so `plain()` removes it with the tag: it is asserted raw.
  assert.ok(view().includes(": 'open'"), "an unexited trade prints legacy's own word");
  // The group table's six headers, the first of which is the raw group key the page echoed.
  for (const header of [JOURNAL_COPY.groupTrades, JOURNAL_COPY.groupWinRate, JOURNAL_COPY.groupProfitFactor,
    JOURNAL_COPY.groupExpectancy, JOURNAL_COPY.groupTotalPnl]) {
    assert.ok(page.includes(header), `the group table header ${header} is the page's`);
  }
  // The two empty states are sentences, not invented ones.
  assert.ok(view().includes("No entries yet — run a backtest or paper trade."));
  assert.ok(view().includes("No confidence-tagged closed trades yet."));
});

test("the port's own sentences are its own, and none of them claims a control", () => {
  const page = plain(view());
  for (const [key, value] of Object.entries(JOURNAL_PORT_COPY)) {
    assert.ok(!page.includes(value), `${key} is this port's sentence, so it must not be in the PHP`);
    assert.ok(value.length > 40, `${key} says something a reader can act on`);
  }
  // The two divergences and the undrawn write are stated, not left to be discovered.
  assert.match(JOURNAL_PORT_COPY.summaryWindow, /500 rows/);
  assert.match(JOURNAL_PORT_COPY.summaryWindow, /200 rows it displayed/);
  assert.match(JOURNAL_PORT_COPY.groupSwitch, /query string/);
  assert.match(JOURNAL_PORT_COPY.manualWrite, /POST \/api\/v1\/journal\/manual/);
  assert.match(JOURNAL_PORT_COPY.manualWrite, /draw no form|drew no form/);
  assert.match(JOURNAL_PORT_COPY.row18, /chat assistant/);
});

test("the five group keys are the server's own vocabulary", () => {
  // Membership is the contract: `SUMMARY_QUERY` accepts exactly these five. The ORDER is the
  // page's `foreach` order, which is not the order the server lists its accepted values in —
  // so the suite compares the sets and pins the view's order separately.
  assert.deepEqual([...GROUP_KEYS].sort(), ["confidence", "market", "source", "strategy", "symbol"]);
  assert.deepEqual([...JOURNAL_GROUPS.map((group) => group.key)].sort(), [...GROUP_KEYS].sort());
  assert.deepEqual(JOURNAL_GROUPS.map((group) => group.key), ["strategy", "symbol", "market", "source", "confidence"]);
});

/* ---------------------------------------------------------------------------- formatting */

test("the formatters reproduce number_format and never invent a figure", () => {
  assert.equal(journalNumber(1234.5, 0), "1,235");
  assert.equal(journalNumber(1234.5, 2), "1,234.50");
  assert.equal(journalNumber(-42, 0), "-42");
  assert.equal(journalNumber(0, 1), "0.0");
  assert.equal(journalNumber(null, 2), "—");
  assert.equal(journalNumber(undefined, 2), "—");
  assert.equal(journalNumber("", 2), "—");
  assert.equal(journalNumber("nonsense", 2), "—");

  assert.equal(journalPercent(0.5, 1), "50.0%");
  assert.equal(journalPercent(0.126, 0), "13%");
  assert.equal(journalPercent(null, 0), "—");

  // A count is printed raw — legacy never passed it through number_format.
  assert.equal(journalCount(1234), "1234");
  assert.equal(journalCount(0), "0");
  assert.equal(journalCount(null), "—");

  // `>= 0` is up, the `?? 0` default included; only a real negative is down.
  assert.equal(journalTone(0), "up");
  assert.equal(journalTone(null), "up");
  assert.equal(journalTone(-0.01), "down");

  assert.equal(journalTime("2026-10-17T07:15:48.308Z"), "2026-10-17T07:15");
  assert.equal(journalTime(null), "—");
});

test("the six overall figures carry legacy's labels, formatting and tones", () => {
  const summary = {
    overall: {
      winRate: 0.6625, profitFactor: 1.8, totalPnl: -1234.4, avgRMultiple: 0.3249,
      expectancyPnl: 7.25, maxDrawdownAbs: 1000.4, closedTrades: 1234,
    },
  };
  const totals = journalTotals(summary);
  assert.deepEqual(totals.map((total) => total.label), [
    "Win rate", "Profit factor", "Total P&L", "Avg R", "Expectancy", "Max DD ($)",
  ]);
  assert.deepEqual(totals.map((total) => total.value), ["66.3%", "1.80", "-1,234", "0.32", "7.3", "1,000"]);
  assert.deepEqual(totals.map((total) => total.tone), [null, null, "down", null, null, "warn"]);
  assert.equal(overallHeading(summary), "Overall (1234 closed trades)");

  // An analytics response with nothing in it is dashes, not zeros.
  const empty = journalTotals({ overall: {} });
  assert.deepEqual(empty.map((total) => total.value), ["—", "—", "—", "—", "—", "—"]);
  assert.equal(empty[2].tone, "up", "legacy's `?? 0` made an absent total P&L up");
  assert.equal(overallHeading({}), "Overall (— closed trades)");

  // A real zero is a zero: the heading and the total stay numeric.
  assert.equal(journalTotals({ overall: { totalPnl: 0 } })[2].value, "0");
  assert.equal(overallHeading({ overall: { closedTrades: 0 } }), "Overall (0 closed trades)");
});

test("the group rows are formatted as the PHP formatted them, with legacy's note", () => {
  const summary = {
    groups: [
      { key: "breakout", metrics: { count: 12, winRate: 0.5, profitFactor: null, expectancyPnl: -2.5, totalPnl: -30 } },
      { key: "trend-following", metrics: { count: 7, winRate: 0.714, profitFactor: 2.5, expectancyPnl: 4.25, totalPnl: 29.75 } },
    ],
    note: "a note only the confidence grouping produces",
  };
  const rows = journalGroupRows(summary);
  assert.equal(rows[0].key, "breakout");
  assert.equal(rows[0].trades, "12");
  assert.equal(rows[0].winRate, "50%");
  assert.equal(rows[0].profitFactor, "—");
  assert.equal(rows[0].expectancy, "-2.5");
  assert.equal(rows[0].expectancyTone, "down");
  assert.equal(rows[0].totalPnl, "-30");
  assert.equal(rows[0].totalTone, "down");
  assert.equal(rows[1].winRate, "71%");
  assert.equal(rows[1].profitFactor, "2.50");
  assert.equal(rows[1].expectancyTone, "up");
  assert.equal(rows[1].totalTone, "up");
  assert.equal(journalGroupRows({})?.length, 0);
  assert.equal(journalNote(summary), "a note only the confidence grouping produces");
  assert.equal(journalNote({ note: null }), null);
  assert.equal(journalNote({}), null);
});

/* ------------------------------------------------------------------------------- entries */

test("the entries table prints legacy's cells, source tones included", () => {
  const rows = journalEntryRows({
    entries: [
      entry({ id: "a", pnl: 15.25, source: "backtest", confidence: 0.87 }),
      entry({ id: "b", pnl: null, source: "paper", confidence: null, strategy: null, exit: false }),
      entry({ id: "c", pnl: -5, source: "manual", strategy: "breakout" }),
      entry({ id: "d", pnl: 0, source: "live", direction: "SHORT" }),
    ],
  });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.sourceTone), ["badge-sky", "badge-violet", "badge-gray", "badge-red"]);
  assert.deepEqual(SOURCE_TONES, { backtest: "badge-sky", paper: "badge-violet", manual: "badge-gray", live: "badge-red" });
  assert.equal(sourceTone("unknown"), "badge-gray", "legacy's fallback badge is neutral");

  assert.equal(rows[0].time, "2026-10-01T10:00");
  assert.equal(rows[0].symbol, "EURUSD");
  assert.equal(rows[0].direction, "▲");
  assert.equal(rows[0].directionTone, "up");
  assert.equal(rows[0].entryPrice, "1.07500");
  assert.equal(rows[0].exitPrice, "1.09000");
  assert.equal(rows[0].pnl, "15.3");
  assert.equal(rows[0].pnlTone, "up");
  assert.equal(rows[0].rMultiple, "1.53");
  assert.equal(rows[0].confidence, "87%");

  // An unexited trade says `open`, and its gaps are dashes rather than zeroes.
  assert.equal(rows[1].exitPrice, "open");
  assert.equal(rows[1].pnl, "—");
  assert.equal(rows[1].rMultiple, "—");
  assert.equal(rows[1].confidence, "—");
  assert.equal(rows[1].strategy, "—");

  assert.equal(rows[2].pnlTone, "down");
  assert.equal(rows[3].direction, "▼");
  assert.equal(rows[3].directionTone, "down");
  assert.equal(rows[3].pnl, "0.0", "a real zero is printed, not hidden");
  assert.equal(journalEntryRows(undefined).length, 0);
  assert.equal(journalEntryRows({ entries: [] }).length, 0);
});

/* --------------------------------------------------------------------------- calibration */

test("the calibration meters keep legacy's bar widths, colours and text", () => {
  const buckets = journalCalibrationRows({
    buckets: [
      { key: "0–40% (low)", count: 4, winRate: 0.25, expectancyR: -0.4 },
      { key: "40–60% (moderate)", count: 2, winRate: 0.5, expectancyR: 0.125 },
      { key: "60–80% (high)", count: 3, winRate: null, expectancyR: null },
    ],
  });
  assert.deepEqual(buckets.map((bucket) => bucket.key), ["0–40% (low)", "40–60% (moderate)", "60–80% (high)"]);
  assert.deepEqual(buckets.map((bucket) => bucket.text), [
    "4 trades · win 25% · E[R] -0.40",
    "2 trades · win 50% · E[R] 0.13",
    "3 trades · win — · E[R] —",
  ]);
  assert.deepEqual(buckets.map((bucket) => bucket.width), [25, 50, 0]);
  // Green at .5 and above, red below — including for an absent rate, as the PHP's `?? 0` did.
  assert.deepEqual(buckets.map((bucket) => bucket.tone), ["down", "up", "down"]);
  assert.equal(journalCalibrationRows({}).length, 0);

  // A rate outside 0..1 can only come from a hand-written row; the bar stays inside its track.
  assert.equal(journalCalibrationRows({ buckets: [{ key: "x", count: 1, winRate: 2, expectancyR: 0 }] })[0].width, 100);
  assert.equal(journalCalibrationRows({ buckets: [{ key: "x", count: 1, winRate: -1, expectancyR: 0 }] })[0].width, 0);
});

test("the verdict is the server's sentence, and its tone is legacy's ok/warnbox split", () => {
  const sufficient = journalVerdict({ sufficientData: true, verdict: CALIBRATION_VERDICTS.INFORMATIVE });
  assert.deepEqual(sufficient, { text: CALIBRATION_VERDICTS.INFORMATIVE, tone: "ok" });
  const small = journalVerdict({ sufficientData: false, verdict: CALIBRATION_VERDICTS.smallSample(3) });
  assert.equal(small.tone, "warn");
  assert.equal(small.text, "Sample too small for a calibration verdict (3 confidence-tagged closed trades; need 30+). Collect more journal entries.");
  assert.equal(journalVerdict({}), null);
  assert.equal(journalVerdict(null), null);
});

/* ------------------------------------------------------------------------------- windows */

test("the windows the screen states are the server's own bounds", () => {
  assert.equal(JOURNAL_WINDOWS.entries, JOURNAL_LIMIT_DEFAULT);
  assert.equal(JOURNAL_WINDOWS.calibration, JOURNAL_LIMIT_MAX);
  // The summary bound is a private constant in the service, so it is read from the source
  // rather than guessed: the screen's stated 500 must be the number the endpoint uses.
  const service = readFileSync(SERVICE, "utf8");
  assert.match(service, /const JOURNAL_SUMMARY_LIMIT = 500;/);
  assert.match(service, /listJournalEntries\(\{ limit: JOURNAL_SUMMARY_LIMIT \}\)/);
  assert.equal(JOURNAL_WINDOWS.summary, 500);
});

test("the three reads are session-only, and the one write is documented as undrawn", () => {
  assert.deepEqual(JOURNAL_READS.map((read) => read.path), [
    "/api/v1/journal",
    "/api/v1/journal/analytics/summary",
    "/api/v1/journal/analytics/calibration",
  ]);
  assert.equal(JOURNAL_READS.every((read) => read.permission === null), true,
    "Journal::index extended App_Controller: a login and no permission, exactly as the API routes do");
  assert.equal(JOURNAL_WRITE.path, "/api/v1/journal/manual");
  assert.equal(JOURNAL_WRITE.csrf, true);
  assert.equal(JOURNAL_WRITE.panel, "Not drawn");
});

/* -------------------------------------------------------------------------------- routes */

test("the journal routes answer where this screen reads, with the guard it says", async (t) => {
  const app = await instance(t);
  const { headers } = await signIn(app.app);
  const routes = (await get(app.app, "/api/v1/system/routes", headers)).json().routes;
  for (const read of JOURNAL_READS) {
    const route = routes.find((candidate) => candidate.method === read.method && candidate.path === read.path);
    assert.ok(route, `${read.method} ${read.path} is registered`);
    assert.equal(route.auth, true, `${read.path} needs a session`);
    assert.equal(route.permission, null, `${read.path} carries no permission — legacy's page had none`);
  }
  const write = routes.find((candidate) => candidate.method === JOURNAL_WRITE.method && candidate.path === JOURNAL_WRITE.path);
  assert.ok(write, "the manual route exists even though the screen does not draw it");
  assert.equal(write.permission, null);
  // The legacy `api/analytics/*` prefix was deliberately not reproduced (DV-8).
  assert.equal(routes.some((route) => route.path.startsWith("/api/v1/analytics")), false);
});

test("a signed-in account with no permissions reads every panel; the write still needs CSRF", async (t) => {
  const app = await instance(t);
  const plainUser = await roleSession(app.app, app.store, {
    username: "journalreader", phrase: "Journal reader phrase", permissions: [],
  });
  for (const read of JOURNAL_READS) {
    const response = await get(app.app, read.path, plainUser.headers);
    assert.equal(response.statusCode, 200, `${read.path}: ${response.body}`);
  }
  const anonymous = await get(app.app, "/api/v1/journal");
  assert.equal(anonymous.statusCode, 401, "the page itself needed a login, and so do its reads");

  // Legacy's manual route is a session write with CSRF. The screen draws no form for it, but
  // the suite pins the guard so a future form cannot be added against a route that lost it.
  const payload = {
    symbol: "EURUSD", direction: "LONG", entryTime: "2026-10-01T10:00:00.000Z",
    entryPrice: 1.1, positionSize: 1000, reasonForTrade: "a thesis",
  };
  const cookieOnly = await app.app.inject({ method: "POST", url: JOURNAL_WRITE.path, payload, headers: { cookie: plainUser.cookie } });
  assert.equal(cookieOnly.statusCode, 403, cookieOnly.body);
  assert.equal(cookieOnly.json().error.code, "CSRF_INVALID");
});

/* -------------------------------------------------------------------------- the live data */

test("the live endpoints feed the panels, and the screen's cells match the payload", async (t) => {
  const app = await instance(t);
  const { headers } = await signIn(app.app);
  await app.store.saveJournalEntry(entry({ id: "live-1", pnl: 25, confidence: 0.9, strategy: "breakout" }));
  await app.store.saveJournalEntry(entry({ id: "live-2", pnl: -10, confidence: null, strategy: "breakout" }));
  await app.store.saveJournalEntry(entry({ id: "live-3", pnl: null, confidence: 0.5, strategy: "momentum", source: "paper", exit: false }));

  const listing = (await get(app.app, `/api/v1/journal?limit=${JOURNAL_WINDOWS.entries}`, headers)).json();
  assert.equal(listing.entries.length, 3);
  const rows = journalEntryRows(listing);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.exitPrice === "open").length, 1, "the unexited row says open");

  const summary = (await get(app.app, "/api/v1/journal/analytics/summary?groupBy=strategy", headers)).json();
  const groups = journalGroupRows(summary);
  // `momentum`'s only row has not exited, so it is not a closed trade and the grouping — which
  // only counts closed trades — does not list it. The table lists it; the analytics do not.
  assert.deepEqual(groups.map((group) => group.key), ["breakout"]);
  assert.equal(groups[0].trades, "2");
  // The heading's count is the endpoint's count of closed trades, not the row count.
  assert.equal(overallHeading(summary), "Overall (2 closed trades)");
  assert.deepEqual(journalTotals(summary).map((total) => total.value)[0], "50.0%");

  // The confidence grouping uses the server's own bucket keys; the one closed, tagged row
  // lands in the top bucket and there is no "no tag" note while a tagged trade exists.
  const byConfidence = (await get(app.app, "/api/v1/journal/analytics/summary?groupBy=confidence", headers)).json();
  assert.deepEqual(journalGroupRows(byConfidence).map((group) => group.key), ["80–100% (very high)"]);
  assert.equal(journalNote(byConfidence), null);

  // With no confidence-tagged closed trade at all, the endpoint sends its own note instead of
  // inventing an empty bucket — and the screen renders that sentence verbatim.
  const untagged = await createFileStoreApp({ configOverrides: { env: JOURNAL_ENV } });
  try {
    await untagged.store.saveJournalEntry(entry({ id: "note-1", pnl: 5 }));
    // A second store means a second session: this app's cookie is not the first app's.
    const untaggedSession = await signIn(untagged.app);
    const noteSummary = (await get(untagged.app, "/api/v1/journal/analytics/summary?groupBy=confidence", untaggedSession.headers)).json();
    assert.deepEqual(journalGroupRows(noteSummary), []);
    assert.equal(journalNote(noteSummary), NO_CONFIDENCE_NOTE);
  } finally {
    await untagged.cleanup();
  }

  const calibration = (await get(app.app, "/api/v1/journal/analytics/calibration", headers)).json();
  assert.equal(calibration.sufficientData, false);
  assert.deepEqual(journalVerdict(calibration), { text: CALIBRATION_VERDICTS.smallSample(1), tone: "warn" });
  const buckets = journalCalibrationRows(calibration);
  assert.equal(buckets.length, 1, "only the 0.9 row is confidence-tagged and closed");
  assert.equal(buckets[0].width, 100);

  const invalid = await get(app.app, "/api/v1/journal/analytics/summary?groupBy=ticker", headers);
  assert.equal(invalid.statusCode, 400);
});

/* ---------------------------------------------------------------------------- the screen */

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/journal", view: "journal", requiresAuth: true \}/);
  assert.match(app, /journal: <JournalView \/>/);
  assert.match(views, /export function JournalView\(\)/);
  assert.match(views, /\{ to: "\/app\/journal", label: "Journal", permission: null \}/);
  assert.match(views, /<h1>\{JOURNAL_COPY\.title\}<\/h1>/);
  assert.match(api, /journal: \(query = ""\) => api\(`\/api\/v1\/journal\$\{query\}`\)/);
  assert.match(api, /journalSummary: \(groupBy\) => api\(`\/api\/v1\/journal\/analytics\/summary\$\{groupBy \? `\?groupBy=/);
  assert.match(api, /journalCalibration: \(\) => api\("\/api\/v1\/journal\/analytics\/calibration"\)/);

  const viewSource = views.slice(views.indexOf("export function JournalView()"), views.indexOf("/* ------------------------------------------------------------- risk console */"));
  // The legacy page was a read, and so is this one: no write verb appears in the screen.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", 'method: "POST"']) {
    assert.ok(!viewSource.includes(method), `the journal console issues no ${method}`);
  }
  // The group switches are state, not links: this router has no query string, and the screen
  // says so. A `?groupBy=` href would be a promise the router cannot keep.
  assert.ok(!viewSource.includes("groupBy="), "the switch does not pretend to be a link");
  assert.match(viewSource, /aria-pressed=\{groupBy === group\.key\}/);
  assert.match(viewSource, /onClick=\{\(\) => setGroupBy\(group\.key\)\}/);
  // The one write is named in the reads panel rather than drawn as a control.
  assert.match(viewSource, /\{JOURNAL_WRITE\.method\} \{JOURNAL_WRITE\.path\}/);
  assert.match(viewSource, /not drawn/);
  // The two divergences and the row's remainder are on the page.
  assert.match(viewSource, /JOURNAL_PORT_COPY\.summaryWindow/);
  assert.match(viewSource, /JOURNAL_PORT_COPY\.groupSwitch/);
  assert.match(viewSource, /JOURNAL_PORT_COPY\.row18/);
});

test("the dashboard's activity foot now points at the journal, in legacy's words", () => {
  assert.equal(PANEL_FEET.activity.text, "View analytics");
  assert.equal(PANEL_FEET.activity.to, "/app/journal");
  assert.equal(PANEL_FEET.activity.note, null);
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  assert.ok(app.includes('path: "/app/journal"'), "the foot's destination is a declared route");
});

test("the served shell carries the screen, and the deep link answers", async (t) => {
  const app = await instance(t);
  const shell = path.resolve(CLIENT, "..", "..", "public", "app", "index.html");
  assert.ok(existsSync(shell), "the built SPA shell is required: npm run build:workforce-client");
  const html = await get(app.app, "/app/journal", { accept: "text/html" });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, "the shell must reference the built bundle");
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  for (const needle of [
    "Analytics",
    "Journal entries (latest 200)",
    "No entries yet — run a backtest or paper trade.",
    "Confidence calibration",
    "/app/journal",
  ]) {
    assert.ok(bundle.includes(needle), `the served bundle carries ${JSON.stringify(needle)}`);
  }
  // The screen offers no form for the module's write, so no wrapper for it exists to call.
  assert.ok(!/api\(\s*[`"]\/api\/v1\/journal\/manual/.test(bundle), "the bundle carries no manual-entry request");
});
