import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { createPool } from "./pool.js";
import { migrationStatus, runMigrations } from "./migrator.js";

const migrationDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const mode = process.argv.includes("--status") ? "status" : process.argv.includes("--dry-run") ? "dry-run" : "apply";
const database = createPool(loadDatabaseConfig(process.env));

try {
  const rows = mode === "apply" ? null : await migrationStatus(database, migrationDirectory);
  if (mode === "apply") {
    const applied = await runMigrations(database, migrationDirectory);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database schema is already current.");
  } else {
    const labels = { applied: "applied", pending: "PENDING", drifted: "DRIFTED" };
    for (const row of rows) console.log(`${labels[row.state].padEnd(8)} ${row.name}${row.appliedAt ? `  (${row.appliedAt})` : ""}`);
    const pending = rows.filter((row) => row.state === "pending").map((row) => row.name);
    const drifted = rows.filter((row) => row.state === "drifted").map((row) => row.name);
    if (mode === "dry-run" && pending.length) console.log(`Would apply: ${pending.join(", ")}`);
    if (mode === "dry-run" && !pending.length) console.log("Nothing to apply.");
    if (drifted.length) {
      console.error(`Drifted after apply: ${drifted.join(", ")} — the recorded checksum no longer matches the file. Do not apply: reconcile by hand. See docs/migration/DATA_DICTIONARY.md.`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`Migration ${mode} failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database.end();
}
