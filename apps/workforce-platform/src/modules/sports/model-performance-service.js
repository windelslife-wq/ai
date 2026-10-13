/**
 * Model versioning and measured performance — the port of legacy
 * `Aegis\Sports\ModelPerformanceService` (row 14, slices 3 and 5).
 *
 * Every metric here is COMPUTED from stored settled data (prediction outcomes plus
 * ticket settlements). Models are compared on measured performance — the newest model
 * is never assumed to be the best, and a model with no settled data reports null
 * metrics rather than an invented baseline.
 *
 * Ported as written, including the parts that look odd and are not:
 *
 *  - The accuracy rule is legacy's: predicted-over is `round(p * 1000) >= 500`, i.e.
 *    measured to a tenth of a percent before the ½ comparison (see
 *    `metricsFromOutcomes`). `performanceReport` uses the plain ½ comparison because
 *    that is what its own legacy source uses; the two rules live in their respective
 *    ports, not unified.
 *  - Per-selection ROI shares one ticket's stake and P/L equally across its legs —
 *    `ticket_stake / max(1, selectionCount)` and `ticket_pnl / n` — which is legacy's
 *    allocation, not a claim that legs contributed equally.
 *  - `metricsFor` WRITES a `live` snapshot row on every call, snapshot failure
 *    swallowed (legacy's `saveSnapshot` catches everything). A read that records
 *    evidence history: `wf_sports_model_metrics` grows by one row per model per
 *    performance read, which is the same growth legacy has, and is why retention for
 *    this table belongs to the platform-wide retention decision (R-28's list).
 *
 * The port-side note recorded in PHASE19: the ticket's P/L and stake arrive through
 * the `settledSelections` join (`ticket_pnl` / `ticket_stake`) instead of legacy's
 * one-`findTicket`-per-selection reads. The values are the same columns; the N+1 reads
 * are gone.
 */

import { AppError } from "../../http/errors.js";
import { phpRound } from "../../lib/php.js";
import { evaluateCalibration } from "./calibration.js";

/** The plain-½ accuracy `metricsFor` uses, matching legacy's line exactly. */
function predictedOver(probability) {
  return phpRound(probability * 1000) >= 500;
}

