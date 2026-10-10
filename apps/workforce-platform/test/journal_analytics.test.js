/**
 * Journal analytics and confidence calibration — the "model/decision analytics"
 * half of row 8 in docs/migration/UNFINISHED_MODULES.md.
 *
 * The case prefixed `legacy 08-engine-journal` is ported 1:1 from
 * `tests/cases/08-engine-journal.php` ("journal analytics: groupings +
 * calibration verdicts"), including its fixture: twenty trades at confidence 0.3
 * split 50/50 and twenty at 0.9 split 13/7, which is exactly enough to make the
 * calibration verdict flip and exactly too few to make it interesting by accident.
 *
 * The HTTP cases run against the real file adapter with
 * `MARKET_DATA_REAL_PROVIDERS=0`, so nothing can reach the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";
import {
  CALIBRATION_MIN_SAMPLE,
  CALIBRATION_VERDICTS,
  CONFIDENCE_BUCKETS,
  GROUP_KEYS,
  MISSING_GROUP_KEY,
  NO_CONFIDENCE_NOTE,
  analyze,
  bucketMetrics,
  calibration,
} from "../src/modules/strategies/journal-analytics.js";

// ---- fixtures --------------------------------------------------------------

/**
 * The oracle's `$mk` closure. Field order and values match so both sides compute
 * the same aggregates from the same rows.
 */
function entry(pnl, confidence, index) {
  const at = (offset) => new Date((1_700_000_000 + offset) * 1000).toISOString();
  return {
    id: `j-${index}`,
    source: "backtest",
    symbol: index % 2 ? "BTCUSDT" : "ETHUSDT",
    market: "crypto",
    strategy: index % 2 ? "trend-following" : "breakout",
    strategy_version: "1.0.0",
    direction: "LONG",
    entry_time: at(index),
    entry_price: 100.0,
    exit_time: at(100 + index),
    exit_price: 101.0,
    position_size: 10.0,
    stop_loss: 98.0,
    take_profit: 105.0,
    fees: 1.0,
    slippage: 0.5,
    pnl,
    pnl_pct: 1.0,
    r_multiple: pnl / 20.0,
    reason: "t",
    ai_confidence: confidence,
    confidence_source: confidence !== null ? "strategy" : null,
    agent_consensus: null,
    risk_score: null,
    execution_time: at(index),
  };
}

/** The oracle's forty-entry sample: 50% win at low confidence, 65% at high. */
function oracleFixture() {
  const entries = [];
  for (let i = 0; i < 20; i += 1) entries.push(entry(i % 2 === 0 ? 15.0 : -10.0, 0.3, i));
  for (let i = 20; i < 40; i += 1) entries.push(entry(i % 3 === 0 ? -10.0 : 15.0, 0.9, i));
  return entries;
}

const GENEROUS = {
  RATE_LIMIT_STRATEGY_BACKTEST_MAX: "10000",
  RATE_LIMIT_STRATEGY_OPTIMIZE_MAX: "10000",
  STRATEGY_MAX_CONCURRENT_RUNS: "0",
};

async function signIn(app) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "rootadmin", password: "Root administrator pass" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return {
    cookie: cookieFrom(response),
    csrfToken: body.csrfToken,
    headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken },
  };
}

function harness(options = {}) {
  return createFileStoreApp({
    configOverrides: {
      env: {
        PUBLIC_BASE_URL: "https://site.example.test",
        MARKET_DATA_REAL_PROVIDERS: "0",
        ...GENEROUS,
        ...(options.env || {}),
      },
    },
    ...options,
  });
}

function rejectedFields(response) {
  const details = response.json()?.error?.details;
  const issues = Array.isArray(details) ? details : (details?.fields || []);
  return issues.map((issue) => issue.field);
}

// ============================================================================
// legacy tests/cases/08-engine-journal.php
// ============================================================================

test("legacy 08-engine-journal: groupings and calibration verdicts", () => {
  const entries = oracleFixture();

  const byStrategy = analyze(entries, "strategy");
  assert.equal(byStrategy.groups.length, 2);
  assert.equal(byStrategy.overall.closedTrades, 40);

  const cal = calibration(entries);
  assert.equal(cal.sufficientData, true);
  assert.equal(cal.buckets.length, 2);
  let highWin = 0;
  let lowWin = 0;
  for (const bucket of cal.buckets) {
    // The oracle matches on the label text, so the EN dash in "0–40%" is part of
    // the contract rather than typography.
    if (bucket.key.includes("80")) highWin = bucket.winRate;
    if (bucket.key.includes("0–40")) lowWin = bucket.winRate;
  }
  assert.ok(highWin > lowWin, `high-confidence win rate ${highWin} must exceed low ${lowWin}`);
  assert.equal(lowWin, 0.5);
  assert.equal(highWin, 0.65);
  assert.match(cal.verdict, /directionally informative/);

  const small = calibration(entries.slice(0, 10));
  assert.equal(small.sufficientData, false);
  assert.match(small.verdict, /Sample too small/);
});

