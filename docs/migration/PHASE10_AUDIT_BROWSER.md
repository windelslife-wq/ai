# Phase 10 — Audit browser

**Date:** 2026-10-11 · **Branch:** `arena/8de8de2e-ai` · **Status:** ported (read-only browser API); the console screen and the retention policy are not part of this phase

## Scope

The second half of row 5 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md).
Phase 9 ported notifications; this phase ports the **audit browser** — the
permissioned, filterable, read-only view over the platform's own trail.

Node already *wrote* audit events (every ported action does) and already exposed
the caller's own trail at `GET /api/v1/account/activity`. What was missing is the
review surface: there was no way for an administrator to answer "who did what, to
which entity, in what window" across the whole platform, and — the part that
actually blocks a review — **the read view did not include the actor at all**.
`listAuditEvents` projected `id`, `action`, `entityType`, `entityId`, `details`
and `createdAt`. An audit trail that cannot say who acted is not evidence, so the
gap was not merely a missing page.

Ported from:

| Legacy source | Node target |
|---|---|
| `Api_system::events()` (`api/events`, `api/events/(:num)`) | `GET /api/v1/admin/audit` |
| `AuditRepository::recent()` / `emit()`, `Aegis/Persistence/Repositories.php:37` | `listAuditEvents` (extended, no new contract method) |
| `audit_logs` table, `schema.mysql.sql:173` | `wf_audit_events` (migration 001 — **no new migration**) |

This phase adds **no migration and no contract method**. It extends the options
and the projection of an existing method, and uses `ix_wf_audit_entity`
`(entity_type, entity_id, created_at)`, which migration 003 created and nothing
had queried until now.

## What the endpoint does

`GET /api/v1/admin/audit` — paginated, filterable, read-only.

| Filter | Semantics |
|---|---|
| `action` | exact `action_key` **or** its dotted children (`governance` matches `governance.kill-switch.activated`), the legacy prefix behaviour |
| `entityType`, `entityId` | served by `ix_wf_audit_entity` |
| `actor` | `any` (no filter) · `system` (events with **no** actor) · a user id |
| `from`, `to` | inclusive window, canonical ISO-8601 UTC |
| `sort`, `direction` | `createdAt` · `action` · `id`; the three columns migrations 001/003 actually index |
| `limit`, `offset` | 1–200 (default 50), 0–1 000 000 |

Every event carries a resolved actor:

```json
{ "id": 6, "action": "identity.login.succeeded", "entityType": "identity",
  "entityId": "1", "details": { "…": "…" }, "createdAt": "2026-10-11T20:14:53.961Z",
  "actor": { "userId": 1, "username": "rootadmin", "kind": "user" } }
```

A system event reports `{ "userId": null, "username": null, "kind": "system" }`.
A user id that no longer resolves reports the **id with a null username** — the
attribution survives the deleted account, and no label is substituted for the
missing name.

`meta` echoes the applied filters, the page window, and `mutable: false` on every
page rather than in a document nobody reads.

## Divergences

| # | Divergence | Reason |
|---|---|---|
| **AV-1** | `GET /api/v1/admin/audit` requires `identity.users.view`; legacy `api/events` required only a signed-in user | `Api_controller::PUBLIC_ACTIONS` lists four public actions and `api_system/events` is not among them, so it needed authentication — but `Api_system::events()` makes **no** `requirePermission` call, so *every* operator could read *every* operator's trail, including identity, governance and execution detail. Node narrows it deliberately. This is a security tightening, not parity, and is recorded as such rather than presented as an equivalent port |
| **AV-2** | `from`/`to` must be canonical ISO-8601 **UTC** (`…Z`); a `+01:00` offset is a 400 that explains itself | `wf_audit_events.created_at` is `DATETIME(3)` — no timezone. The SQL adapter binds an instant through the connection's session timezone while the file adapter compares absolute instants, so the same offset window could select different rows on the two adapters. Refusing the offset is the only answer that does not depend on a host's `time_zone` setting. Same convention as `assertIsoCutoff` for retention |
| **AV-3** | `limit` above 200 is a **400**; legacy `api/events` silently clamped with `min($limit, 500)` | A silently clamped page tells an operator they saw everything when they saw 200 of 900. The schema refuses instead. The ceiling is 200 rather than 500 to match the other paginated Node surfaces |
| **AV-4** | Legacy returned a bare `{ events: [...] }` with no total; Node returns `meta.total` and the applied filters | Without a total a reviewer cannot tell whether the trail has 3 events or 3 pages. Legacy `AuditRepository::recent()` had no count query, so this is an addition, not a port |
| **AV-5** | Legacy `audit_logs` stored `type`/`summary`/`actor` as **strings** with the actor defaulting to `'system'`; Node stores `actor_user_id` as a nullable FK and derives `kind` | The legacy `actor VARCHAR(8)` could not hold a username and was never joined to `users`, so "who" was a free-text label that could say anything. Node's actor is a real foreign key with `ON DELETE SET NULL`, which is why a deleted user resolves to null instead of to a stale string |

