# cPanel deployment — Node.js migration target

> **Status: staging/bootstrap only.** This deploys the JavaScript platform in `apps/workforce-platform`; it does not replace the PHP/CodeIgniter application. Keep the existing PHP site as the production service and rollback target. Do not redirect production traffic based on this guide.
>
> **Install steps live in one place:** [`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §4
> covers this path end to end (preflight, upload, Application Manager, environment, dependencies,
> the SPA bundle, migration, health checks). The files in this directory are the cPanel-specific
> detail that guide points at: [ENVIRONMENT.md](ENVIRONMENT.md), [HEALTHCHECK.md](HEALTHCHECK.md),
> [HTACCESS.md](HTACCESS.md), [CRON.md](CRON.md), [ROLLBACK.md](ROLLBACK.md).

## 1. Hosting preflight

Before creating the application, confirm with the hosting provider that this account has:

- cPanel **Setup Node.js App / Application Manager** using Passenger and Node.js **22.x** (the app declares `>=22.20.0 <25`).
- A usable terminal/SSH or equivalent for running the versioned database migration command.
- MySQL/MariaDB with InnoDB, foreign keys, and JSON columns; a dedicated database/user and enough connection slots for a pool capped at five.
- HTTPS/AutoSSL, Passenger environment variables, application restart/log access, and outbound network rules documented.
- A cPanel cron facility: the platform ships three scheduled CLI entry points (see [CRON.md](CRON.md)).

The actual cPanel account, Passenger proxy behavior, resource quotas, MySQL version, and outbound-network policy have **not been verified** in this repository. Ordinary PHP-only cPanel is not enough.

## 2. Install side-by-side

The step-by-step sequence — upload path, Application Manager settings, environment variables,
dependency install, the SPA bundle, migration and health checks — is in
[`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §4. The essentials:

1. Back up the current site and database. Create a **new staging subdomain** such as `node-staging.example.com`; do not point the existing production hostname at this app.
2. Create a new MySQL database and a dedicated least-privilege user in cPanel → MySQL Databases. Do not import `database/production.sql` into the new database — that is the PHP schema.
3. Upload the repository to a private path outside `public_html`, for example `/home/CPANEL_USER/apps/windels-ai`. Keep the PHP app available in its current document root. Do not upload secrets or a populated local `.env` file.
4. In cPanel → Setup Node.js App, create an application for the staging subdomain. Select Node 22, set the application root to the private repository path, and set the startup file to `apps/workforce-platform/passenger-start.cjs`. The entry binds to cPanel's `PORT` on `0.0.0.0`.
5. Set the variables listed in [ENVIRONMENT.md](ENVIRONMENT.md) in the Application Manager UI — at minimum `NODE_ENV=production`, a unique random `SESSION_SECRET` of at least 32 bytes, the `DB_*` set for the new database, and `PUBLIC_BASE_URL` as the bare HTTPS staging origin. Do not put secrets in `public_html`, source control, or command-line arguments.
6. From the private repository root, install only this workspace's production dependencies with the root lockfile:

   ```sh
   npm ci --workspace=@windels/workforce-platform --include-workspace-root=false --omit=dev
   ```

   If the provider's Application Manager has a supported NPM-install action, it may be used instead; confirm its log shows the correct workspace and production-only install.

7. Build the workspace SPA (`npm run build:workforce-client`, or build locally and upload `apps/workforce-platform/public/app/`) so `/app/` serves it. `public/app/` is git-ignored, so it is not in a fresh checkout — without it `/app/` answers 404 while the public site and the API work normally.
8. Run the schema migration against the new staging database, then restart the app through Application Manager:

   ```sh
   npm run migrate --workspace=@windels/workforce-platform
   ```

   The migration creates only `wf_*` tables and is checksum-versioned. It does **not** import PHP users or business data, modify legacy tables, or create an administrator. If the host must have a sign-in account, create one deliberately with `npm run seed:platform -- --admin-username … --admin-password …` and change the password after the first sign-in.
9. Enable AutoSSL/HTTPS for the staging subdomain, restart the Node application, and follow [HEALTHCHECK.md](HEALTHCHECK.md).

## 3. Operations and rollback

- Scheduled jobs are the three CLI entry points in [CRON.md](CRON.md) — never a persistent worker, and no HTTP route can run a job or take a lock.
- Back up the new database before future schema/data changes: `npm run backup` / `npm run restore`, and see [ROLLBACK.md](ROLLBACK.md).
- Keep the PHP app and its database unchanged and available. Traffic cutover, legacy writes, account import, and production deployment require later parity gates and explicit approval.
- Store Passenger/application logs outside the public document root and monitor failed starts, memory, CPU, database connections, and health responses.

## 4. Current limitations

The Node platform implements a large part of the legacy application — identity and accounts, the
public site, market data, analysis, the Strategy Lab, paper trading, risk governance, the
proposal workflow, notifications, the audit browser, portfolio optimization, the broker connector
boundary, sports and lottery intelligence, and the workspace console screens — with each module's
acceptance level stated by `GET /api/v1/system/status` and never upgraded on this page.

What it does **not** have: a verified cPanel/Passenger deployment (nothing here has run on a real
account), any migration applied to a real MySQL/MariaDB server, a legacy-data import that has been
rehearsed or approved, live provider or broker connectivity, and any order-routing or automated
trading path. Language learning and lead discovery remain legacy-only. `productionReplacement`
remains false until the broader migration is accepted — see
[`docs/migration/STATUS.md`](../../docs/migration/STATUS.md) and
[`docs/UNFINISHED_MODULE_INVENTORY.md`](../../docs/UNFINISHED_MODULE_INVENTORY.md).
