# Phase 22 — Lottery Intelligence: the combination engines (row 15, slice 2)

> **Status: landed on `arena/653d6218-ai`.** This record covers slice 2: the four combination
> engines — `CombinationAnalyzer`, `CombinationGenerator` (all five modes), `DiversificationEngine`
> and `SystemBuilder` — their persistence (migration **017**), and the nine routes legacy's
> `Api_lottery` declares for them. It does **not** cover tickets, backtests, model versions, the
> lottery cron or the console screens. The previous record is
> [`PHASE21_LOTTERY_FOUNDATION.md`](PHASE21_LOTTERY_FOUNDATION.md).

## 1. What this phase is

Slice 1 built the lottery's data foundation and proved the provider boundary against PHP. Slice 2
builds the intelligence ON that foundation — the reason the module exists: generating candidate
lines (RANDOM / BALANCED / HISTORICAL / DIVERSIFIED / ANTI-POPULAR), profiling one line against
stored history, scoring how different a set of lines is from itself, and expanding a pool into a
full system whose line count is **computed as C(N,5) × C(S,2), never hardcoded**. Every output
carries legacy's honesty contract verbatim: balance scores and diversity scores are STATISTICAL
descriptions, never probabilities; the decision report records the ACTUAL inputs (mode, seed,
locks, excludes, rules version, dataset version) — never invented after the fact; and no column,
row or response in this slice names a stake, a price or a payout (`estimatedCost` is null by
design, with legacy's "no cost is fabricated" note).

## 2. What was ported

| Legacy source (lines) | Node home |
|---|---|
| `CombinationAnalyzer.php` (218) | `src/modules/lottery/combinations.js` (+ `mathMean`/`mathStdev`, PHP `x % 2` semantics kept for pool values) |
| `CombinationGenerator.php` (394) | `src/modules/lottery/generator.js` (Fisher-Yates prefix, sequential weighted sampling, the kMax retry loops, the factors report) |
| `DiversificationEngine.php` (181) | `src/modules/lottery/diversification.js` (exact C(k,2)/C(k,3) overlap math) |
| `SystemBuilder.php` (166) | `src/modules/lottery/system.js` (JS generator for the lazy enumeration; `comb` truncation chain kept) |
| `LotteryIntelligence` slice-2 methods | `src/modules/lottery/service.js` (`analyzeLine`, `generate`, `saveGeneration`, `diversity`, `buildSystem`, `saveSystem`, `systemPlan`, `systemPage`, the four combination reads) |
| `lottery_combinations` + `lottery_ai_decisions` | migration **017** (`wf_lottery_combinations`, `wf_lottery_ai_decisions`), 6 repository methods on both adapters |

**Not ported yet:** tickets and checking, backtests and model versions, the lottery cron, the
console screens (F-29). The status matrix shrank accordingly — six areas to four, removed rather
than re-labelled.

## 3. The permission split is legacy's, and it is deliberate

Legacy's controller guards the three analysis POSTs with **`lottery.view`** (`generate`,
`diversity`, `system` — `requirePostPermission('lottery.view')`) and only the background build
with **`lottery.manage`** (`system-build`). The port keeps that split exactly, and the HTTP test
pins it from both sides: a viewer WITHOUT manage can generate, persist and score diversity
(audited to them), and is refused on `system-build`. The reasoning is legacy's own shape: analysis
records are not managed ingestion — only a route that writes a **job-run row** (the queue) needs
the manage permission. All four POSTs require CSRF, like every write on the platform.

## 4. Findings

- **The parity harness passed on the first run.** After slice 1 caught two real bugs, the entire
  35-case combination group — including the five-mode generator seeded at 42 — reproduced PHP
  byte-for-byte with **zero port fixes required**. The xorshift32 PRNG's proven identity is what
  buys this: identical randomness plus identical control flow yields identical draw universes.
- **The `{row, created}` wrapper is load-bearing.** The SQL adapter's save originally returned the
  bare row; the store's explicit method-assignment list (F-41) strips `this`, which ALSO silently
  broke the internal find-by-id helper. Both were caught by the store test, and the helpers are
  now closures over the executor — the repo's established pattern. Recorded so the next
  repository method does not rediscover it.
- **The framework's query validator is a schema gate, not a bag**: undeclared query keys do not
  reach a handler (`request.query` is `{}` without a `querySchema`). `analyze` needed an explicit
  schema for `mains`/`stars` — which also puts the route in the ledger as `validated: true`.
- **Boundary validation divergences, on purpose, platform-wide:** the JSON body schema 400s a
  non-integer `count` where legacy's casts would soften it — but `analyze?mains=abc` still
  coerces to `0` through the PHP `(int)`-cast port (`phpIntval`), so legacy's exact error string
  ("main number out of range 1-50: 0") is preserved where legacy preserved it.
