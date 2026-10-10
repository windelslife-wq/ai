/**
 * Multi-agent debate — a deterministic adversarial review in front of the
 * consensus verdict.
 *
 * Ported from `application/libraries/Aegis/Agents/AgentDebate.php`. Four rule-based
 * roles, no model and nothing invented:
 *  - the bull and bear advocates state the strongest evidence on each side, citing
 *    the agent and signal each claim came from;
 *  - the skeptic challenges the *leading* bias with checkable objections
 *    (S1 conflicts, S2 regime contradiction, S3 staleness, S4 synthetic origin,
 *    S5 weak conviction, S6 abstentions);
 *  - the risk critic challenges the concrete proposal (R1 risk/reward below the
 *    minimum, R2 an unusually wide stop) and records R0 when there is no proposal.
 *
 * The verdict can only reduce a bias, never inflate it:
 *   any sustained CRITICAL objection → NO_TRADE
 *   ≥ 2 sustained MAJOR objections   → downgrade to NEUTRAL
 *   1 sustained MAJOR                → bias kept, confidence −0.10
 *   minors only                      → −0.02 each, capped at −0.15
 * The transcript travels with the analysis so the reasoning is auditable after the
 * fact, not only at the moment it was produced.
 *
 * Two deliberate divergences from the legacy code, both recorded in
 * `docs/migration/PHASE5_ANALYSIS.md`:
 *  1. `S1` counts conflicts properly. The legacy line casts
 *     `consensus.conflicts` — an *array* of conflict records — to `(int)`, which
 *     in PHP yields 1 for any non-empty array, so a genuinely split panel could
 *     never reach the "≥ 2 is a real split" branch. Counting the array makes the
 *     skeptic stricter, and strictness is the only safe direction here.
 *  2. Advocates cite agent votes in production runs. The legacy advocate loop only
 *     accepts signals whose `signal` field literally reads `bullish`/`bearish`,
 *     while the technical agent emits `BUY`/`SELL`/`NEUTRAL` — so in a real run the
 *     transcript's advocate statements come from the ±0.25 vote rule alone. That
 *     behaviour is preserved rather than "fixed": widening it would put indicator
 *     claims into the transcript that the legacy platform never made.
 */

import { fixedFormat, roundTo, signedFormat } from "../math.js";

const MAX_ADVOCATE_STATEMENTS = 6;
const MINIMUM_VOTE_FOR_ADVOCACY = 0.25;
const WIDE_STOP_PCT = 0.05;
const MINOR_OBJECTION_PENALTY = 0.02;
const MAX_MINOR_PENALTY = 0.15;

