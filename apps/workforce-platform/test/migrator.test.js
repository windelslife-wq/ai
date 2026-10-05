import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, splitSqlStatements } from "../src/db/migrator.js";

class FakeMigrationPool {
  constructor() { this.ledger = new Map(); this.statements = []; }
  async execute(sql, values = []) {
    if (sql.startsWith("SELECT checksum")) {
      const checksum = this.ledger.get(values[0]);
      return [checksum ? [{ checksum }] : [], []];
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
