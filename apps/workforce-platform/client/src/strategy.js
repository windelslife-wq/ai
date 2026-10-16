/**
 * The Strategy Lab console's own logic (Phase 31, row 8's console gap — F-29).
 *
 * Plain ESM on purpose: no JSX, no browser globals, no imports from the server.
 * `test/client_strategy_console.test.js` imports this file and the server's own
 * contracts side by side, so a vocabulary that drifts from the API fails the
 * suite instead of producing a 400 a person discovers by clicking.
 *
 * Three rules run through everything here, and they are the reasons each function
 * exists rather than being inlined in the view:
 *
 *  1. **The engine's numbers are never re-derived.** Returns, Sharpe, drawdown,
 *     profit factor and the sample size all come from the report; this module
 *     formats them and nothing else.
 *  2. **The legacy screen's vocabulary is kept** — the six symbols, the four
 *     timeframes, the bar defaults, the stage order and the "Paper trading
 *     (deploy)" label — because a person comparing the two consoles should see
 *     the same choices in the same order (`views/strategy/index.php`).
 *  3. **The console never invents a stricter rule than the API.** Two places
 *     where that matters: `limit` is CLAMPED by the engine, not refused
 *     (`BACKTEST_LIMIT_MIN..MAX`, `OPTIMIZE_CANDLE_MIN..MAX`), so the bounds here
 *     are documentation for the input's `min`/`max` attributes and not a refusal;
 *     and the symbol list is the form's own six, which the API is wider than.
 */

/** The six symbols `views/strategy/index.php` offered, with the class each maps to. */
export const SYMBOLS = Object.freeze([
  Object.freeze({ value: "BTCUSDT", marketClass: "crypto" }),
  Object.freeze({ value: "ETHUSDT", marketClass: "crypto" }),
  Object.freeze({ value: "SOLUSDT", marketClass: "crypto" }),
  Object.freeze({ value: "EURUSD", marketClass: "forex" }),
  Object.freeze({ value: "GBPUSD", marketClass: "forex" }),
  Object.freeze({ value: "XAUUSD", marketClass: "commodity" }),
]);

/** The four timeframes a strategy backtest may use — legacy's own list, 1h selected. */
export const TIMEFRAMES = Object.freeze([
  Object.freeze({ value: "15m", label: "15m" }),
  Object.freeze({ value: "1h", label: "1h" }),
  Object.freeze({ value: "4h", label: "4h" }),
  Object.freeze({ value: "1d", label: "1d" }),
]);

/**
 * Bar bounds, as the engine applies them.
 *
 * `backtester.js` clamps into `BACKTEST_LIMIT_MIN..BACKTEST_LIMIT_MAX` (60–5000)
 * and refuses only a series shorter than 120 candles *after* fetching; the
 * optimizer clamps into `OPTIMIZE_CANDLE_MIN..MAX` (420–2000). The legacy form
 * asked for 1500 backtest bars and 1000 optimizer bars, and those defaults are
 * kept — they are inside both ranges.
 */
export const BACKTEST_BARS = Object.freeze({ min: 60, max: 5000, default: 1500 });
export const OPTIMIZE_BARS = Object.freeze({ min: 420, max: 2000, default: 1000 });

/** The lifecycle order, exactly `StrategyRegistry::nextStage`'s. */
export const LIFECYCLE_ORDER = Object.freeze([
  "DRAFT", "BACKTESTED", "VALIDATED", "RISK_REVIEWED", "PAPER_TRADING", "APPROVED",
]);
export const RETIRED_STAGE = "RETIRED";

/** The legacy stepper's step labels: only PAPER_TRADING was annotated. */
export const STAGE_LABELS = Object.freeze({ PAPER_TRADING: "Paper trading (deploy)" });

/**
 * The legacy page's colour language, kept as badge classes rather than collapsed
 * into three tones: a DRAFT and an APPROVED strategy must not look alike.
 */
