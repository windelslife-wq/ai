# Phase 14 — Broker Center: the connector boundary and its gates

Date: 2026-10-12 · Branch `arena/8de8de2e-ai` · Version 0.12.0 → 0.13.0
Row 13 of `docs/migration/UNFINISHED_MODULES.md`: *Broker Center and broker connectors.*

Row 13's instruction: *"Port the Node-facing connector boundary and health/demo gates;
verify MT5 against a real demo terminal before any real-routing claim."* The second half
cannot be satisfied here — there is no MetaTrader terminal in this sandbox — so it
constrains the first half: port the boundary and the gates, prove the gates refuse, and
make no routing claim.

## Scope

Source reconciled: `application/libraries/Aegis/Brokers/` — `BrokerConnector.php`
(the interface plus `BrokerManager`), `TradingConnector.php`, `BrokerDataNormalizer.php`,
`ConfiguredTradingConnectors.php` (318 lines: the generic connector plus nine subclasses),
`Mt5BridgeConnector.php` (262 lines), `DemoBridgeConfig.php` — together with
`application/controllers/Brokers.php`, the broker rows of `Api_system.php`, the ten
`register()` calls in `Aegis\Platform::__construct` (lines 68–78) and
`PortfolioRiskMonitor::brokerAlerts()`.

## What was ported

**The normalized data contracts** (`normalizer.js`). Nine of them — account, quote,
positions, pending orders, history, candles, and the three result shapes — plus the four
private validators behind them. This class is the reason a bridge cannot hand the
supervisor a payload it has to interpret: validation happens once, and a malformed
provider response is refused rather than passed along with a plausible-looking zero in it.
It refuses negative account values, an inverted quote, a candle whose high is below its
low, a non-positive stop, an unknown enum, and a timestamp it cannot parse.

Its error messages are **byte-identical to legacy's** (`"broker quote bid/ask is invalid"`,
not a rewritten sentence), and its timestamps use legacy's `gmdate('c')` shape rather than
the `…Z` shape the rest of this platform uses. Both choices are for one reason: the
normalizer is pure, synchronous and dependency-free on both sides, which makes it the
cheapest possible subject for the PHP↔Node differential harness that **F-26** has been
asking for since Phase 4. A message or format difference would fail every comparison on a
technicality. That harness is **not built yet** — see "Not claimed".

**The connector and its gates** (`connector.js`). The four-state ladder — `DISABLED` →
`NOT_CONFIGURED` → `DOWN` → `READY` — where only `READY` carries the bridge-reported
fields, so a caller cannot read an absent `orderSubmissionEffective` as `false`-but-present
on a connector that was never reached. And the safety model, unchanged from legacy:

* Nothing is enabled by default. A connector needs `_ENABLED`, a valid URL and a token
  even to be *read*.
* Order submission needs the local `_TRADING_ENABLED` flag **and** a bridge that reports
  `tradingEnabled: true`. Flipping our environment variable is not enough if the bridge
  itself refuses to trade.
* Non-demo accounts are refused unless `_LIVE_ALLOWED=1` is *also* set. Demo is the safe
  default; no provider is ever silently live, and the adapter never guesses whether an
  account is safe to trade.
* **Every write re-runs all of it against a force-refreshed probe.** A cached `READY` from
  four seconds ago is not a reason to place an order now. Reads may use the 5-second cache;
  writes may not.

`capabilities().orderSubmission` is *intent*; `status().orderSubmissionEffective` is
*permission*. Keeping those two separate is the whole point of the design, and a test
asserts they disagree in exactly the configurations where they should.

**The manager** (`manager.js`), whose `tradingConnector()` is the safety argument in four
lines: a connector must be order-capable **and** report `READY` **and** report
`orderSubmissionEffective === true`, or the answer is `null` and routing stays disabled.
Nothing else in the platform is given a connector directly.

**The roster** (`registry.js`): legacy's ten connectors, in legacy's registration order,
with legacy's environment variable names including the `AEGIS_` prefix, so an existing
cPanel environment carries across unchanged. All ten are registered on every boot and all
ten are disabled. Registering is not enabling.

