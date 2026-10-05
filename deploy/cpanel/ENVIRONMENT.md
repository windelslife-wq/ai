# cPanel Node application environment

Set variables in cPanel → Setup Node.js App / Application Manager. Do not place secrets in a web-readable `.env` file. Values marked required must be present before the app starts.

| Variable | Type | Required | Default / bounds | Purpose |
|---|---|---:|---|---|
| `NODE_ENV` | string | yes | `production` on host; allowed: `development`, `test`, `production` | Runtime mode. Production enables Secure host-only session cookies and requires an HTTPS public origin. |
| `HOST` | string | no | `0.0.0.0` | Bind address. Do not set to loopback under Passenger. |
| `PORT` | integer | no | `3000`; 1–65535 | Passenger normally supplies this port. |
| `PUBLIC_BASE_URL` | HTTPS origin | production | required in production; e.g. `https://node-staging.example.com` | Exact origin used to reject cross-origin auth requests. No path, query, fragment, credentials, or trailing app path. |
| `TRUST_PROXY` | boolean | no | `false` | Set true only after confirming the cPanel/Passenger proxy topology; the app then trusts one proxy hop. Do not enable when direct public traffic can spoof forwarded headers. |
| `LOG_LEVEL` | string | no | `info` in production; `debug` otherwise | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. Secret-bearing headers/passwords are redacted. |
| `DB_HOST` | string | yes | provider database host | MySQL/MariaDB hostname from cPanel. |
| `DB_PORT` | integer | no | `3306`; 1–65535 | MySQL/MariaDB port. |
| `DB_NAME` | string | yes | none | Dedicated staging database name, including any cPanel account prefix. |
| `DB_USER` | string | yes | none | Least-privilege database user, including any cPanel account prefix. |
| `DB_PASSWORD` | secret string | yes | none | Database password. Configure only in Application Manager. |
| `DB_CONNECTION_LIMIT` | integer | no | `5`; 1–20 | Maximum MySQL connections held by this Node process. Keep within the cPanel account quota. |
| `SESSION_SECRET` | secret string | yes | at least 32 UTF-8 bytes | HMAC key for session-bound CSRF tokens. Generate independently for each environment; rotate with session invalidation. |
| `SESSION_TTL_SECONDS` | integer | no | `28800`; 300–604800 | Session lifetime from 5 minutes to 7 days. |

Generate a secret locally without putting it into shell history, then paste it into the cPanel environment UI:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

For development, `PUBLIC_BASE_URL` may be an HTTP origin only on `localhost`, `127.0.0.1`, or `[::1]`. Production always requires HTTPS. The server does not load dotenv files.
