/**
 * The Risk Center console (row 11, Phase 38).
 *
 * Legacy has one page over this module: `Risk_center::index` → `views/risk/index.php`. It
 * carried three panels — the independent limits with veto power, the portfolio risk monitor,
 * and the latest audit rows — and this screen is those three, plus the governance state the
 * legacy layout header showed, read rather than assumed.
 *
 * Four rules, the same ones every console in this shell follows:
 *
 *  1. **The screen states what it is reading, and the API decides it.** The limits panel
 *     reads `GET /risk/limits` (the persisted row the Risk Engine enforces) and the monitor
 *     reads `GET /portfolio/risk-scan`, whose *read is the scan* — there is no scan POST in
 *     the Node module. Legacy's `Risk_center::scan()` was a POST that scanned, audited the
 *     alert transitions and stored the report; the port's read writes nothing, and the
 *     audited transition sweep is the scheduled operations job (`npm run jobs` →
 *     `portfolio.risk.alert` / `portfolio.risk.cleared`). The panel says so rather than
 *     implying a button that leaves an audit row.
 *  2. **No number is printed that the server did not send,** and no severity is invented:
 *     the scan returns breach codes without a severity, so the badge uses the *same*
 *     classification the operations cron uses to decide a notification's severity
 *     (`CRITICAL_BREACH_CODES` / `WARNING_BREACH_CODES` in `src/jobs/scheduled.js`). The
 *     test asserts the two maps agree for every code the scan can emit.
 *  3. **Nothing is offered that the API would refuse.** Every read here is `trading.view`;
 *     the limits write is `trading.control`, so a viewer sees the form's values and is told
 *     which permission the save needs. The governance writes (mode, kill switch, synthetic
 *     prices) are **not** on this screen — legacy's risk page did not carry them either,
 *     and the screen names where they live (`/app/analysis`).
 *  4. **Legacy's copy is legacy's.** Every heading, note, form label, empty state and flash
 *     sentence is asserted against `application/views/risk/index.php` and
 *     `application/controllers/Risk_center.php`, with the two places this port deliberately
 *     departs named as departures in the test.
 *
 * Every function here is pure: `views.jsx` binds them to reads and the console test holds
 * them to the legacy text and to the routes the server actually registers.
 */

import { numberText } from "./sports.js";

/** Legacy `Risk_center::base()` ran under `App_Controller`; its API reads are `trading.view`. */
export const RISK_PERMISSION = "trading.view";
/** Updating the persisted limits: `trading.control` (`POST /risk/limits/update`). */
export const RISK_CONTROL = "trading.control";
/** The audit panel's gate — AV-1, the port's deliberate tightening of legacy's session read. */
export const RISK_AUDIT_PERMISSION = "identity.users.view";
/** `system.super_admin` short-circuits every permission check server-side. */
export const SUPER_ADMIN_PERMISSION = "system.super_admin";

const EM_DASH = "—";
const finite = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const isFiniteNumber = (value) => Number.isFinite(value);

/** Whether the session holds a permission, mirroring `userHasPermission` on the server. */
export function holdsRiskPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(SUPER_ADMIN_PERMISSION);
}

/** Money with the port's two decimals and thousands separators; a gap is an em dash. */
export function moneyText(value) {
  const number = finite(value);
  return isFiniteNumber(number) ? number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : EM_DASH;
}