export function createModelPerformanceService({ store = null, now = () => Date.now() } = {}) {
  const requireStore = () => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so model performance cannot be measured");
    }
    return store;
  };

  /** The stored model registry, in the read view legacy's `listModels` returns. */
  async function listModels() {
    const repository = requireStore();
    const rows = await repository.listSportsModelVersions();
    return rows.map((m) => ({
      id: Number(m.id),
      modelName: m.model_name,
      modelVersion: m.model_version,
      featureVersion: m.feature_version,
      calibrationVersion: m.calibration_version ?? null,
      status: m.status,
      createdAt: m.created_at,
    }));
  }

  /**
   * Metrics for one model version over a trailing window (live samples only).
   *
   * @param {number} modelVersionId
   * @param {number} windowDays
   * @param {{nowSec?: number}} [options]
   */
  async function metricsFor(modelVersionId, windowDays, options = {}) {
    const repository = requireStore();
    const nowSec = options.nowSec ?? Math.floor(now() / 1000);
    const since = nowSec - windowDays * 86400;
    const sinceIso = new Date(since * 1000).toISOString();

    const outcomes = (await repository.listSportsPredictionOutcomes(modelVersionId, 5000))
      .filter((o) => {
        const at = Date.parse(String(o.created_at ?? ""));
        return !Number.isNaN(at) && Math.floor(at / 1000) >= since;
      });
    const selections = (await repository.listSportsSettledSelections({ from: sinceIso, modelVersionId }, 5000))
      .filter((s) => s._settled === 1);

    const metrics = {
      samples: outcomes.length,
      settledTickets: new Set(selections.map((s) => String(s.ticket_id))).size,
    };

    if (outcomes.length > 0) {
      const probabilityOf = (o) => Number(o.calibrated_probability ?? o.raw_probability ?? 0.5);
      let correct = 0;
      for (const o of outcomes) {
        const outcome = Number(o.outcome);
        if (predictedOver(probabilityOf(o)) ? outcome === 1 : outcome === 0) correct += 1;
      }
      metrics.accuracy = phpRound(correct / outcomes.length, 5);
      const cal = evaluateCalibration(outcomes, probabilityOf);
      metrics.brier = cal.brier;
      metrics.ece = cal.ece;
    }

    if (selections.length > 0) {
      let stakeSum = 0;
      let pnlSum = 0;
      let hasStake = false;
      let cum = 0;
      let peak = 0;
      let maxDd = 0;
      const byMarket = new Map();
      const byLeague = new Map();
      const legCounts = new Map();
      for (const s of selections) {
        if (!legCounts.has(String(s.ticket_id))) {
          const legs = await repository.listSportsTicketSelections(String(s.ticket_id));
          legCounts.set(String(s.ticket_id), legs.length);
        }
      }
      for (const s of selections) {
        const stake = s.ticket_stake !== null && s.ticket_stake !== undefined
          ? Number(s.ticket_stake) / Math.max(1, legCounts.get(String(s.ticket_id)))
          : null;
        const pnl = s.ticket_pnl !== null && s.ticket_pnl !== undefined ? Number(s.ticket_pnl) : null;
        // Per-selection share of the ticket's stake and P/L for the breakdowns.
        const n = Math.max(1, legCounts.get(String(s.ticket_id)));
        if (pnl !== null && stake !== null) {
          const pnlSel = pnl / n;
          const stakeSel = stake;
          hasStake = true;
          pnlSum += pnlSel;
          stakeSum += stakeSel;
          cum += pnlSel;
          peak = Math.max(peak, cum);
          maxDd = Math.max(maxDd, peak - cum);
        }
        const market = s.market ?? "UNKNOWN";
        const league = s.competition ?? "UNKNOWN";
        for (const [group, label] of [["byMarket", market], ["byLeague", league]]) {
          const bucket = group === "byMarket" ? byMarket : byLeague;
          if (!bucket.has(label)) bucket.set(label, { n: 0, won: 0 });
          const entry = bucket.get(label);
          entry.n += 1;
          if (String(s.status) === "WON") entry.won += 1;
        }
      }
      const toOut = (bucket) => Object.fromEntries(
        [...bucket.entries()].map(([label, b]) => [label, { ...b, winRate: phpRound(b.won / b.n, 4) }]),
      );
      metrics.byMarket = toOut(byMarket);
      metrics.byLeague = toOut(byLeague);
      const decisive = selections.filter((s) => s.status === "WON" || s.status === "LOST").length;
      const won = selections.filter((s) => s.status === "WON").length;
      metrics.winRate = decisive ? phpRound(won / decisive, 5) : null;
      metrics.roi = (hasStake && stakeSum > 0) ? phpRound(pnlSum / stakeSum, 5) : null;
      metrics.maxDrawdown = hasStake ? phpRound(maxDd, 4) : null;
    }

    await saveSnapshot(repository, modelVersionId, windowDays, metrics);
    return metrics;
  }

  /** Side-by-side comparison across all model versions (measured only). */
  async function compare(windowDays = 90) {
    const models = await listModels();
    const out = [];
    for (const m of models) {
      const metrics = await metricsFor(m.id, windowDays);
      out.push({ ...m, metrics });
    }
    return out;
  }

  return Object.freeze({ listModels, metricsFor, compare });
}

/**
 * The `live` snapshot. Snapshotting must never break the read it records — legacy
 * wraps this in a catch-all, and so does this port.
 */
async function saveSnapshot(repository, modelVersionId, windowDays, metrics) {
  try {
    await repository.saveSportsModelMetrics({
      modelVersionId,
      windowDays,
      sampleType: "live",
      predictions: metrics.samples ?? 0,
      settled: metrics.settledTickets ?? 0,
      accuracy: metrics.accuracy ?? null,
      brier: metrics.brier ?? null,
      ece: metrics.ece ?? null,
      winRate: metrics.winRate ?? null,
      roi: metrics.roi ?? null,
      maxDrawdown: metrics.maxDrawdown ?? null,
      computedAt: new Date().toISOString(),
    });
  } catch {
    // Swallowed, as legacy's is: a failed snapshot must not fail the read.
  }
}
