// Finite decimal arithmetic: no binary floating-point multiplication.
export function decimal(value) {
  if (typeof value !== "string" || !/^\d{1,6}(\.\d{1,12})?$/.test(value))
    throw new Error("INVALID_ODDS");
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
export function multiply(values) {
  const result = values
    .map(decimal)
    .reduce(
      (a, b) => ({ units: a.units * b.units, scale: a.scale + b.scale }),
      { units: 1n, scale: 0 },
    );
  const text = result.units.toString().padStart(result.scale + 1, "0");
  return result.scale
    ? `${text.slice(0, -result.scale)}.${text.slice(-result.scale)}`
    : text;
}
export function compare(a, b) {
  a = decimal(a);
  b = decimal(b);
  const scale = Math.max(a.scale, b.scale);
  const difference =
    a.units * 10n ** BigInt(scale - a.scale) -
    b.units * 10n ** BigInt(scale - b.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function validateOdds(
  fixture,
  odds,
  { now = Date.now(), maxAgeSeconds = 900 } = {},
) {
  if (!fixture || !Number.isSafeInteger(fixture.id) || fixture.id <= 0)
    return "INVALID_FIXTURE";
  if (fixture.status !== "NS") return "INELIGIBLE_STATUS";
  const kickoff = Date.parse(fixture.kickoff);
  if (!Number.isFinite(kickoff) || kickoff <= now)
    return "FIXTURE_STARTED_OR_INVALID";
  if (!odds || odds.fixtureId !== fixture.id || odds.market !== "OVER_1_5")
    return "MARKET_OR_FIXTURE_MISMATCH";
  if (
    !Number.isSafeInteger(odds.bookmakerId) ||
    odds.bookmakerId <= 0 ||
    !odds.bookmaker
  )
    return "BOOKMAKER_UNAVAILABLE";
  if (
    odds.source !== "API_FOOTBALL" ||
    odds.verified !== true ||
    odds.manuallyAltered !== false
  )
    return "UNVERIFIED_SOURCE";
  try {
    if (compare(odds.price, "1") <= 0) return "INVALID_ODDS";
  } catch {
    return "INVALID_ODDS";
  }
  const timestamp = Date.parse(odds.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now)
    return "INVALID_TIMESTAMP";
  if (now - timestamp > maxAgeSeconds * 1000) return "STALE_ODDS";
  return null;
}