export function lifecycleTone(stage) {
  const value = String(stage ?? "").toUpperCase();
  if (value === "APPROVED") return "badge-green";
  if (value === "RETIRED") return "badge-red";
  if (value === "RISK_REVIEWED" || value === "PAPER_TRADING") return "badge-violet";
  if (value === "BACKTESTED" || value === "VALIDATED") return "badge-sky";
  return "badge-gray";
}

/** The lifecycle stepper: which stages are done, current, or still pending. */
export function stageSteps(lifecycle) {
  const current = String(lifecycle ?? "").toUpperCase();
  const index = LIFECYCLE_ORDER.indexOf(current);
  return LIFECYCLE_ORDER.map((stage, position) => ({
    stage,
    label: STAGE_LABELS[stage] ?? stage,
    state: index === -1 ? "pending" : position < index ? "done" : position === index ? "current" : "pending",
  }));
}

/**
 * A symbol's market class, by legacy's rule (`Strategy_lab::run_backtest`):
 * a USDT pair is crypto, XAUUSD is a commodity, everything else is forex.
 *
 * The engine upper-cases the symbol, so this does too — the two must agree or a
 * lowercase entry would be classified one way on screen and another on the wire.
 */
export function marketClassFor(symbol) {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (value === "XAUUSD") return "commodity";
  if (value.endsWith("USDT")) return "crypto";
  return "forex";
}

/* ------------------------------------------------------------------ forms */

const KNOWN_SYMBOLS = new Set(SYMBOLS.map((entry) => entry.value));
const KNOWN_TIMEFRAMES = new Set(TIMEFRAMES.map((entry) => entry.value));

function integerProblem(value, field, label) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) {
    return { field, message: `${label} must be a whole number of bars.` };
  }
  return null;
}

/**
 * The backtest pre-flight.
 *
 * Only shape is refused: an empty symbol, a symbol outside the form's list, a
 * timeframe the endpoint does not serve, or a bar count that is not a whole
 * number. A bar count outside the clamp range is NOT refused — the engine clamps
 * it and reports what it used, and refusing here would be a rule the API does not
 * have.
 */
export function validateBacktestForm(form) {
  const problems = [];
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  if (!symbol) problems.push({ field: "symbol", message: "Choose a symbol." });
  else if (!KNOWN_SYMBOLS.has(symbol)) problems.push({ field: "symbol", message: `Choose one of: ${SYMBOLS.map((entry) => entry.value).join(", ")}.` });
  if (!KNOWN_TIMEFRAMES.has(String(form?.timeframe ?? ""))) problems.push({ field: "timeframe", message: `Choose one of: ${TIMEFRAMES.map((entry) => entry.value).join(", ")}.` });
  const bars = integerProblem(form?.limit, "limit", "Bars");
  if (bars) problems.push(bars);
  return problems;
}

/** The optimizer pre-flight — the same shape-only rule as the backtest form. */
export function validateOptimizeForm(form) {
  const problems = [];
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  if (!symbol) problems.push({ field: "symbol", message: "Choose a symbol." });
  else if (!KNOWN_SYMBOLS.has(symbol)) problems.push({ field: "symbol", message: `Choose one of: ${SYMBOLS.map((entry) => entry.value).join(", ")}.` });
  if (!KNOWN_TIMEFRAMES.has(String(form?.timeframe ?? ""))) problems.push({ field: "timeframe", message: `Choose one of: ${TIMEFRAMES.map((entry) => entry.value).join(", ")}.` });
  const bars = integerProblem(form?.limit, "limit", "Bars");
  if (bars) problems.push(bars);
  return problems;
}

/**
 * `HUMAN_SIGNOFF_BODY` requires a reason of at least 10 characters after trimming,
 * so the console says that rather than letting the server answer 422 — the one
 * place a client rule and a server rule are intentionally identical.
 */
export function validateSignOffForm(form) {
  const problems = [];
  const reason = String(form?.reason ?? "").trim();
  if (reason.length < 10) problems.push({ field: "reason", message: "Record at least 10 characters explaining the review." });
  else if (reason.length > 1000) problems.push({ field: "reason", message: "Keep the reason under 1000 characters." });
  return problems;
}

/* ----------------------------------------------------------------- bodies */

