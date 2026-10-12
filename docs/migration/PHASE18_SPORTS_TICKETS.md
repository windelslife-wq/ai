# Phase 18 — Sports Intelligence: tickets (row 14, slice 4 of 5)

> **Status: slice 4 landed on `arena/7577d922-ai`, not merged. Slice 5 is not started.** This record
> covers correlation, the ticket optimizer, ticket governance (record and decide), and the daily
> ticket run. It does **not** cover settlement, result verification, the backtester, model drift
> or performance analytics. Those are slice 5, and they remain not ported. The previous record is
> [`PHASE17_SPORTS_DECISION_CHAIN.md`](PHASE17_SPORTS_DECISION_CHAIN.md).

## 1. What this slice is

Slice 3 decided whether one fixture qualifies. Slice 4 is the first slice that **proposes a ticket**:
a combination of qualified selections, inside the configured odds window, that no two of which share
a match, and whose pairwise correlation is within the configured limit. A ticket is recorded as
`PENDING_USER_APPROVAL`. A person approves or rejects it. An approval is a record. It is never an
order.

Nothing in this slice places a bet, moves a stake, settles a ticket or reaches a paper, execution or
broker path. The stake on a ticket is the configured `stake_amount`, copied, not sized (see §8).

## 2. What was ported

| Legacy (PHP, read-only) | Node | Notes |
|---|---|---|
| `Aegis\Sports\CorrelationEngine` | `src/modules/sports/correlation.js` | `assessCorrelation` and `classifySelections`, ported as written. Team and competition reads are at the top level, as legacy reads them (F-39). |
| `Aegis\Sports\TicketOptimizer` | `src/modules/sports/ticket-optimizer.js` | `ticketPool` (the filters, in legacy's order) and `optimizeTicket` (exhaustive search, best summed expected value, first wins a tie, never pads). |
| `Aegis\Sports\TicketGovernance::record`, `::decide` | `src/modules/sports/ticket-governance.js` | `buildTicket` and `decisionFor`. The automated branch is not ported (DV-22). |
| `Aegis\Sports\DailyTicketService` | `src/modules/sports/ticket-service.js` | `runDaily`, the reads, and the decision. The run reads stored fixtures (DV-21). Simulated candidates are refused for tickets (DV-20). |
| `Api_sports` ticket routes | `src/modules/sports/routes.js` | Five routes (§4). |

The optimizer's window, floors and limits come from the configuration row under legacy's camelCase keys
(`optimizerConfig` in `ticket-service.js`). The defaults are a window of 5.0–8.0, at most five selections,
and `maxCorrelation` MEDIUM.

## 3. Findings

### F-39 — legacy's correlation team and competition checks never fire

`CorrelationEngine` reads `homeTeam`, `awayTeam` and `competition` at the top level of a candidate. The
pipeline puts them under `match`. So in legacy, those checks never see a value, and only `SAME_MATCH` can
fire. Two selections that share a team are scored LOW and may sit on the same ticket.

The port keeps `assessCorrelation` as written. `candidateFor` in `ticket-service.js` copies the three fields
up from `match`, so the documented checks run. The golden test records both behaviours: the pipeline-shaped
pair is LOW, and the port-shaped twin is HIGH. The difference is therefore evidence, not a silent change.

This changes ticket composition relative to legacy's production behaviour. **Pending your confirmation (§9).**

### F-40 — concurrent inserts shared an id (file adapter), fixed

`nextRowId` in `src/persistence/file-store.js` read the table's current maximum and returned one more. The
queued write, which stores the row, ran later. Two inserts that started in the same tick therefore both read
the same maximum and both received the same id. A test inserting three matches with `Promise.all` got
`[1, 1, 1]`.

The daily run can hit the same race when two runs for different days overlap, because each writes selections.
`nextRowId` is now monotonic: it records the highest id it has issued per entity, so an id is never reissued
before its write is applied. The MySQL adapter is unaffected, because its ids are `AUTO_INCREMENT`. This
predates slice 4 (Phase 16's match ingestion). It was found while testing this slice and is covered by the
F-40 test in `sports_tickets_store.test.js`.

## 4. The surface

### Repository

Nine methods, `SPORTS_TICKET_METHODS`, added to the shared contract: `saveSportsTicket`, `findSportsTicket`,
`listSportsTickets`, `listSportsTicketSelections`, `decideSportsTicket`, `claimSportsDailyTicketRun`,
`finishSportsDailyTicketRun`, `findSportsDailyTicketRun`, `listSportsDailyTicketRuns`. The contract grows
from 120 to **129**. Both adapters implement all nine over the same row shapes (`src/persistence/sports-rows.js`).

### Routes

Five routes. Reads are `sports.view`. Running the daily ticket is `sports.manage`. Deciding a ticket is
`sports.approve`, the permission legacy's `Api_sports` checks for approval.

| Route | Permission | Purpose |
|---|---|---|
| `POST /api/v1/sports/daily-tickets/run` | `sports.manage` | Run generation for one UTC day (default today). Body: `date`. |
| `GET /api/v1/sports/daily-tickets` | `sports.view` | Run outcomes, newest first. |
| `GET /api/v1/sports/tickets` | `sports.view` | Tickets. Filters: `approvalStatus`, `runDate`. |
| `GET /api/v1/sports/tickets/:ticketId` | `sports.view` | One ticket with its selections. |
| `POST /api/v1/sports/tickets/:ticketId/decision` | `sports.approve` | Body: `approve` (boolean, required), `reason`. |

The sports surface grows from 20 to **25** routes. The total route count is **106** (was 101).

### Audit actions

`sports.daily_ticket.run` (every run, including skipped and failed ones), `sports.ticket.approved` and
`sports.ticket.rejected`. Each decision audit carries `externalExecution: false`.

### Ledger label

The `sports` label in `src/modules/platform/health.js` is rewritten for slice 4. It now lists the ticket
surface, and states that nothing is executed. Its not-ported list is stake sizing, settlement, calibration
fitting, backtests, model drift and performance analytics. Its counts are fifteen `sports.view` reads, two
`sports.manage` reads, seven `sports.manage` writes and one `sports.approve` write.

## 5. Migration 013

`src/db/migrations/013_sports_tickets.sql` creates three tables. Migrations 001–012 are unchanged. The
schema grows from 35 to **38** tables.

| Table | Purpose | Constraint that carries meaning |
|---|---|---|
| `wf_sports_tickets` | One row per recorded combination. | `id` is `tkt_` plus 16 hex, generated before the insert. `status` is `PENDING` until a person decides. The engine never writes `APPROVED` (DV-22). |
| `wf_sports_ticket_selections` | One row per leg, linked to its prediction by id. | Written in the same transaction as the ticket on MySQL. |
| `wf_sports_daily_tickets` | One row per (run date, configuration version). | `UNIQUE (run_date, configuration_version)`. The claim is an insert on this key. |

There are **no foreign keys**, as in migrations 011 and 012. Referential integrity is by convention, and the
repository writes a ticket and its legs together. Migration 013 is **not applied to any database** in this
sandbox. No MySQL server runs here (F-15).

## 6. Divergences

Numbering continues from Phase 17, whose last entry is DV-19.

| ID | Divergence | Kind | Why |
|---|---|---|---|
| **DV-20** | A simulated candidate is recorded as a prediction, but never enters the ticket pool | Deliberate (user-chosen) | Legacy's gate ignores the `simulated` flag, so a sandbox fixture with a fresh price can be placed on a ticket. The user chose refusal. Real-data tickets are unchanged. The run reports `simulatedRefused` and says so in its message. |
| **DV-21** | The daily run reads stored fixtures and stored odds. It calls no provider | Deliberate, **pending approval** | Legacy fetches the day's fixtures and odds inside the run. The port reads what the sync already stored. A run therefore cannot reach a provider, and a stored fixture with no odds rejects on `ODDS_UNAVAILABLE`. |
| **DV-22** | The automated branch of `TicketGovernance` is not ported. A ticket is never `APPROVED` by the engine | Deliberate, **pending confirmation** | Legacy marks a ticket `APPROVED_NOT_EXECUTED` directly when its mode is automated. The configuration refuses `AUTOMATED_EXECUTION` (DV-14), so that branch cannot be reached through this API. |
| **DV-23** | A run that throws is stored as `FAILED`, not as `NO_QUALIFIED_TICKET` | Deliberate, **pending confirmation** | Legacy stores such a run as `NO_QUALIFIED_TICKET` with the error in its message, which reads as "no candidate qualified" when the system broke. |
| **F-39** | Legacy's team and competition correlation checks never fire. The port runs them | Divergence, **pending confirmation** | See §3. |
| **F-40** | Concurrent inserts shared an id on the file adapter. Fixed | Defect fix | See §3. Predates slice 4. |

Two behaviours that are not divergences from legacy, but that a reader must know:

- **The file adapter writes a ticket and its legs as separate appends.** A crash between them leaves a
  ticket with missing legs. The MySQL adapter writes them in one transaction. Recorded as R-30.
- **A run that crashes mid-way stays `RUNNING`.** It blocks that day and configuration version, and no
  route recovers it (R-29).

## 7. The differential harness

`runtime/parity/sports-tickets-golden.php` holds three groups, which `runtime/parity/sports-golden.php`
includes as `$slice4`: `correlation` (8 cases), `classifySelections` (4) and `optimize` (17), plus a
`constants` group with the score table and the optimizer defaults. The two PHP classes are loaded with
`require_once`, because the golden file runs in the same process as the slice 3 golden.

The regenerated golden adds the `cases.slice4` key and nothing else. Its diff against `HEAD` is **4217
insertions and zero deletions**, and every existing key is byte-identical. The generator now exits when
it has written the file. It did not before (see §10).

`test/sports_tickets_parity.test.js` checks the three groups, **5 tests**. Correlation, classification and
optimizer results are compared exactly, after the same canonicalisation the slice 3 test uses. The
optimizer's ticket id is stripped by the golden, so the test checks its shape, and checks that it is
present exactly when legacy's result had one. The F-39 test pins the pipeline-shaped result as LOW, and
checks that the port-shaped twin is HIGH.

The Phase 16 count mismatch (124 in the Phase 16 record, 134 records in its golden sections) is not
reconciled here. It is listed in §9.

## 8. What this slice does not claim

- **No stake is sized.** `stake` is the configured `stake_amount`, copied onto each ticket. Nothing is sized
  from bankroll or edge. This is listed as not ported (`SPORTS_NOT_PORTED`, "stake sizing").
- **No outcome, so no result.** Every ticket and selection carries `settlement_status PENDING` and a null
  result. Whether a ticket won is unknown until slice 5.
- **Nothing is executed.** `externalExecution` is `false` on every decision. Approval is a record only.
- **Simulated fixtures never reach a ticket** (DV-20), but they are still scored and recorded. A sandbox run
  therefore produces predictions and no tickets.
- **The daily run depends on the sync.** A day with no stored fixtures reports `no fixtures stored`. It does
  not fetch them (DV-21).
- **No recovery route.** A run stuck in `RUNNING` cannot be re-run or cleared. Its day and version stay
  blocked (R-29).
- **No MySQL was exercised** (F-15). The MySQL repository is tested against a scripted connection, which
  proves the adapter's rules and the SQL it sends. It does not prove the SQL executes.
- **Migration 013 is not applied to any database.**
- **No cron.** The daily run is an operator action. `SportsCronService` is still unported.
- **Nothing is deployed.** No release was cut. Version is unchanged at 0.15.0.

## 9. Decisions

**Decided by the user (2026-10-12):**

1. **Simulated candidates are refused for tickets** (DV-20). The user chose this as a deliberate departure from
   legacy. Real-data tickets are unchanged.

**Pending, to confirm before this phase is accepted:**

2. **F-39.** Should the port run the team and competition correlation checks, as legacy's documented intent
   says, or match legacy's production behaviour, where only `SAME_MATCH` fires? The port runs them. This
   refuses some pairs that legacy would place on one ticket.
3. **DV-21.** Is it acceptable that the daily run reads stored data and never fetches from a provider?
4. **DV-22.** Is it acceptable that the engine never marks a ticket approved, and that the automated branch is
   absent?
5. **DV-23.** Should a run that throws be `FAILED`, which the port does, or `NO_QUALIFIED_TICKET`, as legacy does?
6. **`ticketEngine` status value.** The engine exists and runs only when an operator asks. The synchronous status
   surface cannot read configuration, so `GET /api/v1/sports/status` and the system status report it as
   `ON_REQUEST`, not `NOT_PORTED`. Enablement is read from `GET /api/v1/sports/configuration`. This value
   was chosen in this session and has not been approved.
7. **Sandbox qualification, globally.** PHASE17 §9 asked whether a sandbox `QUALIFIED` decision should be refused
   everywhere, not only for tickets. The answer so far covers tickets only.
8. **Calibration approval before slice 5** (carried from PHASE17 §9). Approval is still reachable only through a
   stored row, because the fit is refused until settlement exists.
9. **Record numbering.** Slice 3 is Phase 17, this slice is Phase 18, and slice 5 is Phase 19. This is assumed,
   not confirmed.
10. **Phase 16 golden count** (124 in its record, 134 in its golden sections). Not reconciled.

## 10. Gates

Measured in `apps/workforce-platform` on this branch, on 2026-10-12, Node v22.22.3.

| Gate | Result |
|---|---|
| `npm test` (run by `npm run check`) | **875 / 875** across **51** files (was 841 / 841 across 47). The 34 new tests are `sports_tickets_parity` (5), `sports_tickets_http` (8), `sports_tickets_store` (10) and `sports_ticket_governance` (11) |
| `npm run check` | **exit 0**. `verify:install` **29 / 29**; **76** documented variables |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367** |
| Legacy tree | `git status --porcelain application/ system/ tests/` is **empty** |
| Routes | **106** total (was 101); **25** sports (was 20) |
| Contract | **129** repository methods (was 120); **43** sports (was 34) |
| Schema | **38** tables (was 35); migrations **001–013** |
| Golden | `cases.slice4` added, 4217 insertions and zero deletions against `HEAD`. Regenerated with `runtime/sports-parity.mjs`, exit 0 |
| Version | **0.15.0**, unchanged |

Test pins updated for the new counts: the backup table map (38, with the three ticket tables), the migration
list and its readiness placeholders (13), the platform findings and retention contract pins (129), the sports
store pins (43), and the sports route inventory and its write-surface list.

**Tooling fix, found in this slice.** `runtime/sports-parity.mjs` wrote the golden and then did not exit, so
the first regeneration ran until a 600-second timeout killed it. It now calls `process.exit(0)` after writing.
The re-run wrote a byte-identical golden and exited 0.

**Not run:** a real MySQL server, and migration 013 against any database.

## 11. Ledger

`sports` stays **partial** in the ledger, because slice 5 is not built. Row 14 in
[`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) describes slice 4 and names slice 5 as the remainder.

## 12. Open items and risks

- **R-29, no recovery route for a stuck run.** Needs a route, or an operator procedure, before any scheduled run.
- **R-30, the file adapter is not atomic for tickets.** Acceptable only while the file adapter is test or sandbox
  storage.
- **Calibration approval before slice 5** (§9, item 8).
- **Slice 5** (settlement, result verification, the backtester, `ModelDriftMonitor`, which closes NV-6, and
  performance analytics) is pending.