/** A fraction rendered as a percentage (`0.01` → `1.00%`); a gap is an em dash. */
export function percentText(value, digits = 2) {
  const number = finite(value);
  if (!isFiniteNumber(number)) return EM_DASH;
  return `${(number * 100).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** A plain count or measurement; a gap is an em dash and a real zero stays `0`. */
export function countText(value) {
  const number = finite(value);
  return isFiniteNumber(number) ? String(number) : EM_DASH;
}

/** Legacy rendered `substr($ev['at'], 5, 14)` of a MySQL datetime — `MM-DD HH:MM:SS`. */
export function auditTimeText(value) {
  const text = String(value ?? "");
  if (!text) return EM_DASH;
  const normalized = text.replace("T", " ");
  return normalized.length >= 19 ? normalized.slice(5, 19) : normalized;
}

/* ------------------------------------------------------------------------ the page's words */

/**
 * `views/risk/index.php` + `Risk_center`'s flash sentences, verbatim. Two departures are
 * deliberate and named where they are used: the scan flash counts **breaches** rather than
 * legacy's *alerts* (the port's scan returns one row per breach, not per alert), and the
 * panel says the read performs the scan because in this module it does.
 */
export const RISK_COPY = Object.freeze({
  eyebrow: "RISK · ROW 11",
  title: "Risk Center",
  lede: "Independent limits with veto power over every trade, plus portfolio monitoring. Correlation alerts use static disclosed groups — a heuristic, not a statistical model.",

  limitsTitle: "Risk limits",
  updateLabel: "Update risk limits",
  limitsNote: "Exposure is capital-at-risk (stop-distance basis), not notional. Synthetic and stale data are blocked for live decisions.",
  updateNotice: "Risk limits updated.",
  noFieldsNotice: "No valid limit fields supplied.",
  unchangedNotice: "No limit changed — nothing was sent.",
  limitsGate: "Saving limits needs `trading.control`. The values below are readable under `trading.view`, which this session holds.",

  monitorTitle: "Portfolio Risk Monitor",
  scanLabel: "Run portfolio risk scan",
  monitorNote: "Continuous checks: HIGH_EXPOSURE · EXCESSIVE_LEVERAGE · CORRELATED_POSITIONS · MAX_DRAWDOWN_WARNING · DAILY_LOSS_WARNING · BROKER_DISCONNECTED. Only alert transitions are audited.",
  noScan: "No scan yet.",
  lastScanPrefix: "Last scan: ",
  noAlerts: "No active risk alerts.",
  scanClean: "Portfolio scan clean — no risk alerts.",
  scanFailedPrefix: "Scan failed: ",

  alertsSeverity: "Severity",
  alertsCode: "Code",
  alertsScope: "Scope",
  alertsDetail: "Detail",

  accountsTitle: "Scanned accounts",
  accountsAccount: "Account",
  accountsStatus: "Status",
  accountsEquity: "Equity",
  accountsOpen: "Open",
  accountsBreaches: "Breaches",

  readOnlyTitle: "Governed but not editable here",
  readOnlyNote: "Legacy's form offered eleven fields and the port adds the notional field its controller silently dropped; these remaining limits are persisted and enforced, and the API accepts them — they are simply not on the page legacy drew.",

  boundaryTitle: "What this screen does not do",
  readsTitle: "What this screen reads",
});

/**
 * The form's fields, in legacy's order and with legacy's labels and scales.
 *
 * `scale: 100` means the persisted value is a fraction and the field shows percent — legacy's
 * own `$limits[$key] * $scale` on render and `/100` on save. `maxPositionNotionalUsd` is the
 * twelfth: legacy's view rendered it and `Risk_center::limits()` skipped it by name
 * (`if ($key === 'maxTradeNotional' || $key === 'maxPositionNotionalUsd') continue;`), so the
 * field could never be saved. The port keeps the field and lets it save.
 */
export const RISK_FIELDS = Object.freeze([
  Object.freeze({ key: "riskPerTradePct", label: "Risk per trade (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "maxRiskPerTradePct", label: "Hard risk cap/trade (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "minRiskReward", label: "Min risk/reward", scale: 1, kind: "number", step: "0.1" }),
  Object.freeze({ key: "maxPositionNotionalUsd", label: "Max position notional ($)", scale: 1, kind: "number", step: "1" }),
  Object.freeze({ key: "maxLeverage", label: "Max leverage (x)", scale: 1, kind: "number", step: "0.1" }),
  Object.freeze({ key: "maxOpenPositions", label: "Max open positions", scale: 1, kind: "integer", step: "1" }),
  Object.freeze({ key: "maxDailyLossPct", label: "Max daily loss (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "maxWeeklyLossPct", label: "Max weekly loss (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "maxDrawdownPct", label: "Max drawdown (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "maxSymbolExposurePct", label: "Max symbol exposure (%)", scale: 100, kind: "number", step: "0.01" }),
  Object.freeze({ key: "maxPortfolioExposurePct", label: "Max portfolio exposure (%)", scale: 100, kind: "number", step: "0.01" }),
]);

/**
 * The persisted limits legacy's form did not draw. `requireStopLoss` is in the first group
 * because it is not merely un-drawn, it is immutable: `normalizeRiskLimits` forces it true
 * on every read, so no request can turn the stop requirement off.
 */
export const RISK_OTHER_LIMITS = Object.freeze([
  Object.freeze({ key: "maxCorrelatedPositions", label: "Max correlated positions", kind: "count", note: "Declared and persisted; no code path enforces it yet (F-30)." }),
  Object.freeze({ key: "minDataQuality", label: "Minimum data quality", kind: "ratio" }),
  Object.freeze({ key: "blockSyntheticData", label: "Block synthetic data", kind: "flag" }),
  Object.freeze({ key: "blockStaleData", label: "Block stale data", kind: "flag" }),
  Object.freeze({ key: "requireStopLoss", label: "Require stop loss", kind: "flag", note: "Always on: the service forces it true on every read, so it cannot be turned off through the API." }),
]);

/**
 * The six codes legacy's monitor raised (`PortfolioRiskMonitor`'s docblock), kept here so the
 * screen can state what legacy's vocabulary was *as vocabulary* and not as if this API emitted
 * it. The Node scan emits the nine codes in `RISK_SCAN_CODES` instead.
 */
export const LEGACY_ALERT_CODES = Object.freeze([
  "HIGH_EXPOSURE", "EXCESSIVE_LEVERAGE", "CORRELATED_POSITIONS",
  "MAX_DRAWDOWN_WARNING", "DAILY_LOSS_WARNING", "BROKER_DISCONNECTED",
]);

/** Every code `portfolioRiskScan` can emit (`src/modules/paper/service.js`). */
export const RISK_SCAN_CODES = Object.freeze([
  "NON_POSITIVE_EQUITY", "VALUATION_UNAVAILABLE", "OPEN_POSITION_LIMIT", "DAILY_LOSS_LIMIT",
  "WEEKLY_LOSS_LIMIT", "DRAWDOWN_LIMIT", "PORTFOLIO_EXPOSURE_LIMIT", "SYMBOL_EXPOSURE_LIMIT",
  "SYNTHETIC_EXPOSURE",
]);

/**
 * The severity classification the operations cron uses, mirrored so the badge on a live
 * breach says the same thing the notification for it would. The console test asserts this
 * against `src/jobs/scheduled.js`'s own sets — a code the cron treats as critical may not
 * render here as a warning.
 */
export const CRITICAL_BREACH_CODES = Object.freeze(["NON_POSITIVE_EQUITY", "OPEN_POSITION_LIMIT", "DAILY_LOSS_LIMIT", "WEEKLY_LOSS_LIMIT", "DRAWDOWN_LIMIT", "PORTFOLIO_EXPOSURE_LIMIT", "SYMBOL_EXPOSURE_LIMIT"]);
export const WARNING_BREACH_CODES = Object.freeze(["VALUATION_UNAVAILABLE", "SYNTHETIC_EXPOSURE", "SCAN_FAILED"]);

/** `critical` for codes that mean capital is outside a limit, `warning` for the rest. */
export function breachSeverity(code) {
  const key = String(code);
  if (CRITICAL_BREACH_CODES.includes(key)) return "critical";
  return "warning";
}

/** The badge a severity gets: critical is red, everything else amber — legacy's own pair. */
export function severityTone(severity) {
  return severity === "critical" ? "badge-red" : "badge-amber";
}

/** The badge an account's scan status gets. */
export function scanStatusTone(status) {
  return String(status).toUpperCase() === "BREACH" ? "badge-red" : "badge-green";
}

/* ----------------------------------------------------------------------- the limits panel */

/**
 * The request schema's bounds, mirrored from `RISK_LIMITS_BODY` in
 * `src/modules/paper/contracts.js` so the form refuses what the API would refuse instead of
 * letting a 400 arrive as a surprise. The console test asserts this map equals the contract's
 * own, key for key and bound for bound.
 */
export const RISK_LIMIT_BOUNDS = Object.freeze({
  riskPerTradePct: Object.freeze({ min: 0.0001, max: 0.05 }),
  maxRiskPerTradePct: Object.freeze({ min: 0.0001, max: 0.1 }),
  minRiskReward: Object.freeze({ min: 0, max: 100 }),
  maxPositionNotionalUsd: Object.freeze({ min: 1, max: 100_000_000 }),
  maxLeverage: Object.freeze({ min: 1, max: 100 }),
  maxOpenPositions: Object.freeze({ min: 1, max: 100 }),
  maxDailyLossPct: Object.freeze({ min: 0, max: 1 }),
  maxWeeklyLossPct: Object.freeze({ min: 0, max: 1 }),
  maxDrawdownPct: Object.freeze({ min: 0, max: 1 }),
  maxSymbolExposurePct: Object.freeze({ min: 0, max: 1 }),
  maxPortfolioExposurePct: Object.freeze({ min: 0, max: 1 }),
});

/** The windows the screen reads. Legacy sliced the last 60 audit rows down to 25. */
export const RISK_WINDOWS = Object.freeze({ scanAccounts: 50, auditRows: 25 });

/** The form's initial values: legacy's `$limits[$key] * $scale`, as strings for inputs. */
export function limitFormState(limits) {
  const source = limits && typeof limits === "object" ? limits : {};
  const form = {};
  for (const field of RISK_FIELDS) {
    const value = finite(source[field.key]);
    form[field.key] = isFiniteNumber(value) ? String(Number((value * field.scale).toFixed(6))) : "";
  }
  return form;
}

/**
 * Validate the form against the same bounds the request schema enforces, in input space.
 *
 * Returning *errors per field* rather than one message is what lets the screen refuse before
 * the request: legacy let the server drop every non-numeric field silently (`is_numeric`
 * checks) and then flashed "No valid limit fields supplied." if nothing survived.
 */
export function validateLimitForm(form, { bounds = null } = {}) {
  const values = form && typeof form === "object" ? form : {};
  const errors = {};
  for (const field of RISK_FIELDS) {
    const raw = values[field.key];
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    if (text === "") {
      errors[field.key] = `${field.label} needs a value.`;
      continue;
    }
    const number = Number(text);
    if (!Number.isFinite(number)) {
      errors[field.key] = `${field.label} must be a number.`;
      continue;
    }
    if (field.kind === "integer" && !Number.isInteger(number)) {
      errors[field.key] = `${field.label} must be a whole number.`;
      continue;
    }
    if (bounds) {
      const rule = bounds[field.key];
      if (rule) {
        // The schema is in persisted (fraction) space; the field is in display space.
        const persisted = number / field.scale;
        if (persisted < rule.min || persisted > rule.max) {
          errors[field.key] = `${field.label} must be between ${Number((rule.min * field.scale).toFixed(6))} and ${Number((rule.max * field.scale).toFixed(6))}.`;
        }
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * The patch to send: only the fields whose value differs from what is persisted, scaled back
 * to fractions and typed the way the contract expects.
 *
 * Legacy sent every valid field on every save, so an unchanged form still rewrote (and
 * re-audited) all eleven. Sending only what changed makes `details.changed` in the audit row
 * mean what it says. An empty object is a real outcome — the caller says "nothing was sent".
 */
export function limitPatch(form, limits) {
  const values = form && typeof form === "object" ? form : {};
  const current = limits && typeof limits === "object" ? limits : {};
  const patch = {};
  for (const field of RISK_FIELDS) {
    const number = Number(String(values[field.key] ?? "").trim());
    if (!Number.isFinite(number)) continue;
    const persisted = field.kind === "integer" ? Math.trunc(number / field.scale) : number / field.scale;
    const existing = finite(current[field.key]);
    if (isFiniteNumber(existing) && Math.abs(existing - persisted) < 1e-12) continue;
    patch[field.key] = persisted;
  }
  return patch;
}

/**
 * The read-only rows for the limits this form does not edit, formatted by kind.
 *
 * `differs from the legacy vocabulary` is not a thing here: the row exists because the API
 * persists it, so it is rendered from the payload and an absent value is an em dash.
 */
export function otherLimitRows(limits) {
  const source = limits && typeof limits === "object" ? limits : {};
  return RISK_OTHER_LIMITS.map((limit) => {
    const value = finite(source[limit.key]);
    let text = EM_DASH;
    if (limit.kind === "flag") text = value === null ? EM_DASH : (Number(value) ? "yes" : "no");
    else if (limit.kind === "ratio") text = percentText(value);
    else if (isFiniteNumber(value)) text = String(value);
    return { ...limit, value: text };
  });
}

/* --------------------------------------------------------------------- the monitor panel */

/**
 * One row per breach across every scanned account, ordered the way legacy ordered its alerts:
 * most severe first, then by code (`usort` on `[severity, code]`).
 *
 * The scope is legacy's own `paper:<id>` string, so a row pasted into a support thread means
 * the same thing it did on the PHP page, with the account's name beside it because the Node
 * scan returns the name and an id alone is not an identity.
 */
export function breachRows(scan) {
  const accounts = Array.isArray(scan?.accounts) ? scan.accounts : [];
  const rows = [];
  for (const account of accounts) {
    const breaches = Array.isArray(account.breaches) ? account.breaches : [];
    for (const breach of breaches) {
      const severity = breachSeverity(breach.code);
      rows.push({
        key: `${account.accountId}:${breach.code}:${breach.symbol ?? ""}`,
        severity,
        tone: severityTone(severity),
        code: breach.code,
        scope: `paper:${account.accountId}`,
        accountName: account.accountName ?? `#${account.accountId}`,
        symbol: breach.symbol ?? null,
        detail: breach.message ?? EM_DASH,
      });
    }
  }
  rows.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "critical" ? -1 : 1;
    return String(left.code).localeCompare(String(right.code));
  });
  return rows;
}

