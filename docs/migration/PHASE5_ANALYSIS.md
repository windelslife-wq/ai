# Phase 5 — Market analysis, agents, consensus and the risk veto gate (2026-10-09)

**Status: complete in the sandbox, not accepted as the production replacement.** The legacy
application stays authoritative and deployable; nothing here cuts over traffic, changes production
data, enables live trading or deletes legacy code (master plan §11, §13).

| | |
|---|---|
| App version | `@windels/workforce-platform` **0.5.0 → 0.6.0 → 0.6.1** (the patch release is the hardening pass, §13) |
| New source | **3 369 lines** — `src/modules/analysis/**` (1 854) + `src/modules/analysis/agents/**` (1 331) + `src/db/analysis-repository.js`, `src/db/migrations/005_analysis_runs.sql`, `src/modules/market-data/errors.js` (184) |
| Hardening pass | **+2 056 / −139 across 27 files** (git-measured `355a495..c5d252f`) — code 18 files +1 502 / −37, docs 9 files +554 / −102; two of them new: `tools/prune-analysis-runs.mjs` (198) and `test/retention.test.js` (530) |
| New tests | **2 930 lines, 115 tests** — `test/analysis.test.js` (75, pure layer) + `test/analysis_http.test.js` (26, engine/HTTP/persistence/status) + `test/retention.test.js` (14, R-27 on both adapters and the CLI); 95 tests / 2 178 lines before the hardening pass, which added 20 more plus 1 in `config.test.js` and 1 in `backup.test.js` |
| App suite | **257 tests / 16 files, 257 passed, 0 failed** (~33 s); 235/15 before hardening |
| Installation checks | `npm run verify:install` **30/30** — **59 documented env vars** (53 + 5 for R-26 + 1 for R-27) |
| Legacy oracle | `node runtime/run-tests.mjs` **367 passed, 0 failed** in 19.2 s (PHP 8 in WASM; no native `php` here) — **unchanged by the hardening pass, because the legacy PHP is untouched** |
| Typecheck | `tsc --noEmit -p tsconfig.json` clean |
| Egress | 257/257 both with and without `--import /tmp/egress-shim.mjs` (a whole-suite fetch interceptor that fails any non-loopback call); the shim reports **"no outbound requests attempted"** for all 16 files — **no test in this phase can reach the network** |
| Other suites | contracts 12/12 · football 29/29 · icons 4/4 · client build exit 0 ⇒ **665 `node:test` cases passed, 0 failed** across the workspace (257 + 367 + 12 + 29; the 4 icon checks and the build are assertions, not cases) |
| Routes | 33 → **38** API routes; 22 document routes unchanged. Hardening added **no route** — retention is deliberately CLI-only |
| Repository contract | 32 → 35 → **36** methods (`pruneAnalysisRuns`); migrations 001–004 → **001–005** |
| Dependencies | unchanged — `bcryptjs` + `mysql2` only, no `devDependencies` |

---

## 1. What now exists

### Analysis module (`apps/workforce-platform/src/modules/analysis/`)

