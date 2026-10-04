// Empirical goals baseline. NOT trained AI; confidence is evidence reliability, not a calibrated win probability.
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export function analyze(
  fixture,
  homeForm,
  awayForm,
  { now = Date.now() } = {},
) {
  const parse = (input) => {
    try {
      const a = typeof input === "string" ? JSON.parse(input) : input;
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  const recent = (input, teamId) =>
    parse(input)
      .filter(
        (m) =>
          ["FT", "AET", "PEN"].includes(m.status) &&
          Date.parse(m.timestamp) < now &&
          Number.isInteger(m.homeGoals) &&
          Number.isInteger(m.awayGoals) &&
          (m.homeId === teamId || m.awayId === teamId),
      )
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 10);
  const home = recent(homeForm, fixture.homeTeamId),
    away = recent(awayForm, fixture.awayTeamId);
  const venue = (rows, id, isHome) =>
    rows.filter((m) => (isHome ? m.homeId === id : m.awayId === id));
  const h = venue(home, fixture.homeTeamId, true),
    a = venue(away, fixture.awayTeamId, false);
  const metrics = (rows, teamId) => {
    const n = rows.length;
    const over = rows.filter((m) => m.homeGoals + m.awayGoals >= 2).length;
    const goals = rows.reduce((v, m) => v + m.homeGoals + m.awayGoals, 0);
    const scored = rows.map((m) =>
      m.homeId === teamId ? m.homeGoals : m.awayGoals,
    );
    const conceded = rows.map((m) =>
      m.homeId === teamId ? m.awayGoals : m.homeGoals,
    );
    return {
      n,
      over,
      goals,
      averageTotalGoals: n ? goals / n : null,
      averageScored: n ? scored.reduce((v, x) => v + x, 0) / n : null,
      averageConceded: n ? conceded.reduce((v, x) => v + x, 0) / n : null,
      scoringConsistency: n ? scored.filter((x) => x > 0).length / n : null,
      concedingConsistency: n ? conceded.filter((x) => x > 0).length / n : null,
    };
  };
  const H = metrics(home, fixture.homeTeamId),
    A = metrics(away, fixture.awayTeamId),
    H5 = metrics(home.slice(0, 5), fixture.homeTeamId),
    A5 = metrics(away.slice(0, 5), fixture.awayTeamId),
    VH = metrics(h, fixture.homeTeamId),
    VA = metrics(a, fixture.awayTeamId);
  const newest = Math.max(
    Date.parse(home[0]?.timestamp) || 0,
    Date.parse(away[0]?.timestamp) || 0,
  );
  const explanation = {
    homeLast10: H,
    awayLast10: A,
    homeLast5: H5,
    awayLast5: A5,
    homeVenue: VH,
    awayVenue: VA,
    method:
      "Smoothed historical over-1.5 frequencies: (hits+2)/(matches+4); 20% home last ten, 20% away last ten, 15% home last five, 15% away last five, 15% home venue, 15% away venue. Confidence is data completeness/freshness. No bookmaker odds in the probability formula.",
    excluded:
      "Injuries, H2H and league environment are not included without verified usable samples.",
  };
  if (
    home.length < 8 ||
    away.length < 8 ||
    h.length < 3 ||
    a.length < 3 ||
    !newest ||
    now - newest > 30 * 86400000
  )
    return { reason: "DATA_UNAVAILABLE", explanation };
  const rate = (m) => (m.over + 2) / (m.n + 4);
  const probability = clamp(
    0.2 * rate(H) +
      0.2 * rate(A) +
      0.15 * rate(H5) +
      0.15 * rate(A5) +
      0.15 * rate(VH) +
      0.15 * rate(VA),
    0.01,
    0.99,
  );
  const quality = clamp(
    Math.round(
      (40 * Math.min(H.n, A.n)) / 10 +
        (40 * Math.min(VH.n, VA.n)) / 5 +
        20 * (1 - Math.min(1, (now - newest) / (30 * 86400000))),
    ),
    0,
    100,
  );
  const confidence = clamp(
    Math.round(
      0.75 * quality + 0.25 * Math.min(100, 200 * Math.abs(probability - 0.5)),
    ),
    0,
    95,
  );
  const scoringPenalty = Math.round(
    10 * (1 - (H.scoringConsistency + A.scoringConsistency) / 2),
  );
  const risk = clamp(
    Math.round(
      100 * (1 - probability) * 0.6 + (100 - quality) * 0.4 + scoringPenalty,
    ),
    0,
    100,
  );
  return {
    probability: Number(probability.toFixed(6)),
    confidence,
    quality,
    risk,
    explanation: {
      ...explanation,
      probability,
      quality,
      confidence,
      risk,
      scoringPenalty,
      calibration: "NOT_EMPIRICALLY_CALIBRATED",
    },
  };
}
