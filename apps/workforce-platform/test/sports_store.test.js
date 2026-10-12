/**
 * The sports foundation repository (row 14, slice 2) against a recording
 * MySQL-shaped executor and against the file adapter.
 *
 * Two kinds of assertion, because there is no MySQL in CI (**F-15**) and pretending
 * otherwise would produce tests that pass against a fiction:
 *
 *  - **Behaviour** is proven on the file adapter, which really stores, really reads
 *    back and really replays its write-ahead log. Every rule that matters — the
 *    idempotency key, the created-versus-updated counters, the point-in-time odds
 *    query, the retention boundary — is asserted here end to end.
 *  - **SQL shape** is proven on the recording executor: that the right statement is
 *    issued with the right bound parameters, that limits are interpolated as bounded
 *    integers rather than as caller text, and that the upserts really are
 *    `ON DUPLICATE KEY UPDATE` rather than a select followed by an insert.
 *
 * What this file cannot prove is that MariaDB accepts the statements. That gap is
 * F-15 and it is stated rather than papered over.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSportsRepository, SPORTS_REPOSITORY_METHODS } from "../src/db/sports-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { createSportsSyncService } from "../src/modules/sports/sync.js";

/** A fixed instant, so every assertion below is about ordering and not about clocks. */
const T0 = "2026-03-01T12:00:00.000Z";

function recordingExecutor({ rows = [], affectedRows = 1, insertId = 7 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      return [rows.map((row) => ({ ...row })), []];
    },
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      return [{ affectedRows, insertId }, []];
    },
  };
}

async function tempFileStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "sports-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createFileStore({ dir: path.join(directory, "store"), logger: { warn() {} }, syncWrites: false });
}

function fixture(overrides = {}) {
  return {
    provider: "sandbox-sim",
    externalId: "sim-f3ff5d-1",
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

function odds(overrides = {}) {
  return {
    provider: "sandbox-sim",
    market: "1X2",
    selection: "HOME",
    decimalOdds: 2.1,
    observedAt: "2026-03-05T09:00:00.000Z",
    ...overrides,
  };
}

// ── contract ─────────────────────────────────────────────────────────────────

test("the sports repository exposes exactly the 22 methods the contract names, and no more", () => {
  const repository = createSportsRepository(recordingExecutor());
  assert.equal(SPORTS_REPOSITORY_METHODS.length, 22);
  for (const method of SPORTS_REPOSITORY_METHODS) {
    assert.equal(typeof repository[method], "function", `${method} must be implemented`);
  }
  assert.deepEqual(Object.keys(repository).sort(), [...SPORTS_REPOSITORY_METHODS].sort());
  // The naming rule that keeps row 15 from overwriting row 14: legacy's sports and
  // lottery repositories declare `ensureProvider`, `saveHealth`, `latestHealth` and
  // `listHealth` with IDENTICAL names, and this contract is one flat namespace.
  for (const generic of ["ensureProvider", "saveHealth", "latestHealth", "listHealth", "deleteOldHealth"]) {
    assert.ok(!SPORTS_REPOSITORY_METHODS.includes(generic), `${generic} must be module-prefixed (divergence SP-18)`);
  }
  // Ingestion must not be able to attest to a result.
  assert.ok(!SPORTS_REPOSITORY_METHODS.includes("verifySportsResult"));
});

// ── provider registry ────────────────────────────────────────────────────────

test("ensureSportsProvider creates a DISABLED row and is idempotent on the provider code", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());

  const first = await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  assert.equal(first.provider_code, "sandbox-sim");
  // Disabled on purpose: a row appearing because a sync named a vendor is not an
  // operator approving that vendor.
  assert.equal(first.enabled, false);
  assert.equal(first.created_at, first.updated_at);

  const again = await store.ensureSportsProvider("sandbox-sim", "a different display name");
  assert.equal(again.id, first.id, "one row per provider code, however often it is ensured");
  // Legacy does not refresh the display name on an existing row, so a renamed vendor
  // keeps its first name and the row never disagrees with the history attached to it.
  assert.equal(again.display_name, "sandbox-sim");

  await store.setSportsProviderEnabled(first.id, true);
  assert.equal((await store.listSportsProviders(true)).length, 1);
  await store.setSportsProviderEnabled(first.id, false);
  assert.deepEqual(await store.listSportsProviders(true), []);
  assert.equal((await store.listSportsProviders()).length, 1, "disabling is not deleting");
});

