# Phase 31 — Strategy Lab console

**Date:** 2026-10-16 · **Scope:** close row 8's last recorded entry — the four legacy document routes
(`/strategy`, `/strategy/backtest`, `/strategy/optimize`, `/strategy/advance`) and `views/strategy/index.php`
(F-29 for this module) — as one exact-path screen at `/app/strategy`, driving the twelve strategy/backtesting
routes that already existed. No new HTTP route, migration, contract method or permission: the route count stays
**146** before and after.

## Why this module next

`UNFINISHED_MODULES.md` row 8 has said `ported` since Phase 6, with one named absence: the console. That is a
different job from Phase 30's, where the console was the *last* item of a `partial` module and closing it moved
the ledger. Here the state was already correct and the phase's evidence is simply that the absence is gone — so
the work is judged by whether the screen is a faithful port of the legacy page, not by a count that changes.

The rows that remain open are the settings screens and the analysis/sports dashboards (row 3), and both sit
behind modules that are still `partial` for reasons of their own — sports owes stake sizing and a verified
vendor. Strategy was the last dashboard whose module had no other remainder.

## Delivered

**`/app/strategy` — the Strategy Lab console** (`StrategyLabView`), the port of `views/strategy/index.php` and
of the three posts behind it. The legacy controller navigated on every submit (POST → redirect → flash); the SPA
performs the same three operations as API calls and renders the API's answer in place.

- **Strategy cards** from `GET /api/v1/strategies` — one per strategy, with the lifecycle badge in legacy's own
  colour language (DRAFT gray, BACKTESTED/VALIDATED sky, RISK_REVIEWED/PAPER_TRADING violet, APPROVED green,
  RETIRED red), the `params` summary, the version list, and the six-stage stepper
  `DRAFT → BACKTESTED → VALIDATED → RISK_REVIEWED → PAPER_TRADING → APPROVED` with legacy's one annotated step,
  `Paper trading (deploy)`. A RETIRED version shows no current stage rather than pretending to be somewhere on
  the ladder.
- **The backtest runner** — legacy's six symbols (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `EURUSD`, `GBPUSD`,
  `XAUUSD`) and four timeframes (`15m`, `1h`, `4h`, `1d`, default `1h`), the bar count legacy defaulted to
  (1500, with the engine's own 60–5000 clamp carried as the input's bounds), and the `allowShorts` toggle. The
  body carries `strategyVersion` **from the version on screen**, so a run is recorded against what the operator
  was looking at rather than whatever is latest at submit time. The `marketClass` is derived by legacy's rule
  (`XAUUSD` → commodity, `*USDT` → crypto, else forex) and upper-cased to match the engine, so a lowercase entry
  cannot be classified one way on screen and another on the wire.
- **The report** — every metric the backtester returns as a labelled list, the equity curve, the trade list, the
  data-provenance line (source, candle count, window) and the engine's own warnings verbatim. A synthetic run is
  labelled **SIMULATION — not market performance** on the row and in the report; the legacy flash sentence
  ("Backtest complete: N trades · return X% · maxDD Y%") is rebuilt from the report rather than from a flash
  cookie that does not exist here.
- **The stored history** — `GET /backtesting/results` with legacy's Date/Sym/TF/Trades/Return/Win%/PF/Sharpe/MaxDD
  columns and the SIM|LIVE badge, and the detail route fetched behind an inspect control because the listing
  carries **summaries only** (DV-11: legacy decoded every row's LONGTEXT on a thirty-row list; the equity curve
  and the trades stay in the detail payload).
- **The lifecycle stepper's controls** — the advance button always targets the server's own `nextStage` (never a
  client-side copy of the order) and carries an optional reason. A refused transition renders the 409's
  `details.reasons` **and** `details.warnings` verbatim: legacy's gates computed those advisories and
  `transition()` then discarded them on a successful path (DV-3), so a console that showed only "rejected" would
  lose exactly what a person acts on. Live evidence: `Sample size too small: 3 trades < 10 required (BTCUSDT)`
  with `Trade count is modest — results may not be statistically robust`, and
  `Invalid transition BACKTESTED -> APPROVED. Expected next stage: VALIDATED (stages may not be skipped)`.