// ============================================================================
// bucketMetrics
// ============================================================================

test("bucketMetrics reports null for what cannot be measured, and 0 for total P&L", () => {
  const empty = bucketMetrics([]);
  assert.deepEqual(empty, {
    count: 0,
    winRate: null,
    profitFactor: null,
    expectancyPnl: null,
    avgWin: null,
    avgLoss: null,
    // The one aggregate that stays numeric: a caller summing totalPnl across
    // groups would otherwise have to special-case the empty one.
    totalPnl: 0,
    avgRMultiple: null,
  });

  const allWins = bucketMetrics([entry(10, 0.5, 1), entry(5, 0.5, 2)]);
  assert.equal(allWins.count, 2);
  assert.equal(allWins.winRate, 1);
  assert.equal(allWins.profitFactor, null, "no losses means no measured profit factor");
  assert.equal(allWins.avgLoss, null);
  assert.equal(allWins.avgWin, 7.5);
  assert.equal(allWins.totalPnl, 15);
});

test("bucketMetrics counts a break-even trade as a loss and excludes open ones", () => {
  const closed = [entry(10, 0.5, 1), entry(0, 0.5, 2), entry(-5, 0.5, 3)];
  const metrics = bucketMetrics(closed);
  assert.equal(metrics.count, 3);
  assert.equal(metrics.winRate, 0.3333, "one win of three");
  // Two "losses" (0 and -5): grossLoss 5, grossWin 10.
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.avgLoss, -2.5);

  // An entry with a mark-to-market pnl but no exit_time is an OPEN trade and must
  // not be reported as a result.
  const withOpen = [...closed, { ...entry(999, 0.5, 4), exit_time: null }];
  assert.equal(bucketMetrics(withOpen).count, 3, "an open position is not a closed trade");
  assert.equal(bucketMetrics(withOpen).totalPnl, metrics.totalPnl);

  // …and neither is one with an exit but no realised pnl.
  const noPnl = [...closed, { ...entry(0, 0.5, 5), pnl: null }];
  assert.equal(bucketMetrics(noPnl).count, 3);
});

test("bucketMetrics rounds half away from zero, as PHP does", () => {
  // Math.round(-0.5) is -0 in JavaScript and -1 in PHP. avgLoss and expectancyPnl
  // are negative often enough that the difference would show up in a payload.
  const metrics = bucketMetrics([entry(-0.005, 0.5, 1)]);
  assert.equal(metrics.avgLoss, -0.01, "PHP round(-0.005, 2) is -0.01, Math.round would give -0");
  assert.equal(metrics.expectancyPnl, -0.01);
  assert.equal(metrics.avgRMultiple, -0.0003, "r_multiple -0.00025 rounds away from zero");
});

test("bucketMetrics leaves avgRMultiple null when no trade carries one", () => {
  const withoutR = [{ ...entry(10, 0.5, 1), r_multiple: null }];
  assert.equal(bucketMetrics(withoutR).avgRMultiple, null);
  const withR = [{ ...entry(10, 0.5, 1), r_multiple: 2 }];
  assert.equal(bucketMetrics(withR).avgRMultiple, 2);
});

// ============================================================================
// analyze
// ============================================================================

test("analyze groups by confidence into the four declared buckets", () => {
  const entries = [
    entry(10, 0.1, 1),   // 0–40%
    entry(10, 0.39, 2),  // 0–40% (upper edge, exclusive at 0.4)
    entry(10, 0.4, 3),   // 40–60% (boundary belongs to the higher bucket)
    entry(10, 0.75, 4),  // 60–80%
    entry(10, 1.0, 5),   // 80–100% — exactly 1.0 must land inside, hence max 1.0001
  ];
  const report = analyze(entries, "confidence");
  assert.deepEqual(report.groups.map((group) => group.key), [
    "0–40% (low)",
    "40–60% (moderate)",
    "60–80% (high)",
    "80–100% (very high)",
  ]);
  assert.deepEqual(report.groups.map((group) => group.metrics.count), [2, 1, 1, 1]);
  assert.equal(report.note, null, "confidence-tagged trades exist, so no note");
  assert.equal(report.groupBy, "confidence");
});

