# Phase 11 — Research-only portfolio optimization

**Date:** 2026-10-11 · **Branch:** `arena/8de8de2e-ai` · **Status:** ported (API only); the console screen and saved reports are not part of this phase

## Scope

Row 9 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md): the research-only
portfolio optimizer. `portfolioOptimizer` is a new key in `MODULE_STATUS`, taking
the ledger to **9 ported / 2 partial / 5 not-ported** across **16** modules.

Ported from:

| Legacy source | Node target |
|---|---|
| `Aegis\Optimization\PortfolioOptimizer` (501 lines) | `src/modules/portfolio/optimizer.js` — the pure numeric core |
| `Aegis\Platform::optimizePortfolio()` (`Platform.php:187`) | `src/modules/portfolio/service.js` — orchestration |
| `Aegis\Platform::portfolioPeriodsPerYear()` (`Platform.php:296`) | `portfolioPeriodsPerYear()` in the same service |
| `POST /api/portfolio/optimize` (`Api_portfolio::optimize`) | `POST /api/v1/portfolio/optimize` |
| `Portfolio::index` + `views/portfolio/optimizer.php` | **not ported** (app-shell work, row 3) |

No migration, no contract method and no new table: the optimizer is pure
computation over fetched price history. It records its runs in the **existing**
`wf_audit_events` trail through `store.recordAudit`, so it adds no storage surface
and no retention question of its own.

## What it does

Estimates annualized arithmetic returns and a sample covariance from close-to-close
observations aligned on the timestamps **every** asset shares, applies diagonal
covariance shrinkage plus a numerical ridge, then solves two programs under a
fully-invested, long-only, per-asset weight cap:

- **minimum variance** — a convex QP, projected gradient with a Lipschitz-derived
  step (`1/L`, `L = 2·maxᵢ Σⱼ|Σᵢⱼ|`), so every iterate is feasible and the answer
  is feasible even if the iteration limit is hit first;
- **maximum Sharpe** — non-convex, deterministic multi-start projected ascent with
  backtracking line search. Starts are equal weights, the minimum-variance point,
  and one capped corner per asset: `n + 2` starts, nothing random, so two runs of
  one input produce identical weights to the bit.

The projection onto `{w: Σw = 1, 0 ≤ wᵢ ≤ cap}` is bisection (90 halvings) plus a
residue sweep that only ever moves a weight *within* its box.

The report publishes four allocations (selected, minimum variance, maximum Sharpe,
equal-weight benchmark), per-asset rows, the correlation matrix, the constraints,
the estimation method, the request echo, per-asset provenance and a warning list.

**It never places or sizes an order.** That is structural, not a comment: the
service is constructed with `{store, marketData, log}` and is not given the paper
service, the strategy registry or the execution supervisor, so there is no
reference path from this module to an order. The body schema cannot express one
either — `additionalProperties: false` makes `execute`, `amount`, `orderId`,
`accountId` and `notional` a 400 at both the top level and inside an asset, and a
test asserts each by name.

## Divergences

| # | Divergence | Reason |
|---|---|---|
| **PO-1** | The simplex projection keeps the legacy bisection + residue sweep instead of the closed-form median-based water filling | The two are not bit-identical. A research number that differs from the legacy number in the tenth decimal is a support ticket nobody can diagnose, so the slower algorithm that reproduces the old one wins |
| **PO-2** | Estimation failures (`OptimizationUnavailableError`) answer **422**; input-shape failures (`InvalidOptimizationError`) answer **400** | Legacy used `\InvalidArgumentException` for both, so "your prices produced a non-finite return" came back as 400 — a status that tells the caller to fix the request, when nothing about the request was wrong. 422 is the status the legacy controller already used for its `\RuntimeException` branch |
| **PO-3** | An unsupported `marketClass` is refused before any provider call | Legacy validated the timeframe up front but let a bad class fall through to `getCandleSeries`, so a typo surfaced as an outage. Asserted both ways: bad class *first* costs zero provider calls, bad class *second* costs exactly the one preceding fetch (per-asset validation in encounter order, as legacy did) |
| **PO-4** | `assets` is bounded by the schema (`minItems`/`maxItems`) as well as by the service | Legacy checked the count twice with the same numbers; declaring it once means a fourteen-asset body is refused before it is parsed |
| **PO-5** | The path is `/api/v1/portfolio/optimize`, with no alias for the legacy unversioned `/api/portfolio/optimize` | Consistent with the whole versioned API. No alias, because nothing consumes the legacy path yet and an alias would imply otherwise. A test asserts the old path does not answer 200 |
| **PO-6** | The `/portfolio/` prefix is now shared by two modules: this optimizer and the paper module's pre-existing `GET /portfolio/risk-scan` (Phase 7) | Recorded rather than silently re-homed — moving the paper route would break a shipped path. They are different concerns that happen to share a word: one is research over a requested universe, the other is risk over open paper positions |
| **PO-7** | `computedAt` is `new Date().toISOString()` (`…Z`) rather than PHP `gmdate('c')` (`…+00:00`) | Same instant, and `…Z` matches every other timestamp this platform emits, including the audit trail's canonical-UTC rule from Phase 10 (AV-2) |

