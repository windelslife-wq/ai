/**
 * `SportsSyncService` (row 14, slice 2) — the ingestion half of the sports port.
 *
 * Legacy's own summary is the spec: *"Idempotent fixture ingestion. Provider
 * exceptions and malformed records are counted, never hidden."* Most of these tests
 * exist to hold those two clauses apart, because they pull in opposite directions and
 * the seam between them is where an ingestion port goes wrong:
 *
 *  - a **malformed record** is counted and named, and the run still completes;
 *  - a **provider-level refusal** — not `ONLINE`, or a fixture that was never
 *    synchronized — fails the whole run, because there is no partial answer to give.
 *
 * Collapsing either into the other is the failure mode. Treating a malformed record as
 * a run failure hides the thirty-nine records that were fine; treating a dead provider
 * as a per-record refusal reports `COMPLETED` for a run that stored nothing.
 *
 * These run against the file adapter, which really stores and really reads back, so
 * every assertion below is about rows that exist afterwards rather than about calls
 * that were made.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFileStore } from "../src/persistence/file-store.js";
import { createSportsSyncService, NO_ODDS_SENTINEL, PROVIDER_NOT_ONLINE, FIXTURE_NOT_SYNCED, SYNC_AUDIT_ACTIONS } from "../src/modules/sports/sync.js";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

function goodFixture(externalId, overrides = {}) {
  return {
    provider: "sandbox-sim",
    externalId,
    sport: "football",
    competition: "Premier League",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    kickoff: "2026-03-07T15:00:00.000Z",
    status: "SCHEDULED",
    sourceTimestamp: "2026-03-01T12:00:00.000Z",
    simulated: true,
    fieldsPresent: ["homeTeam", "awayTeam", "kickoff", "competition", "status"],
    ...overrides,
  };
}

/**
 * A stub provider.
 *
 * Each operation is configured separately, because a stub that throws on one operation
 * and is silent about the others will happily *serve* a call it was never told about —
 * a chain built once and asserted as "total failure" then passes for the wrong reason.
 */
function stubProvider({ health = { status: "ONLINE", reliability: 0.9 }, fixtures = [], odds = [], results = [], id = "sandbox-sim" } = {}) {
  return {
    id: () => id,
    async health() { return health; },
    async fixtures() { return fixtures; },
    async odds() { return odds; },
    async results() { return results; },
  };
}

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "sports-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), logger: { warn() {} }, syncWrites: false });
  t.after(() => store.close());
  const audits = [];
  // `recordAudit` is intercepted rather than faked wholesale: everything else goes to
  // the real file adapter, so the rows asserted below really were written.
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === "recordAudit") return async (entry) => { audits.push(entry); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const sync = createSportsSyncService({ store: wrapped, now: () => NOW });
  return { store, sync, audits };
}

// ── the happy path, and the counters that make it evidence ───────────────────

test("a fixture sync stores the fixtures, scores them, and counts creations correctly", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({ fixtures: [goodFixture("f1"), goodFixture("f2"), goodFixture("f3")] });

  const run = await sync.syncFixtures(provider, { from: "2026-03-07", to: "2026-03-08" }, "fixtures:2026-03-07");

  assert.equal(run.status, "COMPLETED");
  assert.equal(run.processed, 3);
  // Divergence SP-13, and the reason this assertion exists. Legacy's repository
  // returned no `created_at` on the insert path, so its `created_at === updated_at`
  // test could never be true and **every new fixture was counted as an update**: a
  // first sync of three fixtures reported `created: 0, updated: 3`. These counters are
  // operator evidence in `wf_sports_sync_runs`, and false evidence is worse than
  // divergent evidence — so the comparison is unchanged and the row it reads is not.
  assert.equal(run.created, 3);
  assert.equal(run.updated, 0);
  assert.deepEqual(run.errors, []);
  assert.ok(run.runId, "a run that opened reports its id");

  assert.equal((await store.listSportsMatches()).length, 3);
  const [row] = await store.listSportsProviders();
  assert.equal(row.provider_code, "sandbox-sim");
  // Legacy passes `$provider->id()` as both the code and the display name. Preserved:
  // inventing a prettier name would make this row disagree with the history attached
  // to the same id, and a rename is an operator's decision, not an ingestion side
  // effect.
  assert.equal(row.display_name, "sandbox-sim");
  assert.equal(row.enabled, false, "a sync naming a vendor is not an operator approving it");

  // A re-sync of the same window updates rather than duplicates. The clock is advanced
  // past the first write first: created-vs-updated is decided by comparing `created_at`
  // with `updated_at`, so a re-sync landing in the same millisecond would be counted as
  // three more creations and this assertion would be testing nothing.
  const [storedRow] = await store.listSportsMatches();
  await afterInstant(storedRow.updated_at);
  const again = await sync.syncFixtures(provider, {}, "fixtures:2026-03-07:2");
  assert.equal(again.created, 0);
  assert.equal(again.updated, 3);
  assert.equal((await store.listSportsMatches()).length, 3);
});

