# Phase 28 — Read-only audit browser console

**Date:** 2026-10-16 · **Scope:** expose the existing Phase 10 audit API as the next shared-shell console, without changing audit writes, storage, or retention.

## Delivered

- Added the authenticated SPA route `/app/admin/audit`, guarded by the existing `identity.users.view` permission in both the client route and server API.
- Added the workspace navigation entry; roles without the permission see the normal locked entry and receive the existing access-denied state if they open the route directly.
- Added server-backed filters for action prefix, entity type and ID, system/user actor, and inclusive time window. Local date-time inputs are converted to canonical UTC before the request.
- Added the API-supported sort keys and directions, bounded page sizes (25–200), previous/next pagination, and visible result totals.
- Rendered resolved actor attribution, entity identifiers, event timestamps, JSON details, loading/error/empty states, and the endpoint's explicit read-only status.
- Kept the screen read-only. It adds no event mutation, redaction, export, or deletion action and does not change the existing API contract.

## Verification

- Client production build: `npm run build:workforce-client` — passed.
- Workforce installation checks: `npm run check:workforce` — 30/30.
- Workforce tests: 975 passed, 0 failed.
- No real browser, MySQL/MariaDB server, production deployment, or legacy PHP runtime was exercised for this UI slice.

## Remaining

The audit trail still has no retention/deletion policy, and existing legacy `audit_logs` rows have not been imported. Phase 10's security tightening remains: `identity.users.view` is required, rather than the legacy endpoint's signed-in-only access. The portfolio optimizer console, settings and domain dashboards remain separate app-shell work. This phase does not claim real-MySQL or production acceptance.
