/**
 * The journal console (row 18, Phase 41).
 *
 * Legacy has one page over the journal: `Journal::index` → `views/journal/index.php`. It drew
 * the five group switches, the overall figures with their per-group table, the newest 200
 * entries and the confidence-calibration meters, all from `Aegis\Journal\Analytics` over rows
 * `JournalRepository::list()` returned. The port serves those reads from the strategies module
 * (`GET /api/v1/journal`, `…/analytics/summary`, `…/analytics/calibration`), which is the same
 * bounded context: backtests WRITE journal rows and the analytics READ them.
 *
 * Three rules, the same ones every console in this shell follows:
 *
 *  1. **The screen is the API's data, formatted as legacy formatted it.** Every figure is a
 *     string this module builds from the response: `number_format`'s thousands separators and
 *     fixed decimals, `—` for a value that is not there, `open` for an unexited trade. The
 *     analytics themselves are the server's (`journal-analytics.js`); nothing is recomputed in
 *     the browser, so a figure on this page cannot drift from the endpoint that produced it.
 *  2. **A screen does not invent a control the API does not have.** Legacy's page was a read,
 *     and so is this one. `POST /api/v1/journal/manual` exists and is documented beside the
 *     reads, but the page draws no form for it — exactly as legacy's page drew none.
 *  3. **Legacy's copy is legacy's.** Every heading, label, empty state and table header is
 *     asserted against the PHP with `readFileSync`; the sentences this port adds live in
 *     `JOURNAL_PORT_COPY`, and they are the ones that state the two divergences below.
 *
 * Divergences, stated on the screen rather than discovered by comparing it with the PHP:
 *
 *  - **The group switch is in-page state.** Legacy's five links were `?groupBy=` URLs; this
 *    shell's router matches exact paths and carries no query string, so the five buttons set
 *    state and the address bar does not change.
 *  - **The summary window is wider than the table's.** `Api_journal::summary` read a fixed 500
 *    rows, while `Journal::index` computed its figures over the 200 rows it displayed. This
 *    screen shows the endpoint's figures, so the overall panel can describe trades the table
 *    below does not list; the panel says so instead of letting the two look like one dataset.
 *
 * Every function here is pure: `views.jsx` binds them to reads, and
 * `test/client_journal_console.test.js` holds them to the legacy text and to the routes the
 * server registers.
 */

const EM_DASH = "—";
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/* ------------------------------------------------------------------------ the page's words */

/**
 * The five group switches, in the view's order — which is also the order its `foreach`
 * renders. `/journal?groupBy=` accepted the same five keys.
 */
export const JOURNAL_GROUPS = Object.freeze([
  Object.freeze({ key: "strategy", label: "By strategy" }),
  Object.freeze({ key: "symbol", label: "By symbol" }),
  Object.freeze({ key: "market", label: "By market" }),
  Object.freeze({ key: "source", label: "By source" }),
  Object.freeze({ key: "confidence", label: "By confidence" }),
]);

/** `views/journal/index.php`'s strings, verbatim. */
export const JOURNAL_COPY = Object.freeze({
  eyebrow: "JOURNAL · ROW 18",
  title: "Analytics",
  lede: "Every backtest and paper trade is journaled with fees, reason and confidence so you can see whether high-confidence decisions actually perform better.",

  // The overall panel: the heading interpolates the count, then six figures.
  overallTitle: "Overall",
  winRate: "Win rate",
  profitFactor: "Profit factor",
  totalPnl: "Total P&L",
  avgR: "Avg R",
  expectancy: "Expectancy",
  maxDd: "Max DD ($)",

  // The per-group table. The first header is the raw group key, as legacy printed it.
  groupTrades: "Trades",
  groupWinRate: "Win%",
  groupProfitFactor: "PF",
  groupExpectancy: "E[P&L]",
  groupTotalPnl: "Total P&L",

  entriesTitle: "Journal entries (latest 200)",
  entriesEmpty: "No entries yet — run a backtest or paper trade.",
  entryHeaders: Object.freeze(["Time", "Src", "Sym", "Dir", "Strategy", "Entry", "Exit", "P&L", "R", "Conf", "Reason"]),
  open: "open",

  calibrationTitle: "Confidence calibration",
  calibrationEmpty: "No confidence-tagged closed trades yet.",
});

/**
 * The sentences this port adds, kept separate from legacy's so the copy test can require
 * every string in `JOURNAL_COPY` inside the PHP and every string here only in this module.
 */
