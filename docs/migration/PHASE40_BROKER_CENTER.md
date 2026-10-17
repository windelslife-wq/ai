# Phase 40 — the Broker Center console (row 13)

**Status:** complete · 2026-10-17 · branch `arena/046b29ac-ai`

`/app/brokers` is the port of `Brokers::index` → `views/brokers/index.php` (105 lines) over the
module's only broker route, `GET /api/v1/brokers` (`trading.view`), plus `GET /api/v1/trading/mode`
for the governance strip. With it **row 13 has no screen left**, and **F-29's residual list is one:
the journal**.

This is the first console in the series whose legacy page is mostly *controls the port deliberately
does not have*. Legacy drew a simulated-bridge switch (`POST /brokers/sim-toggle` →
`Brokers::sim_toggle()`, writing the marker file `DemoBridgeConfig` turns into environment
variables), and two read-only MT5 panels (`Api_system::mt5_account()` and `mt5_quote()`, both
**unauthenticated** — F-32). The port registers none of the three. The screen carries legacy's own
sentences for each, then the reason it is absent, rather than drawing a switch that turns on nothing
or a table that would always be empty.

The three statements, all on the page:

1. **The screen is one read and nothing else.** `routable` is the server's boolean, not the page's
   inference; every connector state, capability flag and PLANNED row comes from the same response.
   There is no enable, no toggle and no order button, because there is no such route — and the
   reads panel lists the two routes the screen uses beside the three legacy surfaces it does not.
2. **The simulated bridge is absent, with its switch.** The marker-file mock `DemoBridgeConfig`
   writes has no equivalent in this platform; porting the switch without the bridge would advertise
   a capability that does not exist. The panel still reports the MT5 adapter's own `simulated` flag,
   so a host that has one is described truthfully, and legacy's two button labels appear as text.
3. **The MT5 account and quote panels have no payload because they have no route.** Both legacy
   reads were unauthenticated (F-32), and a read that can only answer 503 on a host with no bridge
   is worse than no route. The quote form's button is `disabled` with
   `title="No MT5 quote route exists in this port"`; neither panel draws an empty table that would
   look like a successful read with no data.

## Scope

| | |
|---|---|
| Legacy | `views/brokers/index.php` (105 L), `controllers/Brokers.php` (86 L — `index` and `sim_toggle`), `Api_system::brokers()` / `mt5_account()` / `mt5_quote()` (`Api_system.php` :91–120) |
| Node routes used (both already present) | `GET /api/v1/brokers` and `GET /api/v1/trading/mode`, both `trading.view`. **No broker write route exists**; the port's route count is 146 before and after, with exactly one under `/api/v1/brokers` |
| New files | `client/src/brokers.js`, `test/client_broker_console.test.js` (16 tests), this record |
| Edited (client) | `client/src/views.jsx` (`BrokerCenterView`, its import block, the nav entry), `client/src/api.js` (one wrapper), `client/src/App.jsx` (route + view map), `client/src/styles.css` (`.broker-*`, one responsive rule) |
| Edited (server) | `src/modules/platform/health.js` — the `brokers` label names the console and keeps the module's whole remainder in the same sentence; the `execution` label's "brokers and the journal remain" becomes "brokers left that list in Phase 40, and the journal remains". **No route, no contract, no service, no migration, no repository method, no permission, no dependency** |
| Edited (tests) | `test/client_dashboard.test.js` — `/app/brokers` leaves F-29's absence list and joins the landed list |

## The screen

- **The routing banner** is one of legacy's three arms, chosen from two facts in the response:
  `routable` and the MT5 adapter's `simulated` flag. `routingActiveSimulated` is only reachable when
  the server says both are true; the disabled arm names the audit code (`ROUTING_BLOCKED`) legacy's
  sentence named. The server's own `notice` sits under it, attributed to the server.
- **The governance strip** reads `GET /trading/mode`: the mode, the kill switch, synthetic paper
  prices and the platform's simulation-only posture. Nothing on the strip is editable.
