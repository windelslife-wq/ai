/**
 * Execution governance at submission time (row 12 — bypass and recovery).
 *
 * The property under test is the one legacy `ExecutionSupervisor::route()` existed to
 * guarantee: **steps 1–2 are re-verified when the order is actually routed**, not only
 * when the proposal was evaluated. An approval granted while the platform was live must
 * not become an order after the kill switch is thrown.
 *
 * Node had the re-verification but two things were missing. Nothing tested it, and a
 * refused attempt left no trace: legacy's `routingBlocked()` audited
 * `EXECUTION_ROUTING_BLOCKED` and published a `ROUTING_BLOCKED` notification deduped to
 * one per UTC day, while this port threw a bare 409. "Who tried to route an order while
 * the platform was stopped, and when" is the first question a governance review asks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { createExecutionService } from "../src/modules/execution/service.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import { DEFAULT_PAPER_TRADING_STATE } from "../src/modules/paper/service.js";
import { AppError } from "../src/http/errors.js";

const OWNER = 7;
const OTHER_OWNER = 8;
const BASE_TIME = Date.parse("2026-10-11T12:00:00.000Z");
const DAY_MS = 86_400_000;
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

function isAppError(code, status) {
  return (error) => error instanceof AppError && error.code === code && error.statusCode === status;
}

/** Governance state writer: the only way these tests move the kill switch or the mode. */
async function setGovernance(store, { tradingMode = "PAPER_TRADING", killSwitch = false, reason = null } = {}) {
  const state = structuredClone(DEFAULT_PAPER_TRADING_STATE);
  state.tradingMode = tradingMode;
  state.killSwitch = {
    active: killSwitch,
    activatedAt: killSwitch ? new Date(BASE_TIME).toISOString() : null,
    reason: killSwitch ? reason ?? "operator stop" : null,
  };
  await store.withPaperTransaction((tx) => tx.saveTradingState(state, {
    updatedByUserId: OWNER,
    updatedAt: new Date(BASE_TIME).toISOString(),
  }));
}

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-execution-governance-"));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  let clock = BASE_TIME;
  const now = () => clock;
  const paperCalls = [];
  let releasePaper = () => {};
  const paperGate = new Promise((resolve) => { releasePaper = resolve; });

  const paper = {
    async tradingState() {
      return { tradingMode: "PAPER_TRADING", killSwitch: { active: false }, simulationOnly: true, liveTradingEnabled: false };
    },
    async submitOrder(ownerUserId, accountId, order, options) {
      paperCalls.push({ ownerUserId, accountId, order, options });
      await paperGate;
      return {
        filled: true,
        order: { id: 41, status: "FILLED", synthetic: true, rejectReasons: [] },
        position: { id: 52, status: "OPEN", synthetic: true },
        riskDecision: { approved: true, reasons: [], warnings: [] },
      };
    },
  };

  await store.withPaperTransaction((tx) => tx.createPaperAccount({
    owner_user_id: OWNER,
    name: "Governance test account",
    currency: "USD",
    starting_balance: 10_000,
    balance: 10_000,
    peak_equity: 10_000,
    revision: 0,
    created_at: new Date(BASE_TIME).toISOString(),
  }));
  await setGovernance(store);

  const notifications = createNotificationService({ store, now, log: SILENT });
  const service = createExecutionService({ store, paper, strategies: null, notifications, log: SILENT, now });

  return {
    store,
    service,
    notifications,
    paperCalls,
    releasePaper,
    advance: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
    /** An APPROVED proposal, ready to submit. */
    async approvedProposal(intent = INTENT) {
      const created = await service.propose(OWNER, intent);
      assert.equal(created.status, "PENDING_APPROVAL");
      // The decision reason has a 10-character floor (`INVALID_DECISION_REASON`), which
      // is the point: an approval must carry a justification an auditor can read.
      const decided = await service.decide(OWNER, created.id, { approve: true, reason: "I reviewed the risk and approve this paper simulation" });
      assert.equal(decided.proposal.status, "APPROVED");
      return decided.proposal;
    },
    async auditOf(proposalId, action = null) {
      const rows = (await store.snapshot()).audit.filter((event) => String(event.entity_id) === String(proposalId));
      return action ? rows.filter((event) => event.action_key === action) : rows;
    },
    async blockedNotifications() {
      const inbox = await store.listNotifications(OWNER, { limit: 200 });
      return inbox.filter((row) => row.type === "ROUTING_BLOCKED");
    },
  };
}

