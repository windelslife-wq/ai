/**
 * Scheduled operations jobs (row 19) — the portfolio risk sweep, the cross-owner
 * stale-proposal expiry, the `wf_job_locks` row that keeps two cron runs apart, and
 * the job state that makes alerting edge-triggered.
 *
 * The lock and state tests run against the file adapter for behaviour and against a
 * recording executor for the MySQL SQL shapes, because there is still no real MySQL
 * staging database (finding F-15) and a lock that is only proven on one adapter is
 * not proven.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFileStore } from "../src/persistence/file-store.js";
import { createJobRepository, PORTFOLIO_RISK_STATE_KEY } from "../src/db/job-repository.js";
import { createExecutionRepository } from "../src/db/execution-repository.js";
import { createPaperService, DEFAULT_PAPER_TRADING_STATE } from "../src/modules/paper/service.js";
import { createExecutionService } from "../src/modules/execution/service.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import {
  AUDIT_ACTIONS,
  CRITICAL_BREACH_CODES,
  LEGACY_ACTIONS,
  OPERATIONS_JOB_NAME,
  PORTFOLIO_RISK_NOTIFICATION_TYPE,
  WARNING_BREACH_CODES,
  createScheduledJobs,
  severityForBreachCode,
} from "../src/jobs/scheduled.js";

const OWNER = 7;
const OTHER_OWNER = 8;
const BASE_TIME = Date.parse("2026-10-11T12:00:00.000Z");
const EXPIRY_WINDOW_MS = 4 * 60 * 60_000;
const SILENT = { warn() {}, info() {}, error() {}, debug() {} };

const INTENT = Object.freeze({
  accountId: 1,
  symbol: "eurusd",
  marketClass: "FOREX",
  side: "buy",
  type: "market",
  stopLoss: 0.5,
  takeProfit: 2.5,
  reason: "Reviewed paper setup",
});

async function makeStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-scheduled-jobs-"));
  let store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    /** Reopen the same directory, proving rows outlive the process that wrote them. */
    async reopen() {
      await store.close();
      store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
      return store;
    },
  };
}

/** A paper account owned by `owner`, plus the enabled trading state the sweep needs. */
async function seedAccount(store, owner, name, { balance = 10_000 } = {}) {
  const enabled = structuredClone(DEFAULT_PAPER_TRADING_STATE);
  enabled.tradingMode = "PAPER_TRADING";
  enabled.killSwitch = { active: false, activatedAt: null, reason: null };
  return store.withPaperTransaction(async (tx) => {
    await tx.saveTradingState(enabled, { updatedByUserId: owner, updatedAt: new Date(BASE_TIME).toISOString() });
    return tx.createPaperAccount({
      owner_user_id: owner,
      name,
      currency: "USD",
      starting_balance: balance,
      balance,
      peak_equity: balance,
      revision: 0,
      created_at: new Date(BASE_TIME).toISOString(),
    });
  });
}

/** An open position, so the account summary has something to mark. */
async function seedPosition(store, accountId, { symbol = "EURUSD", synthetic = false } = {}) {
  return store.withPaperTransaction((tx) => tx.savePaperPosition({
    account_id: accountId,
    symbol,
    market_class: "FOREX",
    direction: "LONG",
    units: 10_000,
    entry_price: 1.1,
    stop_loss: 1.05,
    take_profit: 1.2,
    entry_fee: 0,
    risk_amount: 50,
    strategy: null,
    strategy_version: null,
    reason: "seeded for the scheduled-jobs test",
    ai_confidence: null,
    synthetic,
    opened_at: new Date(BASE_TIME).toISOString(),
    status: "OPEN",
    closed_at: null,
    exit_price: null,
    realized_pnl: null,
    exit_reason: null,
  }));
}

/**
 * A feed that can be made to fail. A failing quote is caught by the paper service's
 * `markPrices` and reported as an unavailable valuation, which is the deterministic
 * way to produce a real breach without driving an order through the risk engine.
 */
function feed({ failQuotes = false, price = 1.1 } = {}) {
  return {
    async quote({ symbol }) {
      if (failQuotes) throw new Error("provider unreachable in this test");
      return {
        quote: { symbol, last: price, timestamp: BASE_TIME },
        source: "scheduled-jobs-test-feed",
        synthetic: false,
        fetchedAt: BASE_TIME,
      };
    },
    async candles({ symbol, marketClass, timeframe }) {
      return {
        symbol,
        marketClass,
        timeframe,
        candles: [],
        provenance: { source: "scheduled-jobs-test-feed", synthetic: false, live: true, dataTimestamp: BASE_TIME, fetchedAt: BASE_TIME, stale: false },
      };
    },
  };
}

/**
 * The paper service the *execution* sweep needs: a trading state and an order path.
 * Deliberately separate from the risk-sweep paper service, which is the real one.
 */
function executionPaper({ submitted = [] } = {}) {
  return {
    async tradingState() {
      return { tradingMode: "PAPER_TRADING", killSwitch: { active: false }, simulationOnly: true, liveTradingEnabled: false };
    },
    async submitOrder(ownerUserId, accountId, order) {
      submitted.push({ ownerUserId, accountId, order });
      return {
        filled: true,
        order: { id: 41, status: "FILLED", synthetic: true, rejectReasons: [] },
        position: { id: 52, status: "OPEN", synthetic: true },
        riskDecision: { approved: true, reasons: [], warnings: [] },
      };
    },
  };
}

/**
 * Full harness: file store, controllable clock, notification and execution services,
 * and a `jobs()` factory so a test can swap the paper service per case.
 */
async function harness(t, { failQuotes = false } = {}) {
  const context = await makeStore(t);
  const state = { clock: BASE_TIME };
  const now = () => state.clock;

  const build = (store, paper) => {
    const notifications = createNotificationService({ store, now, log: SILENT });
    const execution = createExecutionService({ store, paper: executionPaper(), strategies: null, notifications, log: SILENT, now });
    return { notifications, execution };
  };

  const services = build(context.store, null);

  /** Real paper service over the same store, with a feed that can be made to fail. */
  const realPaper = () => createPaperService({
    store: context.store,
    marketData: feed({ failQuotes }),
    strategies: null,
    notifications: services.notifications,
    log: SILENT,
    now,
  });

  return {
    ...context,
    now,
    advance: (ms) => { state.clock += ms; },
    setClock: (ms) => { state.clock = ms; },
    notifications: services.notifications,
    execution: services.execution,
    realPaper,
    /** Jobs wired to whatever paper service a case supplies. */
    jobs(paper = null, overrides = {}) {
      return createScheduledJobs({
        store: context.store,
        paper,
        execution: services.execution,
        notifications: services.notifications,
        log: SILENT,
        now,
        ...overrides,
      });
    },
    /** Audit rows in insertion order, optionally filtered by action. */
    async audit(action = null) {
      const page = await context.store.listAuditEvents({ limit: 200, sort: "createdAt", direction: "asc" });
      const rows = page.events ?? page;
      return action ? rows.filter((event) => event.action === action) : rows;
    },
  };
}

