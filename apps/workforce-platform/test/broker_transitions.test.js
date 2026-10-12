/**
 * Broker health transitions in the scheduled sweep (row 13).
 *
 * Legacy published `BROKER_CONNECTED` and `BROKER_DISCONNECTED` from inside
 * `PortfolioRiskMonitor::brokerAlerts()`, which ran between the account checks and
 * the transition diff of the same cron sweep. Phase 12 ported that sweep for
 * `PORTFOLIO_RISK` only, because there were no connectors to watch; these two types
 * have been on the NV-6 list of declared-but-unpublished notification types ever
 * since. This file is what takes them off it.
 *
 * The behaviour that matters is the *negative* one: `DISABLED` is never counted. A
 * default deployment has ten disabled connectors and must stay silent, or every
 * host would raise ten critical alerts on the first cron run after this phase.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { PORTFOLIO_RISK_STATE_KEY } from "../src/db/job-repository.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import {
  AUDIT_ACTIONS,
  BROKER_CONNECTED_NOTIFICATION_TYPE,
  BROKER_DISCONNECTED_NOTIFICATION_TYPE,
  LEGACY_ACTIONS,
  createScheduledJobs,
} from "../src/jobs/scheduled.js";

const BASE_TIME = Date.parse("2026-10-12T06:00:00Z");
const SILENT = { warn() {}, error() {}, info() {}, debug() {} };

/** A registry whose connector states the test sets directly. */
function fakeRegistry(states) {
  const calls = { allStatus: 0 };
  return {
    calls,
    states,
    allStatus: async () => {
      calls.allStatus += 1;
      if (typeof states.current === "function") return states.current();
      return { ...states.current };
    },
  };
}

/** A registry that cannot report at all. */
function throwingRegistry(message = "probe exploded") {
  return { allStatus: async () => { throw new Error(message); } };
}

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-transitions-"));
  const store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  const state = { clock: BASE_TIME };
  const now = () => state.clock;
  const notifications = createNotificationService({ store, now, log: SILENT });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * A paper service with no accounts, so the sweep produces no account alerts and
   * every alert in the report came from a connector. `portfolioRiskScan` must exist
   * or the whole stage refuses to run with PAPER_SERVICE_UNAVAILABLE.
   */
  const emptyPaper = { portfolioRiskScan: async () => ({ accounts: [], totals: { accounts: 0 } }) };
  const noProposals = { expireStaleProposals: async () => ({ expired: 0, scanned: 0, dryRun: false }) };

  return {
    store,
    notifications,
    now,
    advance: (ms) => { state.clock += ms; },
    jobs(brokers) {
      return createScheduledJobs({
        store,
        paper: emptyPaper,
        execution: noProposals,
        notifications,
        brokers,
        log: SILENT,
        now,
      });
    },
    async auditEvents() {
      const rows = await store.listAuditEvents({ limit: 500 });
      return rows.events ?? rows;
    },
    async inbox() {
      return store.listNotifications(null, { limit: 200 });
    },
    async jobState() {
      return store.loadJobState(PORTFOLIO_RISK_STATE_KEY);
    },
  };
}

test("ten disabled connectors are silent, run after run", async (t) => {
  const context = await harness(t);
  const disabled = {};
  for (const id of ["mt5-bridge", "mt4-bridge", "binance", "bybit", "okx", "coinbase", "kraken", "ib", "alpaca", "oanda"]) {
    disabled[id] = { state: "DISABLED", configured: false };
  }
  const registry = fakeRegistry({ current: disabled });
  const jobs = context.jobs(registry);

  const first = await jobs.runOperations({ holder: "cron#1" });
  context.advance(60_000);
  const second = await jobs.runOperations({ holder: "cron#2" });

  for (const [label, result] of [["first", first], ["second", second]]) {
    assert.equal(result.completed, true, label);
    assert.equal(result.risk.alerts, 0, `${label} run raised no alerts`);
    assert.deepEqual(result.risk.codes, [], label);
    assert.deepEqual(result.risk.brokerDisconnected, [], label);
    assert.deepEqual(result.risk.brokerReconnected, [], label);
    assert.equal(result.risk.brokerConnectors, 10, `${label} run still reports all ten`);
    assert.equal(result.risk.brokerError, null, label);
  }

  assert.deepEqual(await context.inbox(), [], "a connector nobody enabled is not an outage");
  const events = await context.auditEvents();
  assert.deepEqual(
    events.filter((event) => String(event.action).startsWith("brokers.")),
    [],
    "no broker audit event was written",
  );

  // The states are still persisted, so a connector that later becomes READY and
  // then DOWN is detected rather than being treated as new.
  const persisted = await context.jobState();
  assert.deepEqual(persisted.brokerStates, Object.fromEntries(Object.keys(disabled).map((id) => [id, "DISABLED"])));
});

