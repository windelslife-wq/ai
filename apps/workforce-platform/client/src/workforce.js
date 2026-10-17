/**
 * The AI Workforce console's own logic (Phase 32, row 3's analysis dashboard).
 *
 * Plain ESM like the other two console modules, and for the same reason: no JSX,
 * no browser globals, no server imports. `test/client_workforce_console.test.js`
 * imports this file *and* the server's own `analysis/contracts.js`,
 * `market-data/timeframes.js` and `paper/contracts.js`, so a vocabulary that
 * drifts fails a suite instead of producing a 400 somebody discovers by clicking.
 *
 * Three rules run through it:
 *
 *  1. **The engine's numbers are never re-derived.** Bias, confidence, confluence,
 *     agreement, scores, signals, levels and the risk verdict all come from the run
 *     payload; this module formats them.
 *  2. **The legacy page's vocabulary is kept** — `views/welcome/index.php`'s two
 *     symbol groups and their order, its four timeframes, its six-symbol watchlist,
 *     the bias badge colours and the trading-mode select — so a person comparing
 *     the two consoles sees the same choices.
 *  3. **The console never offers what the API refuses.** The mode select is the one
 *     place this bites: legacy offered five modes and this edition accepts two. The
 *     other three are refused at the request edge — `TRADING_MODE_BODY` declares the
 *     two values, so the validator answers 400 `INVALID_REQUEST` ("mode must be one
 *     of: ANALYSIS_ONLY, PAPER_TRADING") before any handler runs. The service's own
 *     guard (`TRADING_MODE_UNSUPPORTED`, a 409) sits behind that schema and is
 *     therefore unreachable over HTTP — the same shape as the lottery's unreachable
 *     statistics-kind refusal. The select lists the two and *names* the three with
 *     the capability reason each is unavailable for.
 */

/* ------------------------------------------------------------- vocabulary */

/** `Welcome::symbols()`'s two optgroups, in its order. */
export const SYMBOL_GROUPS = Object.freeze([
  Object.freeze({ label: "Crypto", symbols: Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]) }),
  Object.freeze({ label: "Forex & Metals", symbols: Object.freeze(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD"]) }),
]);

/** Every symbol the form offers, flattened — the run form's own list. */
export const SYMBOLS = Object.freeze(SYMBOL_GROUPS.flatMap((group) => group.symbols));

/**
 * The four timeframes the page offered (`$this->symbols()`'s sibling literal).
 *
 * The run endpoint accepts six (`1m` and `5m` included); this form is narrower on
 * purpose, and the consensus endpoint it also drives accepts exactly these four.
 */
export const RUN_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);

