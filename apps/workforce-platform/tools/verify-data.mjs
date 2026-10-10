#!/usr/bin/env node
/**
 * Data-integrity verification (audit finding F-13: the Node side had no data-integrity
 * tooling, so a migrated host could serve traffic with a broken dataset indefinitely).
 *
 * Checks the invariants the schema cannot express on a shared cPanel host — the
 * legacy tables have no unique indexes on the normalized handles and no foreign keys —
 * plus the invariants the import could have broken silently: dangling role and
 * session links, an unusable digest, or an account that can never sign in.
 *
 * Usage:
 *   node tools/verify-data.mjs [--json] [--strict]
 *
 * With --json, stdout is exactly one JSON document (no progress lines).
 *
 * Exit: 0 no hard failure, 1 a hard failure (or any warning with --strict).
 * Warnings never fail a normal run: a stale session is not corruption.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");

const failures = [];
const warnings = [];
const notes = [];

function fail(check, detail) {
  failures.push({ check, detail });
  if (!asJson) console.log(`[FAIL] ${check} — ${detail}`);
}

function warn(check, detail) {
  warnings.push({ check, detail });
  if (!asJson) console.log(`[WARN] ${check} — ${detail}`);
}

function note(check, detail) {
  notes.push({ check, detail });
  if (!asJson) console.log(`[ OK ] ${check} — ${detail}`);
}

function checkUniqueness(label, rows, key) {
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    const value = String(row[key] ?? "").trim().toLowerCase();
    if (!value) continue;
    if (seen.has(value)) duplicates.push(`${value} (#${seen.get(value)}, #${row.id})`);
    else seen.set(value, row.id);
  }
  if (duplicates.length) fail(label, `${duplicates.length} collision(s): ${duplicates.slice(0, 5).join(", ")}`);
  else note(label, `${seen.size} distinct values`);
}

const config = loadConfig();
const { store, pool, adapter } = await createStoreFor({ config, logger: { warn: () => {}, info: () => {}, error: () => {} } });

try {
  const readiness = await store.readiness();
  if (!readiness.database) fail("database reachable", `adapter ${readiness.adapter} detail ${readiness.detail || "unknown"}`);
  if (!readiness.schema) fail("migrations applied", `adapter ${readiness.adapter} detail ${readiness.detail || "schema missing"}`);
  if (readiness.database && readiness.schema) note("readiness", `${readiness.adapter}: database and schema present`);
  if (readiness.detail === "roles-not-seeded") {
    fail("RBAC baseline seeded", "the store holds no roles, so nothing can be administered; run `npm run seed:platform` (or the legacy identity import) first");
  }
  if (readiness.adapter === "file" && store.capabilities?.recommendedForProduction === false) {
    warn("adapter is not production storage", "the file adapter is single-process with no transactions; migrate to MySQL before serving traffic");
  }

  if (adapter === "mysql") {
    const [[{ users }]] = await pool.query("SELECT COUNT(*) AS users FROM wf_users");
    const [[{ sessions }]] = await pool.query("SELECT COUNT(*) AS sessions FROM wf_sessions");
    const [[{ audit }]] = await pool.query("SELECT COUNT(*) AS audit FROM wf_audit_events");
    const [[{ strategies }]] = await pool.query("SELECT COUNT(*) AS strategies FROM wf_strategies");
    const [[{ backtests }]] = await pool.query("SELECT COUNT(*) AS backtests FROM wf_backtests");
    const [[{ journal }]] = await pool.query("SELECT COUNT(*) AS journal FROM wf_journal_entries");
    note("row counts", `${users} users, ${sessions} sessions, ${audit} audit events`);
    note("strategy lab row counts", `${strategies} strategies, ${backtests} backtests, ${journal} journal entries`);

    for (const [label, table, key] of [["username collisions", "wf_users", "username"], ["email collisions", "wf_users", "email"], ["legacy UID collisions", "wf_users", "legacy_uid"]]) {
      const [rows] = await pool.query(
        `SELECT LOWER(${key}) AS value, GROUP_CONCAT(id ORDER BY id) AS ids, COUNT(*) AS total\n` +
        `  FROM ${table} WHERE ${key} IS NOT NULL GROUP BY LOWER(${key}) HAVING total > 1`,
      );
      if (rows.length) fail(label, rows.map((row) => `${row.value} (#${String(row.ids).replaceAll(",", ", #")})`).slice(0, 5).join(", "));
      else note(label, "none");
    }

    const [dangling] = await pool.query("SELECT COUNT(*) AS total FROM wf_user_roles ur LEFT JOIN wf_roles r ON r.id = ur.role_id WHERE r.id IS NULL");
    if (dangling[0].total) fail("role assignments resolve", `${dangling[0].total} dangling wf_user_roles row(s)`);
    else note("role assignments resolve", "every grant names an existing role");

    const [orphanSessions] = await pool.query("SELECT COUNT(*) AS total FROM wf_sessions s LEFT JOIN wf_users u ON u.id = s.user_id WHERE u.id IS NULL");
    if (orphanSessions[0].total) fail("sessions belong to a user", `${orphanSessions[0].total} orphan session(s)`);
    else note("sessions belong to a user", "none orphaned");

    const [weak] = await pool.query("SELECT COUNT(*) AS total FROM wf_users WHERE password_hash NOT LIKE '$2%'");
    if (weak[0].total) fail("password digests are bcrypt", `${weak[0].total} row(s) hold a digest this platform cannot verify`);
    else note("password digests are bcrypt", "all rows verifiable");

    const [noHandle] = await pool.query("SELECT COUNT(*) AS total FROM wf_users WHERE username IS NULL OR TRIM(username) = ''");
    if (noHandle[0].total) fail("every account has a handle", `${noHandle[0].total} row(s) cannot sign in by username`);
    else note("every account has a handle", "none missing");

    const [stale] = await pool.query("SELECT COUNT(*) AS total FROM wf_sessions WHERE revoked_at IS NULL AND expires_at <= UTC_TIMESTAMP(3)");
    if (stale[0].total) warn("expired sessions are swept", `${stale[0].total} row(s) are past expiry but not revoked; they are refused at read time and can be pruned`);
    else note("expired sessions are swept", "none pending");

    const [disabled] = await pool.query("SELECT COUNT(*) AS total FROM wf_sessions s JOIN wf_users u ON u.id = s.user_id WHERE u.status <> 'active' AND s.revoked_at IS NULL");
    if (disabled[0].total) warn("disabled accounts have no live session", `${disabled[0].total} session(s) still active for a disabled account; sign-in is refused but the token was not revoked`);
    else note("disabled accounts have no live session", "none");

    // `wf_journal_entries.backtest_id` is deliberately NOT a foreign key (migration
    // 006 explains why: a legacy import writes the two tables in separate passes),
    // so this is the only thing that enforces it. A journal row citing a backtest
    // that does not exist is a trade whose provenance cannot be inspected, which is
    // exactly the evidence a lifecycle gate is supposed to rest on.
    const [orphanJournal] = await pool.query(
      "SELECT COUNT(*) AS total FROM wf_journal_entries j LEFT JOIN wf_backtests b ON b.id = j.backtest_id WHERE j.backtest_id IS NOT NULL AND b.id IS NULL",
    );
    if (orphanJournal[0].total) fail("journal rows cite an existing backtest", `${orphanJournal[0].total} orphan journal row(s)`);
    else note("journal rows cite an existing backtest", "none orphaned");

    // A backtest must name a strategy version that exists, or the VALIDATED gate can
    // be satisfied by evidence attached to nothing.
    const [orphanBacktests] = await pool.query(
      "SELECT COUNT(*) AS total FROM wf_backtests b LEFT JOIN wf_strategies s ON s.strategy_id = b.strategy_id AND s.version = b.strategy_version WHERE s.strategy_id IS NULL",
    );
    if (orphanBacktests[0].total) fail("backtests cite an existing strategy version", `${orphanBacktests[0].total} orphan backtest row(s)`);
    else note("backtests cite an existing strategy version", "none orphaned");
  } else {
    const snapshot = await store.snapshot();
    note("row counts", `${snapshot.users.length} users, ${snapshot.sessions.length} sessions, ${snapshot.audit.length} audit events, ${snapshot.roles.length} roles, ${snapshot.permissions.length} permissions`);
    checkUniqueness("username collisions", snapshot.users, "username");
    checkUniqueness("email collisions", snapshot.users, "email");
    checkUniqueness("legacy UID collisions", snapshot.users, "legacy_uid");

    const roleIds = new Set(snapshot.roles.map((role) => String(role.id)));
    const userIds = new Set(snapshot.users.map((user) => String(user.id)));
    const permissionIds = new Set(snapshot.permissions.map((permission) => String(permission.id)));
    const danglingRoles = snapshot.userRoles.filter((entry) => !roleIds.has(String(entry.roleId)) || !userIds.has(String(entry.userId)));
    if (danglingRoles.length) fail("role assignments resolve", `${danglingRoles.length} dangling user-role link(s)`);
    else note("role assignments resolve", "every grant names an existing role and user");
    const danglingPermissions = snapshot.rolePermissions.filter((entry) => !roleIds.has(String(entry.roleId)) || !permissionIds.has(String(entry.permissionId)));
    if (danglingPermissions.length) fail("permission grants resolve", `${danglingPermissions.length} dangling grant(s)`);
    else note("permission grants resolve", "every grant names an existing permission");
    const orphanSessions = snapshot.sessions.filter((session) => !userIds.has(String(session.userId)));
    if (orphanSessions.length) fail("sessions belong to a user", `${orphanSessions.length} orphan session(s)`);
    else note("sessions belong to a user", "none orphaned");
    const weak = snapshot.users.filter((user) => !String(user.password_hash || "").startsWith("$2"));
    if (weak.length) fail("password digests are bcrypt", `${weak.length} row(s) hold a digest this platform cannot verify`);
    else note("password digests are bcrypt", "all rows verifiable");
    const noHandle = snapshot.users.filter((user) => !String(user.username || "").trim());
    if (noHandle.length) fail("every account has a handle", `${noHandle.length} row(s) cannot sign in by username`);
    else note("every account has a handle", "none missing");
    const now = Date.now();
    const stale = snapshot.sessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() <= now);
    if (stale.length) warn("expired sessions are swept", `${stale.length} row(s) are past expiry but not revoked`);
    else note("expired sessions are swept", "none pending");
    // The same two invariants the MySQL branch checks, against the snapshot. Both
    // adapters must describe the same world, so neither gets a weaker check.
    const backtestIds = new Set(snapshot.backtests.map((row) => String(row.id)));
    const orphanJournal = snapshot.journalEntries.filter((entry) => entry.backtest_id && !backtestIds.has(String(entry.backtest_id)));
    if (orphanJournal.length) fail("journal rows cite an existing backtest", `${orphanJournal.length} orphan journal row(s)`);
    else note("journal rows cite an existing backtest", "none orphaned");

    const strategyKeys = new Set(snapshot.strategies.map((row) => `${String(row.strategy_id)}:${String(row.version)}`));
    const orphanBacktests = snapshot.backtests.filter(
      (row) => !strategyKeys.has(`${String(row.strategy_id)}:${String(row.strategy_version)}`),
    );
    if (orphanBacktests.length) fail("backtests cite an existing strategy version", `${orphanBacktests.length} orphan backtest row(s)`);
    else note("backtests cite an existing strategy version", "none orphaned");

    note("strategy lab row counts", `${snapshot.strategies.length} strategies, ${snapshot.backtests.length} backtests, ${snapshot.journalEntries.length} journal entries`);
    note("state checksum", await store.checksum());
  }
} finally {
  await store.close?.();
  await pool?.end?.();
}

const ok = failures.length === 0 && (!strict || warnings.length === 0);
// `--json` means stdout is a single machine-readable document: the human summary is
// suppressed rather than appended, so `verify-data --json | jq` and a cron job reading
// the exit code both work off the same run.
if (asJson) {
  console.log(JSON.stringify({
    ok,
    adapter,
    passed: notes.length,
    counts: { passed: notes.length, warnings: warnings.length, failures: failures.length },
    failures,
    warnings,
    notes,
  }, null, 2));
} else {
  console.log(`\n${notes.length} checks passed, ${warnings.length} warning(s), ${failures.length} failure(s) on the ${adapter} adapter`);
}
process.exitCode = failures.length || (strict && warnings.length) ? 1 : 0;
void ROOT;