test("ensureSportsProvider inserts disabled, and a lost race returns a row rather than throwing", async () => {
  // An unknown provider: SELECT finds nothing, INSERT runs, the row is read back.
  const fresh = recordingExecutor({ rows: [] });
  await createSportsRepository(fresh).ensureSportsProvider("vendor", "Vendor");
  const insert = fresh.calls.find((call) => call.sql.includes("INSERT INTO wf_sports_data_sources"));
  assert.ok(insert, "a new provider must be inserted");
  assert.match(insert.sql, /VALUES \(\?, \?, 0, \?, \?\)/, "inserted DISABLED: a row appearing because a sync named a vendor is not an operator approving it");
  assert.deepEqual(insert.values.slice(0, 2), ["vendor", "Vendor"]);

  // A known provider short-circuits, and does NOT refresh the display name — legacy's
  // behaviour, preserved so the row never disagrees with the history attached to it.
  const known = recordingExecutor({ rows: [{ id: 3, provider_code: "vendor", display_name: "Vendor", enabled: 1, created_at: T0, updated_at: T0 }] });
  const found = await createSportsRepository(known).ensureSportsProvider("vendor", "Renamed");
  assert.equal(found.id, 3);
  assert.equal(found.display_name, "Vendor");
  assert.equal(found.enabled, true);
  assert.ok(!known.calls.some((call) => call.kind === "execute"), "an existing provider is returned without a write");

  // The collision path. The preceding SELECT is an optimization for the common case;
  // the UNIQUE key is still the arbiter, because two concurrent callers can both get
  // past it. Divergence SP-12 is about `startSportsSync`, and the same discipline
  // applies here: catch the collision and read the winner's row back, so the answer is
  // identical whether the race is lost by microseconds or never happens.
  // The first SELECT must come back empty — that is what puts the caller on the insert
  // path — while the read-back SELECT returns the row the winner wrote.
  const winnerRow = { id: 9, provider_code: "vendor", display_name: "Vendor", enabled: 0, created_at: T0, updated_at: T0 };
  const raced = {
    calls: [],
    reads: 0,
    async query() {
      this.reads += 1;
      return [[this.reads === 1 ? undefined : winnerRow].filter(Boolean), []];
    },
    async execute(sql) {
      this.calls.push(sql);
      throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
    },
  };
  const winner = await createSportsRepository(raced).ensureSportsProvider("vendor", "Vendor");
  assert.equal(winner.id, 9, "a lost insert returns the winner's row");
  assert.equal(raced.calls.length, 1, "one insert attempt, and it did not throw out of the caller");
});

// ── sync runs: the idempotency arbiter ───────────────────────────────────────

test("startSportsSync returns null for a reused execution key, on both paths", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());

  const run = { id: "11111111-1111-4111-8111-111111111111", providerId: null, jobType: "FIXTURES", executionKey: "fixtures:2026-03-07" };
  const opened = await store.startSportsSync(run);
  assert.equal(opened.status, "RUNNING");
  assert.equal(opened.id, run.id);

  // The whole point of the key: a schedule that fires twice for one window, or a
  // retry after a timeout, cannot ingest the same records twice.
  const duplicate = await store.startSportsSync({ ...run, id: "22222222-2222-4222-8222-222222222222" });
  assert.equal(duplicate, null, "a reused execution key must not open a second run");

  const runs = await store.listSportsSyncRuns();
  assert.equal(runs.length, 1, "and it must not have written a second row");
});

test("startSportsSync refuses a malformed run id or key rather than storing one", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  const base = { providerId: null, jobType: "FIXTURES", executionKey: "k" };
  // A caller-supplied UUID has to exist before the work starts, so a crash mid-sync
  // still leaves evidence of the attempt — which is only true if ids cannot collide.
  await assert.rejects(() => store.startSportsSync({ ...base, id: "not-a-uuid" }), /must be a UUID/);
  await assert.rejects(() => store.startSportsSync({ ...base, id: "11111111-1111-4111-8111-111111111111", executionKey: "" }), /execution_key/);
  await assert.rejects(() => store.startSportsSync({ ...base, id: "11111111-1111-4111-8111-111111111111", jobType: "TICKETS" }), /job_type/);
});