/** The consensus watchlist `Welcome::index` scans: six symbols, `1h` by default. */
export const WATCHLIST = Object.freeze(["EURUSD", "GBPUSD", "XAUUSD", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);

/** `CONSENSUS_BODY.symbols` bounds — read from the API by the contract test. */
export const MAX_WATCHLIST = 10;

/** The symbol shape `RUN_BODY` declares (minLength 2, maxLength 24). */
export const SYMBOL_RE = /^[A-Z0-9._:-]{2,24}$/;

/**
 * The trading modes this edition can actually be put into, and the three legacy
 * offered that it does not have.
 *
 * The first list is `TRADING_MODE_BODY`'s own values, so the validator and the
 * select agree; the other three are refused with a 400 at the request edge. A
 * select offering them would be a control whose only outcome is an error. They are
 * still named with the *capability* reason each is unavailable for — a reader
 * comparing the two consoles must see what is absent and why, and "no order path
 * exists to approve into" is the reason, not the error code that reports it.
 */
export const TRADING_MODES = Object.freeze(["ANALYSIS_ONLY", "PAPER_TRADING"]);
export const REFUSED_MODES = Object.freeze([
  Object.freeze({ mode: "HUMAN_APPROVAL", reason: "no order path exists to approve into" }),
  Object.freeze({ mode: "SEMI_AUTONOMOUS", reason: "no automated route, and no connector is verified" }),
  Object.freeze({ mode: "FULLY_AUTOMATED", reason: "no automated route, and live trading is disabled platform-wide" }),
]);

/** The bias badge colours of `views/welcome/index.php`, kept as tones. */
export function biasTone(bias) {
  const value = String(bias ?? "").toUpperCase();
  if (value === "BULLISH") return "badge-green";
  if (value === "BEARISH") return "badge-red";
  if (value === "NO_TRADE") return "badge-amber";
  return "badge-gray";
}

/** A signal or agent vote: BUY is green, SELL red, everything else neutral. */
export function signalTone(signal) {
  const value = String(signal ?? "").toUpperCase();
  if (value === "BUY") return "badge-green";
  if (value === "SELL") return "badge-red";
  return "badge-gray";
}

/** `strtolower(str_replace('_', ' ', $regime))` — legacy's watchlist rendering. */
export function regimeLabel(regime) {
  return String(regime ?? "").toLowerCase().replace(/_/g, " ");
}

/**
 * Legacy's market class for a symbol: `PaperTradingEngine::inferMarketClass`.
 *
 * The known-symbol map is ported whole rather than collapsed to the two rules that
 * happen to agree on today's list — the function is data in PHP, and a symbol
 * added to that map must be able to classify here without a code change. The
 * strategy console's `marketClassFor` is equivalent on every input the two share
 * (asserted in the contract test), so the two screens cannot disagree.
 */
const KNOWN_CLASSES = Object.freeze({
  EURUSD: "forex", GBPUSD: "forex", USDJPY: "forex", AUDUSD: "forex", USDCAD: "forex",
  USDCHF: "forex", NZDUSD: "forex", XAUUSD: "commodity",
});

export function marketClassFor(symbol) {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (KNOWN_CLASSES[value]) return KNOWN_CLASSES[value];
  if (value.endsWith("USDT")) return "crypto";
  return "forex";
}

/* ------------------------------------------------------------------ forms */

const KNOWN_SYMBOLS = new Set(SYMBOLS);
const KNOWN_TIMEFRAMES = new Set(RUN_TIMEFRAMES);

/**
 * The run pre-flight. Only shape is refused: a symbol outside the form's list or a
 * timeframe the endpoint does not serve. A symbol the API would accept but this
 * form does not offer is a typed mistake, not a request.
 */
export function validateRunForm(form) {
  const problems = [];
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  if (!symbol) problems.push({ field: "symbol", message: "Choose a symbol." });
  else if (!KNOWN_SYMBOLS.has(symbol)) problems.push({ field: "symbol", message: `Choose one of: ${SYMBOLS.join(", ")}.` });
  else if (!SYMBOL_RE.test(symbol)) problems.push({ field: "symbol", message: "A symbol is 2–24 characters of A–Z, 0–9 or . _ : -." });
  if (!KNOWN_TIMEFRAMES.has(String(form?.timeframe ?? ""))) {
    problems.push({ field: "timeframe", message: `Choose one of: ${RUN_TIMEFRAMES.join(", ")}.` });
  }
  return problems;
}

/**
 * The watchlist pre-flight: 1–10 distinct symbols of the declared shape. The API
 * refuses a duplicate with its own message and caps the list at
 * `MAX_CONSENSUS_SYMBOLS`, so both are checked here before a scan that costs up to
 * ten analysis runs.
 */
export function validateWatchlistForm(form) {
  const problems = [];
  const raw = String(form?.symbols ?? "");
  const symbols = raw.split(/[\s,]+/).map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) problems.push({ field: "symbols", message: "List at least one symbol." });
  if (symbols.length > MAX_WATCHLIST) problems.push({ field: "symbols", message: `At most ${MAX_WATCHLIST} symbols per scan.` });
  const invalid = symbols.filter((symbol) => !SYMBOL_RE.test(symbol));
  if (invalid.length) problems.push({ field: "symbols", message: `Not a symbol: ${invalid.join(", ")}.` });
  const duplicates = symbols.filter((symbol, index) => symbols.indexOf(symbol) !== index);
  if (duplicates.length) problems.push({ field: "symbols", message: `Listed twice: ${[...new Set(duplicates)].join(", ")}.` });
  const timeframe = form?.timeframe ?? "1h";
  if (!KNOWN_TIMEFRAMES.has(String(timeframe))) {
    problems.push({ field: "timeframe", message: `Choose one of: ${RUN_TIMEFRAMES.join(", ")}.` });
  }
  return problems;
}

