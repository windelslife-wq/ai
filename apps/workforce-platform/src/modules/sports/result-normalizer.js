/**
 * Result normalizer — the port of `Aegis\Sports\SportsResultNormalizer`.
 *
 * Legacy's summary: *"Validates provider result payloads before
 * verification/persistence."* It is a separate class from the fixture normalizer
 * because a result is a different kind of claim: a fixture says something is
 * scheduled, a result says it happened and how it ended, and the second one is what
 * settlement and calibration training data are eventually built on.
 *
 * Three rules carry the weight:
 *
 *  1. **Scores exist only for `FINISHED`.** A `VOID`, `CANCELLED`, `POSTPONED` or
 *     `SUSPENDED` result stores `null` scores, never `0`. Writing `0-0` for a
 *     postponed match would fabricate a scoreline, and `NULL` — "no score was
 *     reported" — is a different fact from "no goals were scored".
 *  2. **A `FINISHED` result must carry two non-negative integers**, validated as
 *     integers and not merely as numbers. `2.5` goals is not a football score, and
 *     accepting it would put a non-integer into a column typed `INT`.
 *  3. **`verified` is always `false` here.** Ingestion reports; a human verifies.
 *     The flag this returns is never read as authority — `verifyResult()` is a
 *     separate, separately-authorized step.
 *
 * The raw payload is returned under `payload` so the stored row can be compared
 * against what actually arrived, which matters most exactly when a refusal has to be
 * explained later.
 *
 * Error messages are byte-identical to legacy's, for the same reason the fixture
 * normalizer's are: they are truncated to 200 characters and stored in the sync
 * run's `errors` array, so they are operator-facing evidence — and because this
 * class is a subject of the PHP differential harness (**F-26**).
 */

/** The five result statuses legacy accepts. `SCHEDULED` and `LIVE` are not among them: a result is an outcome. */
export const RESULT_STATUSES = Object.freeze(["FINISHED", "VOID", "CANCELLED", "POSTPONED", "SUSPENDED"]);

const RESULT_REQUIRED = Object.freeze(["externalId", "status", "sourceTimestamp"]);

function phpIsset(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/**
 * PHP's `filter_var($value, FILTER_VALIDATE_INT)`.
 *
 * Not `Number.isInteger`. The differences that matter here:
 *
 *  - a numeric **string** of an integer passes (`"2"` → `2`), because providers
 *    send JSON in which a score may well be quoted;
 *  - a float fails even when it is whole in value but not in text (`"2.5"` fails,
 *    and so does `2.5`), while PHP stringifies a whole float (`42.0` → `"42"`) and
 *    accepts it — reproduced here so a provider sending `2.0` is treated the same
 *    way on both sides;
 *  - surrounding whitespace is allowed, as PHP allows it;
 *  - a boolean is stringified first, so `true` → `"1"` passes and `false` → `""`
 *    fails. That is PHP's behaviour and it is reproduced rather than "corrected",
 *    because a differential harness would report the correction as a divergence and
 *    the correction would buy nothing: no provider sends a boolean score.
 *  - hexadecimal is refused (PHP needs `FILTER_FLAG_ALLOW_HEX` for that).
 *
 * @param {unknown} value
 * @returns {number|null} the integer, or `null` when PHP's filter would return `false`
 */
export function phpFilterValidateInt(value) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "boolean") {
    text = value ? "1" : "";
  } else if (typeof value === "string") {
    text = value;
  } else {
    return null;
  }
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Normalize one provider result (legacy `SportsResultNormalizer::normalize`).
 *
 * @param {unknown} raw the provider's payload for one result
 * @param {string} provider the provider's `id()`, stamped on as provenance
 * @returns {{provider: string, externalId: string, status: string,
 *   homeScore: number|null, awayScore: number|null, sourceTimestamp: string,
 *   verified: false, payload: Record<string, unknown>}}
 * @throws {Error} with legacy's exact message when a required field is missing, the
 *   status is not one of the five, or a `FINISHED` result's scores are not two
 *   non-negative integers
 */
export function normalizeResult(raw, provider) {
  if (!raw || typeof raw !== "object") throw new Error("result missing externalId");
  const source = raw;

  for (const field of RESULT_REQUIRED) {
    // `!isset($raw[$f]) || $raw[$f] === ''` — a strict empty comparison, with no
    // trim and no cast, exactly as the odds normalizer does it and unlike the
    // fixture normalizer's trimmed cast. The three gates are not the same gate.
    if (!phpIsset(source, field) || source[field] === "") {
      throw new Error(`result missing ${field}`);
    }
  }

  const status = String(source.status).toUpperCase();
  if (!RESULT_STATUSES.includes(status)) throw new Error("result status invalid");

  const finished = status === "FINISHED";
  let homeScore = null;
  let awayScore = null;
  if (finished) {
    // `!isset(home, away) || filter_var(home, INT) === false || filter_var(away, INT)
    // === false || (int) home < 0 || (int) away < 0` — one refusal for all five
    // ways a scoreline can be wrong, because the operator's remedy is the same.
    const home = phpIsset(source, "homeScore") ? phpFilterValidateInt(source.homeScore) : null;
    const away = phpIsset(source, "awayScore") ? phpFilterValidateInt(source.awayScore) : null;
    if (home === null || away === null || home < 0 || away < 0) {
      throw new Error("finished result scores invalid");
    }
    homeScore = home;
    awayScore = away;
  }

  return {
    provider: String(provider),
    externalId: String(source.externalId),
    status,
    homeScore,
    awayScore,
    // Cast to string, not validated as a timestamp: a result's `sourceTimestamp` is
    // the provider's own claim about when it observed the outcome, and it is stored
    // as evidence rather than used for arithmetic. The fixture normalizer parses and
    // re-formats its equivalent because that one is compared and ordered.
    sourceTimestamp: String(source.sourceTimestamp),
    verified: false,
    payload: source,
  };
}
