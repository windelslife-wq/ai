# Phase 16 — Sports Intelligence slice 2: persistence and ingestion

**Branch:** `arena/8de8de2e-ai` · **Row:** 14 of `UNFINISHED_MODULES.md` (slice 2 of 5) · **Version:** 0.14.0 → 0.15.0
**Predecessor:** `PHASE15_SPORTS_FOUNDATION.md` (slice 1 — the normalized contracts, the two gates, the provider boundary, and the PHP↔Node differential harness).

---

## 1. What this slice is, in one paragraph

Phase 15 ported the classes that decide *whether a record may be trusted* and deliberately
created no tables, on the argument that schema nothing reads is dead schema. Phase 16 is
the other half of that argument: it creates the seven tables, writes the only code that
fills them, and exposes the result. Fixture, odds and result ingestion now runs end to end
— idempotently, under a caller-supplied execution key — and every run leaves evidence
behind that an operator can read. In the process it makes reachable a piece of legacy that
legacy itself never reached (finding **F-35**), and it closes the last gap in the sports
portion of **F-26** by putting the result normalizer and the health monitor under the
differential harness.

What this slice still cannot do is stated in §8 and is enforced by the absence of tables
rather than by a runtime check: **no prediction, no ticket, no settlement, no calibration,
no backtest, and no verified result.**

---

## 2. What was ported

| Legacy | Lines | Node | Notes |
|---|---|---|---|
| `Aegis_model.php` sports repository (anonymous class, lines 154–332) | ~178 | `src/db/sports-repository.js` | 22 of the interface's methods; see §4 |
| `SportsResultNormalizer` | 11 | `src/modules/sports/result-normalizer.js` | Under differential parity |
| `SportsSyncService` | 75 | `src/modules/sports/sync.js` | All three entry points |
| `ProviderHealthMonitor` *(made reachable)* | 93 | `src/modules/sports/health-monitor.js` (Phase 15) | Now fed real rows; under parity |
| — *(no legacy counterpart)* | — | `src/persistence/sports-rows.js` | Shared validators and row mappers |
| `application/database/sports.mysql.sql`, `sports_results.mysql.sql` | — | `src/db/migrations/011_sports_foundation.sql` | 7 tables |

The concrete repository was the blocking unknown going in. `Persistence/Repositories.php`
holds only the 65-method **interface**; the implementation is an *anonymous class inside
`application/models/Aegis_model.php`*, one per aggregate, which is why a grep for
`SportsRepository` across `application/` returns only consumers. Worth recording as a
navigation fact: in this codebase the persistence behaviour lives in a model file, not in
the persistence namespace.

**Routes: 1 → 7.** Five reads (`sports.view`), one write (`sports.manage`), and the
existing status route.

---

## 3. Finding F-35 — legacy wrote sync evidence it could not read, and built a monitor it never called

Two independent gaps, found while looking for the repository implementation:

1. **`sports_sync_runs` has no reader.** The interface declares `startSync` and
   `finishSync`. Nothing in `application/` issues a `SELECT` against that table — verified
   by grepping every PHP file for the table name, which returns only the two write sites
   and one *docblock*. So a run's counters, and the per-record refusal messages that
   `finishSync` stores, were written into a table no operator could query. A row left in
   `RUNNING` — the evidence of a worker that died mid-sync — was invisible.
2. **`ProviderHealthMonitor::assess()` has no caller.** The only references to the class
   anywhere in the application are its `use` statement and its construction in
   `SportsIntelligence`. And its own docblock documents the third parameter as *"newest-first
   `sports_sync_runs` rows for this provider"* — the table that gap 1 says cannot be read.

So the derived provider status, which is the entire purpose of the monitor and the value
the data-quality engine consumes as `providerReliability`, was **never computed in the
legacy application**. The reliability that fed every quality assessment was whatever
`$health['reliability']` a provider happened to self-report.

This retroactively explains a Phase 15 decision. Slice 1 declined to report `derivedStatus`
on the unauthenticated status surface, reasoning that "a field that can only ever hold
`UNKNOWN` invites a reader to think it was measured". F-35 is the evidence for *why* it
could only ever hold `UNKNOWN`: legacy never measured it.

