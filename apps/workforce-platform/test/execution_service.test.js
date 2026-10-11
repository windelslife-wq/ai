import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { createExecutionService } from "../src/modules/execution/service.js";
import { DEFAULT_PAPER_TRADING_STATE } from "../src/modules/paper/service.js";

const OWNER = 7;
const OTHER_OWNER = 8;
const BASE_TIME = Date.parse("2026-10-11T12:00:00.000Z");
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

async function harness(t, { paperSubmit = null, strategies = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-execution-service-"));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const enabledState = structuredClone(DEFAULT_PAPER_TRADING_STATE);
  enabledState.tradingMode = "PAPER_TRADING";
  enabledState.killSwitch = { active: false, activatedAt: null, reason: null };
  let nowValue = BASE_TIME;
  const calls = [];
  const paper = {
    async tradingState() {
      return { tradingMode: "PAPER_TRADING", killSwitch: { active: false }, simulationOnly: true, liveTradingEnabled: false };
    },
    async submitOrder(ownerUserId, accountId, order, options) {
      calls.push({ ownerUserId, accountId, order, options });
      if (paperSubmit) return paperSubmit(ownerUserId, accountId, order, options);
      return {
        filled: true,
        order: { id: 41, status: "FILLED", synthetic: true, rejectReasons: [] },
        position: { id: 52, status: "OPEN", synthetic: true },
        riskDecision: { approved: true, reasons: [], warnings: ["synthetic quote"] },
      };
    },
  };
  await store.withPaperTransaction(async (tx) => {
    await tx.saveTradingState(enabledState, { updatedByUserId: OWNER, updatedAt: new Date(BASE_TIME).toISOString() });
    await tx.createPaperAccount({
      owner_user_id: OWNER,
      name: "Execution test account",
      currency: "USD",
      starting_balance: 10_000,
      balance: 10_000,
      peak_equity: 10_000,
      revision: 0,
      created_at: new Date(BASE_TIME).toISOString(),
    });
  });
  const service = createExecutionService({ store, paper, strategies, now: () => nowValue });
  return {
    store,
    service,
    calls,
    setNow(value) { nowValue = value; },
    async addStrategy(record) { return store.saveStrategy(record); },
  };
}

function isAppError(code, statusCode) {
  return (error) => error?.code === code && error?.statusCode === statusCode;
}

test("proposal decisions are explicit, owner-bound and permit one simulation-only paper submission", async (t) => {
  let releasePaper;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const paperGate = new Promise((resolve) => { releasePaper = resolve; });
  const { store, service, calls } = await harness(t, {
    paperSubmit: async () => {
      markStarted();
      await paperGate;
      return {
        filled: true,
        order: { id: 41, status: "FILLED", synthetic: true, rejectReasons: [] },
        position: { id: 52, status: "OPEN", synthetic: true },
        riskDecision: { approved: true, reasons: [], warnings: ["synthetic quote"] },
      };
    },
  });

  const created = await service.propose(OWNER, INTENT);
  assert.equal(created.status, "PENDING_APPROVAL");
  assert.equal(created.intent.symbol, "EURUSD", "the service normalizes values before persistence");
  assert.equal(created.intent.marketClass, "forex");
  assert.equal(created.intent.side, "BUY");
  assert.equal(created.intent.type, "MARKET");
  assert.equal(created.simulationOnly, true);
  assert.equal(created.liveTradingEnabled, false);
  assert.equal(created.checks.some((check) => !check.ok), false);

  assert.deepEqual((await service.list(OTHER_OWNER)).proposals, [], "a foreign owner cannot list the proposal");
  await assert.rejects(service.find(OTHER_OWNER, created.id), isAppError("EXECUTION_PROPOSAL_NOT_FOUND", 404));
  await assert.rejects(service.submitToPaper(OWNER, created.id), isAppError("PAPER_SUBMISSION_NOT_APPROVED", 409));
  assert.equal(calls.length, 0, "pending proposals cannot reach Paper Trading");

  const approved = await service.decide(OWNER, created.id, {
    approve: true,
    reason: "I reviewed the risk and explicitly approve paper simulation",
  });
  assert.equal(approved.proposal.status, "APPROVED");
  assert.equal(approved.proposal.decisionByUserId, OWNER);
  assert.equal(approved.proposal.decisionReason, "I reviewed the risk and explicitly approve paper simulation");

  const submitting = service.submitToPaper(OWNER, created.id);
  await started;
  await assert.rejects(
    service.submitToPaper(OWNER, created.id),
    isAppError("PAPER_SUBMISSION_NOT_APPROVED", 409),
    "a concurrent/repeated submit cannot claim a row already in PAPER_SUBMITTING",
  );
  releasePaper();
  const result = await submitting;

  assert.equal(calls.length, 1, "the owner-scoped claim gates the paper service to one attempt");
  assert.equal(calls[0].ownerUserId, OWNER);
  assert.equal(calls[0].accountId, 1);
  assert.equal(calls[0].order.symbol, "EURUSD");
  assert.equal(calls[0].order.side, "BUY");
  assert.equal(calls[0].options.actorId, OWNER);
  assert.equal(result.proposal.status, "PAPER_EXECUTED");
  assert.equal(result.proposal.paperOrderId, 41);
  assert.equal(result.paper.order.synthetic, true, "synthetic provenance is preserved, never laundered");
  assert.equal(result.paper.simulationOnly, true);
  assert.equal(result.paper.liveTradingEnabled, false);
  await assert.rejects(service.submitToPaper(OWNER, created.id), isAppError("PAPER_SUBMISSION_NOT_APPROVED", 409));
  assert.equal(calls.length, 1);

  const audit = (await store.snapshot()).audit.filter((event) => event.entity_id === created.id);
  // Three of these are refusals, and each corresponds to an attempt this test
  // deliberately made. Legacy routed every routing refusal through `routingBlocked()`,
  // which audited `EXECUTION_ROUTING_BLOCKED`; a bare 409 left no evidence that anyone
  // had tried. The middle one is the interesting case: a second submit racing a row
  // already in PAPER_SUBMITTING is a bypass attempt, and it is now reconstructable.
  assert.deepEqual(audit.map((event) => event.action_key), [
    "execution.proposal.created",
    "execution.paper-submission.blocked",   // submitted while PENDING_APPROVAL
    "execution.proposal.approved",
    "execution.paper-submission.started",
    "execution.paper-submission.blocked",   // concurrent submit against PAPER_SUBMITTING
    "execution.paper-submission.completed",
    "execution.paper-submission.blocked",   // resubmitted after PAPER_EXECUTED
  ]);

  const blocked = audit.filter((event) => event.action_key === "execution.paper-submission.blocked");
  assert.equal(blocked.length, 3);
  for (const event of blocked) {
    assert.equal(event.detail_json.legacyAction, "EXECUTION_ROUTING_BLOCKED");
    assert.equal(event.detail_json.code, "PAPER_SUBMISSION_NOT_APPROVED");
    assert.equal(event.detail_json.orderCreated, false, "a refused submission must record that no order exists");
    assert.equal(event.detail_json.retryable, true, "and that the proposal is still usable");
    assert.equal(event.actor_user_id, OWNER, "the attempt is attributed to whoever made it");
  }
  assert.deepEqual(blocked.map((event) => event.detail_json.proposalStatus),
    ["PENDING_APPROVAL", "PAPER_SUBMITTING", "PAPER_EXECUTED"],
    "each record says what state the proposal was actually in when it was refused");

  // `ROUTING_BLOCKED` is reserved for the platform being unable to route. Broadcasting
  // it because a caller submitted the wrong proposal would say the platform is down
  // when it is not, so this class records evidence and stays quiet.
  const inbox = await store.listNotifications(OWNER, { limit: 50 });
  assert.equal(inbox.filter((row) => row.type === "ROUTING_BLOCKED").length, 0);
  assert.ok(audit.every((event) => event.actor_user_id === OWNER));
  assert.equal(service.route, undefined, "there is no generic or live routing method");
  assert.equal(service.statusSnapshot().liveTradingEnabled, false);
});

test("governance failures are persisted as rejected proposals and approval expires after four hours", async (t) => {
  const { store, service, setNow, calls } = await harness(t);
  await store.withPaperTransaction(async (tx) => {
    const state = structuredClone(DEFAULT_PAPER_TRADING_STATE);
    state.tradingMode = "PAPER_TRADING";
    state.killSwitch = { active: true, activatedAt: new Date(BASE_TIME).toISOString(), reason: "operator stop" };
    await tx.saveTradingState(state, { updatedByUserId: OWNER, updatedAt: new Date(BASE_TIME).toISOString() });
  });
  const blocked = await service.propose(OWNER, INTENT);
  assert.equal(blocked.status, "REJECTED");
  assert.equal(blocked.checks[0].check, "kill-switch");
  assert.equal(blocked.checks[0].ok, false);
  await assert.rejects(service.submitToPaper(OWNER, blocked.id), isAppError("PAPER_SUBMISSION_NOT_APPROVED", 409));
  assert.equal(calls.length, 0);

  await store.withPaperTransaction(async (tx) => {
    const state = structuredClone(DEFAULT_PAPER_TRADING_STATE);
    state.tradingMode = "PAPER_TRADING";
    state.killSwitch = { active: false, activatedAt: null, reason: null };
    await tx.saveTradingState(state, { updatedByUserId: OWNER, updatedAt: new Date(BASE_TIME).toISOString() });
  });
  const pending = await service.propose(OWNER, INTENT);
  setNow(BASE_TIME + 4 * 60 * 60_000 + 1);
  const expired = await service.find(OWNER, pending.id);
  assert.equal(expired.proposal.status, "EXPIRED");
  await assert.rejects(service.decide(OWNER, pending.id, {
    approve: true,
    reason: "This approval is too late because it expired",
  }), isAppError("EXECUTION_DECISION_CLOSED", 409));
});

test("an AI strategy proposal needs an executable exact version, APPROVED lifecycle and persisted human sign-off", async (t) => {
  const registry = {
    implementation(id, version) { return id === "reviewed-ai" && version === "1.2.0" ? () => null : null; },
  };
  const { store, service, addStrategy } = await harness(t, { strategies: { registry } });
  const record = {
    strategy_id: "reviewed-ai",
    version: "1.2.0",
    source: "ai",
    lifecycle: "APPROVED",
    human_signoff: null,
    created_at: new Date(BASE_TIME).toISOString(),
    updated_at: new Date(BASE_TIME).toISOString(),
  };
  await addStrategy(record);
  const input = { ...INTENT, strategyId: "REVIEWED-AI", strategyVersion: "1.2.0" };
  const missingSignoff = await service.propose(OWNER, input);
  assert.equal(missingSignoff.status, "REJECTED");
  assert.match(missingSignoff.checks.find((check) => check.check === "strategy").detail, /human risk sign-off/);

  await store.saveStrategy({
    ...record,
    human_signoff: { actor_user_id: OWNER, reason: "AI risk review was completed by an operator", signed_at: new Date(BASE_TIME).toISOString() },
  });
  const signedOff = await service.propose(OWNER, input);
  assert.equal(signedOff.status, "PENDING_APPROVAL");
  assert.equal(signedOff.intent.strategyId, "reviewed-ai");
  assert.equal(signedOff.intent.strategyVersion, "1.2.0");
  assert.equal(signedOff.checks.find((check) => check.check === "strategy").ok, true);
});

test("unowned paper-account identifiers are rejected before proposal storage or strategy lookup", async (t) => {
  let lookups = 0;
  const strategies = { registry: { implementation() { lookups += 1; return () => null; } } };
  const { store, service } = await harness(t, { strategies });
  const before = (await store.snapshot()).executionProposals.length;
  await assert.rejects(service.propose(OTHER_OWNER, INTENT), isAppError("PAPER_ACCOUNT_NOT_FOUND", 404));
  assert.equal((await store.snapshot()).executionProposals.length, before);
  assert.equal(lookups, 0);
});
