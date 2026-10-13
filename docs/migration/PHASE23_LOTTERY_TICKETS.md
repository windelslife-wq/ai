# Phase 23 — Lottery Intelligence: saved tickets, checking and archive (row 15, slice 3)

> **Status: landed on `arena/653d6218-ai`.** This record covers slice 3: the saved-ticket record —
> create, list, detail, check against stored VERIFIED draws, and soft archive — its persistence
> (migration **018**), and the five routes legacy's `Api_lottery` declares for them. It does
> **not** cover backtests, model versions, measured performance, the lottery cron or the console
> screens. The previous record is
> [`PHASE22_LOTTERY_COMBINATIONS.md`](PHASE22_LOTTERY_COMBINATIONS.md).

## 1. What this phase is

A ticket on this platform is a **record of number lines** — never a purchase. Nothing here
executes, buys, reserves or pays; the port carries no `externalExecution` anywhere near it, and
the API responses say so in the same breath the spec (§30) does: these are the user's own picks,
kept so they can be checked later against draws the platform has already ingested and VERIFIED.

Checking reports official prize-tier **labels** ("TIER_1 (5 mains + 2 stars)" … "TIER_10
(2 stars)") and never an amount. The ticket's own `result` column stores exactly the matched
lines and their tier labels; prize money varies per draw and is not stored — the response note
carries that sentence verbatim, and it also states why this surface exists at all: these are
**ACTUAL ticket outcomes**, kept separate from backtest results and demo data (spec §30).

## 2. What was ported

Migration **018** adds `wf_lottery_tickets` and `wf_lottery_ticket_lines` (schema now **52**),
taking the repository contract to **180** methods (**36** lottery) on both adapters and the
route inventory to **140** of **141** total (the tickets' three reads and two POSTs are
`lottery.view`). Ported from `LotteryIntelligence` (legacy lines 448–610):

- **createTicket** — name required, ≥1 line, ≤50 lines (`MAX_TICKET_LINES`), method uppercased
  and member of `TICKET_METHODS` else `unknown generation method: X`, draw date a real Y-m-d
  calendar date (legacy's own `invalid draw date: X` string — deliberately **not**
  `assertDrawDate`, whose message is the stored-draw validator's), every line rules-validated
  with the first offender reported as `line {i+1} invalid: {errors joined "; "}`. Lines are
  stored **sorted** — the service sorts values before the store sees them, and the store
  preserves them exactly as given (a store that reordered would hide a service regression).
  `model_version` defaults to the literal `'MANUAL'`; status starts `OPEN`.
- **listMyTickets / ticketDetail** — owner-scoped by default; the detail route widens to
  **any** ticket for an actor holding `lottery.manage` (legacy's `identity->can` branch). There
  is no status filter anywhere: an ARCHIVED ticket still reads back through detail, and archive
  is a soft delete that flips status only.
- **checkTicket** — scoped find; stored draws filtered to the ticket's lottery code, VERIFIED
  status, and on-or-before the ticket's draw date when it has one. No stored draw → status
  `NO_DRAW` with legacy's note, surfaced by the route as **409**
  (`no stored draw to compare yet (sync the provider first)`) — a missing comparison is never a
  fake zero, and the ticket is NOT marked CHECKED on that path. Matches are set intersections
  (`phpIntval` semantics preserved); the result carries draw date, external id, source, per-line
  match counts and tier labels, then the row moves to `CHECKED`.
- **archiveTicket** → status `ARCHIVED`, audited like create and check
  (`lottery.ticket.created` / `checked` / `archived`; legacy audited UPPERCASE — the lowercase
  actions are the slice-1 divergence, kept consistent).

The free-form `configuration` caller JSON is stored verbatim (legacy's `json_decode`'d column).
The framework validator strips undeclared keys inside objects, so it gained one declared
passthrough — `{ type: "object", additionalProperties: true }` with no declared properties —
type-checked as a plain object, inner keys untouched (commented in `src/http/validate.js`).

## 3. What was deliberately NOT ported

Everything that would turn a record into a transaction: no purchase, no execution, no
`externalExecution` field, no amount anywhere in a tier label or the stored result. Also still
not ported (later slices): backtests and model versions, measured performance, the lottery cron
(F-29's console screens with it) — the queued background system builds from slice 2 still have
**no consumer** until the cron lands.

## 4. How it is proven

The differential golden grows to **122 cases** (+4 ticket cases: the constants, the full 6×3
tier grid, the ten official tier strings, and the order-dependent `match(true)` ladder —
`prizeTier(5,3)` is `TIER_3` because the legacy ladder has **no star upper bound**; the oracle
corrected an initial wrong assumption here). Three test files:

- `test/lottery_tickets_parity.test.js` — the Node `prizeTier` and constants reproduce PHP
  byte-for-byte;
- `test/lottery_tickets_store.test.js` — contract pin (180), round-trip with decoded
  configuration and as-given lines surviving reopen, update whitelist
  (exactly `status`/`result`/`updated_at`, per-column validation, silent on missing id and
  empty patch), SQL shapes with user isolation in every WHERE and legacy's insert column list;
- `test/lottery_tickets_http.test.js` — the lifecycle (create sorted, six validation refusals
  with legacy's strings and no partial writes, check → `TIER_1` against a sandbox draw, the
  NO_DRAW 409 leaving the row OPEN, archive soft, 404s), cross-user isolation over HTTP
  (other user's list empty; detail/check/archive all 404 — invisible, not forbidden; admin
  `lottery.manage` detail scope), and anonymous 401 on all five routes.

Gates at close: `npm run check` exit 0 — **949/949** across 62 files, **29/29** install;
oracle **367/367**; legacy tree byte-identical; version **0.20.0**.

## 5. What this phase does not claim

No MySQL server was exercised: migrations 016–018 are not applied to any real database and the
SQL repository is proven against a recording executor (F-15). Nothing is deployed. The check
path has been run end-to-end only against the labelled sandbox provider (`sandbox-simulation`,
double-gated); no official provider was contacted, and none could be from this sandbox. The
NO_DRAW 409 is unit- and HTTP-tested against the file adapter; its SQL sibling executes the
same service branch. Prize tiers are official EuroMillions labels; no prize amount is computed,
estimated or stored anywhere.

## 6. Decisions

- **DV-26 (port, operator-visible): the NO_DRAW check is a 409.** Legacy returns the
  `NO_DRAW` status in a 200 envelope; the port surfaces it as HTTP 409 with legacy's note as
  the message, consistent with every other lottery "nothing to compare yet" route. Pending user
  confirmation, same status as DV-22/24/25.
- **The framework validator passthrough** (`additionalProperties: true` on a property-less
  object) is a framework extension in `src/http/validate.js`, commented there, exercised by the
  HTTP test's configuration round-trip.
- **Ticket draw-date validation keeps legacy's error string** (`invalid draw date: X`) rather
  than reusing `assertDrawDate`, whose message belongs to the stored-draw validator — the two
  stay distinguishable in logs and responses.

## 7. Gates

| Gate | Result |
| --- | --- |
| `npm run check` (`verify:install` + full suite) | exit 0 — 949/949 tests, 62 files, 29/29 install checks |
| PHP/WASM oracle (`node runtime/run-tests.mjs`) | 367 passed, 0 failed |
| Legacy tree (`application/`, `system/`, `tests/`) | byte-identical, 0 changes |
| Differential lottery golden | 122 cases, regenerated from PHP, zero Node-side port fixes this slice |
| Version | 0.20.0 (slice bumps the minor: 0.18.0 → 0.19.0 → 0.20.0) |