test("finishSportsSync stores the counters and truncates each error message to 200 characters", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  const id = "33333333-3333-4333-8333-333333333333";
  await store.startSportsSync({ id, providerId: null, jobType: "ODDS", executionKey: "odds:1" });
  const long = "x".repeat(500);
  await store.finishSportsSync(id, { status: "COMPLETED", processed: 40, created: 38, updated: 0, errors: [long, "kickoff missing"] });

  const [run] = await store.listSportsSyncRuns({ jobType: "ODDS" });
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.records_processed, 40);
  assert.equal(run.records_created, 38);
  assert.ok(run.ended_at, "a finished run says when it finished");
  assert.equal(run.errors[0].length, 200, "a run must name its refusals, but one provider's stack trace must not fill the column");
  assert.equal(run.errors[1], "kickoff missing");
});

test("listSportsSyncRuns is the read legacy never had, and filters by provider and status", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();

  await store.startSportsSync({ id: "44444444-4444-4444-8444-444444444444", providerId: provider.id, jobType: "FIXTURES", executionKey: "a" });
  await store.startSportsSync({ id: "55555555-5555-4555-8555-555555555555", providerId: provider.id, jobType: "ODDS", executionKey: "b" });
  await store.finishSportsSync("55555555-5555-4555-8555-555555555555", { status: "FAILED", errors: ["provider is not ONLINE"] });

  assert.equal((await store.listSportsSyncRuns()).length, 2);
  assert.equal((await store.listSportsSyncRuns({ jobType: "ODDS" })).length, 1);
  assert.equal((await store.listSportsSyncRuns({ status: "FAILED" })).length, 1);
  assert.deepEqual(await store.listSportsSyncRuns({ providerId: provider.id + 99 }), []);

  // Finding F-35: legacy wrote this table from `startSync`/`finishSync` and selected
  // from it nowhere in `application/`, so a row left RUNNING — the evidence of a
  // worker that died mid-sync — was invisible to anyone.
  const unfinished = (await store.listSportsSyncRuns({ status: "RUNNING" }));
  assert.equal(unfinished.length, 1, "a run that never closed is evidence, and it must be findable");
});

// ── fixtures ─────────────────────────────────────────────────────────────────

test("saveSportsMatch upserts by (provider, external id) and distinguishes created from updated", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();

  const created = await store.saveSportsMatch(provider.id, fixture());
  assert.ok(created.id > 0);
  assert.equal(created.created_at, created.updated_at);
  assert.equal(created.payload.simulated, true, "the normalized record is stored whole, so a disputed row can be compared against what arrived");

  // Divergence SP-13. Legacy's insert branch returned a row WITHOUT `created_at`, so
  // the sync service's `created_at === updated_at` test could never be true and every
  // new fixture was counted as an update: a first sync of twelve fixtures reported
  // `created: 0, updated: 12`. These counters are operator evidence, and false
  // evidence is worse than divergent evidence.
  const updated = await store.saveSportsMatch(provider.id, fixture({ status: "LIVE" }));
  assert.equal(updated.id, created.id, "one row per provider per external fixture");
  assert.equal(updated.status, "LIVE");
  assert.equal(updated.created_at, created.created_at, "an update does not move created_at");
  assert.notEqual(updated.updated_at, updated.created_at);

  assert.equal((await store.listSportsMatches()).length, 1, "re-syncing corrects rather than duplicates");
  assert.equal((await store.findSportsMatch(provider.id, "sim-f3ff5d-1")).id, created.id);
  assert.equal(await store.findSportsMatch(provider.id, "never-seen"), null);
});

test("two providers numbering the same fixture differently are two rows, not one", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("vendor-a", "vendor-a");
  await store.ensureSportsProvider("vendor-b", "vendor-b");
  const [a, b] = await store.listSportsProviders();

  // The unique key is scoped by provider on purpose: inventing a cross-provider
  // identity for one fixture would be a guess about two vendors' numbering.
  await store.saveSportsMatch(a.id, fixture({ externalId: "1" }));
  await store.saveSportsMatch(b.id, fixture({ externalId: "1" }));
  assert.equal((await store.listSportsMatches()).length, 2);
});

