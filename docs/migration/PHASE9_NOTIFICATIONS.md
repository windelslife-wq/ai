# Phase 9 — Operator notifications

**Date:** 2026-10-11 · **Branch:** `arena/8de8de2e-ai` · **Status:** ported (service, API and publishers); the console UI is not part of this phase

## Scope

Row 5 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) — *Notifications, audit
browser, feature/status reporting and system health* — and the `notifications`
entry the status surface reported as `not-ported`.

This phase ports the **notification module**: the notifier service, its
persistence on both adapters, the three legacy JSON endpoints, and the publishers
that make it carry real platform events. It does **not** port the audit browser,
the settings screens or the domain dashboards; those stay open under rows 3 and 5.

Ported from:

| Legacy source | Node target |
|---|---|
| `application/libraries/Aegis/Notifications/Notifier.php` | `src/modules/notifications/service.js` |
| `NotificationRepository` interface, `application/libraries/Aegis/Persistence/Repositories.php:213` | `REPOSITORY_METHODS` (6 new methods) |
| anonymous repository impl, `application/models/Aegis_model.php:774` | `src/db/notification-repository.js` + the file adapter |
| `notifications` table, `application/database/schema.mysql.sql:232` | migration `009_notifications.sql` → `wf_notifications` |
| `Api_system::notifications`, `notification_read`, `notification_read_all` | `src/modules/notifications/routes.js` |
| `Aegis/Platform.php:428` kill-switch alert | `paper.setKillSwitch()` publisher |
| `Aegis/ExecutionSupervisor.php` alert call sites | `execution/service.js` publishers |

## Behaviour preserved exactly

- **Unread dedupe.** While an UNREAD row carries a dedupe key, a new publish with
  that key is skipped. A recurring risk alert produces one unread badge until an
  operator acknowledges it, not one per scan. Acknowledging re-arms the key.
- **Broadcast visibility.** `user_id NULL` is visible to every signed-in operator;
  a targeted row is visible only to its recipient plus broadcast readers. An
  unauthenticated reader would see broadcasts only — though every ported endpoint
  requires `system.authenticated`, so that path is not reachable over HTTP.
- **Severity coercion.** An unrecognized severity becomes `info`, as the legacy
  repository's `in_array(...) ? ... : 'info'` did. It is not a 400.
- **Title truncation.** Titles are cut to 200 characters rather than rejected,
  matching `mb_substr`.
- **The `?unread=1` flag**, the 50-row default and the 200-row ceiling.
- **The legacy dedupe keys**, verbatim: `kill-switch:active`, `proposal:{id}`,
  `proposal:{id}:expired`, `proposal:{id}:filled`, `proposal:{id}:failed`.
- **The 404 on a read miss.** A missing, already-read or foreign id all answer
  `404 notification not found or already read`, so the route cannot be used to
  discover which notification ids exist.

## Divergences