/** The scanned accounts, as the table renders them. */
export function scanAccountRows(scan) {
  const accounts = Array.isArray(scan?.accounts) ? scan.accounts : [];
  return accounts.map((account) => ({
    key: String(account.accountId),
    id: account.accountId,
    name: account.accountName ?? `#${account.accountId}`,
    status: account.status ?? "UNKNOWN",
    tone: scanStatusTone(account.status),
    equity: moneyText(account.equity),
    openPositions: countText(account.openPositions),
    breaches: countText(Array.isArray(account.breaches) ? account.breaches.length : 0),
    valuationAvailable: account.valuationAvailable !== false,
  }));
}

/**
 * The scan's totals as the panel states them, and the flash the button produces.
 *
 * Legacy's two sentences are kept for the clean case and re-worded only where the unit really
 * changed: its "N active alert(s)" counted alert rows, and this scan counts breach rows. The
 * sentence keeps legacy's shape so an operator who knew the PHP page recognises it.
 */
export function scanSummary(scan) {
  if (!scan || typeof scan !== "object") return null;
  const totals = scan.totals ?? {};
  const rows = breachRows(scan);
  const accounts = scanAccountRows(scan);
  return {
    generatedAt: scan.generatedAt ?? null,
    accounts: countText(totals.accounts),
    breachedAccounts: countText(totals.breachedAccounts),
    equity: moneyText(totals.equity),
    openPositions: countText(totals.openPositions),
    breachCount: rows.length,
    accountRows: accounts,
    breachRows: rows,
    clean: rows.length === 0,
    message: rows.length === 0
      ? RISK_COPY.scanClean
      : `Portfolio scan: ${rows.length} active breach(es) — see the monitor panel.`,
  };
}

