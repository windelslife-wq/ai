# Phase 39 — the Execution Center console (row 2)

**Status:** complete · 2026-10-17 · branch `arena/046b29ac-ai`

`/app/execution` is the port of `Execution::index` → `views/execution/index.php` (152 lines): the
propose form, the human decision, the broker executions panel and the automation envelope, drawn over
`Aegis\ExecutionSupervisor`'s fifteen-step pipeline. With it, **row 2 has no screen left**, and F-29's
residual list is down to **brokers and journal**.

This is the first console in the series whose gap is not a divergence but a **missing half**. Legacy's
page drew four surfaces; this port registers routes for three of them and none at all for the
automation envelope, the automated-execution form or the broker executions table. The screen states
that rather than dressing the missing half in disabled controls. The three statements, all on the
page:

1. **The port performs three of the fifteen steps.** `propose()` writes `kill-switch`,
   `trading-mode` and `strategy` checks (steps 1–3) and audits them (step 14). Step 11 is the
   separate `trading.control` decision. Steps 4–10 and 12–15 read or write broker state that does not
   exist here (row 13), and the pipeline panel marks each stage — this port, human decision,
   broker-bound — instead of presenting three checks as a fifteen-step run.
2. **The automation envelope is not stored.** There is no `GET /api/v1/trading/limits`, no
   `updateAutomationLimits`, no `POST /api/v1/execution` and no `automationModeGate`. The panel shows
   `ExecutionSupervisor::automationLimits()`'s own defaults — 500 USD notional, 5 daily trades, 1 %
   risk, no approved symbol — **labelled as legacy defaults**, and says the port implements none of
   them. `POST /trading/mode` accepts only `ANALYSIS_ONLY` and `PAPER_TRADING`, so the two automated
   modes cannot even be selected here.
3. **The step after approval is a paper submission.** There is no `route` route and no executions
   read, so the Brokers panel carries legacy's empty-state sentence plus the reason it can only ever
   be empty. "Submit to paper" is the port's action; the outcome sentence never borrows legacy's
   "broker order created".

## Scope

| | |
|---|---|
| Legacy | `views/execution/index.php` (152 L), `controllers/Execution.php` (`index`, `propose`, `decide`, `route`, `execute`, `limits`), `libraries/Aegis/ExecutionSupervisor.php` (the fifteen-step pipeline, `automationLimits`, `decide`, `executeAutomated`, `route`) |
| Node routes used (all already present) | five reads — `GET /execution/status`, `GET /execution/proposals`, `GET /trading/mode`, `GET /paper/accounts` (all `trading.view`) and `GET /strategies` (**session-only**, legacy's own `Api_strategies` guard) — and the three writes the page offers: `POST /execution/proposals` (`trading.execute`), `POST /execution/proposals/:id/decision` (**`trading.control`**), `POST /execution/proposals/:id/paper-submit` (`trading.execute`) |
| New files | `client/src/execution.js` (634 L), `test/client_execution_console.test.js` (27 tests), this record |
| Edited (client) | `client/src/views.jsx` (`ExecutionView`, its import block, the nav entry), `client/src/api.js` (six wrappers), `client/src/App.jsx` (route + view map), `client/src/styles.css` (`.exec-*`, one responsive rule) |
| Edited (server) | `src/modules/platform/health.js` — the `execution` label names the console, keeps F-29's statement and the broker-bound remainder in the same sentence. **No route, no contract, no service, no migration, no repository method, no permission, no dependency** |
| Edited (tests) | `test/client_dashboard.test.js` — `/app/execution` leaves the F-29 absence list and joins the landed list; `test/platform_findings.test.js` pins `/app/execution` in the module label |

## The screen

- **The banners** are legacy's: the kill-switch sentence, the execution-mode sentence (true on every
  host this port can have), plus the port's own paper-only scope banner, which names both
  `brokerConnectorAvailable: false` and `automatedModesAvailable: false`.
- **The module-scope strip** reads `GET /execution/status`: paper submission availability, configured
  connector count (configuration-only, stated as such), automated modes, approval requirement and the
  four-hour proposal expiry.
- **The propose form** carries the paper account (the port is owner- and account-scoped), symbol,
  market class, side, type, limit price, mandatory stop, take profit, the risk fraction, an APPROVED
  strategy id/version pair and a reason. Legacy's static quote fallbacks 1.0750 / 1.0900 appear as
  **placeholders**, not values — the port has no quote to derive them from.
- **The pipeline panel** lists all fifteen steps with their stage badge; the docblock text is parsed
  from `ExecutionSupervisor.php` by the suite, so a renamed or reordered step fails.
