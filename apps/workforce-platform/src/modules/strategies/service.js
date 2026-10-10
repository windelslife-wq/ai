/**
 * Strategy Lab service: the seam between the HTTP layer and the engine.
 *
 * It owns the orchestration the legacy split across three places —
 * `Api_strategies` (validation and status codes), `Platform::runBacktest` /
 * `Platform::optimizeStrategy` (resolving a strategy to an executable
 * implementation, fetching candles, registering adopted variants) and
 * `Backtester::run` (the run itself plus its two audit events) — so a route only
 * has to translate a validated body into a call and an error into a status.
 *
 * It also owns the adapter that lets the registry keep its narrow legacy-shaped
 * interface. `createStrategyRegistry` asks for `repo.find/all/save/
 * countBacktests/latestBacktest` and `journal.list`, which is the
 * `StrategyRepository` / `JournalRepository` pair from
 * `libraries/Aegis/Persistence/Repositories.php`. The Node store contract is flat
 * (`findStrategy`, `listStrategies`, `countStrategyBacktests`, …), so the mapping
 * lives here rather than forcing the registry to learn a second vocabulary or
 * forcing the contract to nest.
 *
 * ## Persistence is required, not optional
 *
 * The analysis service can compute a run with no store and simply not record it.
 * The Strategy Lab cannot: a backtest is only meaningful against a *registered
 * strategy version*, because the whole point is that the evidence cites the exact
 * code that produced it. With no adapter every method here reports 503 rather
 * than pretending there are no strategies.
 */

import { randomUUID } from "node:crypto";

import { AppError } from "../../http/errors.js";
import { isProviderFailure, marketDataFailure } from "../market-data/errors.js";
// Legacy `Platform::optimizeStrategy` infers the market class with
// `PaperTradingEngine::inferMarketClass`, which knows the seven USD pairs and
// treats XAUUSD as a commodity. The analysis module already ports that mapping
// faithfully; `market-data/timeframes.js` has a DIFFERENT, narrower one that would
// label gold as forex and fetch the wrong series. Importing the faithful port is
// what keeps `XAUUSD` a commodity here.
import { inferMarketClass } from "../analysis/contracts.js";
import {
  BACKTEST_DEFAULTS,
  MIN_BACKTEST_CANDLES,
  InsufficientHistoryError,
  buildBacktestRecord,
  filterCandlesByRange,
  isoUtc,
  journalEntriesFromBacktest,
  resolveBacktestRequest,
  simulate,
} from "./backtester.js";
import { builtinStrategyFactory, createVersionedStrategy } from "./builtin.js";
import {
  DEFAULT_OPTIMIZE_SYMBOL,
  OPTIMIZE_CANDLE_DEFAULT,
  OPTIMIZE_CANDLE_MAX,
  OPTIMIZE_CANDLE_MIN,
  messages,
} from "./contracts.js";
import { optimize } from "./optimizer.js";
import { createStrategyRegistry, newStrategyRecord, nextStage } from "./registry.js";