test("an approval granted while the platform was live cannot become an order after the kill switch is thrown", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();

  // The gate legacy re-verified at routing time: the world changed between the
  // evaluation and the submission, and the submission must see the new world.
  await setGovernance(h.store, { killSwitch: true, reason: "operator hit the stop" });

  await assert.rejects(
    h.service.submitToPaper(OWNER, proposal.id),
    isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409),
  );

  assert.equal(h.paperCalls.length, 0, "the paper engine was never reached, so no order exists");

  const after = await h.service.find(OWNER, proposal.id);
  assert.equal(after.proposal.status, "APPROVED",
    "a blocked attempt does not consume the proposal — legacy left the status alone so the attempt stays retryable");
  assert.equal(after.proposal.paperOrderId, null);
});

test("a governance-blocked attempt leaves audit evidence that survives the rolled-back transaction", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();
  const before = await h.auditOf(proposal.id);

  await setGovernance(h.store, { killSwitch: true });
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));

  // The refusal is detected INSIDE the paper transaction, which then rolls back. An
  // audit event written inside that transaction would roll back with it and the
  // evidence would silently not exist, so it is written outside. Exactly one event,
  // not zero (rolled back) and not two (written twice).
  const blocked = await h.auditOf(proposal.id, "execution.paper-submission.blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].detail_json.legacyAction, "EXECUTION_ROUTING_BLOCKED");
  assert.equal(blocked[0].detail_json.code, "EXECUTION_GOVERNANCE_BLOCKED");
  assert.match(blocked[0].detail_json.reason, /kill switch active/);
  assert.equal(blocked[0].detail_json.proposalStatus, "APPROVED");
  assert.equal(blocked[0].detail_json.orderCreated, false);
  assert.equal(blocked[0].detail_json.retryable, true);
  assert.equal(blocked[0].actor_user_id, OWNER,
    "legacy attributed the block to 'system'; the attempt was made by an identified operator and the trail says which");

  const all = await h.auditOf(proposal.id);
  assert.equal(all.length, before.length + 1, "the blocked attempt added one event and changed nothing else");
});

test("ROUTING_BLOCKED is broadcast once per UTC day however many attempts are refused", async (t) => {
  const h = await harness(t);
  const first = await h.approvedProposal();
  const second = await h.approvedProposal({ ...INTENT, reason: "A second reviewed setup" });
  await setGovernance(h.store, { killSwitch: true });

  await assert.rejects(h.service.submitToPaper(OWNER, first.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  await assert.rejects(h.service.submitToPaper(OWNER, second.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  h.advance(60_000);
  await assert.rejects(h.service.submitToPaper(OWNER, first.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));

  const alerts = await h.blockedNotifications();
  assert.equal(alerts.length, 1, "three refusals on one UTC day produce one alert — legacy's `routing-blocked:` . gmdate('Ymd') dedupe");
  assert.equal(alerts[0].severity, "warning");
  assert.equal(alerts[0].dedupe_key, "routing-blocked:20261011");
  assert.equal(alerts[0].user_id, null, "broadcast to operators, as legacy did — a stopped platform is everyone's business");
  assert.equal(alerts[0].detail.orderCreated, false);

  // Every attempt is still audited individually: the alert is de-noised, the evidence
  // is not.
  assert.equal((await h.auditOf(first.id, "execution.paper-submission.blocked")).length, 2);
  assert.equal((await h.auditOf(second.id, "execution.paper-submission.blocked")).length, 1);

  // The next UTC day is a new condition, so it alerts again.
  h.advance(DAY_MS);
  await assert.rejects(h.service.submitToPaper(OWNER, first.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  const nextDay = await h.blockedNotifications();
  assert.equal(nextDay.length, 2, "a platform still blocked the next day says so again");
  // `listNotifications` is newest-first, so the new alert is at index 0.
  assert.equal(nextDay[0].dedupe_key, "routing-blocked:20261012");
  assert.equal(nextDay[1].dedupe_key, "routing-blocked:20261011");
});

test("a trading-mode change blocks submission the same way the kill switch does", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();

  await setGovernance(h.store, { tradingMode: "ANALYSIS_ONLY" });
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));

  assert.equal(h.paperCalls.length, 0);
  const blocked = await h.auditOf(proposal.id, "execution.paper-submission.blocked");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].detail_json.reason, /not PAPER_TRADING/);
  assert.equal((await h.blockedNotifications()).length, 1);

  const after = await h.service.find(OWNER, proposal.id);
  assert.equal(after.proposal.status, "APPROVED", "still retryable once the mode is restored");
});

test("recovery: the same proposal submits once governance is restored, and only once", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();

  await setGovernance(h.store, { killSwitch: true });
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  assert.equal(h.paperCalls.length, 0);

  // The operator releases the stop. Nothing about the proposal had to be recreated.
  await setGovernance(h.store, { killSwitch: false });
  const submitting = h.service.submitToPaper(OWNER, proposal.id);
  h.releasePaper();
  const result = await submitting;

  assert.equal(result.proposal.status, "PAPER_EXECUTED");
  assert.equal(result.proposal.paperOrderId, 41);
  assert.equal(h.paperCalls.length, 1, "two blocked attempts and one successful submission reached the paper engine exactly once");

  // And the at-most-once claim still holds afterwards.
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("PAPER_SUBMISSION_NOT_APPROVED", 409));
  assert.equal(h.paperCalls.length, 1);

  // The trail reconstructs the whole story in the order it happened: created,
  // approved, two refusals while the platform was stopped, one successful submission
  // after it was released, and a final refusal because the proposal was consumed.
  const actions = (await h.auditOf(proposal.id)).map((event) => event.action_key);
  assert.deepEqual(actions, [
    "execution.proposal.created",
    "execution.proposal.approved",
    "execution.paper-submission.blocked",
    "execution.paper-submission.blocked",
    "execution.paper-submission.started",
    "execution.paper-submission.completed",
    "execution.paper-submission.blocked",
  ]);
});