- **The summary line** counts the rows it is about to draw — total, READY, configured — so it cannot
  disagree with the cards below it.
- **The simulated-bridge panel** carries legacy's title and `DEMO · SIMULATION` badge,
  `SIMULATION RUNNING` when the MT5 adapter reports `simulated`, and legacy's blocked sentence
  otherwise. The absence row names `/api/v1/brokers/sim-toggle` and both button labels.
- **The ten connector cards** are drawn in the API's order — the registry's roster order, which is
  legacy's registration order. Each card carries the adapter id and its badge, `configured`, the
  adapter's own message, the four capability rows and the reason. Bridge fields
  (`bridgeVersion`, `bridgeTradingEnabled`, `accountType`, `orderSubmissionEffective`) are printed
  **only when the response carries them**, which is only in READY; a non-READY card never shows
  `undefined`.
- **The MT5 panels** carry legacy's heading, empty-state sentence and row labels first, then this
  port's reason, then the absent route. The account panel adds the MT5 adapter's current state when
  one exists, because "no account read exists" and "the adapter is DOWN" are different facts.
- **The PLANNED table** is the nine registry entries with the controller's `PLANNED` details
  verbatim, in a table, followed by the sentence that the Broker Center is one read and nothing else.
- **The reads/absences panel** lists the two routes with their permission and the three legacy
  surfaces with their `why`, plus the five-state ladder in one line.

## Divergences, stated rather than discovered

- **The roster is the registry's, not the view's.** Legacy's page hard-coded its own connector list;
  this screen renders the API's object in insertion order, so a roster change cannot leave the page
  drawing a connector the server does not have. The PLANNED matrix keeps the controller's wording
  (`MetaTrader 4`, `Contract adapter scaffolded; …`), while the card titles are the adapter ids
  (`mt4-bridge`), which is what the status payload keys on. Where a registry display name differs
  from the controller's label (`ib` = "Interactive Brokers"), the matrix uses the controller's row
  and the screen does not pretend the two vocabularies are one.
- **A fifth state.** `manager.allStatus()` catches a throwing adapter and answers `state: "ERROR"`;
  the port keeps legacy's four states and tones (READY green, DOWN red, DISABLED gray,
  NOT_CONFIGURED amber) and renders `ERROR` neutral with its reason on the card, **never green**.
  An unknown state is neutral for the same reason.
- **`orderSubmission` and `orderSubmissionEffective` are different facts.** The first is the local
  intent flag, the second is the bridge-verified answer and the only one the supervisor trusts. The
  capability row prints the intent flag; the bridge field prints the verified answer when READY
  carries it; the caption under the grid says which is which and that the two disagreeing is the
  normal state of a scaffolded adapter.
- **The state ladder's order is legacy's.** `DISABLED → NOT_CONFIGURED → DOWN → READY` with the
  bridge fields only in READY is legacy's own gate; the screen states the ladder rather than sorting
  the cards into a tidier order that would imply a different one.

## Tests

`test/client_broker_console.test.js` — **16 tests**, hermetic (file adapter,
`MARKET_DATA_REAL_PROVIDERS=0`, no network). Five of them drive the real app over HTTP:

- copy: every `BROKERS_COPY` string is asserted inside the PHP page, markup- and entity-insensitive;
  the two simulation flash sentences against `Brokers.php` raw (the file is PHP, so the suite strips
  `<?php` before any tag stripping); the account and quote row labels; and the nine PLANNED details
  against the controller's own `PLANNED` matrix. The port's own sentences live in
  `BROKERS_PORT_COPY` and are asserted not to claim a capability the API lacks;
- the ladder: legacy's four states and tones are parsed out of the PHP and compared; `ERROR` is the
  port's fifth and is neutral; an unknown state is neutral; the summary counts come from the rows;
