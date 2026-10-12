import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrationFiles, migrationStatus, runMigrations, splitSqlStatements } from "../src/db/migrator.js";

class FakeMigrationPool {
  constructor() { this.ledger = new Map(); this.statements = []; }
  async execute(sql, values = []) {
    if (sql.startsWith("SELECT migration_name, checksum, applied_at")) {
      const entry = this.ledger.get(values[0]);
      return [entry ? [{ migration_name: values[0], checksum: entry, applied_at: "2026-10-08 00:00:00.000" }] : [], []];
    }
    if (sql.startsWith("INSERT INTO wf_schema_migrations")) {
      this.ledger.set(values[0], values[1]);
      return [{ affectedRows: 1 }, []];
    }
    return [[], []];
  }
  async query(sql) { this.statements.push(sql); return [{}, []]; }
}

test("SQL splitter removes full-line comments and keeps ordered statements", () => {
  assert.deepEqual(splitSqlStatements("-- heading\nCREATE TABLE sample (id INT);\n-- next\nINSERT INTO sample VALUES (1);\n"), [
    "CREATE TABLE sample (id INT)",
    "INSERT INTO sample VALUES (1)",
  ]);
});

test("migration runner records checksums and does not reapply an unchanged migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wf-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "001_first.sql"), "CREATE TABLE first_table (id INT);\n");
  const pool = new FakeMigrationPool();
  assert.deepEqual(await runMigrations(pool, directory), ["001_first"]);
  assert.equal(pool.statements.length, 1);
  assert.deepEqual(await runMigrations(pool, directory), []);
  assert.equal(pool.statements.length, 1);

  await writeFile(join(directory, "001_first.sql"), "CREATE TABLE changed_table (id INT);\n");
  await assert.rejects(runMigrations(pool, directory), /checksum mismatch/);
});

test("the production foundation migration is valid UTF-8 and contains only bounded SQL statements", async () => {
  const path = new URL("../src/db/migrations/001_platform_foundation.sql", import.meta.url);
  const sql = await readFile(path, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 11);
  assert.ok(statements.every((statement) => statement.length > 20));
  assert.match(sql, /wf_users/);
  assert.match(sql, /wf_sessions/);
  assert.match(sql, /wf_audit_events/);
});

test("identity parity migration creates its profile table idempotently", async () => {
  const path = new URL("../src/db/migrations/002_identity_import_fields.sql", import.meta.url);
  const sql = await readFile(path, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS wf_user_profiles/);
  assert.match(statements[0], /FOREIGN KEY \(user_id\) REFERENCES wf_users\(id\)/);
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS wf_data_imports/);
  assert.match(statements[1], /source_checksum CHAR\(64\)/);
});

test("Phase 7 migration is ordered, parseable and starts with simulation blocked", async () => {
  const migrationPath = new URL("../src/db/migrations/007_paper_trading.sql", import.meta.url);
  const sql = await readFile(migrationPath, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 10, "three additive column changes, six tables and the safe-state seed");
  const createPrefix = "CREATE TABLE IF NOT EXISTS ";
  assert.deepEqual(
    statements.filter((statement) => statement.startsWith(createPrefix))
      .map((statement) => statement.slice(createPrefix.length).split(" ")[0]),
    ["wf_trading_state", "wf_paper_accounts", "wf_paper_orders", "wf_paper_positions", "wf_paper_trades", "wf_paper_deployments"],
  );
  assert.ok(statements[0].includes("ALTER TABLE wf_strategies"));
  assert.ok(statements[0].includes("ADD COLUMN human_signoff LONGTEXT"));
  assert.ok(statements[2].includes("MODIFY COLUMN paper_position_id BIGINT UNSIGNED"));
  assert.ok(sql.includes("owner_user_id BIGINT UNSIGNED NOT NULL"));
  assert.ok(sql.includes("FOREIGN KEY (owner_user_id) REFERENCES wf_users(id)"));
  assert.ok(sql.includes("synthetic TINYINT(1) NOT NULL DEFAULT 0"));
  assert.ok(!sql.includes("CREATE TABLE IF NOT EXISTS wf_live_orders"));
  assert.ok(!sql.includes("CREATE TABLE IF NOT EXISTS wf_broker_orders"));

  const seed = statements.find((statement) => statement.startsWith("INSERT IGNORE INTO wf_trading_state"));
  assert.ok(seed, "a persisted singleton state is seeded");
  const stateLiteral = seed.split("\n").map((line) => line.trim()).find((line) => line.startsWith("'{"));
  assert.ok(stateLiteral, "the safe-state JSON literal is present");
  const state = JSON.parse(stateLiteral.slice(1, -2));
  assert.equal(state.tradingMode, "ANALYSIS_ONLY");
  assert.equal(state.killSwitch.active, true);
  assert.equal(state.allowSyntheticPaperData, false);
  assert.equal(state.riskLimits.requireStopLoss, true);
  assert.ok((await listMigrationFiles(new URL("../src/db/migrations/", import.meta.url))).includes("007_paper_trading.sql"));
});

