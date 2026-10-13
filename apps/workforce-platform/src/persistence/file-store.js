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
import { assertIsoCutoff, assertJobLockHolder, assertJobLockInstant, assertJobName } from "./contract.js";
import { parseStrictInstant } from "../lib/php-date.js";
import {
  HEALTH_STATUSES,
  MATCH_STATUSES,
  RESULT_STATUSES,
  SYNC_JOB_TYPES,
  SYNC_STATUSES,
  assertEnum,
  assertExecutionKey,
  assertInstant,
  assertProviderCode,
  assertProviderName,
  assertRowId,
  assertSyncRunId,
  assertText,
  encodeJson,
  healthRow,
  matchRow,
  oddsRow,
  optionalInstant,
  optionalRowId,
  providerRow,
  qualityRow,
  resultRow,
  syncRunRow,
  toInt,
  assertPredictionId,
  calibrationRow,
  configurationRow,
  modelVersionRow,
  predictionRow,
  prepareCalibration,
  prepareConfiguration,
  prepareModelVersion,
  preparePrediction,
  CALIBRATION_STATUSES,
  TICKET_APPROVALS,
  TICKET_STATUSES,
  assertRunDate,
  assertTicketId,
  dailyRunRow,
  prepareDailyRunClaim,
  prepareDailyRunFinish,
  prepareTicket,
  ticketRow,
  ticketSelectionRow,
  backtestRow,
  modelMetricsRow,
  performanceSnapshotRow,
  prepareBacktest,
  prepareModelMetrics,
  preparePerformanceSnapshot,
  prepareSelectionSettlement,
  prepareTicketSettlement,
  predictionOutcomeRow,
  settledSelectionRow,
  SNAPSHOT_WINDOWS,
} from "./sports-rows.js";
import {
  LOTTERY_VERIFICATION_STATUSES,
  assertDrawDate,
  assertLotteryCode,
  prepareLotteryCombination,
  prepareLotteryAiDecision,
  lotteryDrawNumberRow,
  lotteryDrawRow,
  lotteryCombinationRow,
  lotteryAiDecisionRow,
  lotteryTicketRow,
  lotteryTicketLineRow,
  prepareLotteryTicket,
  prepareLotteryTicketLine,
  prepareLotteryBacktest,
  lotteryBacktestRow,
  prepareLotteryModelVersion,
  lotteryModelVersionRow,
  lotteryGameRow,
  lotteryHealthRow,
  lotteryProviderRow,
  lotteryRulesRow,
  lotterySyncRunRow,
} from "./lottery-rows.js";
import { createHash } from "node:crypto";
import path from "node:path";

const ENTITIES = ["users", "profiles", "sessions", "roles", "permissions", "userRoles", "rolePermissions", "audit", "inquiries", "analysisRuns", "strategies", "backtests", "journalEntries", "tradingState", "paperAccounts", "paperOrders", "paperPositions", "paperTrades", "paperDeployments", "executionProposals", "notifications", "jobLocks",
  // Sports Intelligence data foundation (migration 011). Seven collections for seven
  // tables, named for the module so that row 15's lottery provider registry — which
  // legacy spells with the SAME method names and near-identical tables — cannot
  // collide with them. Adding an entity here also adds it to `stats()`, which is what
  // makes `backup.test.js` demand a MySQL counterpart for each one.
  "sportsProviders", "sportsHealth", "sportsMatches", "sportsOdds", "sportsResults",
  "sportsQuality", "sportsSyncRuns",
  // Sports decision chain (migration 012): model registry, immutable predictions,
  // append-only configuration and PENDING-until-decided calibrations.
  "sportsModelVersions", "sportsPredictions", "sportsConfigurations", "sportsCalibrations",
  // Tickets and the daily ticket run (migration 013, slice 4). A ticket's selections are a
  // separate collection, as the table is, and a daily run is keyed by its day and version.
  "sportsTickets", "sportsTicketSelections", "sportsDailyTickets",
  // Settlement, measurement and backtests (migration 014, slice 5). Backtests are keyed
  // by their `bt_` id; metrics snapshots are append-only and keyed by id.
  "sportsBacktests", "sportsModelMetrics",
  // Performance snapshots (migration 015, row 19). Keyed by (as_of hour, window) — the
  // migration's UNIQUE key, and what makes a re-run of the same hour REPLACE.
  "sportsPerformanceSnapshots",
  // Lottery Intelligence data foundation (migration 016, row 15 slice 1). Seven
  // collections for seven tables, named for the module exactly as the sports ones
  // are — SP-18 was ABOUT this module's method names. The game registry is
  // `lotteries` (legacy's own table name); a draw is (lottery, external id); a
  // stored rule version is (lottery, version); numbers are (draw, kind, position);
  // health and sync runs follow the sports collections' shapes.
  "lotteries", "lotteryRules", "lotteryProviders", "lotteryHealth", "lotteryDraws",
  "lotteryDrawNumbers", "lotterySyncRuns",
  // Slice 2 (migration 017): the generated-combination record and its AI
  // decision report (spec §14/§26/§33).
  "lotteryCombinations", "lotteryAiDecisions",
  // Slice 3 (migration 018): the ticket record and its number lines.
  "lotteryTickets", "lotteryTicketLines",
  // Slice 4 (migration 019): backtest reports + the model versions they are
  // stamped with (spec §23–§25/§33; ensured once, never deleted).
  "lotteryBacktests", "lotteryModelVersions"];
const PAPER_TX_ENTITIES = Object.freeze(["tradingState", "paperAccounts", "paperOrders", "paperPositions", "paperTrades", "paperDeployments", "executionProposals", "strategies", "journalEntries", "audit"]);
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

/**
 * The file adapter's copy of `lockRow` in `src/db/job-repository.js`.
 *
 * Both adapters must return the SAME shape, because `contract.js` describes one
 * interface and a caller cannot be expected to branch on which one it got. The SQL
 * adapter has always mapped its rows to camelCase; returning the raw snake_case row
 * here would mean `lock.expiresAt` is a string on MySQL and `undefined` on the file
 * store — the sort of divergence that only shows up when a deployment switches
 * adapters, which is exactly when it is hardest to debug.
 */
function jobLockRow(row) {
  if (!row) return null;
  return {
    jobName: String(row.job_name),
    holder: String(row.holder),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
  };
}

/**
 * The file adapter's copy of `assertStateKey` in `src/db/job-repository.js`.
 *
 * Duplicated rather than imported because `src/persistence/` must not depend on
 * `src/db/` — the two adapters are peers that both satisfy `contract.js`. Both
 * copies refuse the `'global'` governance key, which is the invariant that matters.
 */
function assertJobStateKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9._-]{0,23}$/.test(key)) {
    throw new TypeError(`job state key must be 1-24 characters of [a-z0-9._-] starting with a letter, received ${JSON.stringify(String(value).slice(0, 40))}`);
  }
  if (key === "global") {
    throw new TypeError(`"${key}" is the trading-governance state key and is not writable through the job state methods`);
  }
  return key;
}

