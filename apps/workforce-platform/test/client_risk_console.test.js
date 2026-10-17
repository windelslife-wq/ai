/**
 * The Risk Center console against the API it reads (row 11, Phase 38).
 *
 * `views/risk/index.php` → `Risk_center::index` is legacy's one page over this module:
 * the limits with veto power, the portfolio risk monitor, and the latest audit rows. The
 * port is `/app/risk`, and this suite holds it to the same three things the paper and
 * sports console suites hold theirs to:
 *
 *  1. **The copy is legacy's.** Every heading, note, form label, flash sentence and empty
 *     state in `client/src/risk.js` is asserted against `views/risk/index.php` and
 *     `controllers/Risk_center.php`, read with `readFileSync` — with the departures named
 *     as departures, because two of them are deliberate (the scan is a read here, and the
 *     form keeps the field legacy's controller silently dropped).
 *  2. **The numbers and the severities are the server's.** The form's bounds are the request
 *     contract's, the breach severity is the classification the operations cron publishes
 *     with, and the scan's codes are the ones `portfolioRiskScan` can emit — each asserted
 *     against the server module rather than trusted.
 *  3. **The wiring reaches the routes, and the guards are the server's.** Every declared read
 *     and write is checked against `/api/v1/system/routes`, the limits write is exercised
 *     over HTTP under `trading.control` (refused for a viewer, accepted and audited for an
 *     operator), and the scan is asserted to be a read that writes nothing.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp` with
 * `MARKET_DATA_REAL_PROVIDERS=0`, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CRITICAL_BREACH_CODES, LEGACY_ALERT_CODES, RISK_AUDIT_PERMISSION, RISK_CONTROL, RISK_COPY,
  RISK_FIELDS, RISK_LIMIT_BOUNDS, RISK_OTHER_LIMITS, RISK_PERMISSION, RISK_READS, RISK_SCAN_CODES,
  RISK_WINDOWS, RISK_WRITES, SUPER_ADMIN_PERMISSION, WARNING_BREACH_CODES,
  auditRows, auditTimeText, breachRows, breachSeverity, countText, governanceFacts, holdsRiskPermission,
  limitFormState, limitPatch, moneyText, otherLimitRows, percentText, scanAccountRows, scanStatusTone,
  scanSummary, severityTone, validateLimitForm,
} from "../client/src/risk.js";
import {
  CRITICAL_BREACH_CODES as SERVER_CRITICAL, WARNING_BREACH_CODES as SERVER_WARNING,
} from "../src/jobs/scheduled.js";
import { RISK_LIMITS_BODY } from "../src/modules/paper/contracts.js";
import { DEFAULT_RISK_LIMITS } from "../src/modules/analysis/risk-engine.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_VIEW = path.join(REPO, "application", "views", "risk", "index.php");
const LEGACY_CONTROLLER = path.join(REPO, "application", "controllers", "Risk_center.php");
const LEGACY_MONITOR = path.join(REPO, "application", "libraries", "Aegis", "Portfolio", "PortfolioRiskMonitor.php");

const view = () => readFileSync(LEGACY_VIEW, "utf8");
const controller = () => readFileSync(LEGACY_CONTROLLER, "utf8");
/** Legacy's prose with its inline markup removed, so a sentence split across tags compares whole. */
const plain = (text) => text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

/** Hermetic: the synthetic provider chain alone, as every console suite in this shell runs. */
const RISK_ENV = { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "1" };

async function instance(t) {
  const app = await createFileStoreApp({ configOverrides: { env: RISK_ENV } });
  t.after(() => app.cleanup());
  return app;
}

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken }, user: body.user, permissions: body.permissions };
}

const get = (app, url, headers) => app.inject({ method: "GET", url, headers });
const post = (app, url, headers, payload = {}) => app.inject({ method: "POST", url, headers, payload });

/** A signed-in role built the way the platform baseline builds `trading_viewer`. */
async function readOnlySession(app, store, username, phrase) {
  const role = await store.ensureRole("trading_viewer", "Trading viewer");
  for (const key of ["system.authenticated", RISK_PERMISSION]) {
    const permission = await store.ensurePermission(key, key);
    await store.grantRolePermission(role.id, permission.id);
  }
  const user = await store.createUser({
    username, email: `${username}@example.test`, passwordHash: await hashPassword(phrase), displayName: username,
  });
  await store.assignRole(user.id, role.id);
  return signIn(app, username, phrase);
}

