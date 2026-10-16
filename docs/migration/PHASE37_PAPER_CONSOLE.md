# Phase 37 — the paper trading console (row 10)

**Status:** complete · 2026-10-16 · branch `arena/046b29ac-ai`

`/app/paper` is now the port of `views/paper/index.php` (`Paper::index`) and
`views/paper/account.php` (`Paper::account`) on one screen: the accounts board, the account console (its
eight statistics, open positions with their close buttons, the orders table **including the rejected rows**,
the closed positions the close journaled, the deployments and their tick), the order and deploy forms,
legacy's three banners, the effective risk limits, and the module's own statement of where its governance
lives. With it, **row 10 has no screen left**.

The API half of this module was ported and documented in Phase 7 (`docs/migration/PHASE7_PAPER_TRADING.md`);
this phase ports the **screens over it**, which is why it adds no route, no migration, no repository
method, no permission and no dependency.

## Scope

| | |
|---|---|
| Legacy | `views/paper/index.php` (60 L), `views/paper/account.php` (179 L), `controllers/Paper.php` (`index`, `account`, `create`, `order`, `close`, `deploy`, `tick`), `libraries/Aegis/Paper/PaperTradingEngine.php:34-36` (the three cost constants) and `:173-178` (the risk fraction), `tests/cases/07-paper-trading.php` |
| Node routes used (all already present) | seven reads — `GET /trading/mode` (`trading.view`, the governance state the banners and the limits panel read), `GET /paper/accounts` (`.view`), `GET /paper/accounts/:id` (`.view`), `GET /paper/accounts/:id/orders` (`.view`), `GET /paper/accounts/:id/positions` (`.view`), `GET /paper/accounts/:id/deployments` (`.view`), `GET /strategies` (session-only, the deploy form's list) — and the six mutations the screen offers, all `trading.execute`: `POST /paper/accounts`, `POST /paper/accounts/:id/orders`, `POST /paper/accounts/:id/positions/:positionId/close`, `POST /paper/accounts/:id/tick`, `POST /paper/accounts/:id/deployments`, `POST /paper/accounts/:id/deployments/:deploymentId/toggle` |
| New files | `client/src/paper.js` (656 L, 49 exports), `test/client_paper_console.test.js` (29 tests), this record |
| Edited (client) | `client/src/views.jsx` (`PaperConsoleView`, its import block, the nav entry, two stale docblocks), `client/src/api.js` (ten new paper wrappers, and `paperAccounts()` now takes a query string), `client/src/App.jsx` (route + view map), `client/src/styles.css` (`.paper-*`, `.paper-view`, `.view-lede`, two responsive rules), `client/src/dashboard.js` (`PAPER_NOTE`, the quick action, the paper KPI card's note and destination, one docblock) |
| Edited (tests) | `test/client_dashboard.test.js` — the paper absence assertions move, because the screen exists now |
| Unchanged | **no new route** (146 before and after), no migration, no repository method (`REPOSITORY_METHODS` is 185 either way), no permission, no dependency, **no server file at all** |

## The screen

- **The accounts board** (`index.php`'s table): every account the session owns with its balance, equity,
  unrealized and daily P&L, open positions, and the server's own `valuationAvailable` warning where the
  valuation could not be computed. Selecting a row opens the console below it; a session with no accounts
  gets legacy's own empty sentence, and a session that cannot execute still reads everything.
- **The account console** (`account.php`): the eight statistics in legacy's order (balance, equity,
  unrealized P&L, daily P&L, weekly P&L, open positions, open risk Σ, daily loss), each tone from the sign
  the server sent (a `0` is neither up nor down), then:
  - **open positions** with direction glyph, units, entry, the server's current price, stop, take profit,
    unrealized P&L and R — and a **close** button per row;
  - **orders including the rejected** — legacy's own caption — with the requested or filled price, the
    status badge, the synthetic mark, and the **reason**, which is where a refusal is explained;
  - **closed positions (journaled automatically)**, the 25 most recent per legacy's `limit(25)`;
  - **deployments** with strategy, version, symbol, timeframe, class, `active`/`paused`, the last signal,
    and a pause/resume per row;
  - the **order form** (symbol, side, type, limit price, mandatory stop, take profit, risk, reason,
    confidence, strategy, TF) and the **deploy form** (strategy from `GET /strategies`, marked
    `undeployable` while the lifecycle is below `RISK_REVIEWED` instead of hidden).
- **Legacy's three banners**, all read from `GET /trading/mode` and none assumed: the synthetic-paper
  banner, the mode banner (`Trading mode is X — paper orders are blocked until you switch to PAPER_TRADING
  on the Dashboard. The kill switch must also be released.`), and the kill-switch banner. Every one of the
  three is asserted against `index.php`, including the two the PHP splits across tags.
- **The effective risk limits** panel reads the same persisted limits the Risk Engine enforces
  (`GET /trading/mode` → `riskLimits`, sixteen rows, percents rendered as percents) — not a second opinion
  about them.
- **The boundary panel** states what the module is: fills are simulated and never routed to a broker, the
  tick is an operator's action rather than a schedule (there is no cron here), and the three governance
  acts the screen does **not** carry — trading mode, the kill switch, synthetic-paper prices — are
  `trading.control` and live on `/app/analysis`, which the panel names and links.
- **Refusal text is the server's own sentence** everywhere: an order refused under the switch renders the
  stored row's `reject_reason` (the console's `orderOutcome` builds the flash from the response body,
  because that route answers a refusal as a `409` carrying a whole order record rather than the usual
  `{error:{code,message}}` envelope), so a paraphrase cannot soften it.

## Divergences stated, not hidden

- **Owner scoping.** Legacy's `Paper::account($id)` looked an account up by id with no owner filter at all,
  and legacy's orders/positions/deployments queries were not owner-filtered either; the port scopes every
  paper read to the owner and answers a foreign account exactly as it answers a missing one
  (`404 PAPER_ACCOUNT_NOT_FOUND` — no existence leak). The console test asserts the divergence against
  legacy's source (the controller never mentions the column) and against the API, and the dashboard's
  paper KPI note already stated the same fact about the count.
- **The risk field's label.** Legacy's form labelled it `Risk %` with `min="0.1" max="2"`, while the engine
  multiplies equity by the value as a **fraction** (`$riskAmount = $summary['equity'] * $riskPct`), so
  legacy's own bounds meant 10 %–200 % of equity and were then clamped by the 1 %/2 % risk limits. The port
  keeps the fraction and names it (`Risk (fraction of equity)`, bounded by the contract's `1e-6`…`0.05`),
  and the test pins both the legacy label and the port's, so the change cannot be mistaken for a
  transcription error later.
- **Nothing is fabricated.** A `null` balance, equity, price, P&L or R renders an em dash, never a zero; a
  position whose valuation is unavailable says so and its R is an em dash; a limits vocabulary the server
  did not send is not invented.

## Tests

`test/client_paper_console.test.js` — **29 tests**, hermetic (file adapter, `createFileStoreApp` with
`MARKET_DATA_REAL_PROVIDERS=0` and `MARKET_DATA_ALLOW_SYNTHETIC=1`, no network). Five of them build the
real app and drive it over HTTP:

- the two legacy views are read with `readFileSync` and every heading, lede, empty state, table caption and
  footnote in `PAPER_COPY` is asserted against them, so a paraphrase fails the suite;
- `PAPER_COSTS` is asserted equal to `src/modules/paper/engine.js`'s own constants (the fills note's basis
  points are the engine's, not a copy), and `PAPER_MARKET_CLASSES`/`PAPER_TIMEFRAMES` against the
  market-data and strategy enums;
- the route inventory: all seven reads and all nine declared writes exist in
  `GET /api/v1/system/routes` with the permission the server enforces, the `/api/v1/paper/` surface is
  **11 method+path entries**, and the strategy list is session-only;
- the three governance writes are declared `carried: false` and asserted **absent** from the view, which
  points at `/app/analysis` instead;
- the shapers on both an empty and a populated payload: the board, the eight statistics, the positions,
  the orders with a stored rejection, the closed rows, the deployments, the three banners (including that
  an absent switch field is not a released switch), and the sixteen limit rows;
- the form validators and body builders, including that a blank optional field is **omitted** so the
  server's defaults apply rather than being shadowed;
- live: an empty host renders legacy's empty state and reads every surface; a `trading.view` session reads
  the three non-account-scoped surfaces, is answered `404 PAPER_ACCOUNT_NOT_FOUND` for an account it does
  not own (and sees an empty board), and is refused **403 `PERMISSION_DENIED`** on all six mutations with
  the bodies their own contracts accept;
- live: the whole flow — create through the form's body, be refused by the **kill switch**, be refused in
  **ANALYSIS_ONLY**, be refused in **PAPER_TRADING with synthetic prices off** by the Risk Engine's own
  provenance sentence, fill after the governance is satisfied, pend a limit order and tick, then close the
  position and read it back from the closed table;
- live: a DRAFT strategy is refused by the deploy route, the lifecycle chain (backtest → `BACKTESTED` →
  `VALIDATED` → `RISK_REVIEWED`) then makes the same body `201`, and the toggle answers
  `Deployment <id> paused.`;
- the served shell: `/app/paper` answers `200 text/html`, its bundle carries the screen's strings and the
  nav path, and the stale F-29 sentence is gone from the bundle.

(The five are: the empty host, the `trading.view` session, the order flow, the deploy flow and the served
shell; the rest are pure shapers, formatters and form builders, and need no app.)

`test/client_dashboard.test.js` moved with the note it pinned: the quick action now has a destination, the
paper KPI card links to the console, `PAPER_NOTE` no longer cites F-29, and `/app/paper` leaves the
"named as open in F-29" list for the reason `/app/sports` left it in Phase 36.

## Gates

- `npm run check:workforce` → **1095 / 1095** (1066 before: +29 console tests).
- The client suites together → **118 / 118** (89 + 29).
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:client` → `index-BZ7bg51D.js` 509.21 kB / 137.59 kB gzip,
  `index-BbfC8AGb.css` 42.15 kB / 9.05 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe (demo host on `:4020`, file-store adapter, admin `root`): **35 / 35** — login, the demo's
  deliberate governance state read back, the board and its rows, an order refused **409** under the switch
  and stored `REJECTED` with the refusal sentence, the fill path (switch released → `PAPER_TRADING` →
  synthetic allowed) filling a market order, a tick answering, the position closed and the closed table
  reading back, the deployments table reading back, `/app/paper` serving the shell, the served bundle
  carrying the screen's strings and no F-29 sentence, and the demo's governance state **restored exactly**
  (kill switch ACTIVE, `ANALYSIS_ONLY`, synthetic prices off).
- **Probe note:** the probe *did* write — deliberately, to leave the preview showing a real board rather
  than empty states: account 1 ("Recon simulator") now holds a FILLED order with its reason, three
  stored kill-switch rejections and one risk/reward rejection (`Risk/reward 1.34 below minimum 1.5`), one closed
  position (the close journaled a row), and one active `breakout@1.0.0` deployment whose strategy was
  advanced through backtesting, validation and risk review for the demo. The governance state was restored
  afterwards, so the refusal path the demo exists to show is still the first thing an operator sees. The
  probe scripts were deleted; none of this is a product change.
- **Not run:** a real browser (no rendering, no click-through of the forms), real MySQL/MariaDB (F-15), any
  live provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## The first CI run failed — and what it found

The phase's first push (`f20bf70`) went red on the `javascript` job: the two HTTP tests that submit orders
(the whole flow and the deploy/toggle flow) failed on the runner while passing in the sandbox. The cause is
worth recording because it is a property of the *test*, not of the console: the suite's
`createFileStoreApp` did not set `MARKET_DATA_REAL_PROVIDERS=0`, so the app registered the **real** provider
chain (`src/config.js:595` defaults `realProviders` to `true`). In the sandbox an outbound fetch fails and
the chain falls back to the synthetic provider, which is why the assertions held; on a GitHub runner with
internet the same fetch **succeeds**, so the order the test submits is priced against a live BTCUSDT quote
and the backtest the lifecycle chain depends on runs on live candles instead of the suite's own — different
prices, different trades, different gates. Every other console suite and the module's own `paper_http` suite
already set that flag for exactly this reason; this one now does too, and it asserts the consequence where
it matters (the filled order's row is `synthetic: true`, the backtest's `dataProvenance.synthetic` is
`true`), so a future configuration drift fails loudly on the assumption instead of silently on the price.

## After this phase

**F-29's residual list is now risk, execution, brokers, journal** — paper left it, which is what row 10's
closure means. **Module counts are unchanged — 10 ported / 5 partial / 2 not-ported:** this phase ported
screens over routes that already existed, and `paperTrading` was already `ported`.

The `partial` remainder the module carries is unchanged and still stated on the screen: no provider
egress, fills simulated with the three engine costs, the tick an operator's action, and the Risk Engine's
own refusals rendered as the server sent them. F-30's `maxCorrelatedPositions` is still declared without
enforcement.

Next, unchanged: F-29's remaining consoles (risk, execution, brokers, journal), row 5's
retention/outbound-delivery decisions, row 18's chat/journal/tools inventory, and every host-level gate
(real MySQL, crontab, cPanel/Passenger, live providers, SMTP, official feeds).
