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
  ported, so `publicSite` reports `partial`.
- **Market data, analysis, the Strategy Lab, paper trading, persisted risk
  governance, the paper-proposal workflow, operator notifications, the audit
  browser, portfolio optimization, the scheduled operations cron, the broker
  connector boundary, sports and lottery intelligence are ported**;
  `/api/v1/system/status` states each module's acceptance level individually and
  never upgrades one: nine modules report `ported`, six `partial` (brokers, sports
  and lottery among them) and language learning and lead discovery remain
  legacy-only. This bullet previously called brokers, sports and lottery
  "legacy-only", which Phases 14–25 made untrue — the status surface was right and
  this sentence was not.
- **Operator notifications are ported** (migration `009`, `wf_notifications`): an
  unread-deduped notifier, broadcast plus targeted visibility, the three legacy
  `/api/v1/notifications` endpoints, and publishers for the kill switch, trading-mode
  changes and the paper-proposal lifecycle. Their workspace screen is ported
  (Phase 27, `/app/notifications`) and states the delivery gap using the server's
  own `deliveryChannels` value. Alerts are stored and read in-product only — there
  is **no** mail, push or webhook delivery channel, and no HTTP route can publish
  one. See [`docs/migration/PHASE9_NOTIFICATIONS.md`](../../docs/migration/PHASE9_NOTIFICATIONS.md).
- **Research-only portfolio optimization is ported**: `POST /api/v1/portfolio/optimize`
  estimates returns and covariance from history aligned on the timestamps every asset
  shares, then solves minimum-variance and maximum-Sharpe allocations under a
  fully-invested, long-only, per-asset cap. It **cannot reach an order path** — the
  service is never given the paper, strategy or execution services, and the body
  schema refuses `execute`, `amount`, `orderId` and `notional` by name. An
  all-synthetic universe needs an explicit `allowSyntheticData: true` opt-in and is
  then labelled `SIMULATION:`; a **mixed** synthetic/live universe is refused with no
  override. Its workspace screen is ported (Phase 27, `/app/portfolio/optimizer`):
  it renders the weights, every asset's provenance and the run's own warnings, and
  it has no path to an order. No saved reports yet.
  See [`docs/migration/PHASE11_PORTFOLIO_OPTIMIZER.md`](../../docs/migration/PHASE11_PORTFOLIO_OPTIMIZER.md).
- **The audit browser is ported**: `GET /api/v1/admin/audit` serves the whole trail
  filterable by actor, action prefix, entity and inclusive UTC window, paginated,
  with every event carrying a resolved `actor {userId, username, kind}`. It is
  **read-only** — no route on either adapter can edit, redact or delete an audit
  event — and requires `identity.users.view`, a deliberate tightening of the legacy
  `api/events`, which any signed-in user could read (divergence AV-1). Its
  workspace screen is ported (Phase 27, `/app/admin/audit`) and renders the
  server's own `mutable: false` plus the filters the server applied. No retention
  policy yet.
  See [`docs/migration/PHASE10_AUDIT_BROWSER.md`](../../docs/migration/PHASE10_AUDIT_BROWSER.md).
- **The sports and lottery consoles are ported** (Phase 28): `/app/sports` merges
  legacy's `Sports::index` and `Sports::tickets` — fixtures, predictions, tickets with
  the approve/reject (`sports.approve`) and settlement (`sports.settle`) controls
  legacy carried, sync runs, daily runs, the measured half, models and calibrations —
  and `/app/lottery` is legacy's `Lottery::index`: draws, all seven statistics kinds,
  the decision records, saved tickets with an owner-scoped check, the three-section
  performance overview, model versions and job history, with the provider probe and
  draw sync behind `lottery.manage`. Both render the module's `notPorted` matrix,
  the sandbox banner and the independence disclaimer **verbatim**, and together they
  remove the last two halves of finding F-29 — which stays open for the market-data,
  analysis and Strategy Lab consoles, and both labels say so rather than claiming it
  is closed. Nothing here sizes a stake, executes a ticket or purchases a line; the
  controls are the five legacy's consoles had, and every other sports/lottery
  mutation is listed with the permission it needs and has no client call at all.
  See [`docs/migration/PHASE28_SPORTS_LOTTERY_CONSOLES.md`](../../docs/migration/PHASE28_SPORTS_LOTTERY_CONSOLES.md).
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
| `npm run prune:analysis` | Analysis-run retention (R-27). Measures by default; `--apply` deletes, `--batch` bounds each `DELETE`, `--days N` overrides `ANALYSIS_RETENTION_DAYS`. Deletion is irreversible and removes evidence, so take a backup first. |
| `npm run jobs` | The scheduled operations sweep — portfolio risk across every owner, plus stale execution-proposal expiry. **Measures and writes nothing**, and takes no lock. |
| `npm run jobs:apply` | The same sweep for real, under a `wf_job_locks` row: expires proposals, publishes `PORTFOLIO_RISK` and `PROPOSAL_EXPIRED` notifications, records one `system.job.run` audit event as the system actor. |

Backup, restore, the retention prune, the importers and the scheduled jobs are CLI-only; the
web process never reads `LEGACY_DB_*`, and **no HTTP route can run a job or touch a lock**.
`runOperations` takes no owner argument — it scans every account on the platform and expires
every operator's proposals — so exposing it would turn any reachable caller into a
platform-wide actor. A test asserts no route in the inventory matches
`job|cron|schedul|sweep|stale|lock`.

### cPanel cron

The operations job is meant to run every minute, as the legacy `tools cron` did:

```
* * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/scheduled-jobs.mjs --apply >> /home/USER/logs/workforce-cron.log 2>&1
```

Three things about that line are load-bearing:

* **Use the absolute `node` path.** cron does not inherit an interactive shell's `PATH`.
* **`cd` first.** `loadConfig` resolves relative storage paths against the working directory.
* **Source the environment yourself.** The job needs the same variables as the web app —
  `SESSION_SECRET` and the `DB_*` set — because `loadConfig` is a single gate for the whole
  platform and refuses without them. cPanel supplies those to Passenger through the
  Application Manager, not from a `.env` file, so cron gets nothing for free. Keep them in a
  file **outside the web root** with `0600` permissions; never commit it, and never put a
  secret in the crontab line itself, where it is readable in the process list and in
  cPanel's own cron editor.

Two caveats to read before trusting it. The file adapter's lock is **single-process only** and
says so — `crossProcessSafety: false` in the JSON output and a warning in the text output — so
real cron needs MySQL to be safe against overlap. And a skipped run is **not** a failure: if
the previous minute's run is still going, this one reports `SKIPPED`, names the holder and
exits 0. Exit 1 means refused, failed, or completed with a stage error, which is deliberate —
a cron that exits 0 while one of its two jobs is broken is how a job stops running and nobody
notices for a month.

Not yet verified on a real host: no crontab was installed and no Passenger instance ran this,
so the line above is reasoned from cPanel's documented behaviour rather than observed. See
`docs/migration/PHASE12_SCHEDULED_JOBS.md` §"Not exercised, and therefore not claimed".

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
