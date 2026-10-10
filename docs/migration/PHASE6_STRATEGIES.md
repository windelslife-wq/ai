# Phase 6 — Strategy Lab, backtesting, lifecycle gates and confidence calibration (2026-10-10)

Row 8 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md): *"Strategy Lab,
lifecycle, backtesting and model/decision analytics."* Item 3 in the master plan's
module order.

Six commits, `b3c5d35..a2bef0f`, 30 files, **+10 124 −16**. Version 0.6.1 → 0.7.0.

| Commit | What |
|---|---|
| `82bbe4f` | The pure engine: series view, four builtins, metrics, backtester, optimizer, lifecycle registry |
| `b550ab4` | Persistence: migration 006, three tables, ten contract methods on both adapters |
| `3621750` | Promote backtest headline fields to columns so the listing reaches parity |
| `bdd1665` | The HTTP surface: seven `/api/v1` routes, cost control, 27 tests |
| `be7add3` | Journal analytics and confidence calibration: four routes, 30 tests |
| `a2bef0f` | Correct a workspace card that called a ported module unported (F-29) |

Nothing in `application/`, `system/` or `tests/` was modified — verified with
`git diff --name-only b3c5d35..HEAD`, which returns no path under those
directories. The legacy oracle still passes **367/367**.

---

## 1. What now exists

### Strategies module (`apps/workforce-platform/src/modules/strategies/`)

| File | Ported from | Role |
|---|---|---|
| `series-view.js` | `Strategies/SeriesView.php` | Causal window; a future read throws `LookAheadError` |
| `builtin.js` | `Strategies/BuiltinStrategies.php` | Four strategies plus the `TradingStrategy` contract |
| `metrics.js` | `Backtest/Metrics.php` | 21 aggregate keys, Sharpe/Sortino, streaks, drawdown |
| `backtester.js` | `Backtest/Backtester.php` | Next-bar fills, cost model, record and journal projection |
| `optimizer.js` | `Optimization/StrategyOptimizer.php` | Walk-forward 70/30 search with adoption rules |
| `registry.js` | `Strategies/StrategyRegistry.php` | Evidence-gated lifecycle |
| `journal-analytics.js` | `Journal/Analytics.php` | Groupings and the confidence-calibration verdict |
| `contracts.js` / `service.js` / `routes.js` | `Api_strategies.php`, `Api_journal.php`, `Platform.php` | The HTTP surface |

It reuses what Phases 4 and 5 already proved rather than re-porting it:
indicators from `analysis/indicators.js`, `clamp`/`roundTo`/`numberFormat` from
`analysis/math.js`, `timeframeMs` from `market-data/timeframes.js`, `seededRandom`
from `market-data/normalize.js`, `isProviderFailure`/`marketDataFailure` from
`market-data/errors.js`, and — deliberately — `inferMarketClass` from
`analysis/contracts.js` rather than the narrower one in `market-data`, because the
latter would label `XAUUSD` forex and fetch the wrong series. `seededRandom` and
`timeframeMs` were checked against `MathUtils::seededRandom` and `Timeframes::ms`
before being relied on, since the test fixtures are generated with that PRNG and
would diverge silently otherwise.

### Supporting changes

- `src/db/migrations/006_strategies.sql` — `wf_strategies`, `wf_backtests`,
  `wf_journal_entries`.
- `src/db/strategy-repository.js` — the MySQL adapter (10 methods).
- `src/persistence/contract.js` — `REPOSITORY_METHODS` **36 → 46**.
- `src/persistence/file-store.js` — entities **10 → 13**, plus a composite
  `keyOf` case for strategies.
- `tools/verify-data.mjs` — two integrity checks per adapter (§6).
- `src/config.js` + `.env.example` — five cost-control variables, documented count
  **59 → 64**.
- `client/src/views.jsx` + `styles.css` — F-29.

---

## 2. Route parity

Eleven routes, taking the platform from 38 to **49**. All session-only with
**no permission gate**, because the legacy routes sat behind `Api_controller`,
appeared in no `PUBLIC_ACTIONS` list and carried no permission check — any
signed-in role could backtest, optimize or promote a strategy. The four mutating
routes are CSRF-gated; bearer callers are exempt.