/**
 * The real store with selected methods overridden.
 *
 * Used for the two failure cases the file adapter cannot produce on its own: a
 * proposal row with no owner, and a storage error part-way through the sweep. In
 * MySQL `wf_execution_proposals.owner_user_id` is `NOT NULL` with
 * `ON DELETE RESTRICT`, so an ownerless proposal cannot exist there — the guard is
 * defensive rather than a path a healthy schema reaches, and saying so is the only
 * honest way to test it.
 */
function storeWith(store, overrides) {
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A fake paper service whose scan is scripted per owner. */
function scriptedPaper({ scans = {}, failOwners = [] } = {}) {
  const calls = [];
  return {
    calls,
    async portfolioRiskScan(ownerUserId, options = {}) {
      calls.push({ ownerUserId, options });
      if (failOwners.includes(Number(ownerUserId))) {
        throw new Error(`valuation exploded for owner ${ownerUserId}`);
      }
      const accounts = scans[Number(ownerUserId)] ?? [];
      return {
        generatedAt: new Date(BASE_TIME).toISOString(),
        simulationOnly: true,
        accounts,
        totals: { accounts: accounts.length, breachedAccounts: accounts.filter((entry) => entry.breaches?.length).length },
      };
    },
  };
}

function accountScan(accountId, breaches, { ownerUserId = OWNER, accountName = null } = {}) {
  return { accountId, accountName, ownerUserId, status: breaches.length ? "BREACH" : "HEALTHY", breaches };
}

// ---------------------------------------------------------------- job locks

test("a job lock is acquired once, is holder-scoped on release, and refuses a second holder", async (t) => {
  const { store } = await harness(t);
  const nowIso = new Date(BASE_TIME).toISOString();
  const expiresAt = new Date(BASE_TIME + 600_000).toISOString();

  assert.equal(await store.findJobLock(OPERATIONS_JOB_NAME), null, "a job that has never run has no lock row");

  const first = await store.acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#1", nowIso, expiresAt });
  assert.equal(first.acquired, true);
  assert.equal(first.lock.holder, "cron#1");
  assert.equal(first.lock.expiresAt, expiresAt);

  const second = await store.acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#2", nowIso, expiresAt });
  assert.equal(second.acquired, false, "a live lock is not handed to a second holder");
  assert.equal(second.lock.holder, "cron#1", "the refusal names who actually holds it");
  assert.match(second.reason, /cron#1/, "the reason is usable in a cron log");

  assert.equal(await store.releaseJobLock(OPERATIONS_JOB_NAME, "cron#2"), false, "a non-holder cannot release");
  const still = await store.findJobLock(OPERATIONS_JOB_NAME);
  assert.equal(still.holder, "cron#1", "a failed release left the row alone");

  assert.equal(await store.releaseJobLock(OPERATIONS_JOB_NAME, "cron#1"), true);
  assert.equal(await store.findJobLock(OPERATIONS_JOB_NAME), null);

  const locks = await store.listJobLocks();
  assert.deepEqual(locks, [], "the released job leaves nothing behind");
});

test("an expired lock is taken over, and the run that overran cannot release it afterwards", async (t) => {
  const { store } = await harness(t);
  const acquired = await store.acquireJobLock(OPERATIONS_JOB_NAME, {
    holder: "cron#slow",
    nowIso: new Date(BASE_TIME).toISOString(),
    expiresAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
  assert.equal(acquired.acquired, true);

  // The next run starts after the TTL elapsed. This is the case that matters on
  // shared hosting: a job that runs long must not wedge the schedule forever.
  const later = BASE_TIME + 120_000;
  const takeover = await store.acquireJobLock(OPERATIONS_JOB_NAME, {
    holder: "cron#fresh",
    nowIso: new Date(later).toISOString(),
    expiresAt: new Date(later + 600_000).toISOString(),
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.lock.holder, "cron#fresh");
  assert.match(takeover.reason, /expired/i, "the log says the lock was taken over, not freshly created");

  // The slow run finally finishes and tries to clean up. It must not unlock the run
  // that is legitimately active — that is what would let a third run in.
  assert.equal(await store.releaseJobLock(OPERATIONS_JOB_NAME, "cron#slow"), false);
  assert.equal((await store.findJobLock(OPERATIONS_JOB_NAME)).holder, "cron#fresh");
});

test("extendJobLock only extends for the current holder", async (t) => {
  const { store } = await harness(t);
  const nowIso = new Date(BASE_TIME).toISOString();
  await store.acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#1", nowIso, expiresAt: new Date(BASE_TIME + 60_000).toISOString() });

  assert.equal(
    await store.extendJobLock(OPERATIONS_JOB_NAME, "cron#2", new Date(BASE_TIME + 900_000).toISOString()),
    false,
    "extending someone else's lock would be indistinguishable from stealing it",
  );
  assert.equal((await store.findJobLock(OPERATIONS_JOB_NAME)).expiresAt, new Date(BASE_TIME + 60_000).toISOString());

  assert.equal(
    await store.extendJobLock(OPERATIONS_JOB_NAME, "cron#1", new Date(BASE_TIME + 900_000).toISOString()),
    true,
  );
  assert.equal((await store.findJobLock(OPERATIONS_JOB_NAME)).expiresAt, new Date(BASE_TIME + 900_000).toISOString());
});

test("job locks and job state survive a store close and reopen", async (t) => {
  const context = await harness(t);
  const nowIso = new Date(BASE_TIME).toISOString();
  await context.store.acquireJobLock("retention.audit", { holder: "cron#1", nowIso, expiresAt: new Date(BASE_TIME + 600_000).toISOString() });
  await context.store.saveJobState(PORTFOLIO_RISK_STATE_KEY, { lastScanAt: nowIso, alertKeys: { "paper:1:DRAWDOWN_LIMIT": true } }, { updatedAt: nowIso });

  const reopened = await context.reopen();
  const lock = await reopened.findJobLock("retention.audit");
  assert.equal(lock.holder, "cron#1", "a lock row is durable, which is the point of using a table instead of GET_LOCK()");
  const state = await reopened.loadJobState(PORTFOLIO_RISK_STATE_KEY);
  assert.deepEqual(state.alertKeys, { "paper:1:DRAWDOWN_LIMIT": true }, "the transition memory is durable, so a restart does not re-alert");
});

test("job state cannot read or write the trading-governance key", async (t) => {
  const { store } = await harness(t);
  const governance = structuredClone(DEFAULT_PAPER_TRADING_STATE);
  governance.killSwitch = { active: true, activatedAt: new Date(BASE_TIME).toISOString(), reason: "operator stop, set before the job ran" };
  await store.withPaperTransaction((tx) => tx.saveTradingState(governance, { updatedByUserId: OWNER, updatedAt: new Date(BASE_TIME).toISOString() }));
  const before = await store.loadTradingState();
  assert.equal(before.killSwitch.active, true);

  await store.saveJobState(PORTFOLIO_RISK_STATE_KEY, { lastScanAt: new Date(BASE_TIME).toISOString(), alertKeys: {} });

  const after = await store.loadTradingState();
  assert.deepEqual(after.killSwitch, before.killSwitch, "a job run cannot move the kill switch");
  assert.equal(after.tradingMode, before.tradingMode);
  assert.equal(after.updatedByUserId, OWNER, "nor can it rewrite who last touched the governance row");

  // Both methods are async, so the guard surfaces as a rejection rather than a
  // synchronous throw on either adapter.
  for (const key of ["global", "GLOBAL", "", "Portfolio Risk", "a".repeat(25)]) {
    await assert.rejects(store.saveJobState(key, {}), TypeError, `saveJobState must refuse ${JSON.stringify(key)}`);
    await assert.rejects(store.loadJobState(key), TypeError, `loadJobState must refuse ${JSON.stringify(key)}`);
  }
  // "GLOBAL" and a 25-character key are refused by the pattern itself: MySQL's
  // VARCHAR(24) would truncate the long one into a *different* row, and the pattern
  // is case-sensitive because `state_key` is the primary key the two documents are
  // separated by.
  assert.equal((await store.loadTradingState()).killSwitch.reason, before.killSwitch.reason,
    "every refused write left the governance document exactly as it was");
});

// ------------------------------------------------- cross-owner proposal expiry

test("the expiry sweep dry run measures and writes nothing", async (t) => {
  const { store, execution, advance, audit } = await harness(t);
  await seedAccount(store, OWNER, "Owner account");
  const created = await execution.propose(OWNER, INTENT);
  assert.equal(created.status, "PENDING_APPROVAL");
  advance(EXPIRY_WINDOW_MS + 1_000);

  const dry = await execution.expireStaleProposals({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.scanned, 1);
  assert.equal(dry.staleFound, 1);
  assert.deepEqual(dry.wouldExpireIds, [created.id], "the dry run names what it would expire");
  assert.deepEqual(dry.expiredIds, [], "and expires nothing");
  assert.equal(dry.alreadyExpired, 0, "a dry run cannot know what another run already did");

  // Read through the store, NOT through `execution.find`: the HTTP path expires a
  // stale proposal lazily on read, so using it here would expire the row and make the
  // dry run look like it wrote. This is the only read that answers "did the dry run
  // change anything".
  const pending = await store.listExecutionProposalsAllOwners({ status: "PENDING_APPROVAL", limit: 10 });
  assert.deepEqual(pending.map((row) => row.id), [created.id], "the proposal is still pending after a dry run");

  const inbox = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(inbox.filter((row) => row.type === "PROPOSAL_EXPIRED").length, 0, "a dry run publishes nothing");
  assert.deepEqual(await audit("execution.proposal.expired"), [], "and audits nothing");
  assert.deepEqual(await audit(AUDIT_ACTIONS.cronRun), []);
});

test("the expiry sweep expires stale proposals across owners, notifying and auditing each", async (t) => {
  const { store, execution, advance, notifications } = await harness(t);
  await seedAccount(store, OWNER, "Owner account");
  await seedAccount(store, OTHER_OWNER, "Other owner account", { balance: 20_000 });

  // Two owners, one proposal each: the sweep must not be owner-scoped, which is the
  // whole reason `listExecutionProposalsAllOwners` exists separately from the
  // owner-bound read (see the note on `listExecutionProposals(null)`).
  const mine = await execution.propose(OWNER, INTENT);
  const theirs = await execution.propose(OTHER_OWNER, { ...INTENT, accountId: 2 });
  assert.equal(mine.status, "PENDING_APPROVAL");
  assert.equal(theirs.status, "PENDING_APPROVAL");
  advance(60_000);
  const fresh = await execution.propose(OWNER, INTENT);

  advance(EXPIRY_WINDOW_MS);
  const result = await execution.expireStaleProposals();
  assert.equal(result.dryRun, false);
  assert.equal(result.scanned, 3, "all three pending proposals were considered, across both owners");
  assert.equal(result.staleFound, 2);
  assert.deepEqual([...result.expiredIds].sort(), [mine.id, theirs.id].sort());
  assert.deepEqual(result.failures, []);
  assert.equal(result.exhausted, true);

  const mineAfter = await execution.find(OWNER, mine.id);
  assert.equal(mineAfter.proposal.status, "EXPIRED");
  const freshAfter = await execution.find(OWNER, fresh.id);
  assert.equal(freshAfter.proposal.status, "PENDING_APPROVAL", "a proposal inside its window is untouched");

  // The legacy sweep published PROPOSAL_EXPIRED with dedupe key `proposal:<id>:expired`.
  const inbox = await store.listNotifications(OWNER, { limit: 50 });
  const expiries = inbox.filter((row) => row.type === "PROPOSAL_EXPIRED");
  assert.equal(expiries.length, 2, "each expired proposal notified its own operator");
  assert.ok(expiries.some((row) => row.dedupe_key === `proposal:${mine.id}:expired`));
  assert.equal(typeof notifications.notify, "function");
});

test("a second expiry sweep is idempotent", async (t) => {
  const { store, execution, advance } = await harness(t);
  await seedAccount(store, OWNER, "Owner account");
  const created = await execution.propose(OWNER, INTENT);
  advance(EXPIRY_WINDOW_MS + 1_000);

  const first = await execution.expireStaleProposals();
  assert.deepEqual(first.expiredIds, [created.id]);

  const second = await execution.expireStaleProposals();
  assert.equal(second.scanned, 0, "an expired proposal is no longer pending, so the sweep has nothing to look at");
  assert.equal(second.staleFound, 0);
  assert.deepEqual(second.expiredIds, []);
  assert.equal(second.alreadyExpired, 0);

  const inbox = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(inbox.filter((row) => row.type === "PROPOSAL_EXPIRED").length, 1, "no duplicate alert on the re-run");
});

test("a storage failure on one proposal does not stop the sweep", async (t) => {
  const context = await harness(t);
  const { store, execution, advance, notifications } = context;
  await seedAccount(store, OWNER, "Owner account");
  await seedAccount(store, OTHER_OWNER, "Other owner account", { balance: 20_000 });
  const first = await execution.propose(OWNER, INTENT);
  const second = await execution.propose(OTHER_OWNER, { ...INTENT, accountId: 2 });
  advance(EXPIRY_WINDOW_MS + 1_000);

  // Fail the first transaction the sweep opens and let the second through. Legacy had
  // no per-item isolation at all: one throwing row abandoned the whole `foreach`, so a
  // deterministic failure on proposal 3 of 200 left the other 197 pending forever
  // (divergence SJ-1). Continuation is the property under test, not the failure itself.
  let opened = 0;
  const flaky = storeWith(store, {
    async withPaperTransaction(work) {
      opened += 1;
      if (opened === 1) throw new Error("the store refused this transaction");
      return store.withPaperTransaction(work);
    },
  });
  const flakyExecution = createExecutionService({
    store: flaky,
    paper: executionPaper(),
    strategies: null,
    notifications,
    log: SILENT,
    now: context.now,
  });

  const result = await flakyExecution.expireStaleProposals();
  assert.equal(result.staleFound, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /the store refused this transaction/);
  assert.equal(result.expiredIds.length, 1, "the other proposal was still expired");
  assert.ok([first.id, second.id].includes(result.expiredIds[0]));
});

test("a proposal with no usable owner is reported rather than expired under an invented identity", async (t) => {
  const context = await harness(t);
  const { store, execution, advance, notifications } = context;
  await seedAccount(store, OWNER, "Owner account");
  const good = await execution.propose(OWNER, INTENT);
  advance(EXPIRY_WINDOW_MS + 1_000);

  // MySQL cannot produce this row: `owner_user_id` is NOT NULL with ON DELETE
  // RESTRICT, so a user who owns proposals cannot be deleted and the column cannot be
  // nulled. The guard exists for adapters without that constraint and for restored
  // backups, and `actorIdOf` would throw on it — which is why the sweep validates the
  // owner itself instead of letting one bad row abort the batch.
  const orphan = {
    id: "00000000-0000-4000-8000-000000000001",
    owner_user_id: null,
    account_id: 1,
    status: "PENDING_APPROVAL",
    created_at: new Date(BASE_TIME).toISOString(),
  };
  const injected = storeWith(store, {
    async listExecutionProposalsAllOwners(options) {
      const rows = await store.listExecutionProposalsAllOwners(options);
      return [...rows, orphan];
    },
  });
  const injectedExecution = createExecutionService({
    store: injected,
    paper: executionPaper(),
    strategies: null,
    notifications,
    log: SILENT,
    now: context.now,
  });

  const result = await injectedExecution.expireStaleProposals();
  assert.equal(result.staleFound, 2);
  assert.deepEqual(result.expiredIds, [good.id], "the real proposal was still expired");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].proposalId, orphan.id);
  assert.match(result.failures[0].reason, /no usable owner/);
});

// ------------------------------------------------------------ portfolio risk sweep

test("the risk sweep turns a real portfolio breach into a keyed, classified alert", async (t) => {
  const context = await harness(t, { failQuotes: true });
  const { store } = context;
  const account = await seedAccount(store, OWNER, "Unmeasurable account");
  await seedPosition(store, account.id);

  const jobs = context.jobs(context.realPaper());
  const sweep = await jobs.portfolioRiskSweep();
  assert.equal(sweep.owners, 1);
  assert.equal(sweep.accountsScanned, 1);
  assert.equal(sweep.exhausted, true);
  assert.deepEqual(sweep.scanFailures, []);

  assert.equal(sweep.alerts.length, 1);
  const [alert] = sweep.alerts;
  assert.equal(alert.code, "VALUATION_UNAVAILABLE");
  assert.equal(alert.scope, `paper:${account.id}`);
  assert.equal(alert.key, `paper:${account.id}:VALUATION_UNAVAILABLE`, "the key is legacy's `<scope>:<code>`");
  assert.equal(alert.severity, "warning", "an untrustworthy measurement is a warning, not a capital breach");
  assert.equal(alert.classified, true);
  assert.equal(alert.ownerUserId, OWNER);
});

test("one owner's scan failure does not blind the sweep to the other owners", async (t) => {
  const { store, jobs } = await harness(t);
  const mine = await seedAccount(store, OWNER, "Scannable account");
  await seedAccount(store, OTHER_OWNER, "Unscannable account", { balance: 20_000 });

  const paper = scriptedPaper({
    scans: {
      [OWNER]: [accountScan(mine.id, [{ code: "DRAWDOWN_LIMIT", message: "drawdown 12% exceeds the 10% limit" }], { ownerUserId: OWNER })],
    },
    failOwners: [OTHER_OWNER],
  });

  const sweep = await jobs(paper).portfolioRiskSweep();
  assert.equal(sweep.accountsScanned, 1, "the healthy owner was still scanned");
  assert.equal(sweep.scanFailures.length, 1);
  assert.equal(sweep.scanFailures[0].owner, OTHER_OWNER);
  assert.match(sweep.scanFailures[0].reason, /valuation exploded/);

  const codes = sweep.alerts.map((alert) => alert.code);
  assert.deepEqual(codes, ["DRAWDOWN_LIMIT", "SCAN_FAILED"], "critical sorts before warning, then by code");
  const failed = sweep.alerts.find((alert) => alert.code === "SCAN_FAILED");
  assert.equal(failed.severity, "warning", "legacy raised SCAN_FAILED as a warning");
  assert.equal(failed.ownerUserId, OTHER_OWNER, "the alert knows whose accounts could not be measured");
});

test("an account with no owner is reported rather than scanned under an invented identity", async (t) => {
  const { store, jobs } = await harness(t);
  const orphan = await store.withPaperTransaction((tx) => tx.createPaperAccount({
    owner_user_id: null,
    name: "Ownerless account",
    currency: "USD",
    starting_balance: 1_000,
    balance: 1_000,
    peak_equity: 1_000,
    revision: 0,
    created_at: new Date(BASE_TIME).toISOString(),
  }));

  const paper = scriptedPaper({});
  const sweep = await jobs(paper).portfolioRiskSweep();
  assert.equal(paper.calls.length, 0, "no owner-scoped scan was attempted for an ownerless account");
  assert.equal(sweep.scanFailures.length, 1);
  assert.equal(sweep.scanFailures[0].owner, null);
  assert.deepEqual(sweep.scanFailures[0].accountIds, [Number(orphan.id)]);
  assert.deepEqual(sweep.alerts.map((alert) => alert.code), ["SCAN_FAILED"]);
});

test("only transitions are raised: a breach that persists notifies once", async (t) => {
  const { store, jobs } = await harness(t);
  const account = await seedAccount(store, OWNER, "Breaching account");
  const breaches = [{ code: "DRAWDOWN_LIMIT", message: "drawdown 12% exceeds the 10% limit" }];
  const paper = scriptedPaper({ scans: { [OWNER]: [accountScan(account.id, breaches)] } });
  const run = jobs(paper);

  const first = await run.runOperations({ holder: "cron#1", timestamp: BASE_TIME });
  assert.equal(first.risk.raised, 1);
  assert.equal(first.risk.cleared, 0);
  assert.equal(first.risk.activeAlerts, 1);
  // "Every alert looks new" has two causes and an operator must be able to tell them
  // apart: a first run establishes the baseline, a fault re-sends what was already sent.
  assert.equal(first.risk.firstRun, true);
  assert.equal(first.risk.memoryReadable, true);

  // A cron running every minute would call this 1 440 times a day. Without the
  // persisted transition memory each call would re-alert on the same breach.
  const second = await run.runOperations({ holder: "cron#2", timestamp: BASE_TIME + 60_000 });
  assert.equal(second.risk.raised, 0, "the same breach is not new the second time");
  assert.equal(second.risk.cleared, 0);
  assert.equal(second.risk.activeAlerts, 1, "but it is still active, and still counted");
  assert.equal(second.risk.firstRun, false, "the baseline written by the first run was read back");
  assert.equal(second.risk.memoryReadable, true);

  const third = await run.runOperations({ holder: "cron#3", timestamp: BASE_TIME + 120_000 });
  assert.equal(third.risk.raised, 0);

  const alerts = await store.listNotifications(OWNER, { limit: 50 });
  const riskAlerts = alerts.filter((row) => row.type === PORTFOLIO_RISK_NOTIFICATION_TYPE);
  assert.equal(riskAlerts.length, 1, "three runs, one notification");
  assert.equal(riskAlerts[0].severity, "critical");
  assert.equal(riskAlerts[0].dedupe_key, `paper:${account.id}:DRAWDOWN_LIMIT`, "the dedupe key is the alert key");
  assert.equal(riskAlerts[0].user_id, null, "a portfolio risk alert is broadcast to operators, as legacy did");
  assert.equal(riskAlerts[0].detail.accountId, Number(account.id), "the account is in the payload even though legacy's title omits it");

  const raised = await store.listAuditEvents({ action: AUDIT_ACTIONS.riskAlert, limit: 50 });
  const raisedRows = raised.events ?? raised;
  assert.equal(raisedRows.length, 1, "one audit event per transition, not per run");
  assert.equal(raisedRows[0].entityId, `paper:${account.id}:DRAWDOWN_LIMIT`);
  assert.equal(raisedRows[0].details.legacyAction, LEGACY_ACTIONS.riskAlert);
  assert.equal(raisedRows[0].details.code, "DRAWDOWN_LIMIT");
});

test("an unreadable transition memory is reported as a fault, not as a first run", async (t) => {
  const context = await harness(t);
  const { store, jobs, notifications } = context;
  const account = await seedAccount(store, OWNER, "Breaching account");
  const paper = scriptedPaper({
    scans: { [OWNER]: [accountScan(account.id, [{ code: "DRAWDOWN_LIMIT", message: "drawdown 12% exceeds 10%" }])] },
  });

  // Establish a real baseline, then make it unreadable. Losing the memory must not
  // stop the sweep — a duplicate alert is noisy, a blind monitor is dangerous — but it
  // must be distinguishable from the harmless case of never having run.
  await jobs(paper).runOperations({ holder: "cron#1", timestamp: BASE_TIME });
  const broken = storeWith(store, {
    async loadJobState() {
      throw new Error("the state document could not be parsed");
    },
  });
  const brokenJobs = createScheduledJobs({
    store: broken,
    paper,
    execution: context.execution,
    notifications,
    log: SILENT,
    now: context.now,
  });

  const result = await brokenJobs.runOperations({ holder: "cron#2", timestamp: BASE_TIME + 60_000 });
  assert.equal(result.risk.memoryReadable, false);
  assert.equal(result.risk.firstRun, false, "a baseline existed; this is a fault, not a first run");
  assert.equal(result.risk.raised, 1, "the alert is raised again rather than the sweep refusing to run");
  assert.equal(result.completed, true);

  const alerts = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(alerts.filter((row) => row.type === PORTFOLIO_RISK_NOTIFICATION_TYPE).length, 1,
    "and Phase 9's unread dedupe still suppresses the duplicate while the first alert is unread");
});

test("a breach that goes away is audited as cleared and does not come back", async (t) => {
  const { store, jobs } = await harness(t);
  const account = await seedAccount(store, OWNER, "Recovering account");
  const breaching = scriptedPaper({
    scans: { [OWNER]: [accountScan(account.id, [{ code: "PORTFOLIO_EXPOSURE_LIMIT", message: "exposure 18% exceeds 15%" }])] },
  });
  const healthy = scriptedPaper({ scans: { [OWNER]: [accountScan(account.id, [])] } });

  const raised = await jobs(breaching).runOperations({ holder: "cron#1", timestamp: BASE_TIME });
  assert.equal(raised.risk.raised, 1);

  const cleared = await jobs(healthy).runOperations({ holder: "cron#2", timestamp: BASE_TIME + 60_000 });
  assert.equal(cleared.risk.cleared, 1);
  assert.equal(cleared.risk.raised, 0);
  assert.equal(cleared.risk.activeAlerts, 0);

  const clearedEvents = await store.listAuditEvents({ action: AUDIT_ACTIONS.riskCleared, limit: 50 });
  const rows = clearedEvents.events ?? clearedEvents;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entityId, `paper:${account.id}:PORTFOLIO_EXPOSURE_LIMIT`);
  assert.equal(rows[0].details.legacyAction, LEGACY_ACTIONS.riskCleared);
  assert.match(rows[0].details.summary, /^alert cleared: /, "legacy's cleared summary wording, kept");

  // Re-breaking must raise again: clearing the memory is what makes the next breach
  // newsworthy rather than permanently silenced.
  const again = await jobs(breaching).runOperations({ holder: "cron#3", timestamp: BASE_TIME + 120_000 });
  assert.equal(again.risk.raised, 1);
  assert.equal(again.risk.cleared, 0);
});

test("the persisted last report drops the diffing key and the classification flag", async (t) => {
  const { store, jobs } = await harness(t);
  const account = await seedAccount(store, OWNER, "Reported account");
  await jobs(scriptedPaper({
    scans: { [OWNER]: [accountScan(account.id, [{ code: "DAILY_LOSS_LIMIT", message: "daily loss 4% exceeds 3%" }], { accountName: "Reported account" })] },
  })).runOperations({ holder: "cron#1", timestamp: BASE_TIME });

  const report = await jobs().lastRiskReport();
  assert.equal(report.alerts.length, 1);
  assert.equal(report.alerts[0].code, "DAILY_LOSS_LIMIT");
  assert.equal(report.alerts[0].key, undefined, "the key is the diffing mechanism, not part of the finding");
  assert.equal(report.alerts[0].classified, undefined);
  assert.equal(report.alerts[0].scope, `paper:${account.id}`);

  const state = await store.loadJobState(PORTFOLIO_RISK_STATE_KEY);
  assert.deepEqual(Object.keys(state.alertKeys), [`paper:${account.id}:DAILY_LOSS_LIMIT`]);
  assert.equal(state.lastScanAt, new Date(BASE_TIME).toISOString());
});

test("every breach code the paper scan can emit is classified", async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "paper", "service.js"),
    "utf8",
  );
  const scan = source.slice(source.indexOf("async function portfolioRiskScan"));
  assert.ok(scan.length > 0, "portfolioRiskScan must still exist in the paper service");
  const emitted = [...scan.matchAll(/code: "([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]);
  const unique = [...new Set(emitted)].sort();
  assert.ok(unique.length >= 8, `expected the paper scan's breach vocabulary, found ${JSON.stringify(unique)}`);

  const unclassified = unique.filter((code) => !CRITICAL_BREACH_CODES.has(code) && !WARNING_BREACH_CODES.has(code));
  assert.deepEqual(
    unclassified,
    [],
    "a new breach code must be classified in src/jobs/scheduled.js, or it silently arrives as a warning-severity alert",
  );
  assert.equal(severityForBreachCode("DRAWDOWN_LIMIT"), "critical");
  assert.equal(severityForBreachCode("SYNTHETIC_EXPOSURE"), "warning");
  assert.equal(severityForBreachCode("SOMETHING_NEW"), "warning", "an unknown code degrades to a warning rather than throwing");
  assert.ok(WARNING_BREACH_CODES.has("SCAN_FAILED"), "SCAN_FAILED is produced by the sweep itself");
});

// ------------------------------------------------------------------ runOperations

test("a concurrent run is skipped and writes nothing", async (t) => {
  const { store, jobs } = await harness(t);
  const account = await seedAccount(store, OWNER, "Breaching account");
  const paper = scriptedPaper({
    scans: { [OWNER]: [accountScan(account.id, [{ code: "DRAWDOWN_LIMIT", message: "drawdown 12% exceeds 10%" }])] },
  });

  // Hold the lock the way a slow run would.
  const held = await store.acquireJobLock(OPERATIONS_JOB_NAME, {
    holder: "cron#slow",
    nowIso: new Date(BASE_TIME).toISOString(),
    expiresAt: new Date(BASE_TIME + 600_000).toISOString(),
  });
  assert.equal(held.acquired, true);

  const skipped = await jobs(paper).runOperations({ holder: "cron#fast", timestamp: BASE_TIME + 1_000 });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.lock.acquired, false);
  assert.equal(skipped.completed, false, "a skipped run did not complete its work");
  assert.equal(skipped.risk, null, "and did not scan");
  assert.equal(skipped.proposals, null);
  assert.match(skipped.lock.reason, /cron#slow/, "the skip names the holder");

  assert.deepEqual(paper.calls, [], "a skipped run never reached the paper service");
  const alerts = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(alerts.filter((row) => row.type === PORTFOLIO_RISK_NOTIFICATION_TYPE).length, 0);
  const runs = await store.listAuditEvents({ action: AUDIT_ACTIONS.cronRun, limit: 50 });
  assert.equal((runs.events ?? runs).length, 0, "a skipped run records no CRON_RUN — it did not run");
});

test("the run audits one system.job.run event as the system actor with the legacy summary", async (t) => {
  const { store, execution, jobs, advance } = await harness(t);
  const account = await seedAccount(store, OWNER, "Breaching account");
  await execution.propose(OWNER, INTENT);
  advance(EXPIRY_WINDOW_MS + 1_000);

  const paper = scriptedPaper({
    scans: { [OWNER]: [accountScan(account.id, [{ code: "DRAWDOWN_LIMIT", message: "drawdown 12% exceeds 10%" }])] },
  });
  const result = await jobs(paper).runOperations({ holder: "cron#1", timestamp: BASE_TIME });

  assert.equal(result.completed, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.lock.acquired, true);
  assert.equal(result.lock.released, true, "the lock is released by the run that took it");
  assert.equal(await store.findJobLock(OPERATIONS_JOB_NAME), null);
  assert.equal(result.proposals.expiredIds.length, 1);

  const runs = await store.listAuditEvents({ action: AUDIT_ACTIONS.cronRun, limit: 50 });
  const rows = runs.events ?? runs;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].actor, { userId: null, username: null, kind: "system" },
    "legacy emitted CRON_RUN with actor 'system', which Phase 10 renders as kind 'system'");
  assert.equal(rows[0].details.legacyAction, LEGACY_ACTIONS.cronRun);
  assert.equal(rows[0].entityId, OPERATIONS_JOB_NAME);
  assert.equal(
    rows[0].details.summary,
    "Scheduled operations: 1 account(s) scanned, 1 risk alert(s) active, 1 proposal(s) expired",
    "the summary sentence keeps legacy's exact wording so old and new cron logs read alike",
  );
  assert.deepEqual(rows[0].details.expiredIds, result.proposals.expiredIds);

  const asSystem = await store.listAuditEvents({ actor: "system", limit: 200 });
  const systemRows = asSystem.events ?? asSystem;
  assert.ok(systemRows.length >= 3, "the run, the alert and the expiry are all attributed to the system actor");
  assert.ok(systemRows.every((row) => row.actor.kind === "system" && row.actor.userId === null),
    "no scheduled write borrows an operator's identity");
});

