# Phase 28 — The sports and lottery consoles (row 3, F-29 narrowed to three consoles)

> **Status: landed on `arena/ef756273-ai`.** This record covers the last two console screens and
> the honesty sweep that moved with them. It **closes F-29** — every console legacy rendered for a
> ported module now has a workspace screen. It adds no HTTP route, no migration and no table: the
> all 25 endpoints it calls were already served and tested. The previous record is
> [`PHASE27_CONSOLE_SCREENS.md`](PHASE27_CONSOLE_SCREENS.md).

## 1. What this phase is

Phase 27 narrowed F-29 to the sports and lottery consoles. This phase ports them:

| Screen | Route | Permission | Legacy source |
|---|---|---|---|
| Sports console | `/app/sports` | `sports.view` (+ `sports.approve` / `sports.settle` for its two controls) | `views/sports/index.php`, `views/sports/tickets.php` (`Sports::index`, `Sports::tickets`) |
| Lottery console | `/app/lottery` | `lottery.view` (+ `lottery.manage` for its two controls) | `views/lottery/index.php` (`Lottery::index`) |

Files: `client/src/consoles.jsx` (both screens plus the shared renderers), `client/src/contracts.js`
(five mirrored vocabularies), `client/src/api.js` (25 client calls), `client/src/App.jsx` (two
exact-path routes), `client/src/views.jsx` (two nav entries; the sports and lottery module cards
stopped saying "API only"), `client/src/styles.css` (one class plus three scoped rules), and
`test/console_screens.test.js` (extended — the ledger below).

Legacy merged the two sports views into one screen. The merge is honest because the API is what the
screen is bound to: fixtures, predictions, tickets and performance are one aggregate read each, and
the ticket list plus its decision control are panel sections rather than a separate page. Legacy's
`Sports::tickets` existed because PHP had to fetch tickets separately; `/app/sports` fetches
`sports/tickets` in the same pass.

Each screen's authority is the permission its endpoints enforce. The shell's checks are presentation
only — a `403` is what actually refuses, and both controls state that before they are pressed.

## 2. Only the actions legacy's consoles performed have controls

The rule from Phase 27 held: a control exists only where a legacy console button existed, and
nothing the API can do is offered just because it is reachable.

| Control | Endpoint | Permission | Legacy counterpart |
|---|---|---|---|
| Approve / reject a ticket | `POST /api/v1/sports/tickets/:id/decision` | `sports.approve` | `Sports::decide` |
| Run the settlement sweep | `POST /api/v1/sports/tickets/:id/settle` | `sports.settle` | `Sports::settle` |
| Probe the lottery provider | `POST /api/v1/lottery/providers/check` | `lottery.manage` | `Lottery::index`'s health probe |
| Sync draws | `POST /api/v1/lottery/sync` | `lottery.manage` | `Lottery::index`'s sync button |
| Check a saved ticket | `POST /api/v1/lottery/tickets/:id/check` | `lottery.view` | `Lottery::index`'s ticket check |

Everything else the sports and lottery modules can do — provider configuration, prediction
evaluation, calibration fit/approve/reject, the daily ticket run, backtest runs, drift runs,
stuck-run recovery, system builds — **has no control and no client call**. The screens say so
outright, listing each one with the permission it needs, so the absence is a stated fact rather than
a missing feature an operator has to infer from an empty toolbar. `api.js` contains no wrapper for
any of them, and `test/console_screens.test.js` fails if a screen calls a key the client does not
declare.

## 3. What the screens render, and what they refuse to invent

- **The honesty matrices, verbatim.** `/sports/status` → `notPorted` and `/lottery/status` →
  `notPorted` are rendered as tables, whatever they contain. Phase 28 emptied the lottery matrix and
  reduced the sports one to stake sizing; the screens print the array, so they will print a new
  entry the day one is added, and print nothing when there is nothing.
- **Synthetic data is labelled where it was produced.** `/sports/status` → `isDemoData` and
  `/sports/performance` → `demoBanner` are rendered as the server wrote them. A sandbox host says
  `DEMO / SANDBOX DATA` next to the numbers those numbers came from.
- **The lottery disclaimer travels with the statistics.** Every statistics payload carries the
  independence disclaimer; the screen renders it above the tables rather than paraphrasing it, and
  the strategy sections keep the same wording everywhere.
- **Performance sections stay separated.** The lottery performance overview renders
  `actualTicketResults`, `historicalBacktestResults` and `demoSandboxData` as three named sections
  under the server's own `label` and `separationNote`, never summed into one figure.
- **No recomputed data-quality band.** Legacy's `Sports::index` derived a per-match quality band in
  PHP. The Node API does not expose that aggregate, and the console does not reproduce it in the
  browser — a second implementation of a scoring rule is exactly how two screens start disagreeing.
  The match table shows the stored columns and links to the quality read instead.

An empty state is a real state here: a default host has no provider, so matches, predictions,
tickets, daily runs, draws, decisions, jobs and statistics are all empty, and each panel says which
empty state it is in rather than rendering a zero as a measurement.

## 4. The ledger test, extended

`test/console_screens.test.js` grew from three screens to five without growing its test count: the
existing tests now iterate a `SCREENS` list in which each entry names its file, its route, its
component, its **gate** endpoint and its elevated controls.

- The **gate** is the endpoint whose permission is the screen's own. The lottery console needed one
  explicitly: `/lottery/status` is readable by any signed-in member — exactly as legacy's
  `Lottery::index` guarded it — so it is deliberately *not* the gate; `lottery/health` is, because
  the draws, statistics, tickets and performance reads behind it all need `lottery.view`.
- **Elevated controls** are asserted endpoint by endpoint: the permission the screen names must be
  the permission the API enforces, it must differ from the screen's gate, it must exist in the
  seeded catalogue, and the screen must reference it in the source that gates the control. A control
  that renders for the wrong permission fails here instead of at the API.
