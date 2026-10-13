# Installation guide — the Node.js platform

**Scope: `apps/workforce-platform/`**, the side-by-side Node.js migration target. This document is
the single installation path for it: local development, a real MySQL/MariaDB database, and a
cPanel/Passenger host.

> **Not this document:** the PHP/CodeIgniter application has its own guide
> ([`CPANEL_DEPLOYMENT.md`](CPANEL_DEPLOYMENT.md)), and `apps/api`, `apps/web` and
> `apps/football-predictions` are separate projects with their own installs. The PHP app remains
> the production service and the rollback target; nothing here authorizes a cutover.

Pick the path that matches what you are doing. All three end at a server that answers health
checks and a sign-in page.

| Path | Database | Time | Use it for |
|---|---|---|---|
| **A** — local, file store | none | ~5 min | Trying the platform, running the tests, working on the SPA |
| **B** — local, MySQL | MySQL/MariaDB | ~15 min | Rehearsing migrations and production-like behaviour |
| **C** — cPanel/Passenger | MySQL/MariaDB | ~30 min | A staging host on a subdomain |

Prerequisites for every path: **Node.js `>=22.20.0 <25`** (enforced in `package.json`; verified here
on 22.22.3) and **npm**. Nothing else — the server is Node's own `http` module, the test suite is
`node:test`, and the runtime dependency set is exactly `mysql2` and `bcryptjs`. There is no
framework, no build step for the server, and no `devDependencies` in the server package.

---

## 1. Get the code and install dependencies

From the repository root (the root manifest is an npm workspace over `packages/*` and `apps/*`):

```bash
git clone https://github.com/windelslife-wq/ai.git
cd ai
npm ci                                            # root lockfile: the server and its two dependencies
npm ci --prefix apps/workforce-platform/client    # the SPA's React/Vite toolchain
```

Two separate installs, two separate lockfiles — that is deliberate. The server package keeps its
dependency list at two runtime packages, so an install on the host cannot pull a framework in
through the workspace.

If you only want to *run* the server and not build the SPA, the second command is optional. If you
skip or forget the first, `src/db/pool.js` fails at startup with
`Cannot find package 'mysql2'` — that error means "dependencies are not installed", not "your
database configuration is broken".

## 2. Path A — local, no database

The file adapter stores everything in an append-only JSONL log under `STORAGE_DIR`. It needs no
server and is what the test suite and the local rehearsal use. It is **development-only** and says
so at runtime (`durability: "development-only"` on the readiness probe).

```bash
cd apps/workforce-platform

export NODE_ENV=development
export STORAGE_ADAPTER=file
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

# Create the RBAC baseline and the first administrator. Seed BEFORE starting the server:
# the file adapter keeps its index in memory, so a process started earlier will not see
# rows this command appends until it is restarted.
npm run seed:platform -- \
  --admin-username root \
  --admin-email root@example.test \
  --admin-password 'a password of at least 14 characters'

npm run verify:data          # 15 integrity checks; one WARNING is expected on the file adapter
npm start                    # node server.js
```

Then:

| URL | What it is |
|---|---|
| `http://localhost:3000/` | The public site — rendered per request, no build step |
| `http://localhost:3000/app/` | The member workspace SPA — **requires the client build (§5)**, otherwise a 404 |
| `http://localhost:3000/api/v1/health/live` | Liveness |
| `http://localhost:3000/api/v1/...` | The API |

`SESSION_SECRET` is always required, on every path, and must be at least 32 bytes — it keys the
CSRF derivation and the login-attempt hash, not just the cookie. The server never auto-loads a
`.env` file: export the variables, source a private file (`set -a; . ./.env; set +a`), or use
cPanel's environment UI.

