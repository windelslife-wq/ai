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
  governance, the paper-proposal workflow, operator notifications and lottery
  intelligence are ported**, as are the audit, inbox, portfolio-optimizer, lottery,
  Strategy Lab, AI Workforce, workspace-dashboard and administrator-control-centre
  screens; `/api/v1/system/status` states each module's acceptance level individually.
  Brokers and sports are ported **in part** (`partial`, each with its own stated
  remainder — no verified adapter, and for sports no stake sizing and no vendor);
  language learning and lead discovery remain legacy-only, and
  one screen of the shared shell is still absent — the sports dashboard (the settings
  gap and the admin control centre both closed in Phases 34–35). The status surface
  reports each state rather than implying coverage.
- **Operator notifications are ported** (migration `009`, `wf_notifications`): an
  unread-deduped notifier, broadcast plus targeted visibility, the three legacy
  `/api/v1/notifications` endpoints, and publishers for the kill switch, trading-mode
  changes and the paper-proposal lifecycle. Alerts are stored and read in-product
  only — there is **no** mail, push or webhook delivery channel, and no HTTP route
  can publish one. See [`docs/migration/PHASE9_NOTIFICATIONS.md`](../../docs/migration/PHASE9_NOTIFICATIONS.md).
- **Research-only portfolio optimization is ported**: `POST /api/v1/portfolio/optimize`
  estimates returns and covariance from history aligned on the timestamps every asset
  shares, then solves minimum-variance and maximum-Sharpe allocations under a
  fully-invested, long-only, per-asset cap. It **cannot reach an order path** — the
  service is never given the paper, strategy or execution services, and the body
  schema refuses `execute`, `amount`, `orderId` and `notional` by name. An
  all-synthetic universe needs an explicit `allowSyntheticData: true` opt-in and is
  then labelled `SIMULATION:`; a **mixed** synthetic/live universe is refused with no
  override. Its console is available at `/app/portfolio/optimizer` (Phase 29, gated by
  `trading.view`); there is still **no saved-report history** — a run is returned, not
  stored, and the screen says so.
- **Lottery intelligence is ported end to end** (row 15, Phases 21–30): the provider
  boundary (no provider by default, the sandbox double-gated and labelled, the official
  feed gated on an explicit https-only license), EuroMillions rules as versioned data,
  validation before storage, idempotent ingestion that never overwrites a verified draw,
  the statistics engine whose every output carries the independence disclaimer, the
  five-mode generator, the diversity and system builders, saved tickets that are
  **records of number lines, never purchases**, the no-look-ahead Strategy Lab whose
  cost and winnings are honestly `null`, and the CLI cron. Its consoles are
  `/app/lottery` (operations: engine state, stored evidence, provider health and
  history, registry, a draw browser, the seven statistics kinds, AI decision reports
  with each stored payload, job runs and the performance overview) and
  `/app/lottery/lab` (generator with locks and excludes, combinations, tickets, the
  Strategy Lab and model versions), both under `lottery.view` — only the probe, the
  sync and the system build are `lottery.manage`.
  See [`docs/migration/PHASE11_PORTFOLIO_OPTIMIZER.md`](../../docs/migration/PHASE11_PORTFOLIO_OPTIMIZER.md)
  and [`docs/migration/PHASE29_PORTFOLIO_OPTIMIZER_CONSOLE.md`](../../docs/migration/PHASE29_PORTFOLIO_OPTIMIZER_CONSOLE.md).
- **The Strategy Lab console is at `/app/strategy`** (Phase 31, row 8): it runs a
  backtest against the version on screen and renders the report it returns — every
  metric, the equity curve, the trades, the data provenance (a synthetic run is
  labelled SIMULATION on the row and in the report) and the engine's own warnings —
  plus the stored history, the six-stage lifecycle stepper whose advance button
  always targets the server's `nextStage`, and the 70/30 optimizer with its finalist
  table. The screen is **session-only, like legacy's `Api_controller`**: it declares
  no permission, and the one permissioned control it renders — the human sign-off for
  an `ai`-sourced version — is `trading.control` on the route itself. Journal reads
  and the model analytics stay under `/journal/*` rather than an alias (DV-8). A
  refused promotion is shown with the server's reasons **and** warnings verbatim:
  `views/strategy/index.php` flashed both, and a console that showed only "rejected"
  would lose exactly what a person acts on.
  See [`docs/migration/PHASE31_STRATEGY_CONSOLE.md`](../../docs/migration/PHASE31_STRATEGY_CONSOLE.md).