/** Create an account with one open position, so a scan has something to measure. */
async function accountWithPosition(app, headers, name = "Risk simulator") {
  const created = await post(app, "/api/v1/paper/accounts", headers, { name, startingBalance: 10000 });
  assert.equal(created.statusCode, 201, created.body);
  const accountId = created.json().account.id;
  assert.equal((await post(app, "/api/v1/trading/kill-switch", headers, { active: false, reason: "risk console test" })).statusCode, 200);
  assert.equal((await post(app, "/api/v1/trading/mode", headers, { mode: "PAPER_TRADING" })).statusCode, 200);
  assert.equal((await post(app, "/api/v1/trading/synthetic-paper", headers, { allow: true })).statusCode, 200);
  // The stop and target clear the engine's own gates — 1% risk of equity with a ~2.5R
  // target — because a fixture the Risk Engine refuses would test the refusal, not the scan.
  const order = await post(app, `/api/v1/paper/accounts/${accountId}/orders`, headers, {
    symbol: "BTCUSDT", side: "BUY", type: "MARKET", stopLoss: 60000, takeProfit: 75000, riskPct: 0.01, reason: "risk console test",
  });
  assert.equal(order.statusCode, 201, order.body);
  return accountId;
}

/* ------------------------------------------------------------------ the page's words */

test("the headings, notes, labels and flashes are the legacy page's and controller's own words", () => {
  const page = plain(view());
  const source = plain(controller());
  for (const [key, value] of [
    ["title", RISK_COPY.title],
    ["lede", RISK_COPY.lede],
    ["limitsTitle", RISK_COPY.limitsTitle],
    ["updateLabel", RISK_COPY.updateLabel],
    ["limitsNote", RISK_COPY.limitsNote],
    ["monitorTitle", RISK_COPY.monitorTitle],
    ["scanLabel", RISK_COPY.scanLabel],
    ["monitorNote", RISK_COPY.monitorNote],
    ["noScan", RISK_COPY.noScan],
    ["lastScanPrefix", RISK_COPY.lastScanPrefix],
    ["noAlerts", RISK_COPY.noAlerts],
    ["alertsSeverity", RISK_COPY.alertsSeverity],
    ["alertsCode", RISK_COPY.alertsCode],
    ["alertsScope", RISK_COPY.alertsScope],
    ["alertsDetail", RISK_COPY.alertsDetail],
  ]) {
    assert.ok(page.includes(value), `${key} must be the legacy page's own string: ${JSON.stringify(value)}`);
  }
  for (const [key, value] of [
    ["updateNotice", RISK_COPY.updateNotice],
    ["noFieldsNotice", RISK_COPY.noFieldsNotice],
    ["scanClean", RISK_COPY.scanClean],
    ["scanFailedPrefix", RISK_COPY.scanFailedPrefix],
  ]) {
    assert.ok(source.includes(value), `${key} must be the controller's own flash sentence: ${JSON.stringify(value)}`);
  }
  // The audit table's caption and its "latest 25" shape come from the controller's own read.
  assert.ok(page.includes("Audit trail (latest)"));
  assert.match(source, /audit->recent\(60\), 0, 25\)/);
  assert.equal(RISK_WINDOWS.auditRows, 25, "the window is legacy's slice, not a number of the port's choosing");
});

