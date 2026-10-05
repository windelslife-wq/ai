# Legacy identity import — controlled, one-time Node migration step

**Status:** importer code and unit tests exist; the import has **not** been run against production or a real MySQL/MariaDB server. Do not run it against live data without a reviewed backup and explicit approval.

## What it imports

From the legacy PHP tables `users`, `roles`, `permissions`, `user_roles`, and `role_permissions`, into the isolated Node tables `wf_users`, `wf_user_profiles`, `wf_roles`, `wf_permissions`, `wf_user_roles`, and `wf_role_permissions`.

- Preserves legacy user IDs, six-digit IDs when present, username/email, bcrypt password hashes, active/inactive state, display name, last-login time, and profile-image path.
- Preserves role/permission keys and relationships. Invalid or dangling references, normalized identity collisions, unsupported password hashes, invalid timestamps, and target-account conflicts fail closed.
- A pre-username legacy row receives a stable `legacy_<id>` username. A missing six-digit ID remains `NULL`; email and the generated username still work.
- The profile-image path is preserved as metadata; the referenced file is **not** copied. Upload/file migration is a separate step.
- Existing PHP sessions and login-event history are not imported; users will need to sign in again. No administrator is created.

This is an initial snapshot importer, not a live synchronizer or delta-import facility. A successful import writes a `legacy_identity_v1` ledger row in the same transaction. Subsequent apply attempts are refused to prevent replay from restoring old passwords, active flags, or permissions over Node-side changes.

## Command procedure

1. Back up both databases. Use a new, otherwise-empty Node target database with migrations 001 and 002 applied.
2. Set the target `DB_*` variables using the host's protected application settings. Supply temporary source `LEGACY_DB_*` variables only in a protected one-shot CLI environment. Give the source DB user **SELECT-only** grants and the target DB user only its dedicated database grants. Never put source credentials in Git, `.env`, shell history, or the long-running Passenger environment; keep target DB credentials in the protected cPanel settings required by the app.
3. Run the default dry run. It reads a repeatable-read source snapshot, validates rows and target conflicts, and makes no target changes:

   ```sh
   npm run import:identity --workspace=@windels/workforce-platform -- --dry-run
   ```

4. Review the counts and conflict result with the data owner. Stop if the source schema or records do not match the expected legacy tables.
5. Proceed only if the dry run reports `targetUsersBeforeImport: 0` and `targetConflicts: 0`. The apply command independently locks/checks that the target identity table is empty, then records the completion checksum in the same transaction. Only with explicit approval, run the transactional apply once:

   ```sh
   npm run import:identity --workspace=@windels/workforce-platform -- --apply
   ```

6. Clear the temporary source credentials immediately:

   ```sh
   unset LEGACY_DB_HOST LEGACY_DB_PORT LEGACY_DB_NAME LEGACY_DB_USER LEGACY_DB_PASSWORD LEGACY_DB_CONNECTION_LIMIT
   ```

A conflict aborts the import; resolve the mapping in a reviewed migration rather than merging accounts by email or deleting target data. The source read is consistent for MySQL/MariaDB InnoDB tables; verify the actual source engine before relying on snapshot semantics.

## Implementation and test limits

The source adapter uses a fixed allow-list of known legacy columns and tolerates optional `username`, `user_uid`, `profile_image`, and `last_login_at` columns being absent. The planner and adapters have unit tests with fake pools; **there is no real MySQL integration test yet**, so this code is not an import acceptance or cutover sign-off.