/**
 * The backtest body: exactly the properties `BACKTEST_BODY` declares, with the
 * market class derived rather than asked for (legacy derived it the same way).
 * `strategyVersion` is sent when the console knows one, so a backtest is recorded
 * against the version on screen instead of whatever is latest at submit time.
 */
export function buildBacktestBody(form) {
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  const body = {
    strategyId: String(form?.strategyId ?? ""),
    symbol,
    marketClass: marketClassFor(symbol),
    timeframe: String(form?.timeframe ?? "1h"),
    allowShorts: form?.allowShorts === true || form?.allowShorts === "true" || form?.allowShorts === "1",
  };
  const version = String(form?.strategyVersion ?? "").trim();
  if (version !== "") body.strategyVersion = version;
  const limit = Number(form?.limit);
  if (Number.isInteger(limit) && limit > 0) body.limit = limit;
  return body;
}

/** The optimize body. `register` is a strict boolean, defaulting to false. */
export function buildOptimizeBody(form) {
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  const body = {
    symbol,
    marketClass: marketClassFor(symbol),
    timeframe: String(form?.timeframe ?? "1h"),
    register: form?.register === true || form?.register === "true" || form?.register === "1",
  };
  const version = String(form?.strategyVersion ?? "").trim();
  if (version !== "") body.strategyVersion = version;
  const limit = Number(form?.limit);
  if (Number.isInteger(limit) && limit > 0) body.limit = limit;
  return body;
}

/** `STATUS_BODY`: a target stage, the version being moved, and an optional reason. */
export function buildTransitionBody(form) {
  const body = { to: String(form?.to ?? "") };
  const version = String(form?.version ?? "").trim();
  if (version !== "") body.version = version;
  const reason = String(form?.reason ?? "").trim();
  if (reason !== "") body.reason = reason;
  return body;
}

/** `HUMAN_SIGNOFF_BODY`: a version and a review reason, both mandatory. */
export function buildSignOffBody(form) {
  return { version: String(form?.version ?? "").trim(), reason: String(form?.reason ?? "").trim() };
}

/* -------------------------------------------------------------- formatting */

/** A figure that is already a percentage (`totalReturnPct`), or an em dash. */
export function pctText(value, decimals = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(decimals)}%` : "—";
}

/** A 0–1 ratio the legacy page rendered as a whole percentage (`winRate`). */
export function ratioPctText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(0)}%` : "—";
}

/** `4.92` or `—`; used where a whole number is the honest rendering. */
export function plainNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(decimals) : "—";
}

/**
 * The metrics the legacy history table showed, in its column order, plus the
 * expectancy and exposure the report carries. Nulls stay em dashes: a strategy
 * with no losing trade has no profit factor, and printing 0 would be a lie.
 */
export function metricPairs(metrics) {
  const m = metrics ?? {};
  return [
    { label: "Trades", value: plainNumber(m.trades, 0) },
    { label: "Total return", value: pctText(m.totalReturnPct) },
    { label: "Final equity", value: plainNumber(m.finalEquity) },
    { label: "Win rate", value: ratioPctText(m.winRate) },
    { label: "Profit factor", value: plainNumber(m.profitFactor, 2) },
    { label: "Expectancy", value: plainNumber(m.expectancyR, 2) },
    { label: "Sharpe", value: plainNumber(m.sharpe, 2) },
    { label: "Sortino", value: plainNumber(m.sortino, 2) },
    { label: "Max drawdown", value: pctText(m.maxDrawdownPct, 1) },
    { label: "Exposure", value: pctText(m.exposurePct, 1) },
    { label: "Total fees", value: plainNumber(m.totalFees) },
    { label: "Total slippage", value: plainNumber(m.totalSlippage) },
  ];
}

/**
 * The sentence legacy flashed after a run, rebuilt from the report rather than
 * from the flash cookie: N trades · return X% · maxDD Y% · SYNTHETIC/real data.
 */
