/**
 * Performance analytics — the port of legacy `Aegis\Sports\PerformanceAnalytics`
 * (row 14, slice 5).
 *
 * Every number is derived from STORED settled records — tickets, selections and
 * prediction outcomes handed in by the caller — never synthesized. An empty database
 * yields `dataAvailable: false` and null metrics, which is the honest answer and not a
 * zero. In SANDBOX mode the report is flagged `DEMO/SANDBOX DATA` so simulated
 * statistics are never confused with real ones.
 *
 * Ported instruction-for-instruction, including the two behaviours a reader could
 * mistake for bugs:
 *
 *  - `summarize` (the deprecated legacy entry point) reports `roi: null` and
 *    `profitLoss: null` on purpose, with a note saying why: it was written before
 *    tickets carried stakes, and legacy keeps it for backward compatibility.
 *  - `meanEv` filters AFTER mapping, so a selection whose `expected_value` is the
 *    number 0 is dropped from the mean (PHP's `array_filter` treats `0.0` as empty).
 *    Ported as written, and the golden file pins it.
 *
 * Pure: no I/O, no clock, no database.
 */

import { phpRound } from "../../lib/php.js";
import { evaluateCalibration } from "./calibration.js";

/** The statuses that mean a ticket or a leg has a decided outcome. */
const TERMINAL = ["WON", "LOST", "VOID", "CANCELLED"];

/**
 * The deprecated legacy summary, kept because the platform keeps it.
 *
 * @param {Array<Record<string, any>>} tickets sports_tickets rows
 */
export function summarizeTickets(tickets) {
  const rows = Array.isArray(tickets) ? tickets : [];
  const settled = rows.filter((t) => TERMINAL.includes(String(t?.settlement_status ?? t?.status ?? "")));
  const counts = { WON: 0, LOST: 0, VOID: 0, CANCELLED: 0 };
  const odds = [];
  for (const t of settled) {
    const s = String(t.settlement_status ?? t.status);
    counts[s] += 1;
    if (t.total_odds !== undefined && t.total_odds !== null && isFinite(Number(t.total_odds))) {
      odds.push(Number(t.total_odds));
    }
  }
  const decisive = counts.WON + counts.LOST;
  return {
    dataAvailable: settled.length > 0,
    totalTickets: rows.length,
    settledTickets: settled.length,
    won: counts.WON,
    lost: counts.LOST,
    void: counts.VOID,
    cancelled: counts.CANCELLED,
    winRate: decisive ? phpRound(counts.WON / decisive, 4) : null,
    averageOdds: odds.length ? phpRound(odds.reduce((sum, o) => sum + o, 0) / odds.length, 4) : null,
    roi: null,
    profitLoss: null,
    notes: ["ROI and profit/loss require stored stake/accounting inputs and are intentionally unavailable"],
  };
}

/**
 * The full performance report from stored data.
 *
 * @param {Array<Record<string, any>>} tickets sports_tickets rows
 * @param {Array<Record<string, any>>} selections sports_ticket_selections rows joined
 *   with the match competition (the `settledSelections` shape)
 * @param {Array<Record<string, any>>} outcomes predictionOutcomes rows (for calibration)
 * @param {{mode?: string, totalPredictions?: number}} [context]
 */