/* ----------------------------------------------------------------- bodies */

/** `RUN_BODY`: symbol, its derived market class, and a timeframe. */
export function buildRunBody(form) {
  const symbol = String(form?.symbol ?? "").trim().toUpperCase();
  return {
    symbol,
    marketClass: marketClassFor(symbol),
    timeframe: String(form?.timeframe ?? "1h"),
  };
}

/**
 * `CONSENSUS_BODY`. The parsed watchlist is only sent when the operator supplied
 * one: an absent `symbols` is what makes the server fall back to its own default
 * watchlist, and sending the console's list instead would silently shadow it.
 */
export function buildConsensusBody(form) {
  const body = { timeframe: String(form?.timeframe ?? "1h") };
  const raw = String(form?.symbols ?? "").trim();
  if (raw !== "") body.symbols = raw.split(/[\s,]+/).map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  return body;
}

/** `TRADING_MODE_BODY` — one strict value from the supported pair. */
export function buildModeBody(mode) {
  const value = String(mode ?? "");
  return { mode: TRADING_MODES.includes(value) ? value : TRADING_MODES[0] };
}

/**
 * `KILL_SWITCH_BODY`. The reason is optional in the schema; legacy's dashboard
 * form sent none, and the button that activates it is the emergency control, so a
 * blank reason is omitted rather than written as an empty string in the audit
 * trail.
 */
export function buildKillSwitchBody(active, reason = "") {
  const body = { active: active === true || active === "true" };
  const trimmed = String(reason ?? "").trim();
  if (trimmed !== "") body.reason = trimmed;
  return body;
}

/* -------------------------------------------------------------- formatting */

/** A 0–1 ratio as a whole percentage, the way the legacy page rendered them. */
export function percentText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "—";
}

/** A number with a fixed precision, or an em dash. Nulls must never render 0. */
export function numberText(value, decimals = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(decimals) : "—";
}

/** `number_format($last, $last >= 10 ? 2 : 5)` — the quote line's precision. */
export function priceText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(number >= 10 ? 2 : 5);
}

/**
 * `number_format($p, $p >= 100 ? 1 : ($p >= 10 ? 3 : 5))` — the chart's own
 * formatter, thousands separators included, because the axis labels are read next
 * to levels the engine printed the same way.
 */
