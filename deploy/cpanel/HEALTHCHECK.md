# cPanel post-deployment health checks

Run these checks against the dedicated HTTPS staging hostname after every deployment or restart:

1. `GET /api/v1/health/live` returns HTTP 200 and `{ "status": "ok" }`. This confirms the Node process is serving requests; it does not confirm database readiness.
2. `GET /api/v1/health/ready` returns HTTP 200 with `database: true` and `schema: true` only after the MySQL connection and foundation migration are present. A 503 is an honest not-ready result; inspect Application Manager logs and migration status without exposing credentials.
3. `GET /` reports `runtime: "nodejs"`, `migrationStatus: "in_progress"`, and `productionReplacement: false`.
4. Confirm HTTPS, the expected hostname, Passenger restart/log behavior, and headers including `X-Content-Type-Options`, CSP, and `Cache-Control: no-store` on versioned API responses.
5. Verify database tables are limited to the new `wf_*` namespace. Do not import user/business data or create a default administrator. Login should remain unavailable until a reviewed identity import/bootstrap flow exists.
6. Confirm the PHP production URL still serves the original application and its business flows are unaffected.

This workspace has not been tested against a real cPanel/Passenger host or live MySQL/MariaDB. Local Fastify route tests are not evidence of cPanel deployment acceptance.
