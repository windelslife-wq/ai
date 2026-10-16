/**
 * Lottery console logic — vocabulary, request assembly and response normalisation
 * (row 15). Plain ESM with no JSX and no server imports, for the same two reasons
 * as `portfolio.js`: the view stays a binding, and `test/client_lottery_console.test.js`
 * imports this module to check it against the *live* API — every statistic kind it
 * offers, every generator mode and every backtest strategy is executed against the
 * real endpoint, so the console cannot offer a value the engine refuses.
 *
 * The honesty rules this file exists to keep are the module's own (spec §41):
 *
 *  - A statistic is an observation about the past. Nothing here computes, or offers
 *    to compute, the chance of a future draw, and no helper names one.
 *  - Prize tiers are labels, never amounts: the platform stores no prize money.
 *  - A ticket is a *record* of numbers a person holds; it is never a purchase, and
 *    nothing in this file implies an order was placed.
 */

/** The seven statistic kinds the endpoint accepts, in reading order. */
export const STATISTICS_KINDS = Object.freeze([
  Object.freeze({ value: "numbers", label: "Main numbers" }),
  Object.freeze({ value: "stars", label: "Lucky Stars" }),
  Object.freeze({ value: "hot-cold", label: "Hot / cold" }),
  Object.freeze({ value: "distribution", label: "Distribution" }),
  Object.freeze({ value: "pairs", label: "Pairs" }),
  Object.freeze({ value: "triplets", label: "Triplets" }),
  Object.freeze({ value: "star-pairs", label: "Star pairs" }),
]);

/** The five generator modes the model config declares. */
export const GENERATOR_MODES = Object.freeze([
  Object.freeze({ value: "RANDOM", label: "Random" }),
  Object.freeze({ value: "BALANCED", label: "Balanced profile" }),
  Object.freeze({ value: "HISTORICAL", label: "Historical frequency" }),
  Object.freeze({ value: "DIVERSIFIED", label: "Diversified" }),
  Object.freeze({ value: "ANTI-POPULAR", label: "Anti-popular" }),
]);

/** The four seeded backtest strategies; the random baseline is mandatory (spec §25). */
export const BACKTEST_STRATEGIES = Object.freeze([
  Object.freeze({ value: "RANDOM_BASELINE", label: "Random baseline (mandatory reference)" }),
  Object.freeze({ value: "BALANCED_PROFILE", label: "Balanced profile" }),
  Object.freeze({ value: "HISTORICAL_FREQ", label: "Historical frequency" }),
  Object.freeze({ value: "ANTI_POPULAR", label: "Anti-popular" }),
]);

export const MAX_GENERATE_COUNT = 1000;
export const MAX_TICKET_LINES = 100;
export const DEFAULT_TICKET_METHOD = "MANUAL";

/* ------------------------------------------------------------------ parsing */

/**
 * `"1, 7,28"` → `[1, 7, 28]`. Returns `null` when any piece is not a positive
 * integer, so a typo is reported rather than silently dropped from a pool.
 */
export function parseNumberList(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return [];
  const pieces = raw.split(/[\s,;]+/).filter((piece) => piece !== "");
  const numbers = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    numbers.push(Number(piece));
  }
  return numbers;
}

/**
 * One ticket line per row: `mains | stars`, each side a comma- or space-separated
 * list. Blank rows are ignored; a row without a `|` is a problem, because guessing
 * which side a bare list means would store a ticket the person did not write.
 *
 * @returns {{lines: Array<{mains: number[], stars: number[]}>, problems: string[]}}
 */
export function parseTicketLines(text) {
  const problems = [];
  const lines = [];
  const rows = String(text ?? "").split("\n").map((row) => row.trim()).filter((row) => row !== "");
  if (rows.length === 0) problems.push("Add at least one line, in the form 1,2,3,4,5 | 1,2");
  if (rows.length > MAX_TICKET_LINES) problems.push(`A ticket holds at most ${MAX_TICKET_LINES} lines.`);
  rows.slice(0, MAX_TICKET_LINES).forEach((row, index) => {
    const [left, right, ...rest] = row.split("|");
    if (right === undefined || rest.length > 0) {
      problems.push(`Line ${index + 1}: use exactly one "|" between main numbers and Lucky Stars.`);
      return;
    }
    const mains = parseNumberList(left);
    const stars = parseNumberList(right);
    if (mains === null || stars === null) {
      problems.push(`Line ${index + 1}: numbers must be whole numbers separated by commas or spaces.`);
      return;
    }
    lines.push({ mains, stars });
  });
  return { lines, problems };
}

