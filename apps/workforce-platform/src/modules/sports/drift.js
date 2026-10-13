/**
 * Model drift monitoring — the port of legacy `Aegis\Sports\ModelDriftMonitor`
 * (row 14, slice 5).
 *
 * Compares a trailing RECENT window (14 days) against the preceding BASELINE window
 * (28 days) for each model version with enough settled samples, and raises a MODEL
 * PERFORMANCE WARNING — an operator notification plus an audit event — when the
 * configured deterioration thresholds are exceeded. Administrator review is required:
 * **the monitor alerts, it never rewrites a model.**
 *
 * This is the publisher `SPORTS_MODEL_DRIFT` has waited for since Phase 9 declared it
 * (finding NV-6): with this service, every declared notification type has a publisher.
 * The dedupe key is legacy's: `sports-drift:<modelVersionId>:<UTC date>`, so a model
 * that stays in breach alerts once per day, not once per run.
 *
 * Every metric is COMPUTED from stored settled outcomes (predictions joined to
 * verified finished results). A model with no settled data reports
 * `INSUFFICIENT_RECENT_DATA` — the monitor invents nothing.
 *
 * Window boundaries are compared as instants, not as legacy's mixed string formats
 * (the same alignment SP-34 records for the model-performance window: legacy compares
 * a `Y-m-d H:i:s` bound against ISO strings as text, which misplaces the boundary day).
 *
 * One difference from legacy's shape, deliberate: legacy's monitor is invoked only by
 * the `monitoring` cron job, which is not ported (row 19). This port is driven on
 * request — by an operator, through `POST /sports/models/drift/run` — so the alerting
 * exists before any scheduler does. The audit and notification behaviour is the cron's.
 */

import { AppError } from "../../http/errors.js";
import { evaluateCalibration } from "./calibration.js";

export const RECENT_DAYS = 14;
export const BASELINE_DAYS = 28;
export const MIN_RECENT_SAMPLES = 20;
/** Eight percentage points. */
export const ACCURACY_DROP_THRESHOLD = 0.08;
export const BRIER_RISE_THRESHOLD = 0.03;
export const ECE_THRESHOLD = 0.08;

