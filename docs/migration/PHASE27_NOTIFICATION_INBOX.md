# Phase 27 — Notification inbox screen

**Date:** 2026-10-15 · **Scope:** first shared-shell console for the already-ported notifications API (rows 3 and 5 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md)).

## Delivered

- Added the authenticated SPA route `/app/notifications` and workspace navigation entry.
- Added typed client calls for the inbox, mark-one-read and mark-all-read endpoints.
- Built the inbox view with unread count, unread-only filtering, broadcast labeling, severity/type/time metadata, bounded detail rendering, per-item acknowledgement, mark-all and retry/error/empty states.
- Kept notification display informational: the screen does not offer governance or execution controls. API authorization remains authoritative.
- Fixed a time-dependent lottery HTTP test fixture: it now builds an exact-match ticket from the opted-in sandbox draw actually returned, rather than assuming a fixed calendar date and PRNG offset.

## Verification

- Client production build: `npm run build` in `apps/workforce-platform/client` — passed.
- Workforce install checks: 30/30.
- Workforce tests: 975 passed, 0 failed.
- The first full test run exposed the old calendar-pinned lottery test failure; the test now derives its expected draw from the test response and passes independently and in the full suite.
- No real MySQL/MariaDB, browser, SMTP transport, or production host was exercised. Notification email delivery remains unavailable.

## Remaining

This closes only the notification inbox-screen item. The shared shell still needs the audit browser and portfolio optimizer screens plus settings/domain dashboards. Notifications still have no delivery channel, and the audit/notification retention decision remains open. This is not production or migration acceptance.