test("READY to DOWN is audited, broadcast as critical, and joins the alert list", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "READY" }, alpaca: { state: "DISABLED" } } });
  const jobs = context.jobs(registry);

  const baseline = await jobs.runOperations({ holder: "cron#1" });
  assert.deepEqual(baseline.risk.brokerDisconnected, [], "a first sighting of READY is not a transition");
  assert.deepEqual(await context.inbox(), []);

  registry.states.current = { "mt5-bridge": { state: "DOWN" }, alpaca: { state: "DISABLED" } };
  context.advance(60_000);
  const result = await jobs.runOperations({ holder: "cron#2" });

  assert.deepEqual(result.risk.brokerDisconnected, ["mt5-bridge"]);
  assert.deepEqual(result.risk.brokerReconnected, []);
  assert.equal(result.risk.alerts, 1, "the disconnect is the only alert");
  assert.deepEqual(result.risk.codes, ["BROKER_DISCONNECTED"]);
  assert.equal(result.risk.raised, 1, "it is a new alert key, so the transition diff raised it");
  assert.deepEqual(result.risk.unclassifiedCodes, [], "BROKER_DISCONNECTED is a known legacy code");

  const events = await context.auditEvents();
  const disconnects = events.filter((event) => event.action === AUDIT_ACTIONS.brokerDisconnected);
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].entityType, "broker_connector");
  assert.equal(disconnects[0].entityId, "mt5-bridge");
  assert.equal(disconnects[0].details.legacyAction, LEGACY_ACTIONS.brokerDisconnected, "the legacy action is carried so the two trails correlate");
  assert.equal(disconnects[0].details.summary, "Connector mt5-bridge was READY and is now DOWN", "legacy's sentence, verbatim");
  assert.deepEqual(disconnects[0].details.from, "READY");
  assert.deepEqual(disconnects[0].details.to, "DOWN");
  // Phase 10 resolves the actor into the read view: a NULL actor reports as
  // `kind: "system"` rather than borrowing an operator's identity.
  assert.equal(disconnects[0].actor.userId, null, "the sweep acts as the system, not as an operator");
  assert.equal(disconnects[0].actor.kind, "system");

  const inbox = await context.inbox();
  // Two notifications for one disconnect, and that is legacy's shape, not a bug:
  // the direct BROKER_DISCONNECTED alert, plus the PORTFOLIO_RISK raise that the
  // alert list produces because the disconnect joined it.
  assert.equal(inbox.length, 2, `expected the broker alert and the portfolio raise, got ${inbox.length}`);
  const brokerAlert = inbox.find((row) => row.type === BROKER_DISCONNECTED_NOTIFICATION_TYPE);
  assert.ok(brokerAlert, "the BROKER_DISCONNECTED notification was published");
  assert.equal(brokerAlert.severity, "critical");
  assert.equal(brokerAlert.title, "Broker disconnected: mt5-bridge", "legacy's title, verbatim");
  assert.equal(brokerAlert.dedupe_key, "broker:mt5-bridge:disconnected", "legacy's notification dedupe key");
  assert.equal(brokerAlert.user_id, null, "broadcast, as legacy did");

  const riskRaise = inbox.find((row) => row.type === "PORTFOLIO_RISK");
  assert.ok(riskRaise, "the alert list also raised PORTFOLIO_RISK for the same disconnect");
  assert.equal(riskRaise.dedupe_key, "broker:mt5-bridge:BROKER_DISCONNECTED", "the alert key is the <scope>:<code> form, and is NOT the notification dedupe key");
  assert.notEqual(riskRaise.dedupe_key, brokerAlert.dedupe_key, "the two keys differ, as they did in legacy");
});

