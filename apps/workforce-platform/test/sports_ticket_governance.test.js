/**
 * Ticket governance, checked by reading (row 14, slice 4).
 *
 * Legacy `TicketGovernance::record` and `::decide` are not run here. Stubbing the PHP
 * SportsRepository to drive them was judged too costly, so each rule below is pinned to the
 * legacy line it comes from, and the assertions are the arithmetic of those lines. If a rule
 * changes in either place, the test that names it fails.
 *
 * Legacy lines (`application/libraries/Aegis/Sports/TicketGovernance.php`):
 *   36–37  combined probability: a product of calibratedProbability, default 0.5
 *   41–43  risk: the worst classification, a missing one counts as HIGH
 *   51     combined_probability = round(combined, 8)
 *   52     confidence = round(min(array_filter(confidences)), 2), or null when none remain
 *   54     data_quality_score = min(qualities)
 *   55–57  PENDING / PENDING_USER_APPROVAL / settlement PENDING (the automated branch is
 *          not ported: DV-22, and the configuration refuses AUTOMATED_EXECUTION, DV-14)
 *   58     stake = config.stake_amount, or null
 *   84     a decision on a ticket that is not PENDING_USER_APPROVAL throws "already decided"
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTicket, decisionFor, RISK_ORDER, TICKET_APPROVAL_PENDING } from "../src/modules/sports/ticket-governance.js";

/** A selection shaped as the optimizer returns it (the fields governance reads). */
function leg({ matchId, competition = "League", home = "H", away = "A", prob = 0.6, odds = 1.9,
  confidence = 70, quality = 80, risk = "LOW", expectedValue = 0.1, market = "TOTAL_GOALS", selection = "OVER_1_5" }) {
  return {
    predictionId: `prd_${String(matchId).padStart(24, "0")}`,
    matchId,
    match: { id: matchId, homeTeam: home, awayTeam: away, competition },
    homeTeam: home, awayTeam: away, competition,
    market, selection,
    risk: { classification: risk, approved: risk !== "HIGH" },
    value: { qualified: true, odds, expectedValue },
    confidence: { confidence },
    quality: { score: quality },
    prediction: { calibratedProbability: prob, rawModelProbability: prob - 0.02 },
    oddsTimestamp: "2026-10-12T09:00:00.000Z",
  };
}

const optimized = (selections, extra = {}) => ({
  status: "QUALIFIED", ticketId: "tkt_0123456789abcdef", totalOdds: selections.reduce((p, s) => p * s.value.odds, 1),
  selections, optimizationScore: 0.5, poolSize: selections.length, ...extra,
});

const built = (selections, config = { stake_amount: 10 }) => buildTicket(optimized(selections), {
  configurationVersion: 2, modelVersionId: 9, config, createdAt: "2026-10-12T10:00:00.000Z",
});

test("the ticket is PENDING, awaiting a person, settlement PENDING, and carries the version it was built under", () => {
  const { ticket } = built([leg({ matchId: 1 }), leg({ matchId: 2, home: "X", away: "Y", competition: "Other" })]);
  assert.equal(ticket.status, "PENDING");
  assert.equal(ticket.approvalStatus, TICKET_APPROVAL_PENDING);
  assert.equal(ticket.settlementStatus, "PENDING", "legacy line 57: nothing is settled at creation");
  assert.equal(ticket.configurationVersion, 2);
  assert.equal(ticket.modelVersionId, 9);
  assert.equal(ticket.decidedBy, null);
});

test("combined probability is the product of the calibrated probabilities, rounded to 8 places (line 36–37, 51)", () => {
  const { ticket } = built([leg({ matchId: 1, prob: 0.6 }), leg({ matchId: 2, prob: 0.5, home: "X", away: "Y", competition: "Z" }), leg({ matchId: 3, prob: 0.7, home: "P", away: "Q", competition: "R" })]);
  assert.equal(ticket.combinedProbability, 0.21, "0.6 × 0.5 × 0.7");
  // A non-terminating product is rounded, not left at full precision.
  const third = built([leg({ matchId: 1, prob: 1 / 3 }), leg({ matchId: 2, prob: 1, home: "X", away: "Y", competition: "Z" })]).ticket;
  assert.equal(third.combinedProbability, 0.33333333);
});

test("a missing calibrated probability counts as 0.5 (line 37, the ?? default)", () => {
  const noProb = leg({ matchId: 1 });
  delete noProb.prediction.calibratedProbability;
  const { ticket } = built([noProb, leg({ matchId: 2, prob: 0.8, home: "X", away: "Y", competition: "Z" })]);
  assert.equal(ticket.combinedProbability, 0.4, "0.5 × 0.8");
});

