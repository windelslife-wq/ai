# Phase 24 — Lottery Intelligence: the Strategy Lab, model versions and measured performance (row 15, slice 4)

> **Status: landed on `arena/653d6218-ai`.** This record covers slice 4: the no-look-ahead
> backtester (`LotteryBacktester`, 192 legacy lines, ported whole), model versioning (spec §33),
> the persisted backtest surface and the performance overview (spec §30) — migration **019** and
> the six routes legacy's `Api_lottery` declares for them. It does **not** cover the lottery cron
> or the console screens. The previous record is
> [`PHASE23_LOTTERY_TICKETS.md`](PHASE23_LOTTERY_TICKETS.md).

## 1. What this phase is

The measured half of row 15. A STRATEGY is a deterministic line-generation rule replayed against
historical draws **without look-ahead**: for test draw i the strategy only sees draws 1..i-1.
Four seeded strategies — RANDOM_BASELINE (the mandatory baseline, spec §25), BALANCED_PROFILE,
HISTORICAL_FREQ and ANTI_POPULAR — each generating its lines through the slice-2 generator with a
per-test-draw seed mixed from CRC-32 of the strategy name, the draw index and the model version.

The honesty contract is the spec's, carried into every report: labelled **HISTORICAL
SIMULATION**; simulated cost and winnings stay **NULL** with their notes while official line
pricing and prize amounts are unavailable — nothing is fabricated; comparisons run every strategy
on the SAME period and declare no strategy "better" (spec §34). The differential golden pins
`run` and `compare` to PHP byte-for-byte, including the seeds.

## 2. What was ported

Migration **019** adds `wf_lottery_backtests` and `wf_lottery_model_versions` (schema now **54**),
taking the repository contract to **185** methods (**41** lottery) on both adapters and the route
inventory to **146** of which **31** are lottery (19 `lottery.view` reads, 8 `lottery.view` POSTs,
3 `lottery.manage` writes, 1 status read). Ported:

- **backtest / backtestCompare** (spec §23/§24) — engine over `lotteryDrawsForStats`, persisted
  under the strategy name or the COMPARISON stamp, audited (`lottery.backtest.run`), returned
  with `saved.backtestId`. Refusals are legacy's strings at the 400 layer: unknown strategy,
  `backtesting needs at least 11 stored draws (got N)`, `the random baseline must be part of
  every comparison (spec §25)`, `at least one strategy is required`.
- **Model versioning** (spec §33) — `ensureLotteryModelVersion` returns the FIRST row on an
  existing (model_name, model_version) pair and never deletes or replaces rows; the config JSON
  records the analyzer weights, generator modes and the backtester constants. `GET
  /lottery/models` lists oldest first.
- **listBacktests / backtestDetail** — newest first, report JSON decoded on read, legacy's
  clamp min(500, max(1, limit)); detail refuses rows of another lottery code.
- **performance** (spec §30) — ACTUAL ticket results, HISTORICAL backtest results and
  DEMO/SANDBOX data as three separate sections that are never mixed; tiers only, amounts never.

The whole measured half sits behind **`lottery.view`** — legacy's own split (analysis records are
not managed ingestion), pinned by a viewer-only-user HTTP test.

## 3. What the parity record caught

Two golden facts shaped the port, both PHP's own output and both kept:

- **Distribution shapes are arrays.** PHP declares the match distributions with sequential
  0-based keys, so `json_encode` emits JSON **lists** (`"mains": [3,7,0,0,0,0]`) — the port
  matches, while `tierCounts` (string-keyed) stays an object, and an EMPTY `ksort`ed PHP array
  emits `[]`, which the empty tier map reproduces.
- **F-45 (new finding): the tier rank is `substr($tier, 5, 1)`.** The best-line tracker reads the
  FIRST character after `TIER_` — so `TIER_10 (2 stars)` is treated as **rank 1**, the best, when
  the tracker sees it. Legacy's behaviour, kept byte-for-byte and pinned in the golden
  (`rankOf`); a "fix" would be a deliberate, documented divergence.

One genuine port bug was caught on the way by the HTTP tests and fixed before landing: the
tier-sort used `Object.fromEntries` on keys instead of entries (an `Iterator value … is not an
entry object` TypeError on any report with a prize hit — the first parity cases had no hits, so
the golden alone did not catch it).

## 4. What this phase does not claim

No MySQL server was exercised: migrations 016–019 are not applied to any real database and the
SQL repository is proven against a recording executor (F-15). Nothing is deployed. Backtests ran
only against seeded synthetic histories and file-store draws; no official provider was contacted.
A backtest report is a HISTORICAL SIMULATION record — it never executes, purchases or prices
anything, and the performance overview mixes none of its sections.

## 5. Decisions

- **No new DV**: the slice introduces no operator-visible divergence beyond the standing list.
  F-45 is recorded as a finding, not changed behaviour. The lowercased audit action
  (`lottery.backtest.run` vs legacy's `LOTTERY_BACKTEST_RUN`) is the slice-1 divergence, kept
  consistent.
- **The `?:` cast is the route's** — `(int)($body['lines'] ?: 1)` means 0/null/missing all
  become 1; the port keeps that at the route layer and `compare`'s top-level `linesPerDraw`
  reports the argument AS GIVEN, exactly as legacy does.

## 6. Gates

| Gate | Result |
| --- | --- |
| `npm run check` (`verify:install` + full suite) | exit 0 — 961/961 tests, 65 files, 29/29 install checks |
| PHP/WASM oracle (`node runtime/run-tests.mjs`) | 367 passed, 0 failed |
| Legacy tree (`application/`, `system/`, `tests/`) | byte-identical, 0 changes |
| Differential lottery golden | **137 cases** (+15 backtests: constants, seeds, 4 full reports, the clamps, 4 refusals, the comparison, rankOf) |
| Version | 0.21.0 |
