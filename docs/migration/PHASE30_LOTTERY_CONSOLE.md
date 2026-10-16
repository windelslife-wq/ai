# Phase 30 — Lottery console screens

**Date:** 2026-10-16 · **Scope:** close row 15's last unported entry — the console screens (F-29 for this module) — by
exposing the existing 31 lottery routes as two workspace screens, and promote `lottery` from `partial` to `ported` on
the strength of an empty `notPorted` matrix. No new HTTP route, migration, contract method or permission.

## Why this module next

`UNFINISHED_MODULES.md` row 15 said, in its own words: *"All row-15 code ported in slices 1–5 … `partial` on its label
for the console screens alone."* That is the strongest kind of remainder to close — a module whose only gap is a screen,
where the fan-out for building it is a screen and the evidence that it is closed is an empty list rather than a claim.
The alternative was to start on settings or the sports dashboard, both of which sit behind modules that are still
`partial` for reasons of their own (stake sizing, a live provider).

## Delivered

Two exact-path SPA routes, both guarded by `lottery.view` — the same permission legacy's `Lottery.php` required
(`requirePermission('lottery.view', false)`) and the same one the 27 read routes use:

- **`/app/lottery` — the operations board** (`LotteryOperationsView`): the port of
  `application/views/lottery/index.php` plus the surfaces the Node module added afterwards.
  - The four KPI cards legacy showed: engine state, tracked draws, active rules (version with the mains/stars counts)
    and model version.
  - **Provider health**: provider name, the live message verbatim, the state badge, and the six facts the legacy panel
    carried (`data-health-*`): source class, license metadata, last recorded check, last response time, last draw
    retrieved, synthetic status. The persisted health-history table sits under it with legacy's exact columns (observed,
    state, response, records, invalid, data label), including the `SYNTHETIC` badge and the "no observations yet"
    empty state.
  - **Latest stored draw** with the typed number rows (`Mains 6 · 16 · 25 · 35 · 44`), the source, the verification
    badge, and the rules note — the schedule is read as *stored configuration, not an odds forecast*, which is
    legacy's sentence and the module's honesty rule.
  - **Provider registry** (display name, code, registry flag, data class) with the hint that registry metadata does not
    activate a provider.
  - **Stored draws** — a date-filtered browser over `/lottery/draws`, showing each row with its source, verification
    state and the recorded jackpot/rollover. Legacy showed one draw; the Node module stores a history, so the screen
    shows it rather than a summary.
  - **Statistics** — the seven kinds the endpoint serves (`numbers`, `stars`, `hot-cold`, `distribution`, `pairs`,
    `triplets`, `star-pairs`) with a window control, rendered as tables built from the payload, plus each payload's own
    disclaimer or observation text.
  - **AI decision reports** with the `Historical records · not predictions` badge, the intro copy, and an inspect
    `details` per row carrying method, seed, rules/dataset version, the generated lines and the **full stored
    payload** — the same evidence legacy exposed, one click away. React escapes it, so a hostile payload cannot inject
    markup (legacy's case 68 asserts the same property of its own renderer).
  - **Sync runs** and the **performance overview**, whose three sections (ACTUAL / HISTORICAL / DEMO) are rendered as
    separate blocks so they can never be read as one number.
  - **Module boundary** — `/lottery/status`'s `notPorted` matrix, rendered as the module's own statement of what it does
    not do, with the disclaimer under it.
- **`/app/lottery/lab` — the lab** (`LotteryLabView`): the writing half, which legacy reached through the API only —
  the generator (five modes, count, seed, locks, excludes) with its report (lines with scores, inputs, factors), saved
  combinations, the diversity check, tickets as **records** with create/check/archive and per-line match counts and
  prize-tier labels, the Strategy Lab (four strategies, forced baseline, single run and comparison), stored backtest
  reports, and the model versions.

Both screens are in the workspace nav (rendered locked, not hidden, without the permission) and on the row-3 module
card, which now points at `/app/lottery` instead of describing the module as API-only.

## The two mutations, and why they are the only writes on the screen

`Check provider health` and `Sync draw history` post `/lottery/providers/check` and `/lottery/sync` under
`lottery.manage` + CSRF, exactly as legacy's `data-lottery-action="health"|"sync"` buttons did, and exactly as the
routes are guarded. They are the only actions on the operations board that reach out of the process; every panel load is
a read, so opening the screen never probes a provider. The lab's writes are analysis records and ticket rows — nothing
there can reach a payment path, and the ticket result text says "It is not a purchase and no money changed hands."

## Defects found and fixed on the way

1. **`POST /lottery/generate` silently dropped `locks` and `excludes`** — a real parity defect in the HTTP edge, not in
   the engine. The route declared them as `{type: "object"}` with no properties, and `http/validate.js` keeps only
   *declared* keys on an object node (its own comment calls this out), so `{mains: [7, 21]}` reached the generator as
   `{}`: the route accepted a lock and generated without it. Legacy forwards `$body['locks']` unchanged (`is_array` and
   nothing more) and lets the generator's `normalizeField` be the only validator, throwing legacy's exact messages —
   which is what the `additionalProperties: true` passthrough now restores, with that reasoning in the schema.
   Neither existing suite caught it: `lottery_combinations_parity.test.js` calls the service directly, and every HTTP
   test generated without constraints. Pinned in `test/lottery_combinations_http.test.js` — including that passthrough
   did **not** make the route lax: `duplicate locked main: 7`, `a main number is both locked and excluded` and
   `nonsense is not an accepted field` all still refuse with legacy's words.
2. **The console's own mode vocabulary was wrong in one spelling** — the generator's engine list is
   `RANDOM, BALANCED, HISTORICAL, DIVERSIFIED, ANTI-POPULAR` (hyphen) while the backtester's strategy of the same name
   is `ANTI_POPULAR` (underscore). The console module had the underscore in both. The new contract test compares both
   client lists against the engine's exported lists as **sets**, so this cannot drift again.

## Contract tests — `test/client_lottery_console.test.js` (13 tests)

The optimizer console's pattern, kept and extended where the lottery engine differs — it validates its own vocabulary
at runtime (its route schemas deliberately stay permissive, `legacy's controller casts with (string)…`), so a static
schema comparison is not available. The tests are therefore **behavioural against the live API**, on an in-process
server built from the same `test/helpers.js` the HTTP suites use:

- Every statistic kind the console offers is requested and answered by the API, and `clairvoyance` is refused with the
  message that lists the kinds it does serve.
- Every generator mode generates a real, persisted report (`saved.combinationId` / `saved.decisionId`), and
  `ALCHEMY` is refused by the engine.
- Every backtest strategy runs; a comparison **without** the baseline is refused by the engine
  (`the random baseline must be part of every comparison`), and the console's `buildCompareBody` — which injects it —
  is what makes the call legal. This is the difference between a screen whose Compare button works and one that 400s.
- Both vocabularies are compared against `generator.js` and `backtester.js` as sets (the regression above).
- The bodies carry only what the endpoints accept: blank seed/pools are *omitted* so the engine's defaults apply rather
  than being shadowed; a lock sent from the console reaches `inputs.locks` and every generated line; an excluded number
  never appears; the ticket body is asserted to have **no** amount, price, payment, order or quantity key.
- The pre-flights refuse what the engine refuses and accept the console's own defaults (a first click on a default form
  must not be a validation error).