| # | Divergence | Reason |
|---|---|---|
| **NV-1** | The `detail` payload is bounded (16 KB serialized, depth 4, 60 entries); truncation is recorded in the row as `truncated: true` | Legacy stored an unbounded `json_encode` into a LONGTEXT. A broadcast row is written once and read into every operator's inbox, so an unbounded payload is a storage and latency risk. Truncation is stated rather than silent |
| **NV-2** | Read state stays **global** to a broadcast row: one operator acknowledging a broadcast clears it for all | This is legacy behaviour, not a new decision — `read_at` is one column on the row. Per-recipient read state is a product change needing its own migration and approval, so it is recorded here instead of being quietly "fixed" |
| **NV-3** | One new type, `TRADING_MODE_CHANGED`, beyond the ten the PHP publishes | Legacy audited a mode change but never alerted one. The mode gates every proposal, so an operator watching the inbox should see it move. Declared as an addition in the test vocabulary, not smuggled into the legacy list |
| **NV-4** | Unknown `type` is a 400 against a declared vocabulary | Legacy had no type validation at all — any string up to 40 chars was stored. A typo would silently create a new alert category no UI knows how to render |
| **NV-5** | `EXECUTION_FAILED` wording names the paper risk/governance refusal, not a broker | This workflow has no broker. The legacy text read "Broker rejected proposal"; keeping it would advertise a capability that does not exist |
| **NV-6** | `PORTFOLIO_RISK`, `BROKER_CONNECTED`, `BROKER_DISCONNECTED`, `ROUTING_BLOCKED` and `SPORTS_MODEL_DRIFT` were in the vocabulary with **no publisher yet** (four have since gained one) | Their legacy publishers (`PortfolioRiskMonitor`, the broker health loop, `ModelDriftMonitor`) are not ported. Declaring the types now keeps the vocabulary complete; inventing publishers would fabricate alerts. **Superseded in part by Phase 12:** `PORTFOLIO_RISK` now has a real publisher — the scheduled portfolio risk sweep in `src/jobs/scheduled.js`, which raises it on alert *transitions* using the legacy dedupe key `<scope>:<code>` and broadcasts it as the system actor, exactly as `PortfolioRiskMonitor::recordTransitions` did. **Superseded again by Phase 13:** `ROUTING_BLOCKED` now has a real publisher too — `recordSubmissionRefusal` in `src/modules/execution/service.js`, which ports legacy's `routingBlocked()` helper. It fires when a submission to the paper engine is refused by governance (an active kill switch, or a trading mode that is no longer `PAPER_TRADING`), is published as a `warning` broadcast, and keeps legacy's **one-per-UTC-day** dedupe key `routing-blocked:<YYYYMMDD>` verbatim, so a platform that stays stopped alerts once a day instead of once per attempt. Legacy sent `ROUTING_BLOCKED` for all five of its routing refusals; Node sends it only for the governance one, because broadcasting "the platform cannot route today" when a caller merely submitted an undecided proposal would be misleading (ES-3). **Superseded a third time by Phase 14:** `BROKER_CONNECTED` and `BROKER_DISCONNECTED` now have publishers too, and they come from exactly where legacy published them — `PortfolioRiskMonitor::brokerAlerts()`, inside the same cron sweep Phase 12 ported. Only the two transitions legacy counted are counted: `READY → DOWN` audits and broadcasts a `critical` alert, `DOWN → READY` audits and notifies `info`, and **`DISABLED` is never counted** — so a default host with ten disabled connectors stays silent instead of raising ten critical alerts on its first run. Both dedupe keys are preserved verbatim and are *not* the same string: the alert key is `broker:<id>:BROKER_DISCONNECTED` while the notification dedupe key is `broker:<id>:disconnected`. **One** type remains unpublished: `SPORTS_MODEL_DRIFT`, whose legacy publisher `ModelDriftMonitor` belongs to row 14. See [`PHASE12_SCHEDULED_JOBS.md`](PHASE12_SCHEDULED_JOBS.md), [`PHASE13_EXECUTION_GOVERNANCE.md`](PHASE13_EXECUTION_GOVERNANCE.md) and [`PHASE14_BROKER_CENTER.md`](PHASE14_BROKER_CENTER.md) |

## Safety properties

**Publishing is not reachable over HTTP.** The module registers exactly three
routes — one read and two read-state transitions. There is no create, publish,
broadcast or delete route, so no caller can inject an alert that appears to come
from the risk engine. A test asserts the full list of registered
`/api/v1/notifications*` mutations rather than just the absence of one path.

**A notification can never break the action that caused it.** Publishers are
best-effort and run *after* the audit row has committed. `wf_audit_events` is the
evidence; the notification is the nudge. A host without migration 009 can still
move the kill switch, and the response reports `notification: null` rather than
implying an alert was raised. The reverse ordering would be worse — an alert about
a change that then rolled back.

