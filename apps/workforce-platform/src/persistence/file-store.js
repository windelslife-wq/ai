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
import { createHash } from "node:crypto";
import path from "node:path";

const ENTITIES = ["users", "profiles", "sessions", "roles", "permissions", "userRoles", "rolePermissions", "audit", "inquiries", "analysisRuns"];
const COMPACTION_ENTRIES = 2_000;
const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

function keyOf(entity, record) {
  if (entity === "sessions") return record.tokenHash;
  if (entity === "userRoles") return `${record.userId}:${record.roleId}`;
  if (entity === "rolePermissions") return `${record.roleId}:${record.permissionId}`;
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

  async function persist(entry) {
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
    if (appendCount >= COMPACTION_ENTRIES) await compact();
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

  async function mutate(entity, op, record) {
    const key = keyOf(entity, record);
    const run = async () => {
      const table = tables.get(entity);
      const value = op === "delete" ? null : record;
      if (op === "upsert" && table.has(key) && record.replace === false) throw new Error("Already exists");
      apply({ entity, key, op, value: value ? sanitize(value) : undefined }, { persist: false });
      await persist({ entity, key, op, value: op === "delete" ? null : sanitize(record) });
    };
    queue = queue.then(run, run);
    return queue;
  }

  function sanitize(value) {
    const { replace, ...rest } = value;
    return rest;
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