| File | Lines | Legacy source | What it is |
|---|---|---|---|
| `math.js` | 75 | `Aegis/MathUtils.php` | PHP-faithful numerics: `roundTo` (half **away from zero**, not banker's), `numberFormat` (grouped), `fixedFormat` (ungrouped — legacy `number_format($v,5,'.','')`), `signedFormat`, `clamp`, `finiteNumber` |
| `indicators.js` | 399 | `Aegis/Indicators.php` | SMA, EMA, RSI (Wilder), MACD, Bollinger, ATR, ADX/±DI, VWAP, classic floor-trader pivots, fractal swings, support/resistance merging, volume profile, regression slope, `%D` masking. Candles are keyed **`timestamp`**, matching `market-data/normalize.js` |
| `regime.js` | 314 | `Aegis/Analysis.php` (all four static methods) | `detectRegime` → **seven** labels (`UNKNOWN`, `BREAKOUT`, `TRENDING_UP`, `TRENDING_DOWN`, `HIGH_VOLATILITY`, `LOW_VOLATILITY`, `RANGING`) with evidence, volatility % and ADX; needs `MINIMUM_CANDLES_FOR_REGIME = 60` candles or it reports `UNKNOWN` with the reason rather than guessing. Also ports `regimeDirectionality`, `generateSetup` (the entry/stop/target proposal with its 1.5 / 2.5 / 3.5 R targets) and `buildScenarios` + `insufficientDataScenarios` |
| `risk-engine.js` | 183 | `Aegis/RiskEngine.php` | The **veto gate**: frozen `DEFAULT_RISK_LIMITS`, `createRiskEngine(limits)` with `getLimits`/`updateLimits` (a configured risk is always clamped to the hard cap) and `evaluate(setup, context)` → `{approved, checkedAt, reasons, warnings, sizing}` |
| `feeds.js` | 131 | `Aegis/Agents/*Feed*`, sentiment validator | `unavailableSentimentFeed`, `unavailableFundamentalsFeed`, `createSentimentSnapshotValidator(maxAgeSeconds)`. Abstention is a **computed** outcome: available, licensed, attributed to a named source, and ≥ 2 individually attributable in-range fresh observations |
| `agents/helper.js` | 55 | `Aegis/Agents/AgentHelper.php` | `AGENT_WEIGHTS`, `makeVote`, the ±0.15 vote threshold |
| `agents/technical.js` | 212 | `Aegis/Agents/TechnicalAgent.php` | The full structured report: trend, momentum, volatility, volume and the `signals[]` array. Throws on an empty series rather than inventing a report. Setups and scenarios are **not** built here — the legacy builds them in `Analysis.php`, so they live in `regime.js` |
| `agents/market-structure.js` | 262 | `Aegis/Agents/MarketStructureAgent.php` | BOS/CHoCH, swing structure, liquidity. **A wick beyond a swing never confirms a break** — confirmation is a close rule |
| `agents/forex.js` | 185 | `Aegis/Agents/ForexCryptoSentimentAgents.php` | Currency strength from 7 reference legs, session detection, `macro.available: false` with the missing provider named |
| `agents/crypto.js` | 133 | ditto | On-chain, derivatives and dominance each reported `available: false` — never proxied from price |
| `agents/sentiment.js` | 106 | ditto | The licensed-feed boundary; abstains (`votes: false`) unless the validator passes |
| `agents/fundamentals.js` | 58 | `Aegis/Agents/FundamentalsAgent.php` | Abstains: no earnings, macro-calendar or valuation feed exists, and none is faked |
| `agents/intelligence.js` | 128 | `Aegis/TradingIntelligenceEngine.php` consensus block | Consensus: weighted votes, agreement, conflicts, confluence, confidence, the two hard gates and the recommendation. Keeps the gate reasoning it consumes |
| `agents/debate.js` | 192 | `Aegis/Agents/AgentDebate.php` | Four-round adversarial review (data critic, risk critic, contradiction check, conviction test) producing a transcript and a verdict that can only **reduce** confidence |
| `engine.js` | 409 | `Aegis/TradingIntelligenceEngine.php` (`run`, `consensus`) | Orchestrates: fetch → regime → panel → consensus → debate → setup → risk veto → persist → audit. `DEFAULT_TRADING_STATE` is frozen with the kill switch **engaged** |
| `contracts.js` | 153 | `Api_analysis.php` vocabulary | Body/query/param schemas, `MARKET_CLASSES`, `TIMEFRAMES`, `CONSENSUS_TIMEFRAMES`, `DEFAULT_WATCHLIST` (7 symbols), `inferMarketClass`, `AGENT_CATALOGUE` |
| `service.js` | 106 | — | The HTTP seam: consensus fan-out with per-symbol class inference, history/find reads, and the **static** `statusSnapshot()` |
| `routes.js` | 84 | `Api_analysis.php` | The five endpoints (§2), statics registered before `:runId` |

### Supporting changes

* **`src/db/migrations/005_analysis_runs.sql`** (35 lines) — `wf_analysis_runs`, additive only. Mirrors the
  legacy `analysis_runs` columns because the summary rows *are* an API payload. `completed_at` stays
  `VARCHAR(32)` holding the same ISO-8601 UTC string as `payload.completedAt` (history sorts by it, and
  ISO-8601 UTC sorts chronologically as text — so this column must never be fed mixed offset formats).
  `synthetic` and `source` are promoted to columns so a query can find every run built on labelled
  synthetic data without opening the payload. `payload LONGTEXT` is the audit copy of what the caller saw.
* **`src/db/analysis-repository.js`** (102 lines) — upsert via `ON DUPLICATE KEY UPDATE`;
  `Number(row.confidence)` at the boundary because `db/pool.js` sets `decimalNumbers: false`.
* **`src/modules/market-data/errors.js`** (47 lines, new) — `marketDataFailure` / `isProviderFailure`
  extracted from the market-data routes so the analysis routes answer a provider outage with the *same*
  503 + `Retry-After` contract instead of a 500. The market-data routes now import it (37 tests still green).
* **`src/persistence/contract.js`** 32 → 35 → **36** (the hardening pass added `pruneAnalysisRuns`, plus
  the shared `assertIsoCutoff` guard both adapters use); **`src/persistence/file-store.js`** gains an
  `analysisRuns` table plus the four methods; **`src/db/store.js`** requires migrations 001–005.
* **Hardening pass (§13)** — `tools/prune-analysis-runs.mjs` (198 lines, new), `npm run prune:analysis`,
  six new env vars in `.env.example`, `config.rateLimit.analysis*` + `config.analysis.retentionDays`,
  `createAnalysisRunGate` in `analysis/routes.js`, the equity veto in `analysis/risk-engine.js`, and
  `tools/backup.mjs` deriving its MySQL table counts from the migrations (finding **F-28**).
* **`src/app.js`** builds **one** `createAnalysisService({store, marketData, log})` on the same
  market-data service the API uses, and shares it with the health routes — the engine reads provider
  provenance to decide how much to trust its own opinion, so it must see the same caches, breakers and
  provenance stamps as the API does.
* **`src/modules/platform/health.js`** — `analysis` → `ported`, `risk` → `partial`, plus a static
  `analysis` snapshot on `/system/status` (never a probe, never a computation over market data).

---

## 2. Route parity — the ported surface

| Node route | Legacy route | Notes |
|---|---|---|
| `POST /api/v1/analysis/run` | `POST /api/analysis/run` | `marketClass` **required** (the legacy inferred it) — a run's cost depends on it: forex/commodity runs also fetch 7 reference legs |
| `GET /api/v1/analysis/history` | `GET /api/analysis/history` | summary rows, newest first, no payload; `limit` 1–100 (default 20) |
| `GET /api/v1/analysis/agents` | `GET /api/agents` | static catalogue, honest about what each agent cannot do |
| `POST /api/v1/analysis/consensus` | `GET /api/agents/consensus` | **method divergence** — see §5 |
| `GET /api/v1/analysis/:runId` | `GET /api/analysis/:id` | full persisted payload; 404 `ANALYSIS_RUN_NOT_FOUND` vs 400 on a malformed id |

Auth: session for all five (none appears in the legacy `Api_controller::PUBLIC_ACTIONS`), **no
permission** — analysis was readable by every legacy role. The two mutations additionally require the
session CSRF token, which the legacy CI3 session supplied for free. This is the first ported module with
an authenticated *unsafe* method, so it is the first to declare `requireCsrf` explicitly.

The payload keeps every legacy key and adds three: `marketClass`, `gates` (the consensus hard-gate
reasoning the legacy computed, used and discarded), and `riskContext` (the trading state the veto was
evaluated against, including `syntheticData`, `staleData`, `dataQuality` and a `note` saying why the
portfolio gates are vacuous on this platform).

---

## 3. Honesty rules that are enforced, not documented

1. **Nothing can be approved.** `DEFAULT_TRADING_STATE` is frozen with `killSwitch.active = true` and
   `tradingMode: "ANALYSIS_ONLY"`, and no ported code path releases it (the kill-switch control surface
   is still legacy-only). `evaluate()` pushes the kill-switch reason **first**, so `reasons[0]` always
   names it. Every run also carries `riskContext.note` explaining that the portfolio gates are evaluated
   against an empty portfolio. Tests assert both the veto and its ordering.
2. **The synthetic label survives the module boundary** (master plan rule 4, risk R-25). The engine reads
   `provenance.synthetic` from market data, carries it into the run payload, into the persisted row
   (as a column), into the audit details, and into the risk context — where `blockSyntheticData: true`
   turns it into a veto. Freshness is graded, not binary: live 1.0, synthetic 0.5, stale 0.2.
3. **Stale data is a critical objection, not a discount.** A stale series is sustained as `CRITICAL` in
   round 3 of the debate, forcing `NO_TRADE` and dropping the proposal entirely — so the platform does not
   publish a trade idea it would have to veto anyway.
4. **Abstention is computed.** Sentiment and fundamentals set `votes: false` and are *excluded* from the
   panel (`consensus.abstainingAgents`); they cannot dilute a directional vote by voting neutral. When a
   licensed feed is injected, the same agent votes — which is the only way to prove the boundary is a gate
   rather than a stub.
5. **Price is never relabelled as sentiment or fundamentals.** Both agents say so in their own report, and
   the crypto agent reports on-chain, derivatives and dominance as `available: false` instead of deriving
   them from candles.
6. **A wick never confirms a break of structure.** Confirmation is a close rule; a wick beyond a swing
   yields an `unconfirmed` break with an identical score to the pre-wick report (pinned by test).
7. **The debate can only reduce confidence.** `verdict.confidenceAdjustment ≤ 0`, and the pre-debate figure
   is recoverable from the verdict — a challenge cannot make the panel more sure of itself.
8. **No store, no silent empties.** The app still boots with `store: null` (a documented capability), but
   `history`/`find` answer `503 ANALYSIS_STORE_UNAVAILABLE` rather than an empty list that would read as
   "no runs yet".

---

## 4. Test evidence (this sandbox, 2026-10-09)

Everything below was executed here; no result is quoted from an earlier phase.

| Command | As delivered (Phase 5) | After the hardening pass (§13) |
|---|---|---|
| `node --test test/*.test.js` | 235 tests, 235 pass, 0 fail (~36 s, 15 files) | **257 tests, 257 pass, 0 fail** (~33 s, 16 files) |
| `node --test test/analysis.test.js` | 71 / 71 | **75 / 75** |
| `node --test test/analysis_http.test.js` | 24 / 24 | **26 / 26** |
| `node --test test/retention.test.js` | — (did not exist) | **14 / 14** |
| `node --test test/config.test.js` | 6 / 6 | **7 / 7** |
| `node --test test/backup.test.js` | 4 / 4 | **5 / 5** |
| `node --test test/platform_findings.test.js` | 32 / 32 | **32 / 32** |
| `node --test test/market_data.test.js` | 37 / 37 (after the `errors.js` extraction) | **37 / 37** — untouched |
| `npm run verify:install` | 30/30 checks, 53 env vars | **30/30 checks, 59 env vars** |
| `npm run verify:install -- --require-bundle` | 30/30 | **30/30** |
| `node runtime/run-tests.mjs` (legacy oracle) | 367 passed, 0 failed in 19.3 s | **367 passed, 0 failed in 19.2 s** — the legacy PHP is untouched, so this cannot move |
| `tsc --noEmit -p tsconfig.json` | clean | **clean** |
| `node --import /tmp/egress-shim.mjs --test test/*.test.js` | 235/235 | **257/257**, shim reporting *"no outbound requests attempted"* for all 16 files |
| `npm run test:contracts` · football · `check:icons` · client build | 12/12 · 29/29 · 4/4 · exit 0 | **12/12 · 29/29 · 4/4 · exit 0** (`index-DSbqgd7N.js`, see §9.1) |
| **Workspace total** (`node:test` cases) | 643 passed, 0 failed = 235 app + 367 oracle + 12 contracts + 29 football | **665 passed, 0 failed** = 257 app + 367 oracle + 12 contracts + 29 football |

The totals count `node:test` cases only, so they are additive and checkable. The 4 icon checks
(`npm run check:icons`) and the client build are assertions, not test cases, and are reported separately
in both columns — which is why this figure is 665 and not 669.

Five consecutive full-suite runs and two runs under CPU contention (two suites at once on 2 cores)
passed with zero failures at 235/235; every run after the hardening pass passed 257/257, including the
egress-blocked one. The only flake ever observed in this suite was root-caused to a test asserting row
order by position (defect D-11) and removed, not re-run until green.

### 4.1 Legacy cases ported 1:1 (36 of 38)

Every ported case keeps the legacy name as a `legacy <file>:` prefix, so a reader can diff the two suites.

| Legacy file | Cases | Ported | Notes |
|---|---|---|---|
| `tests/cases/01-indicators.php` | 11 | **11** | SMA/EMA/RSI extremes/MACD/Bollinger (hand-computed 10.5 ± 2√33.25)/ATR/ADX/VWAP/pivots/fractal swings/regression slope |
| `tests/cases/03-agents.php` | 8 | **8** | technical full report + empty-series refusal, structure empty-series refusal, wick-never-confirms, forex macro unavailable + price-momentum strength, crypto honestly unavailable, sentiment abstains, consensus agreement/conflicts/NO_TRADE gates |
| `tests/cases/04-risk-engine.php` | 8 | **8** | exact sizing (100 / 0.003 / 33 333 units), min R:R veto, missing stop, kill switch `reasons[0]`, synthetic + stale vetoes and their config opt-out, portfolio gates (drawdown 15 % > 10 %, EURUSD concentration), notional + leverage caps, `updateLimits` clamp |
| `tests/cases/34-agent-debate.php` | 7 | **7** | clean sustain, stale → CRITICAL → NO_TRADE, two majors → NEUTRAL, one major → −0.10, weak conviction 0.42 → 0.32, risk-critic setup challenge, **engine carries the transcript and honors the verdict** |
| `tests/cases/08-engine-journal.php` | 4 | **2** | The two ported cases are the engine's. The other two — `runBacktest` (persists + journals + lifecycle evidence) and journal analytics (groupings + calibration verdicts) — exercise `Aegis/Backtest/Backtester.php` and `Aegis/Journal/*`, which are **separate unported modules**, not the analysis engine. They are listed in `UNFINISHED_MODULES.md` and are not claimed here |

### 4.2 Node-specific coverage beyond the legacy suite

`test/analysis.test.js` also pins: warm-up nulls, Wilder convergence, true range across gaps, `%D`
masking, flat-series neutrality, volume profile, S/R merging, PHP rounding and both number formats,
agent applicability by market class, the `dataQuality` ladder (1 / 0.6 synthetic / 0.3 short / 0.42 stale /
0.8 gapped), the ±0.15 vote threshold, **licensed sentiment feed votes** (score 0.4, quality 0.7, weight
0.5, 2 observations excluded) and every validator rejection (`UNLICENSED`, `NO_SOURCE`,
`STALE_OR_INCOMPLETE`, forward-skew tolerance), fundamentals abstention, abstainer exclusion, quality
weighting, **all seven regime labels from deterministic single-branch fixtures** (`UNKNOWN` on a short
series, `TRENDING_UP`, `TRENDING_DOWN` — where flat volume is what keeps it out of the breakout branch —
`BREAKOUT` on a close beyond the 48-bar range at 4× volume, `HIGH_VOLATILITY`, `LOW_VOLATILITY` including
the legacy `1th percentile` ordinal kept verbatim, and `RANGING`), the self-referential nature of the
volatility percentile (a dead-flat series reads `HIGH_VOLATILITY`), setup nulls plus complete self-consistent BUY/SELL proposals and price-scale
rounding, scenarios always three with triggers and invalidation, debate confidence monotonicity and the
minor-objection cap (−0.15), malformed consensus → `NEUTRAL` 0, `givenUnits` measurement, the degenerate
entry-zone warning, a misconfigured-limit veto, and the frozen `DEFAULT_RISK_LIMITS` table.

`test/analysis_http.test.js` adds the engine and transport layer: persistence + audit attribution, the
stale-series downgrade end to end, a **live** (non-synthetic) series where the kill switch is the *only*
remaining veto, an agent that throws (audited as `analysis.agent.failed`, run continues), an injected
sentiment feed reaching the panel, a provider outage surfacing as the provider's own refusal (and as a
per-symbol `error:` row in a consensus scan rather than a failed batch), which reference legs are fetched
for which market class, a missing reference leg weakening the strength table without failing the run, the
frozen trading state, class inference (`XAUUSD` → commodity), 401 on all five routes, CSRF on both
mutations, the validation matrix, the response shape, history ordering and bounded limit, 404 vs 400 on
`:runId`, static-route precedence over `:runId`, consensus bounds and timeframe vocabulary, the 503 +
`Retry-After` outage contract, upsert-not-duplicate persistence, the status surface, and the route
inventory.

