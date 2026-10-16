/**
 * Portfolio optimizer console logic — form vocabulary and request assembly (row 9).
 *
 * Deliberately plain ESM with no JSX and no imports, for two reasons:
 *
 *  1. The view stays a binding, and the part that decides **what is sent to the
 *     server** lives here where `test/client_console.test.js` can import it
 *     directly and compare it against the server's own request contract
 *     (`src/modules/portfolio/contracts.js`). A drift between the console's
 *     vocabulary and the endpoint's is then a failing test rather than a 400 a
 *     user discovers.
 *  2. Nothing in this file may reference the server tree. The client bundle is
 *     built by Vite for the browser; importing a server module would drag the
 *     provider chain into it. The vocabulary is therefore declared here and the
 *     test — which runs in Node and may import both sides — pins it.
 *
 * What this file must never do: express an instruction to trade. The body it
 * builds contains a universe, a window and two estimation knobs. There is no
 * amount, no order id and no execute flag, which is the client-side half of the
 * structural guarantee behind `status: "RESEARCH_ONLY"`.
 */

/** The nine market classes the endpoint accepts, in the legacy view's order. */
export const MARKET_CLASSES = Object.freeze([
  Object.freeze({ value: "crypto", label: "Crypto" }),
  Object.freeze({ value: "forex", label: "Forex" }),
  Object.freeze({ value: "commodity", label: "Commodity" }),
  Object.freeze({ value: "stock", label: "Stock" }),
  Object.freeze({ value: "etf", label: "ETF" }),
  Object.freeze({ value: "futures", label: "Futures" }),
  Object.freeze({ value: "options", label: "Options" }),
  Object.freeze({ value: "indices", label: "Indices" }),
  Object.freeze({ value: "bonds", label: "Bonds" }),
]);

/** The four supported bar sizes, in the legacy view's order. */
export const TIMEFRAMES = Object.freeze([
  Object.freeze({ value: "1d", label: "1 day" }),
  Object.freeze({ value: "4h", label: "4 hours" }),
  Object.freeze({ value: "1h", label: "1 hour" }),
  Object.freeze({ value: "15m", label: "15 minutes" }),
]);

export const OBJECTIVES = Object.freeze([
  Object.freeze({ value: "max_sharpe", label: "Maximum Sharpe (approximate)" }),
  Object.freeze({ value: "min_variance", label: "Minimum variance" }),
]);

export const MIN_ASSETS = 2;
export const MAX_ASSETS = 12;
export const MIN_LIMIT = 31;
export const MAX_LIMIT = 2000;
export const MAX_SYMBOL_LENGTH = 24;

/**
 * The symbol rule the route schema enforces (2–24 characters, `[A-Z0-9._:-]`).
 * Checked here so an obvious typo costs a form message instead of a provider
 * fan-out that ends in a 400. The server remains the authority: this is a
 * pre-flight, never a substitute.
 */
export const SYMBOL_PATTERN = /^[A-Z0-9._:-]{2,24}$/;

/** One blank asset row. */
export function emptyAsset() {
  return { symbol: "", marketClass: "crypto" };
}

/**
 * The form as the console opens it.
 *
 * Defaults mirror the legacy screen (`views/portfolio/optimizer.php`): 1 day,
 * 365 bars, maximum Sharpe, a 0.60 per-asset cap, a 0% risk-free rate and two
 * crypto rows. The legacy screen defaulted to BTCUSDT/ETHUSDT; those values are
 * kept, because a blank universe would make the first click a validation error
 * rather than a demonstration of what the endpoint does.
 */
export function defaultForm() {
  return {
    timeframe: "1d",
    limit: 365,
    objective: "max_sharpe",
    maxWeight: 0.6,
    riskFreeRatePct: 0,
    periodsPerYear: "",
    allowSyntheticData: false,
    assets: [{ symbol: "BTCUSDT", marketClass: "crypto" }, { symbol: "ETHUSDT", marketClass: "crypto" }],
  };
}

function numeric(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  return Number(value);
}