| Node | Legacy | Note |
|---|---|---|
| `GET /api/v1/strategies` | `api/strategies` | grouped by id, latest + versions |
| `GET /api/v1/strategies/:strategyId` | `api/strategies/(:any)` | `?version=`, empty means latest |
| `POST /api/v1/strategies/:strategyId/status` | `api/strategies/(:any)/status` | DV-4: POST only |
| `POST /api/v1/strategies/:strategyId/optimize` | `api/strategies/(:any)/optimize` | DV-6: id from the path only |
| `POST /api/v1/backtesting/run` | `api/backtesting/run` | |
| `GET /api/v1/backtesting/results` | `api/backtesting/results` | DV-11: summaries |
| `GET /api/v1/backtesting/results/:backtestId` | `api/backtesting/results/(:any)` | the only payload read |
| `GET /api/v1/journal` | `api/journal` | |
| `POST /api/v1/journal/manual` | `api/journal/manual` | 201 |
| `GET /api/v1/journal/analytics/summary` | `api/analytics/summary` | DV-8 |
| `GET /api/v1/journal/analytics/calibration` | `api/analytics/confidence-calibration` | DV-8 |

Validation matches the legacy vocabulary, which is **narrower** than the
platform's: `timeframe ∈ {15m, 1h, 4h, 1d}` (not the six market-data serves) and
`marketClass ∈ {forex, crypto, commodity}` (not the nine). A caller asking for
`5m` gets a 400 here exactly as it does on the legacy route. A 1-minute backtest
would also be almost entirely cost, since the model charges every fill.

**Not ported, and not claimed:** the four legacy *document* routes (`/strategy`,
`/strategy/backtest`, `/strategy/optimize`, `/strategy/advance`) and
`views/strategy/index.php`. See F-29 — this is a platform-wide gap, not a
Strategy Lab one.

---

## 3. Honesty rules that are enforced, not documented

1. **A signal never fills on its own bar.** Entries fill at the *next* bar's open;
   `LookAheadError` escapes the run rather than being recorded as a warning.
2. **Costs are charged on every fill.** Half-spread plus slippage move the price,
   fees apply both ways, and `rawPnl − totalCost === netPnl` is asserted.
3. **Ambiguity resolves against the strategy.** A bar touching both stop and
   target closes at the stop. An entry bar can stop out immediately
   (`barsHeld: 0`).
4. **Synthetic data says so twice** — in the promoted `synthetic` column a query
   can filter on, and in the run's `warnings`.
5. **Unmeasurable is `null`, never `0`.** `profitFactor` with no losing trades,
   Sharpe with under two returns, calibration under 30 tagged trades. `0` would
   read as "measured and terrible".
6. **Calibration refuses to flatter.** Under 30 confidence-tagged closed trades it
   returns no verdict and states the count. Above that, a win rate that does not
   rise with confidence is reported as a reason to *distrust* the signal — the
   check that stops a confidence score becoming an invitation to size up.
7. **Evidence is per version.** A backtest against `1.0.1` cannot satisfy the
   `BACKTESTED` gate for `1.0.0`, because the gate exists to prove that *this
   code* worked.
8. **An AI-adopted variant cannot self-promote.** `source: "ai"` is refused at the
   risk-review and paper gates (and see the dead end in §10).

---

## 4. Test evidence (this sandbox, 2026-10-10)

| Suite | Cases | Result |
|---|---|---|
| `test/strategies.test.js` | 86 | pass |
| `test/strategies_store.test.js` | 27 | pass |
| `test/strategies_http.test.js` | 27 | pass |
| `test/journal_analytics.test.js` | 30 | pass |
| `test/config.test.js` | 8 (+1) | pass |
| **App suite total** | **428** (was 257 before this module, **+171**) | **pass** |
| Legacy oracle (`runtime/run-tests.mjs`) | 367 | pass, unchanged |
| `tsc --noEmit` | — | clean |
| `verify-install --require-bundle` | 30 | pass, 64 env vars documented |

Client bundle rebuilt: `index-BEWWTqRR.js` 265.73 kB (gzip 79.66 kB),
`index-CuzqXBFB.css` 18.15 kB.