export function chartPriceText(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const decimals = number >= 100 ? 1 : number >= 10 ? 3 : 5;
  const [whole, fraction] = Math.abs(number).toFixed(decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${number < 0 ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/* ----------------------------------------------------------- run rendering */

/**
 * The provenance banner, as `views/welcome/index.php` decides it: a synthetic run
 * is a warn box that says the risk engine vetoes trades on synthetic data, a stale
 * non-synthetic run is an error box, and a fresh live run is an ok box.
 */
export function provenanceFacts(provenance) {
  // No payload is no banner: pushing LIVE onto an empty object would render a
  // provenance box for a run that never reported one.
  if (!provenance || typeof provenance !== "object") return null;
  const p = provenance;
  const synthetic = p.synthetic === true;
  const stale = p.stale === true;
  const facts = [];
  if (p.source) facts.push(`source ${p.source}`);
  if (Number.isFinite(Number(p.dataTimestamp))) {
    facts.push(`data time ${new Date(Number(p.dataTimestamp)).toISOString().slice(0, 19)}Z`);
  }
  if (Number.isFinite(Number(p.dataAgeMs))) {
    facts.push(`age ${Math.round(Number(p.dataAgeMs) / 60_000)}m`);
  }
  if (!synthetic) facts.push(stale ? "stale" : p.delayed ? "DELAYED" : "LIVE");
  if (Array.isArray(p.fallbackChain) && p.fallbackChain.length) {
    facts.push(`fallback: ${p.fallbackChain.join(" → ")} → ${p.source ?? "—"}`);
  }
  if (!facts.length) return null;
  return {
    tone: synthetic ? "warn" : stale ? "error" : "ok",
    synthetic,
    stale,
    facts,
    label: synthetic ? "SIMULATION / SYNTHETIC DATA" : stale ? "DATA STALE" : "PROVENANCE",
    note: synthetic
      ? p.fallbackChain?.length
        ? "Real providers were unreachable from this host and a labelled provider served this run. The Risk Engine vetoes trades on synthetic data."
        : "This run was produced by a labelled synthetic provider. The Risk Engine vetoes trades on synthetic data."
      : "",
  };
}

/** `BTCUSDT · 1h · NEUTRAL (HOLD)` — the one-line identity of a run. */
export function runHeadline(run) {
  const parts = [run?.symbol, run?.timeframe].filter(Boolean).map(String);
  const bias = run?.bias ? String(run.bias) : "—";
  const recommendation = run?.recommendation ? ` (${run.recommendation})` : "";
  return `${parts.join(" · ")}${parts.length ? " · " : ""}${bias}${recommendation}`;
}

/** The three meters legacy drew: confidence, confluence and agent agreement. */
export function meterRows(run) {
  return [
    { label: "Confidence", value: Number(run?.confidence), tone: "sky" },
    { label: "Confluence", value: Number(run?.confluence), tone: "violet" },
    { label: "Agent agreement", value: Number(run?.consensus?.agreement), tone: "green" },
  ].map((meter) => ({
    ...meter,
    pct: Number.isFinite(meter.value) ? Math.round(meter.value * 100) : 0,
    text: Number.isFinite(meter.value) ? `${Math.round(meter.value * 100)}%` : "—",
  }));
}

/** The consensus strip: voting agents, abstaining agents and the net score. */
export function consensusSummary(run) {
  const consensus = run?.consensus ?? {};
  const list = (value) => (Array.isArray(value) && value.length ? value.join(", ") : "none");
  return {
    netScore: numberText(consensus.netScore, 2),
    voting: list(consensus.votingAgents),
    abstaining: list(consensus.abstainingAgents),
    agreement: percentText(consensus.agreement),
  };
}

/** The technical signals table. */
export function signalRows(signals) {
  return (Array.isArray(signals) ? signals : []).map((signal) => ({
    name: signal?.name ?? "",
    detail: signal?.detail ?? "",
    value: numberText(signal?.value, 2),
    signal: String(signal?.signal ?? "—"),
    tone: signalTone(signal?.signal),
  }));
}

/**
 * The agent panels. An abstaining agent is rendered as abstaining — `votes: false`
 * is the whole point of the five-agent panel, and a UI that showed "NEUTRAL" with
 * no marker would hide that sentiment and fundamentals contributed nothing.
 */
export function agentPanels(agents) {
  return (Array.isArray(agents) ? agents : []).map((agent) => {
    const vote = agent?.vote ?? {};
    const scores = agent?.currencyStrength?.scores;
    return {
      id: String(agent?.agent ?? ""),
      title: agent?.title ?? agent?.agent ?? "Agent",
      quality: percentText(agent?.dataQuality),
      votes: vote.votes === true,
      voteLabel: vote.votes === true ? (vote.signal === "BUY" ? "▲ BULL" : vote.signal === "SELL" ? "▼ BEAR" : String(vote.signal ?? "—")) : "ABSTAIN",
      voteTone: vote.votes === true ? signalTone(vote.signal) : "badge-gray",
      score: numberText(vote.directionalScore, 2),
      reason: vote.reason ?? "",
      warnings: (Array.isArray(agent?.warnings) ? agent.warnings : []).concat(Array.isArray(agent?.dataLimitations) ? agent.dataLimitations : []),
      currencyStrength: Array.isArray(scores)
        ? scores.slice(0, 8).map((entry) => ({
          currency: entry?.currency ?? "",
          text: `${Number(entry?.score) >= 0 ? "+" : ""}${numberText(Number(entry?.score) * 100, 2)}%`,
          tone: Number(entry?.score) >= 0 ? "badge-green" : "badge-red",
        }))
        : [],
    };
  });
}

/** The technical agent's support/resistance levels, for the chart and the panel. */
export function structureLevels(agents) {
  const technical = (Array.isArray(agents) ? agents : []).find((agent) => agent?.agent === "technical");
  const clean = (value) => (Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []);
  return { support: clean(technical?.structure?.support), resistance: clean(technical?.structure?.resistance), structure: technical?.structure ?? null };
}

/**
 * The debate verdict, in legacy's shape: a verdict line plus four rounds whose
 * statements carry `claim`/`evidence` and whose objections carry `grounds`/
 * `severity` (the port emits both spellings, so both are read).
 */
export function debateView(debate) {
  if (!debate) return null;
  const verdict = debate.verdict ?? {};
  return {
    bias: String(verdict.bias ?? "—"),
    tone: verdict.bias === "NO_TRADE" ? "badge-red" : Number(verdict.confidenceAdjustment) < 0 ? "badge-amber" : "badge-gray",
    adjustment: Number(verdict.confidenceAdjustment) || 0,
    reasoning: Array.isArray(verdict.reasoning) ? verdict.reasoning.map(String) : [],
    rounds: (Array.isArray(debate.rounds) ? debate.rounds : []).map((round) => ({
      role: String(round?.role ?? "").replace(/-/g, " "),
      items: (Array.isArray(round?.statements) ? round.statements : Array.isArray(round?.objections) ? round.objections : [])
        .map((item) => ({ text: String(item?.claim ?? item?.grounds ?? ""), evidence: item?.evidence ?? null, severity: item?.severity ?? null })),
    })),
  };
}

/** The trade proposal, or null — and null is a deliberate outcome, not an error. */
export function tradeSetupView(setup) {
  if (!setup) return null;
  const rows = [
    { label: "Entry zone", value: `${chartPriceText(setup.entry?.min)} – ${chartPriceText(setup.entry?.max)}`, tone: "" },
    { label: "Stop loss", value: chartPriceText(setup.stopLoss), tone: "down" },
    ...(Array.isArray(setup.takeProfit) ? setup.takeProfit.map((target, index) => ({ label: `Target ${index + 1}`, value: chartPriceText(target), tone: "up" })) : []),
    { label: "Expires", value: setup.expiration ? `${String(setup.expiration).slice(0, 16)}Z` : "—", tone: "" },
  ];
  return {
    action: String(setup.action ?? "—"),
    tone: setup.action === "BUY" ? "badge-green" : "badge-red",
    symbol: setup.symbol ?? "",
    timeframe: setup.timeframe ?? "",
    riskReward: numberText(setup.riskReward, 2),
    confidence: percentText(setup.confidence),
    rows,
  };
}

/** The risk engine's verdict: approved or vetoed, with every reason kept. */
export function riskDecisionView(decision) {
  if (!decision) return null;
  return {
    approved: decision.approved === true,
    label: decision.approved === true ? "RISK: APPROVED" : "RISK: VETOED",
    tone: decision.approved === true ? "badge-green" : "badge-red",
    reasons: (Array.isArray(decision.reasons) ? decision.reasons : []).map(String),
  };
}

/** The history table's rows, from `GET /analysis/history`. */
export function historyRows(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    id: run?.id ?? "",
    symbol: run?.symbol ?? "",
    timeframe: run?.timeframe ?? "",
    bias: String(run?.bias ?? "—"),
    tone: biasTone(run?.bias),
    confidence: percentText(run?.confidence),
    time: String(run?.completedAt ?? "").slice(11, 19),
    synthetic: run?.synthetic === true,
  }));
}