test("the eleven form fields are legacy's, in legacy's order and with legacy's labels", () => {
  const page = view();
  const legacyFields = [...page.matchAll(/'(\w+)' => \['([^']+)', (\d+)\]/g)].map((match) => ({ key: match[1], label: match[2], scale: Number(match[3]) }));
  assert.equal(legacyFields.length, 11);
  assert.deepEqual(RISK_FIELDS.map((field) => field.key), legacyFields.map((field) => field.key));
  assert.deepEqual(RISK_FIELDS.map((field) => field.label), legacyFields.map((field) => field.label));
  assert.deepEqual(RISK_FIELDS.map((field) => field.scale), legacyFields.map((field) => field.scale));
  // And the grid was two columns, which is what the port renders.
  assert.match(page, /grid-template-columns:repeat\(2,1fr\)/);
});

test("the notional field legacy drew but could never save is named as a departure, not silently restored", () => {
  const source = controller();
  // `Risk_center::limits()` skipped the key by name, so the field on the page was decorative.
  assert.match(source, /if \(\$key === 'maxTradeNotional' \|\| \$key === 'maxPositionNotionalUsd'\) continue;/);
  assert.ok(RISK_FIELDS.some((field) => field.key === "maxPositionNotionalUsd"), "the port keeps the field");
  // The contract accepts it, which is what makes keeping it a fix rather than a decoration.
  assert.ok(RISK_LIMITS_BODY.properties.maxPositionNotionalUsd, "the request schema accepts the field legacy's controller dropped");
  assert.match(RISK_COPY.readOnlyNote, /legacy drew|notional field/);
});

test("the limits this form does not edit are stated with their true status", () => {
  const limited = RISK_OTHER_LIMITS.find((limit) => limit.key === "maxCorrelatedPositions");
  assert.match(limited.note, /F-30/, "the unenforced limit says so rather than looking enforced");
  const stop = RISK_OTHER_LIMITS.find((limit) => limit.key === "requireStopLoss");
  assert.match(stop.note, /cannot be turned off/, "the immutable limit says why it is not a checkbox");
  // The immutability is the server's, not this screen's claim.
  const service = readFileSync(path.resolve(import.meta.dirname, "..", "src", "modules", "paper", "service.js"), "utf8");
  assert.match(service, /limits\.requireStopLoss = true;/);
});

test("the boundary says what the scan is here, because it is not what it was in PHP", () => {
  assert.match(RISK_COPY.boundaryTitle, /does not do/);
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.ok(views.includes("The scan is a read here"), "the panel states that the read performs the scan");
  assert.match(views, /writes nothing/, "and that it writes nothing, unlike legacy's POST");
  assert.match(views, /scheduled operations job/);
});

/* -------------------------------------------------------- constants and contracts */

test("the console's permission constants are the platform's own keys", () => {
  assert.equal(RISK_PERMISSION, "trading.view");
  assert.equal(RISK_CONTROL, "trading.control");
  assert.equal(RISK_AUDIT_PERMISSION, "identity.users.view");
  assert.deepEqual(RISK_READS.map((read) => [read.method, read.path, read.permission]), [
    ["GET", "/api/v1/risk/limits", "trading.view"],
    ["GET", "/api/v1/trading/mode", "trading.view"],
    ["GET", "/api/v1/portfolio/risk-scan", "trading.view"],
    ["GET", "/api/v1/admin/audit", "identity.users.view"],
  ]);
  assert.deepEqual(RISK_WRITES.map((write) => [write.method, write.path, write.permission]), [
    ["POST", "/api/v1/risk/limits/update", "trading.control"],
  ]);
});

test("the super-admin shortcut is mirrored, not forgotten", () => {
  assert.equal(holdsRiskPermission([RISK_PERMISSION], RISK_CONTROL), false);
  assert.equal(holdsRiskPermission([RISK_PERMISSION, RISK_CONTROL], RISK_CONTROL), true);
  assert.equal(holdsRiskPermission([SUPER_ADMIN_PERMISSION], RISK_CONTROL), true);
  assert.equal(holdsRiskPermission([], RISK_PERMISSION), false);
  assert.equal(holdsRiskPermission(undefined, null), true);
});

test("the form's bounds are the request contract's, key for key and bound for bound", () => {
  const contract = Object.fromEntries(Object.entries(RISK_LIMITS_BODY.properties).map(([key, rule]) => [key, { min: rule.min, max: rule.max }]));
  const formKeys = RISK_FIELDS.map((field) => field.key).sort();
  const formBounds = Object.fromEntries(Object.entries(RISK_LIMIT_BOUNDS).sort(([left], [right]) => left.localeCompare(right)));
  assert.deepEqual(Object.keys(formBounds), formKeys, "the form bounds cover exactly the form's fields");
  assert.deepEqual(formBounds, Object.fromEntries(formKeys.map((key) => [key, contract[key]])), "a form that accepted what the schema refuses would be a 400 waiting to happen");
  // The contract's other keys are the panel's read-only rows and the two governance flags —
  // named here so a new contract field cannot be silently unsurfaced.
  const unsurfaced = Object.keys(contract).filter((key) => !formKeys.includes(key)).sort();
  assert.deepEqual(unsurfaced, ["blockStaleData", "blockSyntheticData", "maxCorrelatedPositions", "minDataQuality"]);
  // `requireStopLoss` is not in the contract at all — it is forced true by the service, so a
  // request cannot carry it — and it is still rendered, as an immutable row.
  assert.ok(!("requireStopLoss" in contract), "the stop requirement is not settable through the API");
  assert.deepEqual([...RISK_OTHER_LIMITS].map((limit) => limit.key).sort(), [...unsurfaced, "requireStopLoss"].sort(), "every limit the form omits is rendered somewhere on the screen");
  // And the defaults on a fresh host are inside them, which is what makes an untouched form valid.
  for (const field of RISK_FIELDS) {
    const value = DEFAULT_RISK_LIMITS[field.key];
    assert.ok(value >= RISK_LIMIT_BOUNDS[field.key].min && value <= RISK_LIMIT_BOUNDS[field.key].max, `${field.key} default is inside its bound`);
  }
});

test("the breach severities are the operations cron's classification, not a second opinion", () => {
  assert.deepEqual([...CRITICAL_BREACH_CODES].sort(), [...SERVER_CRITICAL].sort());
  assert.deepEqual([...WARNING_BREACH_CODES].sort(), [...SERVER_WARNING].sort());
  for (const code of LEGACY_ALERT_CODES) assert.ok(!RISK_SCAN_CODES.includes(code), `${code} is legacy's vocabulary, not this scan's`);
  // Every code the scan can emit is classified by the cron, which the test above pins to the
  // console's own maps — so an unclassified code cannot arrive here as a silent "warning".
  const service = readFileSync(path.resolve(import.meta.dirname, "..", "src", "modules", "paper", "service.js"), "utf8");
  const scanBody = service.slice(service.indexOf("async function portfolioRiskScan"), service.indexOf("function statusSnapshot"));
  assert.ok(scanBody.length > 500, "the scan function is what was read");
  const emitted = new Set([...scanBody.matchAll(/code: "([A-Z_]+)"/g)].map((match) => match[1]));
  for (const code of emitted) assert.ok(RISK_SCAN_CODES.includes(code), `${code} is emitted by the service and must be classified`);
  for (const code of RISK_SCAN_CODES) {
    assert.ok(SERVER_CRITICAL.has(code) || SERVER_WARNING.has(code), `${code} has a cron classification`);
    assert.equal(breachSeverity(code), SERVER_CRITICAL.has(code) ? "critical" : "warning", `${code}'s badge matches what the cron would publish`);
  }
});

test("every declared read and write is a registered route with the permission the server enforces", async (t) => {
  const app = await instance(t);
  const inventory = (await get(app.app, "/api/v1/system/routes")).json().routes;
  for (const entry of [...RISK_READS, ...RISK_WRITES]) {
    const route = inventory.filter((candidate) => candidate.method === entry.method && candidate.path === entry.path).at(-1);
    assert.ok(route, `${entry.method} ${entry.path} must be registered`);
    assert.equal(route.permission, entry.permission, `${entry.path} is declared with the wrong permission`);
    assert.equal(route.auth, true, `${entry.path} requires a session`);
  }
  // There is no scan POST in this module: the scan is the GET, and a write route would have
  // been the easy way to imply the audit trail legacy's POST produced.
  assert.ok(!inventory.some((route) => route.method === "POST" && route.path.includes("risk-scan")), "the port has no scan POST");
});

/* ---------------------------------------------------------------------- the shaping */

test("the form starts on the persisted values, scaled the way legacy scaled them", () => {
  const form = limitFormState({ riskPerTradePct: 0.01, maxRiskPerTradePct: 0.02, minRiskReward: 1.5, maxPositionNotionalUsd: 50000, maxLeverage: 5, maxOpenPositions: 10, maxDailyLossPct: 0.03, maxWeeklyLossPct: 0.06, maxDrawdownPct: 0.1, maxSymbolExposurePct: 0.05, maxPortfolioExposurePct: 0.15 });
  assert.equal(form.riskPerTradePct, "1", "a fraction renders as a percent field");
  assert.equal(form.maxDrawdownPct, "10");
  assert.equal(form.minRiskReward, "1.5", "scale 1 is not a percent");
  assert.equal(form.maxPositionNotionalUsd, "50000");
  assert.deepEqual(limitFormState(null), Object.fromEntries(RISK_FIELDS.map((field) => [field.key, ""])), "an unread host is an empty form, not a zeroed one");
});

test("the form refuses what the schema would refuse, in the field's own units", () => {
  const valid = limitFormState(DEFAULT_RISK_LIMITS);
  assert.equal(validateLimitForm(valid, { bounds: RISK_LIMIT_BOUNDS }).ok, true, JSON.stringify(validateLimitForm(valid, { bounds: RISK_LIMIT_BOUNDS }).errors));
  const zero = { ...valid, riskPerTradePct: "0" };
  assert.match(validateLimitForm(zero, { bounds: RISK_LIMIT_BOUNDS }).errors.riskPerTradePct, /must be between 0\.01 and 5/, "the percent field names its bound in percent");
  const wide = { ...valid, maxDrawdownPct: "150" };
  assert.match(validateLimitForm(wide, { bounds: RISK_LIMIT_BOUNDS }).errors.maxDrawdownPct, /must be between 0 and 100/);
  const fractional = { ...valid, maxOpenPositions: "3.5" };
  assert.match(validateLimitForm(fractional).errors.maxOpenPositions, /whole number/);
  const blank = { ...valid, minRiskReward: "" };
  assert.match(validateLimitForm(blank).errors.minRiskReward, /needs a value/);
  const word = { ...valid, maxLeverage: "five" };
  assert.match(validateLimitForm(word).errors.maxLeverage, /must be a number/);
});

test("the patch carries only what changed, converted back to fractions", () => {
  const form = limitFormState(DEFAULT_RISK_LIMITS);
  assert.deepEqual(limitPatch(form, DEFAULT_RISK_LIMITS), {}, "an untouched form sends nothing");
  const changed = { ...form, riskPerTradePct: "1.5", maxOpenPositions: "12" };
  assert.deepEqual(limitPatch(changed, DEFAULT_RISK_LIMITS), { riskPerTradePct: 0.015, maxOpenPositions: 12 });
  // A percent field and a scale-1 field convert differently, which is the whole reason the
  // scale is data rather than a hard-coded list inside the save handler.
  assert.deepEqual(limitPatch({ ...form, minRiskReward: "2.5" }, DEFAULT_RISK_LIMITS), { minRiskReward: 2.5 });
});

test("the limits the form does not edit render by kind, never by guess", () => {
  const rows = otherLimitRows({ maxCorrelatedPositions: 3, minDataQuality: 0.5, blockSyntheticData: true, blockStaleData: false, requireStopLoss: true });
  assert.deepEqual(rows.map((row) => row.value), ["3", "50.00%", "yes", "no", "yes"]);
  assert.deepEqual(otherLimitRows(null).map((row) => row.value), ["—", "—", "—", "—", "—"], "an unread host is an em dash, not a false");
  // A real `false` renders "no", which is different from absent — the distinction the dash exists for.
  assert.equal(otherLimitRows({ blockSyntheticData: false }).find((row) => row.key === "blockSyntheticData").value, "no");
});

test("the breaches are one row each, ordered as legacy ordered its alerts", () => {
  const scan = {
    accounts: [
      { accountId: 2, accountName: "Second", status: "BREACH", breaches: [{ code: "VALUATION_UNAVAILABLE", message: "no mark" }] },
      { accountId: 1, accountName: "First", status: "BREACH", breaches: [{ code: "DAILY_LOSS_LIMIT", message: "Daily loss limit exceeded" }, { code: "SYMBOL_EXPOSURE_LIMIT", symbol: "BTCUSDT", message: "open risk in BTCUSDT" }] },
      { accountId: 3, accountName: "Clean", status: "HEALTHY", breaches: [] },
    ],
  };
  const rows = breachRows(scan);
  assert.deepEqual(rows.map((row) => `${row.severity}:${row.code}`), ["critical:DAILY_LOSS_LIMIT", "critical:SYMBOL_EXPOSURE_LIMIT", "warning:VALUATION_UNAVAILABLE"]);
  assert.equal(rows[0].scope, "paper:1", "legacy's own scope string");
  assert.equal(rows[0].accountName, "First", "and the name beside it, because an id is not an identity");
  assert.equal(rows[1].tone, "badge-red");
  assert.equal(rows[2].tone, "badge-amber");
  assert.equal(rows[1].key, "1:SYMBOL_EXPOSURE_LIMIT:BTCUSDT", "the symbol is part of the key: two symbols can breach the same limit");
  assert.deepEqual(breachRows(null), []);
});

test("the scan summary states its totals, and its clean sentence is the controller's", () => {
  const clean = scanSummary({ generatedAt: "2026-10-16T23:00:00.000Z", accounts: [{ accountId: 1, accountName: "A", status: "HEALTHY", equity: 10000, openPositions: 0, breaches: [] }], totals: { accounts: 1, breachedAccounts: 0, equity: 10000, openPositions: 0 } });
  assert.equal(clean.clean, true);
  assert.equal(clean.message, RISK_COPY.scanClean);
  assert.equal(clean.equity, "10,000.00");
  const breached = scanSummary({ accounts: [{ accountId: 1, accountName: "A", status: "BREACH", equity: 9000, openPositions: 2, breaches: [{ code: "DAILY_LOSS_LIMIT", message: "x" }, { code: "DRAWDOWN_LIMIT", message: "y" }] }], totals: { accounts: 1, breachedAccounts: 1, equity: 9000, openPositions: 2 } });
  assert.equal(breached.message, "Portfolio scan: 2 active breach(es) — see the monitor panel.");
  assert.equal(scanSummary(null), null);
});

test("an account's status and valuation gap are rendered as the scan reported them", () => {
  const rows = scanAccountRows({ accounts: [
    { accountId: 1, accountName: "A", status: "HEALTHY", equity: 10000, openPositions: 0, breaches: [] },
    { accountId: 2, status: "BREACH", equity: null, openPositions: 1, breaches: [{ code: "VALUATION_UNAVAILABLE", message: "x" }], valuationAvailable: false },
  ] });
  assert.equal(rows[0].tone, "badge-green");
  assert.equal(rows[0].equity, "10,000.00");
  assert.equal(rows[1].name, "#2", "no name renders the id, not a blank cell");
  assert.equal(rows[1].equity, "—", "an unvalued account shows the gap, not a zero");
  assert.equal(rows[1].valuationAvailable, false);
  assert.equal(scanStatusTone("BREACH"), "badge-red");
  assert.equal(scanStatusTone("HEALTHY"), "badge-green");
  assert.equal(scanStatusTone(undefined), "badge-green", "an unknown status is not painted as a breach");
});

test("the audit trail is legacy's four columns, from the port's own event shape", () => {
  const rows = auditRows({
    events: [
      { id: 7, action: "governance.risk-limits.updated", entityType: "paper_trading", details: { summary: "Paper risk limits updated" }, createdAt: "2026-10-16T23:04:05.000Z", actor: { userId: 1, username: "root", kind: "user" } },
      { id: 8, action: "system.job.run", entityType: "job", entityId: "operations", details: {}, createdAt: "2026-10-16 23:05:00", actor: { userId: null, username: null, kind: "system" } },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.at, row.type, row.summary, row.actor]), [
    ["10-16 23:04:05", "governance.risk-limits.updated", "Paper risk limits updated", "root"],
    ["10-16 23:05:00", "system.job.run", "job #operations", "system"],
  ]);
  assert.equal(auditTimeText(null), "—");
  assert.deepEqual(auditRows(null), []);
});

test("the governance strip reads the mode and switch rather than assuming either", () => {
  assert.deepEqual(governanceFacts({ tradingMode: "ANALYSIS_ONLY", killSwitch: { active: true }, allowSyntheticPaperData: false }), {
    mode: "ANALYSIS_ONLY", killSwitch: true, synthetic: false, simulated: true,
  });
  assert.equal(governanceFacts({ tradingMode: "PAPER_TRADING", killSwitch: {} }).killSwitch, false, "an absent switch field is not an engaged switch");
  assert.equal(governanceFacts(null), null);
  assert.equal(governanceFacts({}).mode, "UNKNOWN", "a state with no mode says so rather than guessing");
});

test("the formatting helpers never invent a figure", () => {
  assert.equal(moneyText(0), "0.00");
  assert.equal(moneyText("1234.5"), "1,234.50");
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText("abc"), "—");
  assert.equal(percentText(0), "0.00%");
  assert.equal(percentText(0.0125), "1.25%");
  assert.equal(percentText(null), "—");
  assert.equal(countText(0), "0");
  assert.equal(countText(undefined), "—");
  assert.equal(severityTone("critical"), "badge-red");
  assert.equal(severityTone("warning"), "badge-amber");
});

