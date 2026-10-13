# cPanel Node application environment

Install context: [`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §4.

Set variables in cPanel → Setup Node.js App / Application Manager. Do not place secrets in a
web-readable `.env` file. Values marked required must be present before the app starts. The server
never auto-loads dotenv files; `.env.example` in `apps/workforce-platform/` documents all 84
variables the config reads, and `npm run verify:install` fails if a config variable is undocumented
there.

## Minimum for a staging host

| Variable | Type | Required | Default / bounds | Purpose |
|---|---|---:|---|---|
| `NODE_ENV` | string | yes | allowed: `development`, `test`, `production` | Runtime mode. Production enables Secure host-only session cookies and requires an HTTPS public origin. |
| `SESSION_SECRET` | secret string | yes | at least 32 UTF-8 bytes | Keys session-bound CSRF derivation **and** the login-attempt hash. Generate independently per environment; rotate with session invalidation. |
| `PUBLIC_BASE_URL` | HTTPS origin | yes in production | e.g. `https://node-staging.example.com` | Exact origin used to reject cross-origin auth requests. No path, query, fragment, credentials or trailing app path. In development only, HTTP is accepted for `localhost`, `127.0.0.1`, `[::1]`. |
| `DB_HOST` | string | yes (mysql) | provider database host | MySQL/MariaDB hostname from cPanel. |
| `DB_NAME` | string | yes (mysql) | none | Dedicated staging database name, including any cPanel account prefix. |
| `DB_USER` | string | yes (mysql) | none | Least-privilege database user, including any cPanel account prefix. |
| `DB_PASSWORD` | secret string | yes (mysql) | none | Database password. Configure only in Application Manager. |
| `STORAGE_ADAPTER` | string | no | `auto`; one of `auto`, `mysql`, `file` | `auto` picks `mysql` when `DB_HOST`/`DB_NAME`/`DB_USER` are set and `file` otherwise, so the server boots on a host with no database. |

## Common optional variables

| Variable | Type | Required | Default / bounds | Purpose |
|---|---|---:|---|---|
| `HOST` | string | no | `0.0.0.0` | Bind address. Do not set to loopback under Passenger. |
| `PORT` | integer | no | `3000`; 1–65535 | Passenger normally supplies this port. |
| `DB_PORT` | integer | no | `3306`; 1–65535 | MySQL/MariaDB port. |
| `DB_CONNECTION_LIMIT` | integer | no | `5`; 1–20 | Maximum MySQL connections held by this process. Keep within the account quota. |
| `TRUST_PROXY` | boolean | no | `false` | Set true only after confirming the cPanel/Passenger proxy topology; the app then trusts one proxy hop. Never enable when direct public traffic can spoof forwarded headers. |
| `LOG_LEVEL` | string | no | `info` in production; `debug` otherwise | Pino level. Secret-bearing headers and passwords are redacted. |
| `SESSION_TTL_SECONDS` | integer | no | `28800`; 300–604800 | Session lifetime, 5 minutes to 7 days. |
| `ALLOW_FILE_STORE_IN_PRODUCTION` | boolean | no | `0` | Set to `1` only to run the file adapter in production **deliberately**; it has no transactions and a single-process lock. |
| `ANALYSIS_RETENTION_DAYS` | integer | no | `90` | Retention for analysis runs; the prune tool reads it (`ANALYSIS_RETENTION_DAYS`, R-27). No retention policy is decided for audit, notifications or the report tables. |

Market data, broker, sports and lottery gates (`MARKET_DATA_*`, `BROKER_*`, `WINDELS_SPORTS_*`,
`WINDELS_LOTTERY_*`, and the `AEGIS_*` connector names legacy uses) are documented in
`.env.example`. They all default to **off or sandbox**: no provider, connector or live feed is
enabled by configuration alone, and the platform labels simulated data wherever it produces it.

## Generate a secret without leaving it in shell history

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Paste the result into the Application Manager UI. The same variables are needed by the cron jobs —
keep them in a `0600` file outside the web root and source it from the crontab line, never inline it;
see [CRON.md](CRON.md).
