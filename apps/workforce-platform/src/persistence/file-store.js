/**
 * Durable file persistence adapter.
 *
 * This exists so the platform can be run, tested and demonstrated without a
 * database server (finding F-01) — NOT as a production substitute for
 * MySQL/MariaDB. Durability and recovery guarantees are explicit:
 *
 *  - every mutation is appended to a write-ahead log and, with `syncWrites`
 *    enabled (the default), fsynced before the call resolves, so a process
 *    crash or a power loss cannot silently drop an acknowledged write;
 *  - state is rebuilt by replaying the log at startup; a truncated final line
 *    (a torn write) is discarded with a warning instead of corrupting the store;
 *  - the log is compacted into a snapshot once it exceeds a threshold;
 *  - writes are serialized through a single queue, so one process is safe.
 *    There is no cross-process locking, no transactions and no referential
 *    integrity: a multi-worker or multi-host deployment MUST use the SQL adapter.
 */

import { open, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { assertIsoCutoff } from "./contract.js";
import { createHash } from "node:crypto";
import path from "node:path";

const ENTITIES = ["users", "profiles", "sessions", "roles", "permissions", "userRoles", "rolePermissions", "audit", "inquiries", "analysisRuns", "strategies", "backtests", "journalEntries", "tradingState", "paperAccounts", "paperOrders", "paperPositions", "paperTrades", "paperDeployments"];
const PAPER_TX_ENTITIES = Object.freeze(["tradingState", "paperAccounts", "paperOrders", "paperPositions", "paperTrades", "paperDeployments", "strategies", "journalEntries", "audit"]);
const COMPACTION_ENTRIES = 2_000;
/**
 * `wf_journal_entries` columns that are DECIMAL in MySQL.
 *
 * Kept in step with `JOURNAL_NUMERIC_COLUMNS` in `strategy-repository.js`. Both
 * adapters must hand callers the same JavaScript types, because the approval gate
 * sums `pnl` and compares `profitFactor` — a string from one adapter and a number
 * from the other would make the same evidence produce different verdicts.
 */
const JOURNAL_NUMERIC_COLUMNS = Object.freeze([
  "entry_price",
  "exit_price",
  "position_size",
  "stop_loss",
  "take_profit",
  "fees",
  "slippage",
  "pnl",
  "pnl_pct",
  "r_multiple",
  "ai_confidence",
  "risk_score",
]);
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

function keyOf(entity, record) {
  if (entity === "sessions") return record.tokenHash;
  if (entity === "userRoles") return `${record.userId}:${record.roleId}`;
  if (entity === "rolePermissions") return `${record.roleId}:${record.permissionId}`;
  // A strategy is identified by (id, version), not by id alone: the lifecycle gates
  // compare evidence against an exact version, so two versions of one strategy are
  // two rows, exactly as the MySQL primary key makes them.
  if (entity === "strategies") return `${record.strategy_id}:${record.version}`;
  if (entity === "tradingState") return String(record.key || "global");
  return String(record.id);
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Legacy `users` rows carry `password_hash`/`status`; the account service reads
 * and writes that same shape, so both adapters speak one contract.
 */
export async function createFileStore({ dir, logger = console, idFactory = () => null, syncWrites = true } = {}) {
  let sequence = 0;
  const tables = new Map(ENTITIES.map((entity) => [entity, new Map()]));
  let appendCount = 0;
  let queue = Promise.resolve();

  const logPath = path.join(dir, "windels-store.jsonl");
  /**
   * One append handle is kept open so an fsync is possible; it is closed whenever
   * the log file is replaced (compaction) and reopened on the next write.
   */
  let handle = null;
  async function appendHandle() {
    if (!handle) handle = await open(logPath, "a");
    return handle;
  }
  async function closeHandle() {
    if (!handle) return;
    const current = handle;
    handle = null;
    await current.close().catch(() => {});
  }

  function nextId(entity) {
    const provided = idFactory(entity);
    if (provided !== null && provided !== undefined) return provided;
    let candidate = 1;
    const table = tables.get(entity);
    while (table.has(String(candidate))) candidate += 1;
    return candidate;
  }

  function ensureUserUid() {
    const users = tables.get("users");
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const uid = String(Math.floor(Math.random() * 900_000) + 100_000);
      if (![...users.values()].some((user) => user.legacy_uid === uid)) return uid;
    }
    throw new Error("Unable to allocate a unique six-digit user ID");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function load() {
    await mkdir(dir, { recursive: true });
    let raw = "";
    try {
      raw = await readFile(logPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return;
    }
    const lines = raw.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        if (index === lines.length - 1) {
          logger.warn?.({ message: "Discarded a torn trailing entry in the file store log" });
          break;
        }
        throw new Error(`Corrupt file store log at line ${index + 1}`);
      }
      apply(entry, { persist: false });
    }
    appendCount = lines.filter((line) => line.trim() !== "").length;
  }

  function apply(entry, { persist = true }) {
    if (entry.op === "batch") {
      for (const change of entry.changes || []) {
        const table = tables.get(change.entity);
        if (!table) continue;
        if (change.op === "delete") table.delete(change.key);
        else table.set(change.key, change.value);
      }
      if (typeof entry.sequence === "number" && entry.sequence > sequence) sequence = entry.sequence;
      return;
    }
    if (entry.op === "snapshot") {
      for (const entity of ENTITIES) {
        const table = tables.get(entity);
        table.clear();
        for (const record of entry.value?.[entity] ?? []) table.set(keyOf(entity, record), record);
      }
      if (typeof entry.sequence === "number" && entry.sequence > sequence) sequence = entry.sequence;
      return;
    }
    const table = tables.get(entry.entity);
    if (!table) return;
    if (entry.op === "delete") table.delete(entry.key);
    else table.set(entry.key, entry.value);
    if (typeof entry.sequence === "number" && entry.sequence > sequence) sequence = entry.sequence;
    if (!persist) return;
  }

  async function persist(entry, { compactAfter = true } = {}) {
    sequence += 1;
    const record = { ...entry, sequence };
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const file = await appendHandle();
    // position=null with the "a" flag appends atomically for writes under PIPE_BUF.
    await file.write(line, 0, line.length, null);
    // Without this the record only reaches the operating-system cache, and the
    // durability promise in the header comment would be false.
    if (syncWrites) await file.sync();
    appendCount += 1;
    if (compactAfter && appendCount >= COMPACTION_ENTRIES) await compact();
  }

  /**
   * Rewrites the log as a single snapshot record. The in-memory tables are
   * rebuilt from the same payload so the on-disk and in-memory views can never
   * diverge after compaction.
   */
  async function compact() {
    const payload = Object.fromEntries(ENTITIES.map((entity) => [entity, [...tables.get(entity).values()]]));
    const snapshot = { op: "snapshot", entity: "*", key: "*", value: payload, at: nowIso(), sequence };
    const temporary = `${logPath}.compact`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`);
    apply(snapshot, { persist: false });
    // The open handle points at the old inode; drop it before the rename so the
    // next append writes to the compacted file.
    await closeHandle();
    await rename(temporary, logPath);
    appendCount = 1;
  }

  function enqueue(run) {
    queue = queue.then(run, run);
    return queue;
  }

  async function mutate(entity, op, record) {
    const key = keyOf(entity, record);
    const run = async () => {
      const table = tables.get(entity);
      const value = op === "delete" ? null : record;
      if (op === "upsert" && table.has(key) && record.replace === false) throw new Error("Already exists");
      apply({ entity, key, op, value: value ? sanitize(value) : undefined }, { persist: false });
      await persist({ entity, key, op, value: op === "delete" ? null : sanitize(record) });
    };
    return enqueue(run);
  }

  function sanitize(value) {
    const { replace, ...rest } = value;
    return rest;
  }

  /**
   * File-adapter equivalent of the paper repository transaction. All affected
   * rows are changed in a private working copy, appended as one WAL batch, then
   * exposed together. The queue is the single-process serialization boundary;
   * this adapter still does not claim multi-process safety.
   */
  async function withPaperTransaction(work) {
    if (typeof work !== "function") throw new TypeError("paper transaction requires a callback");
    const run = async () => {
      const working = new Map(PAPER_TX_ENTITIES.map((entity) => [
        entity,
        new Map([...tables.get(entity).entries()].map(([key, value]) => [key, structuredClone(value)])),
      ]));
      const txRows = (entity) => [...working.get(entity).values()];
      const txGet = (entity, key) => working.get(entity).get(String(key)) ?? null;
      const txPut = (entity, record) => {
        const value = structuredClone(sanitize(record));
        working.get(entity).set(keyOf(entity, value), value);
        return structuredClone(value);
      };
      const txId = (entity) => {
        let id = 1;
        while (working.get(entity).has(String(id))) id += 1;
        return id;
      };
      const accountOwned = (accountId, ownerUserId = null) => {
        const account = txGet("paperAccounts", accountId);
        return account && (ownerUserId === null || ownerUserId === undefined || String(account.owner_user_id) === String(ownerUserId))
          ? account
          : null;
      };
      const tx = {
        async loadTradingState() {
          const stored = txGet("tradingState", "global");
          return stored ? { ...structuredClone(stored.state), updatedByUserId: stored.updatedByUserId ?? null, updatedAt: stored.updatedAt ?? null } : null;
        },
        async saveTradingState(state, { updatedByUserId = null, updatedAt = nowIso() } = {}) {
          const { updatedByUserId: _oldActor, updatedAt: _oldAt, ...stateJson } = state;
          txPut("tradingState", { key: "global", state: stateJson, updatedByUserId, updatedAt });
          return { ...stateJson, updatedByUserId, updatedAt };
        },
        async createPaperAccount(record) {
          const id = txId("paperAccounts");
          return txPut("paperAccounts", { ...record, id, revision: Number(record.revision ?? 0) });
        },
        async savePaperAccount(record) {
          if (!record.id) return this.createPaperAccount(record);
          if (!accountOwned(record.id, record.owner_user_id)) return null;
          return txPut("paperAccounts", { ...txGet("paperAccounts", record.id), ...record, revision: Number(record.revision ?? 0) });
        },
        async findPaperAccount(id, ownerUserId = null) {
          const account = accountOwned(id, ownerUserId);
          return account ? structuredClone(account) : null;
        },
        async listPaperAccounts(ownerUserId = null, limit = 500) {
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5_000);
          return txRows("paperAccounts")
            .filter((account) => ownerUserId === null || ownerUserId === undefined || String(account.owner_user_id) === String(ownerUserId))
            .sort((a, b) => Number(a.id) - Number(b.id))
            .slice(0, bounded)
            .map((account) => structuredClone(account));
        },
        async markPaperAccountPeak(id, ownerUserId, equity) {
          const account = accountOwned(id, ownerUserId);
          if (!account) return null;
          if (Number(equity) > Number(account.peak_equity)) {
            return txPut("paperAccounts", { ...account, peak_equity: Number(equity), revision: Number(account.revision || 0) + 1 });
          }
          return structuredClone(account);
        },
        async savePaperOrder(record) {
          if (record.id) return txPut("paperOrders", record);
          return txPut("paperOrders", { ...record, id: txId("paperOrders") });
        },
        async findPaperOrder(id, accountId) {
          const row = txGet("paperOrders", id);
          return row && String(row.account_id) === String(accountId) ? structuredClone(row) : null;
        },
        async listPaperOrders({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
          if (!accountOwned(accountId, ownerUserId)) return [];
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2_000);
          return txRows("paperOrders")
            .filter((row) => String(row.account_id) === String(accountId) && (!status || row.status === status))
            .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded).map((row) => structuredClone(row));
        },
        async findOpenPaperOrder(accountId, symbol) {
          return txRows("paperOrders")
            .filter((row) => String(row.account_id) === String(accountId) && row.symbol === String(symbol) && row.status === "PENDING")
            .sort((a, b) => Number(b.id) - Number(a.id)).map((row) => structuredClone(row))[0] ?? null;
        },
        async listAllPendingPaperOrders(limit = 2_000) {
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 2_000, 1), 5_000);
          return txRows("paperOrders").filter((row) => row.status === "PENDING")
            .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
        },
        async savePaperPosition(record) {
          if (record.id) return txPut("paperPositions", record);
          return txPut("paperPositions", { ...record, id: txId("paperPositions") });
        },
        async findPaperPosition(accountId, positionId, ownerUserId = null) {
          if (!accountOwned(accountId, ownerUserId)) return null;
          const row = txGet("paperPositions", positionId);
          return row && String(row.account_id) === String(accountId) ? structuredClone(row) : null;
        },
        async findOpenPaperPosition(accountId, symbol) {
          return txRows("paperPositions")
            .filter((row) => String(row.account_id) === String(accountId) && row.symbol === String(symbol) && row.status === "OPEN")
            .sort((a, b) => Number(b.id) - Number(a.id)).map((row) => structuredClone(row))[0] ?? null;
        },
        async listPaperPositions({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
          if (!accountOwned(accountId, ownerUserId)) return [];
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2_000);
          return txRows("paperPositions")
            .filter((row) => String(row.account_id) === String(accountId) && (!status || row.status === status))
            .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded).map((row) => structuredClone(row));
        },
        async savePaperTrade(record) {
          if (record.id) throw new TypeError("paper trade legs are append-only");
          return txPut("paperTrades", { ...record, id: txId("paperTrades") });
        },
        async listPaperTrades({ accountId, ownerUserId = null, limit = 1_000 } = {}) {
          if (!accountOwned(accountId, ownerUserId)) return [];
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 1_000, 1), 5_000);
          return txRows("paperTrades")
            .filter((row) => String(row.account_id) === String(accountId))
            .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded)
            .map((row) => ({ ...structuredClone(row), net_pnl: row.leg === "EXIT" ? (txGet("paperPositions", row.position_id)?.realized_pnl ?? 0) : null }));
        },
        async savePaperDeployment(record) {
          if (record.id) return txPut("paperDeployments", record);
          return txPut("paperDeployments", { ...record, id: txId("paperDeployments") });
        },
        async findPaperDeployment(id, ownerUserId = null) {
          const row = txGet("paperDeployments", id);
          return row && accountOwned(row.account_id, ownerUserId) ? structuredClone(row) : null;
        },
        async listPaperDeployments({ accountId = null, ownerUserId = null, active = null, limit = 500 } = {}) {
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5_000);
          return txRows("paperDeployments")
            .filter((row) => (accountId === null || accountId === undefined || String(row.account_id) === String(accountId))
              && (active === null || active === undefined || Boolean(row.active) === Boolean(active))
              && Boolean(accountOwned(row.account_id, ownerUserId)))
            .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
        },
        async listAllActivePaperDeployments(limit = 2_000) {
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 2_000, 1), 5_000);
          return txRows("paperDeployments").filter((row) => Boolean(row.active))
            .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
        },
        async findStrategy(strategyId, version) {
          const row = txGet("strategies", `${String(strategyId)}:${String(version)}`);
          return row ? structuredClone(row) : null;
        },
        async saveStrategy(record) {
          const key = `${String(record.strategy_id)}:${String(record.version)}`;
          const existing = txGet("strategies", key);
          return txPut("strategies", {
            ...record,
            strategy_id: String(record.strategy_id),
            version: String(record.version),
            created_at: String(existing?.created_at ?? record.created_at),
            updated_at: String(record.updated_at),
          });
        },
        async saveJournalEntry(entry) {
          const id = String(entry.id);
          const row = { ...entry, id, synthetic: Boolean(entry.synthetic) };
          for (const column of JOURNAL_NUMERIC_COLUMNS) row[column] = entry[column] === null || entry[column] === undefined ? null : Number(entry[column]);
          return txPut("journalEntries", row);
        },
        async recordAudit({ actorId = null, action, entityType = null, entityId = null, details = {} }) {
          return txPut("audit", {
            id: txId("audit"),
            actor_user_id: actorId === null || actorId === undefined ? null : Number(actorId),
            action_key: action,
            entity_type: entityType,
            entity_id: entityId === null || entityId === undefined ? null : String(entityId),
            detail_json: details ?? {},
            created_at: nowIso(),
          });
        },
      };

      const result = await work(tx);
      const changes = [];
      for (const entity of PAPER_TX_ENTITIES) {
        const before = tables.get(entity);
        const after = working.get(entity);
        const keys = new Set([...before.keys(), ...after.keys()]);
        for (const key of keys) {
          const oldValue = before.get(key);
          const newValue = after.get(key);
          if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
          changes.push(newValue === undefined
            ? { entity, key, op: "delete", value: null }
            : { entity, key, op: "upsert", value: sanitize(structuredClone(newValue)) });
        }
      }
      if (changes.length) {
        await persist({ op: "batch", changes }, { compactAfter: false });
        apply({ op: "batch", changes, sequence }, { persist: false });
        if (appendCount >= COMPACTION_ENTRIES) await compact();
      }
      return result;
    };
    return enqueue(run);
  }

  await load();

  function userView(user) {
    if (!user) return null;
    const profile = tables.get("profiles").get(String(user.id));
    return {
      id: user.id,
      legacy_user_id: user.legacy_user_id ?? null,
      legacy_uid: user.legacy_uid ?? null,
      username: user.username,
      email: user.email ?? null,
      password_hash: user.password_hash,
      status: user.status ?? "active",
      created_at: user.created_at,
      updated_at: user.updated_at,
      displayName: profile?.display_name || user.username,
      profileImage: profile?.profile_image ?? null,
      last_login_at: profile?.last_login_at ?? null,
    };
  }

  function permissionsFor(userId) {
    const roleIds = [...tables.get("userRoles").values()].filter((entry) => String(entry.userId) === String(userId)).map((entry) => String(entry.roleId));
    const permissionIds = [...tables.get("rolePermissions").values()]
      .filter((entry) => roleIds.includes(String(entry.roleId)))
      .map((entry) => String(entry.permissionId));
    return [...new Set(permissionIds.map((id) => tables.get("permissions").get(id)?.permission_key).filter(Boolean))].sort();
  }

  function findUserBy(predicate) {
    for (const user of tables.get("users").values()) {
      if (predicate(user)) return user;
    }
    return null;
  }

  const store = {
    adapter: "file",
    capabilities: Object.freeze({
      adapter: "file",
      sql: false,
      durable: true,
      transactions: false,
      crossProcessSafety: false,
      recommendedForProduction: false,
    }),
    /**
     * For a schema-less store, "schema" means the log is loadable in the current
     * format — not that seed data exists. An unseeded install is therefore ready to
     * serve (registration self-heals roles) while still telling the operator which
     * step is missing, instead of looking permanently broken to a load balancer.
     */
    async readiness() {
      const dirStat = await stat(dir).catch(() => null);
      return {
        database: Boolean(dirStat?.isDirectory()),
        schema: true,
        adapter: "file",
        detail: tables.get("roles").size > 0 ? null : "roles-not-seeded",
      };
    },
    async health() {
      return { adapter: "file", entries: appendCount, users: tables.get("users").size, sessions: tables.get("sessions").size };
    },

    // ---- identity -------------------------------------------------------
    async findUserByIdentifier(identifier) {
      const needle = normalizeIdentifier(identifier);
      if (!needle) return null;
      const user = findUserBy((candidate) => [
        normalizeIdentifier(candidate.username),
        normalizeIdentifier(candidate.email),
        String(candidate.legacy_uid ?? ""),
      ].includes(needle));
      if (!user) return null;
      return { id: user.id, legacy_user_id: user.legacy_user_id ?? null, legacy_uid: user.legacy_uid ?? null, username: user.username, email: user.email ?? null, password_hash: user.password_hash, status: user.status ?? "active" };
    },
    async findUserById(id) {
      const user = tables.get("users").get(String(id));
      return user ? { id: user.id, legacy_user_id: user.legacy_user_id ?? null, legacy_uid: user.legacy_uid ?? null, username: user.username, email: user.email ?? null, password_hash: user.password_hash, status: user.status ?? "active" } : null;
    },
    async createUser({ username, email = null, passwordHash, displayName = null, status = "active", legacyUserId = null, legacyUid = null, avatarPath = null, createdAt = null }) {
      const normalizedUsername = normalizeIdentifier(username);
      if (!USERNAME_PATTERN.test(normalizedUsername)) throw new Error("Username is not valid");
      if (await store.findUserByIdentifier(normalizedUsername)) throw new Error("Username already exists");
      if (email && await store.findUserByIdentifier(email)) throw new Error("Email already exists");
      const id = nextId("users");
      const user = {
        id,
        legacy_user_id: legacyUserId,
        legacy_uid: legacyUid || ensureUserUid(),
        username: normalizedUsername,
        email: email ? normalizeIdentifier(email) : null,
        password_hash: passwordHash,
        status,
        created_at: createdAt || nowIso(),
        updated_at: nowIso(),
      };
      await mutate("users", "upsert", user);
      await mutate("profiles", "upsert", {
        id,
        display_name: displayName || normalizedUsername,
        profile_image: avatarPath,
        last_login_at: null,
      });
      return userView(user);
    },
    async updateUser(id, patch) {
      const user = tables.get("users").get(String(id));
      if (!user) throw new Error("User not found");
      const next = { ...user, updated_at: nowIso() };
      if (patch.username !== undefined) {
        const normalized = normalizeIdentifier(patch.username);
        if (!USERNAME_PATTERN.test(normalized)) throw new Error("Username is not valid");
        const clash = findUserBy((candidate) => String(candidate.id) !== String(id) && normalizeIdentifier(candidate.username) === normalized);
        if (clash) throw new Error("Username already exists");
        next.username = normalized;
      }
      if (patch.email !== undefined) {
        const normalizedEmail = patch.email === null ? null : normalizeIdentifier(patch.email);
        if (normalizedEmail) {
          const clash = findUserBy((candidate) => String(candidate.id) !== String(id) && normalizeIdentifier(candidate.email) === normalizedEmail);
          if (clash) throw new Error("Email already exists");
        }
        next.email = normalizedEmail;
      }
      if (patch.passwordHash !== undefined) next.password_hash = patch.passwordHash;
      if (patch.status !== undefined) next.status = patch.status;
      await mutate("users", "upsert", next);
      if (patch.displayName !== undefined || patch.profileImage !== undefined) {
        const profile = tables.get("profiles").get(String(id)) || { id: Number(id), display_name: next.username, profile_image: null, last_login_at: null };
        const nextProfile = { ...profile };
        if (patch.displayName !== undefined) nextProfile.display_name = patch.displayName;
        if (patch.profileImage !== undefined) nextProfile.profile_image = patch.profileImage;
        await mutate("profiles", "upsert", nextProfile);
      }
      if (patch.lastLoginAt !== undefined) {
        const profile = tables.get("profiles").get(String(id)) || { id: Number(id), display_name: next.username, profile_image: null, last_login_at: null };
        await mutate("profiles", "upsert", { ...profile, last_login_at: patch.lastLoginAt });
      }
      return userView(next);
    },
    async usernameTaken(username, excludeId = null) {
      const needle = normalizeIdentifier(username);
      if (!needle) return false;
      return findUserBy((candidate) => normalizeIdentifier(candidate.username) === needle && Number(candidate.id) !== Number(excludeId ?? -1)) !== null;
    },
    async emailTaken(email, excludeId = null) {
      const needle = normalizeIdentifier(email);
      if (!needle) return false;
      return findUserBy((candidate) => normalizeIdentifier(candidate.email) === needle && Number(candidate.id) !== Number(excludeId ?? -1)) !== null;
    },
    async rolesForUser(userId) {
      const roleIds = new Set([...tables.get("userRoles").values()].filter((entry) => String(entry.userId) === String(userId)).map((entry) => String(entry.roleId)));
      return [...tables.get("roles").values()].filter((role) => roleIds.has(String(role.id)));
    },
    async setUserStatus(id, active) {
      return store.updateUser(id, { status: active ? "active" : "disabled" });
    },
    async listUsers(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
      return [...tables.get("users").values()]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, boundedLimit)
        .map((user) => {
          const profile = tables.get("profiles").get(String(user.id));
          return {
            id: user.id,
            legacy_uid: user.legacy_uid ?? null,
            username: user.username,
            email: user.email ?? null,
            status: user.status ?? "active",
            created_at: user.created_at,
            display_name: profile?.display_name ?? null,
            profile_image: profile?.profile_image ?? null,
            last_login_at: profile?.last_login_at ?? null,
          };
        });
    },
    /**
     * Search, filter, sort and page the user directory. The row shape and the
     * bounds are identical to the SQL adapter's `pageUsers`, including the
     * projection: `password_hash` is deliberately absent, so an administrator
     * listing can never carry a digest out of the process.
     */
    async pageUsers({ limit = 25, offset = 0, search = null, status = null, sort = "id", direction = "asc" } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 25, 200));
      const boundedOffset = Math.max(0, Math.min(Number.parseInt(offset, 10) || 0, 1_000_000));
      let rows = [...tables.get("users").values()].map((user) => {
        const view = userView(user);
        return {
          id: view.id,
          legacyUid: view.legacy_uid ?? null,
          username: view.username,
          email: view.email ?? null,
          status: view.status,
          displayName: view.displayName,
          avatar: view.profileImage ? { url: view.profileImage } : null,
          createdAt: view.created_at,
          lastLoginAt: view.last_login_at ?? null,
          // Sort-only fields, removed from the projected rows below.
          __sort: { id: view.id, username: view.username, email: view.email ?? null, status: view.status, createdAt: view.created_at, lastLogin: view.last_login_at ?? null },
        };
      });
      if (status) rows = rows.filter((row) => row.status === status);
      if (search) {
        const needle = normalizeIdentifier(search);
        rows = rows.filter((row) => [row.username, row.email ?? "", String(row.legacyUid ?? "")].some((field) => normalizeIdentifier(field).includes(needle)));
      }
      const key = Object.hasOwn(rows[0]?.__sort ?? {}, sort) ? sort : "id";
      rows.sort((left, right) => {
        const a = left.__sort[key] ?? "";
        const b = right.__sort[key] ?? "";
        if (key === "id") return direction === "desc" ? b - a : a - b;
        return direction === "desc" ? String(b).localeCompare(String(a)) : String(a).localeCompare(String(b));
      });
      const total = rows.length;
      const users = rows.slice(boundedOffset, boundedOffset + boundedLimit).map(({ __sort, ...row }) => row);
      return { total, users };
    },
    async listRoles() {
      return [...tables.get("roles").values()].sort((a, b) => a.role_key.localeCompare(b.role_key));
    },
    async listPermissions() {
      return [...tables.get("permissions").values()].sort((a, b) => a.permission_key.localeCompare(b.permission_key));
    },
    async ensureRole(roleKey, displayName) {
      const existing = [...tables.get("roles").values()].find((role) => role.role_key === roleKey);
      if (existing) return existing;
      const role = { id: nextId("roles"), role_key: roleKey, display_name: displayName || roleKey, created_at: nowIso() };
      await mutate("roles", "upsert", role);
      return role;
    },
    async ensurePermission(permissionKey, displayName) {
      const existing = [...tables.get("permissions").values()].find((permission) => permission.permission_key === permissionKey);
      if (existing) return existing;
      const permission = { id: nextId("permissions"), permission_key: permissionKey, display_name: displayName || permissionKey, created_at: nowIso() };
      await mutate("permissions", "upsert", permission);
      return permission;
    },
    async grantRolePermission(roleId, permissionId) {
      await mutate("rolePermissions", "upsert", { roleId: Number(roleId), permissionId: Number(permissionId), created_at: nowIso() });
    },
    async assignRole(userId, roleId) {
      await mutate("userRoles", "upsert", { userId: Number(userId), roleId: Number(roleId), created_at: nowIso() });
    },
    async setRoles(userId, roleKeys) {
      for (const entry of [...tables.get("userRoles").values()]) {
        if (String(entry.userId) === String(userId)) await mutate("userRoles", "delete", { userId: entry.userId, roleId: entry.roleId });
      }
      for (const roleKey of roleKeys) {
        const role = [...tables.get("roles").values()].find((candidate) => candidate.role_key === roleKey);
        if (!role) throw new Error(`Unknown role: ${roleKey}`);
        await store.assignRole(userId, role.id);
      }
      return permissionsFor(userId);
    },
    async permissionsForUser(userId) {
      return permissionsFor(userId);
    },
    async updatePasswordHash(id, passwordHash) {
      return store.updateUser(id, { passwordHash });
    },

    // ---- sessions -------------------------------------------------------
    async createSession({ tokenHash, userId, expiresAt, deviceLabel = null, createdAt = null }) {
      await mutate("sessions", "upsert", {
        tokenHash,
        userId: Number(userId),
        expiresAt: new Date(expiresAt).toISOString(),
        createdAt: createdAt || nowIso(),
        revokedAt: null,
        deviceLabel,
      });
    },
    async findSession(tokenHash) {
      const session = tables.get("sessions").get(tokenHash);
      if (!session || session.revokedAt) return null;
      if (new Date(session.expiresAt) <= new Date()) return null;
      const user = tables.get("users").get(String(session.userId));
      if (!user || (user.status ?? "active") !== "active") return null;
      return {
        user: userView(user),
        permissions: permissionsFor(user.id),
      };
    },
    async revokeSession(tokenHash) {
      const session = tables.get("sessions").get(tokenHash);
      if (!session) return;
      await mutate("sessions", "upsert", { ...session, revokedAt: nowIso() });
    },
    async updateSessionExpiry(tokenHash, expiresAt, deviceLabel = null) {
      const session = tables.get("sessions").get(tokenHash);
      if (!session) return null;
      await mutate("sessions", "upsert", {
        ...session,
        expiresAt: new Date(expiresAt).toISOString(),
        deviceLabel: deviceLabel ?? session.deviceLabel ?? null,
      });
      return { expiresAt: new Date(expiresAt).toISOString(), deviceLabel: deviceLabel ?? session.deviceLabel ?? null };
    },
    async listSessions(userId) {
      const now = Date.now();
      return [...tables.get("sessions").values()]
        .filter((session) => String(session.userId) === String(userId) && !session.revokedAt && new Date(session.expiresAt).getTime() > now)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((session) => ({
          id: session.tokenHash.slice(0, 12),
          current: false,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          deviceLabel: session.deviceLabel ?? null,
        }));
    },
    async revokeAllSessions(userId, exceptTokenHash = null) {
      let revoked = 0;
      for (const session of [...tables.get("sessions").values()]) {
        if (String(session.userId) !== String(userId) || session.revokedAt) continue;
        if (exceptTokenHash && session.tokenHash === exceptTokenHash) continue;
        await mutate("sessions", "upsert", { ...session, revokedAt: nowIso() });
        revoked += 1;
      }
      return revoked;
    },

    // ---- audit ----------------------------------------------------------
    async recordAudit({ actorId = null, action, entityType = null, entityId = null, details = {} }) {
      const id = nextId("audit");
      await mutate("audit", "upsert", {
        id,
        actor_user_id: actorId === null || actorId === undefined ? null : Number(actorId),
        action_key: action,
        entity_type: entityType,
        entity_id: entityId === null || entityId === undefined ? null : String(entityId),
        detail_json: details ?? {},
        created_at: nowIso(),
      });
    },
    async listAuditEvents({ userId = null, limit = 50, offset = 0, action = null } = {}) {
      let rows = [...tables.get("audit").values()];
      if (userId !== null) rows = rows.filter((row) => String(row.actor_user_id) === String(userId));
      if (action) rows = rows.filter((row) => row.action_key === action || row.action_key.startsWith(`${action}.`));
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const total = rows.length;
      return {
        total,
        events: rows.slice(offset, offset + limit).map((row) => ({
          id: row.id,
          action: row.action_key,
          entityType: row.entity_type,
          entityId: row.entity_id,
          details: row.detail_json,
          createdAt: row.created_at,
        })),
      };
    },

    // ---- public site: contact intake ------------------------------------
    /**
     * Appends one inquiry. The reference is supplied by the caller (the site
     * service mints it) so both adapters store the same identifier shape, and a
     * duplicate reference is refused rather than overwriting a visitor's message.
     */
    async recordContactInquiry({ reference, name, email, message, clientFingerprint, userAgent = null, requestId = null, createdAt = null }) {
      if ([...tables.get("inquiries").values()].some((row) => row.reference === reference)) {
        // References are random 26-character ULIDs, so this is a clock/entropy
        // fault rather than a user error; refuse the write instead of overwriting
        // a message that is already on the audit trail.
        throw new Error(`Duplicate inquiry reference: ${reference}`);
      }
      const id = nextId("inquiries");
      const at = createdAt ? new Date(createdAt).toISOString() : nowIso();
      await mutate("inquiries", "upsert", {
        id,
        reference,
        name,
        email,
        message,
        client_fingerprint: clientFingerprint,
        user_agent: userAgent,
        request_id: requestId,
        status: "new",
        handled_by: null,
        handled_at: null,
        created_at: at,
      });
      return { id, reference, createdAt: at };
    },
    async pageContactInquiries({ limit = 25, offset = 0, search = null, status = null, sort = "createdAt", direction = "desc" } = {}) {
      const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 200);
      const boundedOffset = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), 1_000_000);
      let rows = [...tables.get("inquiries").values()];
      if (search) {
        const term = String(search).toLowerCase();
        rows = rows.filter((row) => row.name.toLowerCase().includes(term) || row.email.toLowerCase().includes(term) || row.reference.toLowerCase().includes(term));
      }
      if (status) rows = rows.filter((row) => row.status === status);
      const column = { id: "id", createdAt: "created_at", name: "name", email: "email", status: "status" }[sort] || "created_at";
      const factor = String(direction).toLowerCase() === "asc" ? 1 : -1;
      rows.sort((a, b) => (String(a[column]).localeCompare(String(b[column])) || a.id - b.id) * factor);
      return {
        total: rows.length,
        inquiries: rows.slice(boundedOffset, boundedOffset + boundedLimit).map((row) => ({
          id: row.id,
          reference: row.reference,
          name: row.name,
          email: row.email,
          message: row.message,
          status: row.status,
          clientFingerprint: row.client_fingerprint,
          userAgent: row.user_agent ?? null,
          requestId: row.request_id ?? null,
          handledBy: row.handled_by ?? null,
          handledAt: row.handled_at ?? null,
          createdAt: row.created_at,
        })),
      };
    },

    // ---- analysis runs (Phase 5) ----------------------------------------
    // Keyed by the run's own UUID, so `nextId` is not involved: the engine mints
    // the identifier and the store only has to be able to find it again.
    async saveAnalysisRun({ id, symbol, timeframe, bias, confidence, regime, recommendation, synthetic, source, completedAt, payload }) {
      await mutate("analysisRuns", "upsert", {
        id: String(id),
        symbol,
        timeframe,
        bias,
        confidence: Number(confidence),
        regime,
        recommendation,
        synthetic: Boolean(synthetic),
        source,
        completed_at: completedAt,
        payload: payload ?? null,
      });
      return { id: String(id), completedAt };
    },

    async listAnalysisRuns({ limit = 20 } = {}) {
      const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const rows = [...tables.get("analysisRuns").values()];
      // ISO-8601 UTC strings sort chronologically as text; the id is the tie-break
      // so two runs completed in the same millisecond keep a stable order.
      rows.sort((a, b) => (String(b.completed_at).localeCompare(String(a.completed_at)) || String(a.id).localeCompare(String(b.id))));
      return rows.slice(0, boundedLimit).map((row) => ({
        id: row.id,
        symbol: row.symbol,
        timeframe: row.timeframe,
        bias: row.bias,
        confidence: Number(row.confidence),
        regime: row.regime,
        recommendation: row.recommendation,
        synthetic: Boolean(row.synthetic),
        source: row.source,
        completedAt: row.completed_at,
      }));
    },

    async findAnalysisRun(id) {
      return tables.get("analysisRuns").get(String(id))?.payload ?? null;
    },

    /**
     * Retention (risk R-27), mirroring the MySQL adapter's contract and report shape.
     *
     * Each row is removed with the log's existing `delete` op rather than a new
     * "prune" op: the write-ahead log is replayed on every boot and rewritten by
     * `compact()`, so a new op would have to be understood by both, and an older log
     * would become unreadable. Row-by-row deletes need no format change and replay
     * exactly. The cost is one log entry per row, which is acceptable on the adapter
     * that exists for development and preview — production runs MySQL, where the same
     * call is a bounded batch delete.
     *
     * Rows are visited oldest-first with the same tie-break `listAnalysisRuns` uses,
     * so the deletion order never depends on map iteration.
     */
    async pruneAnalysisRuns(beforeIso, { dryRun = false } = {}) {
      const cutoff = assertIsoCutoff(beforeIso);
      const doomed = [...tables.get("analysisRuns").values()]
        .filter((row) => String(row.completed_at) < cutoff)
        .sort((a, b) => (String(a.completed_at).localeCompare(String(b.completed_at)) || String(a.id).localeCompare(String(b.id))));
      const report = {
        matching: doomed.length,
        deleted: 0,
        payloadBytes: doomed.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.payload ?? null), "utf8"), 0),
        oldest: doomed.length ? String(doomed[0].completed_at) : null,
        newest: doomed.length ? String(doomed[doomed.length - 1].completed_at) : null,
        cutoff,
        batches: 0,
        exhausted: true,
        dryRun: Boolean(dryRun),
      };
      if (dryRun || doomed.length === 0) return report;
      for (const row of doomed) await mutate("analysisRuns", "delete", { id: row.id });
      report.deleted = doomed.length;
      report.batches = 1;
      return report;
    },

    // ---- strategy lab (Phase 6) -----------------------------------------
    // Strategies are keyed by (strategy_id, version); backtests and journal
    // entries by their own id, which the engine mints. The shapes below match
    // `strategy-repository.js` field for field, including which columns are
    // denormalised, so the two adapters answer the same query the same way.
    async saveStrategy(record) {
      const strategyId = String(record.strategy_id);
      const version = String(record.version);
      const existing = tables.get("strategies").get(`${strategyId}:${version}`);
      await mutate("strategies", "upsert", {
        ...record,
        strategy_id: strategyId,
        version,
        // `created_at` records when this version first existed. The MySQL adapter
        // preserves it by omitting the column from its UPDATE list; here the whole
        // row is replaced, so it has to be carried over explicitly or a strategy
        // would look newly registered after every stage change.
        created_at: String(existing?.created_at ?? record.created_at),
        updated_at: String(record.updated_at),
      });
      return { strategy_id: strategyId, version };
    },

    async recordStrategyHumanSignoff(strategyId, version, signoff, updatedAt) {
      const run = async () => {
        const key = `${String(strategyId)}:${String(version)}`;
        const existing = tables.get("strategies").get(key);
        if (!existing || existing.source !== "ai" || existing.lifecycle !== "VALIDATED" || existing.human_signoff) return false;
        const updated = { ...existing, human_signoff: structuredClone(signoff), updated_at: String(updatedAt) };
        await persist({ entity: "strategies", key, op: "upsert", value: sanitize(updated) }, { compactAfter: false });
        apply({ entity: "strategies", key, op: "upsert", value: sanitize(updated), sequence }, { persist: false });
        if (appendCount >= COMPACTION_ENTRIES) await compact();
        return true;
      };
      return enqueue(run);
    },

    async findStrategy(strategyId, version) {
      const row = tables.get("strategies").get(`${String(strategyId)}:${String(version)}`);
      return row ? structuredClone(row) : null;
    },

    /**
     * Ordered `strategy_id ASC, updated_at ASC`, the legacy `all()` ordering.
     *
     * It is load-bearing rather than cosmetic: the strategy index groups rows by
     * id and expects them contiguous, and "latest version" takes the last row of
     * a group, so within one strategy the most recently updated version must come
     * last. ISO-8601 UTC strings sort chronologically as text, which is why
     * migration 006 pins one timestamp format.
     */
    async listStrategies() {
      return [...tables.get("strategies").values()]
        .sort((a, b) => (
          String(a.strategy_id).localeCompare(String(b.strategy_id))
          || String(a.updated_at).localeCompare(String(b.updated_at))
        ))
        .map((row) => structuredClone(row));
    },

    async saveBacktest(record) {
      const id = String(record.id);
      await mutate("backtests", "upsert", {
        id,
        created_at: String(record.created_at),
        // Denormalised out of the payload so a listing and the two gate queries can
        // be answered without opening every stored run.
        strategy_id: String(record.request?.strategyId ?? ""),
        strategy_version: String(record.request?.strategyVersion ?? ""),
        symbol: String(record.request?.symbol ?? ""),
        timeframe: String(record.request?.timeframe ?? ""),
        synthetic: Boolean(record.dataProvenance?.synthetic),
        // The headline parts of a run, promoted out of the payload so a listing can
        // show them for every row without reading thirty full runs. `trades` and
        // `equityCurve` stay inside `payload` and are only read by findBacktest.
        candles: Number(record.dataProvenance?.candles ?? 0),
        metrics: record.metrics ?? {},
        warnings: record.warnings ?? [],
        payload: record,
      });
      return { id, created_at: String(record.created_at) };
    },

    async findBacktest(id) {
      // A stored run that cannot be read back is a corrupt row, not a missing one;
      // the payload is whatever `saveBacktest` was handed, so there is nothing to
      // parse and nothing that can fail here.
      return structuredClone(tables.get("backtests").get(String(id))?.payload ?? null);
    },

    async listBacktests({ strategyId = null, limit = 20 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const wanted = strategyId === null || strategyId === undefined ? "" : String(strategyId);
      return [...tables.get("backtests").values()]
        .filter((row) => !wanted || row.strategy_id === wanted)
        // Newest first, id as the tie-break so two runs saved in the same
        // millisecond keep a stable order across calls.
        .sort((a, b) => (String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id))))
        .slice(0, bounded)
        // Dropping `payload` is the whole point: the summary keeps the denormalised
        // columns (including metrics/warnings/candles) and leaves the large arrays
        // for the detail route.
        .map(({ payload, ...summary }) => structuredClone(summary));
    },

    async countStrategyBacktests(strategyId, version) {
      const id = String(strategyId);
      const ver = String(version);
      return [...tables.get("backtests").values()]
        .filter((row) => row.strategy_id === id && row.strategy_version === ver)
        .length;
    },

    async latestStrategyBacktest(strategyId, version) {
      const id = String(strategyId);
      const ver = String(version);
      const rows = [...tables.get("backtests").values()]
        .filter((row) => row.strategy_id === id && row.strategy_version === ver)
        .sort((a, b) => (String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id))));
      return rows.length ? structuredClone(rows[0].payload) : null;
    },

    async saveJournalEntry(entry) {
      const id = String(entry.id);
      const row = { ...entry, id, synthetic: Boolean(entry.synthetic) };
      // The money and ratio columns are numbers on the way in and numbers on the
      // way out. MySQL returns them as strings (decimalNumbers: false) and
      // `strategy-repository.js` converts them at its boundary; this adapter has no
      // such boundary, so it coerces on write to keep the two indistinguishable.
      for (const column of JOURNAL_NUMERIC_COLUMNS) {
        row[column] = entry[column] === null || entry[column] === undefined ? null : Number(entry[column]);
      }
      await mutate("journalEntries", "upsert", row);
      return { id };
    },

    async listJournalEntries({ source = null, strategy = null, symbol = null, limit = 200 } = {}) {
      // 2000 matches the MySQL adapter and the legacy calibration query; see the
      // note in `strategy-repository.js`.
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2_000);
      return [...tables.get("journalEntries").values()]
        .filter((row) => {
          if (source && row.source !== String(source)) return false;
          if (strategy && row.strategy !== String(strategy)) return false;
          if (symbol && row.symbol !== String(symbol)) return false;
          return true;
        })
        .sort((a, b) => (String(b.execution_time).localeCompare(String(a.execution_time)) || String(a.id).localeCompare(String(b.id))))
        .slice(0, bounded)
        .map((row) => structuredClone(row));
    },

    // ---- paper trading + persisted governance (Phase 7) -----------------
    async withPaperTransaction(work) {
      return withPaperTransaction(work);
    },
    async loadTradingState() {
      const stored = tables.get("tradingState").get("global");
      return stored ? { ...structuredClone(stored.state), updatedByUserId: stored.updatedByUserId ?? null, updatedAt: stored.updatedAt ?? null } : null;
    },
    async saveTradingState(state, options = {}) {
      return withPaperTransaction((tx) => tx.saveTradingState(state, options));
    },
    async createPaperAccount(record) {
      return withPaperTransaction((tx) => tx.createPaperAccount(record));
    },
    async savePaperAccount(record) {
      return withPaperTransaction((tx) => tx.savePaperAccount(record));
    },
    async findPaperAccount(id, ownerUserId = null) {
      const row = tables.get("paperAccounts").get(String(id));
      if (!row || (ownerUserId !== null && ownerUserId !== undefined && String(row.owner_user_id) !== String(ownerUserId))) return null;
      return structuredClone(row);
    },
    async listPaperAccounts(ownerUserId = null, limit = 500) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5_000);
      return [...tables.get("paperAccounts").values()]
        .filter((row) => ownerUserId === null || ownerUserId === undefined || String(row.owner_user_id) === String(ownerUserId))
        .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
    },
    async markPaperAccountPeak(id, ownerUserId, equity) {
      return withPaperTransaction((tx) => tx.markPaperAccountPeak(id, ownerUserId, equity));
    },
    async savePaperOrder(record) {
      return withPaperTransaction((tx) => tx.savePaperOrder(record));
    },
    async findPaperOrder(id, accountId) {
      const row = tables.get("paperOrders").get(String(id));
      return row && String(row.account_id) === String(accountId) ? structuredClone(row) : null;
    },
    async listPaperOrders({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
      const account = await store.findPaperAccount(accountId, ownerUserId);
      if (!account) return [];
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2_000);
      return [...tables.get("paperOrders").values()]
        .filter((row) => String(row.account_id) === String(accountId) && (!status || row.status === status))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded).map((row) => structuredClone(row));
    },
    async findOpenPaperOrder(accountId, symbol) {
      const rows = [...tables.get("paperOrders").values()]
        .filter((row) => String(row.account_id) === String(accountId) && row.symbol === String(symbol) && row.status === "PENDING")
        .sort((a, b) => Number(b.id) - Number(a.id));
      return rows.length ? structuredClone(rows[0]) : null;
    },
    async listAllPendingPaperOrders(limit = 2_000) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 2_000, 1), 5_000);
      return [...tables.get("paperOrders").values()].filter((row) => row.status === "PENDING")
        .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
    },
    async savePaperPosition(record) {
      return withPaperTransaction((tx) => tx.savePaperPosition(record));
    },
    async findPaperPosition(accountId, positionId, ownerUserId = null) {
      const account = await store.findPaperAccount(accountId, ownerUserId);
      const row = tables.get("paperPositions").get(String(positionId));
      return account && row && String(row.account_id) === String(accountId) ? structuredClone(row) : null;
    },
    async findOpenPaperPosition(accountId, symbol) {
      const rows = [...tables.get("paperPositions").values()]
        .filter((row) => String(row.account_id) === String(accountId) && row.symbol === String(symbol) && row.status === "OPEN")
        .sort((a, b) => Number(b.id) - Number(a.id));
      return rows.length ? structuredClone(rows[0]) : null;
    },
    async listPaperPositions({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
      const account = await store.findPaperAccount(accountId, ownerUserId);
      if (!account) return [];
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 2_000);
      return [...tables.get("paperPositions").values()]
        .filter((row) => String(row.account_id) === String(accountId) && (!status || row.status === status))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded).map((row) => structuredClone(row));
    },
    async savePaperTrade(record) {
      return withPaperTransaction((tx) => tx.savePaperTrade(record));
    },
    async listPaperTrades({ accountId, ownerUserId = null, limit = 1_000 } = {}) {
      const account = await store.findPaperAccount(accountId, ownerUserId);
      if (!account) return [];
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 1_000, 1), 5_000);
      return [...tables.get("paperTrades").values()]
        .filter((row) => String(row.account_id) === String(accountId))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, bounded)
        .map((row) => ({ ...structuredClone(row), net_pnl: row.leg === "EXIT" ? (tables.get("paperPositions").get(String(row.position_id))?.realized_pnl ?? 0) : null }));
    },
    async savePaperDeployment(record) {
      return withPaperTransaction((tx) => tx.savePaperDeployment(record));
    },
    async findPaperDeployment(id, ownerUserId = null) {
      const row = tables.get("paperDeployments").get(String(id));
      const account = row ? await store.findPaperAccount(row.account_id, ownerUserId) : null;
      return row && account ? structuredClone(row) : null;
    },
    async listPaperDeployments({ accountId = null, ownerUserId = null, active = null, limit = 500 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5_000);
      const ownerAccounts = ownerUserId === null || ownerUserId === undefined
        ? null
        : new Set((await store.listPaperAccounts(ownerUserId, 5_000)).map((account) => String(account.id)));
      return [...tables.get("paperDeployments").values()]
        .filter((row) => (accountId === null || accountId === undefined || String(row.account_id) === String(accountId))
          && (active === null || active === undefined || Boolean(row.active) === Boolean(active))
          && (!ownerAccounts || ownerAccounts.has(String(row.account_id))))
        .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
    },
    async listAllActivePaperDeployments(limit = 2_000) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 2_000, 1), 5_000);
      return [...tables.get("paperDeployments").values()].filter((row) => Boolean(row.active))
        .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, bounded).map((row) => structuredClone(row));
    },

    // ---- profile files --------------------------------------------------
    async setAvatarPath(userId, avatarPath) {
      const profile = tables.get("profiles").get(String(userId)) || { id: Number(userId), display_name: null, profile_image: null, last_login_at: null };
      await mutate("profiles", "upsert", { ...profile, profile_image: avatarPath });
    },
    async findAvatarPath(userId) {
      return tables.get("profiles").get(String(userId))?.profile_image ?? null;
    },

    // ---- maintenance ----------------------------------------------------
    async checksum() {
      const hash = createHash("sha256");
      for (const entity of ENTITIES) {
        const rows = [...tables.get(entity).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        hash.update(`${entity}:${JSON.stringify(rows)}\n`);
      }
      return hash.digest("hex");
    },
    async snapshot() {
      return Object.fromEntries([...tables.entries()].map(([entity, table]) => [entity, [...table.values()]]));
    },
    async compact() {
      await compact();
    },
    /** Flushes and releases the log handle. Safe to call more than once. */
    async close() {
      if (handle) await handle.sync().catch(() => {});
      await closeHandle();
    },
    async flush() {
      if (handle) await handle.sync();
    },
    async stats() {
      return Object.fromEntries([...tables.entries()].map(([entity, table]) => [entity, table.size]));
    },
  };

  return store;
}

/** Directory layout is fixed so tooling (backup/restore) can find it. */
export function fileStorePaths(dir) {
  return Object.freeze({ dir, log: path.join(dir, "windels-store.jsonl"), snapshot: path.join(dir, "windels-store.jsonl.compact") });
}