export const JOURNAL_PORT_COPY = Object.freeze({
  groupSwitch:
    "Legacy's five group links were `?groupBy=` URLs; this shell's router matches exact paths and carries no query string, so the choice is in-page state and the address bar does not change.",
  summaryWindow:
    "These figures are `GET /api/v1/journal/analytics/summary`'s: the endpoint reads the newest 500 rows. Legacy's page computed them over the 200 rows it displayed, so the summary can cover trades the table below does not list.",
  calibrationWindow:
    "Calibration reads the newest 2 000 rows, the same bound the legacy endpoint used.",
  entriesSource:
    "Rows are written by backtests (`source: backtest`), paper fills (`paper`) and the manual route (`manual`); this screen never writes one.",
  manualWrite:
    "`POST /api/v1/journal/manual` is the module's one human write — a session plus a CSRF token, and the row it returns is audited as `journal.entry-recorded`. Legacy's page drew no form for it either, so this screen is a read.",
  row18:
    "Row 18's other surface has no Node port: the public chat assistant (`Api_chat::respond`, `Aegis\\ChatAssistant`). The legacy CLI `tools` commands map to `npm run migrate`, `npm run seed:platform`, `npm test`, `npm run jobs`, `npm run sports:jobs` and `npm run lottery:jobs`.",
});

/* ---------------------------------------------------------------------------- formatting */

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * `number_format($value, $digits)` — thousands separators, fixed decimals, and an em dash
 * where legacy would have had nothing to format. A real zero stays `0`, not a dash.
 */
