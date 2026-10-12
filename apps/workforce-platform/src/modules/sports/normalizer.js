/**
 * Sports data normalizer — the port of `Aegis\Sports\SportsDataNormalizer`.
 *
 * Legacy's own summary: *"Validates and converts a provider fixture into the
 * WINDELS-neutral shape."* It is the boundary the provider interface exists to
 * enforce — `SportsDataProvider` documents that its return values are
 * *"normalized only by SportsDataNormalizer"* — so no application layer ever
 * consumes a raw provider payload. A fixture that cannot be validated is refused
 * here and counted as an invalid record by the sync service, rather than being
 * stored with a plausible-looking empty field in it.
 *
 * Two parity decisions, both deliberate and both recorded as divergences in
 * `docs/migration/PHASE15_SPORTS_FOUNDATION.md`:
 *
 *  1. **Timestamps use legacy's `gmdate('c')` shape** — `2026-10-12T01:02:03+00:00`,
 *     second precision, explicit offset — via the shared helper in
 *     `src/lib/php-date.js`, for the same reason the broker normalizer does it
 *     (BC-1): this class is pure, synchronous and dependency-free on both sides,
 *     which makes it the cheapest possible subject for the PHP↔Node differential
 *     harness that F-26 has been asking for since Phase 4. A formatting
 *     difference would fail every comparison on a technicality. The repository
 *     converts to the platform's canonical `…Z` shape when writing a timestamp
 *     *column* (SP-1); the normalized record keeps the legacy shape.
 *
 *  2. **Error messages are byte-identical to legacy's** — `"fixture missing kickoff"`,
 *     not a rewritten sentence — for the same reason. The sync service truncates
 *     them to 200 characters and stores them in the run's `errors` array, so
 *     these strings are operator-facing evidence.
 *
 * Like the broker normalizer, this module throws plain `Error`s with legacy's
 * messages; the caller decides what that means (the sync service counts it, a
 * route would translate it to a 400).
 */

import { formatGmdateC, parseStrictInstant } from "../../lib/php-date.js";

/** The six fixture statuses legacy accepts, and the only six that can be stored. */
export const FIXTURE_STATUSES = Object.freeze([
  "SCHEDULED",
  "LIVE",
  "FINISHED",
  "POSTPONED",
  "CANCELLED",
  "SUSPENDED",
]);

const FIXTURE_REQUIRED = Object.freeze(["externalId", "homeTeam", "awayTeam", "competition", "kickoff"]);
const ODDS_REQUIRED = Object.freeze(["market", "selection", "decimalOdds", "observedAt"]);
const FORM_FIELDS = Object.freeze([
  "homeGoalsPerMatch",
  "awayGoalsPerMatch",
  "homeConcededPerMatch",
  "awayConcededPerMatch",
]);

/* -------------------------------------------------------------------------- */
/* PHP value semantics                                                         */
/* -------------------------------------------------------------------------- */

