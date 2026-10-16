# Phase 32 — AI Workforce console (`/app/analysis`)

**Date:** 2026-10-16 · **Scope:** row 3's analysis dashboard — the `views/welcome/index.php` AI-Workforce page
(`/analysis` → `Welcome::index`) with the `views/welcome/partials/chart.php` SVG chart behind it — as one
exact-path screen at `/app/analysis`, driving the twelve analysis/market-data routes that already existed
plus the paper module's two governance writes. **No new HTTP route, migration, contract method or permission:**
the route count stays **146** before and after.

## Why this module next, and what "row 3" still owes

`UNFINISHED_MODULES.md` row 3 is the shared shell, and its last recorded absences are three screens. Two of them
belong to modules that are still `partial` for reasons of their own — the **sports dashboard** waits on stake
sizing and a verified vendor, the **settings screens** on the row-5 decisions — so closing either would not move
its ledger row. The **analysis dashboard** does not: `analysis` has been `ported` since Phase 5, so this phase is
judged by whether the screen is a faithful port of the legacy page rather than by a count that changes.

## Delivered

**`/app/analysis` — the AI Workforce console** (`AnalysisWorkforceView`), the port of the legacy AI-Workforce
page and of the market panel that sits above it.

- **A run on legacy's own vocabulary** — the three crypto symbols and five forex/metals symbols of
  `views/welcome/index.php` grouped as *Crypto* and *Forex & Metals*, all six server timeframes offered, `1h`
  selected, and the **legacy four** (`15m`, `1h`, `4h`, `1d`) on the watchlist form because that is the list the
  legacy scan offered. `marketClass` is derived by the legacy rule (`XAUUSD` → commodity, `*USDT` → crypto, else
  forex) so a symbol cannot be classified one way on screen and another on the wire, and the rule is asserted
  against `strategy.js`'s copy of it on the shared symbols.
- **The result panels** — the headline (`BTCUSDT · 1h · NEUTRAL (HOLD)`), the SIMULATION/SYNTHETIC banner built
  from the run's own provenance (a synthetic run is labelled *"The Risk Engine vetoes trades on synthetic data"*),
  the three meters (confidence, confluence, agent agreement), the consensus line with its voting and abstaining
  agents named, the nine signal rows, the five-agent panel with each agent's bias, confidence and verdict, and
  the four-round debate with each round's member votes.
- **The risk engine panel** — the proposal (`tradeSetup`) and the risk decision are rendered **only when the run
  produced them**. On this edition's default headless/synthetic posture both are `null` and the panel says so
  instead of filling in a placeholder, with the run's own `riskContext` facts beside it (mode, equity, peak, the
  kill switch and its source) — so an `ANALYSIS_ONLY` veto reads as a posture, not as a failure.
- **The watchlist scan** — `POST /analysis/consensus` over the six legacy symbols (the client omits blank
  `symbols` so the server applies its own `DEFAULT_WATCHLIST`), rendered as the bias/confidence/short-table rows
  legacy's risk-approved/vetoed table showed, capped at the server's own `MAX_CONSENSUS_SYMBOLS` (10).
- **The stored history** — `GET /analysis/history` with the run id, symbol, timeframe, bias badge, confidence,
  time and the SYNTHETIC marker.
- **The chart** — `views/welcome/partials/chart.php` ported as geometry in plain ESM and drawn as SVG: the same
  1000×380 canvas, 6/74/10 padding, 56 px volume strip, the last 140 of up to 200 bars, four gridlines, EMA20 and
  EMA50 with legacy's warm-up rule (first `period − 1` absent, SMA seed, then `v·k + prev·(1 − k)`), support and
  resistance from the technical agent's own levels within ±10 % of the window, the entry zone and the
  take-profit ladder at legacy's opacities, and the *"N of M bars · source: X"* legend. A candle fetch that
  fails drops **only** the chart panel; the run stays on screen.