/* ------------------------------------------------------------------------ the wiring */

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/risk", view: "risk-center", requiresAuth: true, permission: "trading\.view"/);
  assert.match(app, /"risk-center": <RiskCenterView permissions=\{permissions\} \/>/);
  assert.match(views, /export function RiskCenterView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/risk", label: "Risk Center", permission: RISK_PERMISSION \}/);
  assert.match(views, /<h1>\{RISK_COPY\.title\}\.<\/h1>/);
  // The three governance writes are not on this screen — the strip names where they live.
  for (const path_ of ["/api/v1/trading/mode", "/api/v1/trading/kill-switch", "/api/v1/trading/synthetic-paper"]) {
    assert.ok(!views.includes(`api("${path_}"`), `${path_} is governed elsewhere`);
  }
  assert.match(views, /to="\/app\/analysis"/);
  // Every read and the one write are wrappers, and the console uses them.
  for (const name of ["riskLimits", "updateRiskLimits", "portfolioRiskScan", "tradingMode", "adminAudit"]) {
    assert.match(api, new RegExp(`\\n  ${name}:`), `${name} is a declared endpoint`);
    assert.ok(views.includes(`endpoints.${name}(`), `${name} is used by the console`);
  }
  assert.match(views, /const canControl = holdsRiskPermission\(permissions, RISK_CONTROL\);/);
  assert.match(views, /disabled=\{!canControl \|\| busy\}/);
});

