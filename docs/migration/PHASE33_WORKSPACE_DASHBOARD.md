# Phase 33 — the workspace dashboard (`/app`)

**Date:** 2026-10-16 · **Scope:** row 3's workspace dashboard — `Workspace::index` →
`views/workspace/index.php`, legacy's `/dashboard`, the page sign-in lands on — as the SPA's
signed-in home. No new HTTP route, migration, contract method or permission: the route count stays
**146** before and after, and the four reads it performs all already existed.

## Why this module next, and a correction that had to come first

Row 3's list of absences read *"the sports dashboard and the settings screens"* at the start of
this phase. It should have read *"the sports dashboard, the workspace dashboard and the settings
screens"*: Phase 32's record attributes the AI Workforce console to `views/workspace/index.php`,
and that file is **not** the console — it is the dashboard. `/analysis` is `Welcome::index`
(`views/welcome/index.php`, with `partials/chart.php`); `/dashboard` is `Workspace::index`
(`views/workspace/index.php`). The console ported the first; the second was never ported, and the
misattribution had quietly removed it from the list. Correcting that first is why this phase
exists, and the correction is recorded in the Phase 32 record rather than erased from it.

## Delivered

**The dashboard at `/app/`** (`WorkspaceDashboard`), rendering the legacy page in its own order:
the hero (`WINDELS AI WORKFORCE`, *"Welcome back, {first}"* — the first word of the display name,
`Member` when unset), the status pills, legacy's three quick actions, the four KPI cards, then the
recent-activity table and the notification feed.

- **The pills** are legacy's own three, with the trading state **replacing** the mode while the
  kill switch is engaged (that is what `views/workspace/index.php` did, and it is asserted). The
  paper count is `GET /api/v1/paper/accounts`; the language pill is the one number no Node module
  can answer, so it says so (row 16) instead of printing a zero.
- **The KPI cards** are legacy's four with legacy's captions, and each carries the caveat its
  number needs: the run count is *"the six most recent stored runs, as the legacy page counted
  them — not a lifetime total"* (legacy printed `count($history)` where `history(6)` returned at
  most six rows, so its "Recent analyses stored" was never a total either); the paper count is
  **the viewer's own accounts**, because `GET /api/v1/paper/accounts` is owner-scoped and gated on
  `trading.view` while legacy's `listAccounts()` read every row in the table for any member; the
  unread count is the server's own `unread`, which is not narrowed by the feed's page size.
- **The activity panel** is legacy's table — Symbol, Timeframe, Bias, Completed — over
  `GET /api/v1/analysis/history?limit=6`, with legacy's empty state (*"No analysis runs stored
  yet."* + *"Run your first analysis"*) and the bias in the shell's badge language. The row also
  carries the **SIM** marker for a synthetic run: legacy's dashboard could not mark one (its
  history rows carried no provenance), and this port's rows do, so it does.
- **The notification panel** fetches eight (`inbox($userId, false, 8)`) and prints six
  (`array_slice($notes, 0, 6)`), keeping legacy's `title ?? type ?? 'Notice'` fallback as PHP's
  null-coalescing — an empty title stays empty — and its sixteen-character timestamp.
- **Two of the three quick actions have no screen here, and say so.**
  `Run AI analysis` opens `/app/analysis`; `Paper trading` and `Learn a language` render as
  unavailable with their reasons (the paper module is an API with no console — F-29; language
  learning is not ported — row 16). A link that 404s and a quiet omission are both worse than the
  sentence. The activity panel's foot says the same about legacy's `View analytics →`: it pointed
  at `/journal`, which this edition has not ported (row 18), and the foot names the console where
  the runs actually are.
