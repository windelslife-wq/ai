# Phase 27 — The console screens: notification inbox, audit browser, portfolio optimizer (row 3)

> **Status: landed on `arena/ef756273-ai`.** This record covers the first three console screens
> and the honesty sweep that had to move with them. It narrows **F-29** — "no ported module has a
> console screen" — to the sports and lottery consoles, which are now the whole remainder. It
> adds no HTTP route, no migration and no table: the three APIs existed, were tested, and had
> nothing to click. The previous record is [`PHASE26_FILE_ATOMICITY.md`](PHASE26_FILE_ATOMICITY.md).

## 1. What this phase is

Row 3 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) named three ported APIs with **no screen
at all** — `GET /api/v1/notifications` (Phase 9), `GET /api/v1/admin/audit` (Phase 10) and
`POST /api/v1/portfolio/optimize` (Phase 11). This phase builds their screens in the workspace SPA.

| Screen | Route | Permission | Endpoints it renders |
|---|---|---|---|
| Notification inbox | `/app/notifications` | any signed-in member (`system.authenticated`) | `GET /api/v1/notifications`, `POST …/:id/read`, `POST …/read-all` |
| Audit browser | `/app/admin/audit` | `identity.users.view` | `GET /api/v1/admin/audit` |
| Portfolio optimizer | `/app/portfolio/optimizer` | `trading.view` | `POST /api/v1/portfolio/optimize` |

Files: `client/src/screens.jsx` (the three screens), `client/src/contracts.js` (the mirrored
vocabularies), `client/src/api.js` (the five client calls), `client/src/views.jsx` (navigation
entries and the reworked module grid), `client/src/App.jsx` (three exact-path routes),
`client/src/styles.css` (nine classes), and `test/console_screens.test.js` (the ledger below).

The screens add no authority of their own. Each route's permission is the permission its endpoint
enforces, and the shell's checks are presentation only — the API re-checks and refuses with 403
regardless of what the browser rendered.

## 2. The screens render the server's facts, not a sentence about them

Four dishonest-by-omission failures were available here, and each is closed by binding the screen
to the value the server already sends:

- **Delivery.** The inbox does not claim a delivery channel exists and does not quietly imply one
  by silence: it reads `deliveryChannels` / `emailDeliveryAvailable` from
  `GET /api/v1/system/status` and states that an alert is stored and read in-product only. If a
  transport is ever ported, the sentence changes with the value instead of outliving it.
- **Immutability.** The audit browser renders the server's own `meta.mutable: false` and echoes
  `meta.filters` — the filters the server actually applied — rather than promising read-only
  behaviour in prose the API could outgrow.
- **Research-only.** The optimizer renders the server's `notice` and repeats the structural fact
  that no order path exists. It has no client-side path to one either: `api.js` declares exactly
  one portfolio call, and it is the optimize POST.
- **Provenance.** Every asset row carries its `provenance.source`, and a synthetic series is
  labelled **SIMULATION** on screen next to the weights it produced. A demo host cannot show
  generated prices as observed ones.

The audit screen also refuses the two silent-widening traps the API refuses: a window value that
is not a canonical UTC instant is rejected by the server (`INVALID_AUDIT_WINDOW`), so the quick
ranges write canonical instants into visible fields, and the screen says a timezone offset is
refused rather than guessed at.

## 3. The module grid stopped keeping its own copy — a real staleness bug

`ModuleCards` hardcoded its own status list, and it had gone **false**: sports and lottery were
still shown as "Not yet ported to Node / MIGRATION BACKLOG" years-equivalent after Phases 19–25
ported them to `partial`, and every other module read "API ported · no console" after this phase
gave three of them screens. An understatement of that kind is how a finished module gets
re-ported.

