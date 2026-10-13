# Node staging rollback and recovery

Install context: [`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §4 and §8.

## Current side-by-side phase

The PHP application remains the production service and rollback target. The Node platform is
deployed only on a separate staging subdomain and a new database. It writes only its own `wf_*`
tables; no production traffic cutover and no PHP table mutation is part of this phase.

If the Node staging app fails:

1. Use cPanel Application Manager to stop/restart or remove the staging Node application mapping.
2. Keep the current PHP hostname/document root and PHP database unchanged; users continue to use PHP.
3. Preserve Passenger logs and the Node staging database for diagnosis. Do not delete data until a backup has been verified.
4. Restore the Node staging database from the most recent verified backup only if the new schema/data is damaged. `npm run restore` verifies every manifest hash **before** writing, and refuses a non-empty file store without `--force`. Migrations are checksum-protected; do not edit an applied migration file to repair it.
5. Correct the deployment/environment issue, deploy to staging again, re-run
   [HEALTHCHECK.md](HEALTHCHECK.md), and record the result.

Rolling back an *application* release is a code deploy plus a restart; rolling back a *schema* is a
restore, because migrations are forward-only in this tree (there are no down-migrations by design —
a down-migration that loses a column loses the evidence in it). If a migration is wrong, restore the
database and fix the migration file before applying it again; if it is already applied on a staging
host you intend to keep, reconcile by hand and record it, exactly as a `DRIFTED` migration requires.

## Future cutover gate (not yet authorized or implemented)

Before any production switch, require module-by-module parity acceptance, an approved legacy data
importer, backup/restore rehearsal, a verified delta/write-freeze plan, security and permission
tests, real cPanel/Passenger verification, monitoring, an agreed stability period, and explicit
human approval. Keep the PHP deployment and backups available throughout the rollback window. Never
retire/delete legacy code or history as part of a routine Node deployment.

Still unverified for that gate: no migration has been applied to a real MySQL/MariaDB server, no
Passenger instance has run this application, the PHP↔Node numeric parity diff (F-26) has not been
run, and no crontab exists. See
[`docs/migration/RISK_REGISTER.md`](../../docs/migration/RISK_REGISTER.md) for the open findings.
