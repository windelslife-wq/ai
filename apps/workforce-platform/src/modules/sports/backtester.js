/**
 * Historical backtesting — the port of legacy `Aegis\Sports\SportsBacktester`
 * (row 14, slice 5).
 *
 * Strict point-in-time replay: for every finished match in the range only data that
 * EXISTED BEFORE kickoff is visible — odds with `observed_at` before kickoff, the
 * stored form context, and the verified final result. The same deterministic chain run
 * live (features → prediction → calibration → value → risk → gate) is re-run, so
 * backtests measure the model, not luck.
 *
 * Honesty contract, carried from legacy: the report is flagged `simulation: true` and
 * carries an explicit warning. Backtest numbers are NEVER merged into live performance
 * statistics and are never presented as live results; the report is stored whole with
 * that flag inside it, so a report read back years later still says what it is.
 *
 * Calibration in the replay: the newest APPROVED calibration for the baseline model
 * version is used and labelled `APPROVED_<version>`; when none is approved the replay
 * measures the RAW model through the identity mapping (the port passes
 * `method: "identity"` explicitly, because legacy's linear form with intercept 0 and
 * slope 1 IS the identity, and the port's logistic form with those numbers would not
 * be — DV-12's map). Either way the label is in the report.
 *
 * Divergences and quirks carried or recorded here:
 *
 *  - DV-12 applies to the whole replay: the port's calibrated probabilities come from
 *    the logistic map, legacy's from the linear form. The parity harness pins the
 *    difference where it can; backtest reports inherit it.
 *  - The `byMarket`/`byLeague` accumulators use legacy's reference semantics (a group
 *    is created on first touch, `pnl` accumulates only settled selections).
 *  - The rows cap is legacy's 500: a long range reports on the first 500 settled,
 *    scored selections and says nothing more — the same boundary legacy has.
 */

import { randomBytes } from "node:crypto";

import { AppError } from "../../http/errors.js";
import { assessQuality } from "./quality.js";
import { MODEL_NAME, MODEL_VERSION, FEATURE_VERSION, evaluatePrediction } from "./intelligence.js";
import { calibrationVersion, evaluateCalibration } from "./calibration.js";

/** The widest window one run may cover. Legacy's `MAX_RANGE_DAYS`. */
export const MAX_RANGE_DAYS = 90;
/** The most selections one report lists. */
export const SELECTION_ROW_CAP = 500;
/** The most matches one run reads. */
export const MATCH_LIMIT = 1000;

/**
 * Run one backtest over stored history.
 *
 * @param {object} options
 * @param {object} options.store the repository
 * @param {object} params from/to (YYYY-MM-DD), league?, modelVersionId?, minConfidence?,
 *   oddsMin?, oddsMax?, minDataQuality?, stake?
 * @param {string|null} [options.actorId]
 * @param {() => number} [options.now] epoch milliseconds
 */
