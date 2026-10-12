/**
 * MySQL/MariaDB repository for the lottery data foundation (row 15, slice 1).
 *
 * Migration `016_lottery_foundation.sql` explains the schema; this file is the only
 * thing that writes it. It ports the lottery half of the anonymous class in
 * `application/models/Aegis_model.php` (lines 314–509), the concrete
 * `Aegis\Persistence\LotteryRepository` — whose signatures live in
 * `Persistence/Repositories.php`, so the behaviour is easy to miss when reading the
 * persistence namespace.
 *
 * The three sports-repository conventions apply here unmodified, for the same
 * reasons (rows in legacy's snake_case shape with JSON decoded; timestamps in
 * canonical UTC, divergence LT-1; writes idempotent by unique key). One more is
 * lottery-specific:
 *
 *  4. **A stored draw can only be corrected, never silently overwritten.**
 *     `saveLotteryDraw` reproduces legacy's split: an existing draw whose numbers
 *     match is a no-op, a VERIFIED draw with differing numbers is refused to the
 *     caller (the facade audits `LOTTERY_RESULT_CONFLICT` and moves on), and only an
 *     unverified draw may be patched. The repository returns `{row, created}` and
 *     lets the facade own the policy, exactly as legacy's does — but the VERIFIED
 *     guard itself lives here, because a second writer that skipped the facade
 *     would otherwise have nothing standing between it and an attested row.
 *
 * Nothing in this file purchases, wagers or pays out anything. It stores published
 * lottery results and the evidence of how they were obtained.
 */

import { assertIsoCutoff } from "../persistence/contract.js";
import {
  assertDrawDate,
  assertLotteryCode,
  lotteryDrawNumberRow,
  lotteryDrawRow,
  lotteryGameRow,
  lotteryHealthRow,
  lotteryProviderRow,
  lotteryRulesRow,
  lotterySyncRunRow,
  prepareLotteryDraw,
} from "../persistence/lottery-rows.js";
import {
  assertRowId,
  assertText,
  optionalRowId,
} from "../persistence/sports-rows.js";

/**
 * Legacy's integer-bound idiom, ported exactly: `min(CAP, max(1, (int) $limit))`.
 * PHP's `(int)` cast sends null/NaN/non-numeric to 0, which the `max(1, …)` then
 * raises to 1 — so a nonsense limit reads ONE row, never the unbounded table. The
 * JavaScript default parameter only covers `undefined`, legacy's own default.
 */
function legacyLimit(value, fallback, cap) {
  if (value === undefined) return Math.min(cap, Math.max(1, fallback));
  const parsed = Math.trunc(Number(value));
  return Math.min(cap, Math.max(1, Number.isNaN(parsed) ? 0 : parsed));
}

function canonicalNow() {
  return new Date().toISOString();
}

const numberToInt = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`draw numbers must be integers, received ${JSON.stringify(String(value).slice(0, 20))}`);
  return n;
};