test("the screen carries the legacy form's eleven inputs and refuses the save without the permission", async (t) => {
  const app = await instance(t);
  const viewer = await readOnlySession(app.app, app.store, "riskviewer", "Risk viewer phrase");
  // A viewer reads all three `trading.view` surfaces …
  for (const read of RISK_READS.filter((entry) => entry.permission === RISK_PERMISSION)) {
    const response = await get(app.app, read.path, viewer.headers);
    assert.equal(response.statusCode, 200, `${read.key}: ${response.body}`);
  }
  // … and the audit trail is the one read the port gates — AV-1, checked as a refusal.
  const audit = await get(app.app, "/api/v1/admin/audit", viewer.headers);
  assert.equal(audit.statusCode, 403, audit.body);
  assert.equal(audit.json().error.code, "PERMISSION_DENIED");
  // The limits write is `trading.control`, so the viewer's save is refused with the API's code.
  const refused = await post(app.app, "/api/v1/risk/limits/update", viewer.headers, { maxLeverage: 2 });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().error.code, "PERMISSION_DENIED");
  // And the form the viewer sees is the persisted one, not an empty one.
  const form = limitFormState((await get(app.app, "/api/v1/risk/limits", viewer.headers)).json().limits);
  assert.equal(form.riskPerTradePct, "1");
});