- **The governance controls** — the two writes the paper module already served: `POST /trading/mode` and
  `POST /trading/kill-switch`, both `trading.control`. The mode select offers the two modes this edition has
  (`ANALYSIS_ONLY`, `PAPER_TRADING`) and names the three legacy-only ones (`SEMI_AUTONOMOUS`, `HUMAN_APPROVAL`,
  `FULLY_AUTOMATED`) as unavailable **with the capability reason each is missing**, rather than hiding them or
  letting a click discover the refusal. The screen states in its own words that it **never places an order**.

## The guard: session-only, like the controller it ports

Legacy's analysis and market-data routes were guarded by a session and no permission, and the port kept that —
every `/api/v1/analysis*` and `/api/v1/market-data/*` route is permission-`null`. The screen therefore declares
no permission on its exact-path route and none on its navigation entry. The two governance controls it renders
**are** permissioned (`trading.view` to read `GET /trading/mode`, `trading.control` to write) — which is why they
render **disabled with the reason** for a viewer who lacks `trading.control` rather than 403-ing on click: the
server re-checks every write, and the console's job is to say so before the round trip. A test asserts this the
way it can be asserted — by reading the route inventory and requiring **exactly three** permissioned routes on
the whole surface the console drives, and by requiring the declaration not to carry a `permission` key.

## Defects and corrections made on the way

1. **`provenanceFacts(null)` rendered a LIVE banner.** The helper defaulted a null payload to `{}`, which made
   `p.synthetic` and `p.stale` both `false` and produced the tone `ok` with the facts `["source demo", "LIVE"]` —
   a definitive provenance claim about a payload that carried none. It now returns `null` for a null or
   non-object payload and the banner is not drawn. Found by a contract test, not by reading.
2. **The console's copy claimed a 409 the API cannot return.** The mode refusal the console describes is the
   request schema's **400 `INVALID_REQUEST`** ("mode must be one of: ANALYSIS_ONLY, PAPER_TRADING"); the
   service's own `TRADING_MODE_UNSUPPORTED` 409 sits behind that schema and is **unreachable over HTTP** — the
   same shape as the lottery's unreachable statistics-kind refusal. Header and docblock corrected, and the probe
   pins the 400 for all three legacy-only modes.
3. **`killSwitch` keeps a release's reason; the port does not — recorded, not papered over.** Legacy
   `Platform.php:424` stored `$reason ?? ($active ? 'engaged' : 'released')` on **both** branches and stamped a
   fresh `activatedAt` on every call, so a released switch carried an activation timestamp and a reason it was no
   longer engaged for. `paper/service.js` stores `activatedAt: active ? updatedAt : null` and
   `reason: active ? normalizedReason || "Activated by operator" : null`, which is the shape an operator can act
   on; the release's own reason is not lost (it is the audit row's `governance.kill-switch.released` detail).
   The divergence is now written at the assignment with that reasoning, and the suite asserts the port's shape —
   including that a **blank** reason on an activation gets the server's default while a blank reason on a release
   stores `null`.
4. **This record first misattributed the page it ports, and that hid a screen.** It said the console
   was the port of `views/workspace/index.php`; that file is `Workspace::index` — legacy's `/dashboard`,
   the workspace dashboard — while `/analysis` is `Welcome::index` → `views/welcome/index.php`. The
   console consequently claimed a page it does not port, and row 3's absence list quietly lost the
   workspace dashboard: it read *"the sports dashboard and the settings screens"* from this phase until
   Phase 33 put the dashboard back on the list and ported it. The sentences above are corrected; the
   error is recorded here because a record that only ever reads as if it had been right is not evidence.
