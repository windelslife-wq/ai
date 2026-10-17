# Phase 29 — Portfolio optimizer console

**Date:** 2026-10-16 · **Scope:** close row 9's console gap (F-29 for that module) by exposing the existing Phase 11 endpoint as a workspace screen, with no API, schema, migration or route-count change.

## Why this row first

`UNFINISHED_MODULES.md` row 9 lists one remaining item: *"Port the portfolio optimizer console with its permission"*,
and row 3 names the same screen as the next app-shell step after the audit console. Phase 28 closed the audit console;
this closes the optimizer. They are the only two consoles the backlog names specifically — the remaining F-29 work is
"domain dashboards and settings", which depends on those modules being accepted first.

## Delivered

- **Route** `/app/portfolio/optimizer`, an exact-path SPA route guarded by `trading.view` — the same permission the
  legacy page (`views/portfolio/optimizer.php`) and the Phase 11 API both use. A role without it sees the locked
  navigation entry and the denied state; the API returns 403 independently, so nothing is hidden client-side.
- **Navigation entry** "Portfolio optimizer" in the workspace nav, rendered locked (not hidden) without the permission.
- **Inputs** — timeframe, historical bars, objective, per-asset weight cap, annual risk-free rate *as a percentage*
  (converted to the API's decimal in one place), optional `periodsPerYear`, a 2–12 asset universe and the explicit
  synthetic-data opt-in. The screen keeps `views/portfolio/optimizer.php`'s defaults (1 day, 365 bars, maximum Sharpe,
  0.60 cap, BTCUSDT/ETHUSDT) and its option order, so the console looks the same after cutover.
- **Pre-flight validation** (`client/src/portfolio.js`) for the refusals a person can fix before spending the endpoint's
  widest fan-out: universe size, symbol shape and uniqueness, the bar bounds, the `1/n` cap floor, the rate bounds, and
  a mixed-calendar universe with no explicit `periodsPerYear`. Every rule mirrors a server rule; none is stricter.
- **Report** — the one-line summary, the `SIMULATION` badge when any input series is synthetic, every warning the
  endpoint returned, the selected allocation with **per-asset provenance** (source, synthetic/stale flags, gap count),
  the four-allocation comparison (return, volatility, Sharpe, concentration), the sample correlation matrix marked
  **unshrunk**, and the window / estimation / constraints block with the report's own method note and disclaimer.
- **No saved reports, and the screen says so.** The endpoint returns a run; it does not store it. The report carries a
  line stating the result exists in this tab only and that the audit trail records the run, never the report.

## What was deliberately not built

- **No report history or export.** Nothing stores a report, so a list would be a fiction. Retention for
  `wf_analysis_runs` (R-27), `wf_backtests` (R-28) and the audit trail is still an open, single decision (row 5).
- **No order, amount, account or broker control** — and no route to one. The client body builder emits only properties
  `OPTIMIZE_BODY` declares, so `execute`/`amount`/`orderId`/`notional` cannot be expressed from the screen either.
- **No new HTTP route, migration, contract method or permission.** 146 routes before and after; the console is a
  consumer of Phase 11, and the route count staying flat is the honest report of that.

## Contract tests — `test/client_console.test.js` (11 tests)

A console is the one surface no server test can see, so the two failure modes that actually break a screen are pinned
against the real artefacts on both sides:

1. **Vocabulary drift.** The client module is plain ESM with no JSX on purpose, so the suite imports it *and* the
   server's `PORTFOLIO_MARKET_CLASSES`, `PORTFOLIO_TIMEFRAMES`, `OBJECTIVES` and `OPTIMIZE_BODY`. Adding a market class
   to the API fails the suite until the console offers it. The client's display order is asserted separately, because it
   intentionally keeps the legacy order (crypto first, longest timeframe first) while the service lists canonically.
2. **Request-shape containment.** The built body is asserted to carry only declared properties, to always carry the
   required ones, to convert `4` → `0.04`, to omit a blank `periodsPerYear` rather than send `null`, to normalise
   symbols the way the service does, and to treat only a strict `true` as the synthetic opt-in — plus the absence of
   every order-shaped key, so a future edit that adds one fails here rather than at review.
3. **Dead endpoints.** Every literal path in `client/src/api.js` is checked against the route inventory the server
   itself reports (`GET /api/v1/system/routes`), which is derived from what each route declares.
4. **Deep links.** Every declared `/app*` route must answer the SPA shell for an HTML navigation, and must *not* answer
   it for a JSON client — a route reachable only by clicking is a 404 for a bookmark, a refresh or a pasted link.
5. **Pre-flight behaviour.** The rules are tested for what they refuse *and* for what they must not: the default form
   the console opens with is asserted to be sendable, because a first click that fails teaches the wrong lesson about
   its own defaults.

Two real defects were found and fixed by these tests while writing them: `formatPercent(null)` rendered `0.00%`
(`Number(null) === 0`), which would have printed a fabricated zero for a missing figure; and the
market-class/timeframe order assertions were initially written as equality, which would have forced the console to
abandon the legacy display order for no reason.

## Honesty corrections made on the way

The status surface had drifted **under** what exists, which is the same class of error as overstating it:

- `audit`'s label still said *"no console screen"* although Phase 28 shipped `/app/admin/audit`. It now reads
  *"...API and console (no retention policy, no historical import)"* — and a test asserts the label no longer contains
  the stale phrase, so the correction cannot silently revert.
- `portfolioOptimizer`'s label said *"no console screen, no saved reports"*; it now names the console path and keeps
  *no saved reports*, which is still true and is the part `ported` could otherwise imply away.
- The workspace module cards claimed **"Not yet ported to Node"** for sports and lottery — untrue since Phases 15–20 and
  21–25, which ported their measured halves. They now read *"Measured half ported · no console"* and
  *"Slices 1–5 ported · no console"*, and the two genuinely PHP-only modules say *"PHP only · not ported"*. A ninth card
  points at the new console; only cards with a real target render as links.

## Verification

- `npm run check:workforce` — **986 / 986** across 72 files, 0 failures (975 before this phase, +11 new).
- `npm run build:workforce-client` — production bundle built (300.63 kB / 88.43 kB gzip).
- `node tools/verify-install.mjs --require-bundle` — **30/30** installation checks.
- **End-to-end against a real server** (file adapter, seeded administrator, `MARKET_DATA_REAL_PROVIDERS=0`):
  login → `POST /api/v1/portfolio/optimize` with `allowSyntheticData:false` answered **422**
  (`all available history is synthetic; retry with allowSyntheticData=true …`); the same body with the opt-in answered
  **200** with `status: RESEARCH_ONLY`, 364 aligned returns, 365 periods/year, `synthetic-demo` provenance on both
  assets, the `SIMULATION:` warning and the shrinkage warning. The served bundle was fetched back from the running
  server and contains the console.
- **Not run:** a real browser (no rendering, no Lighthouse, no click-through), real MySQL/MariaDB, any live provider
  call, and no numeric PHP↔Node diff (F-26 remains open).

## Remaining after this phase

Row 9 is closed for the screen. Still open, unchanged: **settings screens and the remaining domain dashboards**
(row 3 — analysis, strategy, sports and lottery consoles), the **retention decision** covering audit, notifications,
`wf_analysis_runs` and `wf_backtests` (row 5), **outbound notification delivery** (row 5), and every host-level gate
from the master plan (real MySQL, crontab, cPanel/Passenger, live providers). The ledger is unchanged at
**9 ported / 6 partial / 2 not-ported** across 17 modules: this is app-shell work under row 3, so no module changes
state — the label changes are corrections, not promotions.
