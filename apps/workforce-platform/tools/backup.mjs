#!/usr/bin/env node
/**
 * Backup and restore for the workforce platform (audit finding F-02: a deployment
 * had no documented way to take its data with it).
 *
 * Two adapters, one on-disk layout, so an operator reasons about one thing:
 *
 *   <destination>/2026-10-09T02-11-08Z/
 *     manifest.json             every file, with size and sha256
 *     snapshot.json             logical state (file) or table counts + dump name (mysql)
 *     store/…                   the write-ahead log (file adapter)
 *     uploads/…                 avatar bytes, which live outside the store
 *     database-<stamp>.sql      (mysql adapter)
 *
 * MySQL dumps are produced with the host's `mysqldump`; the password travels in a
 * 0600 `--defaults-extra-file`, never in argv where `ps` could read it. If the
 * binary is missing the tool refuses and prints the command to run instead.
 *
 * Usage:
 *   node tools/backup.mjs create  [--destination DIR]
 *   node tools/backup.mjs verify  --backup DIR
 *   node tools/backup.mjs restore --backup DIR [--force]
 *
 * Restore is deliberately explicit: it overwrites live data.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";

const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const MYSQL_TABLES = Object.freeze([
  "wf_users", "wf_user_profiles", "wf_sessions", "wf_roles", "wf_permissions",
  "wf_role_permissions", "wf_user_roles", "wf_audit_events", "wf_user_files", "wf_schema_migrations",
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

async function* walk(directory, base = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield { absolute: full, relative: path.relative(base, full).split(path.sep).join("/") };
  }
}

/** Copies a tree and records every byte in the manifest as it goes. */
async function copyTree(source, target, manifest, { prefix }) {
  if (!source || !existsSync(source)) return 0;
  let copied = 0;
  for await (const { absolute, relative } of walk(source)) {
    const bytes = await readFile(absolute);
    const destination = path.join(target, prefix, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
    manifest.push({ path: `${prefix}/${relative}`, bytes: bytes.length, sha256: sha256(bytes) });
    copied += 1;
  }
  return copied;
}

/** Recomputes every hash in a manifest. A damaged backup must never restore. */
export async function verifyBackup({ backupDir }) {
  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
  const problems = [];
  for (const entry of manifest.files) {
    const candidate = path.join(backupDir, entry.path);
    const details = await stat(candidate).catch(() => null);
    if (!details?.isFile()) {
      problems.push(`${entry.path}: missing`);
      continue;
    }
    if (details.size !== entry.bytes) {
      problems.push(`${entry.path}: size ${details.size} does not match the recorded ${entry.bytes}`);
      continue;
    }
    if (sha256(await readFile(candidate)) !== entry.sha256) problems.push(`${entry.path}: content does not match the recorded sha256`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** `mysqldump` argument set: consistent snapshot, no GTID noise, no DEFINER surprises. */
export function buildMysqldumpArgs(database) {
  return [
    `--host=${database.host}`, `--port=${database.port ?? 3306}`, `--user=${database.user}`,
    `--default-character-set=utf8mb4`, "--single-transaction", "--quick", "--no-tablespaces",
    "--routines", "--triggers", "--events=FALSE", "--set-gtid-purged=OFF", database.name,
  ];
}

async function withDefaultsFile(directory, database, body) {
  const file = path.join(directory, `wf-backup-${process.pid}.cnf`);
  await writeFile(file, `[client]\npassword="${String(database.password ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`, { mode: 0o600 });
  try {
    return await body(file);
  } finally {
    await rm(file, { force: true });
  }
}

async function dumpDatabase({ database, dumpPath, tmpDir }) {
  await withDefaultsFile(tmpDir, database, async (defaultsFile) => {
    const child = spawn("mysqldump", [`--defaults-extra-file=${defaultsFile}`, ...buildMysqldumpArgs(database)], { stdio: ["ignore", "pipe", "inherit"] });
    const sink = createWriteStream(dumpPath, { mode: 0o600 });
    const piping = pipeline(child.stdout, sink);
    const failure = await new Promise((resolve) => {
      child.once("error", (error) => resolve(error));
      child.once("close", (code, signal) => resolve(code === 0 ? null : new Error(`mysqldump exited with ${signal ?? code}`)));
    });
    await piping;
    sink.end();
    if (failure?.code === "ENOENT") {
      throw new Error(`mysqldump was not found on PATH. Take the dump manually, then run "verify":\n  mysqldump --single-transaction --no-tablespaces -h ${database.host} -u ${database.user} -p ${database.name} > ${dumpPath}`);
    }
    if (failure) throw failure;
  });
}

/**
 * @returns {Promise<{ok: true, backupDir: string, adapter: string, files: number, snapshot: object}>}
 */
export async function createBackup({ config, destination, now = new Date(), tmpDir = path.join(config.storage.fileDir, ".tmp") }) {
  const backupDir = path.join(path.resolve(destination), stamp(now));
  await mkdir(backupDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const files = [];
  const { store, pool, adapter } = await createStoreFor({ config, logger: SILENT });
  try {
    const readiness = await store.readiness();
    if (!readiness.database) throw new Error(`The ${readiness.adapter} database is not reachable (${readiness.detail || "unknown"}); refusing to write an empty backup`);

    let snapshot;
    if (adapter === "file") {
      await store.compact();
      const storeFiles = await copyTree(config.storage.fileDir, backupDir, files, { prefix: "store" });
      const uploadFiles = await copyTree(config.uploads.dir, backupDir, files, { prefix: "uploads" });
      snapshot = { adapter, counts: await store.stats(), checksum: await store.checksum(), copied: { store: storeFiles, uploads: uploadFiles } };
    } else {
      const counts = {};
      for (const table of MYSQL_TABLES) {
        const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
        counts[table] = Number(row.total);
      }
      const dumpName = `database-${stamp(now)}.sql`;
      await dumpDatabase({ database: config.database, dumpPath: path.join(backupDir, dumpName), tmpDir });
      const bytes = await readFile(path.join(backupDir, dumpName));
      files.push({ path: dumpName, bytes: bytes.length, sha256: sha256(bytes) });
      snapshot = { adapter, counts, dump: dumpName, restoreHint: "restore --backup DIR prints the command; a schema replacement is never automatic" };
    }

    const snapshotPath = path.join(backupDir, "snapshot.json");
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    files.push({ path: "snapshot.json", bytes: (await readFile(snapshotPath)).length, sha256: sha256(await readFile(snapshotPath)) });
    await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({ createdAt: now.toISOString(), adapter, node: process.version, files }, null, 2)}\n`);

    const verified = await verifyBackup({ backupDir });
    if (!verified.ok) throw new Error(`The backup did not verify itself: ${verified.problems.join("; ")}`);
    return { ok: true, backupDir, adapter, files: files.length, snapshot };
  } finally {
    await store.close?.();
    await pool?.end?.();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Restores a verified backup into the file store, and refuses anything ambiguous:
 * a partially overwritten directory is worse than no restore at all. A MySQL
 * restore prints the command instead of replacing a live schema behind your back.
 */
export async function restoreBackup({ config, backupDir, force = false, storeDir = null }) {
  const verified = await verifyBackup({ backupDir });
  if (!verified.ok) throw new Error(`Refusing to restore an unverifiable backup: ${verified.problems.join("; ")}`);
  const { manifest } = verified;
  const snapshot = JSON.parse(await readFile(path.join(backupDir, "snapshot.json"), "utf8"));

  if (manifest.adapter === "mysql") {
    throw new Error(
      "A MySQL restore replaces the live schema, so this tool will not do it silently. Run:\n"
      + `  mysql --host=${config.database.host} --port=${config.database.port ?? 3306} --user=${config.database.user} -p ${config.database.name} < ${path.join(backupDir, snapshot.dump)}\n`
      + `Then compare the row counts in ${path.join(backupDir, "snapshot.json")} (${JSON.stringify(snapshot.counts)}) and restart the application so readiness re-checks the migrations.`,
    );
  }

  const target = storeDir || config.storage.fileDir;
  const existing = await readdir(target).catch(() => []);
  if (existing.length && !force) {
    throw new Error(`${target} already holds ${existing.length} file(s). Pass --force to replace them; a mixed restore is not supported`);
  }
  for (const entry of manifest.files.filter((file) => file.path.startsWith("store/"))) {
    const destination = path.join(target, entry.path.slice("store/".length));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(backupDir, entry.path), destination);
  }
  let uploadsRestored = 0;
  if (config.uploads?.dir) {
    for (const entry of manifest.files.filter((file) => file.path.startsWith("uploads/"))) {
      const destination = path.join(config.uploads.dir, entry.path.slice("uploads/".length));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(backupDir, entry.path), destination);
      uploadsRestored += 1;
    }
  }

  const reopened = await createStoreFor({ config, logger: SILENT });
  try {
    const checksum = await reopened.store.checksum?.();
    if (checksum && snapshot.checksum && checksum !== snapshot.checksum) {
      throw new Error(`Restored state does not match the backup checksum (${checksum.slice(0, 12)}… vs ${snapshot.checksum.slice(0, 12)}…)`);
    }
    return { ok: true, adapter: "file", restored: manifest.files.length, uploadsRestored, checksum };
  } finally {
    await reopened.store.close?.();
    await reopened.pool?.end?.();
  }
}

// ---------------------------------------------------------------- CLI

function parseFlags(entries) {
  const flags = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.startsWith("--")) continue;
    const [name, inline] = entry.slice(2).split("=");
    const next = entries[index + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return flags;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    const config = loadConfig();
    const destination = path.resolve(String(flags.get("destination") || path.join(path.dirname(config.storage.fileDir), "backups")));
    if (command === "create") {
      const result = await createBackup({ config, destination });
      console.log(`Backup written to ${result.backupDir} — ${result.files} file(s), ${result.adapter} adapter.`);
      console.log(`Re-check it any time: node tools/backup.mjs verify --backup ${result.backupDir}`);
    } else if (command === "verify") {
      const backupDir = String(flags.get("backup") || "");
      if (!backupDir) throw new Error("--backup DIR is required");
      const result = await verifyBackup({ backupDir });
      console.log(result.ok ? `Backup verifies: ${result.manifest.files.length} file(s), taken ${result.manifest.createdAt}.` : `Backup is damaged:\n  ${result.problems.join("\n  ")}`);
      process.exitCode = result.ok ? 0 : 1;
    } else if (command === "restore") {
      const backupDir = String(flags.get("backup") || "");
      if (!backupDir) throw new Error("--backup DIR is required");
      const result = await restoreBackup({ config, backupDir, force: Boolean(flags.get("force")) });
      console.log(`Restored ${result.restored} file(s) (${result.uploadsRestored} upload(s)); checksum ${String(result.checksum).slice(0, 16)}… matches the manifest.`);
      console.log("Restart the application before serving traffic.");
    } else {
      console.log("Usage: node tools/backup.mjs create|verify|restore [--destination DIR] [--backup DIR] [--force]");
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(`Backup ${command} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