test("DOWN to READY is audited and notified as info, and adds no alert", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "DOWN" } } });
  const jobs = context.jobs(registry);
  await jobs.runOperations({ holder: "cron#1" });

  registry.states.current = { "mt5-bridge": { state: "READY" } };
  context.advance(60_000);
  const result = await jobs.runOperations({ holder: "cron#2" });

  assert.deepEqual(result.risk.brokerReconnected, ["mt5-bridge"]);
  assert.deepEqual(result.risk.brokerDisconnected, []);
  assert.equal(result.risk.alerts, 0, "a working connector is not a risk condition, so it joins no alert list");
  assert.deepEqual(result.risk.codes, []);

  const events = await context.auditEvents();
  const reconnects = events.filter((event) => event.action === AUDIT_ACTIONS.brokerConnected);
  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].details.summary, "Connector mt5-bridge reconnected (DOWN -> READY)", "legacy's sentence, verbatim");
  assert.equal(reconnects[0].details.legacyAction, LEGACY_ACTIONS.brokerConnected);

  const inbox = await context.inbox();
  assert.equal(inbox.length, 1, "only the reconnect notification; no PORTFOLIO_RISK, because no alert was raised");
  assert.equal(inbox[0].type, BROKER_CONNECTED_NOTIFICATION_TYPE);
  assert.equal(inbox[0].severity, "info", "a reconnect is informational, not a warning");
  assert.equal(inbox[0].title, "Broker reconnected: mt5-bridge");
  assert.equal(inbox[0].dedupe_key, "broker:mt5-bridge:connected");
});

test("a disconnect is reported for exactly one cycle, then cleared — legacy's transition-scoped alert", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "READY" } } });
  const jobs = context.jobs(registry);
  await jobs.runOperations({ holder: "cron#1" });

  registry.states.current = { "mt5-bridge": { state: "DOWN" } };
  context.advance(60_000);
  const down = await jobs.runOperations({ holder: "cron#2" });
  assert.equal(down.risk.raised, 1);
  assert.equal(down.risk.cleared, 0);

  // Still DOWN, but the transition already happened. Legacy added the alert only on
  // the READY->DOWN run, so on the next run the key disappears from the alert list
  // and the diff reports it cleared — while the connector is still down. Preserved
  // rather than "fixed" (BC-13): the durable record of the outage is the audit event
  // and the notification, not the alert list.
  context.advance(60_000);
  const stillDown = await jobs.runOperations({ holder: "cron#3" });
  assert.deepEqual(stillDown.risk.brokerDisconnected, [], "no second transition, so no second alert");
  assert.equal(stillDown.risk.alerts, 0);
  assert.equal(stillDown.risk.cleared, 1, "the previous cycle's key is cleared");
  assert.equal(stillDown.risk.raised, 0);

  const inbox = await context.inbox();
  assert.equal(inbox.filter((row) => row.type === BROKER_DISCONNECTED_NOTIFICATION_TYPE).length, 1, "one disconnect notification across three runs");
  const events = await context.auditEvents();
  assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.brokerDisconnected).length, 1);
  assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.riskCleared).length, 1);
  assert.equal((await context.jobState()).brokerStates["mt5-bridge"], "DOWN", "the state is still tracked even though the alert is not");
});

test("a second disconnect while the first is unread is suppressed by the dedupe key", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "READY" } } });
  const jobs = context.jobs(registry);
  await jobs.runOperations({ holder: "cron#1" });

  // down -> up -> down. The notification dedupe key has no date component (unlike
  // the routing-blocked key Phase 13 added), so Phase 9's unread-dedupe suppresses
  // the second one while the first is still unread.
  registry.states.current = { "mt5-bridge": { state: "DOWN" } };
  context.advance(60_000);
  await jobs.runOperations({ holder: "cron#2" });
  registry.states.current = { "mt5-bridge": { state: "READY" } };
  context.advance(60_000);
  await jobs.runOperations({ holder: "cron#3" });
  registry.states.current = { "mt5-bridge": { state: "DOWN" } };
  context.advance(60_000);
  await jobs.runOperations({ holder: "cron#4" });

  const inbox = await context.inbox();
  const disconnects = inbox.filter((row) => row.type === BROKER_DISCONNECTED_NOTIFICATION_TYPE);
  assert.equal(disconnects.length, 1, "the unread first alert suppresses the second");
  const events = await context.auditEvents();
  assert.equal(events.filter((event) => event.action === AUDIT_ACTIONS.brokerDisconnected).length, 2, "both disconnects are audited — the evidence is not deduped, only the nudge");
});

