/**
 * PHP↔Node differential parity for the sports measured half (row 14, slice 5).
 *
 * Every expectation is PHP's output, captured in `test/fixtures/sports-parity-golden.json`
 * under `cases.slice5` by `runtime/sports-parity.mjs`. The slice-5 engines are
 * repository-bound, so the PHP generator drives each REAL legacy class over a scripted
 * fake repository — an array-backed implementation of the real
 * `Aegis\Persistence\SportsRepository` interface — and this file drives the Node port
 * over an equally scripted store, reading the scenario from the golden file itself, so
 * the two sides cannot disagree about what was computed.
 *
 * The three assertion kinds are the slice-3 test's, and the difference matters:
 *
 *  1. **Exact** — the Node result equals PHP's, to the last double and the last
 *     character. This is the default, and it covers result verification, settlement
 *     selection rules, the settlement arithmetic (effective odds, P/L, void policy),
 *     performance analytics, the drift windows and reason strings, the per-model
 *     metrics core, the backtest refusals and one full identity-replay backtest.
 *
 *  2. **Corrected-oracle** — where a documented divergence changes a number. The
 *     identity replay is chosen precisely so DV-12 does NOT bite: legacy's linear form
 *     and the port's logistic map are the same function at intercept 0 / slope 1.
 *
 *  3. **Evidence** — where legacy is wrong, the test asserts the wrongness so a future
 *     legacy fix is noticed rather than absorbed. Here that is F-36 again: PHP casts
 *     each squared error to int inside `CalibrationEngine::evaluate`, so PHP's Brier is
 *     always 0.0 — in the drift windows, the performance report and the backtest
 *     report — while the port computes the real score. Each occurrence asserts the
 *     golden value IS 0.0 and the port's is real, and only then compares the rest.
 *
 * Not driven here, and why: `ModelPerformanceService` snapshots are recorded as
 * evidence but not compared symmetrically, because the port measures without
 * persisting (a `performance_snapshots` writer is row-19 scope — the table has no
 * writer this side, and pretending otherwise would be the fabrication the port
 * refuses). The `SportsCronService` is row-19 entirely.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSettlementService } from "../src/modules/sports/settlement.js";
import { settleSelection, verifyResult } from "../src/modules/sports/result-verification.js";
import { performanceReport, summarizeTickets } from "../src/modules/sports/performance-analytics.js";
import {
  ACCURACY_DROP_THRESHOLD,
  BASELINE_DAYS,
  BRIER_RISE_THRESHOLD,
  ECE_THRESHOLD,
  MIN_RECENT_SAMPLES,
  RECENT_DAYS,
  createModelDriftService,
} from "../src/modules/sports/drift.js";
import { createSportsIntelligenceService } from "../src/modules/sports/intelligence-service.js";
import { runBacktest } from "../src/modules/sports/backtester.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/sports-parity-golden.json", import.meta.url), "utf8"));
const slice5 = golden.cases?.slice5;

/**
 * The instant the Node side stamps wherever the port takes a clock. PHP's stamping
 * calls (`gmdate('c')` with no injectable clock) were unset by the generator, and the
 * same field is unset here after the call — so the stamped FORMAT is out of scope for
 * parity (the engine unit tests pin it) and everything else is exact.
 */
const FIXED_MS = Date.parse("2026-03-01T12:00:00Z");

/**
 * Canonical form for comparison — the slice-3 test's canon. JSON round-trips away
 * `undefined`, PHP's empty array `[]` stands for JavaScript's empty object, and `-0`
 * is folded into `0`.
 */