### 4.1 Legacy cases ported 1:1

- `tests/cases/05-strategies.php` → series-view causality, the four builtins'
  signal behaviour, the first lifecycle gate.
- `tests/cases/06-backtester.php` → fill mechanics, the cost decomposition,
  pessimism, reconciliation, hand-computed Sharpe/Sortino/streaks.
- `tests/cases/33-optimizer.php` → the walk-forward split, determinism, the
  short-history refusal, overfit flagging, AI-variant governance.
- `tests/cases/08-engine-journal.php` → groupings and calibration verdicts, on the
  same forty-entry fixture (twenty at confidence 0.3 split 50/50, twenty at 0.9
  split 13/7), asserting the same numbers: two groups, 40 closed trades, two
  buckets, high win rate 0.65 above low 0.5, "directionally informative".

Fixtures are redefined locally in each test file rather than imported from
`analysis.test.js`, because `node:test` registers cases at import time and
importing that file would re-run its 75 cases inside the importer and inflate
every count. `market_data.test.js` already does this.

### 4.2 Node-specific coverage beyond the legacy suite

Every lifecycle gate in isolation (the legacy reaches them only through a full
platform boot); the request resolver's refusals; both adapters against one
contract with a parity case proving the same evidence yields the same comparison
result on either; WAL replay of the composite strategy key; the two rate-limit
windows independently; the concurrency gate as a unit; and the integration the
module exists for — a run persisted over HTTP is the evidence that unlocks
`BACKTESTED`, asserted by showing the same request 409 before the run and 200
after it.

---

## 5. Deliberate divergences from legacy behaviour

| # | Divergence | Why |
|---|---|---|
| DV-1 | Timestamps are well-formed ISO-8601. Legacy `iso()` builds `gmdate('Y-m-d\TH:i:s\Z', …)` — where `\Z` is a **literal** Z in PHP's date format — then appends `.mmm` and a second Z, producing `2025-08-12T12:00:00Z.123Z`. | Verified: that string is an **Invalid Date** in JavaScript and is rejected by this repo's own `assertIsoCutoff`. It cannot be sorted or range-filtered as text. No oracle assertion pins the legacy spelling, which is why the defect survived there. |
| DV-2 | `created_at`/`updated_at` use the `Z` form, not legacy `gmdate('c')` → `+00:00`. | The two sort differently as text for the same instant, and `findRecord`'s "latest by `updated_at`" relies on lexicographic order being chronological. Migration 006 pins one format for this reason. |
| DV-3 | Gate warnings survive a **successful** transition. | Legacy `transition()` returns a hardcoded `'warnings' => []` on success, discarding the advisories its own gates compute ("Sharpe is suspiciously high", "trade count is modest", "stop distance is very wide") at exactly the moment a strategy is being promoted. Rejection reasons are unchanged. |
| DV-4 | `POST …/status` only; no `GET`. | CodeIgniter routes are method-agnostic, so `ROUTE_MAP.md` §7.4 lists `GET/POST`, but `status()` reads a JSON body and a GET therefore always produced a 400. There was no GET behaviour to preserve, and `GET /strategies/:id` already returns `lifecycle` and `nextStage`. |
| DV-5 | `analyze()` still orders by `execution_time` as **text**, but manual entries are normalised to canonical ISO-8601 UTC on write. | Legacy stored the raw submitted string, so an offset timestamp (`…+01:00`) sorts after every `…Z` string for the same instant and changes the reported `maxDrawdownAbs`. Normalising on write fixes every row *this* platform creates; rows imported from legacy may still misorder, so the divergence stays **open**. |
| DV-6 | `optimize` takes the strategy id from the path only. | Legacy accepted it from the path *or* the body (`if ($strategyId !== '') $body['strategyId'] = $strategyId`), which let two callers disagree about which strategy was optimized. |
| DV-7 | An unexpected fault is a **500**, not legacy's 422 (backtest) / 409 (optimize). | Legacy caught `Throwable` and mapped it to a status that describes the *caller's* request. Reporting our own bug as one sends an operator looking for a mistake in their input. |
| DV-8 | Journal analytics live under `/journal/analytics/*`, not legacy `/api/analytics/*`. | `/api/v1/analytics/*` would sit two letters from Phase 5's `/api/v1/analysis/*`. These endpoints read this module's table, so the module lives behind one prefix — the same call the analysis module made moving `api/agents` under `/analysis/`. No alias: nothing consumes these paths yet, and an alias would imply a compatibility promise nobody asked for. |
| DV-9 | An overlong `reasonForTrade` is **rejected**, not truncated. | Legacy applied `mb_substr(…, 0, 500)`, silently discarding the end of someone's rationale — and the rationale is the field a reviewer reads to judge whether the trade had a thesis. |
| DV-10 | `aiConfidence` is bounded to 0..1. | Legacy accepted any number, but the calibration buckets span `[0, 1.0001)`, so a confidence of 5 would be stored and then silently excluded from every bucket — the report would quietly omit trades it was supposed to measure. |
| DV-11 | `listBacktests` returns summaries carrying promoted `metrics`/`warnings`/`candles` columns, not fully decoded payloads. | Legacy `list()` called `decode()` on every row, so a listing of thirty runs read thirty LONGTEXT blobs. The response shape is unchanged; only where the small fields live moved. `trades` and `equityCurve` stay in the payload for the detail route alone. |

