/**
 * A backup you cannot restore is a file, not a backup (audit finding F-02).
 * These tests drive the real tool against the real file adapter: take a backup,
 * destroy the store, restore it, and require the state to be byte-identical in
 * meaning (checksum) and usable (sign in).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import bcrypt from "bcryptjs";
import { createFileStore } from "../src/persistence/file-store.js";
import { createBackup, restoreBackup, verifyBackup, buildMysqldumpArgs, tablesFromMigrations } from "../tools/backup.mjs";
import { testConfig } from "./helpers.js";

async function tempApp() {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-backup-"));
  const config = testConfig({ __directory: directory });
  return { config, directory, storeDir: config.storage.fileDir };
}

test("F-13 a file-store backup verifies, and restores an identical store after the original is deleted", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  const created = await store.createUser({ username: "persisted", email: "persisted@example.test", passwordHash: await bcrypt.hash("a long enough password", 4), displayName: "Persisted" });
  await store.createSession({ tokenHash: "b".repeat(64), userId: created.id, expiresAt: new Date(Date.now() + 600_000).toISOString(), deviceLabel: "studio" });
  await store.recordAudit({ actorId: created.id, action: "identity.test", entityType: "identity", entityId: created.id, details: { n: 1 } });
  await store.setAvatarPath(created.id, "/api/v1/files/avatars/u1_deadbeefdeadbeefdeadbeefdeadbeef.png");
  // Uploads live outside the store directory and must travel with it.
  await mkdir(config.uploads.dir, { recursive: true });
  await writeFile(path.join(config.uploads.dir, "u1_deadbeefdeadbeefdeadbeefdeadbeef.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const checksumBefore = await store.checksum();
  await store.close();

  const result = await createBackup({ config, destination: path.join(directory, "backups") });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, "file");
  const manifest = JSON.parse(await readFile(path.join(result.backupDir, "manifest.json"), "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("store/windels-store.jsonl"), paths.join(","));
  assert.ok(paths.includes("uploads/u1_deadbeefdeadbeefdeadbeefdeadbeef.png"), "avatar bytes must be in the backup");
  assert.equal(manifest.adapter, "file");
  assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal((await verifyBackup({ backupDir: result.backupDir })).ok, true);

  await rm(storeDir, { recursive: true, force: true });
  await rm(config.uploads.dir, { recursive: true, force: true });

  const restored = await restoreBackup({ config, backupDir: result.backupDir });
  assert.equal(restored.ok, true);
  assert.equal(restored.checksum, checksumBefore, "the restored store must be identical, not merely present");
  assert.equal((await stat(path.join(config.uploads.dir, "u1_deadbeefdeadbeefdeadbeefdeadbeef.png"))).size, 4, "the avatar bytes come back too");

  const reopened = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => reopened.close());
  const user = await reopened.findUserByIdentifier("persisted");
  assert.equal(user.username, "persisted");
  assert.equal(user.email, "persisted@example.test");
  assert.match(user.password_hash, /^\$2[aby]\$0?4\$/, "a digest written by the test harness comes back byte-for-byte, not re-hashed");
  const session = await reopened.findSession("b".repeat(64));
  assert.equal(session.user.displayName, "Persisted", "the profile row travels with the user row");
  assert.equal((await reopened.listSessions(created.id))[0].deviceLabel, "studio", "sessions and their device labels survive a restore");
  assert.equal((await reopened.listAuditEvents({ userId: created.id })).total, 1, "the audit trail is part of the backup, not an afterthought");
  assert.equal(await reopened.findAvatarPath(created.id), "/api/v1/files/avatars/u1_deadbeefdeadbeefdeadbeefdeadbeef.png");
});

test("F-13 a restore refuses to overwrite a non-empty store unless forced", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  await store.createUser({ username: "first", email: "first@example.test", passwordHash: "$2y$12$x", displayName: "First" });
  await store.close();
  const { backupDir } = await createBackup({ config, destination: path.join(directory, "backups") });

  // Write something new, then require the refusal.
  const store2 = await createFileStore({ dir: storeDir, syncWrites: false });
  await store2.createUser({ username: "second", email: "second@example.test", passwordHash: "$2y$12$y", displayName: "Second" });
  await store2.close();

  await assert.rejects(restoreBackup({ config, backupDir }), /already holds \d+ file\(s\)/);
  assert.ok((await readdir(storeDir)).length > 0, "the refusal must not have touched anything");

  const forced = await restoreBackup({ config, backupDir, force: true });
  assert.equal(forced.ok, true);
  const after = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => after.close());
  assert.equal(await after.findUserByIdentifier("second"), null, "a forced restore replaces the state, as documented");
  assert.equal((await after.findUserByIdentifier("first")).username, "first");
});

test("F-13 a damaged backup is refused before anything is overwritten", async (t) => {
  const { config, directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  await store.createUser({ username: "tampered", email: "tampered@example.test", passwordHash: "$2y$12$z", displayName: "T" });
  await store.close();
  const { backupDir } = await createBackup({ config, destination: path.join(directory, "backups") });
  const logPath = path.join(backupDir, "store", "windels-store.jsonl");
  await writeFile(logPath, `${await readFile(logPath, "utf8")}{"op":"forged"}\n`, "utf8");

  const damaged = await verifyBackup({ backupDir });
  assert.equal(damaged.ok, false);
  assert.match(damaged.problems.join("\n"), /size \d+ does not match the recorded/);
  await assert.rejects(restoreBackup({ config, backupDir }), /Refusing to restore an unverifiable backup/);
});

test("F-13 MySQL dumps use the host tool and never put the password in argv", () => {
  const args = buildMysqldumpArgs({ host: "db.internal", port: 3306, user: "wf_admin", password: "hunter2", name: "wf_prod" });
  assert.ok(args.includes("--single-transaction"), "a consistent non-locking snapshot is the only safe dump on a live shop");
  assert.ok(args.includes("--no-tablespaces"), "without this, a shared host aborts the dump on information_schema privileges");
  assert.ok(args.includes("--routines") && args.includes("--triggers"), "routines and triggers are part of the schema");
  assert.ok(args.includes("wf_prod"));
  assert.equal(args.some((entry) => entry.includes("hunter2")), false, "a secret in argv is readable by any process on the host");
  assert.equal(args.some((entry) => entry === "-p" || entry.startsWith("--password")), false);
  assert.ok(args.some((entry) => entry.startsWith("--defaults-extra-file=")) === false, "the defaults file is added by the caller, next to the spawn");
});

test("F-13 the MySQL row counts cover every table the migrations create, and nothing else", async (t) => {
  // The counts in `snapshot.json` are what an operator compares before and after a
  // restore, so the list has to match the schema exactly. It used to be a literal
  // array in the tool, and it was wrong in both directions:
  //
  //   * missing `wf_contact_inquiries` (Phase 3), `wf_data_imports` and
  //     `wf_analysis_runs` (Phase 5) — created by committed migrations, never
  //     counted, so a restore could not prove those tables came back;
  //   * counting `wf_user_files`, which nothing in this repository creates or
  //     references. Avatars live in `wf_user_profiles.profile_image`
  //     (`account-repository.js` `setAvatarPath`). On MySQL that made
  //     `SELECT COUNT(*) FROM wf_user_files` throw `ER_NO_SUCH_TABLE`, so **every
  //     MySQL backup failed** — recorded as finding F-28. No test caught it because
  //     this suite drives the file adapter only and the sandbox has no MySQL.
  //
  // The list is now derived from `src/db/migrations/*.sql`; this pins the derivation.
  const tables = tablesFromMigrations();

  assert.deepEqual(tables, [...tables].sort(), "deterministic order, so two backups are comparable");
  assert.equal(new Set(tables).size, tables.length, "no duplicates across migrations");
  for (const table of tables) assert.match(table, /^wf_[a-z_]+$/, `${table} is interpolated into a COUNT query, so it must be a plain identifier`);

  // Phase 12 added `wf_job_locks` (migration 010), taking the schema to 24 tables.
  // Phase 16 adds the seven `wf_sports_*` tables (migration 011), taking it to 31.
  // Slice 3 adds the four intelligence tables (migration 012), taking it to 35.
  // Slice 4 adds the three ticket tables (migration 013), taking it to 38.
  // Slice 5 adds the backtest and model-metrics tables (migration 014), taking it to
  // 40. `sports_performance_snapshots` is deliberately absent: its only legacy writer
  // is the unported performance cron, and a table with no writer is dead schema.
  //
  // This count is the assertion that a backup covers the schema: `backup.mjs` derives
  // its table list by parsing `CREATE TABLE` out of the migrations, so a table added
  // by a migration is backed up automatically — but a table added to a migration and
  // NOT counted here would be backed up without this test ever proving it can be
  // restored. The number moving is the point: it forces whoever adds a table to look
  // at whether the restore path covers it.
  assert.equal(tables.length, 65, `expected the 65 tables the migrations create, got: ${tables.join(", ")}`);
  assert.ok(!tables.includes("wf_user_files"), "the phantom table must stay out — counting it broke MySQL backups");
  for (const expected of [
    "wf_analysis_runs",
    "wf_backtests",
    "wf_contact_inquiries",
    "wf_data_imports",
    "wf_execution_proposals",
    "wf_job_locks",
    "wf_journal_entries",
    "wf_notifications",
    "wf_schema_migrations",
    "wf_strategies",
    // Migration 011. Listed individually rather than by a prefix loop, so that a
    // renamed or dropped table fails here by name.
    "wf_sports_data_sources",
    "wf_sports_provider_health",
    "wf_sports_matches",
    "wf_sports_odds",
    "wf_sports_results",
    "wf_sports_data_quality_assessments",
    "wf_sports_sync_runs",
    // Migration 016 (row 15 slice 1): the lottery foundation, named for the same
    // reason the sports tables are.
    "wf_lotteries",
    "wf_lottery_rules",
    "wf_lottery_data_sources",
    "wf_lottery_provider_health",
    "wf_lottery_draws",
    "wf_lottery_draw_numbers",
    "wf_lottery_sync_runs",
    // Migration 017 (row 15 slice 2): combinations + AI decisions.
    "wf_lottery_combinations",
    "wf_lottery_ai_decisions",
    // Migration 018 (row 15 slice 3): saved tickets + their number lines.
    "wf_lottery_tickets",
    "wf_lottery_ticket_lines",
    // Migration 019 (row 15 slice 4): backtest reports + model versions.
    "wf_lottery_backtests",
    "wf_lottery_model_versions",
    // Migration 020 (row 17 — Phase 45): organization-scoped Lead Discovery tables.
    "wf_lead_organizations",
    "wf_lead_organization_members",
    "wf_leads",
    "wf_lead_notes",
    "wf_lead_activities",
    "wf_lead_collections",
    "wf_lead_collection_leads",
    "wf_lead_search_history",
    "wf_lead_duplicate_candidates",
    "wf_lead_duplicate_resolutions",
    "wf_lead_export_history",
  ]) {
    assert.ok(tables.includes(expected), `${expected} must be counted`);
  }

  // Every collection the file adapter reports must have a MySQL counterpart counted,
  // so the two adapters describe the same world. `wf_data_imports` and
  // `wf_schema_migrations` are MySQL-side bookkeeping with no file-store collection.
  const { directory, storeDir } = await tempApp();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  try {
    const counted = {
      users: "wf_users",
      profiles: "wf_user_profiles",
      sessions: "wf_sessions",
      roles: "wf_roles",
      permissions: "wf_permissions",
      userRoles: "wf_user_roles",
      rolePermissions: "wf_role_permissions",
      audit: "wf_audit_events",
      inquiries: "wf_contact_inquiries",
      analysisRuns: "wf_analysis_runs",
      strategies: "wf_strategies",
      backtests: "wf_backtests",
      journalEntries: "wf_journal_entries",
      tradingState: "wf_trading_state",
      paperAccounts: "wf_paper_accounts",
      paperOrders: "wf_paper_orders",
      paperPositions: "wf_paper_positions",
      paperTrades: "wf_paper_trades",
      paperDeployments: "wf_paper_deployments",
      executionProposals: "wf_execution_proposals",
      notifications: "wf_notifications",
      // Phase 12: discovered automatically, because `backup.mjs` derives its table
      // list by parsing `CREATE TABLE` out of the migrations rather than keeping a
      // second list that can drift. This mapping is the assertion that the new
      // file-store collection really does have a MySQL counterpart being counted.
      jobLocks: "wf_job_locks",
      // Phase 16: one entry per sports collection. This map is what makes "the two
      // adapters describe the same world" checkable — a file-store collection with no
      // MySQL counterpart would be backed up as a directory and silently missing from
      // a SQL restore.
      sportsProviders: "wf_sports_data_sources",
      sportsHealth: "wf_sports_provider_health",
      sportsMatches: "wf_sports_matches",
      sportsOdds: "wf_sports_odds",
      sportsResults: "wf_sports_results",
      sportsQuality: "wf_sports_data_quality_assessments",
      sportsSyncRuns: "wf_sports_sync_runs",
      // Slice 3 (migration 012): the decision chain.
      sportsModelVersions: "wf_sports_model_versions",
      sportsPredictions: "wf_sports_predictions",
      sportsConfigurations: "wf_sports_configurations",
      sportsCalibrations: "wf_sports_calibrations",
      // Slice 4 (migration 013): tickets and the daily run.
      sportsTickets: "wf_sports_tickets",
      sportsTicketSelections: "wf_sports_ticket_selections",
      sportsDailyTickets: "wf_sports_daily_tickets",
      // Slice 5 (migration 014): backtests and measured model metrics.
      sportsBacktests: "wf_sports_backtests",
      sportsModelMetrics: "wf_sports_model_metrics",
      // Row 19 (migration 015): performance snapshots — the table 014 deliberately
      // refused to create until its only writer (the cron's performance job) arrived.
      sportsPerformanceSnapshots: "wf_sports_performance_snapshots",
      // Row 15 slice 1 (migration 016): the lottery foundation. The provider
      // registry table is wf_lottery_data_sources — the ENTITY is lotteryProviders,
      // mirroring legacy's data-source table and the sports entity's own naming.
      lotteries: "wf_lotteries",
      lotteryRules: "wf_lottery_rules",
      lotteryProviders: "wf_lottery_data_sources",
      lotteryHealth: "wf_lottery_provider_health",
      lotteryDraws: "wf_lottery_draws",
      lotteryDrawNumbers: "wf_lottery_draw_numbers",
      lotterySyncRuns: "wf_lottery_sync_runs",
      lotteryCombinations: "wf_lottery_combinations",
      lotteryAiDecisions: "wf_lottery_ai_decisions",
      lotteryTickets: "wf_lottery_tickets",
      lotteryTicketLines: "wf_lottery_ticket_lines",
      lotteryBacktests: "wf_lottery_backtests",
      lotteryModelVersions: "wf_lottery_model_versions",
      leadOrganizations: "wf_lead_organizations",
      leadOrganizationMembers: "wf_lead_organization_members",
      leads: "wf_leads",
      leadNotes: "wf_lead_notes",
      leadActivities: "wf_lead_activities",
      leadCollections: "wf_lead_collections",
      leadCollectionLeads: "wf_lead_collection_leads",
      leadSearchHistory: "wf_lead_search_history",
      leadDuplicateCandidates: "wf_lead_duplicate_candidates",
      leadDuplicateResolutions: "wf_lead_duplicate_resolutions",
      leadExportHistory: "wf_lead_export_history",
    };
    const stats = await store.stats();
    for (const collection of Object.keys(stats)) {
      assert.ok(counted[collection], `stats() collection "${collection}" has no mapped table`);
      assert.ok(tables.includes(counted[collection]), `${counted[collection]} (from "${collection}") is not counted`);
    }
  } finally {
    await store.close();
  }

  // A directory with no schema is refused rather than backed up as "zero rows".
  const empty = await mkdtemp(path.join(tmpdir(), "wf-no-migrations-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.throws(() => tablesFromMigrations(new URL(`${empty}/`, "file://")), /no tables found/);
});