test("the top bucket's 1.0001 ceiling is what keeps confidence 1.0 measurable", () => {
  assert.equal(CONFIDENCE_BUCKETS.at(-1).max, 1.0001);
  const perfect = Array.from({ length: 3 }, (_, index) => entry(10, 1.0, index));
  const report = analyze(perfect, "confidence");
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].key, "80–100% (very high)");
  // A ceiling of exactly 1.0 with `min <= c < max` would drop these entirely.
  assert.equal(report.groups[0].metrics.count, 3);
});

test("analyze omits empty buckets rather than reporting them as zeroes", () => {
  const report = analyze([entry(10, 0.9, 1)], "confidence");
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].key, "80–100% (very high)");
});

test("analyze labels an untagged group with an EM dash, not the bucket's EN dash", () => {
  assert.equal(MISSING_GROUP_KEY, "—");
  assert.notEqual(MISSING_GROUP_KEY, "–", "the two dashes are different characters");
  const entries = [entry(10, 0.5, 1), { ...entry(-5, 0.5, 2), strategy: null }];
  const report = analyze(entries, "strategy");
  // The placeholder sorts LAST, not first: U+2014 is 0xE2 0x80 0x94 in UTF-8 and
  // 0x2014 in UTF-16, so it is greater than any ASCII byte or code unit. PHP's
  // sort() and JavaScript's default sort agree here, which is the only reason the
  // group order is comparable between the two editions.
  assert.deepEqual(report.groups.map((group) => group.key), ["trend-following", MISSING_GROUP_KEY]);
  assert.ok("t".codePointAt(0) < MISSING_GROUP_KEY.codePointAt(0));
});

test("analyze explains an empty confidence grouping instead of showing nothing", () => {
  const untagged = [entry(10, null, 1), entry(-5, null, 2)];
  const report = analyze(untagged, "confidence");
  assert.deepEqual(report.groups, []);
  assert.equal(report.note, NO_CONFIDENCE_NOTE);

  // An empty journal reads the same way, which is the legacy behaviour (0 === 0)
  // and the honest one: there is nothing tagged yet.
  const emptyReport = analyze([], "confidence");
  assert.equal(emptyReport.note, NO_CONFIDENCE_NOTE);
  assert.equal(emptyReport.overall.closedTrades, 0);

  // A non-confidence grouping carries no note, even when empty.
  assert.equal(analyze([], "strategy").note, null);
  assert.equal(analyze(untagged, "strategy").note, null);
});

test("analyze separates closed trades from open ones in the overall figures", () => {
  const entries = [
    entry(10, 0.5, 1),
    entry(-5, 0.5, 2),
    { ...entry(0, 0.5, 3), exit_time: null, pnl: null },
  ];
  const report = analyze(entries, "strategy");
  assert.equal(report.overall.closedTrades, 2);
  assert.equal(report.overall.openOrPending, 1);
  assert.equal(report.overall.count, 2);
  assert.equal(report.overall.totalPnl, 5);
});

test("analyze measures drawdown from a zero peak, so an early losing streak counts", () => {
  // Losing from the first trade: cumulative -10, -20, -30. With the peak starting
  // at 0 the drawdown is 30. Starting the peak at the first trade's equity would
  // have reported 20 and hidden the first loss.
  const losing = [
    { ...entry(-10, 0.5, 1), execution_time: "2026-01-01T00:00:00.000Z" },
    { ...entry(-10, 0.5, 2), execution_time: "2026-01-02T00:00:00.000Z" },
    { ...entry(-10, 0.5, 3), execution_time: "2026-01-03T00:00:00.000Z" },
  ];
  assert.equal(analyze(losing, "strategy").overall.maxDrawdownAbs, 30);

  // Win then lose: peak 20, trough 5, drawdown 15.
  const mixed = [
    { ...entry(20, 0.5, 1), execution_time: "2026-01-01T00:00:00.000Z" },
    { ...entry(-15, 0.5, 2), execution_time: "2026-01-02T00:00:00.000Z" },
  ];
  assert.equal(analyze(mixed, "strategy").overall.maxDrawdownAbs, 15);

  // Only ever winning: no drawdown at all.
  const winning = [
    { ...entry(10, 0.5, 1), execution_time: "2026-01-01T00:00:00.000Z" },
    { ...entry(10, 0.5, 2), execution_time: "2026-01-02T00:00:00.000Z" },
  ];
  assert.equal(analyze(winning, "strategy").overall.maxDrawdownAbs, 0);
  assert.equal(analyze([], "strategy").overall.maxDrawdownAbs, 0);
});