test("every fixture is scored as it lands, and none of them becomes ticket-eligible", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({ fixtures: [goodFixture("f1")] });
  await sync.syncFixtures(provider, {}, "fixtures:score");

  const [match] = await store.listSportsMatches();
  const quality = await store.latestSportsQuality(match.id);
  assert.ok(quality, "a synced fixture is assessed, not merely stored");
  // Divergence SP-22. The odds check is worth 18 of the 108 points and is scored
  // `false` at sync time, because at that moment no odds observation exists. So a
  // fixture synced without a separate odds sync can score at most 90, and
  // `eligibleForTicket` — which additionally requires `freshnessScore > 0` — is always
  // false here. Ingesting fixtures can therefore NEVER, on its own, make a fixture
  // eligible to be staked on. That is the gate working, not a bug.
  assert.equal(quality.eligible_ticket, false);
  assert.ok(quality.missing_fields.includes("odds"), "and the assessment says why");
  assert.equal(quality.provider_reliability_score, 90, "derived from the health reading the same run took");
  assert.ok(quality.checks_payload.length >= 9, "all nine weighted checks are stored, because a score with no breakdown is an assertion");
});

/**
 * Wait until the wall clock has moved strictly past `instant`.
 *
 * `saveSportsMatch` distinguishes a creation from an update by comparing `created_at`
 * with `updated_at` — the heuristic legacy used and this port deliberately kept
 * (divergence SP-13, which fixed the row the comparison reads, not the comparison). So
 * an update that lands in the SAME MILLISECOND as the insert is indistinguishable from a
 * creation, and gets counted as one.
 *
 * That is a property of the code, not an artifact of the test, and asserting `notEqual`
 * without first guaranteeing the clock moved produced exactly the failure it deserves:
 * green on every run in a 2-core sandbox, intermittent on a 4-core runner where two
 * writes really can land inside one millisecond. Waiting for the clock costs about a
 * millisecond and makes the assertion mean what it says.
 */
async function afterInstant(instant) {
  const at = Date.parse(instant);
  while (Date.now() <= at) await new Promise((resolve) => setTimeout(resolve, 1));
}

// ── idempotency ──────────────────────────────────────────────────────────────

test("a reused execution key is refused, writes nothing, and is not audited", async (t) => {
  const { store, sync, audits } = await harness(t);
  const provider = stubProvider({ fixtures: [goodFixture("f1")] });

  const first = await sync.syncFixtures(provider, {}, "fixtures:once");
  assert.equal(first.status, "COMPLETED");
  const auditsAfterFirst = audits.length;

  const duplicate = await sync.syncFixtures(provider, {}, "fixtures:once");
  assert.equal(duplicate.status, "DUPLICATE_SKIPPED");
  // No `runId`, because no run was opened — and returning one would imply a row that
  // does not exist.
  assert.equal(duplicate.runId, undefined);
  assert.equal(duplicate.executionKey, "fixtures:once");

  // No audit event: the original run already has one, and emitting a second would
  // double-count every retry in a filter built on these actions.
  assert.equal(audits.length, auditsAfterFirst, "a duplicate is not an occurrence");
  assert.equal((await store.listSportsSyncRuns()).length, 1, "and it wrote no run row");
  assert.equal((await store.listSportsMatches()).length, 1, "and it stored no fixture twice");
});