- **The workspace dashboard is `/app`** (Phase 33, row 3) — the port of legacy's `/dashboard`
  (`Workspace::index` → `views/workspace/index.php`): the `WINDELS AI WORKFORCE` hero, the
  status pills (the kill switch replaces the mode while it is engaged, as the page did), legacy's
  three quick actions, the four KPI cards with legacy's captions, the recent-activity table and
  the notification feed (eight fetched, six printed). It is **session-only, like
  `App_Controller`**, and two of its four reads are gated: without `trading.view` the screen does
  not attempt `GET /trading/mode` or `GET /paper/accounts` and says which gate stood there rather
  than showing an error for a request it was never entitled to make. Every number the shell cannot
  source says so — the language card has no Node module behind it (row 16), the run count is the
  six most recent runs rather than a lifetime total, the paper count is owner-scoped (legacy's
  `listAccounts()` read every row), and the Paper trading and Learn a language quick actions render
  as unavailable with their reasons (F-29, row 16) instead of linking into a gap.
  See [`docs/migration/PHASE33_WORKSPACE_DASHBOARD.md`](../../docs/migration/PHASE33_WORKSPACE_DASHBOARD.md).
- **The account screen's profile image is live at `/app/account`** (Phase 34, row 3): the 84px
  hero (the stored image, or the display name's initial when there is none), legacy's
  `Upload image` / `Save image` / `Remove image` labels, its `accept` list and hint line and its
  two notices, driving `POST`/`DELETE /api/v1/account/avatar` — routes that had **no caller**
  until this screen. No route, migration, contract method or permission was added, and the control
  states no rule of its own: the refusals are the server's (`Choose an image to upload`, `Only PNG,
  JPEG, GIF or WebP images are allowed`, `Profile image must be 2 MB or smaller`, the rate-limited
  retry), the oversized upload was made to answer in megabytes rather than a byte count, and a host
  with image storage switched off is named with its remedy (`UPLOADS_ENABLED=1`) instead of a
  3600-second retry.
  See [`docs/migration/PHASE34_ACCOUNT_AVATAR.md`](../../docs/migration/PHASE34_ACCOUNT_AVATAR.md).
- **The administrator control centre is `/app/admin`** (Phase 35, row 3) — the port of
  `views/admin/index.php` (`Admin::index`), gated on `system.super_admin` as `requireAdmin()` was:
  legacy's four statistics with legacy's captions (the language card renders an em dash and **row 16**
  rather than a zero, and the strategy card counts the version rows legacy counted), the access-policy
  list with machine-readable role and permission keys the suite holds to the seeded grants, the
  directory's entry point, the SMTP panel stated as `not-ported` with the ledger rows that wait on a
  transport, and the feature-readiness table built from `GET /system/status`'s own ledger and
  `GET /system/features`' own legend. Auditing the directory for the same policy fixed three controls
  that could never have worked: the create form's role list offered seven options of which only
  `super_admin` was accepted, the toggle sent `suspended` where the schema accepts `active`/`disabled`,
  and the signed-in administrator's own row offered a toggle the API refuses with `SELF_DEACTIVATION`.
  No route, migration, contract method or permission was added.
  See [`docs/migration/PHASE35_ADMIN_CONTROL_CENTRE.md`](../../docs/migration/PHASE35_ADMIN_CONTROL_CENTRE.md).
- **The AI Workforce console is at `/app/analysis`** (Phase 32, row 3): it requests a run
  on the legacy page's own symbols and timeframes, with `marketClass` derived by legacy's
  rule, and renders the run's headline, its **own** provenance (a synthetic run is labelled
  and the veto is stated), the confidence/confluence/agreement meters, the consensus with
  its voting and abstaining agents named, the signal rows, the five-agent panel and the
  four-round debate, plus the stored history. The proposal and the risk decision are drawn
  **only when the run produced them** — on this edition's default `ANALYSIS_ONLY` posture
  they are null, and the run's `riskContext` is shown beside that rather than a
  placeholder. `views/welcome/partials/chart.php` is ported as SVG geometry (1000×380, 140
  of 200 bars, legacy's EMA warm-up, the volume strip, ±10 % S/R from the technical agent's
  own levels); a candle fetch that fails drops only the chart. The screen is **session-only,
  like the controller it ports** — every `/analysis*` and `/market-data/*` route is
  permission-`null` — and its two governance controls are the paper module's own writes, so
  they render **disabled with the reason** when the viewer lacks `trading.control`. The
  three modes this edition does not have are named as unavailable with the capability each
  is missing, and refused by the request schema (400) if posted. Legacy's kill switch kept
  a reason and a fresh activation timestamp on **release** too; this port clears both and
  keeps the release reason in the audit row (a recorded divergence, not a silent one).
  See [`docs/migration/PHASE32_AI_WORKFORCE_CONSOLE.md`](../../docs/migration/PHASE32_AI_WORKFORCE_CONSOLE.md).
- **The audit browser is ported**: `GET /api/v1/admin/audit` serves the whole trail
  filterable by actor, action prefix, entity and inclusive UTC window, paginated,
  with every event carrying a resolved `actor {userId, username, kind}`. It is
  **read-only** — no route on either adapter can edit, redact or delete an audit
  event — and requires `identity.users.view`, a deliberate tightening of the legacy
  `api/events`, which any signed-in user could read (divergence AV-1). Its read-only
  console is at `/app/admin/audit` (Phase 28). No retention policy and no historical
  `audit_logs` import yet.
  See [`docs/migration/PHASE10_AUDIT_BROWSER.md`](../../docs/migration/PHASE10_AUDIT_BROWSER.md).
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
client bundle — **30 checks**) and then runs the suite — currently **1016 tests** across 72 files.
It needs the client built first (`npm run build:client`): the console suites assert that a
bookmarked `/app/...` path reaches the SPA shell, and `public/app/` is generated and
git-ignored, so on a fresh checkout those assertions fail with that instruction rather
than with a routing error. CI builds the client before running the gate.
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
| `npm run sports:jobs` | The sports cron (`tools/sports-jobs.mjs`): nine jobs in legacy's order — fixtures, odds, results, quality, ticket, settlement, performance, monitoring, cleanup — CLI-only, no HTTP route. Each job takes a `wf_job_locks` marker whose expiry **is** its window, and the syncs keep their per-provider execution keys, so firing it twice cannot double-write. `--job <name>`, `--date`, `--json`, `--now`; exit 1 when any job FAILED. |
| `npm run lottery:jobs` | The lottery cron (`tools/lottery-jobs.mjs`): seven jobs in legacy's order — sync, health, statistics, systems (the consumer for the queued background builds the API creates), tickets, backtests, cleanup. Idempotent by execution key on `wf_lottery_sync_runs`; a failed run's key still blocks its window. `--job <name>`, `--date`, `--json`, `--now`; exit 1 when any job FAILED. |

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

The sports and lottery jobs get **their own lines** rather than being folded into that sweep —
they have their own logs, their own schedules and their own idempotency mechanism, and each file's
header comment carries the exact line to paste:

```
# sports — hourly
0 * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/sports-jobs.mjs --json >> /home/USER/logs/workforce-sports-cron.log 2>&1
# lottery — once a day, after the draw results land
30 5 * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/lottery-jobs.mjs --json >> /home/USER/logs/workforce-lottery-cron.log 2>&1
```

Unlike the operations sweep they have **no dry run** — legacy's sports and lottery jobs have no
measure-only form, so their execution keys and window locks are the safety, and pointing cron at
either file cannot double-write however often it fires.

Not yet verified on a real host: no crontab was installed and no Passenger instance ran any of
these three lines, so they are reasoned from cPanel's documented behaviour rather than observed.
See `docs/migration/PHASE12_SCHEDULED_JOBS.md` §"Not exercised, and therefore not claimed",
`docs/migration/PHASE20_SPORTS_CRON.md` and `docs/migration/PHASE25_LOTTERY_CRON.md`.

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