**Notifications cannot act.** A notification is a message about something that
already happened. Nothing in this module can place an order, release the kill
switch or change a trading mode, and no publisher was given a callback into
governance.

### Defect found and fixed during the phase

**D-12 (deadlock).** The first implementation published from *inside*
`store.withPaperTransaction`. The file adapter serializes every mutation through
one queue and holds it for the whole transaction, so the notification write waited
on the transaction that was waiting on it. The suite did not fail — it **hung**,
past a 600 s timeout, which is how it was caught. Every call site now collects a
pending alert inside the transaction and publishes it afterwards through
`publishPending`. Both helpers carry a comment stating the rule, and the
post-commit ordering is asserted by the governance tests rather than assumed.

A second defect was found by the same tests: the service destructured the inbox
filter as `unreadOnly` while the route contract — and the legacy query string —
name it `unread`, so `?unread=1` silently returned an unfiltered page. Both names
are now accepted.

## Verification

Measured in this sandbox on 2026-10-11, Node v22.22.3:

- `npm test` (workforce-platform): **522 passed, 0 failed** — up from 482. 40 new
  tests across `notifications_store` (8), `notifications_service` (20) and
  `notifications_http` (12).
- `npm run verify:install`: **29/29**, with the migration check now listing
  `009_notifications.sql` and `store requires 9`. 64 config variables documented —
  this phase adds **no configuration**, deliberately: the dedupe window, the
  payload bounds and the type vocabulary are code constants, because making safety
  parameters settable by environment would let a host silently weaken them.
- Legacy PHP oracle (`node runtime/run-tests.mjs`): **367 passed, 0 failed**.
  `git status` shows no change under `application/`, `system/` or `tests/`.
- Platform route count **75 → 78**; repository contract **72 → 78** methods;
  migration set **001–008 → 001–009**; Node schema **22 → 23** tables; file-store
  entities **20 → 21**.
- `/api/v1/system/features` now reports `notifications: "ported"`;
  `not-ported` count **6 → 5** (brokers, sports, lottery, language learning, lead
  discovery), `ported` **6 → 7**.

### Not exercised, and therefore not claimed

- **No real MySQL/MariaDB.** `notification-repository.js` is covered by a
  recording executor that asserts the SQL text and bound values; it has never been
  executed against a server. F-15 is unchanged. The `(user_id IS NULL OR user_id = ?)`
  predicate and the two indexes are unmeasured on a real optimizer.
- **No delivery.** There is no outbound mail, webhook, SMS or push channel. The
  module says so in its own status snapshot (`emailDeliveryAvailable: false`,
  `deliveryChannels: []`) and in the `MODULE_STATUS` label.
- **No UI.** The legacy console (`/notifications`, `views/notifications/index.php`)
  is not ported. That is app-shell work (row 3), and F-29 still stands: no ported
  module has a workspace console. *(Updated by Phase 27: the workspace screen is
  ported at `/app/notifications`, so F-29 no longer covers this module — see
  [`PHASE27_CONSOLE_SCREENS.md`](PHASE27_CONSOLE_SCREENS.md).)*
- **No retention.** `wf_notifications` grows without bound and has no delete path,
  matching the legacy table. This is the same open question as R-27
  (`wf_analysis_runs`) and R-28 (`wf_backtests`) and needs one decision, not three.
- **No PHP↔Node value-for-value diff.** The behaviours above were ported by reading
  the PHP and asserting the same rules in Node tests, not by comparing outputs from
  both runtimes. F-26 remains open.
- **No concurrency proof.** Cross-worker behaviour of the conditional `UPDATE`
  (`read_at IS NULL`) is argued from the SQL, not observed under contention.

## Next

Row 5 is now partly closed: notifications are ported, the feature/status matrix
already was. The **audit browser** and **settings screens** remain, along with
security-event retention. In dependency order the outstanding gates are unchanged —
validate migrations 001–009 against real MySQL/MariaDB, then rehearse
cPanel/Passenger deployment, backup/restore and rollback.
