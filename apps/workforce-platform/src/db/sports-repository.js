/**
 * MySQL/MariaDB repository for the sports data foundation (row 14, slice 2).
 *
 * Migration `011_sports_foundation.sql` explains the schema; this file is the only
 * thing that writes it. It ports the sports half of the anonymous class in
 * `application/models/Aegis_model.php` (lines 154–332), which is the concrete
 * implementation of the `Aegis\Persistence\SportsRepository` interface — a detail
 * worth recording because the interface file `Persistence/Repositories.php` holds
 * only signatures, so the behaviour lives in a model file where a reader looking at
 * the persistence namespace would not find it.
 *
 * Three conventions, all of which exist so the file adapter in
 * `src/persistence/file-store.js` can implement the *identical* contract:
 *
 *  1. **Rows come back in legacy's shape** — snake_case keys, JSON columns decoded,
 *     exactly what CodeIgniter's `result_array()` plus `json_decode` produced. The
 *     health monitor ported in Phase 15 reads `observed_at`, `started_at` and
 *     `status` off these rows, so re-casing them here would break a class that is
 *     already byte-compared against PHP.
 *  2. **Timestamps go in canonical UTC** (`…Z`). Divergence SP-1: the normalized
 *     payloads keep legacy's `gmdate('c')` `+00:00` shape because they are the
 *     subject of the differential harness, but the *columns* are one shape, because
 *     `listSportsMatches` really does issue `kickoff_at >= ?` as a string comparison and a
 *     table holding two spellings of UTC would order them wrongly. Values are parsed
 *     strictly on the way in — a timestamp that is not a calendar instant is refused
 *     rather than stored, since every column here exists to say when something was
 *     observed.
 *  3. **Writes are idempotent by a unique key, not by a check.** `saveSportsMatch`,
 *     `saveSportsResult` and `ensureSportsProvider` upsert; `startSportsSync` lets
 *     `uq_wf_sports_sync_runs_execution_key` arbitrate and translates the collision
 *     into its `null` return (divergence SP-12 — legacy checked and then inserted
 *     without catching the duplicate-key error, so two concurrent runs of one window
 *     would have had one throw).
 *
 * Nothing in this file places a bet, moves money, or writes to any trading, order or
 * broker table. It stores observed sporting data and the evidence of how it was
 * obtained.
 */

import { assertIsoCutoff } from "../persistence/contract.js";
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
  decodeJson,
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
  toDecimal,
  toInt,
} from "../persistence/sports-rows.js";

/**
 * The current instant, in the one width every sports timestamp column is written in.
 * See `assertInstant` for why the fractional part is never trimmed.
 */
function canonicalNow() {
  return new Date().toISOString();
}

/** Duplicate-key detection, matching the platform's existing convention. */
function isDuplicateKey(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const sqlState = String(error?.sqlState ?? error?.sqlstate ?? "");
  return code === "ER_DUP_ENTRY" || sqlState === "23000" || sqlState === "23505";
}

const SYNC_RUN_COLUMNS = `id, provider_id, job_type, status, started_at, ended_at,
       records_processed, records_created, records_updated, errors, execution_key`;

/**
 * Read one result row.
 *
 * A module-level function rather than a method call, because `src/db/store.js`
 * composes the store by rebinding individual methods onto one flat object — inside
 * such an object `this` is the store, not this repository. A `this.findSportsResult`
 * call would happen to work today (the store also exposes that name) and would break
 * the moment a caller destructured the repository on its own. Sharing the read is
 * also what keeps `saveSportsResult`'s return value identical to what a subsequent
 * `findSportsResult` would report, instead of a reconstruction of it.
 */
async function readSportsResult(executor, matchId, providerId) {
  const [rows] = await executor.query(
    `SELECT id, match_id, provider_id, home_score, away_score, status, verified,
            source_timestamp, verified_at, payload
       FROM wf_sports_results
      WHERE match_id = ? AND provider_id = ?
      LIMIT 1`,
    [assertRowId(matchId, "match_id"), assertRowId(providerId, "provider_id")],
  );
  return resultRow(rows?.[0] ?? null);
}