- the roster: ten connectors in the roster's order; nine PLANNED rows from the registry; a card never
  prints a bridge field the adapter did not report; the banner is chosen from `routable` and
  `simulated`; the simulated panel reports the adapter's flag and offers no control; both MT5 panels
  are `null` and the screen says why; the formatting helpers return an em dash for a gap and a real
  zero for zero;
- routes: the one declared broker read is registered with `trading.view`, and the three legacy
  surfaces are **absent** from `/api/v1/system/routes` and answer 404; the inventory is 146 routes
  with exactly one `/api/v1/brokers` entry;
- declaration: the route, the render key, the nav entry and the presence check are where the shell
  looks for them; the view holds no `POST`/`PUT`/`PATCH`/`DELETE`, no button handler, and its quote
  button is disabled with its title; each absence is named by its route;
- live: the read returns ten connectors, nine planned rows, `routable: false` and no token, loopback
  address or `Bearer` anywhere in the serialized body; a configured bridge on loopback port 9 (where
  nothing listens) reports **DOWN** while `routable` stays false and the banner still says DISABLED;
- served shell: `/app/brokers` answers 200 `text/html` and the built bundle carries the screen's
  strings and no request to `…/sim-toggle`.

## Gates

- `npm run check:workforce` → **1164 / 1164** (1148 before: +16 console tests).
- The client suites together → **187 / 187** (171 + 16).
- `npm run typecheck` → clean; `npm run test:contracts` → 12/12.
- `npm run build:workforce-client` → `index-DJJMqW7Q.js` 576.08 kB / 153.31 kB gzip,
  `index-BhV6cGTA.css` 45.68 kB / 9.59 kB gzip.
- `npm run verify:install -- --require-bundle` → **30 / 30**.
- Live probe on a demo host reseeded from scratch (`:4020`, file store, admin `root`): **22 / 22** —
  sign-in; `GET /api/v1/brokers` returns exactly `{brokers, planned, routable, notice}` with ten
  connectors in roster order, nine PLANNED rows, `routable: false` and the server's notice; all ten
  DISABLED on a default host; the MT5 capability set; the controller's first PLANNED detail; no
  token or secret in the serialized body; anonymous **401**; `POST /brokers/sim-toggle`,
  `GET /brokers/mt5/account` and `GET /brokers/mt5/quote` **404**; `GET /trading/mode` reports
  `ANALYSIS_ONLY` with the kill switch ACTIVE and synthetic off; `/app/brokers` **200** `text/html`;
  the bundle carries `BROKERS · ROW 13`, the PLANNED heading, the MT5 account path and the nav label;
  the route inventory is **146** with exactly one broker route under `trading.view`. A second host
  started with `AEGIS_MT5_BRIDGE_ENABLED=1` against `http://127.0.0.1:9` reported the MT5 connector
  **DOWN**, `configured: true`, `routable: false`, the DOWN notice, and no trace of the probe token.
  The probe registered one ordinary member account (`nobody40`), which the seed already grants
  `trading.view`; nothing else was written.
- **Not run:** a real browser (no rendering, no click-through), real MySQL/MariaDB (F-15), any live
  provider, SMTP, cPanel/Passenger, and still no PHP↔Node numeric diff (F-26).

## After this phase

**F-29's residual list is one: the journal (row 18).** **Module counts are unchanged — 10 ported /
5 partial / 2 not-ported:** the console adds a screen over a route that already existed, and
`brokers` remains `partial` for reasons that are not the screen — no adapter verified against a
provider, no order routing, no simulated bridge, and no MT5 account/quote read. The console states
all four.

What row 13 still carries, unchanged: MT5 validation against a **real demo terminal** before any
real-routing claim; the two MT5 read endpoints, which arrive only with a deployed bridge; the
simulated demo bridge, deliberately not ported; and the decision about F-32's legacy-side reads at
cutover (row 22). `automationLimits`, `automationModeGate` and the automated modes stay row 12's,
permission-gated from their first commit (F-31).

Next: the **journal** console (row 18), the last screen F-29 counts as absent.