export function backtestSummary(report) {
  const metrics = report?.metrics ?? {};
  const provenance = report?.dataProvenance ?? {};
  const data = provenance.synthetic ? "SYNTHETIC data (simulation)" : "real data";
  return `Backtest complete: ${plainNumber(metrics.trades, 0)} trades · return ${pctText(metrics.totalReturnPct)} · maxDD ${pctText(metrics.maxDrawdownPct, 1)} · ${data}`;
}

/** Rows for the history table, in the legacy column order. */
export function historyRows(results) {
  return (Array.isArray(results) ? results : []).map((row) => ({
    id: row?.id ?? "",
    created: row?.createdAt ?? "",
    symbol: row?.symbol ?? "",
    timeframe: row?.timeframe ?? "",
    synthetic: row?.synthetic === true,
    metrics: row?.metrics ?? {},
  }));
}

/** The provenance line under a report: source, candle count, window, sim flag. */
export function provenanceNote(provenance) {
  const p = provenance ?? {};
  const parts = [];
  if (p.source) parts.push(String(p.source));
  if (Number.isFinite(Number(p.candles))) parts.push(`${Number(p.candles)} candles`);
  if (p.from && p.to) parts.push(`${String(p.from).slice(0, 16)} → ${String(p.to).slice(0, 16)}`);
  if (p.synthetic) parts.push("SIMULATION — not market performance");
  return parts.join(" · ");
}

/** `18 combinations · split 350/150 bars` — the optimizer's headline facts. */
export function optimizeHeadline(report) {
  const space = report?.searchSpace ?? {};
  const split = report?.split ?? {};
  const bits = [];
  if (Number.isFinite(Number(space.combinationsEvaluated))) bits.push(`${Number(space.combinationsEvaluated)} combinations`);
  if (Number.isFinite(Number(split.inSampleBars)) && Number.isFinite(Number(split.outOfSampleBars))) {
    bits.push(`split ${Number(split.inSampleBars)}/${Number(split.outOfSampleBars)} bars`);
  }
  return bits.join(" · ");
}

/**
 * The recommendation, in the words the legacy flash used: ADOPT with the chosen
 * parameters, or "keep current params" with the engine's own reason.
 */
export function optimizeRecommendation(report) {
  const recommendation = report?.recommendation ?? {};
  if (recommendation.adopt) return `ADOPT ${JSON.stringify(recommendation.params ?? {})}`;
  // The engine's own refusal sentence already opens with "keep current
  // parameters — ", so it is used verbatim when it does and prefixed only when it
  // does not. Prefixing unconditionally produced the sentence twice on the live
  // endpoint ("keep current parameters — keep current parameters — no candidate…").
  const reason = String(recommendation.reason ?? "").trim();
  if (reason === "") return "keep current parameters — no candidate beat the baseline out-of-sample";
  return /^keep current parameters/i.test(reason) ? reason : `keep current parameters — ${reason}`;
}

/** Finalist rows: the grid's survivors with both halves of the split. */
export function finalistRows(report) {
  return (Array.isArray(report?.finalists) ? report.finalists : []).map((finalist) => ({
    params: finalist?.params ?? {},
    inSample: finalist?.inSample?.totalReturnPct ?? null,
    outOfSample: finalist?.outOfSample?.totalReturnPct ?? null,
    trades: finalist?.outOfSample?.trades ?? null,
  }));
}

/**
 * A transition refusal, as `POST /strategies/:id/status` sends it: a 409 whose
 * `details.reasons` and `details.warnings` are the whole point. The legacy flash
 * printed the reasons, so a console that showed only "that transition was
 * rejected" would be a regression in what a person can act on.
 */
export function transitionFailure(error) {
  const details = error?.details ?? null;
  if (!details || Array.isArray(details)) return { reasons: [], warnings: [] };
  return {
    reasons: Array.isArray(details.reasons) ? details.reasons : [],
    warnings: Array.isArray(details.warnings) ? details.warnings : [],
  };
}

/**
 * Whether the human sign-off control applies. `signOffAiStrategy` refuses any
 * version that is not `source: "ai"` — it is a review of machine-generated
 * parameters, not a second approval for a built-in strategy.
 */
export function needsSignOff(strategy) {
  return String(strategy?.source ?? "").toLowerCase() === "ai";
}
