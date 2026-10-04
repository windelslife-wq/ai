import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
export function makePool(env = process.env) {
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  return mysql.createPool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    timezone: "Z",
    charset: "utf8mb4",
    dateStrings: true,
    decimalNumbers: false,
    waitForConnections: true,
    connectionLimit: 8,
    multipleStatements: false,
  });
}
export const utc = () =>
  new Date().toISOString().replace("T", " ").replace("Z", "");
export const sqlDate = (d) =>
  new Date(d).toISOString().replace("T", " ").replace("Z", "");
export const iso = (d) => (d ? String(d).replace(" ", "T") + "Z" : null);
export const hash = (v) => createHash("sha256").update(v).digest("hex");
export function passwordHash(password) {
  const salt = randomBytes(32).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, stored) {
  const [method, salt, digest] = String(stored).split("$");
  if (
    method !== "scrypt" ||
    !/^[0-9a-f]{64}$/.test(salt || "") ||
    !/^[0-9a-f]{128}$/.test(digest || "")
  )
    return false;
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(digest, "hex"),
  );
}
export async function migrate(pool) {
  const [rows] = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='fp_schema_migrations'",
  );
  if (!rows.length)
    await pool.query(
      "CREATE TABLE fp_schema_migrations (name VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB",
    );
  const migration = await readFile(
    fileURLToPath(
      new URL("../database/migrations/001_init.sql", import.meta.url),
    ),
    "utf8",
  );
  const checksum = hash(migration);
  const [done] = await pool.query(
    "SELECT checksum FROM fp_schema_migrations WHERE name=?",
    ["001_init"],
  );
  if (done.length) {
    if (done[0].checksum !== checksum)
      throw new Error("Migration checksum mismatch");
    return;
  }
  // DDL auto-commits on MySQL: retry idempotent CREATE IF NOT EXISTS after a failure; never mutate an applied migration.
  for (const statement of migration
    .split(";")
    .map((x) => x.replace(/^--[^\n]*\n/gm, "").trim())
    .filter(Boolean)) {
    const safe = statement.replace(
      /^CREATE TABLE (?!IF NOT EXISTS)/,
      "CREATE TABLE IF NOT EXISTS",
    );
    if (
      safe.startsWith("INSERT INTO fp_settings") ||
      safe.startsWith("INSERT INTO fp_model_versions")
    ) {
      const [existing] = await pool.query(
        `SELECT 1 FROM ${safe.includes("fp_settings") ? "fp_settings" : "fp_model_versions"} LIMIT 1`,
      );
      if (existing.length) continue;
    }
    await pool.query(safe);
  }
  await pool.query("INSERT INTO fp_schema_migrations VALUES(?,?,?)", [
    "001_init",
    checksum,
    utc(),
  ]);
}
export async function audit(db, actor, action, entity, id, detail = {}) {
  await db.execute(
    "INSERT INTO fp_audit(actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)",
    [actor, action, entity, String(id), JSON.stringify(detail), utc()],
  );
}