5. **`npm run check` could not pass on a clean checkout — and CI had been failing since Phase 29.** The
   console suites added between Phases 29 and 31 (and this one) assert that a bookmarked `/app/...` path answers
   the SPA shell with a 200; `public/app/` is generated and **git-ignored**, and without it every deep link is a
   404 **by design**. Locally the bundle was present, so the suite passed; in CI the release gate ran *before* the
   client build, so all four pushes from Phase 29 onward failed at `npm run check` — with only the failing test
   names visible, because the runner logs are not reachable from the environment doing the debugging (the log
   fetch is refused; the annotations are all that can be read). Fixed at both ends: the workflow now installs and
   builds the client **before** the gate, so those assertions run in CI rather than failing on a missing artefact,
   and each deep-link test asserts the built shell up front with the remedy in its message
   (`the built SPA shell is required: npm run build:client`) instead of letting a 404 read as a routing bug.
   Reproduced both ways locally: with `public/app/` moved aside the suite fails on that one message, and after a
   fresh `npm run build:client` the four console suites run 40/40.
6. **A `.secondary-button` class was referenced but never defined.** Phase 31's console used it and it rendered
   unstyled; styles.css now defines it (base, `:hover:not(:disabled)`, `:disabled`) immediately before
   `.danger-button`, whose existing shared disabled rule it inherits.

## Contract tests — `test/client_workforce_console.test.js` (8 tests)

The fourth console suite, and the second for a session-only module, so the absence of a screen permission is
asserted as well as the presence of the screen. It imports the console's plain-ESM logic **and** the server's own
`contracts.js` / `paper/contracts.js` / `market-data/timeframes.js`, and runs against an in-process file-store
server (hermetic: `MARKET_DATA_REAL_PROVIDERS=0`, so every run is synthetic and the assertions say so; the
analysis rate limits and the concurrency cap are raised so the suite exercises the routes rather than the
throttle).

- **Vocabulary is read from the API, not restated** — `RUN_TIMEFRAMES` against the run schema's enum,
  `CONSENSUS_TIMEFRAMES`, `TRADING_MODES` against `TRADING_MODE_BODY`'s values, `MAX_WATCHLIST` against
  `MAX_CONSENSUS_SYMBOLS`, all six legacy watchlist symbols offered, the two symbol groups by name and order, and
  `marketClassFor` agreeing with `strategy.js`'s derivation on sixteen symbols.
- **The four bodies are checked against their schemas property by property** — required fields, the derived
  `marketClass`, the symbol pattern, the timeframe enum, that a blank optional `symbols`/`reason` is omitted
  rather than sent as `""`, and that `buildModeBody` of a mode this edition does not have falls back to
  `ANALYSIS_ONLY` instead of emitting a body the schema refuses.
