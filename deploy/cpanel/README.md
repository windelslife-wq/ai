# cPanel deployment — Node.js migration target

> **Status: staging/bootstrap only.** This deploys the JavaScript foundation in `apps/workforce-platform`; it does not replace the PHP/CodeIgniter application or provide parity for the trading, sports, lottery, learning, lead-discovery, portfolio, or other product modules. Keep the existing PHP site as the production service and rollback target. Do not redirect production traffic based on this guide.

## 1. Hosting preflight

Before creating the application, confirm with the hosting provider that this account has:

- cPanel **Setup Node.js App / Application Manager** using Passenger and Node.js **22.x** (the app declares `>=22 <25`).
- A usable terminal/SSH or equivalent for running the versioned database migration command.
- MySQL/MariaDB with InnoDB, foreign keys, and JSON columns; a dedicated database/user and enough connection slots for a pool capped at five.
- HTTPS/AutoSSL, Passenger environment variables, application restart/log access, and outbound network rules documented.
- A cPanel cron facility for future short-lived jobs. This foundation currently has **no cron job**.

The actual cPanel account, Passenger proxy behavior, resource quotas, MySQL version, and outbound-network policy have **not been verified** in this repository. Ordinary PHP-only cPanel is not enough.

## 2. Install side-by-side

1. Back up the current site and database. Create a **new staging subdomain** such as `node-staging.example.com`; do not point the existing production hostname at this app.
2. Create a new MySQL database and a dedicated least-privilege user in cPanel → MySQL Databases. Do not import `database/production.sql` into the new database.
3. Upload the repository to a private path outside `public_html`, for example `/home/CPANEL_USER/apps/windels-ai`. Keep the PHP app available in its current document root. Do not upload secrets or a populated local `.env` file.
4. In cPanel → Setup Node.js App, create an application for the staging subdomain. Select Node 22, set the application root to the private repository path, and set the startup file to `apps/workforce-platform/passenger-start.cjs`. The entry binds to cPanel's `PORT` on `0.0.0.0`.
5. Set the variables listed in [ENVIRONMENT.md](ENVIRONMENT.md) in the Application Manager UI. Use the staging origin, database credentials for the new database, and a unique random `SESSION_SECRET` of at least 32 bytes. Do not put secrets in `public_html`, source control, or command-line arguments.
6. From the private repository root, install only this workspace's production dependencies with the root lockfile:

   ```sh
   npm ci --workspace=@windels/workforce-platform --include-workspace-root=false --omit=dev
   ```

   If the provider's Application Manager has a supported NPM-install action, it may be used instead; confirm its log shows the correct workspace and production-only install.
7. Run the schema migration against the new staging database, then restart the app through Application Manager:

   ```sh
   npm run migrate --workspace=@windels/workforce-platform
   ```

   The migration creates only `wf_*` tables and is checksum-versioned. It does **not** import PHP users or business data, modify legacy tables, or create an administrator.
8. Enable AutoSSL/HTTPS for the staging subdomain, restart the Node application, and follow [HEALTHCHECK.md](HEALTHCHECK.md).

## 3. Operations and rollback

- Configure no scheduled task for this foundation. See [CRON.md](CRON.md); never start a persistent worker through cron.
- Back up the new database before future schema/data changes. See [ROLLBACK.md](ROLLBACK.md).
- Keep the PHP app and its database unchanged and available. Traffic cutover, legacy writes, account import, and production deployment require later parity gates and explicit approval.
- Store Passenger/application logs outside the public document root and monitor failed starts, memory, CPU, database connections, and health responses.

## 4. Current limitations

The Node app currently provides versioned health endpoints and an identity/RBAC/session foundation. It has no migrated business module UI, no legacy-account importer, no production MySQL integration run in this workspace, and no real-cPanel deployment evidence. The response at `/` explicitly reports `productionReplacement: false` until the broader migration is accepted.
