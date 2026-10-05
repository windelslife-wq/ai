import { fileURLToPath } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { createPool } from "./pool.js";
import { runMigrations } from "./migrator.js";

const migrationDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
const database = createPool(loadDatabaseConfig(process.env));

try {
  const applied = await runMigrations(database, migrationDirectory);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database schema is already current.");
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database.end();
}