export function createLotteryRepository(executor) {
  const repo = {
    // ── the game and its rules ─────────────────────────────────────────────────

    /**
     * The one row per lottery code this platform tracks, ensured idempotently —
     * legacy's constructor calls this on every boot, so a rules-version bump is an
     * UPDATE here and nowhere else.
     */
    async ensureLotteryGame(code, name, rulesVersion) {
      const gameCode = assertLotteryCode(code);
      const gameName = assertText(name, 120, "name");
      const version = assertText(rulesVersion, 16, "rules_version");
      const [existing] = await executor.query(
        `SELECT * FROM wf_lotteries WHERE code = ? LIMIT 1`,
        [gameCode],
      );
      if (existing && existing.length > 0) {
        const row = existing[0];
        if (String(row.rules_version) !== version) {
          await executor.execute(
            `UPDATE wf_lotteries SET rules_version = ?, updated_at = ? WHERE id = ?`,
            [version, canonicalNow(), assertRowId(row.id, "id")],
          );
          const [refreshed] = await executor.query(`SELECT * FROM wf_lotteries WHERE id = ? LIMIT 1`, [row.id]);
          return lotteryGameRow(refreshed[0]);
        }
        return lotteryGameRow(row);
      }
      const now = canonicalNow();
      await executor.execute(
        `INSERT INTO wf_lotteries (code, name, enabled, rules_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`,
        [gameCode, gameName, version, now, now],
      );
      const [created] = await executor.query(`SELECT * FROM wf_lotteries WHERE code = ? LIMIT 1`, [gameCode]);
      return lotteryGameRow(created[0]);
    },

    async listLotteryGames() {
      const [rows] = await executor.query(`SELECT * FROM wf_lotteries ORDER BY id ASC`, []);
      return (rows ?? []).map(lotteryGameRow);
    },

    /** The newest active stored rules row for a code, or null (the code default is authoritative). */
    async activeLotteryRules(lotteryCode) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_rules WHERE lottery_code = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
        [assertLotteryCode(lotteryCode)],
      );
      return lotteryRulesRow(rows?.[0] ?? null);
    },

    async saveLotteryRules(input) {
      const now = canonicalNow();
      const row = {
        lottery_code: assertLotteryCode(input.lotteryCode),
        version: assertText(input.version, 16, "version"),
        main_count: Math.trunc(Number(input.mainCount)),
        main_min: Math.trunc(Number(input.mainMin)),
        main_max: Math.trunc(Number(input.mainMax)),
        star_count: Math.trunc(Number(input.starCount)),
        star_min: Math.trunc(Number(input.starMin)),
        star_max: Math.trunc(Number(input.starMax)),
        schedule: assertText(input.schedule, 65535, "schedule"),
        active: input.active ? 1 : 0,
        created_at: now,
      };
      const [result] = await executor.execute(
        `INSERT INTO wf_lottery_rules
           (lottery_code, version, main_count, main_min, main_max, star_count, star_min, star_max, schedule, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.lottery_code, row.version, row.main_count, row.main_min, row.main_max, row.star_count, row.star_min, row.star_max, row.schedule, row.active, now],
      );
      return Number(result?.insertId ?? 0);
    },

    // ── providers and their health ─────────────────────────────────────────────

    /**
     * The provider registry row, ensured on first sight and created **disabled**:
     * naming a provider in a sync is evidence, not approval — the same rule the
     * sports foundation set in migration 011.
     */
    async ensureLotteryProvider(code, name) {
      const providerCode = assertText(code, 64, "provider_code");
      const displayName = assertText(name, 120, "display_name");
      const [existing] = await executor.query(
        `SELECT * FROM wf_lottery_data_sources WHERE provider_code = ? LIMIT 1`,
        [providerCode],
      );
      if (existing && existing.length > 0) return lotteryProviderRow(existing[0]);
      const now = canonicalNow();
      const synthetic = providerCode.includes("sandbox") ? 1 : 0;
      await executor.execute(
        `INSERT INTO wf_lottery_data_sources (provider_code, display_name, enabled, synthetic, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
        [providerCode, displayName, synthetic, now, now],
      );
      const [created] = await executor.query(`SELECT * FROM wf_lottery_data_sources WHERE provider_code = ? LIMIT 1`, [providerCode]);
      return lotteryProviderRow(created[0]);
    },

    async listLotteryProviders(enabledOnly = false) {
      const sql = enabledOnly
        ? `SELECT * FROM wf_lottery_data_sources WHERE enabled = 1 ORDER BY id ASC`
        : `SELECT * FROM wf_lottery_data_sources ORDER BY id ASC`;
      const [rows] = await executor.query(sql, []);
      return (rows ?? []).map(lotteryProviderRow);
    },

    /** Append one health observation. Append-only, exactly as the sports foundation argues. */
    async saveLotteryHealth(providerId, health) {
      const now = canonicalNow();
      const h = health && typeof health === "object" ? health : {};
      await executor.execute(
        `INSERT INTO wf_lottery_provider_health (
           provider_id, status, response_ms, records_received, invalid_records,
           error_rate, last_success_at, last_failure_at, last_draw_retrieved,
           data_freshness_seconds, synthetic, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assertRowId(providerId, "provider_id"),
          assertText(h.status, 32, "health status"),
          h.responseMs === null || h.responseMs === undefined ? null : Math.trunc(Number(h.responseMs)),
          Math.max(0, Math.trunc(Number(h.recordsReceived ?? 0))),
          Math.max(0, Math.trunc(Number(h.invalidRecords ?? 0))),
          h.errorRate === null || h.errorRate === undefined ? null : Number(h.errorRate),
          h.lastSuccessAt ?? null,
          h.lastFailureAt ?? null,
          h.lastDrawRetrieved === null || h.lastDrawRetrieved === undefined ? null : assertDrawDate(h.lastDrawRetrieved),
          h.dataFreshnessSeconds === null || h.dataFreshnessSeconds === undefined ? null : Math.trunc(Number(h.dataFreshnessSeconds)),
          h.synthetic ? 1 : 0,
          now,
        ],
      );
    },

    async latestLotteryHealth(providerId) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_provider_health WHERE provider_id = ? ORDER BY observed_at DESC LIMIT 1`,
        [assertRowId(providerId, "provider_id")],
      );
      return lotteryHealthRow(rows?.[0] ?? null);
    },

    async listLotteryHealth(providerId, limit = 20) {
      const bounded = legacyLimit(limit, 20, 200);
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_provider_health WHERE provider_id = ? ORDER BY observed_at DESC LIMIT ${bounded}`,
        [assertRowId(providerId, "provider_id")],
      );
      return (rows ?? []).map(lotteryHealthRow);
    },

    // ── draws ──────────────────────────────────────────────────────────────────

    async findLotteryDraw(id) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_draws WHERE id = ? LIMIT 1`,
        [assertRowId(id, "id")],
      );
      return lotteryDrawRow(rows?.[0] ?? null);
    },

    async findLotteryDrawByExternal(lotteryCode, externalId) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_draws WHERE lottery_code = ? AND external_id = ? LIMIT 1`,
        [assertLotteryCode(lotteryCode), assertText(externalId, 64, "external_id")],
      );
      return lotteryDrawRow(rows?.[0] ?? null);
    },

    async listLotteryDraws(filter = {}, limit = 100, order = "DESC") {
      const where = [];
      const values = [];
      if (filter.lotteryCode) {
        where.push("lottery_code = ?");
        values.push(assertLotteryCode(filter.lotteryCode));
      }
      if (filter.from) {
        where.push("draw_date >= ?");
        values.push(assertDrawDate(filter.from));
      }
      if (filter.to) {
        where.push("draw_date <= ?");
        values.push(assertDrawDate(filter.to));
      }
      if (filter.verificationStatus) {
        where.push("verification_status = ?");
        values.push(assertText(filter.verificationStatus, 32, "verification_status"));
      }
      const bounded = legacyLimit(limit, 100, 100_000);
      const direction = order === "ASC" ? "ASC" : "DESC";
      const sql = `SELECT * FROM wf_lottery_draws
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY draw_date ${direction}
         LIMIT ${bounded}`;
      const [rows] = await executor.query(sql, values);
      return (rows ?? []).map(lotteryDrawRow);
    },

    /**
     * Insert-or-correct one draw; returns `{row, created}`. The numbers comparison
     * the facade needs is `payload.main`/`payload.stars` equality, which is the
     * caller's job — but a VERIFIED row is never handed a differing patch: the
     * second writer's `verificationStatus` says VERIFIED while the stored one is
     * VERIFIED and the payloads differ is exactly the conflict legacy audits
     * instead of writing, so this method refuses it with the same outcome.
     */
    async saveLotteryDraw(input) {
      const now = canonicalNow();
      const prepared = prepareLotteryDraw({ ...input, now });
      const [existingRows] = await executor.query(
        `SELECT * FROM wf_lottery_draws WHERE lottery_code = ? AND external_id = ? LIMIT 1`,
        [prepared.lottery_code, prepared.external_id],
      );
      const existing = existingRows?.[0];
      if (existing) {
        if (String(existing.verification_status) === "VERIFIED" && prepared.verification_status === "VERIFIED") {
          // LT-2: the repository-level VERIFIED guard. Legacy's policy lived only in
          // the facade (`importDraws` audits a conflict and never calls saveDraw);
          // the guard is repeated here so a second writer that skips the facade has
          // the same floor: an attested draw is not silently rewritten with
          // different numbers. Identical numbers still fall through to the patch.
          const stored = lotteryDrawRow(existing);
          const incoming = JSON.parse(prepared.payload);
          const same = JSON.stringify(stored.payload?.main ?? null) === JSON.stringify(incoming.main)
            && JSON.stringify(stored.payload?.stars ?? null) === JSON.stringify(incoming.stars);
          if (!same) {
            return { row: stored, created: false, conflict: true };
          }
        }
        await executor.execute(
          `UPDATE wf_lottery_draws SET jackpot = ?, rollover = ?, source = ?, source_timestamp = ?, retrieved_at = ?, verification_status = ?, payload = ?, updated_at = ? WHERE id = ?`,
          [prepared.jackpot, prepared.rollover, prepared.source, prepared.source_timestamp, prepared.retrieved_at, prepared.verification_status, prepared.payload, now, assertRowId(existing.id, "id")],
        );
        return { row: await this.findLotteryDraw(existing.id), created: false, conflict: false };
      }
      const [result] = await executor.execute(
        `INSERT INTO wf_lottery_draws (
           lottery_code, provider_id, external_id, draw_date, jackpot, rollover, source,
           source_timestamp, retrieved_at, verification_status, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          prepared.lottery_code, prepared.provider_id, prepared.external_id, prepared.draw_date,
          prepared.jackpot, prepared.rollover, prepared.source, prepared.source_timestamp,
          prepared.retrieved_at, prepared.verification_status, prepared.payload, now, now,
        ],
      );
      return { row: await this.findLotteryDraw(result?.insertId), created: true, conflict: false };
    },

    async listLotteryDrawNumbers(drawId) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_draw_numbers WHERE draw_id = ? ORDER BY kind ASC, position ASC`,
        [assertRowId(drawId, "draw_id")],
      );
      return (rows ?? []).map(lotteryDrawNumberRow);
    },

    /** Replace a draw's numbers wholesale — legacy deletes then inserts, and so does this. */
    async saveLotteryDrawNumbers(drawId, numbers) {
      const id = assertRowId(drawId, "draw_id");
      await executor.execute(`DELETE FROM wf_lottery_draw_numbers WHERE draw_id = ?`, [id]);
      for (const [field, kind] of [["main", "MAIN"], ["stars", "STAR"]]) {
        const list = Array.isArray(numbers?.[field]) ? numbers[field] : [];
        for (let index = 0; index < list.length; index += 1) {
          await executor.execute(
            `INSERT INTO wf_lottery_draw_numbers (draw_id, kind, position, number) VALUES (?, ?, ?, ?)`,
            [id, kind, index, numberToInt(list[index])],
          );
        }
      }
    },

    /** The statistics input: oldest first, numbers only, draws with unparseable payloads skipped. */
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
      const [rows] = await executor.query(
        `SELECT COUNT(*) AS total FROM wf_lottery_draws WHERE lottery_code = ?`,
        [assertLotteryCode(lotteryCode)],
      );
      return Number(rows?.[0]?.total ?? 0);
    },

    // ── sync runs ──────────────────────────────────────────────────────────────

    /**
     * Claim a run by execution key; null when the key exists. The sports
     * foundation's SP-12 lesson applied from the start: the check-then-insert is
     * kept for the null answer's sake, and `uq_..._execution_key` arbitrates the
     * race a check cannot.
     */
    async startLotteryJobRun(run) {
      const input = run && typeof run === "object" ? run : {};
      const executionKey = assertText(input.executionKey, 128, "execution_key");
      const [existing] = await executor.query(
        `SELECT id FROM wf_lottery_sync_runs WHERE execution_key = ? LIMIT 1`,
        [executionKey],
      );
      if (existing && existing.length > 0) return null;
      const now = canonicalNow();
      const id = assertText(input.id, 64, "id");
      try {
        await executor.execute(
          `INSERT INTO wf_lottery_sync_runs (id, provider_id, job_type, status, started_at, payload, execution_key) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`,
          [
            id,
            optionalRowId(input.providerId, "provider_id"),
            assertText(input.jobType, 40, "job_type"),
            now,
            input.payload === null || input.payload === undefined ? null : JSON.stringify(input.payload),
            executionKey,
          ],
        );
      } catch (error) {
        if (String(error?.code ?? "").includes("ER_DUP_ENTRY") || /duplicate/i.test(String(error?.message ?? ""))) {
          return null;
        }
        throw error;
      }
      return { ...input, id, executionKey };
    },

    async finishLotteryJobRun(id, result) {
      const r = result && typeof result === "object" ? result : {};
      await executor.execute(
        `UPDATE wf_lottery_sync_runs SET status = ?, ended_at = ?, records_processed = ?, records_created = ?, records_updated = ?, errors = ? WHERE id = ?`,
        [
          assertText(r.status, 32, "status"),
          canonicalNow(),
          Math.max(0, Math.trunc(Number(r.processed ?? 0))),
          Math.max(0, Math.trunc(Number(r.created ?? 0))),
          Math.max(0, Math.trunc(Number(r.updated ?? 0))),
          JSON.stringify(r.errors ?? []),
          assertText(id, 64, "id"),
        ],
      );
    },

    async listLotteryJobRuns(jobType = null, limit = 50) {
      const bounded = legacyLimit(limit, 50, 500);
      const where = jobType !== null && jobType !== undefined ? `WHERE job_type = ?` : "";
      const values = jobType !== null && jobType !== undefined ? [assertText(jobType, 40, "job_type")] : [];
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_sync_runs ${where} ORDER BY started_at DESC LIMIT ${bounded}`,
        values,
      );
      return (rows ?? []).map(lotterySyncRunRow);
    },

    async findLotteryJobRunByKey(key) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_lottery_sync_runs WHERE execution_key = ? LIMIT 1`,
        [assertText(key, 128, "execution_key")],
      );
      return lotterySyncRunRow(rows?.[0] ?? null);
    },

    async deleteOldLotteryJobRuns(cutoff) {
      const [result] = await executor.execute(
        `DELETE FROM wf_lottery_sync_runs WHERE started_at < ?`,
        [assertIsoCutoff(cutoff)],
      );
      return Number(result?.affectedRows ?? 0);
    },

    async deleteOldLotteryHealth(cutoff) {
      const [result] = await executor.execute(
        `DELETE FROM wf_lottery_provider_health WHERE observed_at < ?`,
        [assertIsoCutoff(cutoff)],
      );
      return Number(result?.affectedRows ?? 0);
    },
  };
  return repo;
}

/** The 23 methods this repository adds to the shared store contract (slice 1 of row 15). */
export const LOTTERY_REPOSITORY_METHODS = Object.freeze([
  "ensureLotteryGame",
  "listLotteryGames",
  "activeLotteryRules",
  "saveLotteryRules",
  "ensureLotteryProvider",
  "listLotteryProviders",
  "saveLotteryHealth",
  "latestLotteryHealth",
  "listLotteryHealth",
  "findLotteryDraw",
  "findLotteryDrawByExternal",
  "listLotteryDraws",
  "saveLotteryDraw",
  "listLotteryDrawNumbers",
  "saveLotteryDrawNumbers",
  "lotteryDrawsForStats",
  "countLotteryDraws",
  "startLotteryJobRun",
  "finishLotteryJobRun",
  "listLotteryJobRuns",
  "findLotteryJobRunByKey",
  "deleteOldLotteryJobRuns",
  "deleteOldLotteryHealth",
]);
