# Phase 36 — the sports dashboard (row 3)

**Status:** complete · 2026-10-16 · branch `arena/046b29ac-ai`

`/app/sports` is now the port of `views/sports/index.php` (`Sports::index`) and `views/sports/tickets.php`
(`Sports::tickets`) on one screen: today's intelligence, the ticket the daily run produced and the person's
decision over it, the measured performance, the models and their calibrations, the provider boundary, and
the module's own statement of what it does not do. With it, **row 3 has no screen left** — the sports
dashboard was the last one it named.

The screen also closes a divergence it would otherwise have been a lie about: `Api_sports::decide_ticket`
refuses an approval while the platform kill switch is ACTIVE, and the Node decision route did not. That
guard is ported here (server-side), so the console's Approve button is refused by the API exactly as
legacy's was, and settlement stays available exactly as legacy designed it.

## Scope

| | |
|---|---|
| Legacy | `views/sports/index.php`, `views/sports/tickets.php`, `controllers/Sports.php` (`index`, `decide`, `settle`), `controllers/Api_sports.php:380-410` (the kill-switch refusal and its message), `libraries/Aegis/Sports/SportsIntelligence.php:140-235` (`dashboard()`), `tests/cases/50-sports-dashboard-ui.php` |
| Node routes used (all already present) | twelve `sports.view` reads (`/sports/status` included), the one `sports.manage` read the System panel names (`GET /sports/configuration`; `/sports/configuration/versions` exists and the screen does not call it), and the actions the screen offers: `POST /sports/tickets/:ticketId/decision` (`sports.approve`, behind the kill switch), `POST /sports/tickets/:ticketId/settle` (`sports.settle`, not behind it) and `GET /trading/mode` (`trading.view`) for the switch's state |
| New files | `client/src/sports.js`, `test/client_sports_console.test.js`, this record |
| Edited (client) | `client/src/views.jsx` (`SportsIntelligenceView`, the nav entry, the row-3 module card), `client/src/api.js` (14 wrappers), `client/src/App.jsx` (route), `client/src/styles.css` (`.sports-*`) |
| Edited (server) | `src/modules/sports/routes.js` (**the kill-switch guard**, and its docblock), `src/app.js` (passes `paper` to `sportsRoutes`), `src/modules/sports/service.js` (`SPORTS_NOT_PORTED` loses the console entry), `src/modules/platform/health.js` (the sports ledger label), `src/modules/sports/sync.js` (one stale sentence about the missing screens) |
| Unchanged | **no new route** (146 before and after), no migration, no repository method (`REPOSITORY_METHODS` is 185 either way), no permission, no dependency |

## The screen

- **Hero and the two honest banners.** `/sports/status` decides both: `isDemoData` renders legacy's
  `demoBanner` sentence verbatim, and a host with **no provider configured** says so — the same
  `DISABLED_NO_PROVIDER` fact the API reports, never a zero-valued health card. The kill-switch notice is a
  third banner, and reads the switch rather than assuming it (below).
- **Today's intelligence** (`todayIntelligence`) — the day's fixture counts rendered from
  `GET /sports/matches?status=SCHEDULED|LIVE` for the UTC day, the qualified/rejected prediction counts and
  the mean confidence from `GET /sports/predictions`, and the risk meters from the stored rows
  (`riskMeters`). Legacy's `averageConfidence` is an em dash when the day has none, never a 0; the
  prediction counts are computed client-side because `GET /sports/predictions` has **no instant filter**,
  and the panel says that the counts are a floor when the page is full (the endpoint caps at 500 rows).
  The upcoming table names each fixture's kick-off, competition and teams, and marks a fixture whose
  intelligence was **not assessed** as exactly that: the quality read is one `GET /sports/matches/:id/intelligence`
  per displayed fixture (25 at most), and the panel says how many of the shown rows were assessed and how
  many reads failed.