/**
 * @param {object} executor a MySQL pool or connection wrapper exposing
 *   `query(sql, params)` for reads and `execute(sql, params)` for writes
 */
export function createSportsRepository(executor) {
  return {
    // ── providers ──────────────────────────────────────────────────────────────

    /**
     * Return the provider row for `code`, creating it disabled if it does not exist.
     *
     * Disabled on purpose: a row appears as soon as a sync names a provider, which is
     * not the same as an operator having approved it. `enabled` is that distinction,
     * and it is what lets a vendor be stopped without deleting its history.
     *
     * Legacy does not refresh `display_name` on an existing row, so a renamed vendor
     * keeps its first name. Preserved: renaming here would make the row disagree with
     * the health history attached to it.
     */
    async ensureSportsProvider(code, name) {
      const providerCode = assertProviderCode(code);
      const displayName = assertProviderName(name);
      const [existing] = await executor.query(
        `SELECT id, provider_code, display_name, enabled, created_at, updated_at
           FROM wf_sports_data_sources
          WHERE provider_code = ?
          LIMIT 1`,
        [providerCode],
      );
      if (existing?.[0]) return providerRow(existing[0]);

      const now = canonicalNow();
      try {
        await executor.execute(
          `INSERT INTO wf_sports_data_sources (provider_code, display_name, enabled, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?)`,
          [providerCode, displayName, now, now],
        );
      } catch (error) {
        // The unique key is the arbiter: a concurrent `ensureSportsProvider` for the same
        // vendor wins the insert and this caller reads its row back, which is the same
        // answer either way.
        if (!isDuplicateKey(error)) throw error;
      }
      const [created] = await executor.query(
        `SELECT id, provider_code, display_name, enabled, created_at, updated_at
           FROM wf_sports_data_sources
          WHERE provider_code = ?
          LIMIT 1`,
        [providerCode],
      );
      return providerRow(created?.[0] ?? null);
    },

    /** Ordered by id ascending, so the list is stable across calls. */
    async listSportsProviders(enabledOnly = false) {
      const [rows] = await executor.query(
        enabledOnly
          ? `SELECT id, provider_code, display_name, enabled, created_at, updated_at
               FROM wf_sports_data_sources
              WHERE enabled = 1
              ORDER BY id ASC`
          : `SELECT id, provider_code, display_name, enabled, created_at, updated_at
               FROM wf_sports_data_sources
              ORDER BY id ASC`,
      );
      return rows.map(providerRow);
    },

    async setSportsProviderEnabled(id, enabled) {
      const now = canonicalNow();
      await executor.execute(
        `UPDATE wf_sports_data_sources SET enabled = ?, updated_at = ? WHERE id = ?`,
        [enabled ? 1 : 0, now, assertRowId(id, "provider id")],
      );
    },

    // ── provider health ────────────────────────────────────────────────────────

    /**
     * Append one health observation.
     *
     * Append-only: health is a series of observations, not a current value, so an
     * outage shows up as a gap rather than as an overwritten row. `observed_at` is
     * stamped here rather than taken from the payload — legacy does the same — because
     * the observation time is when *this platform* saw the report, and a provider's own
     * clock is not authoritative for staleness.
     */
    async saveSportsHealth(providerId, health) {
      const h = health && typeof health === "object" ? health : {};
      const now = canonicalNow();
      await executor.execute(
        `INSERT INTO wf_sports_provider_health (
           provider_id, status, response_ms, error_rate, rate_limit_remaining,
           last_success_at, last_failure_at, last_fixture_sync_at, last_odds_sync_at,
           last_result_sync_at, data_freshness_seconds, records_received,
           invalid_records, missing_fields, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assertRowId(providerId, "provider_id"),
          assertEnum(h.status, HEALTH_STATUSES, "health status"),
          h.responseMs === null || h.responseMs === undefined ? null : toInt(h.responseMs),
          h.errorRate === null || h.errorRate === undefined ? null : Number(h.errorRate),
          h.rateLimitRemaining === null || h.rateLimitRemaining === undefined ? null : toInt(h.rateLimitRemaining),
          optionalInstant(h.lastSuccessAt, "lastSuccessAt"),
          optionalInstant(h.lastFailureAt, "lastFailureAt"),
          optionalInstant(h.lastFixtureSyncAt, "lastFixtureSyncAt"),
          optionalInstant(h.lastOddsSyncAt, "lastOddsSyncAt"),
          optionalInstant(h.lastResultSyncAt, "lastResultSyncAt"),
          h.dataFreshnessSeconds === null || h.dataFreshnessSeconds === undefined ? null : toInt(h.dataFreshnessSeconds),
          toInt(h.recordsReceived, 0),
          toInt(h.invalidRecords, 0),
          encodeJson(Array.isArray(h.missingFields) ? h.missingFields : []),
          now,
        ],
      );
    },

    /** The newest observation, or `null` when a provider has never reported. */
    async latestSportsHealth(providerId) {
      const [rows] = await executor.query(
        `SELECT id, provider_id, status, response_ms, error_rate, rate_limit_remaining,
                last_success_at, last_failure_at, last_fixture_sync_at, last_odds_sync_at,
                last_result_sync_at, data_freshness_seconds, records_received,
                invalid_records, missing_fields, observed_at
           FROM wf_sports_provider_health
          WHERE provider_id = ?
          ORDER BY observed_at DESC
          LIMIT 1`,
        [assertRowId(providerId, "provider_id")],
      );
      return healthRow(rows?.[0] ?? null);
    },

    /** Newest-first, bounded to 200 — the monitor reads a window, not the table. */
    async listSportsHealth(providerId, limit = 20) {
      const bounded = Math.min(200, Math.max(1, toInt(limit, 20)));
      const [rows] = await executor.query(
        `SELECT id, provider_id, status, response_ms, error_rate, rate_limit_remaining,
                last_success_at, last_failure_at, last_fixture_sync_at, last_odds_sync_at,
                last_result_sync_at, data_freshness_seconds, records_received,
                invalid_records, missing_fields, observed_at
           FROM wf_sports_provider_health
          WHERE provider_id = ?
          ORDER BY observed_at DESC
          LIMIT ${bounded}`,
        [assertRowId(providerId, "provider_id")],
      );
      return rows.map(healthRow);
    },

    /**
     * Delete health observations older than `cutoff`.
     *
     * Named for the platform's retention convention (`pruneAnalysisRuns`) rather than
     * legacy's `deleteOldHealth`, so a reader scanning the contract for "what can be
     * deleted" finds every such method under one verb. Returns the number of rows
     * removed: a retention run that cannot say how much it reclaimed is not evidence.
     */
    async pruneSportsHealth(cutoff) {
      const [result] = await executor.execute(
        `DELETE FROM wf_sports_provider_health WHERE observed_at < ?`,
        [assertIsoCutoff(cutoff)],
      );
      return Number(result?.affectedRows ?? 0);
    },

    // ── matches ────────────────────────────────────────────────────────────────

    async findSportsMatchById(id) {
      const [rows] = await executor.query(
        `SELECT id, provider_id, external_id, sport, competition, home_team, away_team,
                kickoff_at, status, source_timestamp, payload, created_at, updated_at
           FROM wf_sports_matches
          WHERE id = ?
          LIMIT 1`,
        [assertRowId(id, "match id")],
      );
      return matchRow(rows?.[0] ?? null);
    },

    /**
     * Matches matching `filter`, oldest kickoff first.
     *
     * `filter` keys, all optional: `status` (exact), `from` / `to` (inclusive kickoff
     * bounds), `competition` (**prefix** match — legacy used CodeIgniter's `like(...,
     * 'after')`), `providerId` (exact). An empty or absent key is no constraint.
     *
     * The kickoff bounds are compared as strings, which is chronologically correct
     * because every stored value is a fixed-width canonical UTC instant (migration
     * 011's note on SP-1). They are still parsed on the way in, so `?from=12345` is
     * refused rather than silently producing an empty window that looks like a working
     * filter — defect D-12.
     *
     * Divergence SP-16: `%` and `_` in a competition filter are escaped. Legacy passed
     * the value to `like()` unescaped, so a filter of `"%"` matched every row; that is
     * a read of the same table the caller is already authorized for, so it disclosed
     * nothing, but a prefix filter that behaves as a wildcard is not the filter that
     * was asked for.
     */
    async listSportsMatches(filter = {}, limit = 200) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(1000, Math.max(1, toInt(limit, 200)));
      const clauses = [];
      const params = [];

      if (f.status !== null && f.status !== undefined && String(f.status).trim() !== "") {
        clauses.push("status = ?");
        params.push(assertEnum(f.status, MATCH_STATUSES, "match status"));
      }
      if (f.from !== null && f.from !== undefined && String(f.from).trim() !== "") {
        clauses.push("kickoff_at >= ?");
        params.push(assertInstant(f.from, "filter.from"));
      }
      if (f.to !== null && f.to !== undefined && String(f.to).trim() !== "") {
        clauses.push("kickoff_at <= ?");
        params.push(assertInstant(f.to, "filter.to"));
      }
      if (f.competition !== null && f.competition !== undefined && String(f.competition).trim() !== "") {
        const needle = String(f.competition).replace(/[\\%_]/g, (ch) => `\\${ch}`);
        clauses.push("competition LIKE ?");
        params.push(`${needle}%`);
      }
      if (f.providerId !== null && f.providerId !== undefined && String(f.providerId).trim() !== "") {
        clauses.push("provider_id = ?");
        params.push(assertRowId(f.providerId, "filter.providerId"));
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT id, provider_id, external_id, sport, competition, home_team, away_team,
                kickoff_at, status, source_timestamp, payload, created_at, updated_at
           FROM wf_sports_matches
           ${where}
          ORDER BY kickoff_at ASC
          LIMIT ${bounded}`,
        params,
      );
      return rows.map(matchRow);
    },

    /**
     * Upsert one normalized fixture, keyed by (provider, external id).
     *
     * Returns the row as stored. Divergence SP-13: legacy's insert branch returned
     * `array_merge($data, ['id' => …, 'provider_id' => …, 'external_id' => …])`, which
     * has no `created_at` key — while its update branch returned the existing row,
     * which does. The sync service distinguishes created from updated by testing
     * `!empty($row['created_at']) && $row['created_at'] === $row['updated_at']`, so on
     * the insert path that test could never be true and **every newly stored fixture
     * was counted as an update**: a first sync of twelve fixtures reported
     * `created: 0, updated: 12`. The counters are operator evidence in
     * `wf_sports_sync_runs`, and false evidence is worse than divergent evidence, so
     * this port returns `created_at` on both paths — the value the column really
     * holds. The comparison itself is unchanged.
     */
    async saveSportsMatch(providerId, match) {
      const provider = assertRowId(providerId, "provider_id");
      const m = match && typeof match === "object" ? match : {};
      const externalId = assertText(String(m.externalId ?? "").trim(), 128, "external_id");
      if (!externalId) throw new TypeError("external_id must be 1-128 characters");
      const kickoff = assertInstant(m.kickoff, "match kickoff");
      const now = canonicalNow();

      const data = {
        sport: assertText(String(m.sport ?? ""), 32, "sport"),
        competition: assertText(String(m.competition ?? ""), 160, "competition"),
        home_team: assertText(String(m.homeTeam ?? ""), 160, "home_team"),
        away_team: assertText(String(m.awayTeam ?? ""), 160, "away_team"),
        kickoff_at: kickoff,
        status: assertEnum(m.status, MATCH_STATUSES, "match status"),
        source_timestamp: assertInstant(m.sourceTimestamp, "match sourceTimestamp"),
        payload: encodeJson(m),
        updated_at: now,
      };

      await executor.execute(
        `INSERT INTO wf_sports_matches (
           provider_id, external_id, sport, competition, home_team, away_team,
           kickoff_at, status, source_timestamp, payload, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           sport = VALUES(sport),
           competition = VALUES(competition),
           home_team = VALUES(home_team),
           away_team = VALUES(away_team),
           kickoff_at = VALUES(kickoff_at),
           status = VALUES(status),
           source_timestamp = VALUES(source_timestamp),
           payload = VALUES(payload),
           updated_at = VALUES(updated_at)`,
        [provider, externalId, data.sport, data.competition, data.home_team, data.away_team,
         data.kickoff_at, data.status, data.source_timestamp, data.payload, now, now],
      );

      // Read back rather than reconstruct: the row's identity and `created_at` are
      // exactly the two things the sync counters depend on, and `ON DUPLICATE KEY`
      // does not tell us which branch ran.
      const [rows] = await executor.query(
        `SELECT id, provider_id, external_id, sport, competition, home_team, away_team,
                kickoff_at, status, source_timestamp, payload, created_at, updated_at
           FROM wf_sports_matches
          WHERE provider_id = ? AND external_id = ?
          LIMIT 1`,
        [provider, externalId],
      );
      return matchRow(rows?.[0] ?? null);
    },

    /** The stored row for one provider's fixture, **without** decoding `payload`. */
    async findSportsMatch(providerId, externalId) {
      const [rows] = await executor.query(
        `SELECT id, provider_id, external_id, sport, competition, home_team, away_team,
                kickoff_at, status, source_timestamp, payload, created_at, updated_at
           FROM wf_sports_matches
          WHERE provider_id = ? AND external_id = ?
          LIMIT 1`,
        [assertRowId(providerId, "provider_id"), assertText(String(externalId ?? "").trim(), 128, "external_id")],
      );
      return matchRow(rows?.[0] ?? null);
    },

    // ── odds ───────────────────────────────────────────────────────────────────

    /**
     * Append one odds observation.
     *
     * There is deliberately no unique key on (match, market, selection): each row is an
     * observation at an instant, and overwriting would destroy the point-in-time
     * history `findSportsOddsBefore` exists to answer. Returns the stored row so a sync run can
     * count what it actually wrote.
     */
    async saveSportsOdds(matchId, providerId, odds) {
      const o = odds && typeof odds === "object" ? odds : {};
      const market = assertText(String(o.market ?? ""), 96, "market");
      const selection = assertText(String(o.selection ?? ""), 160, "selection");
      const decimal = Number(o.decimalOdds);
      if (!Number.isFinite(decimal) || decimal <= 1.0) {
        // The normalizer already refused this; asserting again here is what keeps the
        // column's invariant true no matter which caller arrives.
        throw new TypeError(`decimal_odds must be a finite number greater than 1.0, received ${JSON.stringify(o.decimalOdds)}`);
      }
      const observedAt = assertInstant(o.observedAt, "odds observedAt");
      const [result] = await executor.execute(
        `INSERT INTO wf_sports_odds (match_id, provider_id, market, selection, decimal_odds, observed_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [assertRowId(matchId, "match_id"), assertRowId(providerId, "provider_id"),
         market, selection, decimal.toFixed(6), observedAt, encodeJson(o)],
      );
      return oddsRow({
        id: Number(result?.insertId ?? 0) || null,
        match_id: matchId,
        provider_id: providerId,
        market,
        selection,
        decimal_odds: decimal,
        observed_at: observedAt,
        payload: encodeJson(o),
      });
    },

    /**
     * The newest odds row for a match, optionally narrowed to one market/selection.
     *
     * A `null` market or selection is *no constraint* — which is why the two are
     * positional and nullable rather than being folded into a filter object: passing
     * `undefined` and passing `"1X2"` must not mean the same thing.
     */
    async latestSportsOdds(matchId, market = null, selection = null) {
      const clauses = ["match_id = ?"];
      const params = [assertRowId(matchId, "match_id")];
      if (market !== null && market !== undefined) {
        clauses.push("market = ?");
        params.push(assertText(String(market), 96, "market"));
      }
      if (selection !== null && selection !== undefined) {
        clauses.push("selection = ?");
        params.push(assertText(String(selection), 160, "selection"));
      }
      const [rows] = await executor.query(
        `SELECT id, match_id, provider_id, market, selection, decimal_odds, observed_at, payload
           FROM wf_sports_odds
          WHERE ${clauses.join(" AND ")}
          ORDER BY observed_at DESC
          LIMIT 1`,
        params,
      );
      return oddsRow(rows?.[0] ?? null);
    },

    /** Newest-first, bounded to 500. */
    async listSportsOdds(matchId, limit = 50) {
      const bounded = Math.min(500, Math.max(1, toInt(limit, 50)));
      const [rows] = await executor.query(
        `SELECT id, match_id, provider_id, market, selection, decimal_odds, observed_at, payload
           FROM wf_sports_odds
          WHERE match_id = ?
          ORDER BY observed_at DESC
          LIMIT ${bounded}`,
        [assertRowId(matchId, "match_id")],
      );
      return rows.map(oddsRow);
    },

    /**
     * The newest odds observation strictly *before* `timestamp`, or `null`.
     *
     * This is the point-in-time question slice 5's backtester needs: "what did we know
     * then". Legacy compares by **epoch rather than by string** and says so in a
     * comment (`// Timestamps are stored in ISO-8601 …; compare by epoch, not string,
     * so mixed formats can never misorder.`), which is why this implementation reads
     * rows and filters in the application rather than issuing `observed_at < ?`. Both
     * are correct now that every stored value is canonical, but the ported behaviour
     * is preserved so that a row written by an older release — one that may hold
     * `+00:00` — is still ordered correctly rather than silently skipped.
     *
     * An unparseable `timestamp` returns `null` (legacy's `strtotime(...) === false`
     * branch), which is the fail-closed answer: "no odds known before an instant we
     * cannot place" rather than "all odds".
     *
     * Bounded to the newest 500 rows, as legacy is. A match with more than 500
     * observations would have its oldest ones unreachable through this method — that
     * is legacy's bound, kept so the two agree, and recorded rather than quietly
     * widened.
     */
    async findSportsOddsBefore(matchId, timestamp) {
      const id = assertRowId(matchId, "match_id");
      const limitDate = parseStrictInstant(timestamp);
      if (!limitDate) return null;
      const limit = Math.floor(limitDate.getTime() / 1000);

      const [rows] = await executor.query(
        `SELECT id, match_id, provider_id, market, selection, decimal_odds, observed_at, payload
           FROM wf_sports_odds
          WHERE match_id = ?
          ORDER BY observed_at DESC
          LIMIT 500`,
        [id],
      );
      for (const row of rows) {
        const observed = parseStrictInstant(row.observed_at);
        if (observed && Math.floor(observed.getTime() / 1000) < limit) return oddsRow(row);
      }
      return null;
    },

    // ── results ────────────────────────────────────────────────────────────────

    /**
     * Upsert one result, keyed by (match, provider).
     *
     * Divergence SP-14, preserved from legacy: re-ingesting a result **clears**
     * `verified` and `verified_at`. That looks like data loss and is not — a provider
     * that changes a scoreline invalidates the human attestation made about the old
     * one, so the safe direction is to require a human to look again. Settlement and
     * calibration both read the flag rather than trusting ingestion, which is what
     * makes clearing it consequential rather than cosmetic.
     *
     * Scores are nullable and are only ever non-null for `FINISHED`; the result
     * normalizer enforces that before this method is reached, and `NULL` here means
     * "no score was reported", not "0-0".
     */
    async saveSportsResult(matchId, providerId, result) {
      const r = result && typeof result === "object" ? result : {};
      const status = assertEnum(r.status, RESULT_STATUSES, "result status");
      await executor.execute(
        `INSERT INTO wf_sports_results (
           match_id, provider_id, home_score, away_score, status, verified,
           source_timestamp, verified_at, payload
         ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE
           home_score = VALUES(home_score),
           away_score = VALUES(away_score),
           status = VALUES(status),
           verified = 0,
           source_timestamp = VALUES(source_timestamp),
           verified_at = NULL,
           payload = VALUES(payload)`,
        [
          assertRowId(matchId, "match_id"),
          assertRowId(providerId, "provider_id"),
          r.homeScore === null || r.homeScore === undefined ? null : toInt(r.homeScore),
          r.awayScore === null || r.awayScore === undefined ? null : toInt(r.awayScore),
          status,
          assertInstant(r.sourceTimestamp, "result sourceTimestamp"),
          encodeJson(r.payload ?? r),
        ],
      );
      return readSportsResult(executor, matchId, providerId);
    },

    /** The stored result for one (match, provider) pair. */
    async findSportsResult(matchId, providerId) {
      return readSportsResult(executor, matchId, providerId);
    },

    // ── data quality ───────────────────────────────────────────────────────────

    /**
     * Append one quality assessment.
     *
     * Append-only for the same reason as odds: "was this fixture eligible when we
     * acted on it" must stay answerable after the next sync re-scores it. Returns the
     * stored row so the caller can cite the assessment it just made.
     */
    async saveSportsQuality(matchId, assessment) {
      const a = assessment && typeof assessment === "object" ? assessment : {};
      const now = canonicalNow();
      const score = toInt(a.score, 0);
      const band = assertEnum(a.band, ["EXCELLENT", "GOOD", "LIMITED", "REJECT"], "quality band");
      await executor.execute(
        `INSERT INTO wf_sports_data_quality_assessments (
           match_id, score, band, freshness_score, provider_reliability_score,
           eligible_prediction, eligible_ticket, missing_fields, checks_payload, assessed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assertRowId(matchId, "match_id"),
          score,
          band,
          toInt(a.freshnessScore, 0),
          toInt(a.providerReliabilityScore, 0),
          a.eligibleForPrediction ? 1 : 0,
          a.eligibleForTicket ? 1 : 0,
          encodeJson(Array.isArray(a.missing) ? a.missing : []),
          encodeJson(a.checks ?? null),
          now,
        ],
      );
      const [rows] = await executor.query(
        `SELECT id, match_id, score, band, freshness_score, provider_reliability_score,
                eligible_prediction, eligible_ticket, missing_fields, checks_payload, assessed_at
           FROM wf_sports_data_quality_assessments
          WHERE match_id = ? AND assessed_at = ?
          ORDER BY id DESC
          LIMIT 1`,
        [matchId, now],
      );
      return qualityRow(rows?.[0] ?? null);
    },

    /** The newest assessment for a match, or `null` if it has never been scored. */
    async latestSportsQuality(matchId) {
      const [rows] = await executor.query(
        `SELECT id, match_id, score, band, freshness_score, provider_reliability_score,
                eligible_prediction, eligible_ticket, missing_fields, checks_payload, assessed_at
           FROM wf_sports_data_quality_assessments
          WHERE match_id = ?
          ORDER BY assessed_at DESC
          LIMIT 1`,
        [assertRowId(matchId, "match_id")],
      );
      return qualityRow(rows?.[0] ?? null);
    },

    // ── sync runs ──────────────────────────────────────────────────────────────

    /**
     * Open a sync run, or return `null` when `executionKey` has already been used.
     *
     * The row is written **before** the work starts, so a crash mid-sync still leaves
     * evidence of the attempt — a `RUNNING` row that never finished is precisely the
     * record of a worker that died.
     *
     * The UNIQUE key on `execution_key` is the arbiter, not a preceding SELECT: a cron
     * job that fires twice for one window, or a retry after a timeout, cannot ingest
     * the same data twice. Divergence SP-12: legacy did `SELECT … if found return null`
     * and then `INSERT` without catching the duplicate-key error, so two concurrent
     * runs of one window would have had the loser throw out of the sync instead of
     * reporting a skip. Here the collision is caught and translated into the same
     * `null` the check would have returned, so the constraint does the guarantee and
     * the answer is identical whether the race is lost by microseconds or by minutes.
     */
    async startSportsSync(run) {
      const r = run && typeof run === "object" ? run : {};
      const id = assertSyncRunId(r.id);
      const executionKey = assertExecutionKey(r.executionKey);
      const jobType = assertEnum(r.jobType, SYNC_JOB_TYPES, "sync job_type");
      const providerId = optionalRowId(r.providerId, "sync provider_id");
      const now = canonicalNow();

      try {
        await executor.execute(
          `INSERT INTO wf_sports_sync_runs
             (id, provider_id, job_type, status, started_at, ended_at,
              records_processed, records_created, records_updated, errors, execution_key)
           VALUES (?, ?, ?, 'RUNNING', ?, NULL, 0, 0, 0, NULL, ?)`,
          [id, providerId, jobType, now, executionKey],
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return null;
      }
      return syncRunRow({
        id,
        provider_id: providerId,
        job_type: jobType,
        status: "RUNNING",
        started_at: now,
        ended_at: null,
        records_processed: 0,
        records_created: 0,
        records_updated: 0,
        errors: null,
        execution_key: executionKey,
      });
    },

    /**
     * Close a sync run with its outcome.
     *
     * Every error message is truncated to 200 characters before it is stored, as
     * legacy does: a run that refused 40 records must be able to name them, but one
     * provider's stack trace must not be able to fill the column.
     */
    async finishSportsSync(id, result) {
      const r = result && typeof result === "object" ? result : {};
      const status = assertEnum(r.status, SYNC_STATUSES, "sync status");
      const now = canonicalNow();
      const errors = Array.isArray(r.errors) ? r.errors.map((entry) => String(entry).slice(0, 200)) : [];
      await executor.execute(
        `UPDATE wf_sports_sync_runs
            SET status = ?, ended_at = ?, records_processed = ?, records_created = ?,
                records_updated = ?, errors = ?
          WHERE id = ?`,
        [
          status,
          now,
          toInt(r.processed, 0),
          toInt(r.created, 0),
          toInt(r.updated, 0),
          encodeJson(errors),
          assertSyncRunId(id),
        ],
      );
    },

    /**
     * Newest-first sync runs, optionally for one provider or one job type.
     *
     * **This method does not exist in legacy.** `Aegis\Persistence\SportsRepository`
     * declares only `startSync` and `finishSync` (they are not module-prefixed there,
     * because a PHP interface is namespaced and this contract is not), and no file in
     * `application/` selects from `sports_sync_runs` — yet `ProviderHealthMonitor`'s
     * own docblock
     * documents its third parameter as *"newest-first `sports_sync_runs` rows for this
     * provider"*, and nothing in the legacy app calls `assess()` either. Legacy
     * therefore wrote sync evidence into a table it had no way to read, and built a
     * monitor whose derived status it never computed. Recorded as divergence SP-15 and
     * finding F-35; adding this method is what makes the monitor reachable, which is
     * the difference between porting a class and porting a capability.
     */
    async listSportsSyncRuns(filter = {}, limit = 20) {
      const f = filter && typeof filter === "object" ? filter : {};
      const bounded = Math.min(500, Math.max(1, toInt(limit, 20)));
      const clauses = [];
      const params = [];
      if (f.providerId !== null && f.providerId !== undefined && String(f.providerId).trim() !== "") {
        clauses.push("provider_id = ?");
        params.push(assertRowId(f.providerId, "filter.providerId"));
      }
      if (f.jobType !== null && f.jobType !== undefined && String(f.jobType).trim() !== "") {
        clauses.push("job_type = ?");
        params.push(assertEnum(f.jobType, SYNC_JOB_TYPES, "filter.jobType"));
      }
      if (f.status !== null && f.status !== undefined && String(f.status).trim() !== "") {
        clauses.push("status = ?");
        params.push(assertEnum(f.status, SYNC_STATUSES, "filter.status"));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT ${SYNC_RUN_COLUMNS}
           FROM wf_sports_sync_runs
           ${where}
          ORDER BY started_at DESC
          LIMIT ${bounded}`,
        params,
      );
      return rows.map(syncRunRow);
    },
  };
}

/** The 22 methods this repository adds to the shared store contract. */
export const SPORTS_REPOSITORY_METHODS = Object.freeze([
  "ensureSportsProvider",
  "listSportsProviders",
  "setSportsProviderEnabled",
  "saveSportsHealth",
  "latestSportsHealth",
  "listSportsHealth",
  "pruneSportsHealth",
  "findSportsMatchById",
  "listSportsMatches",
  "saveSportsMatch",
  "findSportsMatch",
  "saveSportsOdds",
  "latestSportsOdds",
  "listSportsOdds",
  "findSportsOddsBefore",
  "saveSportsResult",
  "findSportsResult",
  "saveSportsQuality",
  "latestSportsQuality",
  "startSportsSync",
  "finishSportsSync",
  "listSportsSyncRuns",
]);
