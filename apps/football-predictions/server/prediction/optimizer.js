import { multiply, compare } from "./odds.js";
export function optimize(
  candidates,
  {
    maxSelections = 8,
    maxCandidates = 24,
    maxCombinations = 50000,
    restrictTeams = true,
    maxPerCompetition = 2,
  } = {},
) {
  if (
    !Number.isInteger(maxSelections) ||
    maxSelections < 2 ||
    maxSelections > 12 ||
    !Number.isInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > 30 ||
    !Number.isInteger(maxCombinations) ||
    maxCombinations < 1 ||
    maxCombinations > 100000 ||
    !Number.isInteger(maxPerCompetition) ||
    maxPerCompetition < 1
  )
    throw new Error("INVALID_LIMITS");
  for (const c of candidates)
    if (
      !Number.isFinite(c.probability) ||
      c.probability <= 0 ||
      c.probability >= 1 ||
      !Number.isFinite(c.risk) ||
      c.risk < 0 ||
      c.risk > 100 ||
      compare(c.price, "1") <= 0 ||
      !Number.isSafeInteger(c.fixtureId) ||
      !c.competitionId ||
      !c.homeTeamId ||
      !c.awayTeamId
    )
      throw new Error("INVALID_CANDIDATE");
  const ranked = [...candidates]
    .sort(
      (a, b) =>
        b.probability - a.probability ||
        a.risk - b.risk ||
        a.fixtureId - b.fixtureId,
    )
    .slice(0, maxCandidates);
  let best = null,
    tested = 0,
    qualified = 0,
    correlationRejections = 0,
    truncated = false;
  function visit(start, picks) {
    for (let i = start; i < ranked.length; i++) {
      if (tested >= maxCombinations) {
        truncated = true;
        return;
      }
      const c = ranked[i];
      if (
        picks.some(
          (p) =>
            p.fixtureId === c.fixtureId ||
            (restrictTeams &&
              [p.homeTeamId, p.awayTeamId].some(
                (t) => t === c.homeTeamId || t === c.awayTeamId,
              )),
        ) ||
        picks.filter((p) => p.competitionId === c.competitionId).length >=
          maxPerCompetition
      ) {
        correlationRejections++;
        continue;
      }
      const next = [...picks, c];
      tested++;
      const odds = multiply(next.map((p) => p.price));
      if (compare(odds, "4") > 0) continue;
      if (next.length >= 2 && compare(odds, "2") >= 0) {
        qualified++;
        const probability = next.reduce((v, p) => v * p.probability, 1);
        const risk = next.reduce((v, p) => v + p.risk, 0) / next.length;
        const utility = probability * (1 - risk / 100);
        if (!best || utility > best.utility)
          best = { selections: next, odds, probability, risk, utility };
      }
      if (next.length < maxSelections) visit(i + 1, next);
    }
  }
  visit(0, []);
  return {
    status: best ? "TICKET QUALIFIED" : "NO QUALIFYING TICKET",
    ticket: best,
    tested,
    qualified,
    correlationRejections,
    truncated,
    candidatesExcludedByLimit: Math.max(0, candidates.length - ranked.length),
    correlationMethod: "CONFIGURABLE_HEURISTIC",
    probabilityAssumption: "INDEPENDENCE_NOT_STATISTICALLY_VERIFIED",
  };
}