test("a run row is closed whatever happens inside it", async (t) => {
  const { store, sync } = await harness(t);
  // A provider whose `fixtures()` rejects outright: the run still has to be closed,
  // because an unclosed RUNNING row is indistinguishable from a worker that died.
  const broken = { id: () => "sandbox-sim", async health() { return { status: "ONLINE" }; }, async fixtures() { throw new Error("transport exploded"); } };
  const run = await sync.syncFixtures(broken, {}, "fixtures:broken");

  assert.equal(run.status, "FAILED");
  assert.deepEqual(run.errors, ["transport exploded"]);
  const [stored] = await store.listSportsSyncRuns();
  assert.equal(stored.status, "FAILED", "finishSync sits outside the try, so the run is always closed");
  assert.ok(stored.ended_at);
});

// ── provider-level refusals ──────────────────────────────────────────────────

test("a provider that is not ONLINE fails the run, but its health observation is kept", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({
    health: { status: "RATE_LIMITED", rateLimitRemaining: 0 },
    fixtures: [goodFixture("f1")],
  });

  const run = await sync.syncFixtures(provider, {}, "fixtures:limited");
  assert.equal(run.status, "FAILED");
  assert.deepEqual(run.errors, [PROVIDER_NOT_ONLINE]);
  assert.equal(run.processed, 0, "no record was reached");
  assert.equal((await store.listSportsMatches()).length, 0);

  // The observation is persisted BEFORE the gate, and that ordering is the point: a
  // provider that reports RATE_LIMITED still leaves a health row explaining why the run
  // failed. Gating first would discard exactly the observation that explains it, and
  // the health monitor would then derive a status from a gap instead of from a reason.
  const latest = await store.latestSportsHealth((await store.listSportsProviders())[0].id);
  assert.equal(latest.status, "RATE_LIMITED");
});

test("a health reading with no status is stored as DATA_ERROR rather than as nothing", async (t) => {
  const { store, sync } = await harness(t);
  // Legacy: `array_merge($health, ['status' => $health['status'] ?? 'DATA_ERROR'])`.
  // A health row can never hold an empty status that the monitor then has to guess at.
  const provider = stubProvider({ health: { responseMs: 12 } });
  const run = await sync.syncFixtures(provider, {}, "fixtures:nostatus");
  assert.equal(run.status, "FAILED");
  const latest = await store.latestSportsHealth((await store.listSportsProviders())[0].id);
  assert.equal(latest.status, "DATA_ERROR");
});

test("odds and results for a fixture that was never synchronized fail, and say so", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({ odds: [{ market: "1X2", selection: "HOME", decimalOdds: 2.1, observedAt: "2026-03-05T09:00:00.000Z" }] });

  const oddsRun = await sync.syncOdds(provider, "never-synced", "odds:missing");
  assert.equal(oddsRun.status, "FAILED");
  assert.deepEqual(oddsRun.errors, [FIXTURE_NOT_SYNCED]);

  const resultRun = await sync.syncResults(stubProvider({ results: [{ externalId: "never-synced", status: "FINISHED", homeScore: 1, awayScore: 0, sourceTimestamp: "2026-03-07T17:00:00.000Z" }] }), "never-synced", "results:missing");
  assert.equal(resultRun.status, "FAILED");
  assert.deepEqual(resultRun.errors, [FIXTURE_NOT_SYNCED]);
  assert.deepEqual(await store.listSportsSyncRuns({ status: "COMPLETED" }), []);
});

// ── malformed records ────────────────────────────────────────────────────────