/** `[1, 7, 28]` → `"1 · 7 · 28"`; an empty list reads as an em dash, never as blanks. */
export function listToText(values) {
  const list = Array.isArray(values) ? values : [];
  return list.length ? list.map((value) => String(value)).join(" · ") : "—";
}

/* ------------------------------------------------------- request assembly */

/** Pre-flight for the line analyzer: both pools must be present and in range. */
export function validateAnalyzeForm(form, rules) {
  const problems = [];
  const mains = parseNumberList(form?.mains);
  const stars = parseNumberList(form?.stars);
  const mainCount = rules?.main?.count ?? 5;
  const starCount = rules?.stars?.count ?? 2;
  if (mains === null) problems.push({ field: "mains", message: "Main numbers must be whole numbers separated by commas." });
  else if (mains.length !== mainCount) problems.push({ field: "mains", message: `Enter exactly ${mainCount} main numbers.` });
  if (stars === null) problems.push({ field: "stars", message: "Lucky Stars must be whole numbers separated by commas." });
  else if (stars.length !== starCount) problems.push({ field: "stars", message: `Enter exactly ${starCount} Lucky Stars.` });
  return problems;
}

/** `/lottery/analyze` query string. Empty pools are omitted rather than sent as "". */
export function buildAnalyzeQuery(form) {
  const mains = parseNumberList(form?.mains) ?? [];
  const stars = parseNumberList(form?.stars) ?? [];
  const params = new URLSearchParams();
  if (mains.length) params.set("mains", mains.join(","));
  if (stars.length) params.set("stars", stars.join(","));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Pre-flight for the generator before it persists a report. */
export function validateGenerateForm(form) {
  const problems = [];
  const count = Number(form?.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
    problems.push({ field: "count", message: `Lines must be a whole number between 1 and ${MAX_GENERATE_COUNT}.` });
  }
  if (!GENERATOR_MODES.some((entry) => entry.value === form?.mode)) {
    problems.push({ field: "mode", message: "Choose a generator mode." });
  }
  const seedRaw = String(form?.seed ?? "").trim();
  if (seedRaw !== "" && !Number.isInteger(Number(seedRaw))) {
    problems.push({ field: "seed", message: "A seed must be a whole number, or blank for a random one." });
  }
  for (const [field, label] of [["locks", "Locked numbers"], ["excludes", "Excluded numbers"]]) {
    if (parseNumberList(form?.[field]) === null) {
      problems.push({ field, message: `${label} must be whole numbers separated by commas, or blank.` });
    }
  }
  return problems;
}

/**
 * The generator body. `locks`/`excludes` carry the endpoint's own shape
 * (`{mains: [...]}`), and are omitted entirely when empty rather than sent as
 * empty objects — the engine's defaults are then the ones that apply.
 */
export function buildGenerateBody(form) {
  const body = {
    mode: String(form?.mode ?? "RANDOM"),
    count: Number(form?.count ?? 1),
  };
  const seedRaw = String(form?.seed ?? "").trim();
  if (seedRaw !== "") body.seed = Number(seedRaw);
  const locks = parseNumberList(form?.locks) ?? [];
  const excludes = parseNumberList(form?.excludes) ?? [];
  if (locks.length) body.locks = { mains: locks };
  if (excludes.length) body.excludes = { mains: excludes };
  return body;
}

/** The ticket body. `configuration` records what the console was told, nothing more. */
export function buildTicketBody(form, { lines, generationMethod = DEFAULT_TICKET_METHOD } = {}) {
  const body = {
    name: String(form?.name ?? "").trim() || "Untitled ticket",
    lines,
    generationMethod: String(generationMethod || DEFAULT_TICKET_METHOD),
  };
  const drawDate = String(form?.drawDate ?? "").trim();
  if (drawDate !== "") body.drawDate = drawDate;
  return body;
}

/** The backtest body; `0`/blank window means "the engine's default window". */
export function buildBacktestBody(form) {
  const body = { strategy: String(form?.strategy ?? "RANDOM_BASELINE") };
  const lines = Number(form?.lines);
  if (Number.isInteger(lines) && lines > 0) body.lines = lines;
  const window = Number(form?.window);
  if (Number.isInteger(window) && window > 0) body.window = window;
  return body;
}

/** The comparison body — always includes the mandatory baseline (spec §25). */
export function buildCompareBody(form) {
  const chosen = (Array.isArray(form?.strategies) ? form.strategies : []).map((value) => String(value));
  const strategies = [...new Set(["RANDOM_BASELINE", ...chosen])];
  const body = { strategies };
  const lines = Number(form?.lines);
  if (Number.isInteger(lines) && lines > 0) body.lines = lines;
  const window = Number(form?.window);
  if (Number.isInteger(window) && window > 0) body.window = window;
  return body;
}

/* --------------------------------------------------------------- formatting */

export function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(decimals);
}