On the file adapter, `verify:data --strict` **exits 1 by design**: the one WARNING ("adapter is not
production storage") is promoted to a failure. That is the correct answer for a file store, so run
`--strict` where it is meaningful — on MySQL, where nothing should warn.

`seed:platform` is idempotent, **refuses to create a second administrator**, and also re-applies
role/permission grants — so it is the supported way to repair a host whose seed rows were lost.
`--admin-password` can be replaced by `WF_BOOTSTRAP_ADMIN_PASSWORD` when you do not want the
password in the process list.

### Working on the SPA

```bash
npm run dev:client           # Vite, 0.0.0.0:5173, base /app/
```

The dev server proxies `/api/v1` server-side to `http://127.0.0.1:3000` (override with
`API_PROXY_TARGET`), so browser code only ever calls relative URLs and never `localhost`. Run the
API (`npm start`) alongside it. A LAN or proxied hostname reaches the SPA at
`http://<host>:5173/app/`.

## 3. Path B — local, against MySQL/MariaDB

```bash
# 1. Create a database and a user with rights to it (cPanel → MySQL Databases, or SQL).
#    The migration runner needs DDL: CREATE/ALTER/INDEX on that schema.

cd apps/workforce-platform
export NODE_ENV=development
export STORAGE_ADAPTER=mysql
export DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=windels_platform DB_USER=windels DB_PASSWORD='…'
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"

npm run migrate:status       # applied / PENDING / DRIFTED per migration
npm run migrate              # applies 001…019, checksum-versioned
npm run seed:platform -- --admin-username root --admin-password 'at least 14 characters'
npm run verify:data -- --strict    # on MySQL this must exit 0; --strict promotes warnings
npm start
```

Notes that matter:

- **`migrate` creates `wf_*` tables only.** It does not import PHP users or business data, does not
  touch legacy tables, and does not create an administrator — that is `seed:platform`'s job.
- **`DRIFTED` is not a repair prompt.** It means a file changed after it was applied. `--dry-run`
  and `--status` print it and exit 1. Reconcile by hand; never edit an applied migration.
- **`STORAGE_ADAPTER=auto`** (the default) picks `mysql` when `DB_HOST`/`DB_NAME`/`DB_USER` are set
  and `file` otherwise, so the server boots on a host with no database.
- **`STORAGE_ADAPTER=file` is refused in production** unless you also set
  `ALLOW_FILE_STORE_IN_PRODUCTION=1`. That refusal is deliberate: the file adapter has no
  transactions and its lock is single-process.

## 4. Path C — cPanel/Passenger (staging)

Full detail and caveats live in [`deploy/cpanel/`](../deploy/cpanel/README.md); this is the short
form.

**Preflight** — confirm with the host that the account has Application Manager / Passenger on
Node 22.x, MySQL/MariaDB with InnoDB, a terminal or equivalent for the migration command, cron, and
AutoSSL. Ordinary PHP-only cPanel is not enough. None of this has been verified against a real
cPanel account from this repository.

1. **Upload outside the web root** — e.g. `/home/CPANEL_USER/apps/windels-ai` — keeping the PHP app
   in its current document root. Never upload `.env` files or secrets.
2. **Create the application** in cPanel → Setup Node.js App: Node 22, application root = that
   private path, startup file = `apps/workforce-platform/passenger-start.cjs` (it binds cPanel's
   `PORT` on `0.0.0.0` and deliberately loads no `.env`).
3. **Set the environment** in the Application Manager UI. Required in production:

   ```ini
   NODE_ENV=production
   SESSION_SECRET=<at least 32 bytes, unique per environment>
   PUBLIC_BASE_URL=https://your-staging-hostname      # HTTPS, exact origin, no path
   DB_HOST=… DB_NAME=… DB_USER=… DB_PASSWORD=…
   ```

   `PUBLIC_BASE_URL` is required in production and must be a bare HTTPS origin — it is the value
   cross-origin auth requests are checked against. Leave `TRUST_PROXY=false` unless you have
   confirmed the proxy topology. `deploy/cpanel/ENVIRONMENT.md` tabulates the core variables;
   `.env.example` documents all 84 the config reads.
4. **Install production dependencies** from the private repository root, using the root lockfile:

   ```sh
   npm ci --workspace=@windels/workforce-platform --include-workspace-root=false --omit=dev
   ```
5. **Build the SPA** (§5) and make sure `apps/workforce-platform/public/app/` is part of what you
   deployed — the server serves that directory at `/app/`.
6. **Migrate, then restart:**

   ```sh
   npm run migrate --workspace=@windels/workforce-platform
   ```
7. **Check health** (§6) and enable AutoSSL/HTTPS.

Add the cron lines in §7 once the app is up. Scheduled jobs are CLI-only by design — **no HTTP
route can run a job or touch a lock**, and a test asserts that.

## 5. The SPA bundle

`public/` holds only real static files (`styles.css`, `site.js`, `icons/`). The generated documents
(`index.html`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `service-worker.js`) are
rendered per request and must never be committed as static copies. The React workspace is built
into `apps/workforce-platform/public/app/`, which is **git-ignored** — so a fresh checkout does not
have it, and `/app/` answers 404 until it exists.

Build it wherever you have the client's devDependencies:

```bash
# In the repository (root scripts)
npm run build:workforce-client

# Equivalently, next to the app
npm run build:client --prefix apps/workforce-platform
```

On a host where installing Vite is undesirable, build locally and upload
`apps/workforce-platform/public/app/` as part of the deployment. `npm run verify:install` checks the
bundle when it is present and points at this section when it is not.

## 6. Verify the installation

```bash
cd apps/workforce-platform
npm run verify:install     # 30 static checks; 29 + a SKIP when public/app/ is absent
npm run verify:data        # reads the configured store: readiness, RBAC baseline, collisions,
                           # dangling grants, orphaned sessions, bcrypt digests, state checksum
npm run check              # verify:install + the full test suite (981 tests, 68 files)
```

`verify:install` needs no data access and exits non-zero on any failure; it covers the engines
range, the dependency set (no framework, no devDependencies in the server package), required files,
the 19 migrations, `.env.example` coverage of the config surface, the production configuration
rules, the reproducible icon set, the absence of static copies of generated documents, and the
bundle.

Then, against the running host:

| Check | Expected |
|---|---|
| `GET /api/v1/health/live` | `200 {"status":"ok","uptimeSeconds":…,"node":"22.x"}` |
| `GET /api/v1/health/ready` | `200 {"status":"ready","database":true,"schema":true,"adapter":"mysql"}`. A **503 `not_ready` is the honest answer** for a missing database, a partial schema or a failed probe — it carries `retry-after: 5`, and the underlying error (which can contain credentials) stays in the log. On the file adapter it also reports `durability: "development-only"` |
| `GET /` | The public site renders |
| `GET /app/` | The workspace SPA loads (requires §5) |
| Sign in | The administrator created by `seed:platform` |

The signed-in navigation shows what the platform actually does for your role; entries your role
cannot use are shown **locked rather than hidden**.

## 7. Scheduled jobs (cron)

Three CLI entry points, all idempotent, all CLI-only. Add lines in cPanel → Cron Jobs:

```cron
# Operations sweep: portfolio risk + stale proposal expiry. Measures unless --apply.
* * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/scheduled-jobs.mjs --apply >> /home/USER/logs/workforce-cron.log 2>&1

# Sports: nine jobs in legacy's order, hourly.
0 * * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/sports-jobs.mjs --json >> /home/USER/logs/workforce-sports-cron.log 2>&1

# Lottery: seven jobs in legacy's order, after the daily draw.
30 5 * * * cd /home/USER/apps/workforce-platform && . /home/USER/wf-cron.env && /usr/local/bin/node tools/lottery-jobs.mjs --json >> /home/USER/logs/workforce-lottery-cron.log 2>&1
```

Three things about those lines are load-bearing:

- **Use the absolute `node` path.** cron does not inherit an interactive shell's `PATH`.
- **`cd` first.** `loadConfig` resolves relative storage paths against the working directory.
- **Source the environment yourself.** `loadConfig` is one gate for the whole platform and refuses
  without `SESSION_SECRET` and the `DB_*` set. cPanel supplies those to Passenger through the
  Application Manager, not from a file, so cron gets nothing for free. Keep them in a file **outside
  the web root** with `0600`, and never in the crontab line itself, where they are readable in the
  process list.

Read these two before trusting the schedule. **The file adapter's lock is single-process only**
(`crossProcessSafety: false`), so real cron needs MySQL to be safe against overlap. And **a skipped
run is not a failure**: if the previous minute's run is still going, the next reports `SKIPPED`,
names the holder, and exits 0. Exit 1 means refused, failed, or completed with a stage error — a
cron that exits 0 while a job is broken is how a job stops running unnoticed. Neither line has been
run under a real crontab.

## 8. Backups, restore and upgrades

```bash
npm run backup            # writes to ./backups/<UTC stamp>. file: copies the store log and uploads
                          # with a sha256 manifest. mysql: mysqldump --single-transaction, with the
                          # password in a 0600 defaults file — never in argv. Override the target with
                          # --destination DIR.

# Prove a backup is usable before you need it:
node tools/backup.mjs verify --backup /path/to/backups/2026-10-13T10-04-42Z

# Restore. --backup is REQUIRED; --destination defaults to the configured store.
npm run restore -- --backup /path/to/backups/2026-10-13T10-04-42Z
```

`restore` verifies every manifest hash **before** writing anything, refuses a **non-empty** target
store without `--force` ("a mixed restore is not supported"), and tells you to restart the
application afterwards. Take a backup before migrations, retention prunes, or any data change — the
prune and the importers delete irreversibly.

Upgrade procedure: take a backup → deploy the new code → `npm ci` (and the client install if you
build on the host) → `npm run migrate:status` → `npm run migrate` → restart the application →
re-run §6. Keep the PHP application and its database untouched throughout.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing required environment variable(s): SESSION_SECRET` | Export it — it is required on every path. |
| `SESSION_SECRET must contain at least 32 bytes` | Generate a real one: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. |
| `Cannot find package 'mysql2'` | Dependencies are not installed. Run `npm ci` from the repository root. |
| `STORAGE_ADAPTER=file is not approved for production` | Use MySQL, or set `ALLOW_FILE_STORE_IN_PRODUCTION=1` deliberately. |
| `PUBLIC_BASE_URL must be a valid HTTPS origin` | Production requires a bare HTTPS origin — no path, query or credentials. |
| Readiness answers 503 `not_ready` | Read `database`/`schema`/`detail` in the body: no store, a dropped connection or a partial schema. The credentials stay in the log, not the response. |
| `/app/` returns 404 while `/` works | The SPA bundle is not built. See §5. |
| Sign-in fails right after seeding | The running process predates the seed. Restart it — the file adapter reads its index at startup. |
| `DRIFTED` migration | A file changed after it was applied. Do not apply; reconcile by hand. |
| Cron exits 1 with `FAILED` / `refused` | One job failed or the lock was refused. `SKIPPED` with a named holder exits 0 and is normal. |
| `verify:data --strict` exits 1 on the file adapter | Expected: `--strict` promotes the durability warning. It is the MySQL run that must be clean. |
| `restore` says `--backup DIR is required` | Pass it: `npm run restore -- --backup <stamp dir>`. |

## 10. What is verified, and what is not

Verified in this repository on Node 22.22.3: the install and start sequence above; the file adapter
path end to end (seed, integrity check, sign-in, every console screen); `verify:install` at 30/30
with the bundle and 29/29 without; `verify:data` at 15 checks + 1 expected warning on the file
adapter; `npm run check` green (981 tests / 68 files); the client build; and the three cron CLIs
executed by hand against a real store.

**Not verified anywhere in this repository:** a real MySQL/MariaDB server (migrations 001–019 are
applied to no database), a real cPanel/Passenger account, an installed crontab, outbound HTTPS to a
live data provider, a licensed feed, or any MT5 demo terminal. The PHP↔Node numeric parity diff
(F-26) has not been run. Treat the cPanel steps as reasoned from the platform's documented
behaviour, not as observed deployment evidence, and do not cut traffic over on the strength of this
guide — see [`migration/RISK_REGISTER.md`](migration/RISK_REGISTER.md) and
[`migration/STATUS.md`](migration/STATUS.md) for the open findings.

## 11. Where to go next

| Document | What it covers |
|---|---|
| [`deploy/cpanel/`](../deploy/cpanel/README.md) | cPanel specifics: environment table, health checks, `.htaccess`, rollback |
| [`apps/workforce-platform/README.md`](../apps/workforce-platform/README.md) | What the platform does, every operational command, module acceptance levels |
| [`migration/STATUS.md`](migration/STATUS.md) | Current phase status and what each gate proved |
| [`migration/UNFINISHED_MODULES.md`](migration/UNFINISHED_MODULES.md) | The port backlog, row by row |
| [`UNFINISHED_MODULE_INVENTORY.md`](UNFINISHED_MODULE_INVENTORY.md) | Names only: what is unfinished, module by module |