test("one malformed fixture does not fail the run; it is counted and named", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({
    fixtures: [
      goodFixture("good-1"),
      { externalId: "bad-1", sport: "football" }, // no kickoff, no teams
      goodFixture("good-2"),
      { externalId: "" }, // not even an id
    ],
  });

  const run = await sync.syncFixtures(provider, {}, "fixtures:mixed");

  // The run COMPLETES. Aborting would hide the two that were fine and tell the operator
  // nothing about the two that were not.
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.processed, 4);
  assert.equal(run.created, 2);
  assert.equal(run.updated, 0);
  assert.equal(run.errors.length, 2, "and both refusals are named");
  // The normalizer reports the FIRST missing required field in a fixed order
  // (homeTeam, awayTeam, kickoff, competition, status), not all of them. Pinned as it
  // is, because an operator reading "fixture missing homeTeam" for a record that is
  // missing four fields needs to know that fixing one will surface the next.
  assert.deepEqual(run.errors, ["fixture missing homeTeam", "fixture missing externalId"]);
  assert.equal((await store.listSportsMatches()).length, 2, "only the valid fixtures were stored");

  // The stored run row carries the same evidence, because that is where an operator
  // reads it later — the return value is gone by then.
  const [stored] = await store.listSportsSyncRuns();
  assert.equal(stored.records_processed, 4);
  assert.equal(stored.records_created, 2);
  assert.equal(stored.errors.length, 2);
});

test("an error message longer than 200 characters is truncated before it is stored", async (t) => {
  const { store, sync } = await harness(t);
  const long = "x".repeat(500);
  const provider = { id: () => "sandbox-sim", async health() { return { status: "ONLINE" }; }, async fixtures() { throw new Error(long); } };
  await sync.syncFixtures(provider, {}, "fixtures:long");

  const [stored] = await store.listSportsSyncRuns();
  assert.equal(stored.errors[0].length, 200, "a run must name its refusals, but one provider's stack trace must not fill the column");
});

// ── odds ─────────────────────────────────────────────────────────────────────

test("an odds sync appends observations, and a provider that returns none says so", async (t) => {
  const { store, sync } = await harness(t);
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:for-odds");

  const withOdds = stubProvider({
    odds: [
      { market: "1X2", selection: "HOME", decimalOdds: 2.1, observedAt: "2026-03-05T09:00:00.000Z" },
      { market: "1X2", selection: "DRAW", decimalOdds: 3.4, observedAt: "2026-03-05T09:00:00.000Z" },
      { market: "1X2", selection: "AWAY", decimalOdds: 0.9, observedAt: "2026-03-05T09:00:00.000Z" }, // below evens
    ],
  });
  const run = await sync.syncOdds(withOdds, "f1", "odds:f1");
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.processed, 3);
  assert.equal(run.created, 2, "the sub-evens price is counted as refused, not stored");
  assert.equal(run.errors.length, 1);
  const [match] = await store.listSportsMatches();
  assert.equal((await store.listSportsOdds(match.id)).length, 2);

  // An empty odds response is COMPLETED, not FAILED — the call succeeded and returned
  // nothing, which is a different fact from a call that broke. But it is recorded,
  // because a completed odds sync that stored zero rows is exactly the circumstance
  // under which a ticket must not be generated, and a bare `processed: 0` in a counter
  // column is too quiet a way to say it.
  const empty = await sync.syncOdds(stubProvider({ odds: [] }), "f1", "odds:f1:empty");
  assert.equal(empty.status, "COMPLETED");
  assert.equal(empty.processed, 0);
  assert.deepEqual(empty.errors, [NO_ODDS_SENTINEL]);
});

test("odds are appended, so two syncs of one market produce two rows and a history", async (t) => {
  const { store, sync } = await harness(t);
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:h");
  const once = stubProvider({ odds: [{ market: "1X2", selection: "HOME", decimalOdds: 2.1, observedAt: "2026-03-05T09:00:00.000Z" }] });
  const twice = stubProvider({ odds: [{ market: "1X2", selection: "HOME", decimalOdds: 2.6, observedAt: "2026-03-06T09:00:00.000Z" }] });
  await sync.syncOdds(once, "f1", "odds:h:1");
  await sync.syncOdds(twice, "f1", "odds:h:2");

  const [match] = await store.listSportsMatches();
  // No unique key on (match, market, selection) on purpose: each row is an observation
  // at an instant, and overwriting would destroy the point-in-time history
  // `findSportsOddsBefore` exists to answer for slice 5's backtester.
  assert.equal((await store.listSportsOdds(match.id)).length, 2);
  assert.equal((await store.latestSportsOdds(match.id, "1X2", "HOME")).decimal_odds, 2.6);
  assert.equal((await store.findSportsOddsBefore(match.id, "2026-03-06T00:00:00.000Z")).decimal_odds, 2.1);
});

