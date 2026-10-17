# Phase 38 — the Risk Center console (row 11)

**Status:** complete · 2026-10-17 · branch `arena/046b29ac-ai`

`/app/risk` is the port of `Risk_center::index` → `views/risk/index.php` (84 lines): the eleven
independent limits with veto power over every trade, the portfolio risk monitor, and the latest audit
rows. With it, **row 11 has no screen left**.

This is the first of F-29's remaining consoles whose legacy page carried a **write**, and porting it
honestly meant stating three things legacy's page could not. All three are on the screen, not in a
docblock:

1. **The scan is a read here.** Legacy's `Risk_center::scan()` was a POST that scanned, audited the
   alert *transitions* and stored the report. The port's `GET /api/v1/portfolio/risk-scan` performs
   the scan and writes nothing; the transition sweep — the audit rows and the `PORTFOLIO_RISK`
   notifications — is the scheduled operations job (`npm run jobs` → `portfolio.risk.alert` /
   `portfolio.risk.cleared`, Phase 12). The panel says so beside the button.
2. **Legacy's notional field could never be saved.** `views/risk/index.php` rendered
   `maxPositionNotionalUsd`, and `Risk_center::limits()` skipped that key by name before building the
   patch — a decorative input. The port keeps the field and lets it save; it is the twelfth editable
   limit, and the deviation is asserted against the controller source rather than described.
3. **`maxCorrelatedPositions` is persisted and unenforced (F-30).** The read-only panel says so in
   the row itself, so the screen cannot be read as a promise that the limit is applied.

## Scope

| | |
|---|---|
| Legacy | `views/risk/index.php` (84 L), `controllers/Risk_center.php` (`index`, `scan`, `limits`), `libraries/Aegis/Portfolio/PortfolioRiskMonitor.php` (the monitor and its six-code vocabulary) |
| Node routes used (all already present) | four reads — `GET /risk/limits` (`trading.view`), `GET /trading/mode` (`trading.view`, the governance strip), `GET /portfolio/risk-scan` (`trading.view`, the monitor), `GET /admin/audit` (**`identity.users.view`** — AV-1, the port's deliberate tightening of legacy's session-only read) — and the one write the page offers: `POST /risk/limits/update` (**`trading.control`**) |
| New files | `client/src/risk.js` (32 exports), `test/client_risk_console.test.js` (26 tests), this record |
| Edited (client) | `client/src/views.jsx` (`RiskCenterView`, its import block, the nav entry, the ModuleCards docblock), `client/src/api.js` (`riskLimits`, `updateRiskLimits`, `portfolioRiskScan`), `client/src/App.jsx` (route + view map), `client/src/styles.css` (`.risk-*`, one responsive rule) |
| Edited (server) | `src/modules/platform/health.js` — the `risk` label names the console and keeps F-30 and the read-vs-audit distinction in the same sentence. **No route, no contract, no service, no migration, no repository method, no permission, no dependency** |
| Edited (tests) | `test/client_dashboard.test.js` — `/app/risk` leaves the F-29 absence list, for the reason `/app/paper` left it |

## The screen

- **The governance strip** reads `GET /trading/mode` and states the mode, the kill switch, whether
  synthetic paper prices are on, and that execution is simulation-only — the state legacy's layout
  header showed on every page. Only an explicit `active: false` reads as released; an absent switch
  field is not a released switch. The three governance **writes** are not carried: they are
  `trading.control` and live on `/app/analysis`, which the strip names and links.
- **The limits form** is legacy's eleven fields in legacy's order, with legacy's labels and scales
  (`scale: 100` where the persisted value is a fraction and the field shows percent), rendered from
  `GET /risk/limits`. Validation is client-side *and* the contract's: the field bounds are mirrored
  from `RISK_LIMITS_BODY` and asserted equal to it in the test, so the form cannot accept what the
  schema refuses. The save sends **only the fields that changed** — legacy sent all eleven on every
  save, so its audit row could not say what moved — which makes `details.changed` in the audit row
  mean what it says. An unchanged form says "No limit changed — nothing was sent." rather than
  re-auditing eleven identical values.
- **The read-only panel** renders the limits the form omits: `maxCorrelatedPositions` (with its F-30
  note), `minDataQuality`, `blockSyntheticData`, `blockStaleData`, and `requireStopLoss` — which is
  not merely un-drawn but immutable: `normalizeRiskLimits` forces it true on every read, so the row
  says it cannot be turned off through the API.
- **The monitor** runs the scan on load and on the button (`scan.retry()`), prints the report's own
  `generatedAt` and totals, one row per breach ordered as legacy ordered its alerts (severity then
  code), and a per-account table. **The severity is not invented**: the scan returns breach codes and
  no severity, so each badge uses `breachSeverity()`, pinned in the test to the operations cron's own
  `CRITICAL_BREACH_CODES` / `WARNING_BREACH_CODES` — a code the cron would publish as `critical`
  cannot render here as a warning. The scope string is legacy's (`paper:<id>`) with the account's
  name beside it, because an id alone is not an identity.
- **The audit panel** is legacy's four columns — At · Type · Summary · Actor — from
  `GET /admin/audit`. The Node trail has no summary column, so the writers' `details.summary` is used
  first and the entity is the fallback; a `system` actor is named rather than left blank. The panel is
  gated: legacy showed the last 25 rows to any signed-in member, the port requires
  `identity.users.view` (AV-1), so a session without it is told which gate it met instead of being
  shown a subset the API does not serve.