- **Binding** now asserts the consoles render the API's own honesty surfaces — `notPorted`,
  `disclaimer`, `demoBanner`, and the performance sections by the names the API uses — rather than
  restating them in prose.

The vocabulary test compares five new client lists against the modules that validate them:
`SPORTS_MATCH_STATUSES`, `SPORTS_TICKET_APPROVALS`, `SPORTS_JOB_TYPES`,
`SPORTS_CALIBRATION_STATUSES` and `LOTTERY_STATISTICS_KINDS`.

## 5. F-29 is narrowed, not closed — and the difference matters

F-29 reads "no ported module has a workspace console". Five ported modules now have one, so the
universal form is false — but the finding's own text names consoles that still do not exist:

- **Market data** (Phase 4, 3 routes) and **analysis** (Phase 5, 5 routes) — no screen.
- **Strategy Lab** (Phase 6, 11 routes) — no screen, and `views/strategy/index.php` (8,466 bytes
  of operator UI with backtest/optimize/advance forms) plus its four document routes are still
  unported.
- The other legacy consoles with no Node screen: `brokers/index.php`, `execution/index.php`,
  `journal/index.php`, `paper/index.php` + `account.php` and `risk/index.php`.

So this phase removes the two halves F-29 had been tracking and states what remains. A label that
said "closed" would be the same class of error as a label that understates a finished module, which
is what this whole sweep exists to prevent. `test/platform_findings.test.js` asserts the labels
**do not** claim F-29 is closed, alongside asserting the removed clauses are gone.

## 6. Labels moved with the screens — removed, never re-labelled

- `SPORTS_NOT_PORTED`: the `console screens` entry was **deleted**; the matrix is stake sizing
  alone. `LOTTERY_NOT_PORTED`: its last entry was deleted and the matrix is **empty**, which is the
  honest report and is asserted as such.
- `health.js`: the `sports` label's "not ported: stake sizing and the two sports console screens —
  F-29, narrowed by Phase 27" became "not ported: stake sizing, and it is the module's whole
  remainder — the sports console screens landed in Phase 28 at `/app/sports`, removing F-29's
  sports half";
  the `lottery` label lost "the two lottery console screens are not ported" the same way.
- `test/platform_findings.test.js`, `test/sports_http.test.js`, `test/sports.test.js` and
  `test/lottery_http.test.js` were updated to assert the new text, the new matrix lengths, **and**
  that the old phrases are gone — a label that understates what exists is the failure mode this
  phase is most exposed to.
- `client/src/views.jsx`: the sports and lottery module cards stopped rendering `API ONLY` and now
  link to their screens. Row 3's other half — settings screens and the per-domain dashboards — is
  untouched, and the cards for those six modules still read `API ONLY · NO CONSOLE SCREEN`.

## 7. What this phase does not claim

- **No settings screens and no domain dashboards.** They are row 3's remainder, the six API-only
  modules still have no dashboard, and F-29 still names the market-data, analysis and Strategy Lab
  consoles.
- **No live upload or execution controls.** Nothing here can size a stake, execute a ticket, or
  submit a lottery ticket — the lottery screens record lines, they do not purchase them, and no
  purchase endpoint exists.
- **Not verified in a real browser.** The screens were exercised through the Vite dev server against
  a file-store API (login, every sports and lottery read, the probe returning its honest
  `UNCONFIGURED` state, and the guarded writes answering domain errors) and the production bundle
  builds — but there is no DOM runner, no Lighthouse run and no cross-browser check. The client
  still has no test suite of its own.
- **No MySQL and no deployment.** F-15 is untouched.
- **No PHP↔Node numeric parity** (F-26): the screens show the port's numbers.
- **Nothing staked, nothing purchased, nothing trusted.** Every control is a person's decision over
  stored records, and each is audited by the endpoint behind it.

## 8. Gates on this branch

- `npm test` → **981 / 981** across **68** files (unchanged counts: the ledger test grew, no file
  was added).
- `npm run verify:install` → **30 / 30** installation checks pass. (Phase 27 recorded 29 / 29 because
  `public/app/` did not exist then, so the bundle-existence check was skipped; the client is built on
  this branch and that check runs — the count moves with the artefact, not with the phase.)
- `npm run check` → exit 0 (verify:install + the 981 tests).
- The PHP tree is untouched — no file under `application/`, `system/` or `tests/` is in this
  branch's diff — so the legacy oracle's 367 / 367 stands. It was **not re-run** in this session:
  `runtime/run-tests.mjs` needs `@php-wasm/node`, which is not installed in the sandbox.
- `npm --prefix client run build` → clean build (`public/app/` is a git-ignored artefact).
- Live rehearsal: file-store API plus the Vite dev server; login, then every endpoint the two
  consoles call — 10 sports reads and 10 lottery reads plus `lottery/statistics/<kind>` for all
  seven kinds, all `200`; the five guarded writes answered `NOT_FOUND` / `LOTTERY_TICKET_NOT_FOUND`
  for a missing record and the probe answered `200` with `state: "UNCONFIGURED"`, which is the
  default host's real state and what the console renders.

## 9. User decisions still open

- **Settings screens** and the six per-domain dashboards (which is where F-29 now lives) — which
  come first.
- **Stake sizing** is now the sports module's entire not-ported list, and it needs an owner decision,
  not a port: the platform sizes nothing.
- **One retention policy** for audit, notifications, `wf_analysis_runs` (R-27) and `wf_backtests`
  (R-28).
- **The outbound mail transport**, still absent, still blocking every email-backed flow.
- Whether a client DOM-level test runner is worth adding; the ledger test still covers the
  screen↔API contract without one.
