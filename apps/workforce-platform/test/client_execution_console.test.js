/**
 * The Execution Center console against the API it reads (row 2, Phase 39).
 *
 * `views/execution/index.php` → `Execution::index` is legacy's one page over
 * `Aegis\ExecutionSupervisor`: propose, decide/route, broker executions, and the automation
 * envelope that governs the two automated modes. The port is `/app/execution`, and this
 * suite holds it to the same three things the paper, sports and risk suites hold theirs to:
 *
 *  1. **The copy is legacy's.** Every heading, note, label, empty state and flash sentence in
 *     `client/src/execution.js` is asserted against `views/execution/index.php` and
 *     `controllers/Execution.php`, read with `readFileSync` — with the departures named as
 *     departures: the account selector, the missing volume field, the written decision
 *     reason, and the paper submission that replaces legacy's broker route.
 *  2. **The scope is the server's.** The fifteen pipeline steps are parsed from the
 *     supervisor's own docblock, the status enum from `PROPOSALS_QUERY`, the market classes
 *     from `MARKET_CLASSES`, and `automationLimits()`'s defaults from the PHP literal. The
 *     screen's claim that no connector can route is `GET /execution/status`'s own answer.
 *  3. **The wiring reaches the routes, and the guards are the server's.** Every declared read
 *     and write is checked against `/api/v1/system/routes`; the three writes are exercised
 *     over HTTP (refused for a viewer, accepted and audited for their permissions); and the
 *     routes the port does *not* register — `/route`, `/execute`, the automation envelope —
 *     are asserted absent, because their presence would make the screen's boundary a lie.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp` with
 * `MARKET_DATA_REAL_PROVIDERS=0`, no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  EXECUTION_CONTROL, EXECUTION_COPY, EXECUTION_EXECUTE, EXECUTION_MARKET_CLASSES, EXECUTION_PERMISSION,
  EXECUTION_PIPELINE, EXECUTION_PORT_COPY, EXECUTION_READS, EXECUTION_WINDOWS, EXECUTION_WRITES,
  LEGACY_AUTOMATION_LIMITS, LEGACY_MARKET_CLASSES, LEGACY_PROPOSAL_STATUSES, LEGACY_WRITES_NOT_PORTED,
  ORDER_SIDES, ORDER_TYPES, PIPELINE_STAGES, PORT_CHECKS, PORT_PROPOSAL_STATUSES, SUPER_ADMIN_PERMISSION,
  automationRows, banners, buildDecisionBody, buildProposalBody, countText, decisionOutcome,
  executionStatusFacts, executionTimeText, governanceFacts, holdsExecutionPermission, moneyText,
  paperSubmitOutcome, passedChecks, percentText, proposalFormState, proposalOutcome, proposalRow, proposalRows,
  statusTone, validateDecision, validateProposalForm,
} from "../client/src/execution.js";
import { PROPOSALS_QUERY, PROPOSAL_BODY } from "../src/modules/execution/contracts.js";
import { TRADING_MODE_BODY } from "../src/modules/paper/contracts.js";
import { MARKET_CLASSES } from "../src/modules/market-data/timeframes.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const LEGACY_VIEW = path.join(REPO, "application", "views", "execution", "index.php");
const LEGACY_CONTROLLER = path.join(REPO, "application", "controllers", "Execution.php");
const LEGACY_SUPERVISOR = path.join(REPO, "application", "libraries", "Aegis", "ExecutionSupervisor.php");

const view = () => readFileSync(LEGACY_VIEW, "utf8");
const controller = () => readFileSync(LEGACY_CONTROLLER, "utf8");
const supervisor = () => readFileSync(LEGACY_SUPERVISOR, "utf8");
/** Legacy's prose with its inline markup and entities resolved, so a sentence compares whole. */
const plain = (text) => text
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, " ");

/** Hermetic: the synthetic provider chain alone, as every console suite in this shell runs. */
const EXECUTION_ENV = { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "1" };