## Safety properties

**Read-only by construction, asserted against the whole route inventory.** There
is no route on either adapter that edits, redacts or deletes an audit event. The
test does not check a written-down list of paths; it filters the inventory for
anything matching `/audit|/account/activity` and asserts every one is a `GET`,
then separately asserts that no non-`GET` route anywhere matches `audit`. An audit
trail an API can prune is not an audit trail.

**The own-activity route did not widen.** `userId: null` has always meant "do not
filter" in the storage contract, and `/account/activity` depends on that. So
"events with no actor" got its own word (`actor: "system"`) rather than a
reinterpretation of `null` that would have silently turned the personal activity
view into a platform-wide one. A test asserts the member's activity route still
returns exactly one distinct actor, while the admin browser spanning the same
store returns two.

**No filter can be injected.** `entityType`, `entityId` and `actor` are bound;
`sort` and `direction` resolve through allow-lists; `limit`/`offset` are coerced
to bounded integers before interpolation. The parity test asserts the SQL text
contains `e.actor_user_id = ?` and that the bound value is a number.

## Verification

Measured in this sandbox on 2026-10-11, Node v22.22.3:

- `npm test` (workforce-platform): **532 passed, 0 failed** — up from 522. 10 new
  tests in `test/audit_browser.test.js`.
- `npm run verify:install`: **29/29**, 64 documented config variables. This phase
  adds **no configuration and no migration**.
- Legacy PHP oracle (`node runtime/run-tests.mjs`): **367 passed, 0 failed**.
  `git status --porcelain` reports **0** modified paths under `application/`,
  `system/` or `tests/`.
- Route count **78 → 79**; admin routes **6 → 7**; `/api/v1/system/features`
  `ported` **7 → 8**, `partial` **3 → 2**, `not-ported` unchanged at 5.
- Repository contract stays at **78 methods** and the migration set stays at
  **001–009**: no new surface, only an extended one.

Two defects were found by this phase's own tests and fixed before the record was
written, rather than the assertions being relaxed to match the code:

- **D-13.** The first window guard used `Number.isFinite(Date.parse(value))`.
  `Date.parse("12345")` is the **year 12345**, so `?from=12345` was accepted and
  silently produced an empty window that looked like a filter working. Replaced by
  the canonical-UTC validator above (AV-2).
- **D-14.** The parity test's recording executor returned every row regardless of
  the `WHERE` clause and in insertion order, so the two adapters "agreed" for
  reasons that had nothing to do with the code under test — and then disagreed
  about ordering. The double now applies the filters it is handed and honours the
  `ORDER BY`, which is what made the comparison mean anything.

### Not exercised, and therefore not claimed

- **No real MySQL/MariaDB.** The extended `listAuditEvents` is pinned by a
  recording executor that applies the recorded `WHERE` and `ORDER BY`; it has never
  run against a server. **F-15 is unchanged**, and the `LEFT JOIN wf_users` plus
  `ix_wf_audit_entity` are unmeasured on a real optimizer — the index is *used* by
  the query text, not proven selective.
- **No console screen.** `views/admin/index.php` and the legacy admin UI are not
  ported; **F-29 still stands** — no ported module has a workspace console. The SPA
  keeps its existing `/app/account` activity list, which is unaffected: it reads
  named fields, so the additive `actor` projection does not change it. *(Updated by
  Phase 27: the audit browser screen is ported at `/app/admin/audit`, so F-29 now
  names only the sports and lottery consoles — see
  [`PHASE27_CONSOLE_SCREENS.md`](PHASE27_CONSOLE_SCREENS.md).)*
- **No retention policy.** `wf_audit_events` is unbounded and has no delete path.
  That is correct for evidence, but "security-event retention" is listed in row 5
  and remains **undecided** — it needs one policy covering audit, notifications
  (unbounded since Phase 9), `wf_analysis_runs` (R-27) and `wf_backtests` (R-28),
  not four separate ones.
- **No PHP↔Node value-for-value diff** (F-26). The legacy `audit_logs` and Node
  `wf_audit_events` schemas differ enough (AV-5) that a row-level diff would
  compare different data models; behaviour was ported by reading the PHP and
  asserting the rules in Node.
- **No legacy data.** Nothing imports existing `audit_logs` rows, so a cutover
  would start the Node trail empty unless row 22 (data migration) covers it.
- **No load measurement.** Pagination is proven bounded, not measured under a
  large trail.

## Next

Row 5 now stands at: notifications **ported** (Phase 9), audit browser **ported**
(Phase 10), feature/status matrix already ported. What remains of row 5 is
**settings screens** and the **security-event retention policy**; what remains of
row 3 is every **console screen**, including the two this phase and the last one
created an API for.

The unchanged dependency-order gates still come first: validate migrations
**001–009** and repository transactions against real MySQL/MariaDB, then rehearse
cPanel/Passenger deployment, backup/restore and rollback.