### 4.3 Live rehearsal (file adapter, no database, no outbound egress)

`POST /analysis/run` for BTCUSDT 1h → `NEUTRAL` at 0.27 → `HOLD`, regime `UNKNOWN` (fewer than 60
usable candles after warm-up), 5 agents reporting, 9 signals, 3 scenarios, a 4-round debate with no
sustained objections. EURUSD 1h → 6 agents (forex applies to a major pair), `macro.available: false`,
synthetic currency strength with its warning attached, session `Asia`, and a `BOS SELL` **confirmed by a
close** where the crypto run's wick break was not. A 7-symbol consensus scan completed, and every run was
readable back by id (27 payload keys) with `analysis.signal.proposed` and `risk.decision.rejected` in the
audit trail — the kill-switch veto firing exactly as designed.

---

## 5. Deliberate divergences from the legacy behaviour

Divergences are numbered **DV-n** and the defects in §6 are numbered **D-n**. They
were both `D-n` in the first draft of this document, which made `D-8` mean two
different things eight lines apart; the prefixes are the fix. (`D-n` is a
per-document namespace across this ledger — `PHASE4_MARKET_DATA.md` §6 has its own
unrelated `D-1 … D-6`.)

| # | Legacy | Node | Why |
|---|---|---|---|
| DV-1 | `AgentDebate::advocateCases()` filters signals on lowercase `'bullish'`/`'bearish'` while `TechnicalAgent` emits `'BUY'`/`'SELL'` | **Ported as-is**, and pinned by a test | Signal-derived claims therefore never appear in a real debate; only vote-derived ones (`|score| ≥ 0.25`, sliced to 6) do. Fixing it would change every verdict, so it is recorded rather than repaired |
| DV-2 | Conflict count derived from a keyed map | Counted as the array length | Same number for the legacy fixtures; the array is what the payload carries |
| DV-3 | `GET /api/agents/consensus` | `POST /api/v1/analysis/consensus` | The legacy answered a GET that wrote one run and one audit row per symbol. A scan of up to 10 symbols is a mutation, so it is a POST with CSRF |
| DV-4 | Unsupported timeframe coerced/ignored | `400` from the contract | Consensus accepts the narrower `15m/1h/4h/1d`; a run accepts the full market-data vocabulary. Coercion would silently analyse the wrong interval |
| DV-5 | `marketClass` inferred on the run route | Required in the body | The class decides whether 7 extra reference legs are fetched; inferring it hides the cost from the caller |
| DV-6 | `/api/agents*` paths | `/api/v1/analysis/*`, no alias | One origin, one vocabulary (master plan §5). The ledger in `ROUTE_MAP.md` §7.3 records the mapping |
| DV-7 | History limit unbounded | Bounded 1–100, `400` outside it | A payload-carrying table must not be listable without a bound |
| DV-8 | Run id from the legacy id generator | `crypto.randomUUID()` (`CHAR(36)`) | The column type matches; ids are opaque to callers |
| DV-9 | MySQL insert-or-update per adapter | One `ON DUPLICATE KEY UPDATE` upsert | Re-running a symbol must not duplicate a row; both adapters now agree (pinned by a test) |
| DV-10 | **`RiskEngine::evaluate()` returns `approved: true` when equity is `0`, negative or non-finite** (finding F-27) | **Refused.** A veto is pushed before sizing: `Equity 0.00 is not positive — portfolio risk cannot be measured` / `Equity is not a finite number — …` | The only divergence in this port that changes a *decision* rather than a shape, and the only one taken against the legacy engine. Every portfolio gate sits behind `equity > 0`, and sizing derives risk from equity, so at zero equity the legacy engine skipped drawdown, daily/weekly-loss and exposure checks *and* cleared the notional and leverage caps trivially (`0 <= cap`) — then approved a proposal with no capital behind it. Without positive equity there is nothing to size, so an approval measures nothing. Directed explicitly: **fix it in Node, record the divergence, leave the legacy PHP untouched until cutover.** No legacy case is affected — `04-risk-engine` uses equity `100` and `10 000`, so all 8 ported cases still pass, and the 36-of-38 parity in §4.1 is unchanged. The reason string is pinned by test so the veto cannot be dropped silently |