/* ----------------------------------------------------------------------- the audit panel */

/**
 * Legacy's four audit columns — At · Type · Summary · Actor — from the port's audit read.
 *
 * The Node trail carries no `summary` column; the writers put the human sentence in
 * `details.summary` (`paper/service.js`'s `audit()` and the jobs' `recordTransitions` both
 * do), so that is the first choice, with the entity as the fallback. A `system` actor is
 * named as such rather than rendered blank: an unattributed row is a fact worth seeing.
 */
export function auditRows(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.map((event) => ({
    key: String(event.id ?? `${event.action}-${event.createdAt}`),
    at: auditTimeText(event.createdAt ?? event.created_at),
    type: String(event.action ?? event.action_key ?? EM_DASH),
    summary: event.details?.summary
      ?? (event.entityType || event.entity_type ? `${event.entityType ?? event.entity_type} #${event.entityId ?? event.entity_id ?? EM_DASH}` : EM_DASH),
    actor: event.actor?.kind === "system" || !event.actor ? "system" : (event.actor.username ?? `#${event.actor.userId}`),
  }));
}

/* ---------------------------------------------------------------------------- the reads */

/**
 * Every surface the console reads, with the permission the server enforces on it. The suite
 * asserts each against `GET /api/v1/system/routes`, so a route that moves, disappears or
 * changes its guard fails there instead of rendering an error box.
 */