export function performanceReport(tickets, selections, outcomes, context = {}) {
  const ticketRows = Array.isArray(tickets) ? tickets : [];
  const selectionRows = Array.isArray(selections) ? selections : [];
  const outcomeRows = Array.isArray(outcomes) ? outcomes : [];

  const settledTickets = ticketRows.filter((t) => TERMINAL.includes(String(t?.settlement_status ?? "")));
  const counts = { WON: 0, LOST: 0, VOID: 0, CANCELLED: 0 };
  const odds = [];
  const confidences = [];
  const probs = [];
  let stakeSum = 0;
  let pnlSum = 0;
  let hasStake = false;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const byDate = new Map();

  for (const t of settledTickets) {
    const s = String(t.settlement_status);
    counts[s] += 1;
    if (t.total_odds !== undefined && t.total_odds !== null && isFinite(Number(t.total_odds))) odds.push(Number(t.total_odds));
    if (t.confidence !== undefined && t.confidence !== null && isFinite(Number(t.confidence))) confidences.push(Number(t.confidence));
    if (t.combined_probability !== undefined && t.combined_probability !== null && isFinite(Number(t.combined_probability))) probs.push(Number(t.combined_probability));
    const pnl = t.pnl === undefined || t.pnl === null ? null : Number(t.pnl);
    const stake = t.stake === undefined || t.stake === null ? null : Number(t.stake);
    if (pnl !== null && stake !== null && stake > 0) {
      hasStake = true;
      pnlSum += pnl;
      stakeSum += stake;
      cum += pnl;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
    }
    const date = String(t.created_at ?? "").slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { n: 0, won: 0, pnl: 0 });
    const bucket = byDate.get(date);
    bucket.n += 1;
    if (s === "WON") bucket.won += 1;
    if (pnl !== null) bucket.pnl += pnl;
  }

  const settledSelections = selectionRows.filter((s) => TERMINAL.includes(String(s?.status ?? "")));
  const selCounts = { WON: 0, LOST: 0, VOID: 0, CANCELLED: 0 };
  const selOdds = [];
  const groupTotals = { byMarket: new Map(), byLeague: new Map(), byModel: new Map() };

  for (const s of settledSelections) {
    const st = String(s.status);
    selCounts[st] += 1;
    selOdds.push(Number(s.odds));
    const buckets = {
      byMarket: s.market ?? "UNKNOWN",
      byLeague: s.competition ?? "UNKNOWN",
      byModel: `${s.model_name ?? "unknown"} v${s.model_version ?? "?"}`,
    };
    for (const [key, label] of Object.entries(buckets)) {
      const group = groupTotals[key];
      if (!group.has(label)) group.set(label, { n: 0, won: 0 });
      const bucket = group.get(label);
      bucket.n += 1;
      if (st === "WON") bucket.won += 1;
    }
  }
  const groupOut = {};
  for (const [key, group] of Object.entries(groupTotals)) {
    const out = {};
    for (const [label, bucket] of group.entries()) {
      out[label] = { ...bucket, winRate: phpRound(bucket.won / bucket.n, 4) };
    }
    groupOut[key] = out;
  }
  const selDecisive = selCounts.WON + selCounts.LOST;

  let calibration = null;
  if (outcomeRows.length > 0) {
    const probabilityOf = (o) => Number(o.calibrated_probability ?? o.raw_probability ?? 0.5);
    const cal = evaluateCalibration(outcomeRows, probabilityOf);
    let correct = 0;
    for (const o of outcomeRows) {
      const p = Number(o.calibrated_probability ?? o.raw_probability ?? 0.5);
      if ((p >= 0.5 ? 1 : 0) === Number(o.outcome)) correct += 1;
    }
    calibration = {
      samples: outcomeRows.length,
      accuracy: phpRound(correct / outcomeRows.length, 5),
      brier: cal.brier,
      ece: cal.ece,
      bins: cal.bins,
    };
  }

  const mode = String(context.mode ?? "SANDBOX");
  return {
    dataAvailable: settledTickets.length > 0 || settledSelections.length > 0,
    mode,
    isDemoData: mode === "SANDBOX",
    demoBanner: mode === "SANDBOX" ? "DEMO / SANDBOX DATA — simulated statistics, not real-world performance" : null,
    totalPredictions: Number(context.totalPredictions ?? 0) || 0,
    totalTickets: ticketRows.length,
    settledTickets: settledTickets.length,
    won: counts.WON,
    lost: counts.LOST,
    void: counts.VOID,
    cancelled: counts.CANCELLED,
    winRate: (counts.WON + counts.LOST) > 0 ? phpRound(counts.WON / (counts.WON + counts.LOST), 5) : null,
    selections: {
      settled: settledSelections.length,
      won: selCounts.WON,
      lost: selCounts.LOST,
      void: selCounts.VOID,
      cancelled: selCounts.CANCELLED,
      winRate: selDecisive > 0 ? phpRound(selCounts.WON / selDecisive, 5) : null,
      averageOdds: selOdds.length ? phpRound(selOdds.reduce((sum, o) => sum + o, 0) / selOdds.length, 4) : null,
    },
    averageOdds: odds.length ? phpRound(odds.reduce((sum, o) => sum + o, 0) / odds.length, 4) : null,
    averageConfidence: confidences.length ? phpRound(confidences.reduce((sum, c) => sum + c, 0) / confidences.length, 2) : null,
    averageProbability: probs.length ? phpRound(probs.reduce((sum, p) => sum + p, 0) / probs.length, 5) : null,
    profitLoss: hasStake ? phpRound(pnlSum, 4) : null,
    roi: (hasStake && stakeSum > 0) ? phpRound(pnlSum / stakeSum, 5) : null,
    maxDrawdown: hasStake ? phpRound(maxDd, 4) : null,
    expectedValue: meanEv(settledSelections),
    calibration,
    modelAccuracy: calibration ? calibration.accuracy : null,
    byMarket: groupOut.byMarket,
    byLeague: groupOut.byLeague,
    byModel: groupOut.byModel,
    byDate: Object.fromEntries(byDate.entries()),
  };
}

/**
 * Mean expected value over settled selections.
 *
 * Ported as written: legacy maps first and filters second with `array_filter`, so an
 * `expected_value` of exactly 0 is dropped rather than averaged. A missing or
 * unparseable value maps to `null`, which the filter drops too.
 */
function meanEv(selections) {
  const evs = selections
    .map((s) => {
      const raw = s?.expected_value;
      if (raw === null || raw === undefined || raw === "" || !isFinite(Number(raw))) return null;
      return Number(raw);
    })
    .filter((v) => v !== null && v !== 0);
  if (evs.length === 0) return null;
  return phpRound(evs.reduce((sum, v) => sum + v, 0) / evs.length, 5);
}