**What closes it** is not porting the class — Phase 15 already did that — but adding the
read it needs. `listSportsSyncRuns` has **no legacy counterpart** (divergence SP-15), and
it is the method that makes `assessProviderHealth` reachable. `GET /api/v1/sports/status`
now reports a derived status computed from stored health observations and stored sync runs,
and `test/sports_sync.test.js` asserts that after one sync it is *not* `UNKNOWN`.

A smaller observation from the same reading, recorded rather than acted on: `assess()`'s
first parameter is documented as the `sports_data_sources` row and is **never read** by the
implementation. The harness captures a case with an empty provider row to pin that.

---

## 4. The 22 contract methods, and why the other 43 are not here

`REPOSITORY_METHODS` goes **86 → 108**. The 22 are the foundation slice of a 65-method
interface:

| Group | Methods |
|---|---|
| Provider registry (3) | `ensureSportsProvider`, `listSportsProviders`, `setSportsProviderEnabled` |
| Provider health (4) | `saveSportsHealth`, `latestSportsHealth`, `listSportsHealth`, `pruneSportsHealth` |
| Fixtures (4) | `findSportsMatchById`, `listSportsMatches`, `saveSportsMatch`, `findSportsMatch` |
| Odds (4) | `saveSportsOdds`, `latestSportsOdds`, `listSportsOdds`, `findSportsOddsBefore` |
| Results (2) | `saveSportsResult`, `findSportsResult` |
| Quality (2) | `saveSportsQuality`, `latestSportsQuality` |
| Sync evidence (3) | `startSportsSync`, `finishSportsSync`, `listSportsSyncRuns` |

Deliberately **absent**, and owed by later slices:

- `verifySportsResult` and `findSportsResultByMatch` — settlement (slice 5). Ingestion
  *reports* a result; it must not get to *attest* to one. `sports.settle` already exists as
  a permission in the baseline, unused.
- Everything over predictions, tickets, selections, configurations, calibrations, job runs,
  backtests, model metrics, daily tickets and performance snapshots. Those eleven tables do
  not exist, so there is nothing for a method to return.

`setSportsProviderEnabled` is in the contract but has **no route**. Enabling a provider
changes what every future sync consults; that is a configuration decision belonging to the
configuration service (slice 3), not a side effect of an ingestion endpoint.

---

## 5. The seven tables

`011_sports_foundation.sql`, drafted in Phase 15 and **removed from that change** because
tables nothing reads are dead schema. They land here, in the same commit as their only
writer, so the schema and the code that fills it arrive together.

`wf_sports_data_sources` · `wf_sports_provider_health` · `wf_sports_matches` ·
`wf_sports_odds` · `wf_sports_results` · `wf_sports_data_quality_assessments` ·
`wf_sports_sync_runs`

Three design decisions carry the most weight, and all three are about *not* collapsing rows
that mean different things:

- **An odds row is an observation at an instant, never a current price.** There is no
  unique key on `(match, market, selection)`, and `latestSportsOdds` /
  `findSportsOddsBefore` are queries rather than columns. Point-in-time backtesting (slice
  5) depends on it: a table that overwrote in place could not answer "what did we know
  then".
- **Health is a series, not a value.** Append-only, so an outage is visible as a gap rather
  than as an overwritten row, and the monitor derives from the newest N.
- **A result's `verified` flag is not set by ingestion.** Nullable scores mean "no score was
  reported", which is a different fact from "no goals were scored" — writing `0-0` for a
  postponed match would fabricate a scoreline.

No column names a stake, a wager, a payout or a bookmaker account, and there is no foreign
key to any trading, order or broker table. Provider and match ids are plain integers rather
than foreign keys for the reason migration 010 gives for avoiding `GET_LOCK()`: the file
adapter must implement the identical contract and has no referential engine.

---

## 6. Divergences SP-12 … SP-26

SP-1 … SP-11 are in `PHASE15_SPORTS_FOUNDATION.md` and still hold.