test("a dry run takes no lock, so it cannot block the real run that follows it", async (t) => {
  const { store, jobs } = await harness(t);
  await seedAccount(store, OWNER, "Breaching account");
  const paper = scriptedPaper({
    scans: { [OWNER]: [accountScan(1, [{ code: "DRAWDOWN_LIMIT", message: "drawdown exceeds the limit" }])] },
  });

  const dry = await jobs(paper).runOperations({ holder: "cron#dry", timestamp: BASE_TIME, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.lock.acquired, false);
  assert.match(dry.lock.reason, /does not take the lock/);
  assert.equal(dry.risk.wouldRaise, 1);
  assert.equal(dry.risk.raised, undefined, "a dry run reports candidates, not outcomes");
  assert.equal(dry.proposals.dryRun, true);
  assert.equal(dry.completed, true);

  assert.equal(await store.findJobLock(OPERATIONS_JOB_NAME), null, "no lock row was written");
  const state = await store.loadJobState(PORTFOLIO_RISK_STATE_KEY);
  assert.equal(state, null, "the transition memory is untouched, so the real run still sees the alert as new");
  const alerts = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(alerts.filter((row) => row.type === PORTFOLIO_RISK_NOTIFICATION_TYPE).length, 0);

  // The real run that follows must still be able to take the floor.
  const real = await jobs(paper).runOperations({ holder: "cron#real", timestamp: BASE_TIME + 1_000 });
  assert.equal(real.lock.acquired, true);
  assert.equal(real.risk.raised, 1);
});

test("the lock is released even when a stage throws, and the failure is reported per stage", async (t) => {
  const { store, execution, jobs, advance } = await harness(t);
  await seedAccount(store, OWNER, "Any account");
  await execution.propose(OWNER, INTENT);
  advance(EXPIRY_WINDOW_MS + 1_000);

  // A paper service with no scan at all, so the failure happens before the per-owner
  // loop. A throwing `portfolioRiskScan` for ONE owner is absorbed by that loop as a
  // `SCAN_FAILED` alert — which is the point of the isolation — so this is the only
  // way to fail the stage itself and test what the `finally` block does about it.
  const unusable = { tradingState: async () => ({ tradingMode: "PAPER_TRADING" }) };

  const result = await jobs(unusable).runOperations({ holder: "cron#1", timestamp: BASE_TIME });
  assert.equal(result.lock.released, true, "a throwing stage must not leave the job locked until its TTL expires");
  assert.equal(await store.findJobLock(OPERATIONS_JOB_NAME), null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "portfolio-risk-scan");
  assert.match(result.errors[0].reason, /paper trading service/);
  assert.equal(result.risk, null);
  assert.equal(result.completed, true, "the run completed: one stage failed, the other did its work");
  assert.deepEqual(result.proposals.expiredIds.length, 1,
    "the proposal sweep still ran — an approval window lapsing unactioned is the more time-sensitive failure");

  // A stage error is still a failure the operator must see, which is why the CLI exits
  // 1 when `errors` is non-empty even though `completed` is true.
  assert.notDeepEqual(result.errors, []);
});

test("no HTTP route exposes the scheduled jobs", async (t) => {
  const { createFileStoreApp } = await import("./helpers.js");
  const { app, store, cleanup } = await createFileStoreApp({
    configOverrides: { env: { MARKET_DATA_REAL_PROVIDERS: "0", MARKET_DATA_ALLOW_SYNTHETIC: "1" } },
  });
  t.after(cleanup);

  assert.equal(typeof app.jobs.runOperations, "function", "the app exposes the jobs to a CLI, not to a client");
  assert.equal(typeof app.jobs.portfolioRiskSweep, "function");

  const routes = app.routes();
  assert.ok(routes.length >= 80, `expected the full route inventory, found ${routes.length}`);
  // Row 15 gives lottery a `GET /api/v1/lottery/jobs` — a READ of stored sync-run
  // history behind `lottery.view`, mirroring legacy's own `api_lottery/jobs` read
  // (`listJobRuns`). Reading the history is not running the schedule, so it is
  // exempted BY NAME and pinned as a guarded GET; any route that TRIGGERS
  // scheduled work still fails this scan.
  const lotteryJobsRead = routes.filter((route) => route.method === "GET" && route.path === "/api/v1/lottery/jobs");
  assert.equal(lotteryJobsRead.length, 1, "the lottery jobs history read exists, as a GET");
  const offenders = routes
    .filter((route) => !lotteryJobsRead.includes(route))
    .filter((route) => /job|cron|schedul|sweep|expire-stale|run-operations|stale/i.test(`${route.method} ${route.path}`));
  assert.deepEqual(offenders.map((route) => `${route.method} ${route.path}`), [],
    "runOperations takes no owner argument: it scans every account and expires every operator's proposals, so it must not be reachable over HTTP");

  // And the store surface it depends on is not reachable either: an HTTP client that
  // could read or clear a lock row could wedge or un-wedge the schedule.
  assert.equal(typeof store.acquireJobLock, "function");
  const lockRoutes = routes.filter((route) => /lock/i.test(route.path));
  assert.deepEqual(lockRoutes.map((route) => `${route.method} ${route.path}`), []);
});

// ------------------------------------------------------- MySQL adapter parity

/**
 * A recording executor for the MySQL side of the job repository.
 *
 * There is no real MySQL staging database yet (finding F-15), so the SQL shapes are
 * asserted here: which statement runs, with which bindings, and — critically — that
 * ownership is decided by reading the row back rather than by an affected-row count.
 */
function recordingExecutor({ rows = [], duplicateInsert = false, stealAffectedRows = 0 } = {}) {
  const calls = [];
  const stored = rows.map((row) => ({ ...row }));
  const duplicate = Object.assign(new Error("Duplicate entry for key 'PRIMARY'"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
  });
  return {
    calls,
    stored,
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (/^\s*UPDATE wf_job_locks\s+SET holder/i.test(sql)) return [{ affectedRows: stealAffectedRows }, []];
      if (/^\s*INSERT INTO wf_job_locks/i.test(sql)) {
        if (duplicateInsert) throw duplicate;
        stored.push({ job_name: values[0], holder: values[1], acquired_at: values[2], expires_at: values[3] });
        return [{ affectedRows: 1 }, []];
      }
      if (/^\s*DELETE FROM wf_job_locks/i.test(sql)) {
        const index = stored.findIndex((row) => row.job_name === values[0] && row.holder === values[1]);
        if (index === -1) return [{ affectedRows: 0 }, []];
        stored.splice(index, 1);
        return [{ affectedRows: 1 }, []];
      }
      if (/^\s*SELECT/i.test(sql)) return [stored.filter((row) => row.job_name === values[0]), []];
      return [{ affectedRows: 0 }, []];
    },
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/wf_job_locks/.test(sql)) return [stored.filter((row) => !values.length || row.job_name === values[0]), []];
      if (/wf_execution_proposals/.test(sql)) return [stored, []];
      return [stored, []];
    },
  };
}