export function journalNumber(value, digits = 0) {
  const number = finiteNumber(value);
  if (number === null) return EM_DASH;
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** `number_format($ratio * 100, $digits) . '%'`, or an em dash for a null ratio. */
export function journalPercent(value, digits = 0) {
  const number = finiteNumber(value);
  return number === null ? EM_DASH : `${journalNumber(number * 100, digits)}%`;
}

/** A count with no separators of its own — legacy printed `e($count)` raw. */
export function journalCount(value) {
  const number = finiteNumber(value);
  return number === null ? EM_DASH : String(Math.trunc(number));
}

/**
 * The class legacy chose from `$value >= 0`: `up` for a gain (and for the `?? 0` default, so
 * an absent P&L was `up`), `down` for a loss. A zero is `up`, as it was in the PHP.
 */
export function journalTone(value) {
  const number = finiteNumber(value);
  return number !== null && number < 0 ? "down" : "up";
}

/** Legacy's source badge colours (`b-sky`, `b-violet`, `b-gray`, `b-red`), and its fallback. */
export const SOURCE_TONES = Object.freeze({
  backtest: "badge-sky",
  paper: "badge-violet",
  manual: "badge-gray",
  live: "badge-red",
});

export function sourceTone(source) {
  return SOURCE_TONES[String(source)] ?? "badge-gray";
}

/** `substr($entry_time, 0, 16)` — the ISO-8601 minute, `T` included, as legacy printed it. */
export function journalTime(value) {
  const text = String(value ?? "");
  return text === "" ? EM_DASH : text.slice(0, 16);
}

/* ------------------------------------------------------------------------------ the panels */

/** The overall heading: `Overall (N closed trades)`, the count from the response. */
export function overallHeading(summary) {
  const closed = isPlainObject(summary?.overall) ? summary.overall.closedTrades : null;
  return `${JOURNAL_COPY.overallTitle} (${journalCount(closed)} closed trades)`;
}

/**
 * The six figures legacy drew, in the view's order, each already formatted. `tone` is the
 * class its value carries — `Max DD ($)` is legacy's `.warn`, and Total P&L is signed.
 */
export function journalTotals(summary) {
  const overall = isPlainObject(summary?.overall) ? summary.overall : {};
  return [
    { key: "winRate", label: JOURNAL_COPY.winRate, value: journalPercent(overall.winRate, 1), tone: null },
    { key: "profitFactor", label: JOURNAL_COPY.profitFactor, value: journalNumber(overall.profitFactor, 2), tone: null },
    { key: "totalPnl", label: JOURNAL_COPY.totalPnl, value: journalNumber(overall.totalPnl, 0), tone: journalTone(overall.totalPnl) },
    { key: "avgR", label: JOURNAL_COPY.avgR, value: journalNumber(overall.avgRMultiple, 2), tone: null },
    { key: "expectancy", label: JOURNAL_COPY.expectancy, value: journalNumber(overall.expectancyPnl, 1), tone: null },
    { key: "maxDrawdown", label: JOURNAL_COPY.maxDd, value: journalNumber(overall.maxDrawdownAbs, 0), tone: "warn" },
  ];
}

/** The per-group rows, formatted as legacy formatted them (Win% at zero decimals). */
export function journalGroupRows(summary) {
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  return groups.map((group) => {
    const metrics = isPlainObject(group.metrics) ? group.metrics : {};
    return {
      key: String(group.key ?? EM_DASH),
      trades: journalCount(metrics.count),
      winRate: journalPercent(metrics.winRate, 0),
      profitFactor: journalNumber(metrics.profitFactor, 2),
      expectancy: journalNumber(metrics.expectancyPnl, 1),
      expectancyTone: journalTone(metrics.expectancyPnl),
      totalPnl: journalNumber(metrics.totalPnl, 0),
      totalTone: journalTone(metrics.totalPnl),
    };
  });
}

/** The summary's own `note`, or null — it exists only for the confidence grouping's gap. */
export function journalNote(summary) {
  const note = summary?.note;
  return typeof note === "string" && note !== "" ? note : null;
}

/** The newest rows, each cell formatted exactly as the PHP's table formatted it. */
export function journalEntryRows(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return entries.map((entry) => {
    const exited = entry.exit_price !== null && entry.exit_price !== undefined;
    return {
      key: String(entry.id ?? `${entry.entry_time ?? ""}-${entry.symbol ?? ""}-${entry.entry_price ?? ""}`),
      time: journalTime(entry.entry_time),
      source: String(entry.source ?? ""),
      sourceTone: sourceTone(entry.source),
      symbol: String(entry.symbol ?? ""),
      direction: entry.direction === "LONG" ? "▲" : "▼",
      directionTone: entry.direction === "LONG" ? "up" : "down",
      strategy: entry.strategy === null || entry.strategy === undefined ? EM_DASH : String(entry.strategy),
      entryPrice: journalNumber(entry.entry_price, 5),
      exitPrice: exited ? journalNumber(entry.exit_price, 5) : JOURNAL_COPY.open,
      pnl: journalNumber(entry.pnl, 1),
      pnlTone: journalTone(entry.pnl),
      rMultiple: journalNumber(entry.r_multiple, 2),
      confidence: entry.ai_confidence === null || entry.ai_confidence === undefined
        ? EM_DASH
        : journalPercent(entry.ai_confidence, 0),
      reason: entry.reason === null || entry.reason === undefined ? "" : String(entry.reason),
    };
  });
}

/**
 * The calibration meters.
 *
 * Legacy's bar width was `round(winRate * 100)` and its colour was green at `>= 0.5`, red
 * otherwise — including for a null rate, which is red with a zero-width bar. The clamp is
 * defensive: a rate outside 0..1 can only come from a hand-written row, and a bar wider than
 * its track would read as a rendering bug rather than the data problem it is.
 */
export function journalCalibrationRows(calibration) {
  const buckets = Array.isArray(calibration?.buckets) ? calibration.buckets : [];
  return buckets.map((bucket) => {
    const rate = finiteNumber(bucket.winRate);
    const width = Math.max(0, Math.min(100, Math.round((rate ?? 0) * 100)));
    return {
      key: String(bucket.key ?? EM_DASH),
      count: journalCount(bucket.count),
      text: `${journalCount(bucket.count)} trades · win ${journalPercent(bucket.winRate, 0)} · E[R] ${journalNumber(bucket.expectancyR, 2)}`,
      winRate: journalPercent(bucket.winRate, 0),
      width,
      tone: rate !== null && rate >= 0.5 ? "up" : "down",
    };
  });
}

/**
 * The verdict is the server's sentence, never one this module composes: `sufficientData`
 * decides only whether the notice is green or amber, exactly as legacy's `ok`/`warnbox` did.
 */
export function journalVerdict(calibration) {
  const text = typeof calibration?.verdict === "string" ? calibration.verdict : "";
  if (text === "") return null;
  return { text, tone: calibration?.sufficientData === true ? "ok" : "warn" };
}

/* ------------------------------------------------------------------------------ the reads */

/**
 * The reads this console makes, with the guard the server enforces. All three are
 * session-only, as legacy's were: `Journal::index` extended `App_Controller` and
 * `Api_journal` extended `Api_controller`, neither of which required a permission. The suite
 * asserts each path against `GET /api/v1/system/routes` and asserts that none carries one.
 */
export const JOURNAL_READS = Object.freeze([
  { key: "entries", method: "GET", path: "/api/v1/journal", permission: null, window: 200, panel: "Journal entries" },
  { key: "summary", method: "GET", path: "/api/v1/journal/analytics/summary", permission: null, window: 500, panel: "Overall and the group table" },
  { key: "calibration", method: "GET", path: "/api/v1/journal/analytics/calibration", permission: null, window: 2000, panel: "Confidence calibration" },
]);

/**
 * The module's one write. It is documented here and in the reads panel, and it is *not*
 * drawn: legacy's page drew no form for it either, and a console that invents one would no
 * longer be the page it ports.
 */
export const JOURNAL_WRITE = Object.freeze({
  key: "manual",
  method: "POST",
  path: "/api/v1/journal/manual",
  permission: null,
  csrf: true,
  panel: "Not drawn",
});

/** The windows the screen states, kept beside the routes that read them. */
export const JOURNAL_WINDOWS = Object.freeze({
  entries: JOURNAL_READS[0].window,
  summary: JOURNAL_READS[1].window,
  calibration: JOURNAL_READS[2].window,
});