test("analyze orders by execution_time before walking the drawdown", () => {
  // Written out of order on purpose: if the walk used insertion order the peak
  // would be reached last and the drawdown would be reported as 0.
  const entries = [
    { ...entry(-25, 0.5, 3), execution_time: "2026-01-03T00:00:00.000Z" },
    { ...entry(30, 0.5, 1), execution_time: "2026-01-01T00:00:00.000Z" },
    { ...entry(5, 0.5, 2), execution_time: "2026-01-02T00:00:00.000Z" },
  ];
  assert.equal(analyze(entries, "strategy").overall.maxDrawdownAbs, 25);
});

test("analyze accepts every declared grouping and sorts group keys", () => {
  assert.deepEqual([...GROUP_KEYS], ["strategy", "market", "symbol", "source", "confidence"]);
  const entries = oracleFixture();
  for (const groupBy of GROUP_KEYS) {
    const report = analyze(entries, groupBy);
    assert.equal(report.groupBy, groupBy);
    assert.ok(report.groups.length >= 1, `${groupBy} must produce at least one group`);
    for (const group of report.groups) {
      assert.equal(typeof group.key, "string");
      assert.ok(group.metrics.count > 0, "an empty group must be omitted");
    }
    if (groupBy !== "confidence") {
      const keys = report.groups.map((group) => group.key);
      assert.deepEqual(keys, [...keys].sort(), `${groupBy} group keys must be sorted`);
    }
  }
  // The fixture alternates two symbols and two strategies.
  assert.deepEqual(analyze(entries, "symbol").groups.map((g) => g.key), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(analyze(entries, "source").groups.map((g) => g.key), ["backtest"]);
  assert.deepEqual(analyze(entries, "market").groups.map((g) => g.key), ["crypto"]);
});

// ============================================================================
// calibration
// ============================================================================

test("calibration refuses a verdict under 30 confidence-tagged closed trades", () => {
  assert.equal(CALIBRATION_MIN_SAMPLE, 30);
  const entries = Array.from({ length: 29 }, (_, index) => entry(10, 0.9, index));
  const report = calibration(entries);
  assert.equal(report.sufficientData, false);
  assert.equal(
    report.verdict,
    "Sample too small for a calibration verdict (29 confidence-tagged closed trades; need 30+). Collect more journal entries.",
  );
  // The buckets are still returned: the counts are informative even when the
  // verdict is not, and hiding them would leave the operator with nothing.
  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0].count, 29);

  assert.equal(calibration([]).sufficientData, false);
  assert.match(calibration([]).verdict, /\(0 confidence-tagged closed trades; need 30\+\)/);
  assert.deepEqual(calibration([]).buckets, []);
});

test("calibration counts only closed trades that carry a confidence", () => {
  // Thirty rows, but ten are untagged and ten are open, so only ten qualify.
  const tagged = Array.from({ length: 10 }, (_, index) => entry(10, 0.9, index));
  const untagged = Array.from({ length: 10 }, (_, index) => entry(10, null, 100 + index));
  const open = Array.from({ length: 10 }, (_, index) => ({ ...entry(10, 0.9, 200 + index), exit_time: null }));
  const report = calibration([...tagged, ...untagged, ...open]);
  assert.equal(report.sufficientData, false);
  assert.match(report.verdict, /\(10 confidence-tagged closed trades; need 30\+\)/);
});

test("calibration calls a non-monotonic signal out instead of flattering it", () => {
  // High confidence loses more than it wins; low confidence wins. That is the
  // failure mode the verdict exists to catch.
  const inverted = [
    ...Array.from({ length: 15 }, (_, index) => entry(10, 0.2, index)),
    ...Array.from({ length: 15 }, (_, index) => entry(-10, 0.9, 100 + index)),
  ];
  const report = calibration(inverted);
  assert.equal(report.sufficientData, true);
  assert.equal(report.verdict, CALIBRATION_VERDICTS.SKEPTICAL);
  assert.match(report.verdict, /does NOT consistently increase/);
  const low = report.buckets.find((bucket) => bucket.key.includes("0–40"));
  const high = report.buckets.find((bucket) => bucket.key.includes("80"));
  assert.equal(low.winRate, 1);
  assert.equal(high.winRate, 0);
});