**One read route** (`GET /api/v1/brokers`), gated on `trading.view`, carrying the
`PLANNED` honesty matrix that legacy showed only in its console view.

**The two broker notification types.** `PortfolioRiskMonitor::brokerAlerts()` ran inside
the same cron sweep Phase 12 ported, between the account checks and the transition diff.
It is now wired in, which takes `BROKER_CONNECTED` and `BROKER_DISCONNECTED` off NV-6 and
leaves **one** unpublished type (`SPORTS_MODEL_DRIFT`, row 14).

## Findings

### F-32 — the legacy system API authorized writes and left reads open

`Api_system::brokers()`, `mt5_account()`, `mt5_quote()`, `risk_limits()`,
`execution_preflight()` and `automation_limits()` make **no `requirePermission` call**,
while every write in the same controller is gated (`trading.control`, `trading.execute`).
`api_system/status` is in `PUBLIC_ACTIONS`, so connector health — including
`bridgeVersion`, `accountType` and `simulated` — was readable **anonymously**.

The most sensitive instance is `mt5_account()`, which returns the broker `accountId` (the
login), currency, balance, equity, margin, free margin and leverage to any signed-in user.
Escalation is trivial: read `status` anonymously to learn a bridge is `READY`, sign in with
any account, read the account snapshot.

This is **AV-1** (Phase 10, the audit trail) and **F-31** (Phase 13, the automation
envelope) again, and three instances across three phases is enough to state it as a
property of the legacy API rather than a sequence of oversights: **it authenticated
broadly and authorized writes only.** Fixed here rather than inherited — the Node route
requires `trading.view`, and the two MT5 read endpoints are not ported at all. The PHP
source is authoritative and unmodified, so **the gap is still live in legacy** and belongs
in the cutover decision (row 22).

### F-33 — the documentation gate could not see a composed variable name

`verify:install` and the F-14 test both scan `config.js` for literal dotted reads of the
environment object. Every licensed-feed and broker setting is read through a **composed**
name built from a prefix table, which the scan cannot see. The result: 21 licensed-feed
variables (`AEGIS_ETF_DATA_*`, `AEGIS_FUTURES_DATA_*`, `AEGIS_OPTIONS_DATA_*`) had shipped
undocumented with the gate reporting green, and the 50 broker variables added by this phase
would have done the same.

Found by strengthening the gate rather than by reading it: the test now enumerates
prefix × suffix from the config's own exported tables, and immediately reported the 21
pre-existing gaps. All 71 composed names are now documented, and the enumeration is derived
from `brokerEnvNames()` so a future irregular prefix cannot drift from what the gate checks.
**An undocumented knob is an unconfigurable one**, which is the principle F-14 exists to
enforce — a gate with a blind spot enforces it only for the variables that happen to be
written literally.

## Divergences

**BC-1 — timestamps use legacy's `gmdate('c')` shape** (`2026-10-12T01:02:03+00:00`), not
this platform's `…T01:02:03.000Z`. The one module where an offset-suffixed, second-precision
instant is the right answer, for the differential-test reason above.

**BC-2 — a non-object row in a list payload is silently dropped**, as legacy dropped a
non-array one. Arguably wrong: a bridge returning `[position, "garbage"]` normalizes to one
position. Preserved because changing it would be a behaviour change disguised as a bug fix.

**BC-3 — one connector factory instead of two classes, using the MT5 class's granular gate
messages.** Legacy's generic connector refused a blocked order with
`"… safety gates failed — order refused"`; its MT5 connector named which of six gates failed.
Node names the gate for every connector, because a message that does not say which flag is
missing gives an operator nothing to act on. The gate *set* is identical, so nothing that
legacy refused is now accepted.

**BC-4 — the health probe carries no token**, following the MT5 connector rather than the
generic one (which sent the token when non-empty). `/health` does not require it, and
sending a bearer credential to an endpoint that does not check it widens that credential's
exposure for no benefit. A bridge that *does* require auth on `/health` will report `DOWN`,
which is fail-closed.