/** Counts are integers in the payload; a missing count is an em dash, never 0. */
export function formatCount(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "—";
}

export function formatDate(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "—";
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : raw;
}

export function formatDateTime(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "—";
  const date = new Date(raw);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : raw;
}

/** A draw's main numbers, preferring the typed `numbers` rows over the payload. */
export function drawNumbers(draw, kind) {
  const rows = (draw?.numbers ?? []).filter((row) => String(row?.kind ?? "").toUpperCase() === kind);
  if (rows.length) {
    return rows.slice().sort((a, b) => Number(a.position) - Number(b.position)).map((row) => Number(row.number));
  }
  const key = kind === "STAR" ? "stars" : "main";
  const payload = Array.isArray(draw?.payload?.[key]) ? draw.payload[key] : [];
  return payload.map((value) => Number(value));
}

/**
 * Verification state of a stored draw. `VERIFIED` is the only state a ticket may be
 * checked against, so it gets its own tone rather than being one badge among many.
 */
export function verificationTone(status) {
  const value = String(status ?? "").toUpperCase();
  if (value === "VERIFIED") return "badge-live";
  if (value === "CONFLICT" || value === "REJECTED") return "badge-warn";
  return "badge-muted";
}

/** Provider state → badge tone. Unknown states stay neutral, never "healthy". */
export function providerTone(state) {
  const value = String(state ?? "").toUpperCase();
  if (value === "ONLINE") return "badge-live";
  if (value === "DEGRADED" || value === "OFFLINE") return "badge-warn";
  return "badge-muted";
}

/* ------------------------------------------------- response normalisation */

/**
 * Turn one statistic kind's payload into a uniform table.
 *
 * The seven kinds answer with genuinely different shapes — a per-number map, two
 * ranked maps, or a ranked group map — so the branch lives here, in one tested
 * place, instead of in the view. Every cell is a string, so a missing field renders
 * as an em dash rather than `undefined`.
 *
 * @returns {{columns: string[], rows: string[][]}}
 */
export function statisticsRows(kind, data) {
  const map = data && typeof data === "object" ? data : {};

  if (kind === "numbers" || kind === "stars") {
    const entries = Object.values(map.numbers ?? {})
      .slice()
      .sort((a, b) => Number(a.number) - Number(b.number));
    return {
      columns: ["Number", "Appearances", "Appearance %", "Last seen", "Current gap", "Avg gap", "Trend (recent − overall %)"],
      rows: entries.map((entry) => [
        formatCount(entry.number),
        formatCount(entry.appearances),
        formatNumber(entry.appearancePct, 2),
        formatDate(entry.lastAppearance),
        formatCount(entry.currentGap),
        formatNumber(entry.avgGap, 2),
        formatNumber(entry.trend, 2),
      ]),
    };
  }

  if (kind === "hot-cold") {
    const hot = Object.entries(map.hot ?? {});
    const cold = Object.entries(map.cold ?? {});
    const length = Math.max(hot.length, cold.length);
    const rows = [];
    for (let index = 0; index < length; index += 1) {
      rows.push([
        String(index + 1),
        hot[index] ? `${hot[index][0]} (${formatCount(hot[index][1])})` : "—",
        cold[index] ? `${cold[index][0]} (${formatCount(cold[index][1])})` : "—",
      ]);
    }
    return { columns: ["Rank", "Hot (appearances in window)", "Cold (appearances in window)"], rows };
  }

  if (kind === "pairs" || kind === "triplets" || kind === "star-pairs") {
    const groups = Object.entries(map.groups ?? {});
    const ranked = Object.entries(map.top ?? {});
    // The endpoint answers both a full group map and a ranked `top`; the console
    // shows the ranked list, and falls back to the full map when `top` is absent.
    const source = ranked.length ? ranked : groups;
    return {
      columns: ["Members", "Times drawn together", "Last seen together", "Avg gap", "Max gap"],
      rows: source.map(([key, entry]) => [
        key,
        formatCount(entry?.count),
        formatDate(entry?.lastSeen),
        formatNumber(entry?.avgGap, 2),
        formatCount(entry?.maxGap),
      ]),
    };
  }

  return { columns: [], rows: [] };
}