The grid now renders from `GET /api/v1/system/status` → `modules` (the server's `MODULE_STATUS`)
and keeps only presentation text keyed by module key: state comes from the ledger, a screen link
appears when one exists, and a module without a screen says `API ONLY · NO CONSOLE SCREEN`.
`test/console_screens.test.js` asserts every module the server reports has a card, that
`MODULE_CARDS` contains no state vocabulary at all (`ported`, `partial`, `not-ported`, `state:`),
and that the grid really does fetch the ledger.

## 4. The ledger test (`test/console_screens.test.js`)

Six tests, no browser, all machine-checked against the live server:

1. **Vocabularies.** Every client pick-list (11 notification types, 3 severities, audit sorts and
   directions, 9 market classes, 4 timeframes, 2 objectives, and the asset/history bounds) is
   compared entry for entry against the module that validates it. A drifted copy fails here
   instead of producing a 400 in an operator's browser.
2. **Endpoints.** `client/src/api.js` is parsed for every `api(...)` call — path and method,
   template segments normalized to `:param` — and all 26 must resolve to routes in the live
   inventory from `GET /api/v1/system/routes`. No screen can be written against an endpoint that
   was never registered.
3. **Authority.** Each screen's declared permission must equal the permission its endpoint
   enforces, or be absent exactly when the endpoint enforces only `system.authenticated`; every
   permission named anywhere in the shell must exist in the seeded `PLATFORM_PERMISSIONS`
   catalogue.
4. **Navigation.** The three entries exist, are locked in the nav exactly as their route guards
   them (locked, never hidden), and every nav target resolves to a declared route.
5. **Ledger coherence.** One card per reported module, no hardcoded state, and a `STATE_LABEL`
   mapping covering every state the server can report.
6. **Binding.** The screens read `deliveryChannels`, `meta.mutable`, the server's `notice` and
   per-asset `provenance`; and every `endpoints.*` key a screen calls is declared in `api.js`.

## 5. Labels moved with the screens — removed, never re-labelled

Four module labels contained claims this phase made untrue, so the claims were **removed**:

- `audit`: "no console screen" → "and its workspace screen (read-only by construction …; no
  retention policy decided)". Retention is still undecided, so that half stays.
- `portfolioOptimizer`: "no console screen" → "with its workspace screen (weights only: no order
  path and no saved reports — a run is returned, not stored)".
- `notifications`: gained "with its workspace screen"; "no outbound delivery" is still true and
  stays.
- `sports` / `lottery`: "the console screens (F-29)" and "F-29, platform-wide" → "the two sports
  console screens" / "the two lottery console screens", each naming that F-29 was **narrowed by
  Phase 27** rather than lifted. `SPORTS_NOT_PORTED` and `LOTTERY_NOT_PORTED` carry the same
  correction in their `detail` strings.

`test/platform_findings.test.js`, `test/sports_http.test.js` and `test/sports.test.js` were
updated to assert the new text **and** to assert the old phrase is gone, so a stale claim cannot
return unnoticed. The comments in `src/modules/sports/{service,routes,sync}.js`,
`src/modules/lottery/service.js` and `src/modules/brokers/routes.js` that said "no ported module
has a console screen" were corrected for the same reason.

## 6. What this phase does not claim

- **No settings screens.** Row 3's other half (settings with their permissions) is untouched, as
  are the per-domain dashboards.
- **No sports or lottery console.** `sports` and `lottery` stay `partial` on the screens alone;
  `SPORTS_NOT_PORTED` still lists two areas, `LOTTERY_NOT_PORTED` still lists one.
- **No retention policy** for audit, notifications, `wf_analysis_runs` (R-27) or `wf_backtests`
  (R-28) — still one undecided decision, not four.
- **No delivery channel**: no mail, push or webhook. The inbox screen states the absence; it does
  not fix it.
- **No saved optimizer reports** and no history endpoint — a run is returned, not persisted.
- **No order path, anywhere.** The optimizer screen shows weights; the endpoint refuses
  `execute`/`amount`/`orderId`/`notional` by name.
- **Not verified in a real browser.** The screens were exercised through the Vite dev server
  against a file-store API (login, inbox, audit page, a synthetic optimization), and the production
  bundle builds — but no Lighthouse run, no cross-browser check and no automated DOM test exists,
  and the client has no test runner of its own.
- **No MySQL and no deployment.** F-15 is untouched: no migration ran against a real server.
- **No PHP↔Node numeric parity** (F-26) — the optimizer screen shows the port's numbers, and the
  port's numbers are still not diffed against PHP's.

## 7. Gates on this branch

- `npm test` → **981 / 981** across **68** files (975 / 67 before; +6 in the new file).
- `npm run verify:install` → **29 / 29** installation checks pass.
- `npm --prefix client run build` → clean build (22 modules, `public/app/` is a git-ignored
  artefact).
- The PHP tree is untouched; the legacy oracle remains at 367 / 367.
- Live rehearsal: file-store API (`STORAGE_ADAPTER=file`, seeded administrator) plus the Vite dev
  server; login, `GET /api/v1/notifications`, `GET /api/v1/admin/audit?limit=3` and a
  `allowSyntheticData: true` optimization all answered against the SPA's own proxy path.

## 8. User decisions still open

- **Settings screens** and the per-domain dashboards (row 3's remainder) — which come first.
- **One retention policy** for audit, notifications and the two report tables (R-27/R-28).
- **The outbound mail transport** — until it exists, no email-backed flow (including password
  reset, row 2) can be claimed.
- Whether optimizer runs should be **persisted**; if so, they join the same retention decision.
- Whether a client test runner (DOM-level) is worth adding, given the ledger test covers the
  screen↔API contract without one.