test("the MySQL acquire path decides ownership by reading the row back, not by affectedRows", async () => {
  const nowIso = new Date(BASE_TIME).toISOString();
  const expiresAt = new Date(BASE_TIME + 600_000).toISOString();

  // A duplicate key means a live holder got there first. The refusal must name them.
  const contended = recordingExecutor({
    rows: [{ job_name: OPERATIONS_JOB_NAME, holder: "cron#other", acquired_at: nowIso, expires_at: expiresAt }],
    duplicateInsert: true,
  });
  const refused = await createJobRepository(contended).acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#mine", nowIso, expiresAt });
  assert.equal(refused.acquired, false);
  assert.equal(refused.lock.holder, "cron#other");
  assert.match(refused.reason, /cron#other/);

  // The case that would silently break mutual exclusion: the steal UPDATE reports a
  // changed row, but the row that changed is not ours. MySQL's affectedRows counts
  // *changed* rows, and a concurrent writer can land between the UPDATE and the
  // read, so the count must never be trusted as ownership.
  const lying = recordingExecutor({
    rows: [{ job_name: OPERATIONS_JOB_NAME, holder: "cron#other", acquired_at: nowIso, expires_at: expiresAt }],
    stealAffectedRows: 1,
  });
  const lied = await createJobRepository(lying).acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#mine", nowIso, expiresAt });
  assert.equal(lied.acquired, false, "affectedRows said 1 but the row belongs to someone else");
  assert.equal(lied.lock.holder, "cron#other");
  assert.equal(lying.calls.filter((call) => /^\s*DELETE/i.test(call.sql)).length, 0, "and nothing was deleted to make room");
});

test("the MySQL lock statements are holder-scoped and the instants are canonical UTC", async () => {
  const executor = recordingExecutor();
  const repository = createJobRepository(executor);
  const nowIso = new Date(BASE_TIME).toISOString();
  await repository.releaseJobLock(OPERATIONS_JOB_NAME, "cron#1");
  await repository.extendJobLock(OPERATIONS_JOB_NAME, "cron#1", new Date(BASE_TIME + 900_000).toISOString());

  const [release, extend] = executor.calls;
  assert.match(release.sql, /DELETE FROM wf_job_locks WHERE job_name = \? AND holder = \?/, "an unscoped DELETE would unlock whoever holds it");
  assert.match(extend.sql, /UPDATE wf_job_locks SET expires_at = \? WHERE job_name = \? AND holder = \?/);

  // `gmdate('c')` emits `+00:00`, which sorts AFTER the `Z` form of the same
  // instant. A mixed-format `expires_at` would read as still live after expiring and
  // two runs would overlap, so offsets are refused outright.
  for (const bad of ["2026-10-11T12:00:00+00:00", "2026-10-11T13:00:00+01:00", "not-a-date", ""]) {
    await assert.rejects(
      repository.acquireJobLock(OPERATIONS_JOB_NAME, { holder: "cron#1", nowIso: bad, expiresAt: new Date(BASE_TIME + 1_000).toISOString() }),
      TypeError,
      `nowIso ${JSON.stringify(bad)} must be refused`,
    );
  }
  await assert.rejects(
    repository.acquireJobLock(OPERATIONS_JOB_NAME, {
      holder: "cron#1",
      nowIso,
      // A lock that expires at or before the instant it is taken would be dead on
      // arrival, and the next run would immediately steal it.
      expiresAt: nowIso,
    }),
    TypeError,
  );
});

test("the MySQL cross-owner proposal read binds no owner and stays bounded", async () => {
  const executor = recordingExecutor({ rows: [] });
  const repository = createExecutionRepository(executor);
  await repository.listExecutionProposalsAllOwners({ status: "PENDING_APPROVAL", limit: 200 });

  const call = executor.calls.at(-1);
  assert.match(call.sql, /FROM wf_execution_proposals/);
  assert.ok(!/owner_user_id\s*=/i.test(call.sql), "the cross-owner read must not filter by owner");
  assert.deepEqual(call.values, ["PENDING_APPROVAL"], "only the status is bound");
  assert.match(call.sql, /ORDER BY p\.created_at ASC, p\.proposal_id ASC/, "oldest first, so a bounded batch drains the backlog in the order it accrued");
  assert.match(call.sql, /LIMIT 200/);

  await repository.listExecutionProposalsAllOwners({ status: "PENDING_APPROVAL", limit: 100_000 });
  assert.match(executor.calls.at(-1).sql, /LIMIT 500/, "the ceiling is enforced in SQL, not left to the caller");
});