test("calibration tolerates a dip of exactly 0.05 and no more", () => {
  // The slack is `previous - 0.05`, so with a low bucket at 1.0 the high bucket
  // must stay at or above 0.95. It exists because a one-trade difference between
  // buckets is noise, and calling noise a broken signal would train operators to
  // ignore the verdict altogether.
  const lowWins = Array.from({ length: 15 }, (_, index) => entry(10, 0.2, index)); // winRate 1.0

  const within = calibration([
    ...lowWins,
    ...Array.from({ length: 48 }, (_, index) => entry(10, 0.9, 100 + index)),
    ...Array.from({ length: 2 }, (_, index) => entry(-10, 0.9, 200 + index)),
  ]);
  assert.equal(within.sufficientData, true);
  const withinHigh = within.buckets.find((bucket) => bucket.key.includes("80"));
  assert.equal(withinHigh.winRate, 0.96, "48 of 50");
  // 0.96 is NOT below 1.0 - 0.05, so the trend still holds.
  assert.equal(within.verdict, CALIBRATION_VERDICTS.INFORMATIVE);

  // One more loss in the top bucket takes it to 0.94, which IS below the slack.
  // The boundary is sharp, and this is the case that decides whether the verdict
  // tells an operator to trust the signal or to stop and re-examine it.
  const beyond = calibration([
    ...lowWins,
    ...Array.from({ length: 47 }, (_, index) => entry(10, 0.9, 100 + index)),
    ...Array.from({ length: 3 }, (_, index) => entry(-10, 0.9, 200 + index)),
  ]);
  const beyondHigh = beyond.buckets.find((bucket) => bucket.key.includes("80"));
  assert.equal(beyondHigh.winRate, 0.94, "47 of 50");
  assert.equal(beyond.verdict, CALIBRATION_VERDICTS.SKEPTICAL);

  // A dip from 1.0 to 0.8 was never within tolerance — the slack is 0.05, not 0.2.
  const large = calibration([
    ...lowWins,
    ...Array.from({ length: 20 }, (_, index) => entry(10, 0.9, 100 + index)),
    ...Array.from({ length: 5 }, (_, index) => entry(-10, 0.9, 200 + index)),
  ]);
  assert.equal(large.buckets.find((bucket) => bucket.key.includes("80")).winRate, 0.8);
  assert.equal(large.verdict, CALIBRATION_VERDICTS.SKEPTICAL);
});

test("calibration reports expectancyR per bucket, or null when no trade carries one", () => {
  const entries = Array.from({ length: 30 }, (_, index) => entry(index % 2 ? 10 : -5, 0.9, index));
  const report = calibration(entries);
  assert.equal(report.buckets.length, 1);
  assert.equal(typeof report.buckets[0].expectancyR, "number");

  const withoutR = entries.map((item) => ({ ...item, r_multiple: null }));
  assert.equal(calibration(withoutR).buckets[0].expectancyR, null);
});

test("calibration buckets ascend by confidence, which is what the trend test assumes", () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, index) => entry(10, 0.9, index)),
    ...Array.from({ length: 10 }, (_, index) => entry(10, 0.1, 100 + index)),
    ...Array.from({ length: 10 }, (_, index) => entry(10, 0.5, 200 + index)),
  ];
  const report = calibration(entries);
  const positions = report.buckets.map((bucket) => CONFIDENCE_BUCKETS.findIndex((b) => b.key === bucket.key));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "buckets must stay in ascending order");
  assert.deepEqual(report.buckets.map((bucket) => bucket.key), [
    "0–40% (low)",
    "40–60% (moderate)",
    "80–100% (very high)",
  ]);
});

// ============================================================================
// HTTP surface
// ============================================================================

test("the four journal routes are registered under /api/v1/journal", async () => {
  const instance = await harness();
  try {
    const paths = instance.app.routes().map((route) => `${route.method} ${route.path}`);
    for (const expected of [
      "GET /api/v1/journal",
      "POST /api/v1/journal/manual",
      "GET /api/v1/journal/analytics/summary",
      "GET /api/v1/journal/analytics/calibration",
    ]) {
      assert.ok(paths.includes(expected), `${expected} must be registered`);
    }
    // The legacy `api/analytics/*` prefix is deliberately not reproduced: it would
    // sit two letters from Phase 5's `api/v1/analysis/*`.
    assert.ok(
      !paths.some((path) => path.includes("/api/v1/analytics")),
      "no /analytics prefix — see the divergence note in routes.js",
    );
  } finally {
    await instance.cleanup();
  }
});

