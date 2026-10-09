# WINDELS AI WORKFORCE — Node.js platform

This is the side-by-side Node.js migration target. The existing PHP/CodeIgniter
application remains authoritative and deployable; this platform is **not** a
production replacement and no traffic has been cut over.

## Current slice

- Node.js `>=22.20.0 <25`. `server.js` starts a core `node:http` server. Routing,
  bounded body parsing, multipart, static serving, security headers, CORS, request
  IDs, rate limits, login lockout, upload policy and graceful shutdown use Node core
  modules and files in this package — no Express, Fastify or middleware framework.
- Runtime dependencies are exactly `mysql2` (the selected cPanel database is
  MySQL/MariaDB; `pg` cannot talk to it) and `bcryptjs` (to verify imported PHP
  `$2y$` hashes). There are no `devDependencies`: the test suite is `node:test`.
- **Identity and account management are ported**: registration, login, logout,
  session rotation, session-bound CSRF, password change, avatar upload/serving/
  removal, audit listing, and the admin user list/detail/create/status/role surface
  with pagination, filtering, sorting and search.
- **The public site, its SEO documents and the PWA shell are ported**: 8 marketing
  pages, 9 legacy aliases/redirects, `robots.txt`, `sitemap.xml`,
  `manifest.webmanifest`, `service-worker.js` (all generated per request), the
  deterministic PNG icon set, and public contact intake with a signed one-shot
  flash for the no-script form path. The legacy public chat widget is **not**
  ported, so `publicSite` reports `partial`. The 12 other product domains remain
  unported and `/api/v1/system/status` says so per module.
- Two storage adapters implement one repository contract:
  - `STORAGE_ADAPTER=mysql` (production target) — the MySQL/MariaDB tables created by
    `src/db/migrations/*.sql`.
  - `STORAGE_ADAPTER=file` (development, tests, rehearsal) — an append-only JSONL log
    under `STORAGE_DIR` with compaction, checksums, backup/restore. It is refused in
    production unless `ALLOW_FILE_STORE_IN_PRODUCTION=1` is set deliberately.
  `STORAGE_ADAPTER=auto` (the default) picks `mysql` when `DB_HOST`/`DB_NAME`/`DB_USER`
  are present and `file` otherwise, so the server boots on a host with no database.
- `public/` holds only real static files: `styles.css`, `site.js` and `icons/`.
  `index.html`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest` and
  `service-worker.js` are **rendered per request** and must never be committed as
  static copies — `verify:install` fails if they reappear. `client/` is the
  React/Vite SPA built into `public/app/` (generated, git-ignored). `native/`
  is the Capacitor wrapper; native sign-in stays disabled until a reviewed
  token/refresh/revocation contract and secure storage implementation exist.

## Running it

Export the values in your shell, source a private file (`set -a; . ./.env; set +a`),
or use cPanel's environment UI — the server never auto-loads `.env` by design.
`.env.example` documents every variable the config reads.

```bash
# Local, no database: file adapter, seeded baseline, ready to sign in.
export NODE_ENV=development
export STORAGE_ADAPTER=file
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run seed:platform -- --admin-username root --admin-email root@example.test --admin-password 'change me, 14+ chars'
npm run verify:data
npm run start:workforce-platform

# Against the real schema
export STORAGE_ADAPTER=mysql DB_HOST=… DB_NAME=… DB_USER=… DB_PASSWORD=…
npm run migrate && npm run migrate:status
```

`SESSION_SECRET` is always required: it keys the CSRF derivation and the
login-attempt hash, not only the session cookie. `DB_*` are required only by the
`mysql` adapter; the importer additionally reads `LEGACY_DB_*`.

`npm run check` is the release gate: it verifies the installation (engines range,
dependency set, required files, migrations, `.env.example` coverage, production
config rules, reproducible icons, absence of static generated documents, built
client bundle — **30 checks**) and then runs the suite — currently **103 tests**.
`npm run build:icons` regenerates the PNG icon set; `npm run check:icons` proves
the committed PNGs are byte-identical to what the generator produces.

## Operations

| Command | What it does |
|---|---|
| `npm run verify:install` | Static release gate on the tree; no data access. Exits non-zero on any failure. |
| `npm run verify:data` | Reads the configured store: readiness, RBAC baseline, duplicate/collision keys, dangling role and permission rows, expired-but-unrevoked sessions, non-bcrypt digests. `--strict` turns warnings into failures. |
| `npm run seed:platform` | Idempotent role/permission baseline for adapters without migrations (the file store), with `--admin-username`/`--admin-password` to bootstrap the first administrator. Refuses to create a second one. |
| `npm run backup` | `file`: copies the store log and uploads into a sha256-manifested directory. `mysql`: runs `mysqldump --single-transaction` with the password in a `0600` defaults file, never in argv. |
| `npm run restore` | Verifies every manifest hash first, then restores. Refuses a non-empty file store without `--force`. |
| `npm run import:identity` | One-time legacy identity import, dry-run first (see `docs/migration/IDENTITY_IMPORT.md`). |

Backup, restore and the importers are CLI-only; the web process never reads
`LEGACY_DB_*`.

## Development

From the repository root:

```bash
npm ci
npm ci --prefix apps/workforce-platform/client
npm run check:workforce
npm run build:workforce-client
```

The Vite development server binds to `0.0.0.0:5173`, uses relative `/api/v1` URLs and
proxies API calls server-side to `http://127.0.0.1:3000` (override with
`API_PROXY_TARGET`). Browser code never calls localhost.

## Capacitor build boundary

From `native/`, install its dependencies, set `VITE_API_BASE_URL` to the deployed
**HTTPS origin**, then `npm run sync`. `npm run build:web` rejects missing, non-HTTPS
or local API origins. Android/iOS SDK setup, platform generation, signing, secure
credential storage, real native API-origin tests and store release remain future
acceptance gates.