export function createStrategiesService({
  store = null,
  marketData = null,
  log = null,
  now = () => Date.now(),
  registry = null,
} = {}) {
  function requireStore() {
    if (!store) throw AppError.unavailable(messages.STORE_UNAVAILABLE, { code: "STRATEGIES_STORE_UNAVAILABLE", retryAfter: 30 });
  }

  function requireMarketData() {
    if (!marketData) throw AppError.unavailable(messages.MARKET_DATA_UNAVAILABLE, { code: "STRATEGIES_MARKET_DATA_UNAVAILABLE", retryAfter: 30 });
  }

  /**
   * Audit writes never fail the operation they describe.
   *
   * A backtest that completed but could not be logged still completed, and
   * throwing here would leave the run persisted while reporting failure to the
   * caller — the worse inconsistency. Same call the analysis engine made.
   */
  async function audit(event, actorId = null) {
    if (!store) return;
    try {
      await store.recordAudit({ actorId, ...event });
    } catch (error) {
      if (log) log.warn({ err: error }, "strategy audit write failed");
    }
  }

  /**
   * The registry, wired to the flat store contract.
   *
   * Built lazily and cached so repeated calls do not re-create the closures, and
   * null when there is no store — the registry tolerates that for its pure gate
   * functions, and every method that would need it calls `requireStore` first.
   */
  let cachedRegistry = registry;
  function strategies() {
    if (cachedRegistry) return cachedRegistry;
    if (!store) return null;
    cachedRegistry = createStrategyRegistry({
      repo: {
        find: (id, version) => store.findStrategy(id, version),
        all: () => store.listStrategies(),
        save: (record) => store.saveStrategy(record),
        countBacktests: (id, version) => store.countStrategyBacktests(id, version),
        latestBacktest: (id, version) => store.latestStrategyBacktest(id, version),
      },
      journal: {
        // The registry passes the limit positionally, as the legacy
        // JournalRepository did; the store contract takes it in the filter object.
        list: (filter = {}, limit = 200) => store.listJournalEntries({ ...filter, limit }),
      },
      audit: {
        // `recordAudit` has no summary column, so the human-readable line the
        // registry composes travels inside `details` and stays searchable there.
        emit: (action, summary, details = {}, actorId = null) =>
          audit(
            {
              action,
              entityType: "strategy",
              entityId: details?.strategyId ?? null,
              details: { ...details, summary },
            },
            actorId,
          ),
      },
      now,
    });
    return cachedRegistry;
  }

  /**
   * Register the four builtin strategies.
   *
   * Idempotent by design — `seedBuiltins` skips any (id, version) already stored
   * and emits no audit event for it — so it is safe to call on every boot, and a
   * strategy an operator has already promoted keeps its stage across a restart.
   */
  async function seed() {
    if (!store) return { seeded: 0, reason: "no persistence adapter configured" };
    return strategies().seedBuiltins();
  }

  // ---- reads ---------------------------------------------------------------

  /**
   * Strategies grouped by id, newest version last.
   *
   * Mirrors `Api_strategies::index`. The grouping depends on `listStrategies`
   * ordering `strategy_id ASC, updated_at ASC`: that makes each id's rows
   * contiguous and puts the most recently updated version last, which is what
   * "latest" means here. `supportsShorts` comes from the executable
   * implementation, not the record, because it is a property of code — a record
   * imported from legacy has no implementation until it is re-registered, and
   * reporting `false` for it is honest where guessing would not be.
   */
  async function list() {
    requireStore();
    const registry = strategies();
    const grouped = new Map();
    for (const record of await store.listStrategies()) {
      const versions = grouped.get(record.strategy_id) ?? [];
      versions.push(record);
      grouped.set(record.strategy_id, versions);
    }
    const out = [];
    for (const [strategyId, versions] of grouped) {
      const latest = versions[versions.length - 1];
      const impl = registry.implementation(strategyId, latest.version);
      out.push({
        strategyId,
        latest: { ...latest, supportsShorts: impl ? impl.supportsShorts() : false },
        versions: versions.map((record) => ({
          version: record.version,
          lifecycle: record.lifecycle,
          updatedAt: record.updated_at,
        })),
      });
    }
    return { strategies: out };
  }

  /**
   * One strategy, plus the two derived fields the legacy `show` appended.
   *
   * `findRecord` resolves an exact version, or the most recently updated one when
   * the version is empty — which is the legacy fallback loop, and the reason an
   * empty `?version=` means "latest" rather than "none".
   */
  async function show(strategyId, version = "") {
    requireStore();
    const registry = strategies();
    const record = await registry.findRecord(strategyId, version);
    if (!record) return null;
    const impl = registry.implementation(record.strategy_id, record.version);
    return {
      ...record,
      supportsShorts: impl ? impl.supportsShorts() : false,
      nextStage: nextStage(record.lifecycle),
    };
  }

  /** Backtest summaries, newest first. No payloads — see `listBacktests`. */
  async function results({ strategyId = "", limit = 30 } = {}) {
    requireStore();
    const rows = await store.listBacktests({
      strategyId: strategyId || null,
      limit: Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100),
    });
    // Field names follow the legacy response (`createdAt`, not `created_at`) so an
    // existing client keeps working; the values come from the denormalised columns.
    return {
      results: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        strategyId: row.strategy_id,
        strategyVersion: row.strategy_version,
        symbol: row.symbol,
        timeframe: row.timeframe,
        synthetic: row.synthetic,
        candles: row.candles,
        metrics: row.metrics,
        warnings: row.warnings,
      })),
    };
  }

  /** The whole stored run, or null. Only this route reads the payload. */
  async function result(backtestId) {
    requireStore();
    return store.findBacktest(String(backtestId));
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Advance or retire a strategy.
   *
   * A rejection is a 409 with `reasons` and `warnings`, exactly as the legacy
   * `status()` answered: the request was understood and the state forbids it,
   * which is a conflict rather than a validation error. Warnings travel with a
   * rejection too, so an operator sees the advisories the gates computed even
   * when one of them blocked (divergence DV-3 in PHASE6_STRATEGIES.md).
   */
  async function transition(strategyId, { to, reason = null, version = "" } = {}, { actorId = null } = {}) {
    requireStore();
    const registry = strategies();
    const resolved = version || (await registry.findRecord(strategyId, ""))?.version || "";
    const result = await registry.transition(strategyId, resolved, to, reason, actorId);
    if (!result.ok) {
      throw new AppError(409, "STRATEGY_TRANSITION_REJECTED", messages.TRANSITION_REJECTED, {
        details: { strategyId, version: resolved, to, reasons: result.reasons, warnings: result.warnings },
      });
    }
    return { ok: true, strategy: result.strategy, warnings: result.warnings, evidence: result.evidence ?? null };
  }

  // ---- backtesting ---------------------------------------------------------

  /**
   * Run a backtest and persist it as evidence.
   *
   * Order matters and follows the legacy: resolve the RECORD first (404 — the
   * strategy does not exist), then the IMPLEMENTATION (400 — it exists but nothing
   * executable is registered for that version), then validate the numbers, then
   * fetch candles. Resolving the record first is what lets an omitted
   * `strategyVersion` mean "the latest", and it means a caller who names a version
   * that was never registered gets a 404 rather than a confusing 400.
   */
  async function runBacktest(body, { actorId = null } = {}) {
    requireStore();
    requireMarketData();
    const registry = strategies();

    const record = await registry.findRecord(body.strategyId, body.strategyVersion ?? "");
    if (!record) throw AppError.notFound(messages.STRATEGY_NOT_FOUND(body.strategyId), { code: "STRATEGY_NOT_FOUND" });

    const strategyVersion = record.version;
    const impl = registry.implementation(record.strategy_id, strategyVersion);
    if (!impl) {
      throw AppError.badRequest(`Strategy ${record.strategy_id}@${strategyVersion} is not registered`, {
        code: "STRATEGY_NOT_EXECUTABLE",
      });
    }

    const req = resolveBacktestRequest({ ...body, strategyId: record.strategy_id, strategyVersion });
    const startedAt = isoUtc(now());
    await audit({
      action: "strategies.backtest.started",
      entityType: "strategy",
      entityId: record.strategy_id,
      details: { strategyId: record.strategy_id, strategyVersion, symbol: req.symbol, timeframe: req.timeframe },
    }, actorId);

    const series = await marketData.candles({
      symbol: req.symbol,
      timeframe: req.timeframe,
      marketClass: req.marketClass,
      limit: req.limit,
    });
    const candles = filterCandlesByRange(series.candles, { from: body.from, to: body.to });
    if (candles.length < MIN_BACKTEST_CANDLES) {
      throw new InsufficientHistoryError(
        `Only ${candles.length} candles in range — need at least ${MIN_BACKTEST_CANDLES} for a meaningful backtest`,
      );
    }

    const result = simulate(impl, candles, req, {
      symbol: req.symbol,
      timeframe: req.timeframe,
      marketClass: req.marketClass,
    });
    const stamp = { id: randomUUID(), createdAt: isoUtc(now()) };
    const stored = buildBacktestRecord({ req, result, provenance: series.provenance, candles, stamp });
    // `startedAt` is recorded on the payload so a run that took a long time can be
    // distinguished from one that was queued, without a second table.
    stored.startedAt = startedAt;

    await store.saveBacktest(stored);
    for (const entry of journalEntriesFromBacktest(stored, req)) await store.saveJournalEntry(entry);

    await audit({
      action: "strategies.backtest.completed",
      entityType: "strategy",
      entityId: record.strategy_id,
      details: {
        backtestId: stored.id,
        strategyId: record.strategy_id,
        strategyVersion,
        symbol: req.symbol,
        timeframe: req.timeframe,
        trades: stored.metrics.trades,
        totalReturnPct: stored.metrics.totalReturnPct,
        synthetic: stored.dataProvenance.synthetic,
      },
    }, actorId);

    return stored;
  }

  // ---- optimization --------------------------------------------------------

  /**
   * Legacy `Platform::nextVariantVersion`.
   *
   * Scans every stored version of one strategy, keeps the highest three-part
   * numeric version and bumps its patch component. Versions that are not exactly
   * three integer parts are skipped rather than parsed loosely, so a hand-made
   * `1.0` or `v2` row cannot become the base for a new variant. Starting from
   * [0,0,0] means a strategy whose versions are all unparseable yields `0.0.1`
   * rather than colliding with an existing one.
   */
  async function nextVariantVersion(strategyId) {
    let max = [0, 0, 0];
    for (const record of await store.listStrategies()) {
      if (record.strategy_id !== strategyId) continue;
      const parts = String(record.version).split(".").map((part) => Number.parseInt(part, 10));
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) continue;
      if (
        parts[0] > max[0]
        || (parts[0] === max[0] && (parts[1] > max[1] || (parts[1] === max[1] && parts[2] > max[2])))
      ) {
        max = parts;
      }
    }
    return `${max[0]}.${max[1]}.${max[2] + 1}`;
  }

  /**
   * Walk-forward parameter search, optionally registering the winner.
   *
   * Mirrors `Platform::optimizeStrategy` including its three refusals, all of
   * which are 400s because each names something the caller can fix: the strategy
   * is not a builtin (only builtins declare a searchable grid), it is not
   * registered, or nothing executable is registered for the resolved version.
   *
   * The candle floor is 420 rather than the backtester's 120 because the
   * optimizer splits 70/30 and refuses to rank a segment under 120 bars; 420 is
   * the smallest history that yields two usable segments.
   */
  async function optimizeStrategy(body, { actorId = null } = {}) {
    requireStore();
    requireMarketData();
    const registry = strategies();

    const strategyId = String(body.strategyId ?? "");
    const factory = builtinStrategyFactory(strategyId);
    if (!factory) throw AppError.badRequest(messages.OPTIMIZE_BUILTIN_ONLY, { code: "STRATEGY_NOT_OPTIMIZABLE" });

    const record = await registry.findRecord(strategyId, body.strategyVersion ?? "");
    if (!record) throw AppError.badRequest(`strategy ${strategyId} is not registered`, { code: "STRATEGY_NOT_FOUND" });

    const impl = registry.implementation(record.strategy_id, record.version);
    if (!impl) {
      throw AppError.badRequest(`strategy ${record.strategy_id}@${record.version} has no executable implementation`, {
        code: "STRATEGY_NOT_EXECUTABLE",
      });
    }

    const symbol = String(body.symbol ?? DEFAULT_OPTIMIZE_SYMBOL).trim().toUpperCase();
    const marketClass = body.marketClass ?? inferMarketClass(symbol);
    const timeframe = body.timeframe ?? "1h";
    const requested = Number.parseInt(body.limit, 10);
    const limit = Math.max(
      OPTIMIZE_CANDLE_MIN,
      Math.min(OPTIMIZE_CANDLE_MAX, Number.isFinite(requested) ? requested : OPTIMIZE_CANDLE_DEFAULT),
    );

    const series = await marketData.candles({ symbol, timeframe, marketClass, limit });

    // Only the keys the backtester actually understands are forwarded, which is
    // what the legacy `array_intersect_key($input, Backtester::DEFAULTS)` did. It
    // stops a caller from smuggling an unvalidated knob into every segment.
    const requestOverrides = {};
    for (const key of Object.keys(BACKTEST_DEFAULTS)) {
      if (body[key] !== undefined && body[key] !== null) requestOverrides[key] = body[key];
    }

    const report = optimize({
      make: factory,
      baselineParams: impl.params(),
      grid: impl.paramGrid(),
      candles: series.candles,
      requestOverrides,
      stamp: { ranAt: isoUtc(now()) },
    });
    report.request = {
      strategyId: record.strategy_id,
      strategyVersion: record.version,
      symbol,
      marketClass,
      timeframe,
      limit,
    };
    report.dataProvenance = series.provenance;

    if (body.register && report.recommendation.adopt) {
      const params = report.recommendation.params;
      const version = await nextVariantVersion(record.strategy_id);
      const at = isoUtc(now());
      const inner = factory(params);
      const variant = createVersionedStrategy(inner, version, params);
      await registry.registerVariant(
        variant,
        {
          ...newStrategyRecord(variant, "ai", at),
          params,
          lifecycle_history: [
            {
              from: null,
              to: "DRAFT",
              at,
              reason: `optimizer variant from @${record.version}; walk-forward verified (OOS PF passed)`,
            },
          ],
        },
        actorId,
      );
      report.registeredVariant = {
        strategyId: record.strategy_id,
        version,
        lifecycle: "DRAFT",
        note: "source ai — the full lifecycle plus human sign-off apply before paper/live",
      };
    }

    await audit({
      action: "strategies.optimize.completed",
      entityType: "strategy",
      entityId: record.strategy_id,
      details: {
        strategyId: record.strategy_id,
        strategyVersion: record.version,
        symbol,
        timeframe,
        combinations: report.searchSpace.combinationsEvaluated,
        adopt: report.recommendation.adopt,
        registeredVariant: report.registeredVariant?.version ?? null,
        synthetic: Boolean(series.provenance?.synthetic),
      },
    }, actorId);

    return report;
  }

  /**
   * Map a non-AppError failure from a run or an optimization onto an HTTP error.
   *
   * The engine's own error classes carry a `statusCode` (400 for a bad request,
   * 400 for insufficient history), and those are honoured. A provider outage is
   * mapped by the shared market-data helper so a backtest reports an outage
   * identically to a candle request. Anything else is a 500: the legacy caught
   * `Throwable` and answered 422 for a backtest and 409 for an optimization, but
   * those statuses describe the caller's request, and an unexpected fault in our
   * own code is neither — reporting it as one would send a client looking for a
   * mistake in its input.
   */
  function toHttpError(error) {
    if (error instanceof AppError) return error;
    // The engine's own error classes declare their status: `BacktestRequestError`
    // and `InsufficientHistoryError` are both 400, `OptimizationInputError` is 400.
    // Honouring the declared status keeps one definition of each failure.
    if (Number.isFinite(error?.statusCode)) {
      return new AppError(error.statusCode, error.code ?? "BACKTEST_FAILED", String(error.message ?? error));
    }
    // `isProviderFailure` is the shared predicate for "this came from the provider
    // chain, not from us", so an outage is reported here exactly as it is on
    // GET /market-data/candles and on an analysis run.
    if (isProviderFailure(error)) return marketDataFailure(error);
    // Anything else is our fault, and `null` tells the route to let the router
    // answer 500. Classifying a bug in this module as a market-data outage would
    // send an operator to check providers that are fine.
    return null;
  }

  return {
    seed,
    list,
    show,
    results,
    result,
    transition,
    runBacktest,
    optimizeStrategy,
    nextVariantVersion,
    toHttpError,
    registry: strategies(),
  };
}