Two schema-level corrections made before committing, both worth recording because
each would have been invisible in a passing test:

- My first `contracts.js` declared `uppercase: true` on the symbol field.
  `src/http/validate.js` supports `trim` and `lowercase` and has **no** `uppercase`
  keyword, so it would have been silently ignored — a schema line that reads like
  a guarantee and is not one. Case folding stays where the legacy does it.
- Two patterns rejected the empty string, which legacy uses to mean "latest
  version" and "no filter". A client building a query string from an unset
  variable sends `?version=` and must get the latest version, not a 400.

---

## 6. Defects found and closed while porting

**A migration comment that was not true.** `006_strategies.sql` says `backtest_id`
is deliberately not a foreign key (a legacy import writes journal and backtest
rows in separate passes, and an FK would make import order load-bearing) with
integrity "checked by `tools/verify-data.mjs` instead". `verify-data.mjs` did no
such thing. It now checks, on **both** adapters, that every journal row citing a
backtest cites one that exists, and that every backtest names a strategy version
that exists. Without the second check a `VALIDATED` strategy could rest on
evidence attached to nothing.

**A journal ceiling that could flip a verdict.** `listJournalEntries` capped at
1000 rows, but `Api_journal::calibration` reads `list([], 2000)`. A lower ceiling
would silently truncate the sample a calibration verdict is computed from — and
since a verdict needs 30+ tagged trades to say anything at all, truncation could
change the answer. Raised to 2000 on both adapters.

**A listing that could not reach parity.** `backtest_results()` reads `metrics`,
`warnings` and `candles` from every listed row. My summaries excluded all three,
so the Node route could not produce the legacy response shape at all. Neither
decision was wrong alone; the split was drawn in the wrong place. Fixed in
`3621750` by separating the small fields a listing shows from the large arrays
only the detail route needs.

**Two legacy cosmetic defects, reported not copied.** `combinationsEvaluated` is
written `count($results) + ($baseline !== null ? 0 : 0)` — a ternary adding zero
on both branches; ported as plain `results.length`, same reported number. And
`num()` in `BuiltinStrategies.php` is never called anywhere in the legacy tree;
not ported.

---

## 7. Configuration

Five new variables, all documented in `.env.example` (checked by
`verify-install`, which reports **64**):

| Variable | Default | Why this value |
|---|---|---|
| `RATE_LIMIT_STRATEGY_BACKTEST_MAX` | 12 | One run fetches up to 5 000 candles and simulates every bar — comparable to an analysis run |
| `RATE_LIMIT_STRATEGY_BACKTEST_WINDOW_MS` | 600000 | Matches the analysis windows |
| `RATE_LIMIT_STRATEGY_OPTIMIZE_MAX` | 2 | An optimization re-runs the backtester once per grid combination and once per walk-forward segment: 24 × 2 plus the baseline ≈ **50 simulations** |
| `RATE_LIMIT_STRATEGY_OPTIMIZE_WINDOW_MS` | 600000 | |
| `STRATEGY_MAX_CONCURRENT_RUNS` | 1 | Lower than the analysis module's 2 on purpose: one strategy slot holds ~50× the work of one analysis slot, so two would put ~100 simulations on a host that may have two cores |