export const RISK_READS = Object.freeze([
  { key: "limits", method: "GET", path: "/api/v1/risk/limits", permission: RISK_PERMISSION, section: "Limits" },
  { key: "tradingState", method: "GET", path: "/api/v1/trading/mode", permission: RISK_PERMISSION, section: "Governance strip" },
  { key: "scan", method: "GET", path: "/api/v1/portfolio/risk-scan", permission: RISK_PERMISSION, section: "Monitor" },
  { key: "audit", method: "GET", path: "/api/v1/admin/audit", permission: RISK_AUDIT_PERMISSION, section: "Audit trail" },
]);

/** The one write the screen offers, and its gate. */
export const RISK_WRITES = Object.freeze([
  Object.freeze({ key: "updateLimits", method: "POST", path: "/api/v1/risk/limits/update", permission: RISK_CONTROL, label: "Update risk limits", legacy: "Risk_center::limits → platform->updateRiskLimits()" }),
]);

/**
 * The governance sentence the strip shows. Read from `GET /trading/mode`: the limits mean
 * nothing without the mode and switch beside them, which is why legacy's layout header showed
 * both on every page.
 */
export function governanceFacts(state) {
  if (!state || typeof state !== "object") return null;
  const killSwitch = state.killSwitch && typeof state.killSwitch === "object" ? state.killSwitch : {};
  return {
    mode: state.tradingMode ?? "UNKNOWN",
    killSwitch: killSwitch.active === true,
    synthetic: state.allowSyntheticPaperData === true,
    simulated: true,
  };
}