function conflictCount(consensus) {
  const value = consensus?.consensus?.conflicts ?? 0;
  if (Array.isArray(value)) return value.length;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function advocateCases(reports) {
  const bull = [];
  const bear = [];
  for (const report of reports) {
    const agent = String(report?.agent ?? "?");
    for (const signal of report?.signals ?? []) {
      const direction = String(signal?.signal ?? "").toLowerCase();
      if (!["bullish", "bearish"].includes(direction)) continue;
      const entry = {
        claim: `${signal?.name ?? "indicator"} is ${direction} (${signal?.detail ?? ""})`,
        evidence: `${agent}:${signal?.name ?? "signal"}`,
      };
      if (direction === "bullish") bull.push(entry);
      else bear.push(entry);
    }
    const score = Number(report?.vote?.directionalScore ?? 0);
    if (Math.abs(score) >= MINIMUM_VOTE_FOR_ADVOCACY) {
      const entry = {
        claim: `${agent} agent directional score ${signedFormat(score, 2)}`,
        evidence: `${agent}:vote`,
      };
      if (score > 0) bull.push(entry);
      else bear.push(entry);
    }
  }
  return [bull.slice(0, MAX_ADVOCATE_STATEMENTS), bear.slice(0, MAX_ADVOCATE_STATEMENTS)];
}

function skepticObjections(reports, consensus, regime, provenance) {
  const objections = [];
  const add = (id, severity, grounds, sustained) => objections.push({ id, severity, grounds, sustained });

  const conflicts = conflictCount(consensus);
  // One conflict is already priced into confluence; two or more is a split panel.
  add("S1", conflicts >= 2 ? "major" : "minor", `${conflicts} conflicting agent signal(s) across the panel`, conflicts >= 2);

  const bias = String(consensus?.bias ?? "NEUTRAL");
  const regimeName = String(regime?.regime ?? "UNKNOWN");
  const regimeConfidence = Number(regime?.confidence ?? 0);
  const contradicts = (bias === "BULLISH" && ["TRENDING_DOWN", "RANGING"].includes(regimeName))
    || (bias === "BEARISH" && ["TRENDING_UP", "RANGING"].includes(regimeName));
  add("S2", "major", `bias ${bias} contradicts ${regimeName} regime (confidence ${fixedFormat(regimeConfidence, 2)})`,
    contradicts && regimeConfidence >= 0.5);

  add("S3", "critical", "market data is stale beyond the freshness threshold", Boolean(provenance?.stale));
  // Informational: synthetic origin already discounts the freshness factor.
  add("S4", "minor", "analysis is built on clearly-labeled synthetic data", false);

  const confidence = Number(consensus?.confidence ?? 0);
  add("S5", "major", `conviction ${fixedFormat(confidence, 2)} is below the 0.50 action threshold`,
    ["BULLISH", "BEARISH"].includes(bias) && confidence < 0.5);

  const voting = reports.filter((report) => Boolean(report?.vote?.votes));
  const abstained = reports.length - voting.length;
  // Informational: abstentions already reduce the voting base.
  add("S6", "minor", `${abstained} of ${reports.length} agent(s) abstained for lack of data`, false);

  return objections;
}

function riskCriticObjections(setup, riskLimits) {
  if (!setup) {
    return [{ id: "R0", severity: "minor", grounds: "no concrete trade setup to challenge", sustained: false }];
  }
  const objections = [];
  const minimumRiskReward = Number(riskLimits?.minRiskReward ?? 1.5);
  const riskReward = Number(setup.riskReward ?? 0);
  if (riskReward < minimumRiskReward) {
    objections.push({
      id: "R1",
      severity: "major",
      grounds: `setup risk/reward ${fixedFormat(riskReward, 2)} below the ${fixedFormat(minimumRiskReward, 2)} minimum`,
      sustained: true,
    });
  }
  const reference = Number(setup.entry?.reference);
  const stopLoss = Number(setup.stopLoss);
  const stopPct = Number.isFinite(reference) && Number.isFinite(stopLoss) && reference > 0
    ? Math.abs(reference - stopLoss) / reference
    : 0;
  if (stopPct > WIDE_STOP_PCT) {
    objections.push({
      id: "R2",
      severity: "minor",
      grounds: `stop is ${fixedFormat(stopPct * 100, 1)}% away — very wide for one position`,
      sustained: true,
    });
  }
  return objections;
}

export function runDebate(reports, consensus, regime, setup, provenance, riskLimits) {
  const bias = String(consensus?.bias ?? "NEUTRAL");
  const confidence = Number(consensus?.confidence ?? 0);

  const [bullCase, bearCase] = advocateCases(reports);
  const objections = skepticObjections(reports, consensus, regime, provenance);
  const riskObjections = riskCriticObjections(setup, riskLimits);

  const sustained = (severity) => objections.filter((objection) => objection.severity === severity && objection.sustained);
  const critical = sustained("critical");
  const major = sustained("major");
  const minor = sustained("minor");

  let verdictBias = bias;
  let adjustment = 0;
  const reasoning = [];
  if (critical.length > 0) {
    verdictBias = "NO_TRADE";
    adjustment = -Math.max(0.25, confidence * 0.5);
    reasoning.push(`sustained critical objection: ${critical[0].grounds}`);
  } else if (major.length >= 2) {
    verdictBias = "NEUTRAL";
    adjustment = -0.15;
    reasoning.push(`${major.length} sustained major objections — bias downgraded to NEUTRAL`);
  } else if (major.length === 1) {
    adjustment = -0.1;
    reasoning.push(`sustained major objection: ${major[0].grounds}`);
  }
  if (minor.length > 0 && verdictBias !== "NO_TRADE") {
    adjustment = Math.max(adjustment - MINOR_OBJECTION_PENALTY * minor.length, -MAX_MINOR_PENALTY);
  }
  const adjusted = Math.max(0, Math.min(confidence, roundTo(confidence + adjustment, 4)));

  return {
    motion: `Sustain ${bias} bias at ${fixedFormat(confidence, 2)} confidence`,
    rounds: [
      { role: "bull-advocate", statements: bullCase },
      { role: "bear-advocate", statements: bearCase },
      { role: "skeptic", objections },
      { role: "risk-critic", objections: riskObjections },
    ],
    verdict: {
      bias: verdictBias,
      confidence: adjusted,
      confidenceAdjustment: roundTo(adjusted - confidence, 4),
      reasoning: reasoning.length ? reasoning : ["no sustained objections — bias stands as proposed"],
    },
  };
}