- **The stale claim on the page above it is gone.** The readiness strip's `TRADING MODE — Not
  enabled in this shell` cell was written when the paper module was an API with no controls; the
  mode is real now (Phase 32's console reads and writes it). The cell became
  `ORDER ROUTING — Simulation only · no live route`, which is what this edition actually
  guarantees, and a test asserts the old sentence is not in the source.

## The guard: session-only, like `App_Controller`

The dashboard is the one screen in the shell with no permission of its own — legacy guarded it
with a session and nothing else — and it stays that way: `/app` declares `requiresAuth` and no
permission. But two of its four reads are gated (`GET /trading/mode` and `GET /paper/accounts`,
both `trading.view`), so the screen **does not attempt them** without it. The pills and cards then
name the gate — *"Trading state needs trading.view"*, *"Paper accounts need trading.view"* — which
is the difference between a viewer being told what they cannot see and being shown an error box
for a request they were never entitled to make. The other two reads are session-only
(`/analysis/history`) and `system.authenticated` (`/notifications`, the baseline
`userHasPermission` answers for every signed-in user regardless of role).

## Defects and corrections made on the way

1. **`kpiCards` turned "not read" into zero.** `Number.isFinite(Number(null))` is `true`, so a
   null unread count became a confident `0` in the alerts card — the exact failure this page is
   supposed to avoid, found by the new suite's own no-zero assertion before it ever ran live. Null
   and empty are "unread" again; only a real count renders as one.
2. **The paper note did not carry its finding.** It explained the missing console but did not name
   F-29, the finding that tracks it, so the platform's own records and the screen disagreed about
   what "not ported" referred to. The note now names it.
3. **Phase 32's record misattributed the console to `views/workspace/index.php`** (see above). The
   Phase 32 file keeps the text with the correction beside it; `STATUS.md` and this phase's row-3
   updates carry the corrected attribution.
4. **Three class names the shell uses are defined nowhere.** `mono`, `dim` and `num` appear in the
   SPA's JSX across every ported console and in no stylesheet — the same class of gap Phase 32 found
   for `.secondary-button`, but cosmetic here (they only promise secondary text and right-aligned
   numeric cells). `.muted`, used in the same cells, is defined. Defined nowhere, they are decoration; defined now, they would restyle seventeen phases
   of reviewed screens. The dashboard reuses them for consistency and the gap is recorded rather
   than swept: it belongs to a stylesheet pass with its own before/after evidence, not to this
   slice.
5. **`biasTone` is imported, not copied.** The dashboard's activity table needs the same bias
   colours as the analysis console's history, so it imports the one function from `workforce.js`
   instead of adding a third copy for a suite to cross-check.

## Contract tests — `test/client_dashboard.test.js` (8 tests)

The fifth client suite and the first for a screen that is not a module console: its subject is the
shell's own honesty rules, because this page's failure mode is not a wrong number but a confident
zero and a link that goes nowhere. Hermetic like the others (`MARKET_DATA_REAL_PROVIDERS=0`), so
the run it renders is synthetic and the assertions say so.

- **Legacy's vocabulary** — the three windows (6/6/8), the three quick actions in order with only
  the first carrying a destination, the four card labels and captions, the page's own sentences
  (lede, section titles, both empty states), the foot texts, and `firstWord`/`countLabel` including
  legacy's `1 paper account` singular.
- **The honesty rules** — a member with nothing granted gets the two gates named and **no `0`
  anywhere**; a released kill switch shows the mode and an engaged one replaces it; a failed read
  is "unread", never a default mode; the language card is an em dash with row 16 in its note; the
  run card's note says the count is a window; the accounts note says owner-scoped and names F-29.
- **Destinations** — every `to` in the actions, cards and feet is a route `App.jsx` declares, and
  every entry without one carries a reason; the premises of the two notes are checked against the
  router (`/app/paper` and `/app/journal` are not declared).
- **Row shapes** — the activity table's seven fields, legacy's `0,16` timestamp with the API's `T`,
  the bias tones (against `workforce.js`'s `biasTone`), the SIM flag, em-dash for a missing bias,
  and non-array payloads yielding nothing; the feed's six-of-eight window, the three severity
  tones, `title ?? type` with a **null** title, an empty title staying empty, and an empty payload.
- **Reads and routes** — each of the four reads is the registered route with the permission the
  server enforces, the query windows are read back out of the module, and auth is required on all
  four.
- **Behaviour against the API** — as the administrator: a stored run appears in the window with
  the right shape and a SIM marker; a broadcast notification comes back with its severity and read
  state; the two gated reads answer and the pills/cards equal what the server returned. Then as a
  member holding only the signed-in baseline: the two session reads are 200, the two governance
  reads are **403 `PERMISSION_DENIED`**, and the screen's pills and cards name the gate and show no
  zero.
- **The screen** — `/app` is declared exact-path and `requiresAuth` with no permission key,
  `WorkspaceOverview` renders `WorkspaceDashboard`, the views module exports it and imports
  `./dashboard.js`, the stale trading-mode sentence is gone and the new one is present, and
  `GET /app` answers the built shell whose bundle actually contains the dashboard's strings.
- **The absences are real** — the ledger has `languageLearning` `not-ported` and `paperTrading`
  `ported`, a `/api/v1/paper/` surface exists while no language surface does, and the six screens
  the notes and F-29 refer to (`/app/paper`, `/app/risk`, `/app/execution`, `/app/journal`,
  `/app/brokers`, `/app/sports`) are not declared. Module counts are asserted unchanged.

## Verification

- `npm run check:workforce` — **1024 / 1024** across 5 suites, 0 failures (1016 before: +8).
- `npm run build:client` — production bundle built: `index-3X6YJttD.js` (419.51 kB / 115.71 kB
  gzip) and `index-Cyo6EhCz.css` (38.08 kB / 8.29 kB gzip).
- `npm run verify:install -- --require-bundle` — **30/30** installation checks.
- **Behavioural end-to-end** against the running server, driven by the module's own helpers: six
  activity rows (all SIM) rendering as `SOLUSDT 1h BEARISH (SIM) @ 2026-10-16 12:57` and siblings;
  the inbox at unread 4 with the kill-switch and two trading-mode alerts; the pills
  `Kill switch active · 0 paper accounts · Language learning not ported` (a counted zero, not a
  fabricated one); the cards equal to what the API returned; `/app` and both bundle assets 200 with
  the new bundle carrying the dashboard's strings; and all four reads matching the route inventory
  (`/analysis/history` session, `/notifications` `system.authenticated`, `/trading/mode` and
  `/paper/accounts` `trading.view`).
- **Not run:** a real browser (no rendering, no click-through, no Lighthouse), real MySQL/MariaDB,
  any live market-data provider, SMTP, and no PHP↔Node numeric diff (F-26 remains open).

## Honesty corrections made on the way

- **Phase 32's attribution** is corrected in that record and in `STATUS.md`: it ported
  `views/welcome/index.php`, not `views/workspace/index.php`.
- **Row 3** now reads: the workspace dashboard **landed in Phase 33**; the sports dashboard is
  still absent (stake sizing, no verified vendor) and so are the settings screens — which are, on
  inspection of the legacy files, the **account screen's avatar control** (`/account/avatar`;
  `POST`/`DELETE /api/v1/account/avatar` exist and no control calls them) and the **admin control
  centre** (`views/admin/index.php`: the SMTP panel, the access-policy list and the feature
  readiness table; its user table and the create/toggle forms are already at `/app/admin/users`,
  and the SMTP panel cannot be ported while there is no mail transport).
- **F-29's residual scope is corrected.** It read *"still open for the Broker Center and the sports
  screens only"*; the legacy view directories say more than that. Verified screen-by-screen against
  `application/views/*`: the consoles still absent are **paper** (`views/paper/{index,account}.php`),
  **risk** (`views/risk/index.php`), **execution**, **brokers**, **journal**, **sports** and the
  **admin control centre**, plus the screens of the modules that are not ported at all (leads,
  language learning, row 16/17 workstreams). `RISK_REGISTER.md` now records that list; the
  dashboard's own notes name the two it touches.
- The app `README.md` gains the dashboard bullet, and the module counts stay **10 ported / 5
  partial / 2 not-ported** — this phase closed a screen, not a ledger state (`analysis`, `paper`,
  `risk` and the shell keep the states they had).

## Remaining after this phase

Row 3 still owes the **sports dashboard** and the **settings screens** (the avatar control and the
admin control centre; the latter is partly blocked on row 5's mail decision), and F-29 still counts
the **paper, risk, execution, broker and journal** consoles; row 5 owes **one retention decision**
over audit, notifications, `wf_analysis_runs` (R-27) and `wf_backtests` (R-28) plus the **outbound
delivery channel**; row 18 still needs its inventory of the remaining chat/journal/tools surfaces;
and every host-level gate from the master plan remains unrun — real MySQL, a crontab,
cPanel/Passenger, live providers, SMTP and the official feeds.