/**
 * The distribution kind is metrics, not a ranking. Returned as label/value pairs so
 * the view renders what the engine computed instead of re-deriving a share.
 */
export function distributionMetrics(data) {
  const map = data && typeof data === "object" ? data : {};
  const pairs = [];
  const push = (label, value) => pairs.push({ label, value: String(value ?? "—") });

  push("Draws in window", formatCount(map.totalDraws));
  for (const [label, count] of Object.entries(map.oddEven ?? {})) {
    push(`Odd / even — ${label}`, `${formatCount(count)} (${formatNumber(map.oddEvenPct?.[label], 2)}%)`);
  }
  for (const [label, count] of Object.entries(map.lowHigh ?? {})) {
    push(`Low / high — ${label}`, `${formatCount(count)} (${formatNumber(map.lowHighPct?.[label], 2)}%)`);
  }
  if (map.lowBound !== undefined) push("Low/high boundary", `≤ ${formatCount(map.lowBound)}`);
  push("Sum — min / max", `${formatCount(map.sum?.min)} / ${formatCount(map.sum?.max)}`);
  push("Sum — avg / median", `${formatNumber(map.sum?.avg, 2)} / ${formatNumber(map.sum?.median, 2)}`);
  push("Spread — min / max", `${formatCount(map.spread?.min)} / ${formatCount(map.spread?.max)}`);
  push("Spread — avg", formatNumber(map.spread?.avg, 2));
  push("Draws with consecutive numbers", `${formatCount(map.consecutive?.drawsWithConsecutive)} (${formatNumber(map.consecutive?.pct, 2)}%)`);
  push("Longest consecutive run", formatCount(map.consecutive?.longestRun));
  for (const [length, count] of Object.entries(map.consecutive?.runLengthDistribution ?? {})) {
    push(`Runs of ${length}`, formatCount(count));
  }
  push("Observation window", map.window === undefined ? "all stored draws" : `${formatCount(map.window)} draws`);
  return pairs;
}

/**
 * The performance overview's tier table.
 *
 * `byTier` is a tier→count map, **except** when nothing has been checked, where the
 * service returns `[]` (its own quirk, pinned by the server tests). Both spellings
 * are accepted here so an empty history renders as an empty table rather than
 * crashing or inventing a tier.
 */
export function tierRows(byTier) {
  const entries = Array.isArray(byTier) ? [] : Object.entries(byTier ?? {});
  return entries.map(([tier, count]) => [String(tier), formatCount(count)]);
}

/** A backtest report's match distribution as label/value pairs. */
export function matchDistribution(report) {
  const pairs = [];
  for (const [index, count] of (report?.matchDistribution?.mains ?? []).entries()) {
    pairs.push({ label: `${index} main match${index === 1 ? "" : "es"}`, value: formatCount(count) });
  }
  for (const [index, count] of (report?.matchDistribution?.stars ?? []).entries()) {
    pairs.push({ label: `${index} star match${index === 1 ? "" : "es"}`, value: formatCount(count) });
  }
  return pairs;
}

/** One generated line as the console prints it. */
export function generatedLineText(line) {
  return `${listToText(line?.mains)} | ${listToText(line?.stars)}`;
}