`0` disables the concurrency cap, matching `MAX_REQUESTS_PER_CLIENT` semantics —
"off", never "refuse everything". Shipped defaults are asserted in
`test/config.test.js`, not in the HTTP suite, because that suite lifts the limits
so they cannot throttle an unrelated test.

This is **R-26 applied at birth** rather than discovered later as a finding. The
global API limiter bounds *requests*, not *work*.

---

## 8. Security review of the new surface

- **Authentication.** All eleven routes require a session. None requires a
  permission, matching legacy; this is recorded rather than "fixed", because
  adding a permission the legacy did not have would change who can operate the
  platform and is a cutover decision.
- **CSRF.** The four mutating routes carry `requireCsrf`. Bearer callers are
  exempt, as elsewhere.
- **Injection.** Every value is bound. `LIMIT` is interpolated because mysql2 does
  not bind it reliably, so it is coerced to a bounded integer first; a test pins
  that `"50; DROP TABLE wf_backtests"` yields `LIMIT 50` with no injected keyword
  and no statement separator in the SQL — inert, though notably *not* the fallback
  default, because `parseInt` keeps leading digits.
- **Order of checks.** Body validation runs **before** authentication (finding
  D-8, pre-existing and platform-wide). An unauthenticated caller with an invalid
  body therefore receives a 400 naming the missing fields, not a 401. Pinned
  explicitly so nobody reads that 400 as evidence the caller was signed in.
- **Corrupt data is a 500, not a default.** A JSON column that will not parse
  throws. Reporting a damaged `params` column as `{}` would let a gate read "no
  criteria declared" and pass a strategy it should refuse.
- **Audit.** Runs, optimizations, registrations and lifecycle changes are audited
  with dotted-lowercase action keys. An audit write failure never fails the
  operation it describes. Attribution is proved through `listAuditEvents`' `userId`
  filter, because the projection exposes no `actorId`.
- **No new dependency.** Runtime deps remain exactly `mysql2` and `bcryptjs`.

---

## 9. What was **not** exercised (honest limitations)

1. **No MySQL server exists in this sandbox (F-15, unchanged).** Migration 006,
   every statement in `strategy-repository.js`, the MySQL branch of
   `verify-data.mjs`, and backup's three new table counts are pinned on **SQL text
   and bound values through a recording fake pool** — never executed. The file
   adapter paths *are* executed for real, including close-and-reopen WAL replay.
2. **No live provider data.** With `MARKET_DATA_REAL_PROVIDERS=0` every backtest
   in every test runs on synthetic candles, and each asserts `synthetic: true`.
   No test proves behaviour against a real feed.
3. **The `APPROVED` stage is unreachable end-to-end.** Its gate requires 10+
   closed `source: "paper"` journal trades, and paper trading is row 10 — not
   ported. Tests satisfy the gate by writing paper rows directly, which proves the
   gate's arithmetic and not that anything can produce those rows.
4. **No cron on any host.** Retention and pruning remain operator-run.
5. **No headless browser.** The F-29 client change is verified by a successful
   production build and by `verify-install`'s bundle-reference check, not by
   rendering. Nobody has looked at the new card.
6. **Bundle byte-reproducibility is not claimed (F-12).** There is no lockfile for
   the app's own dependencies, so the bundle is reproducible from a given
   `node_modules`, not from the repository alone.

---

## 10. Findings after this phase

### F-29 (new) — no ported module has a workspace console

The SPA ships identity, account, admin and status views and **nothing else**.
Market analysis (Phase 5, 5 routes), market data (Phase 4) and now the Strategy
Lab (11 routes) are all reachable only with an API client. The legacy served each
of these as a rendered page — `views/strategy/index.php` is 8 466 bytes of
operator UI with forms for backtest, optimize and advance.