test("listSportsMatches filters by status, window, provider and competition prefix — and refuses a malformed window", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();

  await store.saveSportsMatch(provider.id, fixture({ externalId: "a", kickoff: "2026-03-07T15:00:00.000Z", competition: "Premier League" }));
  await store.saveSportsMatch(provider.id, fixture({ externalId: "b", kickoff: "2026-03-08T15:00:00.000Z", competition: "Premier League Two", status: "LIVE" }));
  await store.saveSportsMatch(provider.id, fixture({ externalId: "c", kickoff: "2026-03-09T15:00:00.000Z", competition: "La Liga" }));

  assert.deepEqual((await store.listSportsMatches()).map((row) => row.external_id), ["a", "b", "c"], "oldest kickoff first");
  assert.equal((await store.listSportsMatches({ status: "LIVE" })).length, 1);
  assert.equal((await store.listSportsMatches({ from: "2026-03-08T00:00:00.000Z" })).length, 2);
  assert.equal((await store.listSportsMatches({ to: "2026-03-08T00:00:00.000Z" })).length, 1);
  assert.equal((await store.listSportsMatches({ providerId: provider.id })).length, 3);

  // A PREFIX match, as legacy's CodeIgniter `like(..., 'after')` was.
  assert.equal((await store.listSportsMatches({ competition: "Premier" })).length, 2);
  assert.equal((await store.listSportsMatches({ competition: "League" })).length, 0, "a prefix filter is not a substring filter");

  // Divergence SP-16: `%` is escaped. Legacy passed the value to `like()` unescaped,
  // so a filter of "%" matched every row — a prefix filter that behaves as a wildcard
  // is not the filter that was asked for.
  assert.equal((await store.listSportsMatches({ competition: "%" })).length, 0);

  // Defect D-12 is exactly this mistake: `?from=12345` must not silently produce an
  // empty window that looks like a working filter.
  await assert.rejects(() => store.listSportsMatches({ from: "12345" }), /ISO-8601 calendar instant/);
  await assert.rejects(() => store.listSportsMatches({ to: "now" }), /ISO-8601 calendar instant/);
  await assert.rejects(() => store.listSportsMatches({ status: "KICKOFF" }), /match status/);
});

