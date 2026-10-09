# Phase 5 — Market analysis, agents, consensus and the risk veto gate (2026-10-09)

**Status: complete in the sandbox, not accepted as the production replacement.** The legacy
application stays authoritative and deployable; nothing here cuts over traffic, changes production
data, enables live trading or deletes legacy code (master plan §11, §13).

| | |
|---|---|
| App version | `@windels/workforce-platform` **0.5.0 → 0.6.0** |
| New source | **3 369 lines** — `src/modules/analysis/**` (1 854) + `src/modules/analysis/agents/**` (1 331) + `src/db/analysis-repository.js`, `src/db/migrations/005_analysis_runs.sql`, `src/modules/market-data/errors.js` (184) |
| New tests | **2 178 lines, 95 tests** — `test/analysis.test.js` (71, pure layer) + `test/analysis_http.test.js` (24, engine/HTTP/persistence/status) |
| App suite | **235 tests / 15 files, 235 passed, 0 failed** (~36 s) |
| Installation checks | `npm run verify:install` **30/30** (53 documented env vars — unchanged; this phase adds no configuration) |
| Legacy oracle | `node runtime/run-tests.mjs` **367 passed, 0 failed** in 19.3 s (PHP 8 in WASM; no native `php` here) |
| Typecheck | `tsc --noEmit -p tsconfig.json` clean |
| Egress | 235/235 both with and without `--import /tmp/egress-shim.mjs` (a whole-suite fetch interceptor that fails any non-loopback call) — **no test in this phase can reach the network** |
| Routes | 33 → **38** API routes; 22 document routes unchanged |
| Repository contract | 32 → **35** methods; migrations 001–004 → **001–005** |
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
* **`src/persistence/contract.js`** 32 → 35; **`src/persistence/file-store.js`** gains an `analysisRuns`
  table plus the three methods; **`src/db/store.js`** requires migrations 001–005.
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

```
node --test test/*.test.js                     → 235 tests, 235 pass, 0 fail  (~36 s, 15 files)
node --test test/analysis.test.js              →  71 tests,  71 pass, 0 fail
node --test test/analysis_http.test.js         →  24 tests,  24 pass, 0 fail
node --test test/market_data.test.js           →  37 tests,  37 pass, 0 fail  (after the errors.js extraction)
npm run verify:install                         →  30/30 checks, 53 env vars documented
node runtime/run-tests.mjs                     →  367 passed, 0 failed in 19.3 s  (legacy PHP/WASM oracle)
tsc --noEmit -p tsconfig.json                  →  clean
node --test --import /tmp/egress-shim.mjs …    →  235/235  (no outbound call is possible)
```

Five consecutive full-suite runs and two runs under CPU contention (two suites at once on 2 cores)
passed with zero failures; every run after the regime coverage was added passed 235/235.

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

| # | Legacy | Node | Why |
|---|---|---|---|
| D-1 | `AgentDebate::advocateCases()` filters signals on lowercase `'bullish'`/`'bearish'` while `TechnicalAgent` emits `'BUY'`/`'SELL'` | **Ported as-is**, and pinned by a test | Signal-derived claims therefore never appear in a real debate; only vote-derived ones (`|score| ≥ 0.25`, sliced to 6) do. Fixing it would change every verdict, so it is recorded rather than repaired |
| D-2 | Conflict count derived from a keyed map | Counted as the array length | Same number for the legacy fixtures; the array is what the payload carries |
| D-3 | `GET /api/agents/consensus` | `POST /api/v1/analysis/consensus` | The legacy answered a GET that wrote one run and one audit row per symbol. A scan of up to 10 symbols is a mutation, so it is a POST with CSRF |
| D-4 | Unsupported timeframe coerced/ignored | `400` from the contract | Consensus accepts the narrower `15m/1h/4h/1d`; a run accepts the full market-data vocabulary. Coercion would silently analyse the wrong interval |
| D-5 | `marketClass` inferred on the run route | Required in the body | The class decides whether 7 extra reference legs are fetched; inferring it hides the cost from the caller |
| D-6 | `/api/agents*` paths | `/api/v1/analysis/*`, no alias | One origin, one vocabulary (master plan §5). The ledger in `ROUTE_MAP.md` §7.3 records the mapping |
| D-7 | History limit unbounded | Bounded 1–100, `400` outside it | A payload-carrying table must not be listable without a bound |
| D-8 | Run id from the legacy id generator | `crypto.randomUUID()` (`CHAR(36)`) | The column type matches; ids are opaque to callers |
| D-9 | MySQL insert-or-update per adapter | One `ON DUPLICATE KEY UPDATE` upsert | Re-running a symbol must not duplicate a row; both adapters now agree (pinned by a test) |

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