/** The watchlist consensus rows, from `POST /analysis/consensus`. */
export function watchlistRows(payload) {
  const rows = Array.isArray(payload?.consensus) ? payload.consensus : [];
  return rows.map((row) => ({
    symbol: row?.symbol ?? "",
    bias: String(row?.bias ?? "—"),
    short: String(row?.bias ?? "—").slice(0, 4),
    tone: biasTone(row?.bias),
    confidence: percentText(row?.confidence),
    regime: regimeLabel(row?.regime),
    synthetic: row?.synthetic === true,
    runId: row?.runId ?? "",
  }));
}

/**
 * The four risk-context facts the proposal panel needs. They come from the run's
 * own `riskContext`, so the panel shows the state the decision was made against
 * rather than the state at render time.
 */
export function riskContextFacts(context) {
  if (!context) return null;
  return {
    mode: String(context.tradingMode ?? "—"),
    killSwitch: context.killSwitch?.active === true,
    killSwitchReason: context.killSwitch?.reason ?? "",
    source: String(context.source ?? "—"),
    equity: numberText(context.equity, 2),
    openPositions: Number(context.openPositions ?? 0),
    note: context.note ?? "",
    syntheticData: context.syntheticData === true,
  };
}

/* ------------------------------------------------------------- candle chart */