test("Phase 8A migration creates only the paper-proposal record, with owner and paper-order integrity", async () => {
  const migrationPath = new URL("../src/db/migrations/008_execution_supervisor.sql", import.meta.url);
  const sql = await readFile(migrationPath, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS wf_execution_proposals/);
  assert.match(sql, /owner_user_id BIGINT UNSIGNED NOT NULL/);
  assert.match(sql, /account_id BIGINT UNSIGNED NOT NULL/);
  assert.match(sql, /FOREIGN KEY \(account_id\) REFERENCES wf_paper_accounts\(id\)/);
  assert.match(sql, /FOREIGN KEY \(paper_order_id\) REFERENCES wf_paper_orders\(id\)/);
  assert.match(sql, /intent_json LONGTEXT NOT NULL/);
  assert.match(sql, /decision_by_user_id BIGINT UNSIGNED NULL/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS wf_(?:live|broker)_/i);
  // The last migration in filename order, which is also the one a fresh host applies
  // last. Pinned so that adding a migration is a deliberate act that shows up in a
  // diff: an out-of-order or mis-numbered file would change the order migrations run
  // in, and a migration that runs before the table it references exists is a failure
  // only on a fresh install — exactly the install nobody tests.
  assert.equal((await listMigrationFiles(new URL("../src/db/migrations/", import.meta.url))).at(-1), "018_lottery_tickets.sql");
});

test("Phase 12 migration creates only the job-lock table, keyed by job name", async () => {
  const migrationPath = new URL("../src/db/migrations/010_job_locks.sql", import.meta.url);
  const sql = await readFile(migrationPath, "utf8");
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 1, "one table and nothing else — no seed row, because a lock that exists before any job runs would block the first run");
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS wf_job_locks/);

  // The primary key IS the mutual-exclusion guarantee: two concurrent acquirers both
  // attempt an INSERT and the loser gets a duplicate-key error. Without it the arbiter
  // would be a check-then-act race.
  assert.match(sql, /job_name VARCHAR\(64\) NOT NULL PRIMARY KEY/);
  assert.match(sql, /holder VARCHAR\(120\) NOT NULL/);
  // Canonical-UTC VARCHAR timestamps, as in 007/008/009, so `expires_at <= ?` is a
  // correct string comparison that no host time_zone setting can reorder.
  assert.match(sql, /acquired_at VARCHAR\(32\) NOT NULL/);
  assert.match(sql, /expires_at VARCHAR\(32\) NOT NULL/);
  assert.match(sql, /KEY ix_wf_job_locks_expiry \(expires_at\)/);
  assert.match(sql, /ENGINE=InnoDB/);

  // Additive only: a coordination lock must not touch a governance, order or broker
  // table, and must not introduce any live-execution surface.
  assert.doesNotMatch(sql, /ALTER TABLE/i);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS wf_(?:live|broker|trading|paper|execution)_/i);
  assert.doesNotMatch(sql, /INSERT INTO/i);
});

test("migration status reports pending, applied and drifted without writing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wf-migration-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "001_first.sql"), "CREATE TABLE first_table (id INT);\n");
  await writeFile(join(directory, "002_second.sql"), "CREATE TABLE second_table (id INT);\n");
  const pool = new FakeMigrationPool();

  const before = await migrationStatus(pool, directory);
  assert.deepEqual(before.map((row) => [row.name, row.state]), [["001_first", "pending"], ["002_second", "pending"]]);
  assert.equal(pool.ledger.size, 0, "status must not touch the ledger");

  await runMigrations(pool, directory);
  const after = await migrationStatus(pool, directory);
  assert.deepEqual(after.map((row) => row.state), ["applied", "applied"]);
  assert.equal(after[0].appliedAt, "2026-10-08 00:00:00.000");
  assert.match(after[0].checksum, /^[a-f0-9]{64}$/);

  await writeFile(join(directory, "002_second.sql"), "CREATE TABLE rewritten (id INT);\n");
  assert.deepEqual((await migrationStatus(pool, directory)).map((row) => row.state), ["applied", "drifted"], "an edited applied migration is a host with unreproducible schema, and status must say so");
  assert.deepEqual(await listMigrationFiles(directory), ["001_first.sql", "002_second.sql"]);
});
