/**
 * The lottery draw validator — the port of `Aegis\Lottery\LotteryResultValidator`
 * (legacy spec §6).
 *
 * Every imported draw must pass ALL checks before it may be stored as official
 * data. Failed draws are marked DATA_VALIDATION_FAILED and audited; they are never
 * inserted as official results — the facade drops them after the audit, so this
 * validator is the gate between a provider and the historical database.
 *
 * The coercion rule is legacy's own: a number list keeps ints and numeric strings
 * (cast), and anything non-numeric becomes `-1` — always out of range, so the
 * rejection reason is the range message rather than a missing-value message. The
 * error strings are byte-identical to PHP's; the differential harness compares
 * them exactly.
 */

import { phpIsNumeric } from "../../lib/php.js";

export const STATUS_VALID = "VALID";
export const STATUS_FAILED = "DATA_VALIDATION_FAILED";

/**
 * @param {object} rules a rules instance (see ./rules.js) — validateLine decides
 *   the count/range/duplicate checks.
 */
export function createLotteryResultValidator(rules) {
  return Object.freeze({
    /**
     * @param {object} draw a normalized provider draw
     * @returns {{valid: boolean, status: string, errors: string[]}}
     */
    validate(draw) {
      const d = draw && typeof draw === "object" ? draw : {};
      const errors = [];

      const externalId = String(d.externalId ?? "").trim();
      if (externalId === "") {
        errors.push("missing draw ID (externalId)");
      }

      const date = String(d.drawDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealCalendarDay(date)) {
        errors.push(`invalid draw date: ${date === "" ? "(missing)" : date}`);
      }

      const main = asInts(d.main);
      const stars = asInts(d.stars);

      const source = String(d.source ?? "").trim();
      if (source === "") {
        errors.push("missing source attribution — no draw may be stored without a source");
      }
      if (String(d.sourceTimestamp ?? "").trim() === "") {
        errors.push("missing source timestamp");
      }

      const line = rules.validateLine(main, stars);
      errors.push(...line.errors);

      return {
        valid: errors.length === 0,
        status: errors.length === 0 ? STATUS_VALID : STATUS_FAILED,
        errors,
      };
    },
  });
}

/** PHP `checkdate(month, day, year)` — validates the calendar day, leap years included. */
function isRealCalendarDay(text) {
  const [year, month, day] = text.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Coerce a number list to ints; non-numeric entries become -1 (always out of range). */
function asInts(values) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => {
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (phpIsNumeric(v)) return Math.trunc(Number(v));
    return -1;
  });
}
