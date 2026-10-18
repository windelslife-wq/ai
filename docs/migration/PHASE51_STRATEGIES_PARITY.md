# Phase 51 — F-26 for the Strategy Lab: backtest engine + metrics + journal analytics diffed exact (F-48 recorded)

**Date:** 2026-10-17 · **Branch:** `arena/d57504c6-ai` · **Version:** 0.27.0

Second strategies-side slice of finding F-26, closing row 8's "not a full
PHP↔Node numeric parity sign-off" caveat from Phase 6. The analysis slice
(Phase 50) set the pattern; this phase pushes it through the heaviest engine
in the Strategy Lab — the whole backtester, through all four built-in
strategies, end to end.

## What closes, and what stays open

- **Closed for this slice:** `Aegis\Backtest\Backtester::simulate` (SeriesView
  look-ahead-proof windows, next-open fills, pessimistic intrabar stop-first,
  fees/spread/slippage accrual, mark-to-market equity, end-of-data flat) run
  against every built-in strategy; `Aegis\Backtest\Metrics` (`compute`,
  `sharpe`, `sortino`); `Aegis\Journal\Analytics` (`bucketMetrics`, `analyze`,
  `calibration`, en-dash bucket keys and both verbatim verdict strings).
- **Still standing under F-26, by name:** the **strategy optimizer** grid
  search (`Aegis\Optimization\StrategyOptimizer`), the portfolio optimizer
  (`PO-1`), the analysis regime/setup/scenario layer, and the notification
  rules.

## Harness pieces

| Piece | Path |
|---|---|
| PHP generator — requires the real `Strategies`/`Backtest`/`Journal` class files; builds three market shapes per strategy by deterministic loops; stores inputs beside PHP's output | `runtime/parity/strategies-golden.php` |
| Runner | `runtime/strategies-parity.mjs` (`node runtime/strategies-parity.mjs` to regenerate) |
| Golden output | `apps/workforce-platform/test/fixtures/strategies-parity-golden.json` (**27 cases**) |
| Node verifier — replays with `strategies/{metrics,backtester,journal-analytics,builtin}.js`, exact `deepEqual` after the documented F-48 canonicalisation | `apps/workforce-platform/test/strategies_parity.test.js` (**30 tests**) |

The seven end-to-end simulations carry real signal content by construction —
the case table is the evidence:

| Case | Strategy | Trades | Purpose |
|---|---|---|---|
| trend leg (decline → rally → fade) | trend-following | LONG + SHORT | EMA cross entry into an already-elevated ADX, cross-close, short continuation |
| customized fast/slow on the channel | trend-following | 6 | parameter override parity |
| the channel | mean-reversion | 5 (shorts + longs) | bollinger/RSI reversion, shorts allowed |
| impulse, shorts **refused** | momentum | 3 LONG, **8 ignored** | the `ignoredSignals` counter and its warning sentence, verbatim |
| same impulse, shorts allowed | momentum | 3 LONG + 2 SHORT | the flag is the only difference — mirrored proof |
| squeeze → breakout | breakout | 7 | squeeze detection into the spike |
| flat series | trend-following | 0 | the empty result is arrays, not errors |

## What it found: **F-48** (recorded, not "fixed")

PHP `Backtester::iso()` is
`gmdate('Y-m-d\TH:i:s\Z') . '.' . sprintf('%03d', $ms % 1000) . 'Z'` — the mask
already carries the `Z`, so the evidence reads `2024-10-08T11:00:00Z.000Z`:
the right instant in a malformed envelope that feeds TEXT columns sorted by
`Journal\Analytics::analyze` (DV-5). The Node port keeps `toISOString()`'s
canonical form **of the same instant** — the correction is pinned
evidence-for-evidence, exactly the F-36/F-37 pattern: the test asserts the
malformed shape truly is in the golden (the finding can never shrink
silently), then canonicalises it before the otherwise exact comparison.
Recorded in `RISK_REGISTER.md` (F-48) with the cutover implication named.

Unlike the analysis slice, the first clean run needed **no code repair**:
every metric, R-multiple, fee accrual, equity point and verdict string
matched to the last double — Phase 6's ports were what it claimed.

## Verification

- `test/strategies_parity.test.js`: **30/30**.
- Full Node suite: **1 384 / 1 384** (1 354 + 30).
- `npm run verify:install`: **30/30**; PHP oracle: **367/367** (legacy tree
  read-only, as the harness requires).

## Canonical workflow note

Regenerate with `node runtime/strategies-parity.mjs` after touching either
side; never edit the fixture by hand. A case that drifts without either source
changing is the platform telling you a semantic moved — investigate it as the
next F-34/F-47/F-48.