/**
 * `views/welcome/partials/chart.php`'s EMA helper, ported exactly: the first
 * `period - 1` points are null, the point at `period - 1` is the SMA seed, and
 * every later point is `v·k + prev·(1 - k)` with `k = 2/(period+1)`.
 *
 * The nulls matter: a naive EMA that treats the seed as the first value shifts
 * every later point, and one that emits 0 for the warm-up draws a spike to the
 * origin. The polyline must start where the average starts.
 */
export function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  let seed = 0;
  (Array.isArray(values) ? values : []).forEach((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number)) { out.push(null); return; }
    if (index < period - 1) { seed += number; out.push(null); return; }
    prev = prev === null ? (seed + number) / period : number * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

const CHART = Object.freeze({ width: 1000, height: 380, padL: 6, padR: 74, padT: 10, volH: 56, visible: 140 });

const point = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;

/**
 * Everything the SVG needs, computed once.
 *
 * Geometry is the legacy partial's, constants included (1000×380, 6/74/10 paddings,
 * a 56px volume strip, the last 140 bars, EMAs over the whole series then sliced,
 * support/resistance inside ±10% of the price range, a 4% pad, 4 gridlines). A
 * chart that silently rescaled would draw the same shape with different labels and
 * make two screenshots incomparable.
 */