**Not divergences, but recorded here so nobody "fixes" them later:** the legacy kill switch defaults to
**ACTIVE** at boot (`Aegis_model.php:636`), so the legacy `08-engine-journal` case saw `SYNTHETIC` as
`reasons[0]` only because its sqlite fixture had released the switch first. The Node port asserts *both*
reasons and the kill switch's precedence, and does not reproduce the released-switch fixture.

---

## 6. Defects found and closed while porting

| # | Defect | Where | Resolution |
|---|---|---|---|
| D-7 | `(sum + finiteNumber(v)) || sum` in the open-risk reduction — JS operator precedence silently discarded a legitimate `0` accumulation where PHP's `??` would not | `analysis/risk-engine.js` | Rewritten with explicit precedence; covered by the portfolio-gate test. **Class of bug to watch:** PHP `??`/`?:` vs JS `??`/`\|\|` |
| D-8 | Body schemas were written in the *query* dialect (a flat field map), so every field was rejected as `UNKNOWN_PROPERTY` — the run route answered `400` before authentication | `analysis/contracts.js` | Rewritten as `{type:"object", properties, required, additionalProperties:false}`. Caught by the new 401 test, which is why that test asserts *all five* routes |
| D-9 | The engine accepted an injectable clock but the sentiment/fundamentals agents judged freshness against the wall clock, so an injected `now` left candle timestamps and feed observations disagreeing about "fresh" | `analysis/engine.js` | The engine now derives `nowSeconds` from its own clock and passes it to the feed agents. Fundamentals has no freshness check and is deliberately left alone |
| D-10 | `createAnalysisService` hard-required a store, so `buildApp({store: null})` threw — breaking the documented "boots and serves with no database configured at all" capability (F-01) and three pre-existing tests | `analysis/service.js` | Store is optional as it is for market data: runs compute without persisting, and the read endpoints answer `503 ANALYSIS_STORE_UNAVAILABLE` |
| D-11 | A test asserted the newest audit row by position (`analyzed[0]`) while its own harness settled provider calls to zero, so two runs could share a millisecond and the stable sort would return the older row | `test/analysis_http.test.js` | Rows are now located by run id, and history ordering additionally asserts descending `completedAt`. This was a **latent flake in the test**, observed once and then removed rather than re-run until green |
| D-12 | The market-data 503 contract was duplicated inside its routes, so a second consumer (analysis) would have re-implemented it | `market-data/errors.js` | Extracted to a shared module; both route sets import it (37 market-data tests still green) |

**Inherited, then repaired in Node only:** the legacy risk engine approves a proposal when equity is `0`,
because every portfolio gate sits behind `equity > 0` (finding F-27). The Node engine now refuses — see
divergence **DV-10** in §5 and the closed finding in §10. The legacy PHP is deliberately untouched until
cutover, so the two engines disagree here on purpose and the disagreement is recorded rather than hidden.

---

## 7. Configuration

**The analysis *engine* adds no environment variables; the hardening pass added six.** The distinction
matters and is the reason both halves are true.

Agent weights, the vote threshold, the candle limit and the risk limits are read from code constants,
deliberately: they are **safety parameters**, not deployment knobs, and turning them into environment
variables would let a host silently weaken a veto. That is unchanged.