- **The optimizer** — legacy's 1000-bar default bounded by the engine's 420–2000 clamp, the register-variant
  toggle whose note keeps saying that a registered variant is `source: ai`, DRAFT and needs a human sign-off, the
  in-sample/out-of-sample split, the finalist table with both halves of the split, the overfit warnings, the
  engine's `methodNote` and its recommendation — `ADOPT <params>` or "keep current parameters — *the engine's own
  reason*".
- **The human sign-off** — rendered **only** when the version on screen is `source: "ai"`, which is the only case
  the route accepts (`STRATEGY_SIGNOFF_REJECTED`: "only required for AI-generated strategies"). It posts under
  `trading.control`, the permission the route already enforced.

## The guard: session-only, like the controller it ports

Legacy's `Api_controller` guarded these routes with a session and **no** permission, and the port kept that —
`routes.js` gates exactly one of the twelve routes (`POST /strategies/:strategyId/sign-off`, `trading.control`).
The screen therefore declares no permission on its exact-path route, and none on its navigation entry: inventing
a screen permission legacy never had would have hidden a console from operators the API serves. A test asserts
this the way it can be asserted — by reading the route inventory and requiring **exactly one** permissioned
route on the whole surface the console drives, and by requiring the declaration not to carry a `permission` key.

The writes the screen performs are all records or analysis: a backtest run and an optimization are persisted
reports (each holds a per-session concurrency slot on the server, released in `finally`), and a transition is a
lifecycle row. Nothing on this screen can reach an order path, and the module is never handed the paper or
execution services.

## Defects and corrections made on the way

1. **`optimizeRecommendation` printed the phrase twice.** The engine's refusal reason already opens with
   "keep current parameters — ", and the formatter prefixed its own copy, producing
   `keep current parameters — keep current parameters — no candidate beat the baseline out-of-sample` on the live
   endpoint. The formatter now uses the server's sentence verbatim when it already says it and prefixes only when
   it does not, with an assertion that the phrase appears exactly once.
2. **A splice rewrote a line it should not have.** While inserting the console, the *portfolio optimizer's*
   timeframe select was changed to the strategy console's aliased timeframe list. Both lists hold the same four
   values, so it built and behaved identically — which is why it is recorded: the source no longer said what it
   meant, and "harmless at runtime" is not a reason to leave it. Restored to the portfolio console's own list.
3. **Three stale "the shell only has a notification inbox" claims.** `sports/routes.js`, `sports/service.js`
   (twice, one of them inside the `SPORTS_NOT_PORTED` detail that is served over HTTP) and a test comment said
   the workspace shell has no console but the inbox. True when written, false since; each now says what is
   actually missing — a **sports** screen — rather than describing the whole shell.

## Contract tests — `test/client_strategy_console.test.js` (8 tests)

The third console suite, and the first for a module whose routes are session-only, so the absence is asserted as
well as the presence. It imports the console's plain-ESM logic **and** the server's own `contracts.js`,
`backtester.js` and `registry.js`, and runs against an in-process file-store server (hermetic:
`MARKET_DATA_REAL_PROVIDERS=0`, so every run is synthetic and the assertions say so).

- **Vocabulary is read from the API, not restated:** `STRATEGY_TIMEFRAMES`, `STRATEGY_MARKET_CLASSES`, the stage
  order from `LIFECYCLE_STAGES` less `RETIRED_STAGE`, and the bar bounds from `BACKTEST_LIMIT_MIN/MAX` and
  `OPTIMIZE_CANDLE_MIN/MAX`. Every offered symbol's table entry must agree with the derivation rule, so the
  select and a hand-typed symbol cannot classify differently.
- **The four bodies are checked against their schemas property by property** — `BACKTEST_BODY`, `OPTIMIZE_BODY`,
  `STATUS_BODY`, `HUMAN_SIGNOFF_BODY` — including required fields, the derived `marketClass`, symbol
  normalisation, and that a blank optional field is omitted rather than sent as `""`.