- The normalisers run against **real payloads** fetched in the same test: 50 main-number rows and 12 star rows with no
  empty cell, ranked hot/cold, the three group kinds keyed by their members, ≥10 distribution metrics, and the
  performance sections — including the service's own quirk that `actualTicketResults.byTier` is a tier→count map
  **except** when nothing has been checked, where it is `[]`.
- Formatting never invents a figure (`null`/`""`/non-numeric all render `—`; a real `0` renders `0`), and a draw
  renders from its typed `numbers` rows with the payload as fallback.
- Both routes are declared exact-path, `requiresAuth`, `lottery.view`, with nav entries; `/lottery/status` stays
  `system.authenticated`; the three `lottery.manage` routes are the only administrator actions; and every path
  `client/src/api.js` calls exists in the server's own `/api/v1/system/routes` inventory.

## Honesty corrections made on the way

- `LOTTERY_NOT_PORTED` went from one entry to **empty**, with the reasoning in the constant, and
  `test/lottery_http.test.js` now asserts the empty list instead of naming the last area. The module's own
  `/lottery/status` therefore reports no unported area — the console renders that as
  "The status route reports no unported area."
- `health.js` moves `lottery` to `state: "ported"` and the label names **both screens by route** rather than dropping
  the sentence — a `ported` state with an undescribed surface is what this ledger has spent thirty phases avoiding.
- `test/platform_findings.test.js` moves the ported count **9 → 10** and the partial count **6 → 5**, each with the
  reason written into the assertion, and asserts the ported label no longer carries the F-29 hedge.
- The `sports` and `brokers` labels keep their `(F-29)` references: F-29 is now narrowed to the consoles that are still
  unported (sports, and the settings/analysis/strategy dashboards) rather than lifted platform-wide.

## Verification

- `npm run check:workforce` — **1000 / 1000** across 5 suites, 0 failures (986 before this phase: +13 console contract
  tests, +1 HTTP regression test).
- `npm run build:workforce-client` — production bundle built.
- `node tools/verify-install.mjs --require-bundle` — **30/30** installation checks.
- **Behavioural end-to-end** against the real app (file adapter, seeded administrator, `WINDELS_LOTTERY_SANDBOX=1`):
  a 40-draw sync, then every one of the 31 routes exercised through the console's own request builders; the console's
  generate body with locks/excludes verified to reach the engine after the schema fix; the ticket check verified to
  return per-line match counts with `prizeTier` labels and no amount.
- **Not run:** a real browser (no rendering, no click-through, no Lighthouse), real MySQL/MariaDB, any live provider,
  and no numeric PHP↔Node diff (F-26 remains open) — the same limits every phase record states.

## Remaining after this phase

Row 15 is closed. The ledger is now **10 ported / 5 partial / 2 not-ported** across 17 modules. Still open, unchanged:
**settings screens and the remaining domain dashboards** (row 3 — analysis, strategy, sports; sports also lacks stake
sizing and a verified vendor), the **retention decision** covering audit, notifications, `wf_analysis_runs` (R-27),
`wf_backtests` (R-28) and now the lottery history the cron prunes, **outbound notification delivery**, and every
host-level gate from the master plan (real MySQL, crontab, cPanel/Passenger, live providers, SMTP, official feeds).