## Safety properties

**The synthetic-data gates are the honesty core, and both are asserted over HTTP.**
A universe that is *entirely* synthetic is refused with 422 unless the caller passes
`allowSyntheticData: true` — a strict boolean, so `"true"` and `1` from a form post
do not unlock a simulation — and an opted-in run still carries a warning beginning
`SIMULATION:`. A universe that *mixes* synthetic and live series is refused with no
flag that can unlock it, because a covariance computed across one real and one
generated series describes neither and no label could make the number meaningful.
On a host with `MARKET_DATA_ALLOW_SYNTHETIC=0` and no real providers, the answer is
**503 `SYNTHETIC_DATA_DISABLED`** with a positive `Retry-After` — a different code
from the 422, because the remedy is a host configuration change rather than a
request edit.

**Annualization is inferred only for a single market calendar.** Crypto trades 365
days, forex and listed equities roughly 252, an intraday equity bar approximates a
6.5-hour session. A universe spanning classes has no one correct answer, so the
caller must state `periodsPerYear` explicitly rather than be handed a number that
is wrong for every asset in it. Refusing is the honest outcome; averaging the
calendars would not be.

**Provenance is per asset and never summarized away.** A reader can see that
`BTCUSDT` came from a synthetic generator while `EURUSD` did not. Stale series and
history gaps are each disclosed by symbol. The correlation matrix is reported from
the **unshrunk sample** covariance, because shrinkage is a regularization device
for the solver and reporting shrunk correlations would understate how correlated the
sample actually was.

