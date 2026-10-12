/**
 * PHP semantics that JavaScript does not provide, for the pure ports of legacy
 * sports classes (Phase 17).
 *
 * The differential harness (`test/sports_parity.test.js`) compares these ports
 * against PHP 8.2's own output to the last double. Every helper here exists because
 * a legacy line depends on a PHP rule that a naive JavaScript translation gets
 * wrong, and each one is pinned by a golden case rather than by reasoning:
 *
 *  - `phpRound` — PHP 8.2 `round()` **pre-rounds** to 15 significant digits before
 *    rounding, so `round(1.005, 2)` is `1.01`. `Math.round(1.005 * 100) / 100` is
 *    `1`. The existing `roundTo` in `analysis/math.js` is naive; this one is not.
 *  - `phpEmpty` — `empty()` treats `"0"`, `0`, `[]` and `{}` (an empty decoded JSON
 *    object is an empty PHP array) as false, which a truthiness check does not.
 *  - `phpIsNumeric` — `is_numeric()` accepts numeric strings with surrounding
 *    whitespace, and rejects hexadecimal, `true`, and `NaN`.
 *
 * Kept in `src/lib/` rather than in a module because nothing here is sports-specific;
 * `src/persistence/` must not import from `src/modules/`, and a helper that is used by
 * the pure layer and the storage layer belongs to neither.
 */

const POWERS_OF_TEN = Object.freeze(Array.from({ length: 23 }, (_, power) => Number(`1e${power}`)));

/** `10 ** power` computed from literals, so 10^0..10^22 are exact on every engine. */
function pow10(power) {
  const magnitude = Math.abs(power);
  return magnitude < POWERS_OF_TEN.length ? POWERS_OF_TEN[magnitude] : 10 ** magnitude;
}

/** `php_round_helper` for PHP_ROUND_HALF_UP: half away from zero. */
function roundHelper(value) {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

/**
 * PHP 8.2 `round($value, $places)`, PHP's pre-rounding algorithm (`_php_math_round`
 * before the 8.4 rewrite). Half away from zero; the value is first normalised to 15
 * significant digits so that decimal inputs such as `1.005` round the way a person
 * writing them down would expect.
 *
 * Non-finite values and zero are returned unchanged, as PHP does.
 *
 * @param {number} value
 * @param {number} [places=0]
 * @returns {number}
 */
export function phpRound(value, places = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return value;

  const precisionPlaces = 14 - Math.floor(Math.log10(Math.abs(value)));
  const f1 = pow10(places);
  let tmp;

  if (precisionPlaces > places && precisionPlaces - 15 < places) {
    let usePrecision = precisionPlaces < -(4 * 15) ? -(4 * 15) : precisionPlaces;
    // php_round_get_basic: scale into the 15-significant-digit window and round there.
    const basic = usePrecision >= 0 ? value * pow10(usePrecision) : value / pow10(usePrecision);
    tmp = roundHelper(basic);
    usePrecision = Math.max(-(4 * 15), places - usePrecision);
    tmp /= pow10(usePrecision);
  } else {
    tmp = places >= 0 ? value * f1 : value / f1;
    // Beyond double precision there is nothing to round.
    if (Math.abs(tmp) >= 1e15) return value;
  }

  tmp = roundHelper(tmp);
  return places > 0 ? tmp / f1 : tmp * f1;
}

const NUMERIC_STRING = /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/;

/** PHP `is_numeric()`: finite numbers and numeric strings (PHP 8 allows trailing whitespace). */
export function phpIsNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return NUMERIC_STRING.test(value);
  return false;
}

/** PHP `empty()`: null, false, 0, "", "0", and empty arrays or objects. */
export function phpEmpty(value) {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value === "" || value === "0";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** PHP `isset()` for one array element: present and not null. */
export function phpIsset(value) {
  return value !== undefined && value !== null;
}

/** PHP `is_array()` as it applies to decoded JSON: arrays and objects both count. */
export function isPhpArray(value) {
  return value !== null && typeof value === "object";
}

/**
 * PHP `(float)` cast. Leading numeric prefixes are read (`"12abc"` is 12) and anything
 * else is 0, which is exactly the cast's contract rather than an error.
 */
export function phpFloat(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseFloat(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** PHP `(int)` cast: the float cast truncated toward zero. */
export function phpInt(value) {
  return Math.trunc(phpFloat(value));
}

/**
 * PHP `(string)` of a float as the legacy code interpolates it into version labels.
 * JavaScript and PHP 8 both print the shortest round-trip form (`0.5`, `-1.25`, `0`),
 * which the golden file verifies. The one known difference is negative zero: PHP
 * prints `-0`, JavaScript `0`. No sports code path produces `-0`, since the calibration
 * grid starts at `-8.0 + 16 * 0.5`, which is positive zero.
 */
export function phpFloatString(value) {
  return String(value);
}