export function createModelDriftService({ store = null, notifications = null, now = () => Date.now() } = {}) {
  const requireStore = () => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so model drift cannot be measured");
    }
    return store;
  };

  /**
   * Run the monitor across every stored model version.
   *
   * @param {{now?: number}} [options] epoch-seconds override, as legacy's `?int $now`
   * @returns {Promise<{models: Array<object>, warnings: number}>}
   */
  async function monitor(options = {}) {
    const repository = requireStore();
    const nowSec = options.now ?? Math.floor(now() / 1000);
    const reports = [];
    let warnings = 0;
    for (const model of await repository.listSportsModelVersions()) {
      const id = Number(model.id);
      const recent = await windowMetrics(repository, id, RECENT_DAYS, nowSec, 0);
      if (recent.samples < MIN_RECENT_SAMPLES) {
        reports.push({ model, status: "INSUFFICIENT_RECENT_DATA", recent, baseline: null, reasons: [] });
        continue;
      }
      const baseline = await windowMetrics(repository, id, BASELINE_DAYS, nowSec, RECENT_DAYS);
      const reasons = [];
      if (
        baseline.accuracy !== null && recent.accuracy !== null
        && baseline.accuracy - recent.accuracy >= ACCURACY_DROP_THRESHOLD
      ) {
        // Byte-identical to legacy's sprintf('accuracy dropped %.1fpp (%.1f%% → %.1f%%)') —
        // the parentheses are part of the pinned reason format the parity test compares.
        reasons.push(
          `accuracy dropped ${((baseline.accuracy - recent.accuracy) * 100).toFixed(1)}pp `
          + `(${(baseline.accuracy * 100).toFixed(1)}% → ${(recent.accuracy * 100).toFixed(1)}%)`,
        );
      }
      if (
        baseline.brier !== null && recent.brier !== null
        && recent.brier - baseline.brier >= BRIER_RISE_THRESHOLD
      ) {
        reasons.push(
          `Brier error rose ${(recent.brier - baseline.brier).toFixed(4)} `
          + `(${baseline.brier.toFixed(4)} → ${recent.brier.toFixed(4)})`,
        );
      }
      if (recent.ece !== null && recent.ece >= ECE_THRESHOLD) {
        reasons.push(`calibration degraded (ECE ${recent.ece.toFixed(3)} ≥ ${ECE_THRESHOLD.toFixed(2)})`);
      }
      const warning = reasons.length > 0;
      reports.push({ model, status: warning ? "DRIFT_WARNING" : "STABLE", recent, baseline, reasons });
      if (warning) {
        warnings += 1;
        const label = `${model.model_name} v${model.model_version}`;
        await repository.recordAudit({
          actorId: null,
          action: "sports.model_drift.warning",
          entityType: "sports_model_version",
          entityId: String(id),
          details: {
            modelId: id,
            reasons,
            recent,
            baseline,
            message: `MODEL PERFORMANCE WARNING: ${label} deteriorated over the last ${RECENT_DAYS} days`,
          },
        });
        await repository.saveSportsModelMetrics({
          modelVersionId: id,
          windowDays: RECENT_DAYS,
          sampleType: "drift",
          predictions: recent.samples,
          settled: recent.samples,
          accuracy: recent.accuracy,
          brier: recent.brier,
          ece: recent.ece,
          winRate: null,
          roi: null,
          maxDrawdown: null,
          computedAt: new Date(nowSec * 1000).toISOString(),
        });
        if (notifications !== null) {
          let published;
          try {
            published = await notifications.notify(
              "SPORTS_MODEL_DRIFT",
              "warning",
              `MODEL PERFORMANCE WARNING: ${label}`,
              {
                modelId: id,
                reasons,
                recent,
                baseline,
                note: "Administrator review required — the monitor never rewrites models.",
              },
              `sports-drift:${id}:${new Date(nowSec * 1000).toISOString().slice(0, 10)}`,
            );
          } catch (error) {
            // A host whose notification store is missing must not lose the warning:
            // the audit event above is the durable record either way.
            published = { created: false, error: String(error?.message ?? error).slice(0, 200) };
          }
          reports[reports.length - 1].notification = published;
        }
      }
    }
    await repository.recordAudit({
      actorId: null,
      action: "sports.model_drift.monitor_run",
      entityType: "sports_model_version",
      entityId: null,
      details: { models: reports.length, warnings },
    });
    return { models: reports, warnings };
  }

  /**
   * Accuracy, Brier and ECE over one model's settled outcomes inside a trailing window.
   *
   * @param {number} modelVersionId
   * @param {number} days window length
   * @param {number} nowSec epoch seconds at the window's end
   * @param {number} offsetDays days to shift the window back (the baseline's offset)
   */
  async function windowMetrics(repository, modelVersionId, days, nowSec, offsetDays) {
    const end = nowSec - offsetDays * 86400;
    const since = end - days * 86400;
    const rows = (await repository.listSportsPredictionOutcomes(modelVersionId, 5000))
      .filter((o) => {
        const at = Date.parse(String(o.created_at ?? ""));
        // Compared as instants (SP-34), so a `…Z` row and a `…+00:00` row for the same
        // moment land on the same side of the boundary.
        if (Number.isNaN(at)) return false;
        const seconds = Math.floor(at / 1000);
        return seconds >= since && seconds <= end;
      });
    if (rows.length === 0) return { samples: 0, accuracy: null, brier: null, ece: null };
    let correct = 0;
    const probabilityOf = (o) => Number(o.calibrated_probability ?? o.raw_probability ?? 0.5);
    for (const o of rows) {
      if ((probabilityOf(o) >= 0.5 ? 1 : 0) === Number(o.outcome)) correct += 1;
    }
    const cal = evaluateCalibration(rows, probabilityOf);
    return {
      samples: rows.length,
      accuracy: round(correct / rows.length, 5),
      brier: cal.brier,
      ece: cal.ece,
    };
  }

  return Object.freeze({ monitor });
}

/** PHP `round($x, $p)`. */
function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
}