test("a save writes the persisted limits and audits exactly the fields it changed", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const before = (await get(app.app, "/api/v1/risk/limits", root.headers)).json();
  assert.equal(before.updatedAt, null, "a fresh host has no saved limits");

  const form = { ...limitFormState(before.limits), riskPerTradePct: "1.5" };
  const patch = limitPatch(form, before.limits);
  assert.deepEqual(patch, { riskPerTradePct: 0.015 });
  const saved = await post(app.app, "/api/v1/risk/limits/update", root.headers, patch);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().limits.riskPerTradePct, 0.015);
  assert.ok(saved.json().updatedAt);

  // The persisted row is what the Risk Engine will read, not a copy on the screen.
  const after = (await get(app.app, "/api/v1/risk/limits", root.headers)).json();
  assert.equal(after.limits.riskPerTradePct, 0.015);
  assert.ok(after.updatedAt);
  // Every other limit is untouched — the patch only carried the changed key.
  for (const field of RISK_FIELDS.filter((entry) => entry.key !== "riskPerTradePct")) {
    assert.equal(after.limits[field.key], before.limits[field.key], `${field.key} was not in the patch and did not change`);
  }

  // The audit row says which fields changed, which is the point of sending only a patch.
  const trail = await get(app.app, "/api/v1/admin/audit?action=governance.risk-limits.updated&limit=5", root.headers);
  assert.equal(trail.statusCode, 200, trail.body);
  const row = auditRows(trail.json())[0];
  assert.equal(row.type, "governance.risk-limits.updated");
  assert.equal(row.summary, "Paper risk limits updated");
  assert.equal(row.actor, "rootadmin");
  const details = trail.json().events[0].details;
  assert.deepEqual(details.changed, ["riskPerTradePct"]);

  // And the bounds are the contract's: a value outside one is the schema's 400, not a save.
  const outOfBounds = await post(app.app, "/api/v1/risk/limits/update", root.headers, { maxDrawdownPct: 1.5 });
  assert.equal(outOfBounds.statusCode, 400, outOfBounds.body);
  // `requireStopLoss` is immutable: the service forces it true whatever arrives.
  assert.equal((await get(app.app, "/api/v1/risk/limits", root.headers)).json().limits.requireStopLoss, true);
});