**BC-5 — one symbol pattern, `/^[A-Z0-9._-]{1,32}$/`, everywhere.** Legacy's generic
connector accepted `/^[A-Z0-9._:-]{1,64}$/` while its MT5 connector and the normalizer both
accepted the narrower one. That mismatch was a latent defect: a symbol containing `:` passed
the connector's own gate and was then **refused by the normalizer applied to the response** —
so the request failed *after* it had been sent to the bridge. Node refuses it before sending.

**BC-6 — no URL, query string or secret can appear in a status or an error message.** A
transport failure becomes a generic `"… request failed"`; a provider-supplied `error` is
passed through but truncated to 200 characters. Legacy did the same, and a test asserts the
serialized HTTP response contains no token, no loopback address and no `Bearer`.

**BC-7 — `modifyOrder` requires positive values on every connector.** Legacy's MT5 connector
accepted *any* numeric here, including zero and negatives, while its generic connector
required positive. A non-positive stop loss reaching a real bridge is a malformed order.

**BC-8 — `allStatus()` is async.** `status()` performs a health probe, and on this platform
that is non-blocking I/O rather than a blocking `file_get_contents`. Callers must await it;
the shape is unchanged.

**BC-9 — `mt5-bridge` declares no market classes.** Legacy's MT5 connector declared none
(unlike every generic subclass), and Node keeps the list empty rather than inventing one:
which classes a real MT5 account offers is a property of that broker's symbol list,
discovered from the bridge, not a claim this platform should assert up front.

**BC-10 — the `PLANNED` matrix and the `routable` flag move into the API response.** Legacy
computed both in `Brokers::index()` for its console. No ported module has a console screen
(F-29), so leaving them there would have lost the distinction between "scaffolded, never
verified" and "working" — the distinction this module exists to make.

**BC-11 — the public status surface never probes.** `/api/v1/system/status` is
unauthenticated, and its invariant is that an anonymous caller cannot make this server do
work or reach an outbound host. Answering `brokerConnectorAvailable` truthfully requires a
probe, so that surface keeps the conservative `false` and adds a config-only
`brokerConnectorsConfigured` count, with the reason string pointing at the authenticated
`routable`. Understating live-trading capability on a public endpoint is also the safe
direction to be wrong in.

**BC-12 — the sweep probes the registry once.** Legacy called `allStatus()` twice per scan
(once in `brokerAlerts`, once when persisting `brokerStates`); its 5-second cache made the
second call free. Node calls once and threads the result, so a sweep cannot report a
disconnect against one probe and persist a different state from another.

**BC-13 — a disconnect is an alert for exactly one cycle.** Legacy added
`BROKER_DISCONNECTED` to the alert list only on the `READY → DOWN` run, so on the next run
the key is gone and the diff reports it *cleared* — while the connector is still down.
Preserved, not fixed: the durable record of an outage is the audit event and the
notification, not the alert list. Tested across three runs so the behaviour is pinned rather
than incidental.

**BC-14 — bridge redirects are refused.** Legacy's stream context followed redirects with
the `Authorization` header attached, so a bridge that redirected to a third host would have
sent the token there. Node's transport sets `redirect: "error"`. A tightening, recorded
because it changes what a misconfigured bridge does: it reports `DOWN` instead of silently
following.

**BC-15 — a bridge call is never retried.** The market-data client retries with backoff
because a provider read is cacheable; a bridge call is a state-changing RPC, and retrying a
`POST /v1/orders` that timed out is how an order gets placed twice. Legacy made one attempt
too, so this is parity, but it is stated because the two HTTP clients in this codebase now
differ deliberately.

## Deliberately not ported

**The simulated demo bridge** (`DemoBridgeConfig`, `Brokers::sim_toggle()`). It is what let
legacy run `propose → 15-step pipeline → approve → route → simulated fill` offline, by
writing a marker file its dev front controller turned into `AEGIS_MT5_*` environment
variables pointing at an in-process mock on loopback. Porting it would create the first
order-routing path in the Node platform — a decision that deserves its own phase and
explicit sign-off, not a side effect of a health-gate port — and it needs a long-lived
loopback listener, which sits badly with a cPanel/Passenger host that offers no persistent
worker. Its absence is why `simulated: true` can be *reported* by a connector here but
nothing in this repository can produce it.