test("a dry run probes and reports transitions but writes nothing at all", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "READY" } } });
  const jobs = context.jobs(registry);
  await jobs.runOperations({ holder: "cron#1" });

  registry.states.current = { "mt5-bridge": { state: "DOWN" } };
  const probesBefore = registry.calls.allStatus;
  const dry = await jobs.runOperations({ holder: "cron#dry", dryRun: true });

  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.risk.brokerDisconnected, ["mt5-bridge"], "a dry run still reports what would happen");
  assert.equal(dry.risk.wouldRaise, 1);
  assert.equal(dry.risk.dryRun, true);
  assert.ok(registry.calls.allStatus > probesBefore, "a dry run does probe, because reporting requires the current state");

  assert.deepEqual(await context.inbox(), [], "a dry run publishes nothing");
  const events = await context.auditEvents();
  assert.deepEqual(events.filter((event) => String(event.action).startsWith("brokers.")), [], "a dry run audits nothing");
  assert.equal((await context.jobState()).brokerStates["mt5-bridge"], "READY", "a dry run persists nothing, so the real run still sees the transition");

  const real = await jobs.runOperations({ holder: "cron#2" });
  assert.deepEqual(real.risk.brokerDisconnected, ["mt5-bridge"], "the transition is still pending for the real run");
  assert.equal((await context.inbox()).length, 2);
});

test("the sweep probes the registry once, not once per stage", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "DISABLED" } } });
  await context.jobs(registry).runOperations({ holder: "cron#1" });
  assert.equal(registry.calls.allStatus, 1, "legacy called allStatus() twice per scan; Node threads one result through (BC-12)");
});

test("no registry means no broker fields at all, so the Phase 12 report shape is unchanged", async (t) => {
  const context = await harness(t);
  const result = await context.jobs(null).runOperations({ holder: "cron#1" });

  assert.equal(result.risk.brokerConnectors, undefined, "no broker summary is invented");
  assert.equal(result.risk.brokerDisconnected, undefined);
  assert.equal(result.risk.brokerError, undefined);
  assert.equal(result.completed, true);

  const persisted = await context.jobState();
  assert.equal(persisted.brokerStates, undefined, "no brokerStates key is written, rather than an empty object that would read as 'every connector vanished'");
  assert.ok(persisted.alertKeys && typeof persisted.alertKeys === "object", "the portfolio memory is untouched");
});

test("a registry that cannot report degrades to an error field without failing the sweep", async (t) => {
  const context = await harness(t);
  const result = await context.jobs(throwingRegistry("bridge registry exploded")).runOperations({ holder: "cron#1" });

  assert.equal(result.completed, true, "the sweep still completes");
  assert.deepEqual(result.errors, [], "a broker registry failure is not a stage failure");
  assert.equal(result.risk.brokerError, "bridge registry exploded");
  assert.equal(result.risk.brokerConnectors, 0);
  assert.equal((await context.jobState()).brokerStates, undefined, "nothing is persisted from a probe that failed, so the next run cannot diff against a fabricated state");
  assert.deepEqual(await context.inbox(), []);
});

test("a connector that reports neither READY nor DOWN cannot manufacture a transition", async (t) => {
  const context = await harness(t);
  const registry = fakeRegistry({ current: { "mt5-bridge": { state: "READY" } } });
  const jobs = context.jobs(registry);
  await jobs.runOperations({ holder: "cron#1" });

  // NOT_CONFIGURED and ERROR are not outages: an operator who removes a bridge's
  // URL has reconfigured the platform, not lost a connection.
  for (const state of ["NOT_CONFIGURED", "ERROR", "DISABLED", ""]) {
    registry.states.current = { "mt5-bridge": { state } };
    context.advance(60_000);
    const result = await jobs.runOperations({ holder: `cron#${state || "empty"}` });
    assert.deepEqual(result.risk.brokerDisconnected, [], `${state || "an empty state"} is not a disconnect`);
    assert.deepEqual(result.risk.brokerReconnected, [], `${state || "an empty state"} is not a reconnect`);
  }
  assert.deepEqual(await context.inbox(), []);
  // ...and a connector that goes READY -> NOT_CONFIGURED -> READY is not a
  // reconnect either, because it was never recorded as DOWN.
  registry.states.current = { "mt5-bridge": { state: "READY" } };
  context.advance(60_000);
  const back = await jobs.runOperations({ holder: "cron#back" });
  assert.deepEqual(back.risk.brokerReconnected, []);
  assert.equal((await context.inbox()).length, 0);
});