async function instance(t) {
  const app = await createFileStoreApp({ configOverrides: { env: EXECUTION_ENV } });
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

/** A fresh role carrying exactly the permissions named, signed in. */
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

/** Created by the owner, so the owner can read and submit it; `executive` holds both trade permissions. */
const executiveSession = (app, store) => roleSession(app, store, {
  username: "executive", phrase: "Executive operator phrase", permissions: [EXECUTION_PERMISSION, EXECUTION_EXECUTE],
});

/** The governance state a proposal needs to pass steps 1–2. */
async function openGovernance(app, headers) {
  assert.equal((await post(app, "/api/v1/trading/kill-switch", headers, { active: false, reason: "execution console test" })).statusCode, 200);
  assert.equal((await post(app, "/api/v1/trading/mode", headers, { mode: "PAPER_TRADING" })).statusCode, 200);
  assert.equal((await post(app, "/api/v1/trading/synthetic-paper", headers, { allow: true })).statusCode, 200);
}

/**
 * An intent the paper engine accepts at submission time. `stopLoss`/`takeProfit` are the
 * values `test/execution_http.test.js` uses for the same purpose: the proposal route does
 * not price the order, and the paper submit only needs a shape the engine can measure.
 */
const INTENT = Object.freeze({
  symbol: "EURUSD", marketClass: "forex", side: "BUY", type: "MARKET",
  stopLoss: 0.5, takeProfit: 2.5, reason: "Execution console test fixture",
});

async function accountAndProposal(app, headers, name = "Execution console account") {
  const created = await post(app, "/api/v1/paper/accounts", headers, { name, startingBalance: 10_000 });
  assert.equal(created.statusCode, 201, created.body);
  const accountId = created.json().account.id;
  const proposed = await post(app, "/api/v1/execution/proposals", headers, { accountId, ...INTENT });
  assert.equal(proposed.statusCode, 201, proposed.body);
  return { accountId, proposal: proposed.json() };
}

/* ------------------------------------------------------------------ the page's words */

test("the headings, notes, labels and flashes are the legacy page's and controller's own words", () => {
  const page = plain(view());
  // `eyebrow` is this shell's own label for the row, not a legacy string; every other entry
  // in the copy object is the PHP's.
  for (const [key, value] of Object.entries(EXECUTION_COPY).filter(([key]) => key !== "eyebrow")) {
    assert.ok(page.includes(value), `${key} must be the legacy page's own string: ${JSON.stringify(value)}`);
  }
  const source = controller();
  for (const sentence of [
    "'Proposal failed: '",
    "'Automation limits updated.'",
    "EXECUTED — broker order created",
    "APPROVED — route it to place the order",
  ]) {
    assert.ok(source.includes(sentence), `${sentence} is the controller's own sentence`);
  }
  assert.match(source, /REJECTED at step \{\$last\['step'\]\} \(\{\$last\['check'\]\}\): \{\$result\['reason'\]\}/);
  // The flash this port keeps: a rejection is still the pipeline's own words, step included.
  assert.equal(
    proposalOutcome({ id: "prp", status: "REJECTED", checks: [{ step: 1, check: "kill-switch", ok: false, detail: "kill switch is active" }] }).message,
    "REJECTED at step 1 (kill-switch): kill switch is active",
  );
});

test("the port's own sentences are its own, and never borrow a legacy claim it cannot honour", () => {
  for (const [key, value] of Object.entries(EXECUTION_PORT_COPY)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0, `${key} must say something`);
  }
  // Legacy's approval flash tells the operator to route the proposal. This port has no
  // broker route, so the same sentence would be a lie; `decisionOutcome` says what the next
  // step actually is instead.
  const flash = decisionOutcome({ status: "APPROVED" }, true).message;
  assert.ok(!flash.includes("route it to place the order"), "the port must not promise a broker route it does not have");
  assert.match(flash, /paper submission/i);
  // And the paper outcome cannot borrow legacy's "broker order created".
  const outcome = paperSubmitOutcome({ proposal: { id: "p", status: "PAPER_EXECUTED" }, paper: { filled: true, order: { id: 7 } } });
  assert.match(outcome.message, /paper order #7 filled/);
  assert.ok(!/broker/i.test(outcome.message), "a paper fill is not a broker fill");
});

/* ---------------------------------------------------------------------- the pipeline */

test("the fifteen steps are the supervisor's own, in its own order", () => {
  const text = supervisor();
  const start = text.indexOf("1 kill switch");
  const end = text.indexOf("portfolio update") + "portfolio update".length;
  assert.ok(start > 0 && end > start, "the supervisor's pipeline docblock is where this test expects it");
  const legacy = text.slice(start, end)
    .split("→")
    .map((piece) => piece.replace(/\*/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((piece) => {
      const match = piece.match(/^(\d+)\s+(.+)$/);
      return match ? { step: Number(match[1]), label: match[2].trim() } : null;
    })
    .filter(Boolean);
  assert.equal(legacy.length, 15, JSON.stringify(legacy));
  assert.deepEqual(
    EXECUTION_PIPELINE.map((step) => ({ step: step.step, label: step.label })),
    legacy,
    "the screen's pipeline is the supervisor's pipeline, not a paraphrase",
  );
  assert.equal(PIPELINE_STAGES.port.tone, "badge-green");
  assert.equal(PIPELINE_STAGES.broker.tone, "badge-gray");
  assert.equal(PIPELINE_STAGES.decision.tone, "badge-amber");
});

test("the port marks exactly the steps it performs, and says the rest are broker-bound", () => {
  const service = readFileSync(path.join(import.meta.dirname, "..", "src", "modules", "execution", "service.js"), "utf8");
  const emitted = [...new Set([...service.matchAll(/addCheck\("([a-z-]+)"/g)].map((match) => match[1]))];
  assert.deepEqual(emitted, [...PORT_CHECKS], "the checks a proposal carries are the module's own addCheck calls");
  const port = EXECUTION_PIPELINE.filter((step) => step.stage === "port").map((step) => step.key);
  assert.deepEqual(port, ["kill-switch", "trading-mode", "strategy", "audit-log"]);
  const broker = EXECUTION_PIPELINE.filter((step) => step.stage === "broker").map((step) => step.step);
  assert.deepEqual(broker, [4, 5, 6, 7, 8, 9, 10, 12, 13, 15], "the broker-bound steps are the ones with no route in this port");
  assert.deepEqual(EXECUTION_PIPELINE.filter((step) => step.stage === "decision").map((step) => step.step), [11]);
});

/* -------------------------------------------------------------------- the vocabulary */

test("the statuses are the two vocabularies the two platforms actually persist", () => {
  assert.deepEqual([...PORT_PROPOSAL_STATUSES].sort(), [...PROPOSALS_QUERY.status.values].sort(), "the port's list is the request contract's enum");
  const php = view();
  const toneBlock = php.slice(php.indexOf("$tone = ["), php.indexOf("$tone = [") + 400);
  const legacy = [...toneBlock.matchAll(/'([A-Z_]+)' => 'b-/g)].map((match) => match[1]);
  assert.deepEqual(legacy, [...LEGACY_PROPOSAL_STATUSES], "legacy's vocabulary is the tone map's own keys, in its own order");
  for (const gone of ["READY_TO_ROUTE", "EXECUTED", "FAILED"]) {
    assert.ok(!PORT_PROPOSAL_STATUSES.includes(gone), `${gone} has no route to reach it in this port`);
  }
  for (const added of ["DECLINED", "EXPIRED", "PAPER_EXECUTED"]) {
    assert.ok(!LEGACY_PROPOSAL_STATUSES.includes(added), `${added} is this port's word and must be stated as such`);
  }
  // Legacy's badge choices survive for the statuses both platforms share.
  for (const [status, tone] of [["PENDING_APPROVAL", "badge-amber"], ["APPROVED", "badge-sky"], ["EXECUTED", "badge-green"], ["REJECTED", "badge-red"], ["FAILED", "badge-red"], ["READY_TO_ROUTE", "badge-sky"]]) {
    assert.equal(statusTone(status), tone, `${status} keeps legacy's tone`);
  }
  assert.equal(statusTone("SOMETHING_ELSE"), "badge-gray", "an unknown status is neutral, not green");
  assert.equal(statusTone("PAPER_EXECUTED"), "badge-green");
  assert.equal(statusTone("EXPIRED"), "badge-gray");
});

test("the market classes are the contract's, and legacy's three singular spellings are a named departure", () => {
  assert.deepEqual([...EXECUTION_MARKET_CLASSES], [...MARKET_CLASSES], "the form offers exactly what PROPOSAL_BODY accepts");
  const onlyLegacy = LEGACY_MARKET_CLASSES.filter((entry) => !EXECUTION_MARKET_CLASSES.includes(entry));
  assert.deepEqual(onlyLegacy, ["future", "index", "bond"], "legacy's spellings the port's contract rejects are named");
  assert.deepEqual(EXECUTION_MARKET_CLASSES.filter((entry) => !LEGACY_MARKET_CLASSES.includes(entry)), ["futures", "options", "indices", "bonds"]);
  assert.deepEqual([...ORDER_SIDES], ["BUY", "SELL"]);
  assert.deepEqual([...ORDER_TYPES], ["MARKET", "LIMIT"]);
});

/* --------------------------------------------------------------------- the permissions */

test("the console's permission constants are the platform's own keys", () => {
  assert.equal(EXECUTION_PERMISSION, "trading.view");
  assert.equal(EXECUTION_EXECUTE, "trading.execute");
  assert.equal(EXECUTION_CONTROL, "trading.control");
  assert.equal(holdsExecutionPermission(["trading.view"], EXECUTION_PERMISSION), true);
  assert.equal(holdsExecutionPermission(["trading.view"], EXECUTION_CONTROL), false);
  assert.equal(holdsExecutionPermission([SUPER_ADMIN_PERMISSION], EXECUTION_CONTROL), true, "the super-admin shortcut is mirrored, not forgotten");
  assert.equal(holdsExecutionPermission([], null), true, "a session-only surface is open to any signed-in session");
});

/* ------------------------------------------------------------------------- the form */

test("the form starts on the account the API listed and on nothing it did not", () => {
  const form = proposalFormState([{ account: { id: 12, name: "Desk" } }]);
  assert.equal(form.accountId, "12", "the first listed account is the default");
  assert.equal(form.symbol, "EURUSD", "legacy's symbol default");
  assert.equal(form.stopLoss, "", "no pre-filled stop: the port has no quote to derive one from");
  assert.equal(proposalFormState([]).accountId, "", "an operator with no account sees an empty selector, not a zero");
  assert.deepEqual(proposalFormState(null).accountId, "");
});

test("the form refuses what PROPOSAL_BODY would refuse, before the request", () => {
  const valid = { ...proposalFormState([{ account: { id: 3 } }]), stopLoss: "1.07", takeProfit: "1.12" };
  assert.equal(validateProposalForm(valid).ok, true, JSON.stringify(validateProposalForm(valid).errors));
  assert.match(validateProposalForm({ ...valid, accountId: "" }).errors.accountId, /Choose a paper account/);
  assert.match(validateProposalForm({ ...valid, symbol: "E" }).errors.symbol, /2–24 characters/);
  assert.match(validateProposalForm({ ...valid, marketClass: "future" }).errors.marketClass, /Choose a market class/, "legacy's spelling is refused here too");
  assert.match(validateProposalForm({ ...valid, type: "LIMIT" }).errors.price, /limit proposal needs a positive price/);
  assert.equal(validateProposalForm({ ...valid, type: "LIMIT", price: "1.06" }).ok, true);
  assert.match(validateProposalForm({ ...valid, stopLoss: "0" }).errors.stopLoss, /Stops are mandatory/);
  assert.match(validateProposalForm({ ...valid, takeProfit: "-1" }).errors.takeProfit, /positive/);
  assert.match(validateProposalForm({ ...valid, riskPct: "0.06" }).errors.riskPct, /between 0\.000001 and 0\.05/);
  assert.match(validateProposalForm({ ...valid, strategyId: "momentum" }).errors.strategyVersion, /supplied together/);
  assert.equal(validateProposalForm({ ...valid, strategyId: "momentum", strategyVersion: "v1" }).ok, true);
});

test("the body is shaped to the contract, and carries no volume the intent does not have", () => {
  const form = {
    ...proposalFormState([{ account: { id: 4 } }]),
    symbol: "btcusdt", marketClass: "CRYPTO", side: "sell", type: "LIMIT", price: "60000",
    stopLoss: "62000", takeProfit: "56000", riskPct: "0.01", strategyId: "Momentum", strategyVersion: "v1", reason: "  break of range  ",
  };
  const body = buildProposalBody(form);
  const allowed = Object.keys(PROPOSAL_BODY.properties);
  for (const key of Object.keys(body)) assert.ok(allowed.includes(key), `${key} is not a PROPOSAL_BODY property`);
  assert.ok(!("volume" in body), "PROPOSAL_BODY has no volume: the Risk Engine sizes the position");
  assert.equal(body.accountId, 4);
  assert.equal(body.symbol, "BTCUSDT");
  assert.equal(body.marketClass, "crypto");
  assert.equal(body.side, "SELL");
  assert.equal(body.price, 60000);
  assert.equal(body.stopLoss, 62000);
  assert.equal(body.strategyId, "momentum");
  assert.equal(body.reason, "break of range");
  // Optional blanks are omitted, not sent as nulls or empty strings.
  const sparse = buildProposalBody({ accountId: 4, symbol: "EURUSD", marketClass: "forex", side: "BUY", type: "MARKET", stopLoss: "1.07" });
  assert.deepEqual(Object.keys(sparse).sort(), ["accountId", "marketClass", "side", "stopLoss", "symbol", "type"]);
});

test("a decision carries the written reason the contract requires", () => {
  assert.equal(validateDecision("").ok, false);
  assert.match(validateDecision("too short").error, /at least 10 characters/);
  assert.equal(validateDecision("a" + "b".repeat(1_000)).ok, false, "1001 characters is over the contract's ceiling");
  assert.equal(validateDecision("I reviewed the risk and approve the simulation").ok, true);
  assert.deepEqual(buildDecisionBody(false, "  no   edge  in this trade "), { approve: false, reason: "no edge in this trade" });
});

/* ----------------------------------------------------------------------- the shaping */

test("a proposal row reports the port's own fields and invents neither a volume nor a broker", () => {
  const row = proposalRow({
    id: "2b0f4c1e-0000-4000-8000-000000000001",
    status: "APPROVED",
    intent: { symbol: "EURUSD", marketClass: "forex", side: "BUY", type: "MARKET", stopLoss: 1.07, takeProfit: 1.12, riskPct: 0.01, price: null },
    checks: [{ step: 1, check: "kill-switch", ok: true, detail: "inactive" }, { step: 2, check: "trading-mode", ok: true, detail: "PAPER_TRADING (simulation-only)" }],
    paperOrderId: null,
    createdAt: "2026-10-17T03:04:05.000Z",
  });
  assert.equal(row.created, "10-17 03:04", "legacy's substr(created_at, 5, 11) renders the same five-to-sixteen slice");
  assert.equal(row.intentText, "BUY MARKET · risk 1.00%");
  assert.equal(row.broker, "none", "no connector has been reached");
  assert.equal(row.risk, "1.00%");
  assert.equal(row.tone, "badge-sky");
  assert.equal(row.canDecide, false);
  assert.equal(row.canSubmitPaper, true);
  assert.deepEqual(passedChecks(row), { passed: 2, total: 2 });
  const filled = proposalRow({ ...row, paperOrderId: 9, status: "PAPER_EXECUTED" });
  assert.equal(filled.broker, "paper", "a submitted proposal names the paper ledger, not a broker");
  assert.equal(filled.canSubmitPaper, false);
  assert.equal(proposalRow(null), null);
  assert.deepEqual(proposalRows(null), []);
});

test("the empty states and the outcome sentences say what happened, not what legacy would have", () => {
  const rejected = proposalOutcome({ id: "p", status: "REJECTED", checks: [{ step: 2, check: "trading-mode", ok: false, detail: "mode is ANALYSIS_ONLY" }] });
  assert.deepEqual(rejected, { tone: "error", message: "REJECTED at step 2 (trading-mode): mode is ANALYSIS_ONLY" });
  const accepted = proposalOutcome({ id: "abc", status: "PENDING_APPROVAL", checks: [] });
  assert.match(accepted.message, /PENDING_APPROVAL — proposal abc awaits a person/);
  assert.equal(proposalOutcome(null).tone, "error");
  const pending = paperSubmitOutcome({ proposal: { id: "p", status: "PAPER_PENDING" }, paper: { filled: false, order: { id: 3 } } });
  assert.match(pending.message, /PAPER_PENDING — paper order #3 pending/);
  assert.match(paperSubmitOutcome({ proposal: { id: "p", status: "PAPER_REJECTED" }, paper: { filled: false, order: null } }).message, /no paper order was created/);
});

test("the automation envelope is legacy's default, labelled as a default and never as this host's configuration", () => {
  const php = supervisor();
  const literal = php.match(/'maxTradeNotionalUsd' => ([\d.]+), 'maxDailyTrades' => (\d+), 'maxRiskPerTradePct' => ([\d.]+), 'approvedSymbols' => \[\]/);
  assert.ok(literal, "ExecutionSupervisor::automationLimits() keeps its defaults in one literal");
  assert.equal(Number(literal[1]), LEGACY_AUTOMATION_LIMITS.maxTradeNotionalUsd);
  assert.equal(Number(literal[2]), LEGACY_AUTOMATION_LIMITS.maxDailyTrades);
  assert.equal(Number(literal[3]), LEGACY_AUTOMATION_LIMITS.maxRiskPerTradePct);
  assert.deepEqual([...LEGACY_AUTOMATION_LIMITS.approvedSymbols], []);
  const rows = automationRows();
  assert.deepEqual(rows.map((row) => row.key), ["maxTradeNotionalUsd", "maxDailyTrades", "maxRiskPerTradePct", "approvedSymbols"]);
  assert.deepEqual(rows.map((row) => row.legacy), ["500.00", "5", "1.00%", "—"]);
  for (const row of rows) assert.match(row.note, /legacy default/);
});

test("the module's scope and banners are read from the API's own answer", () => {
  const snapshot = {
    enabled: true, scope: "human-reviewed paper proposals only", simulationOnly: true,
    paperSubmissionAvailable: true, liveTradingEnabled: false, brokerConnectorAvailable: false,
    brokerConnectorsConfigured: 2, automatedModesAvailable: false, approvalRequired: true, proposalExpiryMinutes: 240,
  };
  const facts = executionStatusFacts(snapshot);
  assert.equal(facts.brokerConnectorAvailable, false);
  assert.equal(facts.brokerConnectorsConfigured, 2);
  assert.equal(facts.automatedModesAvailable, false);
  assert.equal(facts.expiryMinutes, 240);
  const flags = banners({ tradingMode: "PAPER_TRADING", killSwitch: { active: false } }, snapshot);
  assert.deepEqual(flags, { killSwitch: false, modeBlocked: true, noBroker: true, noAutomation: true });
  const stopped = banners({ tradingMode: "PAPER_TRADING", killSwitch: { active: true } }, snapshot);
  assert.equal(stopped.killSwitch, true);
  assert.deepEqual(governanceFacts({ tradingMode: "PAPER_TRADING", killSwitch: { active: false }, allowSyntheticPaperData: true, simulationOnly: true }), {
    mode: "PAPER_TRADING", killSwitch: false, synthetic: true, simulated: true,
  });
  assert.equal(executionStatusFacts(null), null);
  // The mode endpoint's enum is the reason `modeBlocked` is always true here.
  assert.deepEqual([...TRADING_MODE_BODY.properties.mode.values], ["ANALYSIS_ONLY", "PAPER_TRADING"]);
});

test("the formatting helpers never invent a figure", () => {
  assert.equal(moneyText(null), "—");
  assert.equal(moneyText(500), "500.00");
  assert.equal(percentText(null), "—");
  assert.equal(percentText(0.01), "1.00%");
  assert.equal(countText(0), "0", "a real zero is not a gap");
  assert.equal(countText(undefined), "—");
  assert.equal(executionTimeText(null), "—");
  assert.equal(executionTimeText("2026-10-17 03:04:05"), "10-17 03:04", "a MySQL datetime renders as legacy rendered it");
  assert.equal(executionTimeText("2026-10-17T03:04:05.000Z"), "10-17 03:04", "and so does the port's ISO form");
});

/* ----------------------------------------------------------------------- the wiring */

test("every declared read and write is a registered route, and the broker-bound routes are absent", async (t) => {
  const app = await instance(t);
  const inventory = (await get(app.app, "/api/v1/system/routes")).json().routes;
  for (const entry of [...EXECUTION_READS, ...EXECUTION_WRITES]) {
    const route = inventory.filter((candidate) => candidate.method === entry.method && candidate.path === entry.path).at(-1);
    assert.ok(route, `${entry.method} ${entry.path} must be registered`);
    assert.equal(route.permission, entry.permission, `${entry.path} is declared with the wrong permission`);
    assert.equal(route.auth, true, `${entry.path} requires a session`);
  }
  // The screen's boundary is only honest while these stay unregistered.
  assert.ok(!inventory.some((route) => route.path === "/api/v1/execution"), "no automated execution entry");
  assert.ok(!inventory.some((route) => route.path.endsWith("/route")), "no broker route");
  assert.ok(!inventory.some((route) => route.path.includes("trading/limits")), "no automation envelope");
  assert.deepEqual(LEGACY_WRITES_NOT_PORTED.map((entry) => entry.key).sort(), ["execute", "limits", "route"]);
});

test("the screen is declared where the router and the navigation will find it", () => {
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  const api = readFileSync(path.join(CLIENT, "api.js"), "utf8");
  assert.match(app, /path: "\/app\/execution", view: "execution-center", requiresAuth: true, permission: "trading\.view"/);
  assert.match(app, /"execution-center": <ExecutionView permissions=\{permissions\} \/>/);
  assert.match(views, /export function ExecutionView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/execution", label: "Execution", permission: EXECUTION_PERMISSION \}/);
  assert.match(views, /<h1>\{EXECUTION_COPY\.title\}\.<\/h1>/);
  for (const name of ["executionStatus", "executionProposals", "proposeExecution", "decideExecution", "submitExecutionPaper", "paperAccounts", "strategies", "tradingMode"]) {
    assert.match(api, new RegExp(`\\n  ${name}:`), `${name} is a declared endpoint`);
    assert.ok(views.includes(`endpoints.${name}(`), `${name} is used by the console`);
  }
  // The execution screen itself never writes governance: modes and the kill switch live on
  // the AI Workforce console, exactly as the risk page refused to carry them.
  const viewSource = views.slice(views.indexOf("export function ExecutionView"), views.indexOf("/* ------------------------------------------------------------- risk console */"));
  assert.ok(!viewSource.includes("/api/v1/trading/"), "the execution screen carries no governance write");
  assert.match(viewSource, /disabled=\{!canExecute \|\| busy\}/);
  assert.match(viewSource, /disabled=\{!canControl \|\| busy\}/);
  for (const key of ["paperOnly", "envelopeAbsent", "executionsAbsent", "volumeNote", "decisionReason", "modeEnum", "statusVocabulary", "pipelineNote"]) {
    assert.ok(viewSource.includes(`EXECUTION_PORT_COPY.${key}`), `${key} is stated on the screen`);
  }
});

/* ------------------------------------------------------------------------- the HTTP */

test("a viewer reads every surface and is refused all three writes", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  await openGovernance(app.app, root.headers);
  const created = await post(app.app, "/api/v1/paper/accounts", root.headers, { name: "Viewer fixture", startingBalance: 10_000 });
  assert.equal(created.statusCode, 201, created.body);
  const accountId = created.json().account.id;
  const proposed = await post(app.app, "/api/v1/execution/proposals", root.headers, { accountId, ...INTENT });
  assert.equal(proposed.statusCode, 201, proposed.body);
  const proposalId = proposed.json().id;

  const viewer = await roleSession(app.app, app.store, { username: "execviewer", phrase: "Execution viewer phrase", permissions: [EXECUTION_PERMISSION] });
  for (const read of EXECUTION_READS) {
    const response = await get(app.app, read.path, viewer.headers);
    assert.equal(response.statusCode, 200, `${read.key}: ${response.body}`);
  }
  // Owner scoping means the viewer's list is empty — a 200, not another operator's rows.
  assert.deepEqual((await get(app.app, "/api/v1/execution/proposals", viewer.headers)).json().proposals, []);
  // The viewer's own account does not exist, so a proposal is refused at the permission
  // guard before any ownership lookup could answer 404.
  const propose = await post(app.app, "/api/v1/execution/proposals", viewer.headers, { accountId, ...INTENT });
  assert.equal(propose.statusCode, 403, propose.body);
  assert.equal(propose.json().error.code, "PERMISSION_DENIED");
  const decide = await post(app.app, `/api/v1/execution/proposals/${proposalId}/decision`, viewer.headers, { approve: true, reason: "A viewer tried to approve this" });
  assert.equal(decide.statusCode, 403, decide.body);
  assert.equal(decide.json().error.code, "PERMISSION_DENIED");
  const submit = await post(app.app, `/api/v1/execution/proposals/${proposalId}/paper-submit`, viewer.headers, {});
  assert.equal(submit.statusCode, 403, submit.body);
  assert.equal(submit.json().error.code, "PERMISSION_DENIED");
});

test("a proposal persists the checks the port runs, and the screen renders them", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  await openGovernance(app.app, root.headers);
  const { proposal } = await accountAndProposal(app.app, root.headers);
  assert.equal(proposal.status, "PENDING_APPROVAL");
  assert.deepEqual(proposal.checks.map((check) => [check.step, check.check, check.ok]), [
    [1, "kill-switch", true],
    [2, "trading-mode", true],
    [3, "strategy", true],
  ]);
  assert.equal(proposal.checks[1].detail, "PAPER_TRADING (simulation-only)");
  assert.match(proposal.checks[2].detail, /discretionary proposal/);
  assert.equal(proposal.simulationOnly, true);
  assert.equal(proposal.liveTradingEnabled, false);

  const rows = proposalRows((await get(app.app, "/api/v1/execution/proposals", root.headers)).json());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "PENDING_APPROVAL");
  assert.equal(rows[0].canDecide, true);
  assert.equal(rows[0].canSubmitPaper, false);
  assert.equal(rows[0].checkCount, 3);
  assert.equal(rows[0].broker, "none");

  const audits = (await app.store.snapshot()).audit.filter((entry) => entry.entity_id === proposal.id);
  assert.deepEqual(audits.map((entry) => entry.action_key), ["execution.proposal.created"]);
});

test("the kill switch stops a proposal at step 1, exactly as legacy's banner promised", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const created = await post(app.app, "/api/v1/paper/accounts", root.headers, { name: "Stopped fixture", startingBalance: 10_000 });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await post(app.app, "/api/v1/trading/kill-switch", root.headers, { active: true, reason: "console test" })).statusCode, 200);
  const proposed = await post(app.app, "/api/v1/execution/proposals", root.headers, { accountId: created.json().account.id, ...INTENT });
  assert.equal(proposed.statusCode, 201, proposed.body);
  assert.equal(proposed.json().status, "REJECTED");
  const failed = proposed.json().checks.at(-1);
  assert.equal(failed.step, 1);
  assert.equal(failed.check, "kill-switch");
  assert.equal(failed.detail, "kill switch is active");
  assert.match(proposalOutcome(proposed.json()).message, /^REJECTED at step 1 \(kill-switch\): kill switch is active$/);
  // The page's own banner sentence is what this test just proved.
  assert.ok(plain(view()).includes(EXECUTION_COPY.killSwitchNote));
});

test("a mode that is not PAPER_TRADING is refused at step 2 with the port's own sentence", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const created = await post(app.app, "/api/v1/paper/accounts", root.headers, { name: "Mode fixture", startingBalance: 10_000 });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await post(app.app, "/api/v1/trading/kill-switch", root.headers, { active: false, reason: "console test" })).statusCode, 200);
  assert.equal((await post(app.app, "/api/v1/trading/mode", root.headers, { mode: "ANALYSIS_ONLY" })).statusCode, 200);
  const proposed = await post(app.app, "/api/v1/execution/proposals", root.headers, { accountId: created.json().account.id, ...INTENT });
  assert.equal(proposed.statusCode, 201, proposed.body);
  assert.equal(proposed.json().status, "REJECTED");
  const failed = proposed.json().checks.at(-1);
  assert.equal(failed.step, 2);
  assert.equal(failed.check, "trading-mode");
  assert.match(failed.detail, /only PAPER_TRADING proposals are available/);
});

