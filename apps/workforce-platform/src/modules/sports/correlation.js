/**
 * Pairwise correlation between selections on one ticket (row 14, slice 4).
 *
 * Legacy `Aegis\Sports\CorrelationEngine::assess`, ported exactly. The function reads
 * `matchId`, `homeTeam`, `awayTeam`, `home_team`, `away_team` and `competition` from the
 * top level of each candidate, as legacy does.
 *
 * **F-39.** In legacy, the team and competition checks never fire in production. The
 * pipeline's candidate carries `homeTeam`, `awayTeam` and `competition` only under
 * `match`, so the top-level reads are always empty and only SAME_MATCH can trigger. This
 * module keeps the function as written. The ticket service's `candidateFor` (in
 * `ticket-service.js`) supplies the fields from `match`, which is the documented intent. The golden test
 * records both behaviours, so the difference is evidence rather than a silent change.
 *
 * Scores: HIGH 1.0, MEDIUM 0.5, LOW 0.0.
 */
import { phpEmpty } from "../../lib/php.js";

export const CORRELATION_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH"]);
export const CORRELATION_SCORES = Object.freeze({ HIGH: 1.0, MEDIUM: 0.5, LOW: 0.0 });

function teamsOf(candidate) {
  const teams = [];
  for (const key of ["homeTeam", "awayTeam", "home_team", "away_team"]) {
    const value = candidate?.[key];
    if (!phpEmpty(value)) teams.push(String(value));
  }
  return teams;
}

/**
 * Assess how one candidate correlates with the selections already chosen.
 *
 * @param {Record<string, any>} candidate
 * @param {Array<Record<string, any>>} selected
 * @returns {{ classification: 'LOW'|'MEDIUM'|'HIGH', score: number, reasons: string[] }}
 */
export function assessCorrelation(candidate, selected) {
  let level = "LOW";
  const reasons = [];
  const candidateTeams = teamsOf(candidate);

  for (const other of selected) {
    const candidateMatch = candidate?.matchId ?? null;
    if (candidateMatch !== null && candidateMatch === (other?.matchId ?? null)) {
      level = "HIGH";
      reasons.push("SAME_MATCH");
      break;
    }

    const sharedTeams = candidateTeams.filter((team) => teamsOf(other).includes(team));
    if (sharedTeams.length > 0) {
      level = "HIGH";
      reasons.push(`SAME_TEAM_${sharedTeams.join("+")}`);
    }

    const competition = candidate?.competition ?? null;
    if (!phpEmpty(competition) && competition === (other?.competition ?? null)) {
      if (level === "LOW") level = "MEDIUM";
      reasons.push("SAME_COMPETITION");
    }
  }

  return {
    classification: level,
    score: CORRELATION_SCORES[level],
    reasons: [...new Set(reasons)],
  };
}

/**
 * The worst pairwise classification across a set of selections, and the reasons from the
 * pairs that are HIGH or MEDIUM. Legacy `CorrelationEngine::classifySelections`: each
 * selection is assessed against the ones after it, which gives the same pairs.
 */
export function classifySelections(selections) {
  let worst = "LOW";
  let reasons = [];
  for (let i = 0; i < selections.length; i += 1) {
    const pair = assessCorrelation(selections[i], selections.slice(i + 1));
    if (pair.classification === "HIGH" || pair.classification === "MEDIUM") {
      reasons = [...reasons, ...pair.reasons];
    }
    if (CORRELATION_LEVELS.indexOf(pair.classification) > CORRELATION_LEVELS.indexOf(worst)) {
      worst = pair.classification;
    }
  }
  return { classification: worst, reasons: [...new Set(reasons)] };
}