What R-26 and R-27 added are **operational** knobs — how much work one client may trigger, and how long
evidence is kept — which are exactly the things an operator has to be able to tune per host without a
code change, following the same convention as every other limiter in `config.rateLimit`. All six are
documented in `.env.example`, and `npm run verify:install` reports **59 documented variables** (53 before
this phase, +5 for R-26, +1 for R-27) with the "every `env.*` read by `src/config.js` appears in
`.env.example`" check still passing.

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_ANALYSIS_RUN_MAX` | 12 | Runs per window per client address (R-26) |
| `RATE_LIMIT_ANALYSIS_RUN_WINDOW_MS` | 600 000 | That window — 10 minutes |
| `RATE_LIMIT_ANALYSIS_CONSENSUS_MAX` | 4 | Scans per window; tighter because one scan is up to 10 runs |
| `RATE_LIMIT_ANALYSIS_CONSENSUS_WINDOW_MS` | 600 000 | Same 10-minute window |
| `ANALYSIS_MAX_CONCURRENT_RUNS` | 2 | In-flight runs per **session**; `0` disables, matching `MAX_REQUESTS_PER_CLIENT` |
| `ANALYSIS_RETENTION_DAYS` | 90 | How long runs are kept before `npm run prune:analysis` may remove them; `0` keeps them forever (R-27) |

Out-of-range values are refused at boot rather than clamped, as everywhere else in `config.js`
(`RATE_LIMIT_ANALYSIS_RUN_MAX=0` throws; `ANALYSIS_MAX_CONCURRENT_RUNS=-1` throws; `0` is legal and means
"off").

| Constant | Value | Source |
|---|---|---|
| `AGENT_WEIGHTS` | technical 1.0 · market-structure / forex / crypto 0.9 · sentiment 0.5 | `agents/helper.js` |
| Vote threshold | ±0.15 — inside it an agent abstains | `agents/helper.js` |
| Vote weighting | `agent weight × max(0.05, dataQuality)` | `agents/intelligence.js` |
| Confluence | `agreement × (0.5 + 0.5·|netScore|)` | `agents/intelligence.js` |
| Confidence | `0.45·confluence + 0.25·|netScore| + 0.15·regimeClarity + 0.10·avgDataQuality + 0.05·freshness` | `agents/intelligence.js` |
| Hard gates | `dataQuality < 0.5` or `freshness < 0.3` → `NO_TRADE` | `agents/intelligence.js` |
| Bias / action thresholds | `|netScore| < 0.2` → `NEUTRAL`; a directional recommendation needs confidence ≥ **0.55** (compared against the *unrounded* value), else `HOLD` | `agents/intelligence.js` |
| Freshness factor | live 1.0 · synthetic 0.5 · stale 0.2 | `engine.js` |
| `CANDLE_LIMIT` | 300 per analysed symbol | `engine.js` |
| `REFERENCE_SYMBOLS` / `REFERENCE_LIMIT` | 7 legs / 60 candles each, forex and commodity only | `engine.js` |
| `MINIMUM_CANDLES_FOR_REGIME` | 60, else `UNKNOWN` | `regime.js` |
| `TARGET_RISK_MULTIPLES` | 1.5 / 2.5 / 3.5 R | `regime.js` |
| `DEFAULT_RISK_LIMITS` | 1 % risk (2 % hard cap) · min R:R 1.5 · stop required · $50 000 notional · 5× leverage · 10 open positions · 3 % daily / 6 % weekly loss · 10 % drawdown · 5 % symbol / 15 % portfolio exposure (capital-at-risk basis) · 3 correlated · `minDataQuality` 0.5 · block synthetic · block stale | `risk-engine.js` (frozen) |

Market-data configuration is unchanged from Phase 4 (`MARKET_DATA_*`, `BINANCE_API_BASE`,
`FRANKFURTER_API_BASE`, `AEGIS_{STOCK,ETF,FUTURES,OPTIONS}_DATA_*`).

---

## 8. Security review of the new surface

* **Authentication.** All five routes sit behind `createAuthenticator`; the 401 test covers each one, not
  just the read paths. No route is public, and none is reachable before authentication — proven by D-8,
  where a schema bug made the run route answer 400 *first*, which the same test caught.
* **CSRF.** Both mutations require the session-bound token (`403 CSRF_INVALID` otherwise, tested with a
  missing and a wrong token). Bearer callers are exempt by design, as in the identity module.
* **Authorisation.** No permission is required, matching the legacy controller: analysis was readable by
  every role. The route inventory reports `permission: null` for all five so the ledger states this
  explicitly rather than leaving it implicit.
* **Rate limiting.** *(As delivered: no per-route limit — the global API limiter `api:<client>`, 120/60 s,
  applied before routing, and the exposure was recorded as **R-26** rather than silently accepted. That was
  the honest position at the time; it is no longer the position.)* **Closed by §13.2.** Both POST routes now
  carry their own window limits (12 runs / 4 scans per 10 minutes per address, charged before validation)
  *and* hold a slot in a per-session in-flight cap (default 2, keyed by session so a shared NAT cannot be
  used to starve a colleague). Worst case per window is ≤ 416 upstream series instead of 120 requests × 80
  calls. Refusals are `429 RATE_LIMITED` for the window and `429 TOO_MANY_CONCURRENT_ANALYSES` for the cap,
  distinguished because the client's remedy differs. The three GET routes stay unlimited on purpose: they
  read the store and cost no upstream calls.
* **Input handling.** Bodies are schema-validated with `additionalProperties: false`, so an undeclared key
  cannot reach the engine or a repository as an implicit filter. `limit` is bounded twice (contract 1–100
  and the service clamp). `:runId` is constrained to `[A-Za-z0-9_-]{1,64}` — a malformed id is a `400`,
  and only a well-formed unknown id is a `404`, so the route cannot be used to probe id shapes.
* **Injection.** Every analysis query is parameterised; the only interpolated value is a bounded `LIMIT`.
* **Information disclosure.** A provider outage answers `503` with the platform-wide contract and keeps the
  provider's own message in `error.details.reason`; no host, port, key or stack is echoed. Audit rows record
  a *hash-free* summary (symbol, timeframe, bias, confidence, legacy action) and never the payload.
* **Data-at-rest.** `wf_analysis_runs.payload` holds a full run including provenance. It is analysis output,
  not personal data. *(As delivered it grew without a retention policy — recorded as **R-27**.)* **Closed by
  §13.3:** `ANALYSIS_RETENTION_DAYS` (default 90) plus `npm run prune:analysis`, dry-run by default, with
  **no HTTP route able to delete a run** — retention is an operator action, not an API verb, and a test
  asserts the module registers no `DELETE` at all.
* **Storage safety.** The file adapter still refuses production without
  `ALLOW_FILE_STORE_IN_PRODUCTION=1`; analysis adds no new write path that bypasses that check.

---

## 9. What was **not** exercised (honest limitations)

1. **No real upstream data.** This sandbox has no egress. Every run here was computed from the synthetic
   provider or from an injected test double, and says so in `provenance`. The engine's *live* path
   (`synthetic: false`, `stale: false`) is covered only by a double that relabels deterministic candles —
   the arithmetic is proven, the vendor payload shapes are not (carried from Phase 4, F-25).
2. **No MySQL.** Migration `005` and `analysis-repository.js` are verified by the readiness probe, the
   contract check and SQL-text assertions, not by executing against a server. The upsert is unexercised on
   real MySQL (F-15, narrowed).
3. **Ported numerics are still not diffed against PHP output** (F-26, unchanged and still a cutover
   prerequisite). The 36 legacy cases were re-derived by hand and pinned as goldens, but no PHP↔Node
   value-for-value diff of `Indicators.php`, `MathUtils.php` or the agents has been run: booting WASM PHP to
   dump reference constants failed (`ERR_MODULE_NOT_FOUND`, then a 300 s timeout).
4. **The risk engine's approve path is unit-tested only.** It is reachable in tests by passing
   `killSwitchActive: false`, and those tests pin exact sizing. It is **not** reachable from any HTTP route
   on this platform, by design (§3.1). No test claims otherwise.
5. **No portfolio state.** Equity, peak equity, open positions and open risk are platform defaults
   (10 000 paper, empty portfolio), so the drawdown, daily/weekly loss, exposure and correlation gates are
   exercised only by unit tests that supply a context. On the HTTP surface they are vacuous, and
   `riskContext.note` says so in every run.
6. **No UI.** There is no analysis screen in the client bundle; `ported` here means API + tests, exactly as
   in Phase 4. No client *source* changed (`git diff HEAD -- apps/workforce-platform/client` is empty), but
   the rebuilt bundle hash is **not** the one Phases 3–4 recorded — see §9.1, which is evidence for F-12
   rather than a claim of reproducibility.
7. **Not run here:** MT5 `pytest` (9 cases, needs its own Python 3.11 venv), browser/Lighthouse checks,
   real SMTP, cPanel/Passenger deployment.

### 9.1 The client bundle hash moved, and that is a finding — not a Phase 5 change

Phases 3 and 4 recorded the built SPA as `index-Ci3bygYZ.js` (265.27 kB). Rebuilding in this sandbox after
Phase 5 produced **`index-DSbqgd7N.js` (265.20 kB)** with the same CSS (`index-B-xBd6Ec.css`, 18 123 bytes).
Three facts were checked before drawing any conclusion:

1. **No client source changed.** `git diff HEAD -- apps/workforce-platform/client` is empty for both Phase 5
   commits, and the working tree is clean for that directory.
2. **The build is deterministic.** Two consecutive builds against the same `node_modules` produced the same
   hash and byte size, so this is not a non-reproducible build.
3. **The dependencies were re-installed without a lockfile** (`npm install --no-package-lock`, the documented
   workaround for R-04 in this repository). `react`/`react-dom`/`vite` are pinned exactly (19.3.0 / 19.3.0 /
   8.3.2) and did not move, but their **transitive** dependencies are unpinned, and 78 bytes of output
   changed as a result.

So the honest claim is: *the client is unaffected by Phase 5, and the bundle is reproducible from a given
`node_modules` — but it is **not** reproducible from the repository alone.* That is finding **F-12** /
risk **R-04** observed in the wild rather than argued about, and it is why the CI build step matters more
than a locally recorded hash. Nothing here should be read as "the Phase 3–4 measurement was wrong": it was
accurate for the tree that existed then.

---

## 10. Findings after this phase

The three items this phase opened were closed by the hardening pass that followed it, on explicit
instruction: fix F-27 in Node and record the divergence, and close R-26 and R-27 before porting another
module. All three closures are measured below, not asserted.

* **F-27 — CLOSED in Node (🟡 → resolved), divergence DV-10.** The legacy risk engine returns
  `approved: true` when equity is `0`, because every portfolio gate sits behind `equity > 0` and a zero risk
  amount clears the notional and leverage caps trivially (0 ≤ cap). The Node engine now vetoes zero,
  negative and non-finite equity before sizing, naming the reason. **The legacy PHP is untouched**, so the
  two engines disagree here on purpose until cutover — recorded as divergence **DV-10** in §5. Verified:
  all 8 ported `04-risk-engine` cases still pass (they use equity 100 and 10 000), the 36-of-38 parity in
  §4.1 is unchanged, and the veto reason string is pinned by test for zero, negative and non-finite equity
  alongside a positive-equity control that must *not* trip it. The hazard for the broker/execution/
  paper-trading ports is now closed on the Node side rather than merely documented.
* **R-26 — CLOSED (🟠 → resolved).** Both POST routes carry their own window limits (12 runs and 4 scans
  per 10 minutes per client address, charged *before* validation so a malformed body still costs budget),
  and both hold a slot in a per-session in-flight cap (default 2, `0` disables). The cap is keyed by
  session, not address, so a shared office NAT cannot let one colleague's long scan starve another's — the
  same reasoning that keeps login lockout per account. A refused slot returns `429
  TOO_MANY_CONCURRENT_ANALYSES`, deliberately distinct from `RATE_LIMITED` because the remedy differs. The
  release sits in `finally`, so a run that throws gives its slot back instead of locking the session out.
  Worst case per window is now ≤ 416 upstream series against the previous 120 requests/min × 80 calls.
  `GET /api/v1/system/routes` reports `rateLimited: true` for both POSTs and `false` for the three GETs.
* **R-27 — CLOSED (🟡 → resolved).** `ANALYSIS_RETENTION_DAYS` (default 90, `0` keeps forever) plus
  `tools/prune-analysis-runs.mjs` / `npm run prune:analysis`, backed by `pruneAnalysisRuns` on both
  adapters — repository contract **35 → 36**. Dry run is the default and reports matching rows, the oldest
  and newest affected timestamps and the reclaimable payload bytes before anything is deleted. MySQL
  deletes in clamped, `ORDER BY`-deterministic batches (default 500, ceiling 5 000) so no single statement
  holds locks on a shared host, and reports `exhausted: false` if the batch ceiling is reached with rows
  remaining. There is deliberately **no HTTP route** that can delete analysis history.
* **F-28 (new, 🟠 high) — MySQL backups never worked, and nothing caught it.** `tools/backup.mjs` counted a
  hardcoded list of tables that had drifted in both directions: it omitted `wf_contact_inquiries` (Phase 3),
  `wf_data_imports` and `wf_analysis_runs` (Phase 5), and it counted **`wf_user_files`, a table nothing in
  this repository creates or references** — avatars live in `wf_user_profiles.profile_image`. On MySQL that
  made `SELECT COUNT(*) FROM wf_user_files` throw `ER_NO_SUCH_TABLE`, so `npm run backup` **failed outright**
  on the adapter production uses. No test caught it because the backup suite drives the file adapter only
  and this sandbox has no MySQL. Fixed by deriving the list from `src/db/migrations/*.sql`, which makes the
  drift impossible by construction, plus a pin test asserting the derived list equals the 12 tables the
  migrations create and that the phantom stays out. Found while implementing R-27, because a prune that
  changes row counts is only safe if the operator can prove counts before and after.
* **F-24, F-25, F-26** unchanged (per-process provider health/breakers/caches; CI never calls a real
  provider; ported numerics not diffed against PHP).
* Still open from earlier phases: **F-11, F-12 (now with observed evidence — §9.1), F-15 (re-widened),
  F-16, F-18**.

Module ledger after this phase (`GET /api/v1/system/features`, 15 entries): **3 ported** — `identity`,
`marketData`, `analysis`; **3 partial** — `publicSite`, `audit`, `risk`; **9 not-ported** — `notifications`,
`strategies`, `paperTrading`, `execution`, `brokers`, `sports`, `lottery`, `languageLearning`,
`leadDiscovery`. `risk` is *partial*, not ported: only the veto gate lives
here, while the portfolio monitor, the limits API and the kill-switch control surface remain legacy-only.

---

## 11. cPanel notes for this phase

1. **Run the migration before deploying the code.** `npm run migrate` applies `005_analysis_runs.sql`;
   `/api/v1/health/ready` stays `503` until all five migrations are present, so a partial deploy is visible
   rather than half-working. The migration is additive — it alters no existing table.
2. **Passenger note.** The analysis engine holds no long-lived sockets, but it does hold the market-data
   service's in-process caches and circuit breakers. Multiple Passenger instances therefore keep separate
   provider-health views (F-24): a breaker that opens in one worker is invisible to the others. This is
   unchanged from Phase 4 and is not made worse by analysis, but a consensus scan multiplies the number of
   provider calls each worker makes.
3. **Cost.** On a host with real providers, prefer `POST /analysis/consensus` with an explicit short symbol
   list over the 7-symbol default watchlist, and expect a forex run to be ~8× a crypto run. R-26 now bounds
   this: 12 runs and 4 scans per 10 minutes per address, and 2 runs in flight per session. Tune
   `RATE_LIMIT_ANALYSIS_*` / `ANALYSIS_MAX_CONCURRENT_RUNS` per host rather than editing code — but note the
   caps are per **process**, so N Passenger workers each get their own (F-24 applies to limiters too).
4. **Retention is an operator job, and it is not automatic.** `wf_analysis_runs.payload` is a LONGTEXT copy
   of every run and nothing else deletes a row. Add a cron entry, and run the dry form once by hand first:

   ```bash
   node tools/prune-analysis-runs.mjs            # measures: matching rows, oldest/newest, bytes reclaimed
   node tools/prune-analysis-runs.mjs --apply    # deletes; take a backup first (npm run backup)
   ```

   The window comes from `ANALYSIS_RETENTION_DAYS` (default 90; `0` keeps everything forever, and the tool
   then refuses to delete even under `--apply` unless `--days N` is passed explicitly). Exit code is 0 when
   it pruned or there was nothing to do, 1 when it refused; `--json` prints exactly one document for cron
   logging. There is deliberately no HTTP endpoint for this.
5. **Six new env vars, no new secrets.** All are documented in `.env.example` (see §7); `verify:install` is
   30/30 with **59** documented variables. Nothing needs a new credential on the host.
6. **Backups now cover the analysis table.** `snapshot.json` row counts are derived from
   `src/db/migrations/*.sql`, so `wf_analysis_runs` is counted (F-28). Before this fix `npm run backup`
   failed outright on MySQL; verify it once on the host after deploying.
7. **Do not release the kill switch from a config file.** There is no ported control surface for it, and
   that is intentional: releasing it is a Phase 6+ decision requiring explicit human approval.

---

## 12. Entry criteria for the next phase

The next module (paper trading, or the portfolio monitor that would make the risk gates non-vacuous) may
start when:

1. This phase's tests are green **on the target host**, not only in the sandbox (`npm run check`), and
   migration `005` has been applied there.
2. **F-26 is closed**: `Indicators.php`, `MathUtils.php`, `MarketRegimeDetector`, the agent set and
   `RiskEngine::evaluate` diffed value-for-value between PHP and Node, with any divergence recorded here
   rather than patched silently. Until then no analysis output should be treated as equivalent to the
   legacy output, only as independently tested.
3. ~~**F-27 is resolved deliberately**~~ — **done.** The Node engine vetoes zero, negative and non-finite
   equity (divergence **DV-10**); the legacy PHP is intentionally untouched until cutover. What remains for
   the next phase is the *reconciliation*: when F-26 diffs `RiskEngine::evaluate` value-for-value, this
   divergence must appear in that diff as an expected difference, not be "fixed" back. A paper-trading port
   must call the Node engine, never the legacy one, or it will inherit the zero-equity approval.
4. ~~**R-26 has an answer**~~ — **done and measured**: per-route window limits on both POST routes plus a
   per-session in-flight cap, with the limits reported by `GET /api/v1/system/routes`. What the next phase
   must not do is add an expensive endpoint without its own limit; the pattern is now in
   `analysis/routes.js` (`config.rateLimit` + `createAnalysisRunGate`).
5. Any consumer of a run carries `provenance.synthetic` forward into its own payload and inherits the veto
   and banner rules (R-25). The engine does; the next module must too.
6. If the next phase touches portfolio state, it must replace `DEFAULT_TRADING_STATE` with a real,
   persisted snapshot — and must not weaken the kill switch to do it. Note that a real snapshot makes
   DV-10 reachable in earnest: an uninitialised or zeroed equity from a broker feed would now be refused
   rather than approved, which is the point, but the caller must handle the veto.
7. **R-27's cron entry must actually exist on the host.** The tool and the policy are shipped and tested,
   but retention only works if something schedules it; an operator who never runs it has the pre-R-27
   behaviour with extra steps.

---

## 13. The hardening pass (0.6.0 → 0.6.1)

Phase 5 shipped with three findings it had opened itself: **F-27** (the risk engine approves at zero
equity), **R-26** (the most expensive authenticated endpoint had no limit of its own) and **R-27** (the
payload column grows forever). The instruction was to close all three **before** porting another module,
and to fix F-27 in Node while leaving the legacy PHP alone until cutover. This section is that work; it
adds no route, no module and no dependency.

**+2 056 lines across 27 files** (git-measured `355a495..c5d252f`: 2 056 insertions, 139 deletions —
**code** 18 files +1 502 / −37, **docs** 9 files +554 / −102; the two new files are
`tools/prune-analysis-runs.mjs` at 198 lines and `test/retention.test.js` at 530). App suite **235 → 257**;
workspace `node:test` total **643 → 665**; legacy oracle **unchanged at 367**, which is the point — nothing
here touches PHP.

Every commit was verified green **on its own tree state**, in a separate `git worktree` with the full
suite, not only the final one — so the branch stays bisectable:

| Commit | Scope | Suite at that commit |
|---|---|---|
| `54a33df` | F-27 — the equity veto, and the pinning test inverted | **235/235** |
| `805ae1a` | R-26 — route limits, the run gate, 5 config vars | **242/242** |
| `7fd8ee5` | R-27 — retention, both adapters, the CLI, 14 tests | **256/256** |
| `2602e57` | F-28 — backup counts derived from the migrations | **257/257** |
| `c5d252f` | Docs across eight ledgers, release 0.6.1 | **257/257** |

### 13.1 F-27 → divergence DV-10

`risk-engine.js` gained one veto, placed after the data-quality checks and before sizing so the existing
reason ordering is untouched for every funded account:

```js
if (!Number.isFinite(equity) || equity <= 0) {
  reasons.push(Number.isFinite(equity)
    ? `Equity ${numberFormat(equity, 2)} is not positive — portfolio risk cannot be measured`
    : "Equity is not a finite number — portfolio risk cannot be measured");
}
```

The test that used to pin the legacy approval was **inverted**, not deleted: it now asserts the veto for
zero, negative and non-finite equity, that `reasons[0]` carries the exact string (so the veto cannot be
dropped silently), that the payload shape is unchanged (`sizing.units === 0`, `impliedLeverage === null`,
no `NaN` anywhere), that the data vetoes still precede it, and — the control that matters — that an
equity of 100 does **not** trip it.

Why this is safe to diverge on: no legacy case exercises it. `tests/cases/04-risk-engine.php` uses equity
100 and 10 000, so all 8 ported cases pass unchanged and the §4.1 parity stays at 36 of 38. The oracle
still reports 367/367 because the PHP was not edited.

### 13.2 R-26 → per-route limits plus a per-session concurrency cap

Two mechanisms, because they answer different questions.

*Window limits* ride the platform's existing per-route limiter (`config.rateLimit` on the route, keyed
`route:<path>:<client>`, checked after routing and **before** body validation and preHandlers). That
ordering is a property, not an accident: a malformed body still costs budget, so the contract cannot be
hammered for free. `POST /analysis/run` gets 12/10 min, `POST /analysis/consensus` gets 4/10 min — tighter
because one scan is up to ten runs. Both answer `429 RATE_LIMITED` with `Retry-After`.

*Concurrency* is new: `createAnalysisRunGate({tracker, max, keyOf})` in `analysis/routes.js`, exported so
it is unit-testable without HTTP, reusing the platform's existing `createConcurrencyTracker` (the same
instance that backs `MAX_REQUESTS_PER_CLIENT`, with namespaced keys so the two never collide). Both POST
handlers take a slot and release it in `finally` — a run that throws must give the slot back, or one
provider 503 would lock a session out of the endpoint until the process restarted.

Three design decisions worth recording:

1. **Keyed by session, not address.** A shared office NAT must not let one colleague's long scan starve
   another's — the same reasoning that keeps login lockout per account. Unauthenticated requests fall back
   to the address so the key stays total, though both routes authenticate first.
2. **`429 TOO_MANY_CONCURRENT_ANALYSES`, not `RATE_LIMITED`.** The remedy differs ("wait for the run you
   already started" vs "slow down"), and a client that cannot tell them apart cannot back off correctly.
3. **`0` disables, never refuses everything** — matching `MAX_REQUESTS_PER_CLIENT`. A non-finite or
   negative max also disables, and a gate with no tracker is inert, so forgetting the config yields "off"
   rather than an outage.

Worst case per window falls from 120 requests/min × up to 80 calls to **≤ 416 upstream series**
(12 runs × 8 + 4 scans × 10 symbols × 8), pinned by a test so a careless edit to a default is caught.
`GET /api/v1/system/routes` now reports `rateLimited: true` for both POSTs and `false` for the three GETs.

### 13.3 R-27 → retention policy, prune tool, and one new contract method

* `ANALYSIS_RETENTION_DAYS` (default **90**, `0` = keep forever) in `config.analysis.retentionDays`.
  Only the *policy* is configurable; batch size is a code constant with a CLI override, because it is about
  lock duration rather than about what to keep.
* `pruneAnalysisRuns(beforeIso, {dryRun, batchSize, maxBatches})` on **both** adapters — repository
  contract **35 → 36**, enforced at boot by `assertRepositoryContract`.
  * MySQL measures with one aggregate query (`COUNT(*)`, `MIN`/`MAX(completed_at)`,
    `SUM(LENGTH(payload))`) and then deletes in clamped batches (default 500, ceiling 5 000) with
    `ORDER BY completed_at ASC` — `DELETE … LIMIT` without an order is non-deterministic, and
    statement-based replication logs that as unsafe. It reports `exhausted: false` if the batch ceiling is
    reached with rows still matching, rather than implying the job finished.
  * The file adapter deletes row-by-row through the log's **existing** `delete` op instead of adding a
    "prune" op: the write-ahead log is replayed on every boot and rewritten by `compact()`, so a new op
    would have to be understood by both and would make older logs unreadable. A test reopens the store from
    disk to prove the deletions replay instead of resurrecting rows.
  * Both share one cutoff guard, `assertIsoCutoff` in `persistence/contract.js`. `completed_at` is
    `VARCHAR(32)` compared as **text**, so a `+00:00` offset cutoff would sort differently from the `Z`
    form of the same instant and silently delete the wrong rows. Anything non-canonical is refused before
    a query runs — migration 005 already warned about this; now the code enforces it.
* `tools/prune-analysis-runs.mjs` (198 lines) + `npm run prune:analysis`. **Dry run is the default**,
  because what it deletes is evidence: it reports the matching count, the oldest and newest affected
  timestamps and the reclaimable bytes, then tells the operator to take a backup. `--apply` deletes,
  `--days` overrides the policy, `--batch` tunes lock duration, `--now` fixes the clock for tests, `--json`
  prints exactly one document (including on failure, so cron logs stay parseable). Exit 1 on refusal, and
  the usage line goes to **stderr** so stdout never mixes prose into a JSON stream.
* `ANALYSIS_RETENTION_DAYS=0` with `--apply` still deletes nothing and says why. Reading `0` as
  `now - 0` would mean "delete every run ever written", which is the one misreading this tool must not
  permit; an operator who wants a one-off cut passes `--days N` explicitly.
* **No HTTP route can delete analysis history.** A test registers the module against a recorder and asserts
  the route list contains no `DELETE` verb at all. A session-scoped API with a delete verb over the audit
  copy of what a user was shown is not a trade worth making.

### 13.4 F-28, found while implementing R-27

A prune that changes row counts is only safe if an operator can prove counts before and after — which led
straight into `tools/backup.mjs`. Its MySQL row counts came from a hardcoded table list that had drifted in
both directions: it omitted `wf_contact_inquiries` (Phase 3), `wf_data_imports` and `wf_analysis_runs`
(Phase 5), and it counted **`wf_user_files`, which nothing in this repository creates or references**
(avatars live in `wf_user_profiles.profile_image`). On MySQL, `SELECT COUNT(*) FROM wf_user_files` throws
`ER_NO_SUCH_TABLE`, so `npm run backup` **failed outright** on the adapter production actually uses.

No test caught it: the backup suite drives the file adapter only, and this sandbox has no MySQL. The dump
itself is whole-database, so no *data* was ever lost — but `snapshot.json` is what an operator compares
around a restore, and three tables were silently uncounted while a fourth guaranteed failure.

Fixed by deriving the list from `src/db/migrations/*.sql` (`tablesFromMigrations()`), which makes the drift
impossible by construction, only accepts names matching `wf_[a-z_]+` before interpolating them into a
`COUNT`, and reports a missing table as "the migration that creates it has not been applied". A pin test
asserts the derived list is exactly the 12 tables the migrations create, that every file-store collection
has a counted counterpart, and that the phantom stays out.

### 13.5 What the hardening pass did **not** do

* **No legacy PHP was modified**, so the oracle is still 367/367 and F-26 (no value-for-value PHP↔Node
  numeric diff) is still open — DV-10 must appear in that diff as an *expected* difference when it happens.
* **No MySQL was executed.** The prune statements, their bound values and the batching loop are pinned as
  text and call sequences against a fake pool. F-15 stays re-widened: migration 005, the upsert, the
  DECIMAL conversion **and now the batched `DELETE … ORDER BY … LIMIT`** have never run on a real server.
* **The retention cron does not exist on any host.** The tool and policy are shipped and tested; scheduling
  them is §12 entry criterion 7.
* **No load test.** The R-26 limits are proven to fire and to release, not measured against a real provider
  under real concurrency — this sandbox has no egress, so any such number would be invented.