test("a decision needs its reason, is audited, and hands the proposal to the paper step", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  await openGovernance(app.app, root.headers);
  const { proposal } = await accountAndProposal(app.app, root.headers);

  // The contract refuses a reason under ten characters before the service sees it.
  const shortReason = await post(app.app, `/api/v1/execution/proposals/${proposal.id}/decision`, root.headers, { approve: true, reason: "ok" });
  assert.equal(shortReason.statusCode, 400, shortReason.body);
  assert.equal(shortReason.json().error.code, "INVALID_REQUEST");
  assert.equal((await get(app.app, `/api/v1/execution/proposals/${proposal.id}`, root.headers)).json().proposal.status, "PENDING_APPROVAL", "a refused decision changes nothing");

  const approved = await post(app.app, `/api/v1/execution/proposals/${proposal.id}/decision`, root.headers, {
    approve: true, reason: "I reviewed the risk and approve the paper simulation",
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().proposal.status, "APPROVED");
  assert.equal(approved.json().proposal.decisionReason, "I reviewed the risk and approve the paper simulation");

  const submitted = await post(app.app, `/api/v1/execution/proposals/${proposal.id}/paper-submit`, root.headers, {});
  assert.ok([201, 202].includes(submitted.statusCode), submitted.body);
  assert.equal(submitted.json().proposal.status, "PAPER_EXECUTED");
  assert.equal(submitted.json().paper.filled, true);
  assert.equal(submitted.json().paper.order.synthetic, true);
  const outcome = paperSubmitOutcome(submitted.json());
  assert.equal(outcome.tone, "ok");
  assert.match(outcome.message, /PAPER_EXECUTED — paper order #\d+ filled/);

  const actions = (await app.store.snapshot()).audit.filter((entry) => entry.entity_id === proposal.id).map((entry) => entry.action_key);
  assert.deepEqual(actions, [
    "execution.proposal.created",
    "execution.proposal.approved",
    "execution.paper-submission.started",
    "execution.paper-submission.completed",
  ]);
  const row = proposalRow((await get(app.app, `/api/v1/execution/proposals/${proposal.id}`, root.headers)).json().proposal);
  assert.equal(row.broker, "paper");
  assert.equal(row.status, "PAPER_EXECUTED");
  assert.equal(row.canDecide, false);
  assert.equal(row.canSubmitPaper, false);
});

test("the proposer cannot approve their own proposal: the decision is a separate permission", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  await openGovernance(app.app, root.headers);
  const executive = await executiveSession(app.app, app.store);
  // The executive holds `trading.execute` but not `trading.control`, and owns the account.
  const created = await post(app.app, "/api/v1/paper/accounts", executive.headers, { name: "Self-approval fixture", startingBalance: 10_000 });
  assert.equal(created.statusCode, 201, created.body);
  const proposed = await post(app.app, "/api/v1/execution/proposals", executive.headers, { accountId: created.json().account.id, ...INTENT });
  assert.equal(proposed.statusCode, 201, proposed.body);
  assert.equal(proposed.json().status, "PENDING_APPROVAL");
  const decision = await post(app.app, `/api/v1/execution/proposals/${proposed.json().id}/decision`, executive.headers, {
    approve: true, reason: "I approve my own proposal for the simulation",
  });
  assert.equal(decision.statusCode, 403, decision.body);
  assert.equal(decision.json().error.code, "PERMISSION_DENIED");
  // The executive may not submit it either until a control-holding session decides.
  const early = await post(app.app, `/api/v1/execution/proposals/${proposed.json().id}/paper-submit`, executive.headers, {});
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error.code, "PAPER_SUBMISSION_NOT_APPROVED");
});