test("every journal route requires a session, and the write is CSRF-gated", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    for (const url of [
      "/api/v1/journal",
      "/api/v1/journal/analytics/summary",
      "/api/v1/journal/analytics/calibration",
    ]) {
      const anonymous = await instance.app.inject({ method: "GET", url });
      assert.equal(anonymous.statusCode, 401, `GET ${url} must require a session`);
      const authorised = await instance.app.inject({ method: "GET", url, headers: session.headers });
      assert.equal(authorised.statusCode, 200, authorised.body);
    }

    const body = {
      symbol: "EURUSD", direction: "LONG", entryTime: "2026-10-01T10:00:00.000Z",
      entryPrice: 1.1, positionSize: 1000, reasonForTrade: "test",
    };
    const anonymous = await instance.app.inject({ method: "POST", url: "/api/v1/journal/manual", payload: body });
    assert.equal(anonymous.statusCode, 401);
    const cookieOnly = await instance.app.inject({
      method: "POST", url: "/api/v1/journal/manual", payload: body, headers: { cookie: session.cookie },
    });
    assert.equal(cookieOnly.statusCode, 403);
    assert.equal(cookieOnly.json().error.code, "CSRF_INVALID");
  } finally {
    await instance.cleanup();
  }
});

test("GET /journal lists entries and applies the filters", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    await instance.store.saveJournalEntry({ ...entry(10, 0.5, 1), source: "manual", symbol: "EURUSD", market: "forex", strategy: "breakout" });
    await instance.store.saveJournalEntry({ ...entry(-5, 0.5, 2), source: "backtest", symbol: "BTCUSDT", market: "crypto", strategy: "trend-following" });

    const all = await instance.app.inject({ method: "GET", url: "/api/v1/journal", headers: session.headers });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.json().entries.length, 2);

    const bySource = await instance.app.inject({
      method: "GET", url: "/api/v1/journal?source=manual", headers: session.headers,
    });
    assert.equal(bySource.json().entries.length, 1);
    assert.equal(bySource.json().entries[0].symbol, "EURUSD");

    const byStrategy = await instance.app.inject({
      method: "GET", url: "/api/v1/journal?strategy=trend-following", headers: session.headers,
    });
    assert.equal(byStrategy.json().entries.length, 1);

    // The symbol filter is upper-cased server-side, because symbols are stored
    // upper-cased and validate.js has no `uppercase` keyword.
    const bySymbol = await instance.app.inject({
      method: "GET", url: "/api/v1/journal?symbol=btcusdt", headers: session.headers,
    });
    assert.equal(bySymbol.json().entries.length, 1);
    assert.equal(bySymbol.json().entries[0].symbol, "BTCUSDT");

    // An unknown source is refused by the schema rather than silently matching nothing.
    const badSource = await instance.app.inject({
      method: "GET", url: "/api/v1/journal?source=nonsense", headers: session.headers,
    });
    assert.equal(badSource.statusCode, 400);
    assert.ok(rejectedFields(badSource).includes("source"));
  } finally {
    await instance.cleanup();
  }
});

test("POST /journal/manual derives the figures and returns 201", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/journal/manual", headers: session.headers,
      payload: {
        symbol: " eurusd ",
        direction: "LONG",
        entryTime: "2026-10-01T10:00:00.000Z",
        exitTime: "2026-10-01T14:00:00.000Z",
        entryPrice: 1.1000,
        exitPrice: 1.1200,
        positionSize: 10000,
        stopLoss: 1.0900,
        fees: 5,
        reasonForTrade: "broke the daily high on volume",
        aiConfidence: 0.72,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const saved = response.json();

    assert.equal(saved.source, "manual");
    assert.equal(saved.symbol, "EURUSD", "trimmed and upper-cased");
    assert.equal(saved.market, "forex", "the legacy default");
    // (1.12 - 1.10) * 10000 - 5 = 195
    assert.equal(saved.pnl, 195);
    // 195 / (10000 * 1.10) * 100
    assert.equal(saved.pnl_pct, 1.772727);
    // 195 / (|1.10 - 1.09| * 10000) = 1.95
    assert.equal(saved.r_multiple, 1.95);
    assert.equal(saved.ai_confidence, 0.72);
    assert.equal(saved.confidence_source, "manual", "the legacy default when a confidence is supplied");
    assert.equal(saved.backtest_id, null);
    assert.match(saved.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Normalised to canonical ISO-8601 UTC, which is what makes the analytics
    // ordering correct for rows this platform writes (divergence DV-5).
    assert.equal(saved.entry_time, "2026-10-01T10:00:00.000Z");
    assert.equal(saved.exit_time, "2026-10-01T14:00:00.000Z");
    assert.equal(saved.execution_time, saved.entry_time);

    assert.ok(await instance.store.listJournalEntries({ source: "manual" }).then((rows) => rows.length === 1));
    const { events } = await instance.store.listAuditEvents({ action: "journal.entry-recorded" });
    assert.equal(events.length, 1);
    assert.equal(events[0].entityType, "journal");
    assert.equal(events[0].details.symbol, "EURUSD");
  } finally {
    await instance.cleanup();
  }
});