test("the scan reads the same state the limits do, and writes nothing", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);

  const empty = await get(app.app, `/api/v1/portfolio/risk-scan?limit=${RISK_WINDOWS.scanAccounts}`, root.headers);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(scanSummary(empty.json()).accountRows, [], "no accounts is an empty scan, not an error");
  assert.equal(scanSummary(empty.json()).clean, true);
  assert.equal(empty.json().limits.maxLeverage, (await get(app.app, "/api/v1/risk/limits", root.headers)).json().limits.maxLeverage, "the scan reports the persisted limits");

  // The fixture writes audit rows of its own (the switch, the mode, the synthetic flag and the
  // order), so the baseline is taken after it — what the scan adds is the question.
  await accountWithPosition(app.app, root.headers);
  const auditBefore = (await get(app.app, "/api/v1/admin/audit?limit=200", root.headers)).json().meta.total;
  const scan = await get(app.app, `/api/v1/portfolio/risk-scan?limit=${RISK_WINDOWS.scanAccounts}`, root.headers);
  assert.equal(scan.statusCode, 200, scan.body);
  const summary = scanSummary(scan.json());
  assert.equal(summary.accountRows.length, 1);
  assert.equal(summary.accountRows[0].status, "HEALTHY", "one 2%-risk position against a 15% portfolio cap is inside every limit");
  assert.equal(summary.clean, true);

  // The scan wrote nothing: the audit count is exactly what it was, and there is no
  // `portfolio.risk.*` row from a read.
  const auditAfter = (await get(app.app, "/api/v1/admin/audit?limit=200", root.headers)).json();
  assert.equal(auditAfter.meta.total, auditBefore, "the scan is a read: it leaves no audit row");
  assert.ok(!auditAfter.events.some((event) => String(event.action).startsWith("portfolio.risk.")), "no transition row came from the read");
});