// ── results ──────────────────────────────────────────────────────────────────

test("a result sync stores an unverified outcome and persists no health observation", async (t) => {
  const { store, sync } = await harness(t);
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:for-results");
  const [provider] = await store.listSportsProviders();
  const healthBefore = (await store.listSportsHealth(provider.id)).length;

  const provider2 = stubProvider({
    results: [{ externalId: "f1", status: "FINISHED", homeScore: 2, awayScore: 1, sourceTimestamp: "2026-03-07T17:00:00.000Z" }],
  });
  const run = await sync.syncResults(provider2, "f1", "results:f1");
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.processed, 1);
  assert.equal(run.created, 1);

  const [match] = await store.listSportsMatches();
  const result = await store.findSportsResult(match.id, provider.id);
  // Ingestion REPORTS; it does not attest. `verified` is false and there is no
  // `verifySportsResult` in the contract, so nothing in this slice can set it —
  // settlement (slice 5) is the only thing that will, behind `sports.settle`.
  assert.equal(result.verified, false);
  assert.equal(result.verified_at, null);
  assert.equal(result.home_score, 2);
  assert.equal(result.away_score, 1);

  // Divergence SP-21, preserved. Legacy's `syncResults` calls `provider->health()` and
  // gates on it but never persists the observation, unlike the other two. So a provider
  // used only for results leaves no health row and shows as UNKNOWN to the monitor
  // forever. Kept as it is, because silently adding a write would change what the
  // monitor sees for every existing deployment — recorded so the gap is a decision
  // rather than an oversight.
  assert.equal((await store.listSportsHealth(provider.id)).length, healthBefore,
    "a results sync stores no health row, exactly as legacy's does not");
});

test("a result with an invalid scoreline is refused and the fixture keeps no result", async (t) => {
  const { store, sync } = await harness(t);
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:bad-result");
  const provider = stubProvider({
    results: [
      { externalId: "f1", status: "FINISHED", homeScore: 2.5, awayScore: 1, sourceTimestamp: "2026-03-07T17:00:00.000Z" },
      { externalId: "f1", status: "FINISHED", homeScore: -1, awayScore: 0, sourceTimestamp: "2026-03-07T17:00:00.000Z" },
    ],
  });
  const run = await sync.syncResults(provider, "f1", "results:bad");
  assert.equal(run.status, "COMPLETED", "a malformed record is not a provider-level failure");
  assert.equal(run.processed, 2);
  assert.equal(run.created, 0);
  assert.equal(run.errors.length, 2);
  assert.match(run.errors[0], /finished result scores invalid/);

  const [match] = await store.listSportsMatches();
  assert.equal(await store.findSportsResult(match.id, (await store.listSportsProviders())[0].id), null,
    "a refused scoreline is not stored as 0-0 or as anything else");
});

test("a postponed result stores NULL scores, because 0-0 would be a fabricated scoreline", async (t) => {
  const { store, sync } = await harness(t);
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:ppd");
  const run = await sync.syncResults(
    stubProvider({ results: [{ externalId: "f1", status: "POSTPONED", sourceTimestamp: "2026-03-07T17:00:00.000Z" }] }),
    "f1",
    "results:ppd",
  );
  assert.equal(run.status, "COMPLETED");
  const [match] = await store.listSportsMatches();
  const result = await store.findSportsResult(match.id, (await store.listSportsProviders())[0].id);
  assert.equal(result.status, "POSTPONED");
  // NULL means "no score was reported", which is a different fact from "no goals were
  // scored". Writing 0-0 here would invent a scoreline for a match that never happened.
  assert.equal(result.home_score, null);
  assert.equal(result.away_score, null);
});

// ── audit ────────────────────────────────────────────────────────────────────