- **The reads panel** lists the four routes with the permission each carries, and states legacy's
  six-code monitor vocabulary beside this API's nine — the difference between what the PHP page
  promised and what the port measures, on the screen rather than in a footnote.

## Honesty corrections made on the way

- `RISK_COPY.monitorNote` is legacy's sentence **including its `<i>transitions</i>`**, and the test
  compares against the page with inline markup stripped so a sentence split across tags still has to
  match whole.
- The `health.js` `risk` label named the engine and the monitor but not the screen; it now names the
  console, the AV-1 gate, the read-vs-audit distinction and F-30 in one sentence, in the same style
  as the analysis label. The module stays `ported`.
- `test/client_dashboard.test.js`'s F-29 absence list loses `/app/risk` **because it is now
  declared**, which is the only reason a screen may leave that list.

## Tests

`test/client_risk_console.test.js` — **26 tests**, hermetic (file adapter, `createFileStoreApp` with
`MARKET_DATA_REAL_PROVIDERS=0`, no network). Eight of them drive the real app over HTTP:

- the legacy page and controller are read with `readFileSync` and every heading, note, label, flash,
  empty state and table caption is asserted against them, with markup-insensitive comparison;
- the eleven form fields are extracted **from the PHP's own `$fields` array** and compared key for
  key, label for label and scale for scale — a reordered or relabelled form fails;
- the notional-field departure is asserted against the controller's `continue` line, so the test
  distinguishes "legacy drew it" from "legacy could save it";
- the form's bounds are asserted equal to `RISK_LIMITS_BODY`'s, and the contract keys the form does
  not carry are asserted to be exactly the read-only panel's rows plus the immutable stop requirement;
- the breach severities are asserted equal to `src/jobs/scheduled.js`'s two sets, and every code the
  scan function can emit (read out of `portfolioRiskScan` itself) is asserted classified;
- the routes: all four reads and the one write exist in `GET /api/v1/system/routes` with the
  permissions the server enforces, and **no `POST …/risk-scan` exists**;
- live: a `trading.view` viewer reads the limits, the state and the scan, is refused the audit read
  (403 `PERMISSION_DENIED`) and refused the limits save (403), and still sees the persisted form;
- live: a save writes the persisted row, leaves every other limit untouched, and the audit row's
  `details.changed` names exactly the one key that moved; an out-of-bounds value is the schema's 400;
- live: the scan reports the same limits `/risk/limits` does, writes **nothing** (the audit total is
  unchanged and no `portfolio.risk.*` row appears), and, after tightening `maxSymbolExposurePct`
  below what is already open, a real `SYMBOL_EXPOSURE_LIMIT` breach arrives classified `critical`;
- the served shell: `/app/risk` answers 200 `text/html` and its bundle carries the screen's strings.

## Gates

- `npm run check:workforce` → **1121 / 1121** (1095 before: +26 console tests).
- The client suites together → **144 / 144** (118 + 26).
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:client` → `index-BRQhhAzT.js` 528.70 kB / 142.36 kB gzip,
  `index-n6dzW65b.css` 43.05 kB / 9.19 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe (file-store demo rebuilt from scratch on `:4020` after a sandbox reset, admin `root`):
  **25 / 25** — the three `trading.view` reads, the audit read, the demo account's scan row, a limits
  save and its restore with the audit row's `changed` naming the key, an out-of-bounds 400 that
  changed nothing, `/app/risk` serving the shell, and the bundle carrying the screen's strings and no
  kill-switch POST.
- **Probe note:** the demo store was rebuilt this phase (the sandbox reset took the previous one):
  `seed-platform.mjs` for the 9 roles / 14 permissions / 29 grants and the `root` administrator, then
  a temporary populate script created one "Risk Center demo" account (25 000) with a filled BTCUSDT
  market order, and restored the demo's deliberate governance state afterwards (kill switch ACTIVE,
  `ANALYSIS_ONLY`, synthetic prices off). The scan therefore finds one genuine `SYNTHETIC_EXPOSURE`
  breach — the position was opened while synthetic prices were allowed and that flag is now off —
  which is the monitor doing its job on the state that exists rather than a manufactured alert. The
  populate and probe scripts were deleted; none of this is a product change.
- **Not run:** a real browser (no rendering, no click-through of the form), real MySQL/MariaDB
  (F-15), any live provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## After this phase

**F-29's residual list is now three: execution, brokers, journal** — risk left it. **Module counts
are unchanged — 10 ported / 5 partial / 2 not-ported:** this phase ported a screen over routes that
already existed, and `risk` was already `ported`.

What the module still carries, unchanged and stated on the screen: F-30's unenforced
`maxCorrelatedPositions`; no statistical correlation model (legacy's disclosed static groups were
never ported and the Node scan does not raise `CORRELATED_POSITIONS` at all); no broker-connectivity
alerts, because no broker connector is wired (row 13); and the alert transitions are the cron's, so a
host that never runs `npm run jobs` never writes them.

Next, unchanged: F-29's remaining consoles (execution, brokers, journal), row 5's
retention/outbound-delivery decisions, row 18's chat/journal/tools inventory, and every host-level
gate (real MySQL, crontab, cPanel/Passenger, live providers, SMTP, official feeds).