test("governance is re-verified per owner: a blocked platform blocks every owner, not just the one who asked", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();
  await setGovernance(h.store, { killSwitch: true });

  // A foreign owner cannot even see the proposal, and the refusal they get is the
  // owner-scoped 404 rather than a governance answer — governance state must not
  // become a way to probe another operator's proposals.
  await assert.rejects(h.service.submitToPaper(OTHER_OWNER, proposal.id), isAppError("EXECUTION_PROPOSAL_NOT_FOUND", 404));
  assert.equal(h.paperCalls.length, 0);

  const foreignBlocked = (await h.store.snapshot()).audit.filter(
    (event) => event.action_key === "execution.paper-submission.blocked" && event.actor_user_id === OTHER_OWNER,
  );
  assert.equal(foreignBlocked.length, 0, "a 404 is not a routing refusal and records no blocked-submission evidence");

  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
});

test("the evidence write cannot mask the refusal, and a refusal cannot be turned into a success", async (t) => {
  const h = await harness(t);
  const proposal = await h.approvedProposal();
  await setGovernance(h.store, { killSwitch: true });

  // Break the audit writer. The refusal must still reach the caller with its real
  // code: an evidence outage must not look like a governance outage, and must
  // certainly not let a blocked submission through.
  const realRecordAudit = h.store.recordAudit.bind(h.store);
  h.store.recordAudit = async () => { throw new Error("the audit writer is down"); };
  await assert.rejects(h.service.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  assert.equal(h.paperCalls.length, 0, "the paper engine was still not reached");
  h.store.recordAudit = realRecordAudit;

  // The service objects are frozen, so a failing notifier is injected rather than
  // patched onto the real one. Same expectation: the refusal still surfaces.
  const loudService = createExecutionService({
    store: h.store,
    paper: { tradingState: async () => ({}), submitOrder: async () => { throw new Error("must not be called"); } },
    strategies: null,
    notifications: { notify: async () => { throw new Error("the notifier is down"); } },
    log: SILENT,
    now: () => BASE_TIME,
  });
  await assert.rejects(loudService.submitToPaper(OWNER, proposal.id), isAppError("EXECUTION_GOVERNANCE_BLOCKED", 409));
  assert.equal(h.paperCalls.length, 0);

  const after = await h.service.find(OWNER, proposal.id);
  assert.equal(after.proposal.status, "APPROVED", "still retryable after both evidence writers failed");
});