test("each run is audited under the platform's dotted vocabulary, attributed to its actor", async (t) => {
  const { sync, audits } = await harness(t);
  const provider = stubProvider({ fixtures: [goodFixture("f1")] });
  await sync.syncFixtures(provider, {}, "fixtures:audit-1");
  await sync.syncOdds(provider, "f1", "odds:audit-1");
  await sync.syncResults(provider, "f1", "results:audit-1");
  await sync.syncFixtures(stubProvider({ health: { status: "OFFLINE" } }), {}, "fixtures:audit-2");

  assert.deepEqual(audits.map((entry) => entry.action), [
    SYNC_AUDIT_ACTIONS.FIXTURES_COMPLETED,
    SYNC_AUDIT_ACTIONS.ODDS_COMPLETED,
    SYNC_AUDIT_ACTIONS.RESULTS_COMPLETED,
    SYNC_AUDIT_ACTIONS.FIXTURES_FAILED,
  ]);
  // Legacy emits `SPORTS_FIXTURE_SYNC_COMPLETED` and five siblings. This port uses the
  // platform's dotted-lowercase vocabulary because the audit browser filters on these
  // strings (divergence SP-24): one event type spelled two ways is two event types to
  // anyone building a filter, and that browser is one of five workspace screens — the
  // ledger for them is test/console_screens.test.js.
  for (const action of audits.map((entry) => entry.action)) {
    assert.match(action, /^sports\.sync\.[a-z]+\.(completed|failed)$/);
  }
  for (const entry of audits) {
    assert.equal(entry.entityType, "sports_sync_run");
    assert.ok(entry.entityId, "the audit row points at the run it describes");
    assert.ok(entry.details.result, "and carries the run's outcome, not just its name");
    // `actorId` is null for a scheduled run, which Phase 10's attribution reads as
    // `kind: "system"` — so a cron sync is never recorded as though a human ran it.
    assert.equal(entry.actorId, null);
  }
});

test("an operator-triggered sync is attributed to that operator, not to the system", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "sports-actor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: path.join(directory, "store"), logger: { warn() {} }, syncWrites: false });
  t.after(() => store.close());
  const audits = [];
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === "recordAudit") return async (entry) => { audits.push(entry); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // `actorId` is bound per service instance rather than per call, so the same store can
  // serve an operator's request and a scheduled run without one borrowing the other's
  // identity.
  const sync = createSportsSyncService({ store: wrapped, actorId: 42, now: () => NOW });
  await sync.syncFixtures(stubProvider({ fixtures: [goodFixture("f1")] }), {}, "fixtures:actor");
  assert.equal(audits[0].actorId, 42);
});

// ── the monitor is now reachable ─────────────────────────────────────────────

test("a sync gives the health monitor real inputs, so a derived status is measured", async (t) => {
  const { store, sync } = await harness(t);
  const provider = stubProvider({ fixtures: [goodFixture("f1")], health: { status: "ONLINE", reliability: 0.9 } });
  await sync.syncFixtures(provider, {}, "fixtures:monitor");

  const [row] = await store.listSportsProviders();
  const healthRows = await store.listSportsHealth(row.id, 20);
  const runRows = await store.listSportsSyncRuns({ providerId: row.id }, 20);

  // Finding F-35: legacy never reached this. `ProviderHealthMonitor::assess()` has no
  // caller anywhere in `application/`, and its third parameter is documented as
  // "newest-first sports_sync_runs rows" while the repository declares no method that
  // can read that table. Legacy wrote sync evidence it could not query and built a
  // monitor whose derived status it never computed. `listSportsSyncRuns` is what closes
  // the gap — porting the class would not have.
  assert.ok(healthRows.length > 0, "a sync persists the health observation");
  assert.ok(runRows.length > 0, "and the run rows the monitor's third parameter needs");
  assert.equal(runRows[0].status, "COMPLETED");

  const { assessProviderHealth } = await import("../src/modules/sports/health-monitor.js");
  const derived = assessProviderHealth(row, healthRows, runRows, Math.floor(NOW / 1000));
  assert.notEqual(derived.status, "UNKNOWN", "with real observations the derived status is no longer UNKNOWN");
  assert.ok(derived.reliability > 0, "and reliability is computed from the runs, not defaulted");
});