- **`constraints` stays `constraints`.** Legacy's own column name is a MySQL reserved word; the
  migration keeps it (backticked, exactly as legacy backticks it) rather than renaming, so both
  adapters key rows identically. The SQL statements are pinned text (the store test asserts the
  backticks) because that is exactly the kind of thing only a text assertion catches.

## 5. The queue is honest about having no consumer

`buildSystem` queues pools above `SYNC_LINE_LIMIT` (10 000 lines) idempotently: the execution key
is `system:EUROMILLIONS:md5(mains|stars)`, a duplicate build reports the existing run —
`a system build for this pool is already RUNNING (idempotent)` — and nothing is audited twice.
But the background consumer is the lottery cron, which is a later slice, so the response note says
**"the lottery cron that processes it is not ported yet (slice 3); nothing consumes this queue
today"** instead of legacy's pointer at `php index.php tools lottery-cron systems` — a command
this platform does not have. The status matrix's `scheduled jobs` entry says the same. A queued
build on this host will wait, visibly, rather than pretend a worker exists.

## 6. How it is proven

- **Parity: 35 new golden cases** (`cases.combinations`), all deterministic: the analyzer's full
  profile + neutral score + refusals, the generator on every mode seeded (RANDOM ×3 exact lines,
  locks/excludes, HISTORICAL with top-N factors, BALANCED with targets and basis, DIVERSIFIED
  with context penalty ordering, ANTI-POPULAR's refusals), the unknown-mode/lock-conflict/
  starved-pool error strings, the MAX_LINES clamp, float-seed truncation, diversification (far
  apart / identical / mixed / empty / invalid), and the system builder (plan formula, lexicographic
  windows, computed C values up to C(60,5)=5 461 512, the background threshold at C(29,5)×C(2,2)
  = 118 755, and every pool refusal). Golden: 35 cases, zero port fixes.
- **Tests: 17 new** — `test/lottery_combinations_parity.test.js` (7), 
  `test/lottery_combinations_store.test.js` (5: the 173-method contract, JSON round-trip,
  newest-first windows, decision filtering, and the SQL shapes with backticks),
  `test/lottery_combinations_http.test.js` (5: analyze, generate+persist+audit+replay, the
  view/manage permission split with a real viewer user, the inline system + the 409, and the
  anonymous wall).
- **Gates:** `npm run check` exit 0 — `verify:install` **29/29**, `npm test` **938/938** across
  **59** files. PHP oracle **367/367** (re-run after all changes). `application/`, `system/`,
  `tests/` untouched. Version **0.19.0**. Schema **50** tables / **17** migrations (next free:
  018); contract **173** methods; routes **135** (20 lottery: 13 view reads + 3 view POSTs + 3
  manage writes + 1 authenticated status). The moved pins were each read before updating: schema
  48→50, contract 167→173 (4 sites + the breakdown), the repo-method pin 23→29, the matrix 6→4
  areas, backup tables +2 (+ the entity map), the migration pin, the 17-placeholder SQL pin, and
  the two `stats()` key lists.

## 7. What this phase does not claim

No ticket was created or checked; no backtest ran; no model version was registered; the lottery
cron does not exist and queued system builds have **no consumer** (stated in the API response and
the status matrix); no console screen exists (F-29). No MySQL server was exercised: migration 017
and the six new repository statements are pinned on SQL text through a recording pool and were
**never executed** (F-15). No official feed was contacted. Nothing here prices, purchases or
settles anything for money.

## 8. Decisions

- **No new numbered divergences.** The slice is divergence-free by construction: legacy's
  permission split, error strings, sort semantics (tie-free cases, LT-3), `{row, created}` save
  shape, and honesty notes are all preserved. The two judgment calls — the queue's no-consumer
  note (§5) and the platform-schema boundary 400s (§4) — are honesty improvements recorded here,
  not behavior changes requiring confirmation.
- **Slice bookkeeping:** slice 1's plan called this "S3"; the statistics goldens (S2) were
  absorbed into slice 1's parity harness. The remaining lottery work is: tickets and checking;
  backtests, model versions and measured performance; the cron (the queue's consumer); console
  screens (F-29).

## 9. Gates

| Gate | Result |
|---|---|
| `npm run check` | exit 0 (`verify:install` 29/29, `npm test` 938/938, 59 files) |
| PHP oracle (WASM 8.2) | 367/367 |
| Legacy tree untouched | `git status --porcelain application/ system/ tests/` empty |
| Differential parity | 118/118 golden cases total (35 new combination cases, zero fixes) |
| Contract | 173 methods (29 lottery), both adapters |
| Schema | 50 tables, 17 migrations (next free: 018) |
| Routes | 135 total, 20 lottery |
| Version | 0.19.0 |