test("POST /journal/manual leaves an unpriced trade unpriced", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const response = await instance.app.inject({
      method: "POST", url: "/api/v1/journal/manual", headers: session.headers,
      payload: {
        symbol: "BTCUSDT", direction: "SHORT", market: "crypto",
        entryTime: "2026-10-01T10:00:00.000Z", entryPrice: 60000, positionSize: 0.5,
        reasonForTrade: "still open",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const saved = response.json();
    // An open trade has no realised result. Reporting 0 here would be a lie that
    // the analytics would then aggregate.
    assert.equal(saved.pnl, null);
    assert.equal(saved.pnl_pct, null);
    assert.equal(saved.r_multiple, null);
    assert.equal(saved.exit_time, null);
    assert.equal(saved.exit_price, null);
    assert.equal(saved.ai_confidence, null);
    assert.equal(saved.confidence_source, null, "an untagged trade must not claim a provenance");
    assert.equal(saved.market, "crypto");

    // And it is excluded from the closed-trade aggregates.
    const summary = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/summary", headers: session.headers,
    });
    assert.equal(summary.json().overall.closedTrades, 0);
    assert.equal(summary.json().overall.openOrPending, 1);
  } finally {
    await instance.cleanup();
  }
});

test("POST /journal/manual refuses an exit before the entry and non-positive figures", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const post = (payload) =>
      instance.app.inject({ method: "POST", url: "/api/v1/journal/manual", headers: session.headers, payload });
    const valid = {
      symbol: "EURUSD", direction: "LONG", entryTime: "2026-10-02T10:00:00.000Z",
      entryPrice: 1.1, positionSize: 1000, reasonForTrade: "r",
    };

    const backwards = await post({ ...valid, exitTime: "2026-10-01T10:00:00.000Z", exitPrice: 1.2 });
    assert.equal(backwards.statusCode, 400, backwards.body);
    assert.equal(backwards.json().error.code, "EXIT_BEFORE_ENTRY");
    assert.match(backwards.json().error.message, /exitTime cannot precede entryTime/);

    const badEntry = await post({ ...valid, entryTime: "not a date" });
    assert.equal(badEntry.statusCode, 400);
    assert.equal(badEntry.json().error.code, "INVALID_ENTRY_TIME");
    assert.match(badEntry.json().error.message, /ISO 8601 expected/);

    const badExit = await post({ ...valid, exitTime: "also not a date" });
    assert.equal(badExit.statusCode, 400);
    assert.equal(badExit.json().error.code, "INVALID_EXIT_TIME");

    for (const [overrides, code] of [
      [{ entryPrice: 0 }, "INVALID_PRICE_OR_SIZE"],
      [{ entryPrice: -1 }, "INVALID_PRICE_OR_SIZE"],
      [{ positionSize: 0 }, "INVALID_PRICE_OR_SIZE"],
    ]) {
      const refused = await post({ ...valid, ...overrides });
      assert.equal(refused.statusCode, 400, JSON.stringify(overrides));
      assert.equal(refused.json().error.code, code);
      assert.match(refused.json().error.message, /prices and size must be positive/);
    }

    // An equal entry and exit is legal: a scratch trade is a real outcome.
    const scratch = await post({ ...valid, exitTime: "2026-10-02T11:00:00.000Z", exitPrice: 1.1 });
    assert.equal(scratch.statusCode, 201, scratch.body);
    assert.equal(scratch.json().pnl, 0);
  } finally {
    await instance.cleanup();
  }
});

test("POST /journal/manual validates its vocabulary and refuses an overlong rationale", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const post = (payload) =>
      instance.app.inject({ method: "POST", url: "/api/v1/journal/manual", headers: session.headers, payload });
    const valid = {
      symbol: "EURUSD", direction: "LONG", entryTime: "2026-10-02T10:00:00.000Z",
      entryPrice: 1.1, positionSize: 1000, reasonForTrade: "r",
    };

    for (const field of ["symbol", "direction", "entryTime", "entryPrice", "positionSize", "reasonForTrade"]) {
      const { [field]: _dropped, ...rest } = valid;
      const refused = await post(rest);
      assert.equal(refused.statusCode, 400, `a missing ${field} must be refused`);
      assert.ok(rejectedFields(refused).includes(field), `${field} must be named`);
    }

    const badDirection = await post({ ...valid, direction: "SIDEWAYS" });
    assert.equal(badDirection.statusCode, 400);
    assert.match(
      badDirection.json().error.details.find((issue) => issue.field === "direction").message,
      /LONG, SHORT/,
    );

    // Divergence: legacy truncated the rationale to 500 characters with mb_substr,
    // silently discarding the end of someone's reasoning. This refuses instead.
    const overlong = await post({ ...valid, reasonForTrade: "x".repeat(501) });
    assert.equal(overlong.statusCode, 400);
    assert.ok(rejectedFields(overlong).includes("reasonForTrade"));
    assert.equal((await post({ ...valid, reasonForTrade: "x".repeat(500) })).statusCode, 201);

    // A confidence outside 0..1 would be written and then silently excluded from
    // every calibration bucket, so it is refused at the door.
    const badConfidence = await post({ ...valid, aiConfidence: 5 });
    assert.equal(badConfidence.statusCode, 400);
    assert.ok(rejectedFields(badConfidence).includes("aiConfidence"));

    const smuggled = await post({ ...valid, source: "backtest" });
    assert.equal(smuggled.statusCode, 400, "a caller must not be able to set source itself");
    assert.ok(rejectedFields(smuggled).includes("source"));
  } finally {
    await instance.cleanup();
  }
});

