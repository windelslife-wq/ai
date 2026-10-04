import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(here, "../migrations");
const db = createDatabase();
try {
  const files = (await readdir(migrationDir)).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    process.stdout.write(`Applying ${file}... `);
    await db.query(await readFile(path.join(migrationDir, file), "utf8"));
    console.log("ok");
  }
} finally { await db.end(); }