- **The proposals table** lists Created · Symbol · Intent · Broker · Status · Pipeline · Actions. The
  Broker cell says `none` until a paper submission exists and `paper` afterwards; it never names a
  broker the platform has not reached. Each row expands its persisted checks with pass/fail colouring.
- **The decision** opens a reason field (10–1000 characters) rather than legacy's bare
  `approve=1|0`, and records `execution.proposal.approved` / `execution.proposal.declined`.
- **The automation envelope panel** shows legacy's four labels with legacy's defaults and the
  absence note; nothing on it is editable.
- **The reads/writes panel** lists each route and its permission, then legacy's three unregistered
  writes (`/execution/limits`, `/execution/execute`, `/execution/:id/route`) with the reason each is
  absent.

## Divergences, stated rather than discovered

- **Account scope.** Legacy's page had one implicit portfolio; this port's proposals are owner- and
  paper-account bound, so the form names the account. A foreign or guessed account id is a 404
  (`PAPER_ACCOUNT_NOT_FOUND`) before any strategy lookup or write.
- **No volume field.** `PROPOSAL_BODY` has none — the paper Risk Engine sizes the position from
  equity, the stop distance and the risk fraction. The form offers `riskPct` instead, and the suite
  asserts the emitted body contains no `volume` key.
- **The decision needs a written reason.** `DECISION_BODY` requires 10–1000 characters; the contract
  refuses a shorter one with 400 `INVALID_REQUEST` before the service sees it, and the screen says so.
- **Market-class spellings.** Legacy's form offered `future, index, bond`; the port's contract accepts
  `futures, indices, bonds`. The form uses the contract's vocabulary or every proposal in those
  classes would 400. The suite names the three-word difference.
- **Status vocabulary.** `READY_TO_ROUTE`, `EXECUTED` and `FAILED` cannot be reached without a broker
  route; the port adds `DECLINED`, `EXPIRED` and the five `PAPER_*` states. Both vocabularies are
  pinned — legacy's to the PHP's tone map, the port's to `PROPOSALS_QUERY`.
- **The flash sentences.** Legacy's `REJECTED at step N (check): reason` is reproduced exactly. Its
  accepted-proposal sentence carried a `reason` field this port's `proposalView` does not have, so the
  port states status and id and stops; its approval sentence ("route it to place the order") is
  *not* reproduced, because there is no route to place it. The test asserts the absence.

## Defect found and fixed — D-24 (the shared `StateBox` hid the data it was given)

While wiring the proposals table, `StateBox` in `client/src/ui.jsx` turned out to return its
`empty` node whenever a read was `ready` — **before** returning `children`:

```js
if (empty !== null && status === "ready") return empty;
```

Every console in the shell passes an `empty` element unconditionally and also renders its data as
children, so this would have shown *only* the empty state in the paper accounts, orders and closed
positions boards, the Risk Center's scan and audit panels, the sports tables, the admin user and
inquiry lists, the sessions and activity panels and — the reason it was caught — the Execution
Center's proposals table. The app's HTTP tests never render a component, and the phase's live probes
assert response bodies rather than DOM, which is why this survived every earlier green gate and is
recorded as a **defect**, not a divergence.

The fix is in the primitive and in the call sites:

- `StateBox`: `if (status === "ready") return empty ?? children;` — `empty` is a fallback beside the
  content, which is the only reading that makes the prop's name true. The four call sites that
  already passed a computed `empty` (`noMatches`, the dashboard panels, the audit browser) are
  unaffected; the eighteen that passed an unconditional literal now compute it from the data they
  render (`rows.length ? null : …`, `sessions.data?.sessions?.length ? …`), so a genuinely empty
  resource still gets its message and a populated one gets its table.
- The suite pins both halves: the primitive's ready branch, the absence of any `empty={<p…>}` literal
  in `views.jsx`, and the Execution Center's own conditional fallback. Rendering the SPA is still
  **not** verified — this environment has no browser — so the test asserts the shape that caused the
  defect rather than a screenshot of its absence.

## Tests

`test/client_execution_console.test.js` — **27 tests**, hermetic (file adapter, `createFileStoreApp`
with `MARKET_DATA_REAL_PROVIDERS=0`, no network). Ten of them drive the real app over HTTP:

- copy: every `EXECUTION_COPY` string (except the shell's own eyebrow) is asserted inside the PHP,
  markup- and entity-insensitive; the controller's four flash fragments and its step interpolation are
  asserted too; the port's own sentences live in a separate object and are asserted not to claim a
  broker route or a broker fill;
- pipeline: the fifteen steps are parsed out of the supervisor's docblock and compared step for step;
  the port's `addCheck` calls in `service.js` are extracted and compared to `PORT_CHECKS`; the stages
  are asserted to be 1/2/3/14 port, 11 decision, and exactly 4–10/12/13/15 broker;
- vocabularies: `PORT_PROPOSAL_STATUSES` equals `PROPOSALS_QUERY.status.values`; legacy's six come
  from the PHP's tone map in its own order; unknown statuses are neutral; legacy's tones survive;
- markets and permissions: `EXECUTION_MARKET_CLASSES` equals `MARKET_CLASSES`, the three legacy
  spellings the contract rejects are named, and the three permission constants are the platform's;
- form: defaults come from the listed account and nothing else; validation refuses what
  `PROPOSAL_BODY` refuses, including the LIMIT price and the strategy-pair rule; the emitted body's
  keys are all contract properties and never include `volume`;
- routes: every read and write is asserted against `/api/v1/system/routes` with its permission, and
  `/api/v1/execution`, `…/route` and `trading/limits` are asserted **absent**;
- live: a viewer reads all five surfaces and is refused all three writes (403 `PERMISSION_DENIED`);
  an executive with `trading.execute` but not `trading.control` cannot approve their own proposal
  (403) and cannot submit it early (409 `PAPER_SUBMISSION_NOT_APPROVED`);
- live: a proposal persists exactly the three checks, the kill switch stops it at step 1 with legacy's
  detail sentence, and `ANALYSIS_ONLY` stops it at step 2;
- live: a short decision reason is the schema's 400 and changes nothing; a valid one is audited and
  hands the proposal to `paper-submit`, which produces `PAPER_EXECUTED`, a synthetic filled order and
  the four audit actions in order;
- live: `GET /execution/status` is the source of the paper-only claim, and `/app/execution` serves the
  shell whose bundle carries the screen's strings;
- the shared `StateBox` defect above: the primitive prefers children, no unconditional literal empty
  node remains, and this screen's fallback is conditional.

## Gates

- `npm run check:workforce` → **1148 / 1148** (1121 before: +27 console tests).
- The client suites together → **171 / 171** (144 + 27).
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:workforce-client` → `index-NvWKdgRS.js` 560.99 kB / 149.69 kB gzip,
  `index-D_kH6U8l.css` 44.85 kB / 9.44 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe (file-store demo rebuilt from scratch on `:4020` after a sandbox reset, admin `root`):
  **39 / 39** — the five reads, the status snapshot's four claims, account creation, proposal creation
  with its three checks, a short reason's 400, the decision, the paper submission, the proposal
  detail, the audit lifecycle, `/app/execution` serving the shell, the bundle strings, the 146-route
  inventory with no `/route`, `/execute` or automation envelope, and the governance restore. The
  D-24 fix landed after that run, so the rebuilt bundle was re-checked against the running host —
  the screen's strings are present and `/api/v1/execution/execute` is absent from it.
- **Probe note:** the first probe run submitted a proposal and got **409 `PAPER_REJECTED`** — because
  the demo leaves `allowSyntheticPaperData` off and the paper engine refuses synthetic marks while it
  is. That is the platform's own gate, not a console defect; the probe now enables synthetic prices
  for the submission and restores all three governance switches afterwards (kill switch ACTIVE,
  `ANALYSIS_ONLY`, synthetic off). The demo store was wiped and reseeded for the clean run, leaving
  one "Execution Center demo" account and one filled EURUSD paper order. The probe script was deleted;
  none of this is a product change.
- **Not run:** a real browser (no rendering, no click-through of the forms), real MySQL/MariaDB
  (F-15), any live provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## After this phase

**F-29's residual list is now two: brokers and journal.** **Module counts are unchanged — 10 ported /
5 partial / 2 not-ported:** the console adds a screen over routes that already existed, and
`execution` was already `partial` for the broker-bound reasons.

What the module still carries, unchanged and stated on the screen: steps 4–10 and 12–15 (row 13);
`SEMI_AUTONOMOUS` / `FULLY_AUTOMATED`, `executeAutomated()` and `automationModeGate`; the automation
envelope **with enforcement from the first commit** (`automationLimits` must not become another
declared-but-unenforced limit, the F-30 shape); the `executions()` history; and **F-31** — legacy's
`Api_system::automation_limits()` has no `requirePermission`, so any signed-in user could read the
governance envelope. That route is not ported, and when it is it must be permission-gated.

Next, unchanged: F-29's last two consoles (brokers, journal), row 5's retention/outbound-delivery
decisions, row 18's chat/journal/tools inventory, and every host-level gate (real MySQL, crontab,
cPanel/Passenger, live providers, SMTP, official feeds).