export async function runBacktest({ store, params, actorId = null, now = () => Date.now() }) {
  const repository = store;
  if (!repository) {
    throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
      "This host has no sports repository, so there is no history to replay");
  }
  const from = String(params?.from ?? "");
  const to = String(params?.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new AppError(422, "SPORTS_BACKTEST_PARAMS", "from/to must be YYYY-MM-DD");
  }
  const fromTs = Date.parse(`${from}T00:00:00Z`) / 1000;
  const toTs = Date.parse(`${to}T23:59:59Z`) / 1000;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) {
    throw new AppError(422, "SPORTS_BACKTEST_PARAMS", "from/to must be YYYY-MM-DD");
  }
  if (fromTs > toTs) throw new AppError(422, "SPORTS_BACKTEST_PARAMS", "from must be before to");
  if (toTs - fromTs > MAX_RANGE_DAYS * 86400) {
    throw new AppError(422, "SPORTS_BACKTEST_PARAMS", `range must not exceed ${MAX_RANGE_DAYS} days`);
  }

  const numeric = (value, fallback) => {
    const parsed = Number(value);
    return value !== undefined && value !== null && value !== "" && Number.isFinite(parsed) ? parsed : fallback;
  };
  const league = params?.league ?? null;
  const minConfidence = numeric(params?.minConfidence, 75.0);
  const oddsMin = numeric(params?.oddsMin, 0.0);
  const oddsMax = numeric(params?.oddsMax, 100.0);
  const minQuality = Math.trunc(numeric(params?.minDataQuality, 60));
  const stake = Math.max(0.0, numeric(params?.stake, 10.0));
  const modelVersionId = params?.modelVersionId !== undefined && params?.modelVersionId !== null && params?.modelVersionId !== ""
    ? Math.trunc(Number(params.modelVersionId))
    : null;
  if (params?.modelVersionId !== undefined && params?.modelVersionId !== null && params?.modelVersionId !== "" && !Number.isFinite(modelVersionId)) {
    throw new AppError(422, "SPORTS_BACKTEST_PARAMS", "modelVersionId must be a number");
  }

  // Kickoff timestamps carry a time-of-day component, so a bare-date upper bound would
  // exclude the whole `to` day; extend to end-of-day (legacy's own comment).
  let matches = await repository.listSportsMatches({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z` }, MATCH_LIMIT);
  if (league !== null && String(league).trim() !== "") {
    matches = matches.filter((m) => String(m.competition ?? "").includes(String(league)));
  }
  matches = matches.filter((m) => String(m.status ?? "") === "FINISHED");

  // Approved calibration (labeled as of backtest time — the replay assumes the same
  // model stack). When none is approved the replay measures the RAW model via the
  // identity mapping — explicit in the report, and exactly what calibration is meant
  // to improve, not a hidden assumption of accuracy.
  const model = await repository.ensureSportsModelVersion({
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    featureVersion: FEATURE_VERSION,
    createdAt: new Date(now()).toISOString(),
  });
  const approved = (await repository.listSportsCalibrations({ modelVersionId: model.id, status: "APPROVED" }, 1))[0] ?? null;
  let calibrationInput;
  let calibrationLabel;
  if (approved !== null) {
    calibrationInput = {
      approved: true,
      method: approved.method,
      intercept: Number(approved.intercept),
      slope: Number(approved.slope),
      version: approved.calibration_version,
      ece: Number(approved.ece),
      samples: Number(approved.samples),
      approvedAt: approved.approved_at,
    };
    calibrationLabel = `APPROVED_${calibrationVersion({
      method: approved.method,
      intercept: Number(approved.intercept),
      slope: Number(approved.slope),
      samples: Number(approved.samples),
    })}`;
  } else {
    calibrationInput = {
      approved: true,
      method: "identity",
      intercept: 0.0,
      slope: 1.0,
      version: "identity-replay",
      ece: null,
      samples: 0,
      approvedAt: null,
    };
    calibrationLabel = "NONE — identity replay of raw model probabilities";
  }
  let note = null;
  if (modelVersionId !== null && modelVersionId !== model.id) {
    // The stored pipeline is the versioned baseline; comparing a different model
    // version is reported honestly rather than pretending to re-run it.
    note = `replayed model (baseline ${MODEL_VERSION}) differs from requested modelVersionId=${modelVersionId}`;
  }

  const rows = [];
  let evaluated = 0;
  let skipped = 0;
  let pnl = 0.0;
  let staked = 0.0;
  const evPredicted = [];
  const evRealized = [];
  let cum = 0.0;
  let peak = 0.0;
  let maxDd = 0.0;
  const groups = { byMarket: new Map(), byLeague: new Map() };
  const overTime = new Map();
  let accuracyCorrect = 0;
  let accuracyTotal = 0;
  const calRows = [];

  for (const match of matches) {
    const result = await repository.findSportsResultByMatch(match.id).catch(() => null);
    if (result === null || !(result.verified === true || result.verified === 1) || String(result.status ?? "") !== "FINISHED") {
      skipped += 1;
      continue;
    }
    const kickoffTs = parseTs(match.kickoff_at);
    if (kickoffTs === null) {
      skipped += 1;
      continue;
    }

    // Point-in-time inputs ONLY: the newest odds observed strictly before kickoff.
    const oddsRow = await repository.findSportsOddsBefore(match.id, new Date(kickoffTs * 1000).toISOString()).catch(() => null);
    if (oddsRow === null) {
      skipped += 1;
      continue;
    }
    const odds = {
      market: oddsRow.market,
      selection: oddsRow.selection,
      decimalOdds: Number(oddsRow.decimal_odds),
      observedAt: oddsRow.observed_at,
    };
    if (odds.decimalOdds < oddsMin || odds.decimalOdds > oddsMax) {
      skipped += 1;
      continue;
    }

    // Quality recomputed at the historical point in time, from the stored context.
    const payload = match.payload && typeof match.payload === "object" ? match.payload : {};
    const matchArr = {
      ...match,
      externalId: match.external_id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      kickoff: match.kickoff_at,
      context: payload.context ?? null,
      sourceTimestamp: match.source_timestamp,
    };
    const quality = assessQuality(matchArr, {
      oddsAvailable: true,
      recentFormAvailable: !empty(matchArr?.context?.recentForm),
      providerReliability: 0.9,
      dataAgeSeconds: 0,
      maxAgeSeconds: 3600,
    });
    if (quality.score < minQuality) {
      skipped += 1;
      continue;
    }

    // Point-in-time replay shape: as of the decision moment the match was still
    // SCHEDULED and the newest odds were the ones just observed — the freshness gate
    // is evaluated against that moment, never against wall-clock time or the final
    // score.
    const pointInTime = { ...match, status: "SCHEDULED" };
    const decisionMs = Date.parse(String(oddsRow.observed_at ?? ""));
    const decisionNow = Number.isNaN(decisionMs) ? kickoffTs : Math.floor(decisionMs / 1000);
    const candidate = evaluatePrediction({
      match: pointInTime,
      odds,
      quality,
      calibration: calibrationInput,
      config: {
        min_confidence: minConfidence,
        min_data_quality: minQuality,
        require_calibration: 0,
        allowed_markets: [],
        allowed_leagues: [],
      },
      now: decisionNow,
    });
    evaluated += 1;

    const totalGoals = Number(result.home_score) + Number(result.away_score);
    const outcome = candidate.market === "TOTAL_GOALS" && candidate.selection === "OVER_1_5"
      ? (totalGoals > 1 ? 1 : 0)
      : null;
    // An unscorable candidate contributes nothing: no accuracy, no rows, no P/L.
    if (outcome === null) continue;

    calRows.push({
      raw_probability: candidate.prediction?.rawModelProbability ?? null,
      calibrated_probability: candidate.prediction?.calibratedProbability ?? null,
      outcome,
    });
    accuracyTotal += 1;
    const pCal = Number(candidate.prediction?.calibratedProbability ?? candidate.prediction?.rawModelProbability ?? 0.5);
    if ((pCal >= 0.5 ? 1 : 0) === outcome) accuracyCorrect += 1;

    const gate = candidate.rejectionReasons ?? [];
    if (gate.length === 0) {
      const won = outcome === 1;
      const selPnl = won ? stake * (odds.decimalOdds - 1) : -stake;
      pnl += selPnl;
      staked += stake;
      evPredicted.push(Number(candidate.value?.expectedValue ?? 0));
      evRealized.push(won ? odds.decimalOdds - 1 : -1.0);
      cum += selPnl;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
      const groupLabels = { byMarket: candidate.market, byLeague: match.competition ?? "UNKNOWN" };
      for (const [key, label] of Object.entries(groupLabels)) {
        const group = groups[key];
        if (!group.has(label)) group.set(label, { n: 0, won: 0, pnl: 0.0 });
        const bucket = group.get(label);
        bucket.n += 1;
        if (won) bucket.won += 1;
        bucket.pnl += selPnl;
      }
      const day = new Date(kickoffTs * 1000).toISOString().slice(0, 10);
      if (!overTime.has(day)) overTime.set(day, { n: 0, pnl: 0.0 });
      const dayBucket = overTime.get(day);
      dayBucket.n += 1;
      dayBucket.pnl += selPnl;

      rows.push({
        matchId: Number(match.id),
        match: `${match.home_team} vs ${match.away_team}`,
        league: match.competition ?? null,
        kickoff: match.kickoff_at,
        score: `${result.home_score ?? 0}-${result.away_score ?? 0}`,
        market: candidate.market,
        selection: candidate.selection,
        odds: odds.decimalOdds,
        oddsObservedAt: odds.observedAt,
        calibratedProbability: candidate.prediction?.calibratedProbability ?? null,
        confidence: candidate.confidence?.confidence,
        risk: candidate.risk?.classification,
        decision: gate.length === 0 ? "QUALIFIED" : "REJECTED",
        rejectionReasons: gate,
        outcome: won ? "WON" : "LOST",
        pnl: round(selPnl, 4),
        model: `${candidate.prediction?.modelName} ${candidate.prediction?.modelVersion}`,
        calibration: calibrationLabel,
      });
      if (rows.length >= SELECTION_ROW_CAP) break;
    }
  }

  const decisive = rows.filter((r) => r.decision === "QUALIFIED" && (r.outcome === "WON" || r.outcome === "LOST")).length;
  const wonCount = rows.filter((r) => r.outcome === "WON").length;
  const probabilityOf = (o) => Number(o.calibrated_probability ?? o.raw_probability ?? 0.5);
  const calMetrics = calRows.length > 0 ? evaluateCalibration(calRows, probabilityOf) : null;
  const report = {
    simulation: true,
    warning: "BACKTEST SIMULATION — historical replay of stored data; NOT live results. Never mix with live performance.",
    params: cleanParams({ from, to, league, modelVersionId, minConfidence, oddsMin, oddsMax, minDataQuality: minQuality, stake }),
    matchesFinished: matches.length,
    evaluated,
    skipped,
    skippedReasons: ["unverified result", "no pre-kickoff odds", "odds outside range", "data quality below threshold"],
    qualifiedSelections: decisive,
    won: wonCount,
    lost: Math.max(0, decisive - wonCount),
    winRate: decisive > 0 ? round(wonCount / decisive, 5) : null,
    accuracy: accuracyTotal > 0 ? round(accuracyCorrect / accuracyTotal, 5) : null,
    roi: staked > 0 ? round(pnl / staked, 5) : null,
    yield: staked > 0 ? round(pnl / staked, 5) : null,
    profitLoss: round(pnl, 4),
    maxDrawdown: round(maxDd, 4),
    evAccuracy: evPredicted.length > 0
      ? {
        meanPredictedEV: round(evPredicted.reduce((a, b) => a + b, 0) / evPredicted.length, 5),
        meanRealized: round(evRealized.reduce((a, b) => a + b, 0) / evRealized.length, 5),
      }
      : null,
    // Legacy computes the calibration metrics with its own evaluate() over the replay's
    // scored rows; the port uses the same shared evaluateCalibration the fit uses.
    // NOTE: the Brier here is the corrected (non-truncated) score — legacy's is always
    // 0.0 (F-36), so a report compared byte-for-byte with PHP differs on this field.
    calibration: calMetrics ? { brier: calMetrics.brier, ece: calMetrics.ece, bins: calMetrics.bins } : null,
    calibrationUsed: calibrationLabel,
    model: `${MODEL_NAME} ${MODEL_VERSION}`,
    modelNote: note,
    byMarket: mapOut(groups.byMarket),
    byLeague: mapOut(groups.byLeague),
    overTime: Object.fromEntries(overTime.entries()),
    selections: rows,
    generatedAt: new Date(now()).toISOString(),
  };

  const id = `bt_${randomBytes(8).toString("hex")}`;
  const stored = await repository.saveSportsBacktest({
    id,
    createdAt: new Date(now()).toISOString(),
    createdBy: actorId,
    params: report.params,
    report,
    status: "COMPLETED",
  });
  await repository.recordAudit({
    actorId,
    action: "sports.backtest.run",
    entityType: "sports_backtest",
    entityId: id,
    details: {
      backtestId: id,
      simulation: true,
      window: `${from} → ${to}`,
      summary: `Sports backtest ${id} (${from} → ${to}): ${report.qualifiedSelections} qualified selection(s), ROI ${report.roi === null ? "null" : String(report.roi)}`,
      winRate: report.winRate,
      roi: report.roi,
      accuracy: report.accuracy,
    },
  });
  return { ...stored, report: { ...report, id }, id };
}

/**
 * PHP `empty()` for the one field the quality gate reads.
 */
function empty(value) {
  return value === undefined || value === null || value === "" || value === 0
    || (Array.isArray(value) && value.length === 0);
}

/** PHP `round($x, $p)`. */
function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
}

function parseTs(value) {
  if (!value) return null;
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? null : Math.floor(at / 1000);
}

/** Legacy's `array_filter($params, fn($v) => $v !== null)`: drop only the nulls. */
function cleanParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null));
}

function mapOut(map) {
  return Object.fromEntries([...map.entries()].map(([label, b]) => [label, {
    n: b.n,
    won: b.won,
    pnl: round(b.pnl, 4),
  }]));
}