- **The pre-flights refuse what the schemas refuse and nothing stricter**, and the kill-switch reason edge is
  asserted at both ends (blank → the server's own default or `null`; 501 characters → **400** `reason`).
- **Formatters, and the chart's own formatter** — including that the price formatter inserts grouping separators
  only at ≥ 1000, so no assertion pretends otherwise.
- **Geometry against the live API** — the EMA warm-up (`emaSeries([1,2,3,4,5],3) === [null,null,2,3,4]`), 140
  visible bars of 200, five gridlines, the 56 px volume strip, ±10 % S/R selection, ≥ 1 px bodies, no EMA
  warm-up spike at the origin, and empty/garbage candle input yielding `null` rather than a broken chart.
- **Behaviour against the live API** — a run built by the console's own body renders (crypto class, synthetic
  provenance, three meters, nine signals, five agents with two abstaining, the debate, a null proposal and
  decision **with** the run's `riskContext` naming `ANALYSIS_ONLY` and the active kill switch), a 200-candle
  chart builds, the history lists the run, and a three-symbol consensus scan returns bias rows.
- **Screens and routes** — `/app/analysis` declared exact-path and `requiresAuth` with **no** permission key, a
  resolving view and a nav entry with `permission: null`, module card 01 linking to it, `GET /app/analysis`
  answering HTML, and the route inventory holding exactly three permissioned routes on this surface while every
  path `client/src/api.js` calls exists in it.

## Verification

- `npm run check:workforce` — **1016 / 1016** across 5 suites, 0 failures (1008 before: +8 console contract
  tests).
- `npm run build:workforce-client` — production bundle built: `index-Brdr6qjd.js` (410.65 kB / 113.50 kB gzip)
  and `index-C8opwlwx.css` (35.81 kB / 7.89 kB gzip).
- **The gate's own ordering** — the client built, then the four console suites with the bundle present (40/40),
  and then the same suites with `public/app/` moved aside to confirm the new precondition reports the missing
  shell rather than a routing failure.
- **CI itself** — run `38905032261` on commit `c0416cc` completed **success** in both jobs (the `javascript` job
  including the release gate, the native build, the artefact gate, the football-predictions suite and the runtime
  suite). That is the first green run on this branch since Phase 28; the four pushes from Phase 29 to this phase's
  first commit all failed at the gate for the reason item 4 above records.
- `npm run verify:install -- --require-bundle` — **30/30** installation checks.
- **Behavioural end-to-end** against the running server, driven by the console's own builders and formatters
  (a live store holding a BTCUSDT run): login; `GET /trading/mode` 200 with the kill switch engaged and
  `liveTradingEnabled: false`; a run 200 with derived `marketClass: crypto`, the synthetic provenance sentence,
  three meters (confidence 27 %, confluence 35 %, agreement 64 %), nine signals, five agents (technical BEAR,
  market-structure BULL, crypto BULL, sentiment and fundamentals abstaining), four debate rounds, and a null
  proposal/decision with `ANALYSIS_ONLY` + kill switch in the context; 200 candles → 140 bars drawn, both EMAs
  drawn over all 140, support 4 / resistance 1, no warm-up spike, gridlines 62,481.2 … 77,073.1; five history
  rows; a six-symbol scan with bias rows; an eleven-symbol scan refused 400; all three legacy-only modes refused
  400; the kill switch released (reason cleared), re-engaged and reasoned; the mode set and returned to
  `ANALYSIS_ONLY`; `/app/analysis` plus both bundle assets 200; the ledger naming the console.
- **Not run:** a real browser (no rendering, no click-through, no Lighthouse), real MySQL/MariaDB, any live
  market-data provider, and no numeric PHP↔Node diff (F-26 remains open) — the same limits every phase record
  states.

## Honesty corrections made on the way

- `health.js` keeps `analysis` at `ported` and now names the console **by route**, plus the three things
  `ported` alone would not tell a reader: the screen is session-only like the controller it ports, the two
  governance controls are the paper module's own `trading.control` writes, and the three modes this edition does
  not have are refused by the request schema. Its `tests` field becomes
  `unit + http + persistence + client contract`.
- `test/platform_findings.test.js` pins those label sentences.
- **The module counts are unchanged (10 ported / 5 partial / 2 not-ported).** This phase closed an absence inside
  a `partial` row; it did not promote a state, and row 3 keeps its `partial` label because the sports dashboard
  and the settings screens are still absent.
- The app README's test counts were **wrong and are corrected**: it claimed 1008 tests across 74 files; the
  suite is 1016 tests across **72** files, which is what the directory holds.
- `UNFINISHED_MODULES.md` row 3's "Still absent" clause drops the analysis dashboard and gains the Phase 32
  record — **and it was wrong to drop the workspace dashboard with it, which Phase 33 restored and closed**; row 6's and row 7's "no UI" clauses become the ported chart and the console, and their "port the
  chart/dashboard UI with the app-shell workstream" actions are struck through as done; row 7's port-with-the-shell clause is satisfied and now names the console. `UNFINISHED_MODULES_INDEX.md`,
  `STATUS.md` and the app `README.md` carry the same corrections.

## Remaining after this phase

Row 3 still owes the **sports dashboard** and the **settings screens**; row 5 owes **one retention decision** over
audit, notifications, `wf_analysis_runs` (R-27) and `wf_backtests` (R-28) plus the **outbound delivery channel**;
row 18 still needs its inventory of the remaining chat/journal/tools surfaces; and every host-level gate from the
master plan remains unrun — real MySQL, a crontab, cPanel/Passenger, live providers, SMTP and the official feeds.