**`GET /api/brokers/mt5/account` and `/mt5/quote`.** Both read a live bridge; there is no
verified adapter to read. A route that can only answer 503 is a worse surface than no route,
and the connector methods behind them exist and are tested against an injected transport.
When a real bridge is verified, these are two thin handlers.

**`automationModeGate()`, `automationLimits` and the two automated modes.** Phase 13
deferred these to row 13 (ES-6) on the understanding that the limits arrive with the modes
and are enforced from the first commit. Row 13's own acceptance text asks for the connector
boundary and the health/demo gates, and `automationModeGate` is a gate on *enabling
`FULLY_AUTOMATED`* — which cannot be satisfied while no connector can route. Porting it now
would produce a gate that always reports the same two reasons, which is the same
settable-but-inert shape as F-30. It stays unported and is now blocked on a verified adapter
rather than on this module's scope.

**Broker-bound execution steps 4–9 and 12–15.** Phase 13 assigned these to row 13, and they
remain unported: with no verified connector, `tradingConnector()` returns `null` and every
one of those steps has nothing to read. The `execution` module is unchanged in this phase
except for one reported field.

## Verification

| Gate | Result |
|---|---|
| `npm test` | **689 / 689** (was 616; **+73** across three new files) |
| `npm run verify:install` | **29 / 29**, **69** documented config variables (was 67) |
| PHP oracle (`node runtime/run-tests.mjs`) | **367 / 367**, 0 PHP paths modified |
| API routes | **81** (was 80; +1) |
| Admin routes | **7** (unchanged — the broker route is not an admin surface) |
| Persistence contract | **86** methods (unchanged — no new persistence) |
| Migrations | **001–010** (unchanged — no new table) |
| Module ledger | **17** rows; 9 ported / **4 partial** / **4 not-ported** (`brokers` moved) |
| Version | 0.12.0 → **0.13.0** |

No migration and no contract method: connector state is configuration and probe results,
neither of which is persisted. The only new persisted field is `brokerStates` inside the
existing `PORTFOLIO_RISK_STATE_KEY` job-state document, exactly where legacy kept it.

Three new test files, 73 cases:

| File | Cases | Covers |
|---|---|---|
| `test/brokers.test.js` | **57** | The nine data contracts and every refusal in them; the four-state ladder; the gate table (nine configurations, each asserting the verdict *and* that `capabilities()` disagrees with it where it should); every write refused at every gate **with an assertion that no order request reached the transport**; the forced re-probe on writes and the cache on reads; the unauthenticated health probe; secret non-leakage; order-body validation and the `action` wire key; ticket validation as a path segment; clamping; the manager's routing verdict in five configurations; duplicate registration; per-connector degradation; the ten-connector registry performing **zero I/O**; the planned matrix; and roster↔config agreement including MT5's irregular variable names |
| `test/brokers_http.test.js` | **6** | 401 anonymous, 403 without `trading.view`, 200 with it (F-32); the default body — ten `DISABLED` connectors, `routable: false`, nine `PLANNED`, no token or URL in the serialized response; the route inventory proving exactly one broker route, no write route, no simulated-bridge toggle, and that every order-shaped route belongs to `/api/v1/paper`; the public status surface; a configured-but-unreachable bridge reporting `DOWN` while `routable` stays false; and the config gate refusing a remote plain-HTTP URL, credentials in a URL, a non-boolean flag and an out-of-range timeout |
| `test/broker_transitions.test.js` | **10** | Ten disabled connectors silent across two runs; `READY → DOWN` audited, broadcast critical, and joining the alert list with both dedupe keys asserted distinct; `DOWN → READY` audited and notified as info with no alert; the one-cycle alert then clear (BC-13); unread-dedupe suppressing a second disconnect while both are audited; a dry run probing but writing nothing; **one** `allStatus()` call per sweep (BC-12); no registry meaning no broker fields at all, so Phase 12's report shape is unchanged; a throwing registry degrading to `brokerError` without failing the sweep; and `NOT_CONFIGURED` / `ERROR` / `DISABLED` never counting as a disconnect |