/** PHP's `isset($array[$key])`: present **and** not null. */
function phpIsset(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/** PHP's `is_array()`: true for a list *and* a map — see divergence D-20 (Phase 14). */
function phpIsArray(value) {
  return Array.isArray(value) || isRecord(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PHP's `is_numeric()`. Notably **`is_numeric(true)` is false** while
 * `Number(true)` is `1`, and a numeric string with surrounding whitespace is
 * accepted — both of which `Number.isFinite(Number(x))` alone would get wrong.
 */
function phpIsNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return Number.isFinite(Number(trimmed));
}

/**
 * PHP's `(string)` cast, which is not `String()`.
 *
 * The difference matters at exactly one place: a required field holding an array.
 * PHP casts it to the literal text `"Array"` — non-empty, so the field *passes*
 * the presence check — whereas `String([])` is `""` and `String({})` is
 * `"[object Object]"`. Matching the cast keeps a malformed payload refused (or
 * accepted) for the same reason on both sides instead of for two different ones.
 *
 * @param {unknown} value
 * @returns {string}
 */
function phpStringCast(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "";
  if (Array.isArray(value) || isRecord(value)) return "Array";
  return String(value);
}

/**
 * Normalize the injectable clock.
 *
 * `now` is a **function returning epoch milliseconds** — the same convention the
 * broker normalizer uses (Phase 14) — so a caller wiring both modules hands one
 * clock to each rather than a function to one and a number to the other. A number
 * is accepted too, because both are easy to write by hand in a test and refusing
 * one shape buys nothing.
 *
 * Accepting only the numeric shape was a defect, and the differential harness
 * caught it on its first case: a caller passed a function, `new Date(fn)` produced
 * an Invalid Date, and a **valid** fixture that simply omitted `sourceTimestamp`
 * was refused as `"sourceTimestamp is invalid"`. A wrong clock convention does not
 * look like a wrong clock convention — it looks like the provider sent bad data.
 *
 * @param {(() => number)|number|undefined} now
 * @returns {() => number}
 */
function toClock(now) {
  if (typeof now === "function") return now;
  if (typeof now === "number" && Number.isFinite(now)) return () => now;
  return () => Date.now();
}

/** PHP's `!empty()`. `0`, `0.0`, `"0"`, `""`, `false`, `null` and `[]` are all empty. */
function phpNotEmpty(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Legacy's private `timestamp()`: `null` or `''` means **now**, anything else is
 * parsed as a date string and converted to UTC. An unparseable value throws
 * rather than silently becoming "now" — a record that cannot say when it was
 * observed must not be allowed to claim it is fresh.
 *
 * Unlike the broker normalizer's equivalent, this one has **no epoch-seconds
 * branch**: legacy passes the value straight to `DateTimeImmutable`.
 *
 * **SP-2 — parsing is stricter than legacy's, and deliberately so.** PHP's
 * `DateTime` accepts relative text (`"now"`, `"+1 day"`) and loose forms
 * (`"20261012"`); `Date` accepts numeric strings as *years* (`new Date("12345")`
 * is the year 12345 — defect D-12, where `?from=12345` produced an empty window
 * that looked like a working filter) and reads `"0"` as the year 2000 where PHP
 * throws. `parseStrictInstant` accepts a calendar instant with an optional time
 * and offset and refuses everything else, so the two runtimes can only disagree by
 * both refusing. A naive string with no offset is interpreted in the host's
 * default timezone by PHP and by `Date` alike, so parity there holds only while
 * both hosts share a timezone; the HTTP provider contract requires UTC ISO-8601
 * and the sandbox provider always emits `gmdate('c')`, which is why this is a
 * documented edge rather than a live defect.
 *
 * @param {unknown} value
 * @param {() => number} clock epoch milliseconds
 * @returns {string}
 */
function timestamp(value, clock) {
  if (value === null || value === undefined || value === "") return formatGmdateC(new Date(clock()));
  const date = parseStrictInstant(value);
  if (date === null) throw new Error("sourceTimestamp is invalid");
  return formatGmdateC(date);
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one provider fixture (legacy `SportsDataNormalizer::fixture`).
 *
 * @param {unknown} raw the provider's payload for a single fixture
 * @param {string} provider the provider's `id()`, stamped onto the record as provenance
 * @param {{now?: (() => number)|number}} [options] injectable clock in epoch milliseconds
 * @returns {Record<string, unknown>}
 * @throws {Error} with legacy's exact message when a required field is missing or blank,
 *   when `kickoff` cannot be parsed, or when `status` is not one of the six
 */
export function normalizeFixture(raw, provider, { now } = {}) {
  if (!isRecord(raw) && !Array.isArray(raw)) throw new Error("fixture missing externalId");
  const source = raw;
  const clock = toClock(now);

  for (const field of FIXTURE_REQUIRED) {
    // `!isset($raw[$field]) || trim((string) $raw[$field]) === ''`
    if (!phpIsset(source, field) || phpStringCast(source[field]).trim() === "") {
      throw new Error(`fixture missing ${field}`);
    }
  }

  let kickoff;
  try {
    kickoff = timestamp(source.kickoff, clock);
  } catch {
    // Legacy wraps the parse failure in its own message rather than leaking
    // DateTime's, which names the offending text.
    throw new Error("fixture kickoff is invalid");
  }

  const status = phpStringCast(source.status ?? "SCHEDULED").toUpperCase();
  if (!FIXTURE_STATUSES.includes(status)) throw new Error("fixture status is invalid");

  return {
    provider: String(provider),
    externalId: phpStringCast(source.externalId),
    sport: phpStringCast(source.sport ?? "football").toLowerCase(),
    homeTeam: phpStringCast(source.homeTeam).trim(),
    awayTeam: phpStringCast(source.awayTeam).trim(),
    competition: phpStringCast(source.competition).trim(),
    kickoff,
    status,
    sourceTimestamp: timestamp(source.sourceTimestamp ?? null, clock),
    simulated: phpNotEmpty(source.simulated),
    context: normalizeContext(source.context ?? null),
    // `array_keys($raw)` — what the provider actually sent, kept so a record that
    // was refused downstream can be compared against what arrived rather than
    // against what was expected.
    fieldsPresent: Object.keys(source),
  };
}

/**
 * Legacy's private `context()`: optional verified match context, where **missing
 * or malformed context is dropped and returned as `null` — never guessed or
 * invented**. That docblock is the module's honesty rule and it is preserved
 * exactly: `recentForm` is accepted only when all four per-match rates are
 * present, numeric and non-negative, so three of four is treated as none.
 *
 * Legacy's final line reads `$out === null ? null : (count($out) ? $out : null)`.
 * `$out` is initialised to `[]` and is never assigned `null`, so the first branch
 * is unreachable dead code; the effective behaviour is "an empty context is
 * `null`". Ported as the effective behaviour, and recorded as divergence SP-3 so
 * the omission is a decision rather than an oversight.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function normalizeContext(raw) {
  if (!phpIsArray(raw)) return null;
  const source = raw;
  const out = {};

  if (phpIsset(source, "recentForm") && phpIsArray(source.recentForm)) {
    const formSource = source.recentForm;
    const form = {};
    let complete = true;
    for (const key of FORM_FIELDS) {
      if (phpIsset(formSource, key) && phpIsNumeric(formSource[key]) && Number(formSource[key]) >= 0) {
        form[key] = Number(formSource[key]);
      } else {
        complete = false;
      }
    }
    // `count($form) === 4` — all four or nothing.
    if (complete) {
      form.source = typeof (formSource.source ?? null) === "string" ? formSource.source : null;
      out.recentForm = form;
    }
  }

  for (const key of ["marketLiquidity", "restDays"]) {
    if (phpIsset(source, key) && phpIsNumeric(source[key]) && Number(source[key]) >= 0) {
      out[key] = Number(source[key]);
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

/* -------------------------------------------------------------------------- */
/* Odds                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one odds observation (legacy `SportsDataNormalizer::odds`).
 *
 * The presence check here is **stricter and differently shaped** than the
 * fixture's: legacy compares `$raw[$field] === ''` with no `trim()` and no cast,
 * so a whitespace-only market name passes this gate and is trimmed afterwards,
 * while a `decimalOdds` of `0` passes presence and is refused by the numeric
 * check. Preserved as written rather than unified — the two gates are not the
 * same gate, and making them so would change which payloads are accepted.
 *
 * Decimal odds must be numeric, finite and **strictly greater than 1.0**, so
 * "evens" (`1.00`), a zero and a negative are all refused: a decimal price of 1.0
 * or below is not a price, and storing one would let a later value calculation
 * divide by something that cannot be a probability.
 *
 * @param {unknown} raw
 * @param {string} provider
 * @param {{now?: number}} [options]
 * @returns {Record<string, unknown>}
 * @throws {Error} with legacy's exact message
 */
export function normalizeOdds(raw, provider, { now } = {}) {
  if (!isRecord(raw) && !Array.isArray(raw)) throw new Error("odds missing market");
  const source = raw;
  const clock = toClock(now);

  for (const field of ODDS_REQUIRED) {
    if (!phpIsset(source, field) || source[field] === "") {
      throw new Error(`odds missing ${field}`);
    }
  }

  const decimal = source.decimalOdds;
  if (!phpIsNumeric(decimal) || Number(decimal) <= 1.0 || !Number.isFinite(Number(decimal))) {
    throw new Error("decimal odds are invalid");
  }

  return {
    provider: String(provider),
    market: phpStringCast(source.market).trim(),
    selection: phpStringCast(source.selection).trim(),
    decimalOdds: Number(decimal),
    observedAt: timestamp(source.observedAt, clock),
  };
}
