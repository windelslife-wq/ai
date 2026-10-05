# Node staging rollback and recovery

## Current side-by-side phase

The PHP application remains the production service and rollback target. The Node foundation must be deployed only on a separate staging subdomain and a new database. It writes only its own `wf_*` tables; no production traffic cutover or PHP table mutation is part of this phase.

If the Node staging app fails:

1. Use cPanel Application Manager to stop/restart or remove the staging Node application mapping.
2. Keep the current PHP hostname/document root and PHP database unchanged; users continue to use PHP.
3. Preserve Passenger logs and the Node staging database for diagnosis. Do not delete data until a backup has been verified.
4. Restore the Node staging database from the most recent verified backup only if the new schema/data is damaged. The foundation migration is checksum-protected; do not edit an applied migration file to repair it.
5. Correct the deployment/environment issue, deploy to staging again, re-run the health checks, and record the result.

## Future cutover gate (not yet authorized or implemented)

Before any production switch, require module-by-module parity acceptance, an approved legacy data importer, backup/restore rehearsal, a verified delta/write-freeze plan, security and permission tests, real cPanel/Passenger verification, monitoring, an agreed stability period, and explicit human approval. Keep the PHP deployment and backups available throughout the rollback window. Never retire/delete legacy code or history as part of a routine Node deployment.