Two defects were found by these tests and fixed before commit, rather than by reading the
code:

* **D-20** — `read()` refused an array `data` payload. Legacy checked PHP's `is_array()`,
  which is true for a list *and* a map; the four list endpoints return a JSON array as
  `data`, so the port would have rejected **every successful list read**. Caught by a test
  that asked for `history` from a bridge answering `{ok: true, data: []}`.
* **D-21** — the config composed MT5's trading flags as
  `AEGIS_MT5_BRIDGE_TRADING_ENABLED`, but legacy reads `AEGIS_MT5_TRADING_ENABLED` (no
  `_BRIDGE`), and `DemoBridgeConfig` writes exactly that name. A uniform composition rule
  would have left the only connector that can actually work permanently switched off, with
  the documented variable silently doing nothing — F-30's shape again, in configuration.
  Caught by a test that set the legacy name and asserted the flag took effect.

## Not exercised, and therefore not claimed

* **No adapter has spoken to its provider.** Every gate test runs against an injected
  transport. That is how legacy tested its own bridge, and it is why the gates are provable
  here — but it is not evidence that Binance, Alpaca or a real MT5 terminal answers this
  contract. Nine of the ten connectors remain `PLANNED` in their own words, and the MT5
  bridge remains *"NOT yet verified against a real MetaTrader terminal"*.
* **Row 13's own acceptance criterion is unmet and cannot be met here.** "Verify MT5 against
  a real demo terminal before any real-routing claim" requires a Windows host running MT5.
  **No real-routing claim is made anywhere in this phase**, and `routable` is false on every
  host that has not deployed and verified a bridge.
* **No order has been placed, by any path.** `placeOrder` is tested to *refuse*, and to
  build a correct body against a fake transport. Nothing in this repository can reach a
  broker, and the one test that configures a connector points it at loopback port 9, where
  nothing listens.
* **The differential harness still does not exist (F-26).** This phase made it cheap — the
  normalizer is pure on both sides, its messages are byte-identical, and its timestamps now
  match — but no test runs one payload through PHP and Node and compares. That is the
  highest-value remaining piece of F-26 work and the natural next step for this module.
* **The simulated bridge was not ported**, so the offline end-to-end demo legacy offered
  (`propose → approve → route → simulated fill`) does not exist here, and `simulated: true`
  is a state this platform can report but never produce.
* **Concurrency and multi-process behaviour are unchanged and untested** (F-24). The sweep
  holds a `wf_job_locks` row, but broker probing adds an outbound call inside that lock, and
  a host whose bridges are slow now spends more of its lock TTL waiting. The 8-second budget
  times ten connectors is bounded but not measured against a real deployment.
* **No real MySQL** (F-15). Nothing in this phase adds SQL, so the gap is unchanged rather
  than widened.

## Next

* **The differential harness for `BrokerDataNormalizer`** (F-26). Both implementations are
  pure; one table of malformed payloads run through PHP and Node would close the oldest open
  finding in the cheapest way available.
* Row 13's remaining item: verify the MT5 bridge against a real demo terminal, on a real
  host, before any routing claim. Everything after that — the broker-bound execution steps
  4–9 and 12–15, `automationLimits` **with** enforcement, `automationModeGate`, the two
  automated modes, and the two MT5 read endpoints — is unblocked by that verification and
  not by more code here.
* Row 14 (sports) owns the last NV-6 type, `SPORTS_MODEL_DRIFT`, via `ModelDriftMonitor`.
* **F-32 in legacy is still open.** The PHP application is authoritative and unmodified, so
  if it remains reachable after cutover, `mt5_account`, `automation_limits`, `risk_limits`
  and `events` are still readable by any signed-in user there. Row 22 must decide.
* **F-30 is still open** and now has a third instance of its shape to point at: D-21 was a
  variable that looked settable and was not read. The minimum acceptable action remains
  removing `maxCorrelatedPositions` from the API rather than shipping a limit nothing
  enforces.