function canon(value) {
  if (value === -0) return 0;
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [];
    const out = {};
    for (const key of keys.sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

function asJson(value) {
  return canon(JSON.parse(JSON.stringify(value)));
}

function expectOk(entry, label) {
  assert.equal(entry.ok, true, `${label}: PHP threw ${entry.error ?? "(no message)"}`);
  return entry.value;
}

/** Compare one captured case: the value when PHP returned one, the message when it refused. */
function assertOutcome(label, expected, actual) {
  assert.equal(actual.ok, expected.ok, `${label}: expected ${expected.ok ? "a value" : `the refusal "${expected.error}"`}, got ${actual.ok ? "a value" : `"${actual.error?.message ?? actual.error}"`}`);
  if (expected.ok) {
    assert.deepEqual(asJson(actual.value), canon(expected.value), `${label}: value differs from PHP`);
  } else {
    assert.equal(actual.error?.message ?? String(actual.error), expected.error, `${label}: refusal message differs from PHP`);
  }
}

test("the slice-5 golden group exists and covers every case group", () => {
  assert.ok(slice5, "the golden file has no slice5 group — regenerate with node runtime/sports-parity.mjs");
  for (const group of ["verify", "settleSelection", "settlement", "performance", "drift", "metricsFor", "backtestRefusals", "backtestRun"]) {
    assert.ok(slice5[group], `the golden file has no slice5.${group} group`);
  }
  assert.ok(Object.keys(slice5.verify).length >= 12, `expected at least 12 verify cases, got ${Object.keys(slice5.verify).length}`);
  assert.ok(Object.keys(slice5.settleSelection).length >= 8, `expected at least 8 settleSelection cases, got ${Object.keys(slice5.settleSelection).length}`);
  assert.ok(Object.keys(slice5.settlement).length >= 12, `expected at least 12 settlement scenarios, got ${Object.keys(slice5.settlement).length}`);
  assert.ok(Object.keys(slice5.performance).length >= 4, `expected at least 4 performance cases, got ${Object.keys(slice5.performance).length}`);
  assert.ok(Object.keys(slice5.drift.scenarios).length >= 4, `expected at least 4 drift scenarios, got ${Object.keys(slice5.drift.scenarios).length}`);
});

// ── verify: the attestation verdict ─────────────────────────────────────────────

test("result verification agrees with PHP on every verdict, refusals included", () => {
  for (const [name, entry] of Object.entries(slice5.verify)) {
    // Recorded divergence SP-35: PHP's `is_int(2.0)` is false, so PHP refuses a
    // float 2.0 even though it is integral. JavaScript erased the distinction before
    // the port could see it — `JSON.parse("2.0")` IS `2` — and every caller this
    // platform has (the settlement paths) already coerces the stored column with
    // `Number(...)`, as legacy coerces with `(int)`. The port therefore cannot
    // reproduce the refusal and does not pretend to; the golden case stays as the
    // evidence of what PHP does.
    if (/float score/.test(name)) {
      const verdict = verifyResult(entry.input, new Date(FIXED_MS));
      assert.equal(verdict.verified, true, "verify/float: the port accepts an integral score that arrived as 2.0");
      assert.equal(verdict.homeScore, 2);
      continue;
    }
    const actual = outcomeOf(() => {
      const verdict = verifyResult(entry.input, new Date(FIXED_MS));
      if (verdict && "verifiedAt" in verdict) delete verdict.verifiedAt;
      return verdict;
    });
    assertOutcome(`verify/${name}`, entry.result, actual);
  }
});

// ── settleSelection: the one market rule ────────────────────────────────────────

test("selection settlement agrees with PHP on the OVER_1_5 rule and on every refusal", () => {
  for (const [name, entry] of Object.entries(slice5.settleSelection)) {
    const actual = outcomeOf(() => settleSelection(entry.input.selection, entry.input.verified));
    assertOutcome(`settleSelection/${name}`, entry.result, actual);
  }
});

// ── settlement: the service over a scripted store ───────────────────────────────

/**
 * A scripted settlement store: it serves only the rows the golden scenario scripted
 * and records every write, mirroring the PHP generator's `ScriptedSportsRepository`.
 * A call the scenario did not script throws, so a silent empty answer cannot hide a
 * port that reads something PHP does not.
 */
function settlementStore(repo) {
  const writes = { ticketPatches: [], selectionPatches: [], recordedOutcomes: [] };
  const store = {
    findSportsTicket: async (id) => repo.tickets?.[id] ?? null,
    listSportsTicketSelections: async (ticketId) => {
      if (!("selections" in repo)) throw new Error(`scenario did not script selections`);
      return repo.selections[ticketId] ?? [];
    },
    activeSportsConfiguration: async () => repo.configuration ?? null,
    updateSportsTicket: async (id, patch) => void writes.ticketPatches.push({ id, patch }),
    updateSportsTicketSelection: async (id, patch) => void writes.selectionPatches.push({ id, patch }),
    recordSportsTicketOutcome: async (id, pnl) => void writes.recordedOutcomes.push({ ticketId: id, pnl }),
    findSportsResult: async (matchId, providerId) => {
      if (!("results" in repo)) throw new Error(`scenario did not script results`);
      return repo.results[`${matchId}:${providerId}`] ?? null;
    },
    findSportsResultByMatch: async (matchId) => {
      if (!("resultByMatch" in repo)) throw new Error(`scenario did not script resultByMatch`);
      return repo.resultByMatch[matchId] ?? null;
    },
    recordAudit: async () => {},
  };
  return { store, writes };
}

async function runSettlementCalls(service, calls) {
  const returns = [];
  for (const [method, ...args] of calls) {
    returns.push(await outcomeOfAsync(() => service[method](...args)));
  }
  return returns;
}

/**
 * The settlement scenarios capture a list of outcome envelopes (one per service
 * call). PHP's envelope names the exception CLASS too; the port throws plain Error /
 * AppError, so only the message is compared, exactly as `assertOutcome` does.
 */
function compareReturns(label, phpReturns, nodeReturns) {
  assert.equal(nodeReturns.length, phpReturns.length, `${label}: the call count differs from PHP`);
  for (let i = 0; i < phpReturns.length; i++) {
    const php = phpReturns[i];
    const node = nodeReturns[i];
    assert.equal(node.ok, php.ok, `${label}[${i}]: expected ${php.ok ? "a value" : `the refusal "${php.error}"`}`);
    if (php.ok) assert.deepEqual(asJson(node.value), canon(php.value), `${label}[${i}]: the return differs from PHP`);
    else assert.equal(node.error?.message ?? String(node.error), php.error, `${label}[${i}]: refusal message differs from PHP`);
  }
}

/**
 * The port's repository update takes camelCase patch keys (the adapters map them to
 * columns); legacy's takes the column names directly. The naming is adapter API, not
 * behaviour — map it away so the comparison is of WHAT was written.
 */
const patchToColumnNames = (patch) => Object.fromEntries(Object.entries(patch).map(([key, value]) => [
  { settlementStatus: "settlement_status", totalOdds: "total_odds" }[key] ?? key,
  value,
]));

test("ticket settlement agrees with PHP on status, effective odds, P/L and every write", async () => {
  for (const [name, scenario] of Object.entries(slice5.settlement)) {
    const { store, writes } = settlementStore(scenario.input.repo);
    const service = createSettlementService({ store, now: () => FIXED_MS });
    const returns = await runSettlementCalls(service, scenario.input.calls);
    compareReturns(`settlement/${name}`, scenario.returns, returns);
    const nodeTicketPatches = writes.ticketPatches.map((write) => ({ id: write.id, patch: patchToColumnNames(write.patch) }));
    assert.deepEqual(asJson(nodeTicketPatches), canon(scenario.ticketPatches), `settlement/${name}: the ticket writes differ from PHP`);
    assert.deepEqual(asJson(writes.selectionPatches), canon(scenario.selectionPatches), `settlement/${name}: the selection writes differ from PHP`);
    assert.deepEqual(asJson(writes.recordedOutcomes), canon(scenario.recordedOutcomes), `settlement/${name}: the recorded P/L differs from PHP`);
  }
});

// ── performance: the pure report ────────────────────────────────────────────────

test("performance analytics agrees with PHP on the full report and on summarize — the Brier gap is F-36", () => {
  for (const [name, entry] of Object.entries(slice5.performance)) {
    const expectedReport = expectOk(entry.report, `performance/${name}`);
    // F-36 evidence: PHP's calibration Brier is the truncated zero when outcomes exist.
    if (expectedReport.calibration) {
      assert.equal(expectedReport.calibration.brier, 0, `performance/${name}: PHP's Brier is no longer 0.0 — legacy fixed F-36; regenerate and revisit`);
    }
    const report = outcomeOf(() => performanceReport(entry.input.tickets, entry.input.selections, entry.input.outcomes, entry.input.context));
    if (report.ok && report.value?.calibration && expectedReport.calibration) {
      assert.ok(report.value.calibration.brier > 0, `performance/${name}: the port's Brier should be the real (positive) score`);
      report.value.calibration = { ...report.value.calibration, brier: 0 };
    }
    assertOutcome(`performance/${name}/report`, entry.report, report);
    const summary = outcomeOf(() => summarizeTickets(entry.input.tickets));
    assertOutcome(`performance/${name}/summarize`, entry.summarize, summary);
  }
});

// ── drift: the monitor over a scripted store ────────────────────────────────────

test("the drift monitor's thresholds are legacy's, as constants", () => {
  assert.equal(RECENT_DAYS, slice5.drift.constants.RECENT_DAYS);
  assert.equal(BASELINE_DAYS, slice5.drift.constants.BASELINE_DAYS);
  assert.equal(MIN_RECENT_SAMPLES, slice5.drift.constants.MIN_RECENT_SAMPLES);
  assert.equal(ACCURACY_DROP_THRESHOLD, slice5.drift.constants.ACCURACY_DROP_THRESHOLD);
  assert.equal(BRIER_RISE_THRESHOLD, slice5.drift.constants.BRIER_RISE_THRESHOLD);
  assert.equal(ECE_THRESHOLD, slice5.drift.constants.ECE_THRESHOLD);
});

function driftStore(scenario) {
  return {
    listSportsModelVersions: async () => scenario.models,
    listSportsPredictionOutcomes: async () => scenario.outcomes,
    recordAudit: async () => {},
    saveSportsModelMetrics: async () => {},
  };
}

test("the drift monitor agrees with PHP on statuses, windows and reason strings — and the Brier divergence is F-36, not a port bug", async () => {
  for (const [name, scenario] of Object.entries(slice5.drift.scenarios)) {
    const expected = expectOk(scenario.result, `drift/${name}`);
    // F-36 evidence first: every PHP window with samples has Brier exactly 0.0.
    for (const report of expected.models) {
      for (const window of [report.recent, report.baseline]) {
        if (window && window.samples > 0) {
          assert.equal(window.brier, 0, `drift/${name}: PHP's Brier is no longer 0.0 — legacy fixed F-36; regenerate and revisit this evidence`);
        }
      }
    }
    const service = createModelDriftService({ store: driftStore(scenario.input), notifications: null, now: () => FIXED_MS });
    const actual = await service.monitor({ now: slice5.drift.now });
    assert.equal(actual.warnings, expected.warnings, `drift/${name}: the warning count differs from PHP`);
    assert.equal(actual.models.length, expected.models.length, `drift/${name}: the model count differs from PHP`);
    for (let i = 0; i < expected.models.length; i++) {
      const php = expected.models[i];
      const node = actual.models[i];
      assert.deepEqual(asJson(node.model), canon(php.model), `drift/${name}: the model row differs from PHP`);
      assert.equal(node.status, php.status, `drift/${name}: status differs from PHP (${php.status} vs ${node.status})`);
      for (const key of ["recent", "baseline"]) {
        if (php[key] === null) {
          assert.equal(node[key], null, `drift/${name}: ${key} should be null as PHP reports it`);
          continue;
        }
        // Brier: PHP's is the F-36 zero; the port's is the real score. Everything
        // else — samples, accuracy, ECE — is compared exactly.
        assert.equal(node[key].samples, php[key].samples, `drift/${name}: ${key}.samples differs`);
        assert.equal(node[key].accuracy, php[key].accuracy, `drift/${name}: ${key}.accuracy differs`);
        assert.equal(node[key].ece, php[key].ece, `drift/${name}: ${key}.ece differs`);
        if (php[key].brier === 0 && node[key].brier !== 0) {
          assert.ok(node[key].brier > 0, `drift/${name}: ${key}.brier should be the real (positive) score, got ${node[key].brier}`);
        } else {
          assert.equal(node[key].brier, php[key].brier, `drift/${name}: ${key}.brier differs`);
        }
      }
      // Reasons: equal, except that the port may add exactly the Brier-rise reason
      // legacy's truncated score can never produce.
      const phpReasons = php.reasons;
      const nodeReasons = node.reasons;
      const extra = nodeReasons.filter((reason) => !phpReasons.includes(reason));
      const missing = phpReasons.filter((reason) => !nodeReasons.includes(reason));
      assert.deepEqual(missing, [], `drift/${name}: the port is missing PHP's reasons`);
      for (const reason of extra) {
        assert.match(reason, /^Brier error rose /, `drift/${name}: the only permitted extra reason is the Brier rise, got "${reason}"`);
      }
      if (extra.length === 0) {
        assert.deepEqual(nodeReasons, phpReasons, `drift/${name}: reason strings differ from PHP`);
      }
    }
  }
});

// ── metricsFor: the per-model metric core ───────────────────────────────────────

function metricsStore(input) {
  return {
    listSportsModelVersions: async () => input.models,
    listSportsPredictions: async () => [],
    listSportsPredictionOutcomes: async () => input.outcomes,
    listSportsSettledSelections: async () => input.selections,
  };
}

test("the per-model metrics core agrees with PHP's metricsFor — accuracy, tickets, drawdown, breakdowns", async () => {
  const entry = slice5.metricsFor;
  const expected = expectOk(entry.result, "metricsFor");
  // F-36 evidence: PHP's snapshot and window Brier are the truncated zero.
  assert.equal(expected.brier, 0, "metricsFor: PHP's Brier is no longer 0.0 — legacy fixed F-36; regenerate and revisit");
  assert.equal(entry.snapshot.length, 1, "metricsFor: PHP wrote exactly one live snapshot");
  assert.equal(entry.snapshot[0].brier, 0, "metricsFor: PHP's snapshot Brier is no longer 0.0");
  assert.equal(entry.snapshot[0].sample_type, "live");
  assert.equal(entry.snapshot[0].model_version_id, 7);

  const service = createSportsIntelligenceService({ store: metricsStore(entry.input), now: () => FIXED_MS });
  const measured = await service.modelPerformance({ windowDays: entry.input.windowDays });
  const nodeMetrics = measured.comparison[0].metrics;
  // The port measures without persisting (no snapshot writer until row 19); the
  // snapshot PHP wrote is evidence above, not a symmetric comparison.
  const projected = {
    samples: nodeMetrics.samples,
    accuracy: nodeMetrics.accuracy,
    brier: nodeMetrics.brier,
    ece: nodeMetrics.ece,
    settledTickets: nodeMetrics.settledTickets,
    winRate: nodeMetrics.winRate,
    roi: nodeMetrics.roi,
    maxDrawdown: nodeMetrics.maxDrawdown,
    byMarket: nodeMetrics.byMarket,
    byLeague: nodeMetrics.byLeague,
  };
  assert.equal(nodeMetrics.status, "MEASURED", "the port labels a measured window MEASURED");
  assert.ok(projected.brier > 0, "the port's Brier should be the real (positive) score");
  const { brier: _phpBrier, ...rest } = expected;
  const { brier: _nodeBrier, ...restNode } = projected;
  assert.deepEqual(asJson(restNode), canon(rest), "metricsFor: the metric core differs from PHP (Brier aside, per F-36)");
});

// ── backtest: refusals, then one full identity replay ───────────────────────────

test("the backtester refuses exactly what PHP refuses, with the same messages", async () => {
  const untouched = new Proxy({}, { get() { throw new Error("the repository must not be touched by a param refusal"); } });
  for (const [name, entry] of Object.entries(slice5.backtestRefusals)) {
    const actual = await outcomeOfAsync(() => runBacktest({ store: untouched, params: entry.input, actorId: "parity", now: () => FIXED_MS }));
    const expected = entry.result;
    assert.equal(actual.ok, expected.ok, `backtestRefusals/${name}: expected ${expected.ok ? "a value" : "a refusal"}, got the opposite`);
    if (!expected.ok && !actual.ok) {
      // A calendar-impossible date is refused by PHP's DateTimeImmutable with a PHP-
      // specific parse message, and by the port's own pre-check with the generic
      // message the routes surface. Both refuse; the wording divergence is recorded
      // here rather than hidden: the port never constructs a Date from the raw string.
      if (/Failed to parse time string/.test(expected.error)) {
        assert.match(actual.error.message, /from\/to must be YYYY-MM-DD/, `backtestRefusals/${name}: the port must refuse an impossible date with its generic message`);
        continue;
      }
      assert.equal(actual.error.message, expected.error, `backtestRefusals/${name}: refusal message differs from PHP`);
    }
  }
});

function backtestStore(input) {
  const saved = [];
  return {
    saved,
    listSportsMatches: async () => input.matches,
    findSportsResultByMatch: async (matchId) => input.results[matchId] ?? null,
    findSportsOddsBefore: async (matchId) => input.oddsBefore[matchId] ?? null,
    ensureSportsModelVersion: async () => ({ id: input.modelId, model_name: "WINDELS Sports Baseline", model_version: "1.0.0" }),
    listSportsCalibrations: async () => [],
    saveSportsBacktest: async (row) => {
      saved.push(row);
      return null;
    },
    recordAudit: async () => {},
  };
}

test("the identity-replay backtest agrees with PHP on the whole report, F-36 aside", async () => {
  const entry = slice5.backtestRun;
  const expected = expectOk(entry.result, "backtestRun");
  // F-36 evidence: the replay's calibration Brier is PHP's truncated zero, and the
  // port's is the real score over the same rows.
  assert.ok(expected.calibration && expected.calibration.brier === 0, "backtestRun: PHP's replay Brier is no longer 0.0 — legacy fixed F-36; regenerate and revisit");
  // The random id and the wall clock were removed by the generator; the port's copy
  // is removed here before the comparison.
  const store = backtestStore(entry.input);
  const run = await runBacktest({ store, params: entry.input.params, actorId: "parity", now: () => FIXED_MS });
  const nodeReport = { ...run.report };
  assert.match(nodeReport.id, /^bt_[0-9a-f]{16}$/, "the port's backtest id has legacy's shape");
  assert.ok(nodeReport.simulation === true, "the report says it is a simulation");
  delete nodeReport.id;
  delete nodeReport.generatedAt;
  assert.equal(nodeReport.calibration.brier > 0, true, "the port's replay Brier should be the real (positive) score");
  nodeReport.calibration = { ...nodeReport.calibration, brier: 0 };
  assert.deepEqual(asJson(nodeReport), canon(expected), "backtestRun: the report differs from PHP beyond the recorded Brier divergence");

  // What each side stored: PHP encodes params/report as JSON strings, the port stores
  // structures; compare the decoded forms.
  assert.equal(store.saved.length, 1, "the port stores exactly one backtest");
  assert.equal(entry.saved.length, 1, "PHP stored exactly one backtest");
  const phpSaved = entry.saved[0];
  const nodeSaved = store.saved[0];
  assert.equal(nodeSaved.status, phpSaved.status);
  assert.equal(nodeSaved.createdBy, "parity");
  assert.deepEqual(asJson(nodeSaved.params), canon(JSON.parse(phpSaved.params)), "backtestRun: the stored params differ from PHP");
  const phpStoredReport = JSON.parse(phpSaved.report);
  delete phpStoredReport.generatedAt;
  const nodeStoredReport = { ...nodeSaved.report };
  delete nodeStoredReport.generatedAt;
  delete nodeStoredReport.id;
  nodeStoredReport.calibration = { ...nodeStoredReport.calibration, brier: 0 };
  assert.deepEqual(asJson(nodeStoredReport), canon(phpStoredReport), "backtestRun: the stored report differs from PHP");
});

// ── outcome helpers ─────────────────────────────────────────────────────────────

function outcomeOf(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function outcomeOfAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// The async envelopes keep the Error object for the assertion helpers that read
// `.message`; `assertOutcome` and `compareReturns` normalize both sides to strings.