test("a breach is the scan's own finding, and the console renders its severity from the cron's rule", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const accountId = await accountWithPosition(app.app, root.headers, "Breach simulator");
  // Tighten the symbol exposure cap below what is already open: the next scan must find it.
  const tightened = await post(app.app, "/api/v1/risk/limits/update", root.headers, { maxSymbolExposurePct: 0.001 });
  assert.equal(tightened.statusCode, 200, tightened.body);
  const scan = await get(app.app, "/api/v1/portfolio/risk-scan", root.headers);
  assert.equal(scan.statusCode, 200, scan.body);
  const summary = scanSummary(scan.json());
  assert.equal(summary.clean, false);
  const row = summary.breachRows.find((entry) => entry.code === "SYMBOL_EXPOSURE_LIMIT");
  assert.ok(row, `the tightened cap must breach: ${JSON.stringify(summary.breachRows)}`);
  assert.equal(row.severity, "critical", "an exposure breach is capital outside a limit, not a measurement gap");
  assert.equal(row.tone, "badge-red");
  assert.equal(row.scope, `paper:${accountId}`);
  assert.match(row.detail, /exceeds the symbol exposure limit/);
  assert.equal(summary.accountRows[0].status, "BREACH");
  assert.equal(summary.accountRows[0].tone, "badge-red");
  // The message is legacy's shape with the unit the API actually counts.
  assert.equal(summary.message, `Portfolio scan: ${summary.breachRows.length} active breach(es) — see the monitor panel.`);
});

test("the served shell carries the screen, and the deep link answers", async (t) => {
  const app = await instance(t);
  const shell = path.resolve(CLIENT, "..", "..", "public", "app", "index.html");
  assert.ok(existsSync(shell), "the built SPA shell is required: npm run build:client");
  const html = await app.app.inject({ method: "GET", url: "/app/risk", headers: { accept: "text/html" } });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, "the shell must reference the built bundle");
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  for (const needle of ["Risk Center", "Portfolio Risk Monitor", "Update risk limits", "/app/risk"]) {
    assert.ok(bundle.includes(needle), `the served bundle carries ${JSON.stringify(needle)}`);
  }
});
