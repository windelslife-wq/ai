# Phase 21 — Lottery Intelligence: the foundation (row 15, slice 1)

> **Status: landed on `arena/653d6218-ai`.** This record covers the lottery foundation: the
> provider abstraction (unavailable / sandbox / official), the rules engine (EuroMillions as
> data), the draw validator, the PRNG, the statistics engine, idempotent ingestion with the
> VERIFIED-conflict guard, derived provider health, and the first **11** HTTP routes. It does
> **not** cover combination intelligence, tickets, backtests, model versions, the lottery cron
> or the console screens (slices 2–5, F-29). The previous record is
> [`PHASE20_SPORTS_CRON.md`](PHASE20_SPORTS_CRON.md).

## 1. What this phase is

Legacy row 15 is the lottery workstream: 13 tables in `database/lottery.mysql.sql`, 31 routes in
`config/routes.php`, and twelve PHP classes under `application/libraries/Aegis/Lottery/` fronted
by `LotteryIntelligence` (853 lines). The foundation slice ports the layer everything else stands
on — the provider boundary and its three implementations, the rules/validator/PRNG/statistics
engines, and the ingestion + health pipeline through `Api_lottery`'s read endpoints and its two
management writes. The honesty boundary is legacy's own, kept verbatim: simulated draws are
clearly labelled and never official; a draw is validated before it is stored; a VERIFIED result is
never overwritten; and every statistics output says, in legacy's words, that draws are independent
random events and nothing here predicts.

## 2. What was ported

| Legacy source (lines) | Node home |
|---|---|
| `LotteryProvider.php` (125 — interface + unavailable + sandbox) | `src/modules/lottery/providers.js` |
| `OfficialLotteryProvider.php` (185) | `src/modules/lottery/providers.js` |
| `LotteryRules.php` (130 — interface + `EuroMillionsRules`) | `src/modules/lottery/rules.js` |
| `LotteryResultValidator.php` (69) | `src/modules/lottery/validator.js` |
| `LotteryStatisticsEngine.php` (278) | `src/modules/lottery/statistics.js` |
| `MathUtils::seededRandom` (xorshift32 slice) | `src/modules/lottery/prng.js` |
| `Platform.php` provider choice + `Api_lottery.php` foundation endpoints (459) | `src/modules/lottery/service.js`, `src/modules/lottery/routes.js` |
| `Aegis_model` lottery repository block + `Persistence/Repositories.php` interface | `src/persistence/lottery-rows.js`, `src/db/lottery-repository.js`, `src/persistence/contract.js` (23 methods), `src/persistence/file-store.js` |

**Not ported (slice 2/3, F-29):** `CombinationGenerator` (394), `CombinationAnalyzer` (218),
`DiversificationEngine` (181), `SystemBuilder` (166), `LotteryIntelligence` (853 — analyze/generate
facade), `LotteryBacktester` (192), `LotteryCronService` (248), and the ticket/check/performance
endpoints. The health ledger names all six gaps as one list.

## 3. Findings

- **The parity harness caught two real port bugs on its first run** — the reason differential
  testing exists (F-26). (a) The official provider's nested wrapper unwrap was translated as
  "an ARRAY with a `main` key", but legacy unwraps a wrapper *object* one level deep
  (`is_array($main) && isset($main['main'])` — the value IS the assoc array); a feed sending
  `main: {main: […]}` kept its wrapper in the port. (b) `rollover` used JS truthiness, where
  `Boolean('0')` is `true`; PHP's `!empty()` is `false` for `'0'` — a feed sending the STRING
  `"0"` flipped the flag. Both fixed and pinned (`phpEmpty` documents PHP's table; NaN stays
  truthy, as in PHP).