test("GET /journal/analytics/summary honours groupBy and refuses an unknown one", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    for (const [index, item] of oracleFixture().entries()) {
      await instance.store.saveJournalEntry({ ...item, id: `j-${index}` });
    }

    const defaulted = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/summary", headers: session.headers,
    });
    assert.equal(defaulted.statusCode, 200, defaulted.body);
    assert.equal(defaulted.json().groupBy, "strategy", "the legacy default");
    assert.equal(defaulted.json().groups.length, 2);
    assert.equal(defaulted.json().overall.closedTrades, 40);

    const byConfidence = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/summary?groupBy=confidence", headers: session.headers,
    });
    assert.equal(byConfidence.json().groups.length, 2);
    assert.equal(byConfidence.json().note, null);

    const bad = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/summary?groupBy=moonphase", headers: session.headers,
    });
    assert.equal(bad.statusCode, 400);
    assert.match(
      bad.json().error.details.find((issue) => issue.field === "groupBy").message,
      new RegExp(GROUP_KEYS.join(", ")),
    );
  } finally {
    await instance.cleanup();
  }
});

test("GET /journal/analytics/calibration answers over the stored journal", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);

    // An empty journal is not an error: it is an honest "not enough data yet".
    const empty = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/calibration", headers: session.headers,
    });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().sufficientData, false);
    assert.deepEqual(empty.json().buckets, []);
    assert.match(empty.json().verdict, /Sample too small/);

    for (const [index, item] of oracleFixture().entries()) {
      await instance.store.saveJournalEntry({ ...item, id: `j-${index}` });
    }
    const full = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/calibration", headers: session.headers,
    });
    assert.equal(full.statusCode, 200, full.body);
    const report = full.json();
    assert.equal(report.sufficientData, true);
    assert.equal(report.buckets.length, 2);
    assert.match(report.verdict, /directionally informative/);
    // The DECIMAL columns came back through the file adapter as numbers, which is
    // what makes the win-rate arithmetic work at all.
    for (const bucket of report.buckets) {
      assert.equal(typeof bucket.winRate, "number");
      assert.ok(bucket.count > 0);
    }
  } finally {
    await instance.cleanup();
  }
});

test("a backtest's trades reach the journal analytics, closing the loop", async () => {
  const instance = await harness();
  try {
    const session = await signIn(instance.app);
    const run = await instance.app.inject({
      method: "POST", url: "/api/v1/backtesting/run", headers: session.headers,
      payload: { strategyId: "trend-following", symbol: "BTCUSDT", marketClass: "crypto", timeframe: "1h" },
    });
    assert.equal(run.statusCode, 200, run.body);
    const trades = run.json().trades.length;

    const journal = await instance.app.inject({
      method: "GET", url: "/api/v1/journal?source=backtest", headers: session.headers,
    });
    assert.equal(journal.json().entries.length, trades, "one journal row per simulated trade");

    const summary = await instance.app.inject({
      method: "GET", url: "/api/v1/journal/analytics/summary?groupBy=strategy", headers: session.headers,
    });
    assert.equal(summary.statusCode, 200, summary.body);
    const body = summary.json();
    assert.equal(body.overall.closedTrades, trades);
    if (trades > 0) {
      assert.equal(body.groups.length, 1);
      assert.equal(body.groups[0].key, "trend-following");
      assert.equal(body.groups[0].metrics.count, trades);
      // Every backtest trade carries the strategy's own confidence, so the
      // calibration buckets are populated without any manual tagging.
      const calibrationReport = await instance.app.inject({
        method: "GET", url: "/api/v1/journal/analytics/calibration", headers: session.headers,
      });
      const total = calibrationReport.json().buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      assert.equal(total, trades);
    }
  } finally {
    await instance.cleanup();
  }
});