**Cost control (risk R-26), applied at birth.** One optimization fetches up to
twelve series and then solves two iterative programs over a 12×12 covariance, so it
carries its own window limit *and* a per-session in-flight cap (default 1, keyed by
session rather than address so a shared office NAT cannot let one colleague starve
another's). Assets are fetched **sequentially**, not in parallel: the per-session
cap bounds how many optimizations run at once, and sequential fetching bounds the
provider calls within one. A test pins that the slot is released on failure, so one
refused run cannot lock a session out until the process restarts — and a separate
test pins that the window limit is charged **before** validation, so a caller
sending garbage does not get unlimited free requests just because the garbage never
reaches the provider chain.

## Defect found in shared infrastructure (D-15)

**`src/http/validate.js` threw a `TypeError` on any object-typed array item, which
surfaced as a 500.** The array branch forced `required: true` onto the item schema
to mark the item mandatory; the object branch then read `schema.required` as the
list of mandatory *keys* and called `.includes()` on that boolean.

This was **latent, not live**: every `items` node in the platform was a string
(`analysis/contracts.js` consensus symbols) until this phase declared the first
object-typed one, so no shipped route could reach it. It is fixed rather than
worked around, because the next nested-object schema would have hit the same 500,
and a validator that crashes on a valid schema shape is worse than one that
rejects it.

The fix separates the two meanings of `required`: a boolean answers "is this value
itself mandatory", an array answers "which of my keys are". Object items no longer
receive the forced boolean, and their mandatory keys are still enforced from their
own `required` array. Verified against eight shapes — valid body, valid with
options, `null` item, item missing `symbol`, item missing `marketClass`, unknown
item key, too-few items, no `assets` — and by the **full 582-test suite**, since
`validate.js` is shared by every route in the platform.

Two further defects were found by this phase's own tests and fixed before the
record was written, rather than relaxing the assertions:

- **D-16.** Three locals in `optimizePortfolio` shadowed the module-level solver
  functions of the same name (`commonTimestamps`, `minimumVarianceWeights`,
  `maximumSharpeWeights`), so `const f = f(...)` was a `ReferenceError` at runtime.
  `node --check` cannot see this — it is a temporal-dead-zone error, not a syntax
  error — and it took down 18 of 19 tests at once. Locals renamed.
- **D-17.** The service called `marketData.getCandleSeries(...)`, which exists on
  the market-data **manager** but not on the market-data **service** every other
  module consumes, so every request 503'd as "no provider chain configured" on a
  host that had one. Switched to `marketData.candles({...})`, the house seam used by
  analysis, Strategy Lab and paper, which delegates to the same manager method and
  returns the identical `{candles, provenance, validation}` shape while also
  applying the symbol floor and market-class inference.

## Verification

Measured in this sandbox on 2026-10-11, Node v22.22.3:

- `npm test` (workforce-platform): **582 passed, 0 failed** — up from 532. **50**
  new tests across three files: `test/portfolio_optimizer.test.js` (**19**),
  `test/portfolio_service.test.js` (**18**), `test/portfolio_http.test.js` (**13**).
- `npm run verify:install`: **29/29**, **67** documented config variables (was 64;
  this phase adds the three portfolio rate-limit variables to `.env.example`). No
  new migration, so the migration check still reports `store requires 9`.
- Legacy PHP oracle (`node runtime/run-tests.mjs`): **367 passed, 0 failed**.
  `git status --porcelain` reports **0** modified paths under `application/`,
  `system/` or `tests/`.
- Route count **79 → 80**; admin routes unchanged at **7**. `/api/v1/system/features`
  `ported` **8 → 9**, `partial` **2**, `not-ported` **5**, modules **15 → 16**.
- Repository contract stays at **78 methods**; migrations stay at **001–009**.

What the numeric tests actually assert, rather than reproducing a number: every
published allocation satisfies the constraints the report advertises (fully
invested within 1e-9, long-only, within the cap) including the degenerate
zero-variance case; minimum variance beats equal weight on volatility **and**
favours the calmer of two assets; maximum Sharpe beats equal weight on the sample
it was given; a cap below the concentration the optimum wants is respected and the
best asset sits at it; the same input produces the same weights **exactly**
(`deepEqual`, not a tolerance, so a future nondeterminism source cannot hide); a
flat series yields the analytically derivable ridge artifact
`sqrt(EPSILON·252)/√2 ≈ 1.581e-5` rather than `NaN`; and the 12-asset maximum
universe completes inside the iteration budget.

Ledger assertions updated because the counts they pin genuinely changed: ported
**8 → 9** and modules **15 → 16** (`platform_findings`), plus three new label
regexes requiring the `portfolioOptimizer` label to keep saying `research-only`,
`no console screen` and `no saved reports`, so `ported` cannot be read as a
finished workstream.

### Not exercised, and therefore not claimed

- **No real market data.** Every HTTP test runs with `MARKET_DATA_REAL_PROVIDERS=0`
  and `MARKET_DATA_ALLOW_SYNTHETIC=1`, so the endpoint has only ever been exercised
  against the synthetic provider. No claim is made that a licensed feed produces a
  well-conditioned covariance, and the **provider gaps in row 6 are unchanged**:
  licensed stock/ETF/futures/options data and the fundamentals, on-chain and
  options-sentiment feeds are still absent. Optimizing an equity universe therefore
  has no real data source to draw on yet.
- **No real MySQL/MariaDB.** This phase writes only to the existing audit table, so
  **F-15 is unchanged** and it adds no new SQL — but nothing here has been exercised
  against a server either.
- **No console screen.** `views/portfolio/optimizer.php` and `Portfolio::index` are
  not ported; **F-29 still stands** — no ported module has a workspace console, and
  this phase adds a third API with no screen (after notifications and the audit
  browser). *(Updated by Phase 27: this screen is ported at
  `/app/portfolio/optimizer`, and it was the third and last of these three APIs to
  get one — see [`PHASE27_CONSOLE_SCREENS.md`](PHASE27_CONSOLE_SCREENS.md).)*
- **No saved reports.** A run is computed and returned, never persisted. There is
  no history endpoint, so a caller cannot read back what the platform told them
  last week — only the audit event records that a run happened, with its objective,
  universe and selected weights.
- **No numerical parity check against the PHP implementation.** The two were ported
  instruction-for-instruction and the constraints are asserted, but no test runs the
  same candles through both engines and compares weights. **F-26 stands**, and this
  is the module where it bites hardest: PO-1 exists precisely to keep the numbers
  aligned, and nothing currently verifies that they are.
- **No live trading path, by construction and unchanged.** Live trading remains
  disabled by default; this module cannot reach an order even if it were enabled.
- **No load measurement.** The 12-asset case is asserted to finish inside a generous
  bound (20 s) on two cores, which is a guard against a future change making the
  inner loop quadratic, not a performance benchmark.

## Next

Row 9 is now ported. The unchanged dependency-order gates still come first:
validate migrations **001–009** and repository transactions against real
MySQL/MariaDB (**F-15**), then rehearse cPanel/Passenger deployment,
backup/restore and rollback on the actual host.

After that, the largest remaining gaps are row 3 (every console screen — now three
APIs with nothing to render them), row 5's remainder (settings screens and one
retention policy covering audit, notifications, R-27 and R-28), and row 6's
provider gaps, which are what stop this module from optimizing a real equity
universe.