| # | Divergence | Direction | Why |
|---|---|---|---|
| **SP-12** | `startSportsSync` lets the UNIQUE key arbitrate and catches the duplicate-key error | **Improvement** | Legacy did `SELECT … if found return null` then `INSERT` *without* catching the collision, so two concurrent runs of one window would have had the loser throw out of the sync instead of reporting a skip. Same answer whether the race is lost by microseconds or never happens. The `wf_job_locks` lesson from Phase 12. |
| **SP-13** | `saveSportsMatch` returns `created_at` on the insert path | **Fixes a legacy defect** | Legacy's insert branch returned `array_merge($data, […])`, which has no `created_at` key, while its update branch returned the existing row, which does. The sync service distinguishes created from updated by testing `!empty($row['created_at']) && $row['created_at'] === $row['updated_at']` — so on the insert path that test could never be true and **every newly stored fixture was counted as an update**. A first sync of twelve fixtures reported `created: 0, updated: 12`. The comparison is unchanged; the row it reads is not. These counters are operator evidence, and false evidence is worse than divergent evidence. **Residual caveat:** the discrimination is only as fine as the clock — two writes inside one millisecond make an update look like a creation. Legacy compared *second*-resolution stamps, so the collision was ~1000x likelier there; SP-19's millisecond width narrows it without removing it. Found the hard way, as a flaky test that was green seven times locally. |
| **SP-14** | Re-ingesting a result **clears** `verified` and `verified_at` | **Preserved** | Looks like data loss and is not: a provider that changes a scoreline invalidates the human attestation made about the old one, so the safe direction is to require a human to look again. Consequential because settlement and calibration read the flag rather than trusting ingestion. |
| **SP-15** | `listSportsSyncRuns` has no legacy counterpart | **Extension** | Closes F-35. Without it the monitor's third parameter cannot be supplied and the derived status cannot be computed. |
| **SP-16** | `%` and `_` in a competition filter are escaped | **Tightening** | Legacy passed the value to CodeIgniter's `like()` unescaped, so a filter of `"%"` matched every row. It disclosed nothing (the caller may already read the whole table) but a prefix filter that behaves as a wildcard is not the filter that was asked for. |
| **SP-17** | Both health read paths decode `missing_fields` | **Improvement** | Legacy decoded with a `'[]'` fallback on `latestHealth` and *not* on `listHealth`, so the same column had two shapes depending on which method fetched the row — and the monitor reads it as an array. |
| **SP-18** | All 22 methods are module-prefixed | **Necessary** | The contract is **one flat namespace** spread into a single store object; a PHP interface is scoped by the interface. Legacy's *lottery* repository declares `ensureProvider`, `saveHealth`, `latestHealth`, `listHealth` and `deleteOldHealth` with **identical names**, so porting row 15 would have overwritten row 14's methods in the spread and the last module to load would silently win. Caught before writing a line of the lottery port. |
| **SP-19** | Timestamps are written canonical UTC **always with milliseconds** | **Fixes a defect introduced here** | The first draft used `.replace(".000Z", "Z")`. These columns are compared as **text** — `kickoff_at >= ?`, `observed_at < ?`, every `ORDER BY … DESC`. `"…T12:34:56.789Z"` sorts *before* `"…T12:34:56Z"` because `.` is 0x2E and `Z` is 0x5A, even though it is 789 ms *later*. A conditional trim therefore misorders two rows in the same second, silently. `assertIsoCutoff` in `contract.js` already warns about this hazard for `wf_analysis_runs.completed_at`. One fixed width, always. Pinned by a test that measures the lengths. |
| **SP-20** | The competition prefix match is case-insensitive on the file adapter | **Alignment** | MySQL's `utf8mb4_unicode_ci` collation makes `LIKE 'pre%'` case-insensitive; a JS `startsWith` is not. Lowercasing both sides keeps the two adapters answering the same question. |
| **SP-21** | `syncResults` persists **no** health observation | **Preserved** | Legacy's `syncResults` calls `provider->health()` and gates on it but never stores it, unlike `syncFixtures` and `syncOdds`. So a provider used only for results leaves no health row and shows as `UNKNOWN` to the monitor forever. Kept because silently adding a write would change what the monitor sees for every existing deployment — recorded so the gap is a decision rather than an oversight. |
| **SP-22** | A fixture sync always leaves `eligible_ticket` false | **Preserved, and load-bearing** | Legacy scores each fixture at sync time with `oddsAvailable: false`, `recentFormAvailable: false`, `dataAgeSeconds: 0` — all true at that moment. The odds check is worth 18 of 108 points, so a fixture can score at most 90, and `eligibleForTicket` additionally requires `freshnessScore > 0`. **Ingesting fixtures can therefore never, on its own, make a fixture eligible to be staked on.** That is the gate working, not a bug: ticket eligibility requires an odds observation the fixture call does not have. |
| **SP-23** | Error messages are truncated to 200 characters uniformly at the repository | **Consistency** | Legacy truncated in `syncOdds` and `syncFixtures` (`mb_substr`) but not in `syncResults`. One bound, applied where the column is written. |
| **SP-24** | Audit actions use the platform's dotted-lowercase vocabulary | **Consistency** | Legacy emits `SPORTS_FIXTURE_SYNC_COMPLETED` and five siblings. The audit browser filters on these strings and is the only console this platform has (**F-29**); one event type spelled two ways is two event types to anyone building a filter. `sports.sync.<job>.<outcome>`. |
| **SP-25** | `findSportsOddsBefore` compares at **second** granularity | **Preserved** | Legacy compares by `strtotime(...)`, which returns whole seconds, so an observation at `.000` and a bound at `.001` are the same instant and the observation is not "before" it. A millisecond-precise port would return a row where the original returns none. Real limitation with a real consequence — two observations within one second cannot be ordered by this query — and SP-19 is what would make a stricter *text* comparison safe if a later slice wants one. Changing it changes what a backtest can see, and preserving behaviour comes before improving it. Pinned by a test. |
| **SP-26** | A filter carrying a UTC offset is **normalized**, not refused | **Deliberate** | The *columns* hold one canonical width, but an *input* with an explicit offset is parsed and converted, so `+01:00` becomes the equivalent `…Z` instant and the comparison stays chronological. `assertJobLockInstant` refuses offsets, which is right for an internal caller that must already be canonical and unhelpful for an HTTP client entitled to name its own zone. Comparing an offset string as text would be the actual bug. |