export function candleGeometry({ candles, support = [], resistance = [], setup = null, visible = CHART.visible } = {}) {
  const all = (Array.isArray(candles) ? candles : []).filter((candle) => candle && Number.isFinite(Number(candle.close)));
  if (!all.length) return null;
  const window = all.slice(-visible);
  const offset = all.length - window.length;
  const closes = all.map((candle) => Number(candle.close));
  const ema20 = emaSeries(closes, 20).slice(offset);
  const ema50 = emaSeries(closes, 50).slice(offset);

  const lows = window.map((candle) => Number(candle.low));
  const highs = window.map((candle) => Number(candle.high));
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  for (const level of [...support, ...resistance].map(Number).filter(Number.isFinite)) {
    if (level > lo * 0.9 && level < hi * 1.1) { lo = Math.min(lo, level); hi = Math.max(hi, level); }
  }
  if (setup) {
    const stop = Number(setup.stopLoss);
    const entryMin = Number(setup.entry?.min);
    const firstTarget = Number(Array.isArray(setup.takeProfit) ? setup.takeProfit[0] : NaN);
    for (const level of [stop, entryMin, firstTarget].filter(Number.isFinite)) { lo = Math.min(lo, level); hi = Math.max(hi, level); }
  }
  const span = hi - lo;
  const pad = span * 0.04 || 1;
  lo -= pad;
  hi += pad;

  const { width, height, padL, padR, padT, volH } = CHART;
  const priceH = height - padT - volH - 16;
  const step = (width - padL - padR) / Math.max(1, window.length);
  const x = (index) => padL + index * step + step / 2;
  const y = (price) => padT + priceH - ((price - lo) / Math.max(1e-9, hi - lo)) * priceH;
  const volumeMax = Math.max(1, ...window.map((candle) => Number(candle.volume) || 0));
  const vy = (volume) => height - 10 - ((Number(volume) || 0) / volumeMax) * volH;

  const bars = window.map((candle, index) => {
    const open = Number(candle.open);
    const close = Number(candle.close);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const up = close >= open;
    const bodyW = Math.max(1.5, step * 0.6);
    const wickX = x(index);
    const bodyY = Math.min(y(open), y(close));
    return {
      index,
      x: wickX,
      up,
      open: chartPriceText(open),
      high: chartPriceText(high),
      low: chartPriceText(low),
      close: chartPriceText(close),
      timestamp: Number(candle.timestamp),
      wick: { x1: wickX, x2: wickX, y1: y(high), y2: y(low) },
      body: { x: wickX - bodyW / 2, y: bodyY, width: bodyW, height: Math.max(1, Math.abs(y(close) - y(open))) },
      volume: {
        x: wickX - Math.max(1, step * 0.64) / 2,
        y: vy(candle.volume),
        width: Math.max(1, step * 0.64),
        height: height - 10 - vy(candle.volume),
        up,
        label: numberText(Number(candle.volume), 0),
      },
    };
  });

  const seriesPoints = (series) => series
    .map((value, index) => (value === null ? null : point(x(index), y(value))))
    .filter(Boolean)
    .join(" ");

  return {
    width, height, padL, padR, padT, priceH, step, lo, hi,
    totalCount: all.length,
    visibleCount: window.length,
    bars,
    gridlines: [0, 1, 2, 3, 4].map((index) => {
      const price = lo + span * 0 + ((hi - lo) * index) / 4;
      return { price, y: y(price), label: chartPriceText(price) };
    }),
    ema20: { points: seriesPoints(ema20), drawn: ema20.filter((value) => value !== null).length },
    ema50: { points: seriesPoints(ema50), drawn: ema50.filter((value) => value !== null).length },
    support: support.map(Number).filter(Number.isFinite).map((price) => ({ price, y: y(price), label: chartPriceText(price) })),
    resistance: resistance.map(Number).filter(Number.isFinite).map((price) => ({ price, y: y(price), label: chartPriceText(price) })),
    setup: setup
      ? {
        tone: setup.action === "BUY" ? "#22c55e" : "#ef4444",
        zoneY: y(Number(setup.entry?.max)),
        zoneHeight: Math.max(2, y(Number(setup.entry?.min)) - y(Number(setup.entry?.max))),
        zoneWidth: width - padL - padR,
        stopY: y(Number(setup.stopLoss)),
        stopLabel: chartPriceText(setup.stopLoss),
        targets: (Array.isArray(setup.takeProfit) ? setup.takeProfit : []).map((target, index) => ({
          y: y(Number(target)),
          label: `TP${index + 1} ${chartPriceText(target)}`,
          opacity: Math.max(0.15, 0.9 - index * 0.25),
        })),
      }
      : null,
  };
}
