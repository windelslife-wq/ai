import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function stripLeadingComments(statement) {
  return statement
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .trim();
}

export function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(stripLeadingComments)
    .filter(Boolean);
}

const LEDGER_TABLE = `CREATE TABLE IF NOT EXISTS wf_schema_migrations (
  migration_name VARCHAR(190) NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/** Migration files in apply order. Names are the ledger keys, so ordering is part of the contract. */
export async function listMigrationFiles(directory) {
  return (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name)).sort();
}

export async function runMigrations(pool, directory) {
  await pool.execute(LEDGER_TABLE);

  const files = await listMigrationFiles(directory);
  const applied = [];

  for (const file of files) {
    const migrationName = file.slice(0, -4);
    const sql = await readFile(join(directory, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const [existing] = await pool.execute(
      "SELECT migration_name, checksum, applied_at FROM wf_schema_migrations WHERE migration_name = ? LIMIT 1",
      [migrationName],
    );

    if (existing.length) {
      if (existing[0].checksum !== checksum) {
        throw new Error(`Migration checksum mismatch: ${migrationName}`);
      }
      continue;
    }

    for (const statement of splitSqlStatements(sql)) {
      await pool.query(statement);
    }
    await pool.execute(
      `INSERT INTO wf_schema_migrations (migration_name, checksum, applied_at)
       VALUES (?, ?, UTC_TIMESTAMP(3))`,
      [migrationName, checksum],
    );
    applied.push(migrationName);
  }

  return applied;
}

/**
 * Reads the ledger without writing to it, so an operator can answer "is this host
 * current?" before running anything. A file that exists on disk but not in the ledger
 * is `pending`; a file whose bytes changed after it was applied is `drifted` — that
 * host has schema the ledger cannot reproduce, and running the migration again would
 * fail anyway.
 */
export async function migrationStatus(pool, directory) {
  const files = await listMigrationFiles(directory);
  const rows = [];
  for (const file of files) {
    const name = file.slice(0, -4);
    const sql = await readFile(join(directory, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    let recorded = null;
    try {
      const [existing] = await pool.execute(
        "SELECT migration_name, checksum, applied_at FROM wf_schema_migrations WHERE migration_name = ? LIMIT 1",
        [name],
      );
      recorded = existing[0] ?? null;
    } catch (error) {
      if (error?.code !== "ER_NO_SUCH_TABLE" && error?.errno !== 1146) throw error;
    }
    rows.push({
      name,
      checksum,
      state: !recorded ? "pending" : recorded.checksum !== checksum ? "drifted" : "applied",
      appliedAt: recorded?.applied_at ?? null,
    });
  }
  return rows;
}