### Two defects found and fixed while writing this slice

- **D-27** — `status({probe: true})` was first changed to report `persisted: store !== null`.
  That is **false**: a probe writes nothing, only ingestion appends health rows. It would
  have reported `persisted: true` for a reading stored nowhere — a false claim about
  provenance on the one field whose only job is to make that claim. Reverted to
  unconditionally `false`, with the reason recorded. Not writing on a probe is also what
  keeps a dashboard load from mutating the history the monitor derives from: twenty refreshes
  would otherwise append twenty observations, and the error-rate and staleness rules would be
  measuring refreshes rather than the provider.
- **D-28** — the first draft named the 22 methods `ensureProvider`, `saveHealth`,
  `latestHealth`, `listHealth`, `saveMatch`, `findResult`. They matched legacy exactly and
  violated the platform's own convention: **every one of the existing 86 contract methods is
  module-prefixed** (`savePaperOrder`, `findExecutionProposal`, `pruneAnalysisRuns`). The
  collision with the unported lottery repository (SP-18) is what makes it a defect rather
  than a style preference.

---

## 7. What the differential harness now covers (F-26)

`runtime/parity/sports-golden.php` requires **eight** legacy classes (was six) and emits two
new case groups:

- **`result`** — 29 cases over `SportsResultNormalizer`. The interesting ones are the score
  edges, because `filter_var(..., FILTER_VALIDATE_INT)` is neither `is_int` nor
  `is_numeric`: a quoted integer passes, `"2.5"` fails, a whole float `2.0` stringifies and
  passes, `true` stringifies to `"1"` and passes, `false` stringifies to `""` and fails, and
  hexadecimal is refused. Those are exactly the edges a JavaScript port guesses at, so they
  are captured rather than reasoned about. `phpFilterValidateInt` reproduces all five.
- **`health`** — 32 cases over `ProviderHealthMonitor::assess`, covering all seven rules in
  precedence order, both boundaries (exactly 1800 s, exactly 0.5 error rate), the reliability
  helper's four branches, and the SP-11 asymmetry — a **future-dated** observation is skipped
  in the failure scan (which requires `at <= now`) but is still element 0 for `latest`, and a
  future-dated *terminal* report still wins because `recent()` does not bound above.

