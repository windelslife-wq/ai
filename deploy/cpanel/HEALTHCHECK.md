# cPanel post-deployment health checks

Run these against the dedicated HTTPS staging hostname after every deployment or restart. Install
context: [`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §4 and §6.

1. `GET /api/v1/health/live` returns **200** and
   `{ "status": "ok", "uptimeSeconds": …, "node": "22.x" }` — the process is serving requests. It
   says nothing about the database.
2. `GET /api/v1/health/ready` returns **200** with `database: true` and `schema: true`, and
   `adapter` naming the store you configured. A **503 `not_ready`** is the honest answer for a
   missing database, a partial schema or a failed probe: it carries `retry-after: 5` and a `detail`
   code, and the underlying error — which can contain host, port and credentials — stays in the
   log. On the file adapter the body also carries `durability: "development-only"`.
3. `GET /` renders the public site (it is composed per request; there is no static `index.html` to
   check).
4. `GET /app/` loads the workspace SPA. A **404 here while `/` works** means the built client bundle
   (`apps/workforce-platform/public/app/`) is not deployed — see
   [`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §5.
5. Sign in as the administrator created with `npm run seed:platform`, and confirm the navigation
   shows entries your role cannot use as **locked** (never silently hidden).
6. Confirm HTTPS and the expected hostname, and check the response headers on a versioned API path:
   `X-Content-Type-Options`, the CSP, and `Cache-Control: no-store` where the route sets it.
7. Confirm the database contains the new `wf_*` tables only. Do not import user/business data or
   create default accounts during a readiness check; the legacy identity importer exists, has not
   been rehearsed against a real database, and must not be run without separate approval.
8. Confirm the PHP production URL still serves the original application and its business flows are
   unaffected.

**Not verified in this repository:** no real cPanel/Passenger host, no live MySQL/MariaDB, no
installed crontab. The checks above are derived from the platform's own responses and its test
suite; they are not cPanel deployment evidence. See
[`docs/migration/STATUS.md`](../../docs/migration/STATUS.md) for what each phase actually proved.