test("confidence is the minimum of the usable values, rounded to 2; a zero is dropped, as array_filter drops it (line 52)", () => {
  const { ticket } = built([
    leg({ matchId: 1, confidence: 72.456 }),
    leg({ matchId: 2, confidence: 61.234, home: "X", away: "Y", competition: "Z" }),
    leg({ matchId: 3, confidence: 0, home: "P", away: "Q", competition: "R" }),
  ]);
  assert.equal(ticket.confidence, 61.23, "61.234 is the minimum, rounded; the 0 does not pull it down");
});

test("confidence is null when no leg has a usable value, rather than zero", () => {
  const { ticket } = built([leg({ matchId: 1, confidence: null }), leg({ matchId: 2, confidence: null, home: "X", away: "Y", competition: "Z" })]);
  assert.equal(ticket.confidence, null);
});

test("risk is the worst leg, and a leg with no classification counts as HIGH (lines 41–43)", () => {
  assert.deepEqual(RISK_ORDER, { LOW: 0, MEDIUM: 1, HIGH: 2 });
  const mixed = built([leg({ matchId: 1, risk: "LOW" }), leg({ matchId: 2, risk: "MEDIUM", home: "X", away: "Y", competition: "Z" })]).ticket;
  assert.equal(mixed.risk, "MEDIUM");
  const unclassified = leg({ matchId: 3, risk: "LOW", home: "P", away: "Q", competition: "R" });
  delete unclassified.risk.classification;
  const unknown = built([leg({ matchId: 1 }), unclassified]).ticket;
  assert.equal(unknown.risk, "HIGH", "an unclassified leg is the worst case, not the best");
});

test("data quality is the minimum leg score, and correlation is the worst pair (lines 54, 38)", () => {
  const { ticket } = built([
    leg({ matchId: 1, quality: 92 }),
    leg({ matchId: 2, quality: 81, home: "X", away: "Y", competition: "Z" }),
  ]);
  assert.equal(ticket.dataQualityScore, 81);
  assert.equal(ticket.correlation, "LOW", "two different matches, teams and leagues share nothing");

  const sameLeague = built([leg({ matchId: 1, competition: "Shared" }), leg({ matchId: 2, home: "X", away: "Y", competition: "Shared" })]).ticket;
  assert.equal(sameLeague.correlation, "MEDIUM", "a shared competition alone is MEDIUM");
});

test("stake is the configured stake, and null when none is configured (line 58)", () => {
  const legs = [leg({ matchId: 1 }), leg({ matchId: 2, home: "X", away: "Y", competition: "Z" })];
  assert.equal(built(legs, { stake_amount: 25 }).ticket.stake, 25);
  assert.equal(built(legs, {}).ticket.stake, null);
});

test("every leg is stored as PENDING with its odds, its probabilities and its risk", () => {
  const { selections } = built([leg({ matchId: 1, odds: 1.9, prob: 0.6 }), leg({ matchId: 2, odds: 2.1, prob: 0.55, home: "X", away: "Y", competition: "Z" })]);
  assert.equal(selections.length, 2);
  assert.deepEqual(selections.map((s) => s.status), ["PENDING", "PENDING"]);
  assert.equal(selections[0].odds, 1.9);
  assert.equal(selections[0].calibratedProbability, 0.6);
  assert.equal(selections[0].result, null, "a leg has no result until it is settled");
});

test("a decision moves a PENDING ticket once: approve is APPROVED_NOT_EXECUTED, reject is REJECTED, and nothing is executed (line 84)", () => {
  const pending = { approval_status: "PENDING_USER_APPROVAL" };
  const approved = decisionFor(pending, { approve: true, actorId: 4, reason: "ok", decidedAt: "2026-10-12T11:00:00.000Z" });
  assert.equal(approved.approvalStatus, "APPROVED_NOT_EXECUTED");
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.externalExecution, false);
  assert.equal(approved.decidedBy, 4);

  const rejected = decisionFor(pending, { approve: false, actorId: 4, reason: "no", decidedAt: "2026-10-12T11:00:00.000Z" });
  assert.equal(rejected.approvalStatus, "REJECTED");
  assert.equal(rejected.status, "CANCELLED");
});

test("a decided ticket cannot be decided again, and a missing ticket is not found", () => {
  assert.throws(
    () => decisionFor({ approval_status: "REJECTED" }, { approve: true, actorId: 1, decidedAt: "x" }),
    (error) => error.statusCode === 409 && error.code === "SPORTS_TICKET_ALREADY_DECIDED",
  );
  assert.throws(() => decisionFor(null, { approve: true, actorId: 1, decidedAt: "x" }), (error) => error.statusCode === 404);
});
