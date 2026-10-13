/**
 * The lottery rule engine — the port of `Aegis\Lottery\LotteryRules` and
 * `Aegis\Lottery\EuroMillionsRules` (legacy spec §4).
 *
 * Legacy's own header says why this is an interface over data and not a pile of
 * constants: every engine (validation, statistics, generation, the system builder,
 * the backtester) reads counts and ranges from a rules instance, so a rule change
 * or a new lottery is a configuration change, not a rebuild. The active rules can
 * be stored in `wf_lottery_rules` (admin-updatable); when no stored version exists
 * the code default below is authoritative.
 *
 * Ported as a factory returning legacy's readonly surface. `validateLine`'s error
 * strings are byte-identical to PHP's, because the differential harness compares
 * them character by character — including the `'Lucky Star'` label, which PHP
 * interpolates as-is.
 */

/** The current official EuroMillions format. */
export const EURO_MILLIONS_DEFAULTS = Object.freeze({
  code: "EUROMILLIONS",
  name: "EuroMillions",
  version: "1.0",
  mainCount: 5,
  mainMin: 1,
  mainMax: 50,
  starCount: 2,
  starMin: 1,
  starMax: 12,
  schedule: Object.freeze({ days: Object.freeze([2, 5]), time: "21:00", timezone: "UTC" }),
});

/**
 * Build a rules instance. Every argument is optional and defaults to the current
 * official format; `rulesRow` (a stored `wf_lottery_rules` row, snake_case with the
 * `schedule` column still the stored JSON text) overrides the format fields, exactly
 * as `EuroMillionsRules::fromArray` does.
 */
export function createEuroMillionsRules({
  code = EURO_MILLIONS_DEFAULTS.code,
  name = EURO_MILLIONS_DEFAULTS.name,
  version = EURO_MILLIONS_DEFAULTS.version,
  mainCount = EURO_MILLIONS_DEFAULTS.mainCount,
  mainMin = EURO_MILLIONS_DEFAULTS.mainMin,
  mainMax = EURO_MILLIONS_DEFAULTS.mainMax,
  starCount = EURO_MILLIONS_DEFAULTS.starCount,
  starMin = EURO_MILLIONS_DEFAULTS.starMin,
  starMax = EURO_MILLIONS_DEFAULTS.starMax,
  schedule = null,
  rulesRow = null,
} = {}) {
  if (rulesRow) {
    version = String(rulesRow.version ?? EURO_MILLIONS_DEFAULTS.version);
    mainCount = intOr(rulesRow.main_count, EURO_MILLIONS_DEFAULTS.mainCount);
    mainMin = intOr(rulesRow.main_min, EURO_MILLIONS_DEFAULTS.mainMin);
    mainMax = intOr(rulesRow.main_max, EURO_MILLIONS_DEFAULTS.mainMax);
    starCount = intOr(rulesRow.star_count, EURO_MILLIONS_DEFAULTS.starCount);
    starMin = intOr(rulesRow.star_min, EURO_MILLIONS_DEFAULTS.starMin);
    starMax = intOr(rulesRow.star_max, EURO_MILLIONS_DEFAULTS.starMax);
    // PHP: json_decode((string)($row['schedule'] ?: ''), true) — an empty or
    // unparseable schedule falls back to the default, and a decode without days
    // does too.
    schedule = null;
    try {
      const parsed = JSON.parse(String(rulesRow.schedule ?? "") || "null");
      if (parsed && Array.isArray(parsed.days) && parsed.days.length > 0) schedule = parsed;
    } catch {
      schedule = null;
    }
  }

  const resolvedSchedule = schedule ?? EURO_MILLIONS_DEFAULTS.schedule;

  return Object.freeze({
    code: () => code,
    name: () => name,
    version: () => version,
    mainCount: () => mainCount,
    mainMin: () => mainMin,
    mainMax: () => mainMax,
    starCount: () => starCount,
    starMin: () => starMin,
    starMax: () => starMax,
    drawSchedule: () => resolvedSchedule,

    /**
     * Validate one combination line against the configured rules.
     * @returns {{valid: boolean, errors: string[]}}
     */
    validateLine(main, stars) {
      const errors = [
        ...validateField(main, "main", mainCount, mainMin, mainMax),
        ...validateField(stars, "Lucky Star", starCount, starMin, starMax),
      ];
      return { valid: errors.length === 0, errors };
    },
  });
}

/** Rebuild a rules object from a stored `wf_lottery_rules` row (admin-updatable). */
export function euroMillionsRulesFromArray(code, name, row) {
  return createEuroMillionsRules({ code, name, rulesRow: row });
}

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isPhpInt(value) {
  // PHP's is_int: a real integer, never a float. JS numbers erase the distinction
  // (see SP-35), so the port accepts an integral float where PHP would reject 2.0 —
  // the recorded, pending-confirmation divergence for the integer-typed rule fields.
  return typeof value === "number" && Number.isInteger(value);
}

function validateField(values, label, count, min, max) {
  const errors = [];
  const list = Array.isArray(values) ? values : [];
  if (list.length !== count) {
    errors.push(`line must contain ${count} ${label} numbers (got ${list.length})`);
  }
  for (const v of list) {
    if (!isPhpInt(v) || v < min || v > max) {
      errors.push(`${label} number out of range ${min}-${max}: ${typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "invalid"}`);
    }
  }
  const ints = list.filter((v) => isPhpInt(v));
  if (ints.length !== new Set(ints).size) {
    errors.push(`duplicate ${label} numbers`);
  }
  return errors;
}