Worse, `ModuleCards` labelled market intelligence *"Not yet ported to Node"*,
which stopped being true in Phase 5 and stayed on screen through Phase 6. That is
corrected in `a2bef0f` with a three-state vocabulary (`live` / `api` /
`planned`), because two states could not describe reality: "not ported"
understates a tested, served API, and "ported" implies an operator can click it
here, which they cannot. The middle state is styled blue, not the green used for
`live`, since the colour is part of the claim.

Building the consoles is a separate and larger piece of work. It is recorded here
rather than smuggled in, and the four legacy document routes
(`/strategy`, `/strategy/backtest`, `/strategy/optimize`, `/strategy/advance`)
remain **unported**.

### The AI sign-off dead end (reported, deliberately **not** fixed)

`riskReview` refuses `source === "ai"`, and **no route in either edition can
record a human sign-off or change a strategy's source.** An optimizer variant
adopted with `register: true` is written as `source: "ai"` at `DRAFT` and
therefore stops permanently at `VALIDATED` — the "manual human risk sign-off" the
refusal messages promise has no mechanism anywhere.

Oracle `33-optimizer.php` confirms the path is unreachable through the API: to
reach the paper gate it writes `lifecycle = 'RISK_REVIEWED'` **straight into the
database**.

Adding a sign-off route would widen the surface and weaken a control, so it is
left as a finding for the Risk Center row. The control is honest about itself in
the meantime: `register: true` returns a note saying exactly this, and the API
refuses the transition with a reason naming the missing sign-off.

### Still open from earlier phases

F-11, F-12, F-15, F-16, F-18, F-24, F-25, F-26, R-21…R-25. Closed earlier and
still closed: F-27 (DV-10 in Phase 5), R-26, R-27, F-28.

---

## 11. cPanel notes for this phase

1. **Apply migration 006** before deploying. `readiness` requires all six ordered
   migrations and reports `schema: false` until they are present, so `/health/ready`
   stays 503 and traffic is not served against a partial schema. Seeding the four
   builtins runs on every boot and is idempotent; a seeding failure is **logged,
   not fatal**, so a host missing the migration still serves documents and every
   other API rather than turning a missing table into an outage.
2. **Add the five environment variables** (§7). `verify-install` fails the install
   if any `env.*` the config reads is undocumented, and now reports 64.
3. **Backups now cover 15 tables** (was 12). `tablesFromMigrations()` derives the
   list from the migration files by regex, so 006 was picked up automatically —
   which is the point of F-28's fix. A restore taken before this phase will not
   contain the three new tables.
4. **`verify-data` runs two more integrity checks per adapter** (§6). Both are
   failures, not warnings: an orphaned journal row or backtest means evidence whose
   provenance cannot be inspected.
5. **Rebuild the client bundle** (`npm run build:workforce-client`) — the F-29 fix
   is client-side, and `public/app/` is generated and ignored.
6. **Retention for `wf_backtests` is not implemented.** Each row stores a full
   LONGTEXT payload (every trade, the whole equity curve), and nothing deletes
   one. This is the same shape as R-27 for analysis runs, and it is recorded as
   **R-28** rather than silently left. It was not implemented here because
   backtests are load-bearing *evidence* for lifecycle gates, unlike analysis runs
   which are advisory outputs: deleting the run that justified a `VALIDATED`
   strategy destroys the audit basis for a promotion already granted. That
   trade-off deserves its own decision, not a copied one.

---

## 12. Entry criteria for the next phase

1. **Row 10, paper trading.** It is the only way to produce `source: "paper"`
   journal rows, so until it exists the `APPROVED` gate is arithmetically
   satisfiable and practically unreachable (§9.3). It must also resolve the AI
   sign-off dead end in §10 deliberately, not inherit it.
2. **Row 9, `PortfolioOptimizer.php`** — a separate row, explicitly out of scope
   here, and not touched.
3. **Module consoles (F-29).** Three ported modules now have no UI. If the next
   phase adds one, it should establish the pattern for all three rather than for
   itself alone.
4. **R-28.** Decide the retention policy for `wf_backtests` before the table is
   large enough for the decision to be expensive.
5. **F-15 remains the largest unverified surface.** Six migrations and five
   repository modules have now been written against a server this sandbox does not
   have. Every phase adds to that debt; none of it is discharged by more SQL-text
   tests.