Regenerate with `node runtime/sports-parity.mjs`. It boots PHP 8.2 in WASM and takes several
minutes; a 300 s shell timeout is not enough, but the artifact is written regardless, so
check for the file before re-running.

**Still owed under F-26** (unchanged from Phase 15): the optimizer, the indicators,
`MathUtils`, regime generation and the notification rules. `SportsProviderManager` remains
outside the harness — it is stateful rather than pure, and its behaviour is covered by
`sports.test.js` against the ported providers.

---

## 8. What this slice does **not** claim

- **No prediction, ticket, stake, settlement, calibration or backtest.** The eleven tables
  those need do not exist, so there is nothing for a route to return and nothing for a
  service to compute. `GET /api/v1/sports/status` still reports `ticketEngine: "NOT_PORTED"`
  — not `DISABLED`, which would imply an engine exists and was switched off.
- **No stored result is verified.** `verified` is false for every row this slice can write,
  there is no `verifySportsResult` in the contract, and no route can set it.
- **No provider has been verified against a vendor.** The HTTP provider is a generic REST
  client that has never spoken to a real feed (**F-25**). The sandbox provider is
  deterministic, I/O-free and labelled `simulated: true` on every record.
- **No cron wiring.** `SportsCronService` is not ported; a sync happens only when an operator
  calls `POST /api/v1/sports/sync`. Adding a schedule that makes outbound calls is a decision
  for the slice that ports the configuration service, because the window and cadence come from
  `sports_configurations`.
- **No MySQL was exercised.** **F-15** stands: there is no MySQL in CI, so the SQL adapter is
  proven by statement shape and bound parameters against a recording executor, and behaviour
  is proven on the file adapter. `ON DUPLICATE KEY UPDATE` is asserted as text, not executed.
- **The file adapter's uniqueness is single-process.** `capabilities().crossProcessSafety` is
  `false`; the WAL queue serializes mutations within one process. Two Node processes on one
  directory can each believe they opened the same sync run. A real cron deployment needs
  MySQL, where the unique key is the arbiter.
- **NV-6 is still open.** `SPORTS_MODEL_DRIFT` remains unpublished; `ModelDriftMonitor` is
  slice 5.

---

## 9. Row 14's remaining slices

| Slice | Scope | Tables |
|---|---|---|
| **3** | prediction pipeline, feature engineering, match intelligence, confidence, calibration, model performance, **configuration service** (which unblocks cron) | 4 |
| **4** | ticket governance, value, risk, correlation, optimizer, daily ticket | 3 |
| **5** | settlement, result verification (**closes `verified`**), backtester (now unblocked — SP-25 is its one caveat), **`ModelDriftMonitor` (closes NV-6)**, performance analytics | 5 |

Slice 5's backtester is unblocked by this slice: odds are stored one row per observation and
`findSportsOddsBefore` answers the point-in-time question. SP-25's second granularity is the
one property a backtest author needs to know about.

---

## 10. Gates

| Gate | Result |
|---|---|
| `npm run check` | **0 failures** |
| `npm test` | **812 / 812** across 44 files (was 752 / 752 across 42) |
| New tests | `sports_store.test.js` (23), `sports_sync.test.js` (17), +12 in `sports_http.test.js`, +8 in `sports_parity.test.js` — **+60** |
| `verify:install` | **29 / 29**; no new environment variables |
| PHP oracle (`runtime/run-tests.mjs`) | **367 / 367** |
| Legacy tree | `git status --porcelain application/ system/ tests/` **empty** — 0 PHP paths modified |
| Routes | **88** total (was 82); **7** sports (was 1); admin routes unchanged at 7 |
| Contract | **108** methods (was 86); both adapters pass `assertRepositoryContract` |
| Schema | **31** tables (was 24); migrations 001–011 |
| Differential harness | 8 legacy classes, **124** cases (was 62) |
| Version | **0.15.0** |

Every tripwire fired as predicted and each was updated with its intent preserved rather than
relaxed: the table count 24 → 31 and the `counted` collection map; the last-migration
filename pin; the readiness migration list; the contract length in three files; the WAL-replay
stats map in two; and the module ledger's `partial` message and sports label. The label change
is the one worth calling out — it asserted `/no persistence/i`, which became **false**, and a
stale ledger label is worse than none because it is read as current documentation.