- **The pre-flights refuse what the API refuses and nothing stricter:** an unknown symbol, a timeframe the
  endpoint does not serve and a non-integer bar count are refused; a bar count outside the clamp range is *not*,
  because the engine clamps and reports what it used. The one rule that is deliberately identical to the
  server's (`HUMAN_SIGNOFF_BODY`'s 10-character trimmed reason) is asserted at both ends.
- **Behaviour against the live API:** a run built by the console is recorded, summarised (including the SYNTHETIC
  marker), and renders twelve metric cells with no `undefined`/`null` leaking into the DOM; the history and the
  detail route answer; the optimizer returns a search space, a split, finalists, overfit warnings and a
  refusable recommendation; an advance reaches `nextStage` and the next attempt is refused 409 with reasons
  **and** warnings; the skip refusal names the expected stage; a builtin is refused sign-off.
- **Screens and routes:** `/app/strategy` is declared exact-path, `requiresAuth`, with **no** permission key and
  a resolving view and nav entry; the module card links to it; the HTML deep link returns the SPA shell; the
  route inventory holds exactly one permissioned route on this surface; and every path `client/src/api.js` calls
  exists in that inventory.

## Honesty corrections made on the way

- `health.js` keeps `strategies` at `ported` and now names the console **by route**, plus the two things
  `ported` alone would not tell a reader: the screen is session-only, and the one permissioned control is the
  route's own `trading.control`. Its `tests` field becomes `unit + http + persistence + client contract`.
- `test/platform_findings.test.js` pins those label sentences and asserts the label no longer carries the F-29
  hedge. The module counts are unchanged (10 ported / 5 partial / 2 not-ported) — this phase closed an absence,
  it did not promote a state.
- **F-29 is narrowed once more, not lifted:** it now reads *closed for the audit browser, the portfolio
  optimizer, the lottery and strategies; still open for the Broker Center and the sports screens only.*
- `UNFINISHED_MODULES.md` row 8's "Still absent" clause becomes the Phase 31 record, row 3's dashboard list drops
  strategy (and lottery, which Phase 30 had already closed), and row 19's "Still missing" list loses two entries
  that are no longer true (`lottery_cron` was ported in Phase 25; broker transition alerts in Phase 14).
  `UNFINISHED_MODULES_INDEX.md`, `STATUS.md` and the app `README.md` carry the same corrections.

## Verification

- `npm run check:workforce` — **1008 / 1008** across 5 suites, 0 failures (1000 before: +8 console contract
  tests).
- `npm run build:workforce-client` — production bundle built.
- `node tools/verify-install.mjs --require-bundle` — **30/30** installation checks.
- **Behavioural end-to-end** against the running server, driven by the console's own builders and formatters:
  login; four strategy cards with a stepper for `BACKTESTED` and for `DRAFT`; a run returning 200 (240 equity
  points for 300 bars, 3 trades, 2 warnings, synthetic provenance, twelve rendered metrics); the history listing
  2 rows with every column populated; the detail route returning the equity curve and trades the listing omits;
  the optimizer returning 200 with 18 combinations, split 350/150, 3 finalists, 1 overfit warning and
  `adopt: false`; a transition refused 409 with reasons *and* warnings; the stage-skip refusal naming the
  expected stage; the sign-off refusal for a builtin; `/app/strategy` and both bundle assets 200 with the ledger
  naming the console.
- **Not run:** a real browser (no rendering, no click-through, no Lighthouse), real MySQL/MariaDB, any live
  market-data provider, and no numeric PHP↔Node diff (F-26 remains open) — the same limits every phase record
  states.

## Remaining after this phase

Row 3 still owes the **analysis and sports dashboards and the settings screens**; row 5 owes **one retention
decision** over audit, notifications, `wf_analysis_runs` (R-27) and `wf_backtests` (R-28) plus the **outbound
delivery channel**; row 18 still needs its inventory of the remaining chat/journal/tools surfaces; and every
host-level gate from the master plan remains unrun — real MySQL, a crontab, cPanel/Passenger, live providers,
SMTP and the official feeds.