test("the status snapshot is the source of the paper-only claim on the screen", async (t) => {
  const app = await instance(t);
  const root = await signIn(app.app);
  const snapshot = (await get(app.app, "/api/v1/execution/status", root.headers)).json();
  const facts = executionStatusFacts(snapshot);
  assert.equal(facts.enabled, true);
  assert.equal(facts.paperSubmissionAvailable, true);
  assert.equal(facts.brokerConnectorAvailable, false, "the screen can only claim this because the API says it");
  assert.equal(facts.automatedModesAvailable, false);
  assert.equal(facts.approvalRequired, true);
  assert.equal(facts.expiryMinutes, 240, "the supervisor's four-hour window");
  assert.equal(snapshot.liveTradingEnabled, false);
  const flags = banners((await get(app.app, "/api/v1/trading/mode", root.headers)).json(), snapshot);
  assert.equal(flags.noBroker, true);
  assert.equal(flags.noAutomation, true);
  assert.equal(flags.modeBlocked, true, "the mode endpoint's enum cannot produce an execution mode");
});

test("the shared StateBox renders a ready resource's content, and no empty state hides it", () => {
  // Found while wiring this screen: `StateBox` returned its `empty` node whenever the read
  // was ready, so a panel that passed both content and an empty message rendered only the
  // message — the Execution Center's proposals table would never have shown a proposal, and
  // neither would the paper, risk or sports panels that carried the same pattern.
  const ui = readFileSync(path.join(CLIENT, "ui.jsx"), "utf8");
  assert.match(ui, /if \(status === "ready"\) return empty \?\? children;/, "a ready read renders its content; `empty` is the fallback");
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.ok(!/empty=\{<p/.test(views), "every empty state is conditional on the data being absent");
  // The probes' rendering defect is asserted structurally rather than by mounting the SPA:
  // this environment has no browser, which is why the suite states what it can prove.
  const executionView = views.slice(views.indexOf("export function ExecutionView"), views.indexOf("/* ------------------------------------------------------------- risk console */"));
  assert.match(executionView, /empty=\{rows\.length \? null : <p className="empty">\{EXECUTION_COPY\.noProposals\}<\/p>\}/);
});

test("the served shell carries the screen, and the deep link answers", async (t) => {
  const app = await instance(t);
  const shell = path.resolve(CLIENT, "..", "..", "public", "app", "index.html");
  assert.ok(existsSync(shell), "the built SPA shell is required: npm run build:workforce-client");
  const html = await get(app.app, "/app/execution", { accept: "text/html" });
  assert.equal(html.statusCode, 200, "a bookmark, a refresh or a pasted link must reach the screen");
  assert.match(html.headers["content-type"] || "", /text\/html/);
  const assets = [...html.body.matchAll(/assets\/index-[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]);
  assert.ok(assets.length >= 1, "the shell must reference the built bundle");
  const bundle = readFileSync(path.resolve(CLIENT, "..", "..", "public", "app", ...assets[0].split("/")), "utf8");
  for (const needle of ["Execution", "Paper-only supervisor", "Run pipeline & create proposal", "Submit to paper", "/app/execution"]) {
    assert.ok(bundle.includes(needle), `the served bundle carries ${JSON.stringify(needle)}`);
  }
  // The screen's window is legacy's 40, not the contract's 500 ceiling.
  assert.equal(EXECUTION_WINDOWS.proposals, 40);
  assert.match(controller(), /proposals\(null, 40\)/);
});
