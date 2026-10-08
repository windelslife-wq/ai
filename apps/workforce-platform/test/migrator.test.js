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
