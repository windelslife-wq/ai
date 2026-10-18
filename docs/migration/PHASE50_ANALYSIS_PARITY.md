# Phase 50 — F-26 for the analysis module: exact PHP↔Node numeric diff (found and fixed F-47)

**Date:** 2026-10-17 · **Branch:** `arena/d57504c6-ai` · **Version:** 0.26.0

F-26 has been open for the analysis module since Phase 5: the indicator set,
`MathUtils` and the formatting verbs were "ported function-for-function" and
both suites were green, but **nothing compared the two implementations against
each other**. This phase extends the proven harness pattern to them, keeps the
same contract the sports slices set, and — also as the pattern keeps doing —
pays for itself on the first run.

## What closes, and what stays open

- **Closed for this slice:** every pure numeric policy of the analysis module —
  the 16 `Indicators` methods, the `MathUtils` helpers the analysis layer uses
  (`clamp`, `mean`, `stdev`, `hashString`, the seeded PRNG, the Box-Muller
  `gaussian`), and the PHP formatting verbs embedded in payload strings
  (`round`, `number_format`, `sprintf '%+.f'` and `'%.f'`).
- **Still standing under F-26, named so the finding is not read as retired:**
  the optimizer (numerics sit behind `PO-1` and remain un-verified), the
  regime/setup/scenario generation layer, strategy and journal metrics, and the
  notification rules. Row 7's remaining diff work is those, not this slice.

## The harness pieces (same roles as the sports slices)

| Piece | Path |
|---|---|
| PHP generator — requires the real legacy class files by path, builds every input in PHP by deterministic loops, stores each input beside PHP's own result | `runtime/parity/analysis-golden.php` |
| Runner — WASM PHP 8.2, normalizes the version banner, writes the fixture | `runtime/analysis-parity.mjs` (`node runtime/analysis-parity.mjs` to regenerate) |
| Golden output | `apps/workforce-platform/test/fixtures/analysis-parity-golden.json` (**93 cases**) |
| Node verifier — replays each case with the Node port and `assert.deepEqual`s the canonicalized JSON | `apps/workforce-platform/test/analysis_parity.test.js` (**95 tests**: 93 cases + a provenance/integrity test + a coverage test that fails if any exported policy ever goes undiffed) |

Comparison is **exact — no tolerance** — the rule every earlier slice set and
kept even through `exp()` and `sqrt()`: both sides compute on IEEE-754 doubles
in the same operation order, so a single-mismatch is a finding, not noise.

Case construction follows the sports rules: inputs are built in PHP (steps with
non-dyadic expansions sit exactly where rounding conventions disagree), stored
verbatim, and edge guards are targeted deliberately — ema period 0/1, flat
series (rsi's gain/loss-both-zero 50, stochastic's `hh == ll` 50, adx's
`tr == 0` nulls, bollinger's zero stdev at period 3), macd shorter than the
slow period, zero-volume candles for vwap and the volume-profile empty shape,
`hi !> lo` profile, monotonic candles producing no swings, regression one unit
below the window, and `last()` skipping trailing nulls.

## What it found: **F-47** (fixed in this phase)

Case `PHP round(1.005, 2)`: PHP `1.01`; Node `1`. PHP's `round()` pre-rounds to
15 significant digits, so a decimal tie rounds the way the written digit says,
while both JavaScript shortcuts round on the binary value (`1.00499…`).

Three sites carried the shortcut — all three now delegate to
`src/lib/php.js:phpRound`, the genuine algorithm the sports oracle proved in
Phase 17, so the platform keeps **one** round helper:

1. `src/modules/analysis/math.js:roundTo` — the pervasive one (agents, regime,
   risk engine, paper engine, strategies, backtester, journal analytics,
   optimizer summary). Its docblock claimed "PHP round()" and got the tie cases
   wrong.
2. `src/modules/paper/service.js` — a local `roundTo` built on
   `Number(value.toFixed(places))`; same wrong rule, different spelling.
3. `src/modules/analysis/feeds.js` — sentiment scores rounded with
   `Math.round(score * 10_000) / 10_000` where legacy writes `round($s, 4)`.

Record: `RISK_REGISTER.md` **F-47**.

## Verification

- `test/analysis_parity.test.js`: **95/95** on its first green run (the two
  failing cases *were* F-47's evidence, exact at 1 ulp).
- Full Node suite: **1 354 / 1 354** (1 259 + 95). **Zero existing expected
  values changed** — nothing had ever pinned the naive-round result, so the
  fix moves the platform toward PHP without touching any recorded behavior.
- `npm run verify:install`: **30/30**.
- PHP oracle suite: **367/367** (the legacy tree is read-only for the harness,
  as every F-26 slice requires).

## Canonical workflow note

Regenerating the golden after touching either side is a normal step —

```
node runtime/analysis-parity.mjs
```

— never edit the fixture by hand: the file's whole value is that it is PHP's
output, not a transcript of what PHP was believed to do. A case that drifts
without either source changing is the platform telling you a semantic moved;
investigate it as the next F-34/F-47.