- **Empty assoc arrays serialize as `[]`, not `{}`** — legacy's `json_encode` turns an empty
  PHP map (empty history's `oddEven`/`lowHigh`/`runLengthDistribution`, empty `groups`/`top`)
  into a JSON array. The port now does the same (`phpEmptyMap`), so an empty response is
  byte-identical to legacy's rather than merely equivalent.
- **SP-35 extends to the lottery rule fields.** PHP rejects `12.0` (`is_int` is false); JS has
  one number type and cannot even *construct* the distinction. The golden's `12.0` case was
  removed from BOTH harnesses as unrepresentable rather than pinned as a failure; the fractional
  `12.5` case stays and passes.
- **The store-less boot is a contract, and the lottery service now honors it.** Three platform
  tests (static serving, sitemap, service worker) boot the app with `store: null` to prove static
  routes work without a repository. The lottery service initially threw at construction; it now
  follows the sports pattern — `requireStore()` throws **503 `LOTTERY_PERSISTENCE_UNAVAILABLE`**
  lazily, so a host without migration 016 gets per-route 503s, never a boot failure (see §6
  LT-4's consequence for operators).
- **The scheduled-jobs scan needed an exemption, and got one by name.** `GET /api/v1/lottery/jobs`
  is legacy's own read (`api_lottery/jobs` → `listJobRuns`) behind `lottery.view`; the scan that
  keeps scheduled work off HTTP now exempts exactly that GET and pins it, so any route that
  *triggers* work still fails the test.
- **Harness-order lesson, recorded so it is not repeated:** the PHP generator initially captured
  "health online" *after* withdrawing `WINDELS_LOTTERY_SANDBOX` — the env is read per call, so it
  silently pinned the refusal path under an online name. The generator now captures every
  enabled-state observation before the withdrawal, and the withdrawal itself is what proves the
  per-call env read (the same instance goes dark).

## 4. The surface

**11 routes** (legacy `Api_lottery` foundation set): 9 GET — `/lottery/status`
(`system.authenticated`, no lottery permission needed, exactly legacy's header comment),
`/lottery/lotteries`, `/lottery/rules`, `/lottery/draws` (limit 1–100000, default 100),
`/lottery/draws/:drawId`, `/lottery/statistics/:kind` (numbers | stars | hot-cold | distribution |
pairs | triplets | star-pairs; `window` 0–10000), `/lottery/providers`, `/lottery/health`,
`/lottery/jobs` — all `lottery.view`; and 2 POST + `lottery.manage` + session CSRF —
`/lottery/providers/check` (explicit, audited probe; never a side effect of a dashboard load) and
`/lottery/sync` (limit clamped 1–1000, default 100). A null service (never constructed) is 503
`LOTTERY_SERVICE_UNAVAILABLE`; a null store is 503 `LOTTERY_PERSISTENCE_UNAVAILABLE`.

`status()` is the honesty surface: engine state (`ACTIVE` / `DISABLED_NO_PROVIDER` /
`OFFLINE_UNAVAILABLE`), the active rules as plain numbers, the provider's own health verdict,
`drawsTracked`, `lastDraw`, `modelVersion '1.0'`, the independence disclaimer, and the six-area
not-ported matrix (combination intelligence, tickets and checking, backtests and model versions,
generation persistence, scheduled jobs, console screens).

Ingestion outcomes are legacy's, audited with dot-cased actions: `lottery.draw.imported`,
`lottery.draw.validation.failed`, `lottery.draw.corrected` (unverified correction),
`lottery.result.conflict` (a differing VERIFIED draw is NEVER overwritten — the import counts a
conflict and moves on), `lottery.provider.health.probed`, `lottery.admin.sync`. Sync is
idempotent: a second run of the same feed reports `unchanged`, `imported: 0`.

## 5. Migration 016

`016_lottery_foundation.sql` creates **seven** tables, taking the schema from 41 to **48**:
`wf_lotteries` (the game registry, one row per code), `wf_lottery_rules` (versioned format as
data — `code`+`version` unique), `wf_lottery_data_sources` (the provider registry; the entity is
`lotteryProviders`, the TABLE keeps legacy's own name), `wf_lottery_provider_health` (append-only
observations), `wf_lottery_draws` (`code`+`external_id` unique — the idempotency key),
`wf_lottery_draw_numbers` (`draw_id`+`kind`+`position`), `wf_lottery_sync_runs` (one row per job
execution, `execution_key` unique). The migration is additive and idempotent (`CREATE TABLE IF NOT
EXISTS`), like all before it. The file adapter's WAL replay and `stats()` cover all seven
collections; the backup test maps each to its table by name.

## 6. Divergences

- **LT-1 — column casing.** Legacy's schema has mixed-case columns (`drawId`, `jackpotAmount`);
  the Node tables use canonical snake_case (`external_id`, `jackpot_amount`) while API payloads
  keep legacy's camelCase (and `gmdate('c')` instants). SQL is ours; the wire contract is legacy's.
- **LT-2 — the VERIFIED guard is repository-level, not advisory.** `saveLotteryDraw` returns
  `{row, created, conflict}`: a second VERIFIED draw with a different main/stars line can never
  overwrite the first (the import reports a conflict and audits `lottery.result.conflict`);
  identical lines patch provenance in place. In legacy the same protection lives in
  `LotteryIntelligence`'s import loop; the port moved it into both adapters so *no* caller can
  bypass it. **Operator-visible; pending user confirmation.**
- **LT-3 — sort stability.** PHP's `sort`/`usort` are not stable; JS `Array.sort` is. Every
  statistics golden case is constructed tie-free at the sliced boundaries so the difference
  cannot show; a tie in a future golden is a pinned divergence, not a silent one.
- **LT-4 — construction is write-free.** Legacy's `Aegis_model` ensured the game registry row in
  its constructor (a write on every boot). The port ensures it lazily on the first call that
  needs it. Consequence: a host that has **not** applied migration 016 boots fine and its lottery
  routes answer **503 `LOTTERY_PERSISTENCE_UNAVAILABLE`** instead of failing at boot. **Pending
  user confirmation** (the alternative is a hard boot dependency on the migration).
- **SP-35 (extended)** — integral floats (`12.0`) are unrepresentable in JS; see §3.

## 7. How it is proven

- **Unit + store + HTTP: 28 new tests.** `test/lottery.test.js` (5): PRNG exactness (the seed-42
  first five to the last digit), rules errors, validator statuses, statistics hand-verified
  against engine output, the provider boundary. `test/lottery_store.test.js` (9): the 23-method
  contract on both adapters, registries, health series + cutoff refusals, draw lifecycle
  including the LT-2 conflict and an unverified correction, sync-run key arbitration,
  close/reopen, and the SQL shapes pinned against a recording pool (`legacyLimit` = PHP's
  `min(cap, max(1,(int)$x))`, where 0 and NaN go to **1**, never the default).
  `test/lottery_http.test.js` (5): the permission matrix from both sides (anonymous 401, outsider
  403 on every read and write, status OK for a plain authenticated caller), the honest empty
  state with the not-ported matrix, idempotent sync over HTTP, statistics kinds + unknown-kind
  400, and the audited persisted probe.
- **PHP↔Node differential parity: 83 cases.** `runtime/parity/lottery-golden.php` runs the REAL
  legacy classes in WASM PHP 8.2 (`node runtime/lottery-parity.mjs` regenerates; the legacy tree
  is read, never written). `test/lottery_parity.test.js` (9 tests) recomputes every case with the
  Node port: 17 rules, 17 validator, 9 statistics, 4 PRNG, 10 sandbox, 23 official, 3
  unavailable — to the last double and the last error character. The sandbox draw list is
  compared with clock-derived fields sentinel-substituted on both sides; the draw CONTENT
  (numbers, jackpot strings, rollover flags) is exact and was previously proven byte-identical
  against live PHP including timestamps. The official provider's safety defaults (disabled by
  default, https-only with no credentials, 180-char reason truncation, `limit` clamped in the
  query string) are PHP's own output.
- **Smoke:** a full app boot on the file adapter with `WINDELS_LOTTERY_SANDBOX=1` syncs 12
  sandbox draws, re-syncs unchanged, serves draws/statistics/jobs, and refuses an anonymous read.
- **Gates:** `npm run check` exit 0 — `verify:install` **29/29**, `npm test` **921/921** across
  **57** files. PHP oracle **367/367**. `application/`, `system/`, `tests/` untouched.
  Version **0.18.0**. Schema **48** tables / **16** migrations; contract **167** methods; routes
  **126** (11 lottery). The 14 moved test pins were each read before updating; all were counts
  except the store-less-boot contract (§3), the jobs-read exemption (§3) and the notifications
  pin re-pointed at `languageLearning` (the ledger's own churn protocol).

## 8. What this phase does not claim

No combination was generated; no ticket was created or checked; no backtest ran; no model
version was registered; no lottery cron was scheduled and no console screen exists (F-29). No
MySQL server was exercised: migration 016 and every statement in `lottery-repository.js` are
pinned on SQL text and bound values through a recording fake pool and were **never executed**
(F-15). No official feed was contacted — the official provider's transport is a scripted
function in every test, and the sandbox is simulation end to end. Live execution remains
disabled platform-wide.

## 9. Decisions

- **LT-1, LT-2, LT-3, LT-4** as in §6 — recorded, labelled operator-visible where they are, and
  **pending user confirmation**, same status as DV-22/DV-24/DV-25.
- **The golden's `12.0` case is omitted, not failed** — SP-35's principled extension: a case no
  JS implementation can represent would rot the harness into a permanent red.
- **The jobs-read exemption is by name and pinned** — the scan stays sharp for anything that
  triggers work.
- Legacy behaviors kept without a divergence number because they ARE legacy: the `SANDBOX_NOT_ENABLED`
  message, the official feed's authorization-gated messages, `limit` clamping in the query, the
  validator's coercion order (numeric strings cast, non-numeric → −1, floats truncated).

## 10. Gates

| Gate | Result |
|---|---|
| `npm run check` | exit 0 (`verify:install` 29/29, `npm test` 921/921, 57 files) |
| PHP oracle (WASM 8.2) | 367/367 |
| Legacy tree untouched | `git status --porcelain application/ system/ tests/` empty |
| Differential parity | 83/83 golden cases (new fixture, 98 KB) |
| Contract | 167 methods (23 lottery), both adapters |
| Schema | 48 tables, 16 migrations (next free: 017) |
| Routes | 126 total, 11 lottery (9 GET + 2 POST) |
| Version | 0.18.0 |

## 11. Ledger

`lottery` moves **not-ported → partial** (row 15, slice 1): the label names what is proven
(validation before storage, the VERIFIED guard, the disclaimer, the parity evidence, the route
counts) and what is not (combinations, tickets, backtests, cron, console screens — F-29).
`not-ported` shrinks to 2 (language learning, lead discovery). `scheduledJobs` keeps its
CLI-only label; the lottery cron does not exist yet, and the label says so. `UNFINISHED_MODULES`
row 15 is rewritten to the slice-1 state.

## 12. Open items and risks

- **Slices 2–5** (the lottery remainder): parity goldens for the combination engines — combinations,
  generator, diversification, `SystemBuilder`, `LotteryIntelligence` analyze/generate; tickets
  and checking; backtester, model versions, measured performance; the lottery cron (the
  phase-20 lock pattern, CLI-only) and `Lottery.php` console screens (F-29).
- **User decisions pending:** LT-2 (repo-level VERIFIED guard), LT-4 (no-writes-at-construction →
  503 instead of boot failure), plus the standing list (DV-21, DV-22, sandbox qualification,
  calibration policy, SP-35, DV-24, DV-25).
- **F-15** covers this phase too: nothing here has run against a real MySQL/MariaDB server.
- The lottery module has **no stake-sizing analogue and must never grow one silently** — tickets
  are records and analysis is research; any future ticket-cost or payout computation must arrive
  as an explicit, user-confirmed decision.