**Inherited, not repaired:** see F-27 in §10 — the legacy risk engine approves a proposal when equity is
`0`, because every portfolio gate sits behind `equity > 0`.

---

## 7. Configuration

**This phase adds no environment variables and no configuration keys.** `npm run verify:install` still
reports 53 documented variables, and the check that every `env.*` read by `src/config.js` appears in
`.env.example` still passes.

The analysis module reads its behaviour from code constants, deliberately: agent weights, the vote
threshold, the candle limit and the risk limits are **safety parameters**, not deployment knobs, and
turning them into environment variables would let a host silently weaken a veto.

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
* **Rate limiting.** No per-route limit; the global API limiter (`api:<client>`, 120/60 s) applies before
  routing. This is the platform's most expensive authenticated endpoint — a run is up to 8 provider calls,
  a consensus scan up to 80 — so the exposure is recorded as **R-26** rather than silently accepted.
* **Input handling.** Bodies are schema-validated with `additionalProperties: false`, so an undeclared key
  cannot reach the engine or a repository as an implicit filter. `limit` is bounded twice (contract 1–100
  and the service clamp). `:runId` is constrained to `[A-Za-z0-9_-]{1,64}` — a malformed id is a `400`,
  and only a well-formed unknown id is a `404`, so the route cannot be used to probe id shapes.
* **Injection.** Every analysis query is parameterised; the only interpolated value is a bounded `LIMIT`.
* **Information disclosure.** A provider outage answers `503` with the platform-wide contract and keeps the
  provider's own message in `error.details.reason`; no host, port, key or stack is echoed. Audit rows record
  a *hash-free* summary (symbol, timeframe, bias, confidence, legacy action) and never the payload.
* **Data-at-rest.** `wf_analysis_runs.payload` holds a full run including provenance. It is analysis output,
  not personal data, but it grows without a retention policy — recorded as **R-27**.
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
   in Phase 4. The vite build is byte-identical to Phase 3.
7. **Not run here:** MT5 `pytest` (9 cases, needs its own Python 3.11 venv), browser/Lighthouse checks,
   real SMTP, cPanel/Passenger deployment.

---

## 10. Findings after this phase

* **F-27 (new, 🟡 medium) — the legacy risk engine approves a proposal when equity is `0`.** Every
  portfolio gate sits behind `equity > 0`, so with zero equity the notional and leverage checks clear
  trivially (0 ≤ cap) and `evaluate()` returns `approved: true`. Ported faithfully and pinned by a test
  rather than repaired, because changing it would diverge from the legacy oracle. It is **unreachable from
  the analysis path** (the default state carries 10 000 paper equity and the kill switch vetoes first), but
  it is a live hazard for the broker/execution/paper-trading ports, which must not inherit it silently.
* **R-26 (new, 🟠 high) — analysis is the most expensive authenticated endpoint.** A run performs up to 8
  provider calls (1 symbol + 7 reference legs) and a consensus scan up to 80, bounded only by the global
  120/min limiter. On a host with real providers that is an amplification path: one authenticated request
  can fan out into ten upstream ones. Recommended before cutover: a per-route limit on
  `POST /analysis/consensus` and a per-session concurrency cap on runs.
* **R-27 (new, 🟡 medium) — `wf_analysis_runs.payload` grows without a retention policy.** Each row stores
  a full run (agents, transcript, scenarios, setup, risk decision, provenance) as `LONGTEXT`. Nothing prunes
  it. Recommended: a retention window and a `tools/` prune command before this table is written in
  production.
* **F-24, F-25, F-26** unchanged (per-process provider health/breakers/caches; CI never calls a real
  provider; ported numerics not diffed against PHP).
* Still open from earlier phases: **F-11, F-12, F-15 (narrowed), F-16, F-18**.

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
   list over the 7-symbol default watchlist, and expect a forex run to be ~8× a crypto run.
4. **No new env vars, no new secrets, no new cron.** Nothing to add to `.env` on the host; `verify:install`
   is unchanged at 30/30 and 53 documented variables.
5. **Do not release the kill switch from a config file.** There is no ported control surface for it, and
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
3. **F-27 is resolved deliberately** — either the zero-equity approval is fixed in both codebases with the
   oracle updated, or it is accepted in writing with the reason. A paper-trading port must not inherit it
   by accident.
4. **R-26 has an answer**: a per-route limit or concurrency cap on the analysis endpoints, decided and
   measured, before they are exposed to real users on a host with real providers.
5. Any consumer of a run carries `provenance.synthetic` forward into its own payload and inherits the veto
   and banner rules (R-25). The engine does; the next module must too.
6. If the next phase touches portfolio state, it must replace `DEFAULT_TRADING_STATE` with a real,
   persisted snapshot — and must not weaken the kill switch to do it.
