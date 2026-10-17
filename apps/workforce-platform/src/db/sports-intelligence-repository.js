/**
 * MySQL/MariaDB repository for the sports decision chain (row 14, slice 3).
 *
 * Migration `012_sports_intelligence.sql` explains the schema. This file is the only
 * thing that writes those four tables on MySQL, and `src/persistence/file-store.js`
 * implements the identical twelve methods over the same row shapes (`sports-rows.js`
 * owns both the validation and the shapes, so the two adapters cannot disagree).
 *
 * Three rules that differ from the foundation's repository, and why:
 *
 *  1. **Predictions are immutable.** There is an insert and a read, and nothing else.
 *     A decision is evidence of what the chain concluded and with which inputs, and a
 *     method that could alter it would make that evidence worthless.
 *  2. **Configuration versions are append-only and version-unique.** A second writer
 *     that computed the same next version loses on the UNIQUE key, and the method
 *     returns `null`, which the service maps to 409 `SPORTS_CONFIGURATION_CONFLICT`.
 *     Legacy's `saveConfiguration` is a bare insert, and nothing in the application code
 *     checks for an existing version first (SP-29).
 *  3. **Calibration decisions are compare-and-set.** `decideSportsCalibration` updates
 *     only a PENDING row, and reports whether it did. Legacy checked the status in the
 *     controller and then updated unconditionally, so two administrators could both
 *     "approve" the same calibration with the second overwriting the first (SP-28).
 */
import {
  CALIBRATION_STATUSES,
  assertEnum,
  assertRowId,
  calibrationRow,
  configurationRow,
  modelVersionRow,
  predictionRow,
  prepareCalibration,
  prepareConfiguration,
  prepareModelVersion,
  preparePrediction,
  assertPredictionId,
  toInt,
} from "../persistence/sports-rows.js";

const BOUNDED = (limit, fallback = 50) => Math.min(500, Math.max(1, toInt(limit, fallback)));

function isDuplicateKey(error) {
  const code = error?.code;
  const sqlState = error?.sqlState;
  return code === "ER_DUP_ENTRY" || sqlState === "23000" || sqlState === "23505";
}

/** The twelve methods this module adds to the shared store contract. */
export const SPORTS_INTELLIGENCE_METHODS = Object.freeze([
  "ensureSportsModelVersion",
  "listSportsModelVersions",
  "saveSportsPrediction",
  "findSportsPrediction",
  "listSportsPredictions",
  "saveSportsConfiguration",
  "activeSportsConfiguration",
  "listSportsConfigurations",
  "saveSportsCalibration",
  "findSportsCalibration",
  "listSportsCalibrations",
  "decideSportsCalibration",
]);