- **Today's ticket** — the run stored for the day (`GET /sports/daily-tickets`) with the ticket it produced
  (`GET /sports/tickets/:id`): the approval badge, the engine's mode, legacy's cards (odds window, total
  odds, confidence, risk, correlation, data quality, stake, the `stakeNote` that nothing is staked), and the
  legs with their calibrated probability and expected value. The decision form is legacy's: a reason, an
  **Approve**, and a **Reject** that arms before it fires (legacy's two-step confirm), plus **Settle** while
  the ticket is pending settlement. Every answer is the server's own sentence — including the kill-switch
  refusal.
- **Performance** — two panels, because legacy had two: the **window** one
  (`/sports/performance?from=…&to=…`, 30 days) with legacy's metrics and the `dataAvailable:false`
  empty state, and the **all-stored** one, labelled so the two are never read as one number. Every metric
  renders `null` as an em dash; a storage-empty host shows legacy's demo banner sentence rather than zeros.
- **Models and calibrations** — the model versions with their feature/calibration version, and the approved
  calibrations with method, samples, ECE and Brier. The panel states that a fit is stored `PENDING` until an
  administrator approves it, which is what the chain requires before any prediction is `READY`.
- **Tickets** (`tickets.php`'s table) — the stored tickets with their day, status, legs, odds, confidence,
  risk, stake and settlement state, in the server's own enums (`APPROVAL_STATUSES`, `SETTLEMENT_STATUSES`),
  plus the **daily runs** panel (run date, status, ticket, fixtures read, candidates evaluated, predictions
  recorded, rejections, errors) and the **sync runs** panel (`provider_id`, job, status, counts, window,
  errors).
- **System** — the mode, the ticket engine's state, `enabled` (the env switch, reported as itself) beside
  `configuration.module_enabled` (the stored setting, reported as itself — two different facts this API
  keeps apart), and the **provider health** table: registry and enabled flags, the derived status
  (`UNKNOWN` when nothing has been observed — never a fabricated health), reliability, observations and
  sync runs. `GET /sports/configuration` is **not attempted** without `sports.manage`, and the panel names
  the gate instead of filling with a refusal.
- **Boundary** — `/sports/status`'s own `notPorted` matrix, rendered as the module's statement of what it
  does not do, with the standing note that nothing is executed and the screen is a record, not a bet.

## The kill-switch guard (server)

`assertKillSwitchReleased(paper)` runs on `POST /sports/tickets/:ticketId/decision` **after** schema
validation and **before** the decision: a malformed body is still a `400`, and a refusal is a `409`
`SPORTS_KILL_SWITCH_ACTIVE` carrying legacy's own sentence —

> kill switch is ACTIVE — approving new tickets is blocked until it is released (settlement remains available)

The state is read through the **paper service** (`paper.tradingState()` → `publicTradingState` →
`normalizeTradingState`), the module that owns the switch and the only one that normalizes it: only a stored
`active: false` releases it, and absent state, a missing governance surface or malformed rows all **fail
closed** — a fresh host boots ACTIVE, which is what legacy's `Platform::state()` does.
`store.loadTradingState()` is deliberately not read directly, because two normalizations of one flag is how
a guard and a status page end up disagreeing about whether the switch is on.

The refusal applies to **rejects too**, because legacy's guard was on the route and not on the verb.
Settlement is **not** behind it, by legacy's own design and its own sentence: settling existing records is
how a book is closed while new approvals wait.

On the client, the switch is **read, not assumed**: the notice is shown only when the session holds
`trading.view` (the gate on `GET /trading/mode`), and it carries both sentences — the console's flash and
the API's own answer to a decision taken now. A session without `trading.view` sees no notice and still
cannot approve under an ACTIVE switch, because the refusal is the server's.

## Honesty corrections made on the way

- `SPORTS_NOT_PORTED` is down to **one entry, "stake sizing"**. It had still listed "the console screens"
  after the console landed, which is exactly the stale-matrix failure this ledger has been correcting for
  phases: a matrix named *not ported* may not name a surface that exists. External execution and an
  unverified vendor are **not** added as rows — neither is a legacy area with a `state`, and the ledger's
  label states both in words.
- `src/modules/platform/health.js`'s sports label loses `Not ported: stake sizing and the console screens
  (F-29)` and states the console, the F-29 closure, the guard and the single remaining entry instead. The
  module **stays `partial`**: no stake is sized, nothing is executed, no stored result is trusted before a
  person attests to it, and no provider has been verified against a real vendor.
- `src/modules/sports/sync.js`'s audit-vocabulary docblock no longer says the screens are missing; the
  console reads those action names through the audit browser like every other event type.
- The suites that pinned the old claims moved with it, each with the reason in the assertion:
  `test/sports.test.js` (the count 2 → 1, plus a guard that no ported area may re-enter the matrix),
  `test/sports_http.test.js` (the `/status` matrix and the ledger label), `test/platform_findings.test.js`
  (the F-02 label regex, F-03's route inventory, and the partial-count rationale naming sports),
  and `test/client_dashboard.test.js` (the F-29 absence list loses `/app/sports` **because it is now
  declared** — keeping it there would pin a shipped screen as missing).

## Tests

`test/client_sports_console.test.js` — **20 tests**, hermetic (file adapter, `createFileStoreApp`, no
network); three of them build the real app with the sandbox double-gate
(`WINDELS_SPORTS_MODE=SANDBOX` + `WINDELS_SPORTS_SANDBOX=1`) and drive it over HTTP:

- the legacy pages are read with `readFileSync` and the screen's own constants are asserted against them
  (`application/views/sports/index.php`, `tickets.php`), so a paraphrase of legacy's copy fails the suite;
- the route inventory: every one of the console's reads exists in `GET /api/v1/system/routes` and carries
  the permission the server enforces, and the one `sports.manage` read is the only one withheld from a
  `sports.view` viewer;
- the declared writes: `decision` needs `sports.approve` and is the **only** write behind the kill switch
  (`assertKillSwitchReleased` has exactly one call site), `settle` needs `sports.settle` and has none;
- the shapers against real payloads fetched in the same test: today's counts and the mean confidence,
  the risk distribution with legacy's bucket rule (`row.risk ?? "REJECTED"`, unknown names keeping their own
  bucket so the bars still total 100 %), the upcoming rows and their cap, the performance card sets, the
  ticket view and its totals, and the row shapers for tickets, daily runs, sync runs and providers;
- formatting never invents a figure (`null`/`""`/non-numeric render `—`; a real `0` renders `0`);
- the screen is declared exact-path, `requiresAuth`, `sports.view`, in `App.jsx` **and** the navigation;
- live behaviour: a `sports.view` analyst reads every read the screen makes and is refused nothing it asks
  for; the decision route answers **409 `SPORTS_KILL_SWITCH_ACTIVE`** on a fresh (fail-closed) host and
  changes nothing; after an operator releases the switch through `/api/v1/trading/kill-switch` the same
  request succeeds and a second one is `409 SPORTS_TICKET_ALREADY_DECIDED`; and the empty host's
  `notPorted` no longer names a console screen.

`test/sports_tickets_http.test.js` gained the guard test and the `releaseKillSwitch()` helper (**9 tests**,
`node --test test/sports_tickets_http.test.js` → 9/9), which is what makes the 1045 → 1066 movement 21
tests rather than 20.

## Gates

- `npm run check:workforce` → **1066 / 1066**, 5 suites (1045 before: +20 console tests, +1 HTTP guard test).
- The eight client suites together → **89 / 89**; `test/client_sports_console.test.js` **20 / 20**.
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:client` → `index-D7L0hs05.js` 472.30 kB / 129.00 kB gzip, `index-B_XlxOxv.css`
  41.01 kB / 8.83 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe (file-store demo, admin `root`, `RATE_LIMIT_LOGIN_MAX=50`): **36 / 36** — `/app/sports` serves
  the shell, the served bundle carries the screen's strings and the refusal message, the module reports
  `SANDBOX` + `isDemoData` + `notPorted: ["stake sizing"]`, the provider-less message is the API's, all
  thirteen reads answer 200 for the administrator, `/trading/mode` reports the switch ACTIVE, today's board
  finds the four seeded fixtures and their four predictions, the stored ticket carries its three legs and
  `6.859` total odds, the run is stored against the day, and an approval attempt is refused **409
  `SPORTS_KILL_SWITCH_ACTIVE`** with nothing changed.
- **Probe note:** the probe wrote nothing, but the demo store was seeded for the preview — a throwaway
  `tools/seed-demo-sports.tmp.mjs` inserted four **"… Test"** fixtures with odds and a `PENDING`
  calibration into the demo store, the calibration was approved and the daily ticket run through the API,
  so the screen shows the engine's own output rather than a wall of empty states. The seed tool is deleted,
  the demo host's kill switch was **not** touched, and none of this is a product change.
- **Not run:** a real browser (no rendering, no click-through), real MySQL/MariaDB (F-15),
  any live provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## Verification record

CI run **`38976858301`** on `arena/046b29ac-ai` (`1d959a0`) is **success** on both jobs
(`javascript`, `mt5-bridge-contract`). The sandbox that ran the gates above was reset twice
in this phase — `/tmp`, the demo store and `node_modules` do not survive it — so the tree
was realigned to `ee07769` with its P36 changes intact, `npm ci` was re-run at the root and
in `client/` and `native/`, and every gate was re-measured on the committed tree before the
push: `check:workforce` **1066 / 1066**, the eight client suites **89 / 89**, the client build
with the same hashes (`index-D7L0hs05.js`, `index-B_XlxOxv.css`), `typecheck` clean,
`test:contracts` **12 / 12**, `verify:install --require-bundle` **30 / 30**, the football suite
**29 / 29** and the runtime suite **367 passed**. The demo host was then rebuilt for the
preview (seed → `seed-platform.mjs` for the 9 roles / 14 permissions / 29 grants and the
`root` administrator → calibration approved → daily ticket run through the API → the kill
switch left ACTIVE) and the probe re-run with a re-created script: **34 / 34**, the same
facts as the 36-check run above plus the refusal's code, kept honest by leaving the switch on.

## After this phase

Row 3 is closed: the workspace dashboard (Phase 33), the account avatar (Phase 34), the administrator
control centre (Phase 35) and the sports dashboard (this phase). **F-29's residual list is now paper, risk,
execution, brokers, journal** — sports left it. **Module counts are unchanged — 10 ported / 5 partial /
2 not-ported:** this phase ported a screen and one legacy guard over routes that already existed. Sports
stays `partial` for stake sizing and an unverified vendor, and the label says so.

Next, unchanged: F-29's remaining consoles, row 5's retention/outbound-delivery decisions, row 18's
chat/journal/tools inventory, and every host-level gate (real MySQL, crontab, cPanel/Passenger, live
providers, SMTP, official feeds).