/**
 * Pre-flight checks, in the order a person can act on them.
 *
 * These exist to avoid spending the endpoint's widest fan-out — up to twelve
 * sequential provider calls and two iterative solves — on a request the server
 * will refuse before it fetches anything. Every rule here is one the server also
 * enforces; none of them is stricter in a way that would refuse a request the API
 * would accept, and `validateOptimizeForm` never *replaces* a server answer.
 *
 * @returns {Array<{field: string, message: string}>} empty when the form is sendable
 */
export function validateOptimizeForm(form) {
  const problems = [];
  const assets = Array.isArray(form.assets) ? form.assets : [];

  if (assets.length < MIN_ASSETS || assets.length > MAX_ASSETS) {
    problems.push({ field: "assets", message: `Use between ${MIN_ASSETS} and ${MAX_ASSETS} assets.` });
  }

  const seen = new Set();
  assets.forEach((asset, index) => {
    const symbol = String(asset?.symbol ?? "").trim().toUpperCase();
    if (symbol === "") {
      problems.push({ field: `assets.${index}.symbol`, message: `Asset ${index + 1} needs a symbol.` });
      return;
    }
    if (!SYMBOL_PATTERN.test(symbol)) {
      problems.push({
        field: `assets.${index}.symbol`,
        message: `Asset ${index + 1}: use 2–${MAX_SYMBOL_LENGTH} characters from A–Z, 0–9, . _ : -`,
      });
      return;
    }
    if (seen.has(symbol)) {
      problems.push({ field: `assets.${index}.symbol`, message: `${symbol} is listed twice; every symbol must be unique.` });
      return;
    }
    seen.add(symbol);
    if (!MARKET_CLASSES.some((entry) => entry.value === asset?.marketClass)) {
      problems.push({ field: `assets.${index}.marketClass`, message: `Asset ${index + 1} needs a market class.` });
    }
  });

  const limit = numeric(form.limit);
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    problems.push({ field: "limit", message: `Historical bars must be a whole number between ${MIN_LIMIT} and ${MAX_LIMIT}.` });
  }

  const maxWeight = numeric(form.maxWeight);
  if (!Number.isFinite(maxWeight) || maxWeight <= 0 || maxWeight > 1) {
    problems.push({ field: "maxWeight", message: "Maximum weight must be greater than 0 and at most 1." });
  } else if (assets.length >= MIN_ASSETS && maxWeight + 1e-9 < 1 / assets.length) {
    // The cap must leave room to be fully invested: with n assets a cap below 1/n
    // cannot hold at the same time as "weights sum to 1".
    problems.push({
      field: "maxWeight",
      message: `Maximum weight must be at least ${(1 / assets.length).toFixed(4)} for ${assets.length} assets.`,
    });
  }

  const riskFreeRatePct = numeric(form.riskFreeRatePct);
  if (!Number.isFinite(riskFreeRatePct) || riskFreeRatePct < -10 || riskFreeRatePct > 100) {
    problems.push({ field: "riskFreeRatePct", message: "Annual risk-free rate must be between -10% and 100%." });
  }

  if (String(form.periodsPerYear ?? "").trim() !== "") {
    const periods = numeric(form.periodsPerYear);
    if (!Number.isInteger(periods) || periods < 1 || periods > 100000) {
      problems.push({ field: "periodsPerYear", message: "Periods per year must be a whole number between 1 and 100000." });
    }
  } else if (distinctClasses(assets).length > 1) {
    // Crypto trades 365 days, forex and listed equities roughly 252, and a universe
    // spanning them has no single correct number. The server refuses rather than
    // averaging; saying so here is what keeps the refusal from looking like a bug.
    problems.push({
      field: "periodsPerYear",
      message: "Set periods per year explicitly: this universe mixes market classes with different calendars.",
    });
  }

  return problems;
}