export function createSportsIntelligenceRepository(executor) {
  // Named so that methods which read back through each other do not depend on `this`.
  const repo = {
    /**
     * Find or register the model version for an identity. Idempotent: the same
     * (name, version, features, calibration) always resolves to the same row.
     */
    async ensureSportsModelVersion(input) {
      const row = prepareModelVersion(input ?? {}, input?.createdAt);
      const find = async () => {
        const [rows] = await executor.query(
          `SELECT * FROM wf_sports_model_versions
            WHERE model_name = ? AND model_version = ? AND feature_version = ? AND calibration_version = ?`,
          [row.model_name, row.model_version, row.feature_version, row.calibration_version],
        );
        return rows[0] ?? null;
      };
      const existing = await find();
      if (existing) return modelVersionRow(existing);
      try {
        await executor.execute(
          `INSERT INTO wf_sports_model_versions
             (model_name, model_version, feature_version, calibration_version, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.model_name, row.model_version, row.feature_version, row.calibration_version, row.status, row.created_at],
        );
      } catch (error) {
        // A concurrent writer registered the same identity first. That is the outcome we wanted.
        if (!isDuplicateKey(error)) throw error;
      }
      return modelVersionRow(await find());
    },

    async listSportsModelVersions() {
      const [rows] = await executor.query("SELECT * FROM wf_sports_model_versions ORDER BY id ASC");
      return rows.map(modelVersionRow);
    },

    /** Insert one immutable decision. A duplicate id throws: a decision is never overwritten. */
    async saveSportsPrediction(input) {
      const id = assertPredictionId(input?.id);
      const row = preparePrediction(input ?? {}, { id, createdAt: input?.createdAt });
      await executor.execute(
        `INSERT INTO wf_sports_predictions (
           id, match_id, model_version_id, market, selection, raw_probability, calibrated_probability,
           implied_probability, expected_value, confidence, risk, correlation, data_quality_score,
           decision, rejection_reasons, factors, input_version, odds, odds_timestamp, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.match_id, row.model_version_id, row.market, row.selection, row.raw_probability,
          row.calibrated_probability, row.implied_probability, row.expected_value, row.confidence, row.risk,
          row.correlation, row.data_quality_score, row.decision, row.rejection_reasons, row.factors,
          row.input_version, row.odds, row.odds_timestamp, row.created_at,
        ],
      );
      return repo.findSportsPrediction(id);
    },

    async findSportsPrediction(id) {
      const [rows] = await executor.query("SELECT * FROM wf_sports_predictions WHERE id = ?", [assertPredictionId(id)]);
      return predictionRow(rows[0] ?? null);
    },

    async listSportsPredictions(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const clauses = [];
      const params = [];
      if (f.matchId !== null && f.matchId !== undefined) {
        clauses.push("match_id = ?");
        params.push(assertRowId(f.matchId, "filter.matchId"));
      }
      if (f.modelVersionId !== null && f.modelVersionId !== undefined) {
        clauses.push("model_version_id = ?");
        params.push(assertRowId(f.modelVersionId, "filter.modelVersionId"));
      }
      if (f.decision !== null && f.decision !== undefined) {
        clauses.push("decision = ?");
        params.push(assertEnum(f.decision, ["PREDICTION_READY", "NO_PREDICTION"], "filter.decision"));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_predictions ${where} ORDER BY created_at DESC, id DESC LIMIT ${BOUNDED(limit)}`,
        params,
      );
      return rows.map(predictionRow);
    },

    /**
     * Append the next configuration version. Returns the stored row, or `null` when that
     * version already exists (a concurrent writer won the UNIQUE key).
     */
    async saveSportsConfiguration(input) {
      const row = prepareConfiguration(input ?? {});
      try {
        await executor.execute(
          `INSERT INTO wf_sports_configurations (
             version, module_enabled, ticket_engine_enabled, platform_mode, engine_mode, target_odds_min,
             target_odds_max, max_selections, risk_level, min_confidence, min_expected_value, max_correlation,
             min_data_quality, min_liquidity, allowed_markets, allowed_leagues, max_exposure, stake_amount,
             staking_method, void_policy, require_calibration, updated_by, reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.version, row.module_enabled, row.ticket_engine_enabled, row.platform_mode, row.engine_mode,
            row.target_odds_min, row.target_odds_max, row.max_selections, row.risk_level, row.min_confidence,
            row.min_expected_value, row.max_correlation, row.min_data_quality, row.min_liquidity,
            row.allowed_markets, row.allowed_leagues, row.max_exposure, row.stake_amount, row.staking_method,
            row.void_policy, row.require_calibration, row.updated_by, row.reason, row.created_at,
          ],
        );
      } catch (error) {
        if (isDuplicateKey(error)) return null;
        throw error;
      }
      const [rows] = await executor.query("SELECT * FROM wf_sports_configurations WHERE version = ?", [row.version]);
      return configurationRow(rows[0] ?? null);
    },

    async activeSportsConfiguration() {
      const [rows] = await executor.query("SELECT * FROM wf_sports_configurations ORDER BY version DESC LIMIT 1");
      return configurationRow(rows[0] ?? null);
    },

    async listSportsConfigurations(limit = 50) {
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_configurations ORDER BY version DESC LIMIT ${BOUNDED(limit)}`,
      );
      return rows.map(configurationRow);
    },

    /** Store a fitted calibration as PENDING. `input.fit` is the output of `fitCalibration`. */
    async saveSportsCalibration(input) {
      const row = prepareCalibration(input?.fit ?? {}, {
        modelVersionId: input?.modelVersionId,
        calibrationVersion: input?.calibrationVersion,
        createdBy: input?.createdBy,
        createdAt: input?.createdAt,
      });
      const [result] = await executor.execute(
        `INSERT INTO wf_sports_calibrations (
           model_version_id, method, intercept, slope, samples, positives, ece, brier, identity_brier, bins,
           calibration_version, status, created_by, created_at, approved_by, approved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.model_version_id, row.method, row.intercept, row.slope, row.samples, row.positives, row.ece,
          row.brier, row.identity_brier, row.bins, row.calibration_version, row.status, row.created_by,
          row.created_at, row.approved_by, row.approved_at,
        ],
      );
      return repo.findSportsCalibration(result.insertId);
    },

    async findSportsCalibration(id) {
      const [rows] = await executor.query("SELECT * FROM wf_sports_calibrations WHERE id = ?", [assertRowId(id, "calibration id")]);
      return calibrationRow(rows[0] ?? null);
    },

    async listSportsCalibrations(filter = {}, limit = 50) {
      const f = filter && typeof filter === "object" ? filter : {};
      const clauses = [];
      const params = [];
      if (f.modelVersionId !== null && f.modelVersionId !== undefined) {
        clauses.push("model_version_id = ?");
        params.push(assertRowId(f.modelVersionId, "filter.modelVersionId"));
      }
      if (f.status !== null && f.status !== undefined) {
        clauses.push("status = ?");
        params.push(assertEnum(f.status, CALIBRATION_STATUSES, "filter.status"));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT * FROM wf_sports_calibrations ${where} ORDER BY id DESC LIMIT ${BOUNDED(limit)}`,
        params,
      );
      return rows.map(calibrationRow);
    },

    /**
     * Approve or reject a PENDING calibration. Returns the decided row, or `null` when the
     * row does not exist or was already decided. Legacy stamps `approved_by` and
     * `approved_at` on a rejection as well (SP-27), and this keeps that.
     */
    async decideSportsCalibration(id, status, actorId, decidedAt) {
      const calibrationId = assertRowId(id, "calibration id");
      const decision = assertEnum(status, ["APPROVED", "REJECTED"], "calibration decision");
      const [result] = await executor.execute(
        `UPDATE wf_sports_calibrations
            SET status = ?, approved_by = ?, approved_at = ?
          WHERE id = ? AND status = 'PENDING'`,
        [decision, String(actorId ?? "").slice(0, 64), decidedAt, calibrationId],
      );
      if (!result || result.affectedRows !== 1) return null;
      return repo.findSportsCalibration(calibrationId);
    },
  };
  return repo;
}