function keyOf(entity, record) {
  if (entity === "sessions") return record.tokenHash;
  if (entity === "userRoles") return `${record.userId}:${record.roleId}`;
  if (entity === "rolePermissions") return `${record.roleId}:${record.permissionId}`;
  // A strategy is identified by (id, version), not by id alone: the lifecycle gates
  // compare evidence against an exact version, so two versions of one strategy are
  // two rows, exactly as the MySQL primary key makes them.
  if (entity === "strategies") return `${record.strategy_id}:${record.version}`;
  if (entity === "tradingState") return String(record.key || "global");
  // A job lock is identified by its NAME, which is what makes the name itself the
  // mutual-exclusion guarantee — the file adapter's equivalent of the MySQL primary
  // key on `wf_job_locks.job_name`.
  if (entity === "jobLocks") return String(record.job_name);
  // The sports keys mirror the migration's UNIQUE constraints one for one, because the
  // key IS this adapter's uniqueness guarantee — it is what `replace: false` checks.
  // A provider is its code; a fixture is (provider, external id), since two vendors
  // numbering one match differently is the normal case; a result is (match, provider);
  // a sync run is keyed by its execution key rather than its UUID, so the idempotency
  // guarantee is the one that collides. Health, odds and quality are append-only and
  // keyed by id, which is what makes "one row per observation" true by construction.
  if (entity === "sportsProviders") return String(record.provider_code);
  if (entity === "sportsMatches") return `${record.provider_id}:${record.external_id}`;
  if (entity === "sportsResults") return `${record.match_id}:${record.provider_id}`;
  if (entity === "sportsSyncRuns") return String(record.execution_key);
  if (entity === "sportsModelVersions") {
    return [record.model_name, record.model_version, record.feature_version, record.calibration_version].join("|");
  }
  if (entity === "sportsConfigurations") return String(record.version);
  // One daily run per (day, configuration version), the same as the migration's UNIQUE key.
  if (entity === "sportsDailyTickets") return `${record.run_date}|${record.configuration_version}`;
  // One performance snapshot per (as_of hour, window), the same as the migration's
  // UNIQUE key — and what makes the cron's re-run of an hour REPLACE, not append.
  if (entity === "sportsPerformanceSnapshots") return `${record.as_of}|${record.window}`;
  // Lottery foundation (migration 016). A game is its code; a stored rule version is
  // (lottery, version); a provider is its code, as for sports; a draw is
  // (lottery, external id), because two sources numbering one draw differently is
  // the normal case; a number row is (draw, kind, position); a sync run is keyed by
  // its execution key, which is what makes re-ingestion the adapter's arbiter.
  // Health is append-only and keyed by id.
  if (entity === "lotteries") return String(record.code);
  if (entity === "lotteryRules") return `${record.lottery_code}|${record.version}`;
  if (entity === "lotteryProviders") return String(record.provider_code);
  if (entity === "lotteryDraws") return `${record.lottery_code}:${record.external_id}`;
  if (entity === "lotteryDrawNumbers") return `${record.draw_id}|${record.kind}|${record.position}`;
  if (entity === "lotterySyncRuns") return String(record.execution_key);
  // Combinations and AI decisions are auto-increment rows: the insert path below
  // assigns the next id, so the default `String(record.id)` branch is theirs.
  return String(record.id);
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The one notification visibility rule, shared by every read and write so the
 * file adapter cannot drift from the SQL predicate in `notification-repository.js`.
 */
function visibleTo(row, userId) {
  if (row.user_id === null || row.user_id === undefined) return true;
  if (userId === null || userId === undefined) return false;
  return Number(row.user_id) === Number(userId);
}

/**
 * Legacy `users` rows carry `password_hash`/`status`; the account service reads
 * and writes that same shape, so both adapters speak one contract.
 */
export async function createFileStore({ dir, logger = console, idFactory = () => null, syncWrites = true } = {}) {
  let sequence = 0;
  const tables = new Map(ENTITIES.map((entity) => [entity, new Map()]));
  /** The highest id issued per entity, so `nextRowId` never reissues one (F-40). */
  const lastIssuedRowId = new Map();
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

  /**
   * Allocate a row id for an entity whose key is NOT its id.
   *
   * `nextId` above probes `table.has(String(candidate))`, which works when the table
   * is keyed by id. The sports fixtures, results and providers are keyed by their
   * unique constraints instead, so their ids have to be minted by scanning. Highest
   * plus one, never a reused gap: a retired row's id must not be handed to a new one,
   * or an odds row written earlier would appear to belong to a different fixture.
   */
  /**
   * The next id for an entity. Monotonic: an id handed out is never handed out again, even
   * before its write has been applied. Without that, two inserts that start in the same tick
   * (`Promise.all`) both read the same table maximum and both get the same id (F-40). The
   * table scan alone cannot see a write still waiting in the queue.
   */
  function nextRowId(entity) {
    let max = lastIssuedRowId.get(entity) ?? 0;
    for (const row of tables.get(entity).values()) {
      const id = Number(row.id);
      if (Number.isInteger(id) && id > max) max = id;
    }
    lastIssuedRowId.set(entity, max + 1);
    return max + 1;
  }

  /**
   * One provider's health observations, newest first.
   *
   * Sorted by `observed_at` as TEXT with the id as a tiebreaker, which is the same
   * ordering the SQL adapter gets from `ORDER BY observed_at DESC` — and it is
   * chronological only because `assertInstant` writes one fixed width. The tiebreaker
   * matters: two observations in the same millisecond must still come back in a stable
   * order, because `assessProviderHealth` treats element 0 as "the latest report" and
   * derives the provider's status from it.
   */
  function healthFor(providerId) {
    return [...tables.get("sportsHealth").values()]
      .filter((row) => toInt(row.provider_id) === providerId)
      .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || toInt(b.id, 0) - toInt(a.id, 0));
  }

  /** One match's odds observations, newest first, optionally narrowed. */
  function oddsFor(matchId, market = null, selection = null) {
    return [...tables.get("sportsOdds").values()]
      .filter((row) => toInt(row.match_id) === matchId)
      .filter((row) => (market === null || market === undefined ? true : String(row.market) === String(market)))
      .filter((row) => (selection === null || selection === undefined ? true : String(row.selection) === String(selection)))
      .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || toInt(b.id, 0) - toInt(a.id, 0));
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

  /**
   * One WAL record, many changes — the file adapter's atomic multi-row write
   * (R-30). The batch line is applied whole on replay (a torn line is dropped
   * whole), so a crash between the appends of an aggregate — a sports ticket
   * and its selections, a stored draw and its numbers, a lottery ticket and
   * its lines — leaves either everything or nothing, never the half-written
   * state the one-append-at-a-time path could produce. Aggregate writers put
   * children first so even a reader of the raw log sees completeness in the
   * record order. Values are sanitized (the `replace` hint never reaches the
   * log) and the caller owns any pre-write guard it needs.
   *
   * @param {{entity: string, key: string, op: "upsert"|"delete", value: object|null}[]} changes
   */
  function mutateBatch(changes) {
    const run = async () => {
      const clean = changes.map((change) => ({
        entity: change.entity,
        // The key follows the value's own keyOf, exactly as `mutate` derives it —
        // entities with composite keys (draw numbers are draw|kind|position) must
        // not be keyed by a bare id, or deletes and upserts land beside their rows.
        key: change.key ?? keyOf(change.entity, change.value ?? {}),
        op: change.op,
        value: change.value === null || change.value === undefined ? null : sanitize(change.value),
      }));
      await persist({ op: "batch", changes: clean }, { compactAfter: false });
      apply({ op: "batch", changes: clean, sequence }, { persist: false });
      if (appendCount >= COMPACTION_ENTRIES) await compact();
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
        async createExecutionProposal(record) {
          if (!accountOwned(record.account_id, record.owner_user_id)) return null;
          if (txGet("executionProposals", record.id)) throw new Error("Execution proposal already exists");
          return txPut("executionProposals", structuredClone(record));
        },
        async findExecutionProposal(id, ownerUserId) {
          const row = txGet("executionProposals", id);
          return row && String(row.owner_user_id) === String(ownerUserId)
            && accountOwned(row.account_id, ownerUserId)
            ? structuredClone(row)
            : null;
        },
        async listExecutionProposals(ownerUserId, { status = null, limit = 100 } = {}) {
          const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
          return txRows("executionProposals")
            .filter((row) => String(row.owner_user_id) === String(ownerUserId)
              && accountOwned(row.account_id, ownerUserId)
              && (!status || row.status === String(status)))
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
            .slice(0, bounded)
            .map((row) => structuredClone(row));
        },
        async expireExecutionProposal(id, ownerUserId, updatedAt) {
          const row = await this.findExecutionProposal(id, ownerUserId);
          if (!row || row.status !== "PENDING_APPROVAL") return false;
          txPut("executionProposals", { ...row, status: "EXPIRED", updated_at: String(updatedAt) });
          return true;
        },
        async decideExecutionProposal(id, ownerUserId, { status, decisionByUserId, reason, decidedAt, updatedAt }) {
          const row = await this.findExecutionProposal(id, ownerUserId);
          if (!row || row.status !== "PENDING_APPROVAL") return false;
          txPut("executionProposals", {
            ...row,
            status: String(status),
            decision_by_user_id: Number(decisionByUserId),
            decision_reason: String(reason),
            decided_at: String(decidedAt),
            updated_at: String(updatedAt),
          });
          return true;
        },
        async claimExecutionProposal(id, ownerUserId, updatedAt) {
          const row = await this.findExecutionProposal(id, ownerUserId);
          if (!row || row.status !== "APPROVED") return false;
          txPut("executionProposals", { ...row, status: "PAPER_SUBMITTING", updated_at: String(updatedAt) });
          return true;
        },
        async completeExecutionProposal(id, ownerUserId, { status, paperOrderId = null, result = null, updatedAt }) {
          const row = await this.findExecutionProposal(id, ownerUserId);
          if (!row || row.status !== "PAPER_SUBMITTING") return null;
          return txPut("executionProposals", {
            ...row,
            status: String(status),
            paper_order_id: paperOrderId === null ? null : Number(paperOrderId),
            result: result === null ? null : structuredClone(result),
            updated_at: String(updatedAt),
          });
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
    // ------------------------------------------------ job coordination locks
    /**
     * The same protocol as `src/db/job-repository.js`, and deliberately so: a job
     * must behave identically whichever adapter the host is configured with, or a
     * cron schedule validated on the file adapter would not mean anything on MySQL.
     *
     * **This adapter's lock is single-process only.** `capabilities().crossProcessSafety`
     * is `false` here, and the WAL queue that serializes these mutations does not
     * span processes — two Node processes on one directory can each believe they
     * hold the lock. That is a property of the file adapter as a whole, not of this
     * method, and it is why the file store is never `recommendedForProduction`. A
     * real cron deployment needs the MySQL adapter, where the primary key on
     * `wf_job_locks.job_name` is the arbiter. The scheduled-jobs CLI reports the
     * adapter in its output so a log reader can see which guarantee they got.
     */
    async findJobLock(jobName) {
      return jobLockRow(tables.get("jobLocks").get(assertJobName(jobName)));
    },

    async listJobLocks(limit = 100) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      return [...tables.get("jobLocks").values()]
        .sort((a, b) => String(a.job_name).localeCompare(String(b.job_name)))
        .slice(0, bounded)
        .map(jobLockRow);
    },

    async acquireJobLock(jobName, { holder, nowIso, expiresAt }) {
      const name = assertJobName(jobName);
      const owner = assertJobLockHolder(holder);
      const now = assertJobLockInstant(nowIso, "nowIso");
      const expiry = assertJobLockInstant(expiresAt, "expiresAt");
      if (expiry <= now) {
        throw new TypeError("a lock must expire after the instant it is acquired at");
      }

      const table = tables.get("jobLocks");
      const existing = table.get(name);
      if (existing && String(existing.expires_at) > now) {
        const lock = jobLockRow(existing);
        return { acquired: false, lock, reason: `held by ${lock.holder} until ${lock.expiresAt}` };
      }
      const tookOver = Boolean(existing);
      const record = { job_name: name, holder: owner, acquired_at: now, expires_at: expiry };

      try {
        // `replace: false` is this adapter's primary-key arbiter: it makes a
        // concurrent create fail instead of silently overwriting, mirroring the
        // `ER_DUP_ENTRY` the MySQL adapter catches. `sanitize` strips the flag
        // before it is persisted, so it never reaches the WAL.
        await mutate("jobLocks", "upsert", tookOver ? record : { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
        const lock = jobLockRow(table.get(name));
        return {
          acquired: false,
          lock,
          reason: lock ? `held by ${lock.holder} until ${lock.expiresAt}` : "held by another process",
        };
      }

      // Confirm ownership by reading back, exactly as the SQL adapter does, rather
      // than inferring it from the write having not thrown.
      const lock = table.get(name);
      if (!lock || lock.holder !== owner) {
        const current = jobLockRow(lock);
        return {
          acquired: false,
          lock: current,
          reason: current ? `held by ${current.holder} until ${current.expiresAt}` : "the lock row vanished before it could be confirmed",
        };
      }
      return { acquired: true, lock: jobLockRow(lock), reason: tookOver ? "took over an expired lock" : "acquired" };
    },

    async releaseJobLock(jobName, holder) {
      const name = assertJobName(jobName);
      const owner = assertJobLockHolder(holder);
      const existing = tables.get("jobLocks").get(name);
      // Holder-scoped: a run whose lock expired and was taken over must not delete
      // the new holder's row on its way out.
      if (!existing || existing.holder !== owner) return false;
      await mutate("jobLocks", "delete", { job_name: name });
      return true;
    },

    /**
     * Persisted job state, mirroring `src/db/job-repository.js`.
     *
     * Stored in the SAME `tradingState` collection under a different `key`, exactly
     * as the SQL adapter stores it in the same `wf_trading_state` table under a
     * different `state_key` — the two adapters must describe the same world. The
     * governance document lives at key `"global"` and `loadTradingState` reads only
     * that key, so a job state row is invisible to it and vice versa.
     */
    async loadJobState(stateKey) {
      const key = assertJobStateKey(stateKey);
      const stored = tables.get("tradingState").get(key);
      if (!stored || !stored.state || typeof stored.state !== "object") return null;
      return { ...structuredClone(stored.state), updatedAt: stored.updatedAt ?? null };
    },

    async saveJobState(stateKey, state, { updatedAt = nowIso() } = {}) {
      const key = assertJobStateKey(stateKey);
      const { updatedAt: _ignored, ...stateJson } = state && typeof state === "object" ? state : {};
      // `mutate` rather than `withPaperTransaction`: this is not paper state, and
      // routing it through the paper transaction would make a cron write contend
      // with an operator's order for no reason.
      await mutate("tradingState", "upsert", {
        key,
        state: stateJson,
        updatedByUserId: null,
        updatedAt: String(updatedAt),
      });
      return { ...stateJson, updatedAt: String(updatedAt) };
    },

    async extendJobLock(jobName, holder, expiresAt) {
      const name = assertJobName(jobName);
      const owner = assertJobLockHolder(holder);
      const expiry = assertJobLockInstant(expiresAt, "expiresAt");
      const existing = tables.get("jobLocks").get(name);
      if (!existing || existing.holder !== owner) return false;
      await mutate("jobLocks", "upsert", { ...existing, expires_at: expiry });
      return true;
    },

    // ------------------------------------------------ sports data foundation
    /**
     * The same 22 methods as `src/db/sports-repository.js`, over the same row shapes
     * — the validators and mappers are imported from `./sports-rows.js` precisely so
     * that "the same" is a property of the code rather than an intention.
     *
     * **Two guarantees this adapter cannot make, both of which the SQL adapter can.**
     *
     *  1. `capabilities().crossProcessSafety` is `false`. The unique keys that make
     *     `startSportsSync`, `saveSportsMatch` and `saveSportsResult` idempotent are
     *     enforced here by the WAL queue, which serializes mutations *within one
     *     process*. Two Node processes on one directory can each believe they opened
     *     the same sync run. That is a property of the file adapter as a whole (see
     *     `findJobLock` above for the same caveat about locks) and it is why a real
     *     cron deployment needs MySQL, where `uq_wf_sports_sync_runs_execution_key`
     *     is the arbiter.
     *  2. There is no referential engine. `provider_id`, `match_id` and the odds
     *     rows hanging off a match are plain integers here, as they are in the
     *     migration — deliberately, because this adapter has to implement the
     *     identical contract and it has no foreign keys to implement it with.
     *
     * Records are stored with JSON columns as *strings*, so the shared mappers decode
     * them on the way out exactly as they decode a MySQL `LONGTEXT`. Storing parsed
     * objects instead would make this adapter return a different shape from the SQL
     * one for the same call.
     */
    async ensureSportsProvider(code, name) {
      const providerCode = assertProviderCode(code);
      const displayName = assertProviderName(name);
      const table = tables.get("sportsProviders");
      const existing = table.get(providerCode);
      if (existing) return providerRow(existing);

      const now = nowIso();
      const record = {
        id: nextRowId("sportsProviders"),
        provider_code: providerCode,
        display_name: displayName,
        enabled: 0,
        created_at: now,
        updated_at: now,
      };
      try {
        // `replace: false` is this adapter's unique-key arbiter, mirroring the
        // `ER_DUP_ENTRY` the SQL adapter catches.
        await mutate("sportsProviders", "upsert", { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
      }
      return providerRow(table.get(providerCode) ?? null);
    },

    async listSportsProviders(enabledOnly = false) {
      return [...tables.get("sportsProviders").values()]
        .filter((row) => !enabledOnly || toInt(row.enabled, 0) === 1)
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0))
        .map(providerRow);
    },

    async setSportsProviderEnabled(id, enabled) {
      const providerId = assertRowId(id, "provider id");
      const table = tables.get("sportsProviders");
      const existing = [...table.values()].find((row) => toInt(row.id) === providerId);
      if (!existing) return;
      await mutate("sportsProviders", "upsert", {
        ...existing,
        enabled: enabled ? 1 : 0,
        updated_at: nowIso(),
      });
    },

    async saveSportsHealth(providerId, health) {
      const h = health && typeof health === "object" ? health : {};
      const record = {
        id: nextRowId("sportsHealth"),
        provider_id: assertRowId(providerId, "provider_id"),
        status: assertEnum(h.status, HEALTH_STATUSES, "health status"),
        response_ms: h.responseMs === null || h.responseMs === undefined ? null : toInt(h.responseMs),
        error_rate: h.errorRate === null || h.errorRate === undefined ? null : Number(h.errorRate),
        rate_limit_remaining: h.rateLimitRemaining === null || h.rateLimitRemaining === undefined ? null : toInt(h.rateLimitRemaining),
        last_success_at: optionalInstant(h.lastSuccessAt, "lastSuccessAt"),
        last_failure_at: optionalInstant(h.lastFailureAt, "lastFailureAt"),
        last_fixture_sync_at: optionalInstant(h.lastFixtureSyncAt, "lastFixtureSyncAt"),
        last_odds_sync_at: optionalInstant(h.lastOddsSyncAt, "lastOddsSyncAt"),
        last_result_sync_at: optionalInstant(h.lastResultSyncAt, "lastResultSyncAt"),
        data_freshness_seconds: h.dataFreshnessSeconds === null || h.dataFreshnessSeconds === undefined ? null : toInt(h.dataFreshnessSeconds),
        records_received: toInt(h.recordsReceived, 0),
        invalid_records: toInt(h.invalidRecords, 0),
        missing_fields: encodeJson(Array.isArray(h.missingFields) ? h.missingFields : []),
        // Stamped here rather than taken from the payload, as the SQL adapter does:
        // this is when THIS PLATFORM saw the report, and a provider's own clock is not
        // authoritative for staleness.
        observed_at: nowIso(),
      };
      await mutate("sportsHealth", "upsert", record);
    },

    async latestSportsHealth(providerId) {
      const id = assertRowId(providerId, "provider_id");
      const rows = healthFor(id);
      return rows.length ? healthRow(rows[0]) : null;
    },

    async listSportsHealth(providerId, limit = 20) {
      const id = assertRowId(providerId, "provider_id");
      const bounded = Math.min(200, Math.max(1, toInt(limit, 20)));
      return healthFor(id).slice(0, bounded).map(healthRow);
    },

    async pruneSportsHealth(cutoff) {
      const boundary = assertIsoCutoff(cutoff);
      const doomed = [...tables.get("sportsHealth").values()].filter(
        (row) => String(row.observed_at) < boundary,
      );
      for (const row of doomed) {
        await mutate("sportsHealth", "delete", { id: row.id });
      }
      return doomed.length;
    },

    async findSportsMatchById(id) {
      const matchId = assertRowId(id, "match id");
      const row = [...tables.get("sportsMatches").values()].find((entry) => toInt(entry.id) === matchId);
      return matchRow(row ?? null);
    },

    async listSportsMatches(filter = {}, limit = 200) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(1000, Math.max(1, toInt(limit, 200)));
      const status = f.status === null || f.status === undefined || String(f.status).trim() === ""
        ? null
        : assertEnum(f.status, MATCH_STATUSES, "match status");
      const from = f.from === null || f.from === undefined || String(f.from).trim() === ""
        ? null
        : assertInstant(f.from, "filter.from");
      const to = f.to === null || f.to === undefined || String(f.to).trim() === ""
        ? null
        : assertInstant(f.to, "filter.to");
      const providerId = f.providerId === null || f.providerId === undefined || String(f.providerId).trim() === ""
        ? null
        : assertRowId(f.providerId, "filter.providerId");
      // A PREFIX match, as legacy's CodeIgniter `like(..., 'after')` was — but
      // case-sensitively, because MySQL's default `utf8mb4_unicode_ci` collation makes
      // `LIKE 'pre%'` case-insensitive while a JS `startsWith` is not. Lowercasing both
      // sides keeps the two adapters answering the same question (divergence SP-20).
      const competition = f.competition === null || f.competition === undefined || String(f.competition).trim() === ""
        ? null
        : String(f.competition).toLowerCase();

      return [...tables.get("sportsMatches").values()]
        .filter((row) => (status === null ? true : String(row.status) === status))
        .filter((row) => (from === null ? true : String(row.kickoff_at) >= from))
        .filter((row) => (to === null ? true : String(row.kickoff_at) <= to))
        .filter((row) => (providerId === null ? true : toInt(row.provider_id) === providerId))
        .filter((row) => (competition === null ? true : String(row.competition).toLowerCase().startsWith(competition)))
        // A string sort, which is chronological because every kickoff is one fixed
        // width — the property `assertInstant` exists to guarantee.
        .sort((a, b) => String(a.kickoff_at).localeCompare(String(b.kickoff_at)) || toInt(a.id, 0) - toInt(b.id, 0))
        .slice(0, bounded)
        .map(matchRow);
    },

    async saveSportsMatch(providerId, match) {
      const provider = assertRowId(providerId, "provider_id");
      const m = match && typeof match === "object" ? match : {};
      const externalId = assertText(String(m.externalId ?? "").trim(), 128, "external_id");
      if (!externalId) throw new TypeError("external_id must be 1-128 characters");
      const key = `${provider}:${externalId}`;
      const table = tables.get("sportsMatches");
      const existing = table.get(key);
      const now = nowIso();

      const record = {
        // Preserved on update, minted on insert — and returned on BOTH paths. Legacy's
        // insert branch omitted `created_at` from its return value, so the sync
        // service's `created_at === updated_at` test could never be true and every new
        // fixture was counted as an update (divergence SP-13).
        id: existing ? toInt(existing.id) : nextRowId("sportsMatches"),
        provider_id: provider,
        external_id: externalId,
        sport: assertText(String(m.sport ?? ""), 32, "sport"),
        competition: assertText(String(m.competition ?? ""), 160, "competition"),
        home_team: assertText(String(m.homeTeam ?? ""), 160, "home_team"),
        away_team: assertText(String(m.awayTeam ?? ""), 160, "away_team"),
        kickoff_at: assertInstant(m.kickoff, "match kickoff"),
        status: assertEnum(m.status, MATCH_STATUSES, "match status"),
        source_timestamp: assertInstant(m.sourceTimestamp, "match sourceTimestamp"),
        payload: encodeJson(m),
        created_at: existing ? String(existing.created_at) : now,
        updated_at: now,
      };

      try {
        await mutate("sportsMatches", "upsert", existing ? record : { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
      }
      return matchRow(table.get(key) ?? null);
    },

    async findSportsMatch(providerId, externalId) {
      const provider = assertRowId(providerId, "provider_id");
      const id = assertText(String(externalId ?? "").trim(), 128, "external_id");
      return matchRow(tables.get("sportsMatches").get(`${provider}:${id}`) ?? null);
    },

    async saveSportsOdds(matchId, providerId, odds) {
      const o = odds && typeof odds === "object" ? odds : {};
      const market = assertText(String(o.market ?? ""), 96, "market");
      const selection = assertText(String(o.selection ?? ""), 160, "selection");
      const decimal = Number(o.decimalOdds);
      if (!Number.isFinite(decimal) || decimal <= 1.0) {
        throw new TypeError(`decimal_odds must be a finite number greater than 1.0, received ${JSON.stringify(o.decimalOdds)}`);
      }
      const record = {
        id: nextRowId("sportsOdds"),
        match_id: assertRowId(matchId, "match_id"),
        provider_id: assertRowId(providerId, "provider_id"),
        market,
        selection,
        decimal_odds: decimal,
        observed_at: assertInstant(o.observedAt, "odds observedAt"),
        payload: encodeJson(o),
      };
      // No uniqueness check: every observation is a new row, and overwriting would
      // destroy the point-in-time history `findSportsOddsBefore` exists to answer.
      await mutate("sportsOdds", "upsert", record);
      return oddsRow(record);
    },

    async latestSportsOdds(matchId, market = null, selection = null) {
      const rows = oddsFor(assertRowId(matchId, "match_id"), market, selection);
      return rows.length ? oddsRow(rows[0]) : null;
    },

    async listSportsOdds(matchId, limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      return oddsFor(assertRowId(matchId, "match_id")).slice(0, bounded).map(oddsRow);
    },

    async findSportsOddsBefore(matchId, timestamp) {
      const limitDate = parseStrictInstant(timestamp);
      // An unparseable instant means "no odds known before an instant we cannot
      // place", not "all odds" — the fail-closed answer, and legacy's
      // `strtotime(...) === false` branch.
      if (!limitDate) return null;
      const limit = Math.floor(limitDate.getTime() / 1000);
      // Bounded to the newest 500 rows, as legacy is, so a match with more than 500
      // observations has the same reachable history through either adapter.
      for (const row of oddsFor(assertRowId(matchId, "match_id")).slice(0, 500)) {
        const observed = parseStrictInstant(row.observed_at);
        if (observed && Math.floor(observed.getTime() / 1000) < limit) return oddsRow(row);
      }
      return null;
    },

    async saveSportsResult(matchId, providerId, result) {
      const r = result && typeof result === "object" ? result : {};
      const match = assertRowId(matchId, "match_id");
      const provider = assertRowId(providerId, "provider_id");
      const key = `${match}:${provider}`;
      const table = tables.get("sportsResults");
      const existing = table.get(key);
      const record = {
        id: existing ? toInt(existing.id) : nextRowId("sportsResults"),
        match_id: match,
        provider_id: provider,
        home_score: r.homeScore === null || r.homeScore === undefined ? null : toInt(r.homeScore),
        away_score: r.awayScore === null || r.awayScore === undefined ? null : toInt(r.awayScore),
        status: assertEnum(r.status, RESULT_STATUSES, "result status"),
        // Re-ingesting clears the attestation (divergence SP-14, preserved from
        // legacy): a provider that changes a scoreline invalidates the human
        // verification made about the old one, so the safe direction is to require a
        // human to look again.
        verified: 0,
        source_timestamp: assertInstant(r.sourceTimestamp, "result sourceTimestamp"),
        verified_at: null,
        payload: encodeJson(r.payload ?? r),
      };
      try {
        await mutate("sportsResults", "upsert", existing ? record : { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
      }
      return resultRow(table.get(key) ?? null);
    },

    async findSportsResult(matchId, providerId) {
      const key = `${assertRowId(matchId, "match_id")}:${assertRowId(providerId, "provider_id")}`;
      return resultRow(tables.get("sportsResults").get(key) ?? null);
    },

    /**
     * Attest to one stored result (slice 5). Only the attestation moves: scores,
     * status and payload stay as the provider reported them.
     */
    async verifySportsResult(resultId, verifiedAt) {
      const id = assertRowId(resultId, "result id");
      const current = [...tables.get("sportsResults").values()].find((r) => toInt(r.id, 0) === id);
      if (!current) return null;
      const at = optionalInstant(verifiedAt, "verified_at") ?? nowIso();
      await mutate("sportsResults", "upsert", { ...current, verified: 1, verified_at: at });
      return resultRow([...tables.get("sportsResults").values()].find((r) => toInt(r.id, 0) === id));
    },

    /** Verified first, then newest id — the same order the SQL applies. */
    async findSportsResultByMatch(matchId) {
      const id = assertRowId(matchId, "match_id");
      const rows = [...tables.get("sportsResults").values()]
        .filter((r) => toInt(r.match_id, 0) === id)
        .sort((a, b) => (toInt(b.verified, 0) - toInt(a.verified, 0)) || (toInt(b.id, 0) - toInt(a.id, 0)));
      return rows.length ? resultRow(rows[0]) : null;
    },

    async saveSportsQuality(matchId, assessment) {
      const a = assessment && typeof assessment === "object" ? assessment : {};
      const record = {
        id: nextRowId("sportsQuality"),
        match_id: assertRowId(matchId, "match_id"),
        score: toInt(a.score, 0),
        band: assertEnum(a.band, ["EXCELLENT", "GOOD", "LIMITED", "REJECT"], "quality band"),
        freshness_score: toInt(a.freshnessScore, 0),
        provider_reliability_score: toInt(a.providerReliabilityScore, 0),
        eligible_prediction: a.eligibleForPrediction ? 1 : 0,
        eligible_ticket: a.eligibleForTicket ? 1 : 0,
        missing_fields: encodeJson(Array.isArray(a.missing) ? a.missing : []),
        checks_payload: encodeJson(a.checks ?? null),
        assessed_at: nowIso(),
      };
      // Append-only, so "was this fixture eligible when we acted on it" stays
      // answerable after the next sync re-scores it.
      await mutate("sportsQuality", "upsert", record);
      return qualityRow(record);
    },

    async latestSportsQuality(matchId) {
      const id = assertRowId(matchId, "match_id");
      const rows = [...tables.get("sportsQuality").values()]
        .filter((row) => toInt(row.match_id) === id)
        .sort((a, b) => String(b.assessed_at).localeCompare(String(a.assessed_at)) || toInt(b.id, 0) - toInt(a.id, 0));
      return rows.length ? qualityRow(rows[0]) : null;
    },

    async startSportsSync(run) {
      const r = run && typeof run === "object" ? run : {};
      const id = assertSyncRunId(r.id);
      const executionKey = assertExecutionKey(r.executionKey);
      const jobType = assertEnum(r.jobType, SYNC_JOB_TYPES, "sync job_type");
      const providerId = optionalRowId(r.providerId, "sync provider_id");
      const record = {
        id,
        provider_id: providerId,
        job_type: jobType,
        status: "RUNNING",
        started_at: nowIso(),
        ended_at: null,
        records_processed: 0,
        records_created: 0,
        records_updated: 0,
        errors: null,
        execution_key: executionKey,
      };
      try {
        // Keyed by `execution_key`, so `replace: false` is the arbiter — the file
        // adapter's equivalent of `uq_wf_sports_sync_runs_execution_key`. A collision
        // becomes the same `null` the SQL adapter returns, so a double-fired cron job
        // reports DUPLICATE_SKIPPED rather than ingesting twice.
        await mutate("sportsSyncRuns", "upsert", { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
        return null;
      }
      return syncRunRow(record);
    },

    async finishSportsSync(id, result) {
      const runId = assertSyncRunId(id);
      const r = result && typeof result === "object" ? result : {};
      const table = tables.get("sportsSyncRuns");
      const existing = [...table.values()].find((row) => String(row.id) === runId);
      if (!existing) return;
      await mutate("sportsSyncRuns", "upsert", {
        ...existing,
        status: assertEnum(r.status, SYNC_STATUSES, "sync status"),
        ended_at: nowIso(),
        records_processed: toInt(r.processed, 0),
        records_created: toInt(r.created, 0),
        records_updated: toInt(r.updated, 0),
        // Truncated to 200 characters each, as legacy does and as the SQL adapter
        // does: a run must be able to name what it refused, but one provider's stack
        // trace must not be able to fill the column.
        errors: encodeJson((Array.isArray(r.errors) ? r.errors : []).map((entry) => String(entry).slice(0, 200))),
      });
    },

    async listSportsSyncRuns(filter = {}, limit = 20) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 20)));
      const providerId = f.providerId === null || f.providerId === undefined || String(f.providerId).trim() === ""
        ? null
        : assertRowId(f.providerId, "filter.providerId");
      const jobType = f.jobType === null || f.jobType === undefined || String(f.jobType).trim() === ""
        ? null
        : assertEnum(f.jobType, SYNC_JOB_TYPES, "filter.jobType");
      const status = f.status === null || f.status === undefined || String(f.status).trim() === ""
        ? null
        : assertEnum(f.status, SYNC_STATUSES, "filter.status");

      return [...tables.get("sportsSyncRuns").values()]
        .filter((row) => (providerId === null ? true : toInt(row.provider_id) === providerId))
        .filter((row) => (jobType === null ? true : String(row.job_type) === jobType))
        .filter((row) => (status === null ? true : String(row.status) === status))
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map(syncRunRow);
    },

    // ── slice 3: mirrors src/db/sports-intelligence-repository.js method for method ──
    // The same validators and shapes come from sports-rows.js, and the same three rules
    // apply: predictions are insert-only, configuration versions are unique, and calibration
    // decisions only succeed from PENDING. Single-process, like everything in this adapter.
    async ensureSportsModelVersion(input) {
      const row = prepareModelVersion(input ?? {}, input?.createdAt);
      const find = () => [...tables.get("sportsModelVersions").values()].find((r) => r.model_name === row.model_name
        && r.model_version === row.model_version && r.feature_version === row.feature_version
        && r.calibration_version === row.calibration_version);
      const existing = find();
      if (existing) return modelVersionRow(existing);
      const record = { id: nextRowId("sportsModelVersions"), ...row };
      await mutate("sportsModelVersions", "upsert", record);
      return modelVersionRow(find());
    },

    async listSportsModelVersions() {
      return [...tables.get("sportsModelVersions").values()]
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0))
        .map(modelVersionRow);
    },

    async saveSportsPrediction(input) {
      const id = assertPredictionId(input?.id);
      const row = preparePrediction(input ?? {}, { id, createdAt: input?.createdAt });
      // `replace: false`: a decision is never overwritten, so a duplicate id throws, as the
      // MySQL primary key does.
      await mutate("sportsPredictions", "upsert", { id, ...row, replace: false });
      return predictionRow(tables.get("sportsPredictions").get(id));
    },

    async findSportsPrediction(id) {
      return predictionRow(tables.get("sportsPredictions").get(assertPredictionId(id)) ?? null);
    },

    async listSportsPredictions(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const matchId = f.matchId === null || f.matchId === undefined ? null : assertRowId(f.matchId, "filter.matchId");
      const modelVersionId = f.modelVersionId === null || f.modelVersionId === undefined
        ? null : assertRowId(f.modelVersionId, "filter.modelVersionId");
      const decision = f.decision === null || f.decision === undefined
        ? null : assertEnum(f.decision, ["PREDICTION_READY", "NO_PREDICTION"], "filter.decision");
      return [...tables.get("sportsPredictions").values()]
        .filter((r) => (matchId === null || toInt(r.match_id) === matchId)
          && (modelVersionId === null || toInt(r.model_version_id) === modelVersionId)
          && (decision === null || r.decision === decision))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map(predictionRow);
    },

    async saveSportsConfiguration(input) {
      const row = prepareConfiguration(input ?? {});
      if ([...tables.get("sportsConfigurations").values()].some((r) => toInt(r.version) === row.version)) return null;
      const record = { id: nextRowId("sportsConfigurations"), ...row };
      await mutate("sportsConfigurations", "upsert", { ...record, replace: false });
      return configurationRow(record);
    },

    async activeSportsConfiguration() {
      const rows = [...tables.get("sportsConfigurations").values()].sort((a, b) => toInt(b.version, 0) - toInt(a.version, 0));
      return configurationRow(rows[0] ?? null);
    },

    async listSportsConfigurations(limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      return [...tables.get("sportsConfigurations").values()]
        .sort((a, b) => toInt(b.version, 0) - toInt(a.version, 0))
        .slice(0, bounded)
        .map(configurationRow);
    },

    async saveSportsCalibration(input) {
      const row = prepareCalibration(input?.fit ?? {}, {
        modelVersionId: input?.modelVersionId,
        calibrationVersion: input?.calibrationVersion,
        createdBy: input?.createdBy,
        createdAt: input?.createdAt,
      });
      const record = { id: nextRowId("sportsCalibrations"), ...row };
      await mutate("sportsCalibrations", "upsert", record);
      return calibrationRow(record);
    },

    async findSportsCalibration(id) {
      return calibrationRow(tables.get("sportsCalibrations").get(String(assertRowId(id, "calibration id"))) ?? null);
    },

    async listSportsCalibrations(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const modelVersionId = f.modelVersionId === null || f.modelVersionId === undefined
        ? null : assertRowId(f.modelVersionId, "filter.modelVersionId");
      const status = f.status === null || f.status === undefined
        ? null : assertEnum(f.status, CALIBRATION_STATUSES, "filter.status");
      return [...tables.get("sportsCalibrations").values()]
        .filter((r) => (modelVersionId === null || toInt(r.model_version_id) === modelVersionId)
          && (status === null || r.status === status))
        .sort((a, b) => toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(calibrationRow);
    },

    async decideSportsCalibration(id, status, actorId, decidedAt) {
      const calibrationId = String(assertRowId(id, "calibration id"));
      const decision = assertEnum(status, ["APPROVED", "REJECTED"], "calibration decision");
      const current = tables.get("sportsCalibrations").get(calibrationId);
      if (!current || current.status !== "PENDING") return null;
      await mutate("sportsCalibrations", "upsert", {
        ...current,
        status: decision,
        approved_by: String(actorId ?? "").slice(0, 64),
        approved_at: decidedAt,
      });
      return calibrationRow(tables.get("sportsCalibrations").get(calibrationId));
    },

    // ── tickets and the daily run (row 14, slice 4, migration 013) ──────────────────────
    // The same nine methods as `src/db/sports-ticket-repository.js`. The file adapter is one
    // process behind one queue, so a ticket's two collections are written in order rather
    // than in a transaction. The same caveat applies to calibration decisions (SP-28).

    async saveSportsTicket(built) {
      const { ticket, selections } = prepareTicket(built ?? {});
      // R-30: the ticket and its legs are ONE WAL batch, legs FIRST — a crash
      // used to be able to leave a ticket with fewer selections than
      // selection_count claims. The replace:false guard is checked up front so
      // a duplicate id still refuses before anything is written.
      const key = keyOf("sportsTickets", ticket);
      if (tables.get("sportsTickets").has(key)) throw new Error("Already exists");
      const changes = selections.map((selection) => {
        const id = nextRowId("sportsTicketSelections");
        return { entity: "sportsTicketSelections", op: "upsert", value: { id, ...selection } };
      });
      changes.push({ entity: "sportsTickets", op: "upsert", value: { ...ticket, replace: false } });
      await mutateBatch(changes);
      return ticketRow(tables.get("sportsTickets").get(ticket.id));
    },

    async findSportsTicket(id) {
      return ticketRow(tables.get("sportsTickets").get(assertTicketId(id)) ?? null);
    },

    async listSportsTickets(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const approval = f.approvalStatus === null || f.approvalStatus === undefined
        ? null : assertEnum(f.approvalStatus, TICKET_APPROVALS, "filter.approvalStatus");
      // Same meaning as the SQL subquery: tickets linked from a daily run on that day.
      const runDate = f.runDate === null || f.runDate === undefined ? null : assertRunDate(f.runDate);
      const status = f.status === null || f.status === undefined
        ? null : assertText(String(f.status).slice(0, 16), 16, "filter.status");
      const linked = runDate === null ? null : new Set(
        [...tables.get("sportsDailyTickets").values()]
          .filter((r) => r.run_date === runDate && r.ticket_id !== null && r.ticket_id !== undefined)
          .map((r) => String(r.ticket_id)),
      );
      return [...tables.get("sportsTickets").values()]
        .filter((r) => (approval === null || r.approval_status === approval)
          && (linked === null || linked.has(String(r.id)))
          && (status === null || r.status === status))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map(ticketRow);
    },

    async listSportsTicketSelections(ticketId) {
      const id = assertTicketId(ticketId);
      return [...tables.get("sportsTicketSelections").values()]
        .filter((r) => r.ticket_id === id)
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0))
        .map(ticketSelectionRow);
    },

    /** Compare-and-set on PENDING. Returns the decided row, or `null` when not pending. */
    async decideSportsTicket(id, decision) {
      const ticketId = assertTicketId(id);
      const current = tables.get("sportsTickets").get(ticketId);
      if (!current || current.approval_status !== "PENDING_USER_APPROVAL") return null;
      await mutate("sportsTickets", "upsert", {
        ...current,
        approval_status: assertEnum(decision.approvalStatus, TICKET_APPROVALS, "approval_status"),
        status: assertEnum(decision.status, TICKET_STATUSES, "status"),
        reason: decision.reason === null || decision.reason === undefined ? null : String(decision.reason).slice(0, 500),
        decided_by: decision.decidedBy === null || decision.decidedBy === undefined ? null : String(decision.decidedBy).slice(0, 64),
        decided_at: decision.decidedAt,
      });
      return ticketRow(tables.get("sportsTickets").get(ticketId));
    },

    /** Claim the day and version. `null` when a run already exists for them, whatever its status. */
    async claimSportsDailyTicketRun(input) {
      const row = prepareDailyRunClaim(input ?? {});
      const key = `${row.run_date}|${row.configuration_version}`;
      if (tables.get("sportsDailyTickets").has(key)) return null;
      const id = nextRowId("sportsDailyTickets");
      try {
        await mutate("sportsDailyTickets", "upsert", { id, ...row, replace: false });
      } catch (error) {
        if (String(error?.message ?? "") === "Already exists") return null;
        throw error;
      }
      return dailyRunRow(tables.get("sportsDailyTickets").get(key));
    },

    /** Finish a RUNNING run. A run is finished once. `null` when it was not RUNNING. */
    async finishSportsDailyTicketRun(id, outcome, updatedAt) {
      const runId = assertRowId(id, "daily run id");
      const current = [...tables.get("sportsDailyTickets").values()].find((r) => toInt(r.id, 0) === runId);
      if (!current || current.status !== "RUNNING") return null;
      await mutate("sportsDailyTickets", "upsert", { ...current, ...prepareDailyRunFinish(outcome ?? {}, updatedAt) });
      return dailyRunRow([...tables.get("sportsDailyTickets").values()].find((r) => toInt(r.id, 0) === runId));
    },

    async findSportsDailyTicketRun(runDate, configurationVersion) {
      const version = toInt(configurationVersion, -1);
      if (version < 0) throw new TypeError("configuration version must be a non-negative integer");
      return dailyRunRow(tables.get("sportsDailyTickets").get(`${assertRunDate(runDate)}|${version}`) ?? null);
    },

    async listSportsDailyTicketRuns(limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      return [...tables.get("sportsDailyTickets").values()]
        .sort((a, b) => String(b.run_date).localeCompare(String(a.run_date)) || toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(dailyRunRow);
    },

    // ── settlement (slice 5, migration 014) ──────────────────────────────────
    // The same four named-field writes the SQL adapter makes. `updateSportsTicket`
    // accepts the settlement columns only — the same fields `prepareTicketSettlement`
    // validates — so a settlement sweep cannot overwrite `approval_status` here either.

    async updateSportsTicket(id, patch) {
      const ticketId = assertTicketId(id);
      const current = tables.get("sportsTickets").get(ticketId);
      if (!current) return null;
      const p = prepareTicketSettlement(patch ?? {});
      await mutate("sportsTickets", "upsert", {
        ...current,
        settlement_status: p.settlement_status,
        status: p.status,
        total_odds: p.total_odds,
        reason: p.reason,
      });
      return ticketRow(tables.get("sportsTickets").get(ticketId));
    },

    async updateSportsTicketSelection(id, patch) {
      const selectionId = assertRowId(id, "selection id");
      const current = [...tables.get("sportsTicketSelections").values()].find((r) => toInt(r.id, 0) === selectionId);
      if (!current) return null;
      const p = prepareSelectionSettlement(patch ?? {});
      await mutate("sportsTicketSelections", "upsert", { ...current, status: p.status, result: p.result });
      return ticketSelectionRow([...tables.get("sportsTicketSelections").values()].find((r) => toInt(r.id, 0) === selectionId));
    },

    async recordSportsTicketOutcome(id, pnl) {
      const ticketId = assertTicketId(id);
      const current = tables.get("sportsTickets").get(ticketId);
      if (!current) return null;
      const value = Number(pnl);
      if (!Number.isFinite(value)) throw new TypeError(`pnl must be a finite number, received ${JSON.stringify(pnl)}`);
      await mutate("sportsTickets", "upsert", { ...current, pnl: Number(value.toFixed(4)) });
      return ticketRow(tables.get("sportsTickets").get(ticketId));
    },

    /** Delete RUNNING claims for a day and report exactly what was removed (R-29). */
    async recoverSportsDailyTicketRuns(runDate) {
      const date = assertRunDate(runDate);
      const stuck = [...tables.get("sportsDailyTickets").values()]
        .filter((r) => r.run_date === date && r.status === "RUNNING")
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0));
      const removed = [];
      for (const row of stuck) {
        await mutate("sportsDailyTickets", "delete", row);
        removed.push(dailyRunRow(row));
      }
      return removed;
    },

    // ── measured performance (slice 5, migration 014) ────────────────────────

    /** Verified-finished-result outcomes, in creation order; unscorable markets excluded. */
    async listSportsPredictionOutcomes(modelVersionId = null, limit = 5000) {
      const bounded = Math.min(5000, Math.max(1, toInt(limit, 5000)));
      const matches = new Map([...tables.get("sportsMatches").values()].map((m) => [String(m.id), m]));
      const resultsByMatch = new Map();
      for (const r of tables.get("sportsResults").values()) {
        const key = String(r.match_id);
        const current = resultsByMatch.get(key);
        // Verified first, then newest id — the same order the SQL join's WHERE and the
        // MySQL adapter's ORDER BY produce.
        if (!current || toInt(r.verified, 0) > toInt(current.verified, 0) || toInt(r.id, 0) > toInt(current.id, 0)) {
          resultsByMatch.set(key, r);
        }
      }
      const out = [];
      const predictions = [...tables.get("sportsPredictions").values()]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
      for (const p of predictions) {
        if (out.length >= bounded) break;
        if (modelVersionId !== null && modelVersionId !== undefined && toInt(p.model_version_id, 0) !== toInt(modelVersionId)) continue;
        const match = matches.get(String(p.match_id));
        if (!match) continue;
        const result = resultsByMatch.get(String(p.match_id));
        if (!result || toInt(result.verified, 0) !== 1 || result.status !== "FINISHED") continue;
        const mapped = predictionOutcomeRow({
          ...p,
          league: match.competition ?? null,
          home_score: result.home_score,
          away_score: result.away_score,
        });
        if (mapped !== null) out.push(mapped);
      }
      return out;
    },

    /** Ticket legs joined to ticket/match/model fields, `_settled` naming terminal legs. */
    async listSportsSettledSelections(filter = {}, limit = 5000) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(5000, Math.max(1, toInt(limit, 5000)));
      const tickets = new Map([...tables.get("sportsTickets").values()].map((t) => [String(t.id), t]));
      const matches = new Map([...tables.get("sportsMatches").values()].map((m) => [String(m.id), m]));
      const modelVersions = new Map([...tables.get("sportsModelVersions").values()].map((m) => [String(m.id), m]));
      const from = f.from === null || f.from === undefined || String(f.from).trim() === "" ? null : assertIsoCutoff(String(f.from).trim());
      const to = f.to === null || f.to === undefined || String(f.to).trim() === "" ? null : assertIsoCutoff(String(f.to).trim());
      const market = f.market === null || f.market === undefined || String(f.market).trim() === "" ? null : String(f.market).slice(0, 40);
      const modelVersionId = f.modelVersionId === null || f.modelVersionId === undefined ? null : toInt(f.modelVersionId);
      const out = [];
      const selections = [...tables.get("sportsTicketSelections").values()]
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0));
      for (const s of selections) {
        if (out.length >= bounded) break;
        const ticket = tickets.get(String(s.ticket_id));
        if (!ticket) continue;
        if (from !== null && String(ticket.created_at) < from) continue;
        if (to !== null && String(ticket.created_at) > to) continue;
        if (market !== null && s.market !== market) continue;
        if (modelVersionId !== null && toInt(ticket.model_version_id, 0) !== modelVersionId) continue;
        const match = matches.get(String(s.match_id));
        const model = ticket.model_version_id === null ? null : modelVersions.get(String(ticket.model_version_id));
        out.push(settledSelectionRow({
          ...s,
          ticket_odds: ticket.total_odds,
          ticket_status: ticket.settlement_status,
          ticket_stake: ticket.stake,
          ticket_pnl: ticket.pnl,
          competition: match?.competition ?? null,
          kickoff_at: match?.kickoff_at ?? null,
          model_name: model?.model_name ?? null,
          model_version: model?.model_version ?? null,
        }));
      }
      return out;
    },

    async saveSportsModelMetrics(input) {
      const row = prepareModelMetrics(input ?? {});
      const id = nextRowId("sportsModelMetrics");
      await mutate("sportsModelMetrics", "upsert", { id, ...row, replace: false });
      return modelMetricsRow(tables.get("sportsModelMetrics").get(String(id)));
    },

    async listSportsModelMetrics(filter = {}, limit = 100) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 100)));
      const modelVersionId = f.modelVersionId === null || f.modelVersionId === undefined ? null : toInt(f.modelVersionId);
      const windowDays = f.windowDays === null || f.windowDays === undefined ? null : toInt(f.windowDays);
      const sampleType = f.sampleType === null || f.sampleType === undefined ? null : String(f.sampleType).slice(0, 16);
      return [...tables.get("sportsModelMetrics").values()]
        .filter((r) => (modelVersionId === null || toInt(r.model_version_id, 0) === modelVersionId)
          && (windowDays === null || toInt(r.window_days, 0) === windowDays)
          && (sampleType === null || r.sample_type === sampleType))
        .sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)) || toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(modelMetricsRow);
    },

    async saveSportsBacktest(input) {
      const row = prepareBacktest(input ?? {});
      await mutate("sportsBacktests", "upsert", { ...row, replace: false });
      return backtestRow(tables.get("sportsBacktests").get(row.id));
    },

    async findSportsBacktest(id) {
      const backtestId = String(id ?? "");
      if (!/^bt_[0-9a-f]{16}$/.test(backtestId)) {
        throw new TypeError(`backtest id must be 'bt_' and 16 hex characters, received ${JSON.stringify(backtestId.slice(0, 40))}`);
      }
      return backtestRow(tables.get("sportsBacktests").get(backtestId) ?? null);
    },

    async listSportsBacktests(limit = 20) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 20)));
      return [...tables.get("sportsBacktests").values()]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map(backtestRow);
    },

    /**
     * Store one performance snapshot. No `replace: false`: (as_of, window) is the
     * identity the keyOf arbiter enforces, and legacy's write REPLACES the window's
     * snapshot when the same hour runs again — an upsert, not an append.
     */
    async saveSportsPerformanceSnapshot(input) {
      const row = preparePerformanceSnapshot(input ?? {});
      const key = `${row.as_of}|${row.window}`;
      await mutate("sportsPerformanceSnapshots", "upsert", row);
      return performanceSnapshotRow(tables.get("sportsPerformanceSnapshots").get(key));
    },

    async listSportsPerformanceSnapshots(window, limit = 30) {
      const w = String(window ?? "").trim();
      if (!SNAPSHOT_WINDOWS.includes(w)) {
        throw new TypeError(`snapshot window must be one of ${SNAPSHOT_WINDOWS.join(", ")}, received ${JSON.stringify(w.slice(0, 8))}`);
      }
      const bounded = Math.min(366, Math.max(1, toInt(limit, 30)));
      return [...tables.get("sportsPerformanceSnapshots").values()]
        .filter((r) => r.window === w)
        .sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)))
        .slice(0, bounded)
        .map(performanceSnapshotRow);
    },

    // ── Lottery Intelligence data foundation: mirrors src/db/lottery-repository.js
    // method for method (row 15 slice 1, migration 016), on the sports foundation's
    // rules: rows in legacy's shape, instants canonical, writes idempotent by the
    // unique key (LT-2's VERIFIED guard included), single-process.
    async ensureLotteryGame(code, name, rulesVersion) {
      const gameCode = assertLotteryCode(code);
      const table = tables.get("lotteries");
      const existing = table.get(gameCode);
      if (existing) {
        if (String(existing.rules_version) !== String(rulesVersion)) {
          await mutate("lotteries", "upsert", { ...existing, rules_version: String(rulesVersion), updated_at: nowIso() });
        }
        return lotteryGameRow(table.get(gameCode));
      }
      const now = nowIso();
      const record = {
        id: nextRowId("lotteries"),
        code: gameCode,
        name: String(name).slice(0, 120),
        enabled: 1,
        rules_version: String(rulesVersion).slice(0, 16),
        created_at: now,
        updated_at: now,
      };
      await mutate("lotteries", "upsert", { ...record, replace: false }).catch(() => {});
      return lotteryGameRow(table.get(gameCode));
    },

    async listLotteryGames() {
      return [...tables.get("lotteries").values()]
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0))
        .map(lotteryGameRow);
    },

    async activeLotteryRules(lotteryCode) {
      const code = assertLotteryCode(lotteryCode);
      const rows = [...tables.get("lotteryRules").values()]
        .filter((row) => row.lottery_code === code && toInt(row.active, 1) === 1)
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0));
      return rows.length ? lotteryRulesRow(rows[rows.length - 1]) : null;
    },

    async saveLotteryRules(input) {
      const i = input && typeof input === "object" ? input : {};
      const now = nowIso();
      const record = {
        id: nextRowId("lotteryRules"),
        lottery_code: assertLotteryCode(i.lotteryCode),
        version: String(i.version ?? "").slice(0, 16),
        main_count: toInt(i.mainCount, 0),
        main_min: toInt(i.mainMin, 0),
        main_max: toInt(i.mainMax, 0),
        star_count: toInt(i.starCount, 0),
        star_min: toInt(i.starMin, 0),
        star_max: toInt(i.starMax, 0),
        schedule: String(i.schedule ?? ""),
        active: i.active ? 1 : 0,
        created_at: now,
      };
      await mutate("lotteryRules", "upsert", record);
      return record.id;
    },

    async ensureLotteryProvider(code, name) {
      const providerCode = String(code ?? "").trim().slice(0, 64);
      if (!providerCode) throw new TypeError("provider_code must be 1-64 characters");
      const table = tables.get("lotteryProviders");
      const existing = table.get(providerCode);
      if (existing) return lotteryProviderRow(existing);
      const now = nowIso();
      const record = {
        id: nextRowId("lotteryProviders"),
        provider_code: providerCode,
        display_name: String(name ?? "").trim().slice(0, 120),
        enabled: 0,
        synthetic: providerCode.includes("sandbox") ? 1 : 0,
        created_at: now,
        updated_at: now,
      };
      try {
        await mutate("lotteryProviders", "upsert", { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
      }
      return lotteryProviderRow(table.get(providerCode) ?? null);
    },

    async listLotteryProviders(enabledOnly = false) {
      return [...tables.get("lotteryProviders").values()]
        .filter((row) => !enabledOnly || toInt(row.enabled, 0) === 1)
        .sort((a, b) => toInt(a.id, 0) - toInt(b.id, 0))
        .map(lotteryProviderRow);
    },

    async saveLotteryHealth(providerId, health) {
      const h = health && typeof health === "object" ? health : {};
      const record = {
        id: nextRowId("lotteryHealth"),
        provider_id: assertRowId(providerId, "provider_id"),
        status: String(h.status ?? "").trim().slice(0, 32) || "UNKNOWN",
        response_ms: h.responseMs === null || h.responseMs === undefined ? null : toInt(h.responseMs, 0),
        records_received: toInt(h.recordsReceived, 0),
        invalid_records: toInt(h.invalidRecords, 0),
        error_rate: h.errorRate === null || h.errorRate === undefined ? null : Number(h.errorRate),
        last_success_at: h.lastSuccessAt ?? null,
        last_failure_at: h.lastFailureAt ?? null,
        last_draw_retrieved: h.lastDrawRetrieved === null || h.lastDrawRetrieved === undefined ? null : assertDrawDate(h.lastDrawRetrieved),
        data_freshness_seconds: h.dataFreshnessSeconds === null || h.dataFreshnessSeconds === undefined ? null : toInt(h.dataFreshnessSeconds, 0),
        synthetic: h.synthetic ? 1 : 0,
        // Stamped here, as the SQL adapter does: this is when THIS PLATFORM saw the report.
        observed_at: nowIso(),
      };
      await mutate("lotteryHealth", "upsert", record);
    },

    async latestLotteryHealth(providerId) {
      const id = assertRowId(providerId, "provider_id");
      const rows = [...tables.get("lotteryHealth").values()]
        .filter((row) => toInt(row.provider_id) === id)
        .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || toInt(b.id, 0) - toInt(a.id, 0));
      return rows.length ? lotteryHealthRow(rows[0]) : null;
    },

    async listLotteryHealth(providerId, limit = 20) {
      const id = assertRowId(providerId, "provider_id");
      const bounded = Math.min(200, Math.max(1, toInt(limit, 20)));
      return [...tables.get("lotteryHealth").values()]
        .filter((row) => toInt(row.provider_id) === id)
        .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(lotteryHealthRow);
    },

    async findLotteryDraw(id) {
      const drawId = assertRowId(id, "draw id");
      const row = [...tables.get("lotteryDraws").values()].find((entry) => toInt(entry.id) === drawId);
      return lotteryDrawRow(row ?? null);
    },

    async findLotteryDrawByExternal(lotteryCode, externalId) {
      const key = `${assertLotteryCode(lotteryCode)}:${String(externalId ?? "").slice(0, 64)}`;
      const row = tables.get("lotteryDraws").get(key);
      return lotteryDrawRow(row ?? null);
    },

    async listLotteryDraws(filter = {}, limit = 100, order = "DESC") {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(100_000, Math.max(1, toInt(limit, 100)));
      const lotteryCode = f.lotteryCode ? assertLotteryCode(f.lotteryCode) : null;
      const from = f.from ? assertDrawDate(f.from) : null;
      const to = f.to ? assertDrawDate(f.to) : null;
      const verificationStatus = f.verificationStatus ? String(f.verificationStatus).slice(0, 32) : null;
      return [...tables.get("lotteryDraws").values()]
        .filter((row) => (lotteryCode === null ? true : row.lottery_code === lotteryCode))
        .filter((row) => (from === null ? true : String(row.draw_date) >= from))
        .filter((row) => (to === null ? true : String(row.draw_date) <= to))
        .filter((row) => (verificationStatus === null ? true : String(row.verification_status) === verificationStatus))
        .sort((a, b) => (order === "ASC"
          ? String(a.draw_date).localeCompare(String(b.draw_date)) || toInt(a.id, 0) - toInt(b.id, 0)
          : String(b.draw_date).localeCompare(String(a.draw_date)) || toInt(b.id, 0) - toInt(a.id, 0)))
        .slice(0, bounded)
        .map(lotteryDrawRow);
    },

    async saveLotteryDraw(input) {
      const i = input && typeof input === "object" ? input : {};
      const table = tables.get("lotteryDraws");
      const key = `${assertLotteryCode(i.lotteryCode)}:${String(i.externalId ?? "").slice(0, 64)}`;
      const existing = table.get(key);
      const now = nowIso();
      if (existing) {
        // LT-2: an attested draw is not silently rewritten with different numbers.
        const stored = lotteryDrawRow(existing);
        const incoming = i.payload && typeof i.payload === "object" ? i.payload : {};
        const same = JSON.stringify(stored.payload?.main ?? null) === JSON.stringify(incoming.main)
          && JSON.stringify(stored.payload?.stars ?? null) === JSON.stringify(incoming.stars);
        if (String(existing.verification_status) === "VERIFIED" && String(i.verificationStatus) === "VERIFIED" && !same) {
          return { row: stored, created: false, conflict: true };
        }
        await mutate("lotteryDraws", "upsert", {
          ...existing,
          jackpot: i.jackpot ?? null,
          rollover: i.rollover ? 1 : 0,
          source: String(i.source ?? existing.source),
          source_timestamp: String(i.sourceTimestamp ?? existing.source_timestamp),
          retrieved_at: String(i.retrievedAt ?? existing.retrieved_at),
          verification_status: String(i.verificationStatus ?? existing.verification_status),
          payload: JSON.stringify(incoming ?? {}),
          updated_at: now,
        });
        return { row: lotteryDrawRow(table.get(key)), created: false, conflict: false };
      }
      const record = {
        id: nextRowId("lotteryDraws"),
        lottery_code: assertLotteryCode(i.lotteryCode),
        provider_id: i.providerId === null || i.providerId === undefined ? null : toInt(i.providerId, 0),
        external_id: String(i.externalId ?? "").slice(0, 64),
        draw_date: assertDrawDate(i.drawDate),
        jackpot: i.jackpot === null || i.jackpot === undefined || i.jackpot === "" ? null : String(i.jackpot).slice(0, 32),
        rollover: i.rollover ? 1 : 0,
        source: String(i.source ?? "").slice(0, 120),
        source_timestamp: String(i.sourceTimestamp ?? "").slice(0, 40),
        retrieved_at: String(i.retrievedAt ?? now),
        verification_status: LOTTERY_VERIFICATION_STATUSES.includes(String(i.verificationStatus)) ? String(i.verificationStatus) : "UNVERIFIED",
        payload: JSON.stringify(i.payload && typeof i.payload === "object" ? i.payload : {}),
        created_at: now,
        updated_at: now,
      };
      try {
        // Keyed by (lottery, external id): `replace: false` is the idempotency arbiter.
        await mutate("lotteryDraws", "upsert", { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
      }
      return { row: lotteryDrawRow(table.get(key)), created: true, conflict: false };
    },

    async listLotteryDrawNumbers(drawId) {
      const id = assertRowId(drawId, "draw_id");
      return [...tables.get("lotteryDrawNumbers").values()]
        .filter((row) => toInt(row.draw_id) === id)
        .sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || toInt(a.position, 0) - toInt(b.position, 0))
        .map(lotteryDrawNumberRow);
    },

    /** Replace a draw's numbers wholesale — legacy deletes then inserts, and so does this. */
    async saveLotteryDrawNumbers(drawId, numbers) {
      const id = assertRowId(drawId, "draw_id");
      const table = tables.get("lotteryDrawNumbers");
      const doomed = [...table.values()].filter((row) => toInt(row.draw_id) === id);
      // R-30: the replacement is ONE WAL batch — a crash mid-replace used to be
      // able to leave a draw with some of its old numbers and some of its new.
      const changes = doomed.map((row) => ({ entity: "lotteryDrawNumbers", key: keyOf("lotteryDrawNumbers", row), op: "delete", value: null }));
      for (const [field, kind] of [["main", "MAIN"], ["stars", "STAR"]]) {
        const list = Array.isArray(numbers?.[field]) ? numbers[field] : [];
        for (let index = 0; index < list.length; index += 1) {
          const value = Number(list[index]);
          if (!Number.isInteger(value)) throw new TypeError(`draw numbers must be integers, received ${JSON.stringify(String(list[index]).slice(0, 20))}`);
          const recordId = nextRowId("lotteryDrawNumbers");
          changes.push({
            entity: "lotteryDrawNumbers",
            op: "upsert",
            value: { id: recordId, draw_id: id, kind, position: index, number: value },
          });
        }
      }
      await mutateBatch(changes);
    },

    async lotteryDrawsForStats(lotteryCode, limit = 10_000) {
      const rows = await this.listLotteryDraws({ lotteryCode }, limit, "ASC");
      const out = [];
      for (const row of rows) {
        const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
        if (!Array.isArray(payload.main) || !Array.isArray(payload.stars)) continue;
        out.push({
          drawDate: String(row.draw_date),
          main: payload.main.map((value) => Math.trunc(Number(value))),
          stars: payload.stars.map((value) => Math.trunc(Number(value))),
        });
      }
      return out;
    },

    async countLotteryDraws(lotteryCode) {
      return [...tables.get("lotteryDraws").values()].filter((row) => row.lottery_code === assertLotteryCode(lotteryCode)).length;
    },

    async startLotteryJobRun(run) {
      const r = run && typeof run === "object" ? run : {};
      const id = String(r.id ?? "").trim().slice(0, 64);
      const executionKey = String(r.executionKey ?? "").trim().slice(0, 128);
      if (!id) throw new TypeError("id must be a non-empty string");
      if (!executionKey) throw new TypeError("execution_key must be a non-empty string");
      const table = tables.get("lotterySyncRuns");
      if (table.get(executionKey)) return null;
      const record = {
        id,
        provider_id: r.providerId === null || r.providerId === undefined ? null : toInt(r.providerId, 0),
        job_type: String(r.jobType ?? "").trim().slice(0, 40),
        status: "RUNNING",
        started_at: nowIso(),
        ended_at: null,
        records_processed: 0,
        records_created: 0,
        records_updated: 0,
        errors: null,
        payload: r.payload === null || r.payload === undefined ? null : JSON.stringify(r.payload),
        execution_key: executionKey,
      };
      try {
        await mutate("lotterySyncRuns", "upsert", { ...record, replace: false });
      } catch (error) {
        if (!/already exists/i.test(String(error?.message || error))) throw error;
        return null;
      }
      return lotterySyncRunRow(record);
    },

    async finishLotteryJobRun(id, result) {
      const runId = String(id ?? "").trim().slice(0, 64);
      const r = result && typeof result === "object" ? result : {};
      const table = tables.get("lotterySyncRuns");
      const existing = [...table.values()].find((row) => String(row.id) === runId);
      if (!existing) return;
      await mutate("lotterySyncRuns", "upsert", {
        ...existing,
        status: String(r.status ?? "").trim().slice(0, 32) || existing.status,
        ended_at: nowIso(),
        records_processed: toInt(r.processed, 0),
        records_created: toInt(r.created, 0),
        records_updated: toInt(r.updated, 0),
        errors: JSON.stringify(Array.isArray(r.errors) ? r.errors : []),
      });
    },

    async listLotteryJobRuns(jobType = null, limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      return [...tables.get("lotterySyncRuns").values()]
        .filter((row) => (jobType === null || jobType === undefined ? true : String(row.job_type) === String(jobType)))
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map(lotterySyncRunRow);
    },

    async findLotteryJobRunByKey(key) {
      const row = tables.get("lotterySyncRuns").get(String(key ?? "").trim().slice(0, 128));
      return lotterySyncRunRow(row ?? null);
    },

    async deleteOldLotteryJobRuns(cutoff) {
      const boundary = assertIsoCutoff(cutoff);
      const doomed = [...tables.get("lotterySyncRuns").values()].filter((row) => String(row.started_at) < boundary);
      for (const row of doomed) {
        // The job-run table is keyed by EXECUTION KEY (keyOf above), not by id —
        // a delete record carrying `id` alone would name an undefined key and
        // silently prune nothing (found by the slice-5 cleanup test).
        await mutate("lotterySyncRuns", "delete", { execution_key: row.execution_key });
      }
      return doomed.length;
    },

    async deleteOldLotteryHealth(cutoff) {
      const boundary = assertIsoCutoff(cutoff);
      const doomed = [...tables.get("lotteryHealth").values()].filter((row) => String(row.observed_at) < boundary);
      for (const row of doomed) {
        await mutate("lotteryHealth", "delete", { id: row.id });
      }
      return doomed.length;
    },

    // ── combinations + AI decisions (slice 2) ────────────────────────────────
    // Legacy's Aegis_model inserts and re-reads through find* so the JSON columns
    // come back decoded; this adapter does the same via the shared row mappers.

    async saveLotteryCombination(input) {
      const i = input && typeof input === "object" ? input : {};
      const record = prepareLotteryCombination({
        lotteryCode: i.lotteryCode,
        mode: i.mode,
        modelVersion: i.modelVersion,
        seed: i.seed ?? null,
        lineCount: i.lineCount,
        lines: i.lines,
        constraints: i.constraints,
        scoreSummary: i.scoreSummary,
        createdBy: i.createdBy ?? null,
        createdAt: i.createdAt,
      });
      const row = { id: nextRowId("lotteryCombinations"), ...record };
      await mutate("lotteryCombinations", "upsert", row);
      return { row: lotteryCombinationRow(tables.get("lotteryCombinations").get(String(row.id))), created: true };
    },

    async findLotteryCombination(id) {
      const row = tables.get("lotteryCombinations").get(String(assertRowId(id, "id")));
      return lotteryCombinationRow(row ?? null);
    },

    async listLotteryCombinations(limit = 50, offset = 0) {
      const bounded = Math.min(200, Math.max(1, toInt(limit, 50)));
      const safeOffset = Math.max(0, toInt(offset, 0));
      return [...tables.get("lotteryCombinations").values()]
        .sort((a, b) => toInt(b.id, 0) - toInt(a.id, 0))
        .slice(safeOffset, safeOffset + bounded)
        .map((row) => lotteryCombinationRow(row));
    },

    async saveLotteryAiDecision(input) {
      const i = input && typeof input === "object" ? input : {};
      const record = prepareLotteryAiDecision({
        lotteryCode: i.lotteryCode,
        combinationId: i.combinationId ?? null,
        modelVersion: i.modelVersion,
        mode: i.mode ?? null,
        decision: i.decision,
        createdAt: i.createdAt,
      });
      const row = { id: nextRowId("lotteryAiDecisions"), ...record };
      await mutate("lotteryAiDecisions", "upsert", row);
      return { row: lotteryAiDecisionRow(tables.get("lotteryAiDecisions").get(String(row.id))), created: true };
    },

    async findLotteryAiDecision(id) {
      const row = tables.get("lotteryAiDecisions").get(String(assertRowId(id, "id")));
      return lotteryAiDecisionRow(row ?? null);
    },

    async listLotteryAiDecisions(combinationId = null, limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const byCombination = combinationId === null || combinationId === undefined ? null : assertRowId(combinationId, "combination_id");
      return [...tables.get("lotteryAiDecisions").values()]
        .filter((row) => (byCombination === null ? true : toInt(row.combination_id, 0) === byCombination))
        .sort((a, b) => toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map((row) => lotteryAiDecisionRow(row));
    },

    // ── tickets (slice 3) ────────────────────────────────────────────────────
    // A ticket is a record of number lines, never a purchase. User isolation is
    // IN the repository (spec §38): find/list filter by user_id here, so a route
    // cannot leak another user's ticket by forgetting the clause.

    async saveLotteryTicket(input) {
      const i = input && typeof input === "object" ? input : {};
      const record = prepareLotteryTicket({
        userId: i.userId,
        lotteryCode: i.lotteryCode,
        name: i.name,
        drawDate: i.drawDate ?? null,
        generationMethod: i.generationMethod,
        modelVersion: i.modelVersion,
        configuration: i.configuration,
        status: i.status,
        result: i.result ?? null,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      });
      const row = { id: nextRowId("lotteryTickets"), ...record };
      await mutate("lotteryTickets", "upsert", row);
      return { row: lotteryTicketRow(tables.get("lotteryTickets").get(String(row.id))), created: true };
    },

    async findLotteryTicket(id, userId = null) {
      const row = tables.get("lotteryTickets").get(String(assertRowId(id, "id")));
      if (!row) return null;
      if (userId !== null && userId !== undefined && toInt(row.user_id, 0) !== assertRowId(userId, "user_id")) return null;
      return lotteryTicketRow(row);
    },

    async listLotteryTickets(userId, limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const owner = assertRowId(userId, "user_id");
      return [...tables.get("lotteryTickets").values()]
        .filter((row) => toInt(row.user_id, 0) === owner)
        .sort((a, b) => toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(lotteryTicketRow);
    },

    async listAllLotteryTickets(limit = 200) {
      const bounded = Math.min(1000, Math.max(1, toInt(limit, 200)));
      return [...tables.get("lotteryTickets").values()]
        .sort((a, b) => toInt(b.id, 0) - toInt(a.id, 0))
        .slice(0, bounded)
        .map(lotteryTicketRow);
    },

    async updateLotteryTicket(id, patch = {}) {
      // Legacy passes raw column values (the service json_encodes result itself);
      // the adapter merges only the columns the service may legally change.
      const key = String(assertRowId(id, "id"));
      const existing = tables.get("lotteryTickets").get(key);
      if (!existing) return; // legacy: an UPDATE that matches no row is silent
      const next = { ...existing };
      if (patch.status !== undefined) next.status = assertEnum(patch.status, ["OPEN", "CHECKED", "ARCHIVED"], "status");
      if (patch.result !== undefined) next.result = patch.result === null ? null : String(patch.result); // already JSON text from the service
      if (patch.updated_at !== undefined) next.updated_at = assertInstant(patch.updated_at, "updated_at");
      await mutate("lotteryTickets", "upsert", next);
    },

    async listLotteryTicketLines(ticketId) {
      const owner = assertRowId(ticketId, "ticket_id");
      return [...tables.get("lotteryTicketLines").values()]
        .filter((row) => toInt(row.ticket_id, 0) === owner)
        .sort((a, b) => toInt(a.position, 0) - toInt(b.position, 0))
        .map(lotteryTicketLineRow);
    },

    async saveLotteryTicketLines(ticketId, linesIn) {
      // Delete-then-insert, positions AS GIVEN (the draw-numbers rule), each
      // line stamped by the adapter exactly as legacy stamps gmdate('c').
      // R-30: the replacement is ONE WAL batch — a crash mid-replace used to be
      // able to leave a ticket with fewer lines than it was recorded with.
      const owner = assertRowId(ticketId, "ticket_id");
      const table = tables.get("lotteryTicketLines");
      const doomed = [...table.values()].filter((row) => toInt(row.ticket_id, 0) === owner);
      const changes = doomed.map((row) => ({ entity: "lotteryTicketLines", key: keyOf("lotteryTicketLines", row), op: "delete", value: null }));
      const lines = Array.isArray(linesIn) ? linesIn : [];
      for (let position = 0; position < lines.length; position += 1) {
        const line = lines[position] ?? {};
        const record = prepareLotteryTicketLine({
          ticketId: owner,
          position,
          mains: line.mains ?? [],
          stars: line.stars ?? [],
          createdAt: nowIso(),
        });
        const rowId = nextRowId("lotteryTicketLines");
        changes.push({ entity: "lotteryTicketLines", op: "upsert", value: { id: rowId, ...record } });
      }
      await mutateBatch(changes);
      return lines.length;
    },

    // ---- lottery slice 4: backtests + model versions (migration 019) ------
    // A model version is ENSURED: an existing (model_name, model_version) pair
    // returns the existing row decoded, exactly legacy's read-then-insert —
    // historical results stay connected to the model that produced them. Rows
    // are never deleted or replaced on either adapter.
    async ensureLotteryModelVersion(input) {
      const i = input && typeof input === "object" ? input : {};
      const modelName = assertText(i.modelName, 64, "model_name");
      const modelVersion = assertText(i.modelVersion, 16, "model_version");
      const table = tables.get("lotteryModelVersions");
      const existing = [...table.values()].find(
        (row) => row.model_name === modelName && row.model_version === modelVersion,
      );
      if (existing) return lotteryModelVersionRow(existing);
      const record = prepareLotteryModelVersion({
        modelName,
        modelVersion,
        config: i.config,
        datasetVersion: i.datasetVersion ?? null,
        status: i.status,
        createdAt: i.createdAt,
      });
      const row = { id: nextRowId("lotteryModelVersions"), ...record };
      await mutate("lotteryModelVersions", "upsert", row);
      return lotteryModelVersionRow(table.get(String(row.id)));
    },
    async listLotteryModelVersions() {
      // Oldest first (spec §33: versions accumulate, newest is not "current").
      return [...tables.get("lotteryModelVersions").values()]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map(lotteryModelVersionRow);
    },
    async saveLotteryBacktest(input) {
      const i = input && typeof input === "object" ? input : {};
      const record = prepareLotteryBacktest({
        lotteryCode: i.lotteryCode,
        strategy: i.strategy,
        modelVersion: i.modelVersion,
        linesPerDraw: i.linesPerDraw,
        drawsTested: i.drawsTested,
        periodFrom: i.periodFrom ?? null,
        periodTo: i.periodTo ?? null,
        datasetVersion: i.datasetVersion ?? null,
        report: i.report,
        createdAt: i.createdAt,
      });
      const row = { id: nextRowId("lotteryBacktests"), ...record };
      await mutate("lotteryBacktests", "upsert", row);
      return { row: lotteryBacktestRow(tables.get("lotteryBacktests").get(String(row.id))), created: true };
    },
    async findLotteryBacktest(id) {
      const row = tables.get("lotteryBacktests").get(String(assertRowId(id, "id")));
      return lotteryBacktestRow(row);
    },
    async listLotteryBacktests(limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      return [...tables.get("lotteryBacktests").values()]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, bounded)
        .map(lotteryBacktestRow);
    },

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
    /**
     * Mirrors `account-repository.js` filter for filter, including the `actor`
     * vocabulary (`"system"` = no actor, `"any"` = no filter, a number = that
     * user) and the actor projection. The file adapter has no join, so the
     * username is resolved from the users table; a missing user yields null
     * exactly as the LEFT JOIN does, never a substituted label.
     */
    async listAuditEvents({ userId = null, actor = null, limit = 50, offset = 0, action = null, entityType = null, entityId = null, from = null, to = null, sort = "createdAt", direction = "desc" } = {}) {
      const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
      const boundedOffset = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), 1_000_000);
      let rows = [...tables.get("audit").values()];
      if (userId !== null) rows = rows.filter((row) => String(row.actor_user_id) === String(userId));
      if (actor !== null && actor !== undefined && actor !== "any") {
        rows = actor === "system"
          ? rows.filter((row) => row.actor_user_id === null || row.actor_user_id === undefined)
          : rows.filter((row) => String(row.actor_user_id) === String(actor));
      }
      if (action) rows = rows.filter((row) => row.action_key === action || row.action_key.startsWith(`${action}.`));
      if (entityType) rows = rows.filter((row) => row.entity_type === String(entityType));
      if (entityId !== null && entityId !== undefined && entityId !== "") rows = rows.filter((row) => String(row.entity_id ?? "") === String(entityId));
      if (from) rows = rows.filter((row) => Date.parse(row.created_at) >= Date.parse(from));
      if (to) rows = rows.filter((row) => Date.parse(row.created_at) <= Date.parse(to));

      const descending = String(direction).toLowerCase() !== "asc";
      const by = sort === "id" ? "id" : sort === "action" ? "action" : "createdAt";
      rows.sort((a, b) => {
        const left = by === "id" ? Number(a.id) - Number(b.id)
          : by === "action" ? String(a.action_key).localeCompare(String(b.action_key))
            : String(a.created_at).localeCompare(String(b.created_at));
        if (left !== 0) return descending ? -left : left;
        // A stable tie-break on id, matching the SQL `ORDER BY … , id DESC`.
        return descending ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id);
      });

      const users = tables.get("users");
      const usernameOf = (id) => {
        const user = id === null || id === undefined ? null : users.get(String(id));
        return user ? user.username : null;
      };
      const total = rows.length;
      return {
        total,
        events: rows.slice(boundedOffset, boundedOffset + boundedLimit).map((row) => ({
          id: row.id,
          action: row.action_key,
          entityType: row.entity_type,
          entityId: row.entity_id,
          details: row.detail_json,
          createdAt: row.created_at,
          actor: row.actor_user_id === null || row.actor_user_id === undefined
            ? { userId: null, username: null, kind: "system" }
            : { userId: Number(row.actor_user_id), username: usernameOf(row.actor_user_id), kind: "user" },
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
    // Execution proposal reads are always owner-bound and independently verify
    // the current paper-account owner, matching the MySQL join predicates.
    async findExecutionProposal(id, ownerUserId) {
      const row = tables.get("executionProposals").get(String(id));
      const account = row ? tables.get("paperAccounts").get(String(row.account_id)) : null;
      if (!row || !account || String(row.owner_user_id) !== String(ownerUserId)
        || String(account.owner_user_id) !== String(ownerUserId)) return null;
      return structuredClone(row);
    },
    async listExecutionProposals(ownerUserId, { status = null, limit = 100 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      return [...tables.get("executionProposals").values()]
        .filter((row) => {
          const account = tables.get("paperAccounts").get(String(row.account_id));
          return String(row.owner_user_id) === String(ownerUserId)
            && account && String(account.owner_user_id) === String(ownerUserId)
            && (!status || row.status === String(status));
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
        .slice(0, bounded)
        .map((row) => structuredClone(row));
    },
    /**
     * Every pending proposal across **all** owners, for the scheduled expiry job.
     *
     * The SQL adapter orders oldest-first so a bounded batch drains the backlog in
     * the order it accrued; this mirrors that exactly, because a job that expired
     * the newest proposals first would leave the oldest ones pending forever once
     * the batch limit was reached.
     */
    async listExecutionProposalsAllOwners({ status = null, limit = 100 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      return [...tables.get("executionProposals").values()]
        .filter((row) => !status || row.status === String(status))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
        .slice(0, bounded)
        .map((row) => structuredClone(row));
    },
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

    // ---- operator notifications (row 5) ---------------------------------
    /**
     * Visibility and read state follow `notification-repository.js` exactly:
     * `user_id === null` is a broadcast, `read_at` is global to the row, and the
     * dedupe check is global rather than per recipient.
     */
    async createNotification({ userId = null, type, severity, title, detail = {}, dedupeKey = null, createdAt }) {
      const id = nextId("notifications");
      const record = {
        id,
        user_id: userId === null || userId === undefined ? null : Number(userId),
        type: String(type),
        severity: String(severity),
        title: String(title),
        detail: detail && typeof detail === "object" ? structuredClone(detail) : {},
        dedupe_key: dedupeKey === null || dedupeKey === undefined ? null : String(dedupeKey),
        read_at: null,
        created_at: String(createdAt),
      };
      await mutate("notifications", "upsert", record);
      return structuredClone(record);
    },
    async listNotifications(userId = null, { unreadOnly = false, limit = 50 } = {}) {
      const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
      return [...tables.get("notifications").values()]
        .filter((row) => (userId === null || userId === undefined ? row.user_id === null : row.user_id === null || Number(row.user_id) === Number(userId)))
        .filter((row) => (unreadOnly ? row.read_at === null : true))
        .sort((a, b) => (String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id)))
        .slice(0, bounded)
        .map((row) => structuredClone(row));
    },
    async markNotificationRead(id, userId = null, readAt) {
      const row = tables.get("notifications").get(String(id));
      if (!row || row.read_at !== null) return false;
      if (!visibleTo(row, userId)) return false;
      await mutate("notifications", "upsert", { ...row, read_at: String(readAt) });
      return true;
    },
    async markAllNotificationsRead(userId = null, readAt) {
      let marked = 0;
      for (const row of [...tables.get("notifications").values()]) {
        if (row.read_at !== null || !visibleTo(row, userId)) continue;
        await mutate("notifications", "upsert", { ...row, read_at: String(readAt) });
        marked += 1;
      }
      return marked;
    },
    async countUnreadNotifications(userId = null) {
      return [...tables.get("notifications").values()]
        .filter((row) => row.read_at === null && visibleTo(row, userId))
        .length;
    },
    async hasUnreadNotificationDedupe(dedupeKey) {
      const key = String(dedupeKey);
      return [...tables.get("notifications").values()]
        .some((row) => row.dedupe_key === key && row.read_at === null);
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