/** Distinct, valid market classes present in the form, in first-seen order. */
export function distinctClasses(assets) {
  const out = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    const value = asset?.marketClass;
    if (MARKET_CLASSES.some((entry) => entry.value === value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Assemble the request body.
 *
 * Only keys the endpoint declares are ever emitted, and optional keys are omitted
 * rather than sent as `null`, so the server's defaults apply exactly as documented
 * instead of being shadowed by a value the console invented. `riskFreeRatePct` is
 * converted to the annual decimal the API expects (4 → 0.04) — the legacy screen
 * sent `riskFreeRatePct` and divided it in its own JavaScript, so dividing it in
 * one place here is the same arithmetic with one home.
 *
 * @returns {object} the JSON body for `POST /api/v1/portfolio/optimize`
 */
export function buildOptimizeBody(form) {
  const assets = (Array.isArray(form.assets) ? form.assets : []).map((asset) => ({
    symbol: String(asset?.symbol ?? "").trim().toUpperCase(),
    marketClass: String(asset?.marketClass ?? "").trim().toLowerCase(),
  }));

  const body = {
    assets,
    timeframe: String(form.timeframe ?? "1d"),
    limit: Number(form.limit),
    objective: String(form.objective ?? "max_sharpe"),
    maxWeight: Number(form.maxWeight),
    riskFreeRate: Number(form.riskFreeRatePct || 0) / 100,
    allowSyntheticData: form.allowSyntheticData === true,
  };

  const periods = String(form.periodsPerYear ?? "").trim();
  if (periods !== "") body.periodsPerYear = Number(periods);

  return body;
}

/** `0.0412` → `"4.12%"`; anything non-finite renders as an em dash, never `NaN%`. */
export function formatPercent(value, decimals = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${(number * 100).toFixed(decimals)}%`;
}

/** Fixed-width numeric cell; `null` (a Sharpe ratio with no volatility) stays an em dash. */
export function formatNumber(value, decimals = 3) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(decimals);
}

/** ISO timestamp → the reader's local date and time, or the raw string if unparsable. */
export function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** A window bound in seconds/ms: both spellings appear in the report, so accept either. */
export function formatWindowBound(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return formatTimestamp(number < 1e12 ? number * 1000 : number);
}

/**
 * The four published allocations, in the order the comparison table reads them.
 * The keys are the report's own; a missing one is skipped rather than rendered
 * as an empty row.
 */
export const ALLOCATION_ROWS = Object.freeze([
  Object.freeze({ key: "selected", label: "Selected" }),
  Object.freeze({ key: "minimumVariance", label: "Minimum variance" }),
  Object.freeze({ key: "maximumSharpe", label: "Maximum Sharpe (approximate)" }),
  Object.freeze({ key: "equalWeightBenchmark", label: "Equal-weight benchmark" }),
]);

/**
 * The report's per-asset provenance as a symbol → source map.
 *
 * Provenance is shown per asset and never summarized: a reader has to be able to
 * see that one series was synthetic while another was not.
 */
export function provenanceBySymbol(report) {
  const map = new Map();
  for (const entry of report?.dataProvenance ?? []) {
    if (entry?.symbol) map.set(String(entry.symbol), entry);
  }
  return map;
}

/** One provenance cell: source, then the two flags that change how it must be read. */
export function provenanceLabel(entry) {
  if (!entry) return "unknown";
  const parts = [String(entry.source ?? "unknown")];
  if (entry.synthetic) parts.push("SIMULATION");
  if (entry.stale) parts.push("STALE");
  const gaps = Number(entry.validation?.gapCount ?? 0);
  if (gaps > 0) parts.push(`${Math.trunc(gaps)} gap${Math.trunc(gaps) === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Is any input series generated? Drives the SIMULATION badge, never a guess. */
export function isSimulation(report) {
  return (report?.dataProvenance ?? []).some((entry) => Boolean(entry?.synthetic));
}

/**
 * A human summary of what the run covered — the legacy screen's one-line header,
 * rebuilt from the report rather than from the form, so it describes what the
 * server actually computed.
 */
export function reportSummary(report) {
  if (!report) return "";
  const objective = String(report.objective ?? "").replaceAll("_", " ");
  const window = report.window ?? {};
  return [
    report.status,
    objective,
    `${window.returnObservations ?? "—"} aligned ${window.timeframe ?? ""} return observations`.trim(),
    `${window.periodsPerYear ?? "—"} periods/year`,
    `as of ${formatTimestamp(report.computedAt)}`,
  ].join(" · ");
}