test("every stored sports instant is one fixed width, so a text comparison is chronological", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());
  await store.saveSportsOdds(match.id, provider.id, odds());
  await store.saveSportsHealth(provider.id, { status: "ONLINE" });
  await store.startSportsSync({ id: "66666666-6666-4666-8666-666666666666", providerId: provider.id, jobType: "FIXTURES", executionKey: "w" });

  const instants = [
    provider.created_at, provider.updated_at,
    match.kickoff_at, match.source_timestamp, match.created_at, match.updated_at,
    (await store.listSportsOdds(match.id))[0].observed_at,
    (await store.listSportsHealth(provider.id))[0].observed_at,
    (await store.listSportsSyncRuns())[0].started_at,
  ];
  // Divergence SP-19. These columns are compared as TEXT — `kickoff_at >= ?`,
  // `observed_at < ?`, and every `ORDER BY … DESC` here is a string sort. Text
  // ordering is chronological only while every value has the same width, and
  // `"…T12:34:56.789Z"` sorts BEFORE `"…T12:34:56Z"` (`.` is 0x2E, `Z` is 0x5A) even
  // though it is 789 ms LATER. A conditional trim of the fractional part therefore
  // misorders two rows in the same second, silently.
  for (const instant of instants) {
    assert.match(instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${instant} must be canonical UTC with milliseconds`);
  }
  assert.equal(new Set(instants.map((instant) => instant.length)).size, 1, "one width, always");
});

// ── odds ─────────────────────────────────────────────────────────────────────

test("odds are appended, never overwritten, so point-in-time history survives", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  await store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: 2.1, observedAt: "2026-03-05T09:00:00.000Z" }));
  await store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: 2.4, observedAt: "2026-03-06T09:00:00.000Z" }));
  await store.saveSportsOdds(match.id, provider.id, odds({ market: "OU25", selection: "OVER", decimalOdds: 1.9, observedAt: "2026-03-06T10:00:00.000Z" }));

  // A second observation of one market is a second row. Overwriting would destroy the
  // history `findSportsOddsBefore` exists to answer.
  assert.equal((await store.listSportsOdds(match.id)).length, 3);
  assert.equal((await store.latestSportsOdds(match.id)).decimal_odds, 1.9, "newest across all markets");
  assert.equal((await store.latestSportsOdds(match.id, "1X2")).decimal_odds, 2.4);
  assert.equal((await store.latestSportsOdds(match.id, "1X2", "HOME")).decimal_odds, 2.4);
  assert.equal(await store.latestSportsOdds(match.id, "1X2", "AWAY"), null);
  assert.deepEqual((await store.listSportsOdds(match.id)).map((row) => row.observed_at),
    [...(await store.listSportsOdds(match.id))].map((row) => row.observed_at).sort().reverse(),
    "newest first");
});

test("saveSportsOdds refuses a price that is not strictly greater than evens", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  // The normalizer already refuses these; asserting again at the storage boundary is
  // what keeps the column's invariant true no matter which caller arrives.
  for (const invalid of [1.0, 0.5, 0, -2, "abc", null, NaN, Infinity]) {
    await assert.rejects(() => store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: invalid })), /greater than 1\.0/);
  }
  assert.equal((await store.listSportsOdds(match.id)).length, 0, "a refused price is not stored");
});

test("findSportsOddsBefore answers 'what did we know then' and fails closed on an unparseable instant", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  await store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: 2.1, observedAt: "2026-03-05T09:00:00.000Z" }));
  await store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: 2.4, observedAt: "2026-03-06T09:00:00.000Z" }));
  await store.saveSportsOdds(match.id, provider.id, odds({ decimalOdds: 2.9, observedAt: "2026-03-07T09:00:00.000Z" }));

  // The newest observation STRICTLY before the instant — which is the only question
  // slice 5's backtester can honestly ask, since using a price observed after kickoff
  // would be lookahead.
  assert.equal((await store.findSportsOddsBefore(match.id, "2026-03-07T09:00:00.000Z")).decimal_odds, 2.4);
  assert.equal(await store.findSportsOddsBefore(match.id, "2026-03-05T09:00:00.000Z"), null, "strictly before, not at");
  assert.equal((await store.findSportsOddsBefore(match.id, "2026-03-06T00:00:00.000Z")).decimal_odds, 2.1);
  assert.equal(await store.findSportsOddsBefore(match.id, "2020-01-01T00:00:00.000Z"), null);

  // Divergence SP-25, preserved on purpose. Legacy compares by `strtotime(...)`, which
  // returns WHOLE SECONDS, so the comparison is second-granular: an observation at
  // .000 and a bound at .001 are the same instant to this method and the observation is
  // not "before" it. A millisecond-precise port would return a row here and would not
  // match the original.
  //
  // Recorded rather than silently kept, because it is a real limitation with a real
  // consequence: two odds observations within one second cannot be ordered by this
  // query, so a backtest asking for the price "just before kickoff" cannot distinguish
  // them. Divergence SP-19 (one fixed instant width) is what would make a stricter
  // TEXT comparison safe if a later slice wants one — but changing it changes what a
  // backtest can see, and preserving behaviour comes before improving it.
  assert.equal(await store.findSportsOddsBefore(match.id, "2026-03-05T09:00:00.001Z"), null,
    "second-granular comparison, exactly as legacy's strtotime makes it");
  assert.equal((await store.findSportsOddsBefore(match.id, "2026-03-05T09:00:01.000Z")).decimal_odds, 2.1,
    "and one whole second later it is visible");

  // "No odds known before an instant we cannot place" rather than "all odds".
  assert.equal(await store.findSportsOddsBefore(match.id, "not-a-date"), null);
  assert.equal(await store.findSportsOddsBefore(match.id, "12345"), null);
  assert.equal(await store.findSportsOddsBefore(match.id, ""), null);
});

// ── results ──────────────────────────────────────────────────────────────────

test("a stored result is never verified, and re-ingesting one clears an attestation", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  const stored = await store.saveSportsResult(match.id, provider.id, {
    provider: "sandbox-sim", externalId: "sim-f3ff5d-1", status: "FINISHED",
    homeScore: 2, awayScore: 1, sourceTimestamp: "2026-03-07T17:00:00.000Z", verified: false,
    payload: { externalId: "sim-f3ff5d-1", status: "FINISHED", homeScore: 2, awayScore: 1, sourceTimestamp: "2026-03-07T17:00:00.000Z" },
  });
  // Ingestion reports; it does not attest. There is no `verifySportsResult` in the
  // contract at all, so nothing in this slice can set the flag.
  assert.equal(stored.verified, false);
  assert.equal(stored.verified_at, null);
  assert.equal(stored.home_score, 2);

  // A corrected scoreline updates the one row rather than adding a second.
  const corrected = await store.saveSportsResult(match.id, provider.id, {
    status: "FINISHED", homeScore: 3, awayScore: 1, sourceTimestamp: "2026-03-07T18:00:00.000Z", payload: {},
  });
  assert.equal(corrected.id, stored.id);
  assert.equal(corrected.home_score, 3);
  assert.equal((await store.findSportsResult(match.id, provider.id)).home_score, 3);
  assert.equal(corrected.verified, false, "divergence SP-14: a changed scoreline invalidates the attestation made about the old one");
});

test("a non-FINISHED result stores NULL scores, never 0-0", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  const postponed = await store.saveSportsResult(match.id, provider.id, {
    status: "POSTPONED", homeScore: null, awayScore: null, sourceTimestamp: "2026-03-07T17:00:00.000Z", payload: {},
  });
  // Writing 0-0 for a postponed match would fabricate a scoreline. NULL means "no
  // score was reported", which is a different fact from "no goals were scored".
  assert.equal(postponed.home_score, null);
  assert.equal(postponed.away_score, null);
  assert.equal(postponed.status, "POSTPONED");
  await assert.rejects(() => store.saveSportsResult(match.id, provider.id, { status: "ABANDONED", sourceTimestamp: "2026-03-07T17:00:00.000Z", payload: {} }), /result status/);
});

// ── quality ──────────────────────────────────────────────────────────────────

test("quality assessments are append-only, so eligibility at the time of a decision stays answerable", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  const match = await store.saveSportsMatch(provider.id, fixture());

  const assessment = {
    score: 90, band: "EXCELLENT", freshnessScore: 8, providerReliabilityScore: 90,
    eligibleForPrediction: true, eligibleForTicket: false,
    missing: ["odds"], checks: [{ field: "odds", ok: false, weight: 18 }],
  };
  await store.saveSportsQuality(match.id, assessment);
  await store.saveSportsQuality(match.id, { ...assessment, score: 60, band: "LIMITED", eligibleForTicket: false });

  // Two assessments, not one overwritten: "was this fixture eligible when we acted on
  // it" must stay answerable after the next sync re-scores it.
  const latest = await store.latestSportsQuality(match.id);
  assert.equal(latest.score, 60);
  assert.equal(latest.band, "LIMITED");
  assert.deepEqual(latest.missing_fields, ["odds"], "the breakdown is stored, because a score with no breakdown is an assertion");
  assert.equal(latest.eligible_ticket, false);
  assert.equal(latest.eligible_prediction, true);
  await assert.rejects(() => store.saveSportsQuality(match.id, { ...assessment, band: "SUPERB" }), /quality band/);
});

// ── health and retention ─────────────────────────────────────────────────────

test("health is a series of observations, and the monitor's window is what the repository bounds", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();

  await store.saveSportsHealth(provider.id, { status: "ONLINE", responseMs: 120, errorRate: 0, recordsReceived: 12, missingFields: [] });
  await store.saveSportsHealth(provider.id, { status: "RATE_LIMITED", responseMs: 40, missingFields: ["kickoff"] });

  const latest = await store.latestSportsHealth(provider.id);
  assert.equal(latest.status, "RATE_LIMITED");
  // Both read paths decode this column. Legacy decoded it on `latestHealth` and not on
  // `listHealth`, so the monitor's callers had two shapes for one column depending on
  // which method fetched the row (divergence SP-17).
  assert.deepEqual(latest.missing_fields, ["kickoff"]);
  const listed = await store.listSportsHealth(provider.id, 20);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0].missing_fields, ["kickoff"]);
  assert.deepEqual(listed[1].missing_fields, []);
  assert.equal(listed[0].status, "RATE_LIMITED", "newest first — element 0 is what the monitor treats as the last report");
  assert.equal(latest.response_ms, 40);
  assert.equal(listed[1].records_received, 12);
});

test("pruneSportsHealth deletes only what is older than a canonical cutoff and reports how much", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());
  await store.ensureSportsProvider("sandbox-sim", "sandbox-sim");
  const [provider] = await store.listSportsProviders();
  await store.saveSportsHealth(provider.id, { status: "ONLINE" });
  await store.saveSportsHealth(provider.id, { status: "ONLINE" });

  // A cutoff far in the future removes everything; one in the past removes nothing.
  assert.equal(await store.pruneSportsHealth("2000-01-01T00:00:00.000Z"), 0);
  assert.equal((await store.listSportsHealth(provider.id)).length, 2);
  assert.equal(await store.pruneSportsHealth("2999-01-01T00:00:00.000Z"), 2);
  assert.deepEqual(await store.listSportsHealth(provider.id), []);

  // Risk R-27: the cutoff is compared as text, so a mixed-format cutoff would delete
  // the wrong rows. Both adapters refuse anything that is not canonical.
  await assert.rejects(() => store.pruneSportsHealth("2026-03-01T12:00:00+00:00"), /ISO-8601 UTC/);
  await assert.rejects(() => store.pruneSportsHealth("yesterday"), /ISO-8601 UTC/);
});

// ── SQL shape ────────────────────────────────────────────────────────────────

test("the MySQL adapter bounds every LIMIT as an integer and never interpolates caller text", async () => {
  // Each read's bound is legacy's bound, kept so the two adapters return the same
  // window for the same limit: `min(1000, max(1, limit))` for fixtures, 200 for
  // health, 500 for odds and sync runs. The bound is interpolated as an integer this
  // function computed — never as caller text, which is the difference between a
  // bounded read and an injection point.
  const bounds = [
    ["listSportsMatches", [{}, 5000], "FROM wf_sports_matches", "LIMIT 1000"],
    ["listSportsMatches", [{}, 0], "FROM wf_sports_matches", "LIMIT 1"],
    ["listSportsHealth", [1, 900], "FROM wf_sports_provider_health", "LIMIT 200"],
    ["listSportsOdds", [1, 9000], "FROM wf_sports_odds", "LIMIT 500"],
    ["listSportsSyncRuns", [{}, 9000], "FROM wf_sports_sync_runs", "LIMIT 500"],
  ];
  for (const [method, args, table, expected] of bounds) {
    const capture = recordingExecutor({ rows: [] });
    await createSportsRepository(capture)[method](...args);
    const call = capture.calls.find((entry) => entry.sql.includes(table));
    assert.ok(call, `${method} must read ${table}`);
    assert.match(call.sql, new RegExp(expected.replace(" ", "\\s+")), `${method}(${args[1] ?? args[0]}) must be bounded to ${expected}`);
  }

  const capture = recordingExecutor({ rows: [] });
  await createSportsRepository(capture).listSportsMatches({ status: "LIVE", competition: "Premier" }, 200);
  const listed = capture.calls.find((call) => call.sql.includes("FROM wf_sports_matches"));
  assert.deepEqual(listed.values, ["LIVE", "Premier%"], "filter values are bound, never concatenated");
  assert.ok(!listed.sql.includes("LIVE"), "and no bound value may appear in the statement text");
  assert.match(listed.sql, /competition LIKE \?/);

  // A limit that is not a number falls back to the default rather than producing
  // `LIMIT NaN`, which would be a syntax error surfacing as a 500.
  const fallback = recordingExecutor({ rows: [] });
  await createSportsRepository(fallback).listSportsMatches({}, "not-a-number");
  assert.match(fallback.calls.find((call) => call.sql.includes("FROM wf_sports_matches")).sql, /LIMIT 200/);
});

test("the MySQL adapter upserts on the unique key rather than selecting then inserting", async () => {
  const capture = recordingExecutor({ rows: [{ id: 4, provider_id: 1, external_id: "a", sport: "football", competition: "C", home_team: "H", away_team: "A", kickoff_at: T0, status: "SCHEDULED", source_timestamp: T0, payload: "{}", created_at: T0, updated_at: T0 }] });
  const repository = createSportsRepository(capture);
  await repository.saveSportsMatch(1, fixture());
  const insert = capture.calls.find((call) => call.sql.includes("INSERT INTO wf_sports_matches"));
  assert.ok(insert);
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/);
  assert.ok(!insert.sql.includes("created_at = VALUES(created_at)"), "an upsert must not move created_at");

  const results = recordingExecutor({ rows: [] });
  await createSportsRepository(results).saveSportsResult(1, 2, { status: "FINISHED", homeScore: 1, awayScore: 0, sourceTimestamp: T0, payload: {} });
  const resultInsert = results.calls.find((call) => call.sql.includes("INSERT INTO wf_sports_results"));
  assert.match(resultInsert.sql, /verified = 0/);
  assert.match(resultInsert.sql, /ON DUPLICATE KEY UPDATE[\s\S]*verified = 0[\s\S]*verified_at = NULL/,
    "re-ingesting clears the attestation in SQL too (divergence SP-14)");
});

test("the MySQL adapter lets the execution key arbitrate and translates the collision to null", async () => {
  const duplicate = Object.assign(new Error("Duplicate entry 'k' for key 'uq_wf_sports_sync_runs_execution_key'"), { code: "ER_DUP_ENTRY" });
  const capture = {
    calls: [],
    async query() { return [[], []]; },
    async execute(sql) {
      this.calls.push(sql);
      if (sql.includes("INSERT INTO wf_sports_sync_runs")) throw duplicate;
      return [{ affectedRows: 1 }, []];
    },
  };
  // Divergence SP-12: legacy checked for the key and then inserted without catching
  // the duplicate-key error, so two concurrent runs of one window would have had the
  // loser throw out of the sync instead of reporting a skip.
  const outcome = await createSportsRepository(capture).startSportsSync({
    id: "77777777-7777-4777-8777-777777777777", providerId: 1, jobType: "FIXTURES", executionKey: "k",
  });
  assert.equal(outcome, null, "a lost race reports the same answer as a lost check");
  assert.equal(capture.calls.filter((sql) => sql.includes("INSERT INTO wf_sports_sync_runs")).length, 1,
    "one insert attempt, with no preceding existence check");
});

// ── end to end, on the adapter the tests can actually run ────────────────────

test("a full ingestion round trip stores fixtures, odds, results, quality and the run itself", async (t) => {
  const store = await tempFileStore(t);
  t.after(() => store.close());

  const provider = {
    id: () => "sandbox-sim",
    async health() { return { status: "ONLINE", responseMs: 5, reliability: 0.9 }; },
    async fixtures() { return [fixture({ externalId: "f1" }), fixture({ externalId: "f2" })]; },
    async odds(externalId) { return [odds({ selection: "HOME" }), odds({ selection: "AWAY" })].map((row) => ({ ...row, externalId })); },
    async results() { return [{ externalId: "f1", status: "FINISHED", homeScore: 2, awayScore: 0, sourceTimestamp: "2026-03-07T17:00:00.000Z" }]; },
  };
  const audits = [];
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === "recordAudit") return async (entry) => { audits.push(entry); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const sync = createSportsSyncService({ store: wrapped, now: () => Date.parse("2026-03-01T12:00:00.000Z") });
  const first = await sync.syncFixtures(provider, { from: "2026-03-07", to: "2026-03-08" }, "fixtures:2026-03-07");
  assert.equal(first.status, "COMPLETED");
  assert.equal(first.processed, 2);
  // SP-13, end to end: a first sync of two fixtures reports two CREATIONS. Under
  // legacy's return shape it would have reported `created: 0, updated: 2`.
  assert.equal(first.created, 2);
  assert.equal(first.updated, 0);

  const second = await sync.syncFixtures(provider, {}, "fixtures:2026-03-07b");
  assert.equal(second.created, 0);
  assert.equal(second.updated, 2, "a re-sync of the same fixtures updates them");

  const duplicate = await sync.syncFixtures(provider, {}, "fixtures:2026-03-07");
  assert.equal(duplicate.status, "DUPLICATE_SKIPPED");
  assert.equal(duplicate.runId, undefined, "no run was opened, so there is no run id to report");

  const oddsRun = await sync.syncOdds(provider, "f1", "odds:f1");
  assert.equal(oddsRun.status, "COMPLETED");
  assert.equal(oddsRun.created, 2);

  const resultsRun = await sync.syncResults(provider, "f1", "results:f1");
  assert.equal(resultsRun.status, "COMPLETED");

  const [providerRow] = await store.listSportsProviders();
  const matches = await store.listSportsMatches();
  assert.equal(matches.length, 2);
  const detail = await store.findSportsMatch(providerRow.id, "f1");
  assert.equal((await store.listSportsOdds(detail.id)).length, 2);
  assert.equal((await store.findSportsResult(detail.id, providerRow.id)).home_score, 2);
  assert.equal((await store.latestSportsQuality(detail.id)).eligible_ticket, false,
    "ingesting fixtures can never on its own make a fixture eligible to be staked on (divergence SP-22)");

  const runs = await store.listSportsSyncRuns();
  assert.equal(runs.length, 4, "three syncs plus the duplicate's original — the duplicate wrote nothing");
  assert.equal(runs.filter((run) => run.status === "COMPLETED").length, 4);
  assert.ok(audits.length >= 4, "every run that opened is audited");
  assert.ok(audits.every((entry) => entry.entityType === "sports_sync_run"));
});
