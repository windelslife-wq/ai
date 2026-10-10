/**
 * Versioned strategy registry with the evidence-gated lifecycle.
 *
 * Ported from `application/libraries/Aegis/Strategies/StrategyRegistry.php`.
 *
 * The lifecycle is the safety property this module exists to enforce:
 *
 *     DRAFT → BACKTESTED → VALIDATED → RISK_REVIEWED → PAPER_TRADING → APPROVED
 *
 * with `RETIRED` reachable from anywhere and terminal. Stages may not be
 * skipped, and each one demands evidence rather than intent:
 *
 *  - `BACKTESTED` requires at least one completed backtest for *that exact
 *    version* — a backtest of version 1.0.0 says nothing about 1.0.1;
 *  - `VALIDATED` re-reads the latest backtest and applies the numeric criteria
 *    (sample size, profit factor, drawdown ceiling, positive expectancy);
 *  - `RISK_REVIEWED` requires an executable implementation and a declared stop
 *    distance, because a strategy that cannot say where it is wrong cannot be
 *    risk-reviewed;
 *  - `PAPER_TRADING` and `APPROVED` both refuse `source: "ai"` strategies, and
 *    `APPROVED` additionally requires at least ten closed *paper* trades with
 *    positive expectancy and a profit factor above one.
 *
 * Nothing in this file can place an order. Advancing a stage changes a label and
 * writes an audit event; the execution supervisor (not yet ported) is the only
 * thing that could act on `APPROVED`, and it is separately gated.
 *
 * ## Deliberate divergence: gate warnings survive a successful transition
 *
 * The legacy `transition()` returns a hardcoded `'warnings' => []` on the success
 * path, so the advisories its own gates compute — "Sharpe is suspiciously high",
 * "trade count is modest", "stop distance is very wide", "paper profit factor is
 * unusually high" — are discarded exactly when they matter most: when a strategy
 * is being promoted. The API response and the Strategy Lab flash message both
 * render that field, so on the legacy side it is permanently empty for successful
 * transitions. This port accumulates warnings across every gate the transition
 * passes through and returns them. Reasons for a *rejection* are unchanged.
 *
 * ## Known governance dead-end (recorded, not fixed here)
 *
 * `riskReview` refuses `source: "ai"`, and no route in either edition can record
 * a human sign-off or change a strategy's source. An optimizer variant that is
 * adopted therefore stops permanently at `VALIDATED`: the "manual human risk
 * sign-off" the messages promise has no mechanism. Oracle case
 * `33-optimizer.php` works around this by writing `lifecycle = RISK_REVIEWED`
 * straight into the database to reach the paper gate, which confirms the path is
 * unreachable through the API. Adding a sign-off route would widen the surface
 * and weaken a control, so it is reported as a finding for the Risk Center row
 * instead of being invented here.
 */

import { numberFormat, roundTo } from "../analysis/math.js";
import { builtinStrategies } from "./builtin.js";

/**
 * The promotable stages, in order.
 *
 * `RETIRED` is deliberately absent: it is not a stage a strategy advances
 * *through*, it is an exit from the sequence, and including it here would make
 * `nextStage("APPROVED")` return `RETIRED` and turn retirement into the normal
 * next step.
 */
export const LIFECYCLE_ORDER = Object.freeze([
  "DRAFT",
  "BACKTESTED",
  "VALIDATED",
  "RISK_REVIEWED",
  "PAPER_TRADING",
  "APPROVED",
]);

/** The terminal stage, reachable from any non-terminal stage. */
export const RETIRED_STAGE = "RETIRED";

/** Every stage name the API accepts as a transition target. */
export const LIFECYCLE_STAGES = Object.freeze([...LIFECYCLE_ORDER, RETIRED_STAGE]);

/**
 * Numeric criteria for `VALIDATED`.
 *
 * These are the platform's definition of "a backtest that means something". Ten
 * trades is a low bar statistically, which is why the modest-sample warning
 * fires below twenty — the criteria gate promotion, the warnings advise the
 * human reading the result.
 */
export const VALIDATION_CRITERIA = Object.freeze({
  minTrades: 10,
  minProfitFactor: 1.0,
  maxDrawdownPct: 50.0,
  requirePositiveExpectancy: true,
});

/** Minimum closed paper trades before live approval can be considered. */
export const MIN_PAPER_TRADES_FOR_APPROVAL = 10;

/** Above this, a paper profit factor is more likely a fill-model artefact. */
export const SUSPICIOUS_PAPER_PROFIT_FACTOR = 3;

/** Above this, a Sharpe usually means unrealistic fills or over-fitting. */
export const SUSPICIOUS_SHARPE = 4;

/** Above this multiple of ATR, a stop risks more per trade than is prudent. */
export const WIDE_STOP_ATR = 4;

/**
 * The message used whenever an AI-sourced strategy is refused promotion.
 *
 * Exported because tests pin it: the wording is the operator's only explanation
 * of why a variant will not advance, and silently rewording it would make the
 * block look like a bug.
 */
export const AI_SIGNOFF_REQUIRED_PAPER =
  "AI-generated strategies require manual human risk sign-off before paper/live stages (auto-advancement blocked by design)";

/** The equivalent message on the live-approval gate. */
export const AI_SIGNOFF_REQUIRED_LIVE =
  "AI-generated strategies require manual human risk sign-off before live stages (auto-advancement blocked by design)";

/**
 * PHP `is_numeric` semantics: numbers and numeric strings qualify.
 *
 * The distinction matters because parameters arrive from JSON and from the
 * optimizer's grid, and a stop distance supplied as `"2"` must still be treated
 * as a declared stop rather than a missing one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

/**
 * The next stage after `current`, or `null` at the end of the sequence.
 *
 * `RETIRED` and any unrecognised stage yield `null`, so a retired strategy has
 * no "next stage" to be pushed into.
 *
 * @param {string} current
 * @returns {string|null}
 */
export function nextStage(current) {
  const index = LIFECYCLE_ORDER.indexOf(current);
  if (index === -1 || index >= LIFECYCLE_ORDER.length - 1) return null;
  return LIFECYCLE_ORDER[index + 1];
}

/**
 * Apply the `VALIDATED` criteria to one backtest's metrics.
 *
 * Pure: no I/O, no clock. `context` is only used to make the sample-size reason
 * self-describing (it carries the symbol the backtest ran on), so an operator
 * reading a rejection knows which run was judged.
 *
 * A `null` profit factor fails the "exceeds 1.0" test by being skipped, not by
 * being treated as zero — a run with no losing trades has no measured downside,
 * and the trade-count criterion is what catches a sample too small to trust.
 *
 * @param {Record<string, number|null>} metrics
 * @param {string} context
 * @returns {{ok: boolean, reasons: string[], warnings: string[]}}
 */
export function validateMetrics(metrics, context = "") {
  const reasons = [];
  const warnings = [];
  const source = metrics ?? {};
  const trades = Math.trunc(Number(source.trades ?? 0));

  if (trades < VALIDATION_CRITERIA.minTrades) {
    reasons.push(
      `Sample size too small: ${trades} trades < ${VALIDATION_CRITERIA.minTrades} required (${context})`,
    );
  }

  const profitFactor = source.profitFactor ?? null;
  if (profitFactor !== null && profitFactor <= VALIDATION_CRITERIA.minProfitFactor) {
    reasons.push(
      `Profit factor ${numberFormat(profitFactor, 2)} does not exceed ${VALIDATION_CRITERIA.minProfitFactor}`,
    );
  }

  const drawdown = source.maxDrawdownPct ?? 0;
  if (drawdown > VALIDATION_CRITERIA.maxDrawdownPct) {
    reasons.push(
      `Max drawdown ${numberFormat(drawdown, 1)}% exceeds the ${VALIDATION_CRITERIA.maxDrawdownPct}% validation ceiling`,
    );
  }

  const expectancy = source.expectancyPnl ?? null;
  if (expectancy !== null && expectancy <= 0 && VALIDATION_CRITERIA.requirePositiveExpectancy) {
    reasons.push(`Negative expectancy per trade (${numberFormat(expectancy, 2)})`);
  }

  if (trades >= 1 && trades < VALIDATION_CRITERIA.minTrades * 2) {
    warnings.push("Trade count is modest — results may not be statistically robust");
  }

  const sharpe = source.sharpe ?? 0;
  if (sharpe > SUSPICIOUS_SHARPE) {
    warnings.push(
      `Sharpe ${numberFormat(sharpe, 2)} is suspiciously high — inspect for over-fitting or unrealistic fills`,
    );
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Build the record shape the store persists for a newly registered strategy.
 *
 * @param {import("./builtin.js").TradingStrategy} strategy
 * @param {string} source `"builtin"` or `"ai"`
 * @param {string} at ISO timestamp
 * @returns {Record<string, unknown>}
 */
export function newStrategyRecord(strategy, source, at) {
  return {
    strategy_id: strategy.id(),
    version: strategy.version(),
    name: strategy.name(),
    description: strategy.description(),
    market_classes: strategy.marketClasses(),
    timeframes: strategy.timeframes(),
    params: strategy.params(),
    source,
    lifecycle: "DRAFT",
    created_at: at,
    updated_at: at,
    lifecycle_history: [{ from: null, to: "DRAFT", at, reason: "registered" }],
  };
}

/**
 * @typedef {object} StrategyRepo the narrow persistence interface this registry needs
 * @property {(id: string, version: string) => Promise<Record<string, unknown>|null>} find
 * @property {() => Promise<Array<Record<string, unknown>>>} all
 * @property {(record: Record<string, unknown>) => Promise<void>} save
 * @property {(strategyId: string, version: string) => Promise<number>} countBacktests
 * @property {(strategyId: string, version: string) => Promise<Record<string, unknown>|null>} latestBacktest
 */

/**
 * @typedef {object} JournalSource the narrow journal interface the approval gate needs
 * @property {(filter: Record<string, unknown>, limit: number) => Promise<Array<Record<string, unknown>>>} list
 */

/**
 * @typedef {object} AuditSink
 * @property {(action: string, summary: string, details: Record<string, unknown>, actorId?: string|null) => Promise<void>} emit
 */

/**
 * Create a registry over injected persistence.
 *
 * Dependencies are injected as narrow interfaces rather than as the store
 * itself, mirroring the legacy constructor (which takes repository interfaces).
 * That keeps every gate testable with in-memory fakes and means this file has no
 * opinion about MySQL versus the file adapter.
 *
 * Executable implementations live in an in-process map keyed `id@version`. They
 * are *not* persisted: code is not data. A strategy record can exist without an
 * implementation (a variant registered before a restart, or a record imported
 * from legacy), and `riskReview` treats that as a hard refusal rather than
 * silently substituting a default — promoting a strategy nobody can execute
 * would be worse than refusing it.
 *
 * @param {object} deps
 * @param {StrategyRepo} deps.repo
 * @param {AuditSink} [deps.audit]
 * @param {JournalSource|null} [deps.journal]
 * @param {() => number} [deps.now] epoch-millisecond clock, injectable for tests
 * @param {import("./builtin.js").TradingStrategy[]} [deps.builtins]
 * @returns {object} the registry
 */
export function createStrategyRegistry({
  repo,
  audit = null,
  journal = null,
  now = () => Date.now(),
  builtins = builtinStrategies(),
}) {
  /** @type {Map<string, import("./builtin.js").TradingStrategy>} */
  const implementations = new Map();
  const keyOf = (id, version) => `${id}@${version}`;

  function isoNow() {
    return new Date(now()).toISOString();
  }

  /**
   * Write an audit event, never letting a failure break the operation.
   *
   * A lifecycle change that succeeded but could not be logged is still a
   * successful change; throwing here would leave the store updated while
   * reporting failure to the caller, which is the worse inconsistency. The
   * analysis engine made the same call for the same reason.
   */
  async function emitAudit(action, summary, details, actorId = null) {
    if (!audit) return;
    try {
      await audit.emit(action, summary, details, actorId);
    } catch {
      // Deliberately swallowed: see the comment above.
    }
  }

  /**
   * Seed the four builtins if they are not already stored.
   *
   * Idempotent: an existing record is left exactly as it is, so a strategy
   * mid-lifecycle survives a restart at its current stage rather than being
   * reset to `DRAFT`. Implementations are registered in memory on every call,
   * since they are not persisted.
   *
   * @param {string|null} [actorId]
   */
  async function seedBuiltins(actorId = null) {
    for (const strategy of builtins) {
      implementations.set(keyOf(strategy.id(), strategy.version()), strategy);
      const existing = await repo.find(strategy.id(), strategy.version());
      if (existing) continue;
      const at = isoNow();
      const record = newStrategyRecord(strategy, "builtin", at);
      await repo.save(record);
      await emitAudit(
        "strategies.registered",
        `Strategy ${strategy.id()}@${strategy.version()} registered (builtin)`,
        { strategyId: strategy.id(), version: strategy.version(), source: "builtin" },
        actorId,
      );
    }
  }

  /**
   * The executable implementation for an exact `id@version`, or `null`.
   *
   * @param {string} id
   * @param {string} version
   * @returns {import("./builtin.js").TradingStrategy|null}
   */
  function implementation(id, version) {
    return implementations.get(keyOf(id, version)) ?? null;
  }

  /**
   * Register an executable implementation without persisting a record.
   *
   * Used after a restart to re-attach variants that were loaded from the store:
   * the record exists, but the code that implements it has to be rebuilt from
   * the stored parameters and re-registered here.
   *
   * @param {import("./builtin.js").TradingStrategy} strategy
   */
  function registerImplementation(strategy) {
    implementations.set(keyOf(strategy.id(), strategy.version()), strategy);
  }

  /**
   * Record lookup for the execution supervisor and the paper-deployment gate.
   *
   * @param {string} id
   * @param {string} version
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async function findRecordForPaper(id, version) {
    return repo.find(id, version);
  }

  /**
   * Exact-version lookup, or the most recently updated record for that id.
   *
   * The "most recent" comparison is a string compare on `updated_at`, which is
   * correct only because every timestamp this module writes is the fixed-width
   * ISO-8601 `Z` form — lexicographic order equals chronological order. Ties
   * resolve to the later record in iteration order, matching the legacy `>= 0`.
   *
   * @param {string} id
   * @param {string|null} [version]
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async function findRecord(id, version = null) {
    if (version !== null && version !== "") return repo.find(id, version);
    let best = null;
    for (const record of await repo.all()) {
      if (record.strategy_id !== id) continue;
      if (best === null || String(record.updated_at ?? "") >= String(best.updated_at ?? "")) {
        best = record;
      }
    }
    return best;
  }

  /**
   * Persist an optimized variant under a new version with `source: "ai"`.
   *
   * Refuses to overwrite: a duplicate `id@version` would mean two different
   * parameter sets claiming the same identity, and the loser would silently
   * vanish. Throwing is the honest outcome.
   *
   * @param {import("./builtin.js").TradingStrategy} strategy
   * @param {Record<string, unknown>} record
   * @param {string|null} [actorId]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function registerVariant(strategy, record, actorId = null) {
    const key = keyOf(strategy.id(), strategy.version());
    if (implementations.has(key) || (await repo.find(strategy.id(), strategy.version()))) {
      const error = new Error(`variant ${key} already exists`);
      error.code = "STRATEGY_VARIANT_EXISTS";
      error.statusCode = 409;
      throw error;
    }
    implementations.set(key, strategy);
    await repo.save(record);
    await emitAudit(
      "strategies.variant-registered",
      `Optimized variant ${key} registered (source ai, DRAFT, human sign-off required)`,
      { strategyId: strategy.id(), version: strategy.version(), params: strategy.params() },
      actorId,
    );
    return record;
  }

  /**
   * The `RISK_REVIEWED` gate.
   *
   * Two things are checked: that an executable implementation exists for this
   * exact version, and that the strategy declares a positive stop distance.
   * `mean-reversion` is exempt from the stop-parameter check because its stop is
   * expressed through the Bollinger mid band rather than an ATR multiple — an
   * exemption inherited from the legacy and preserved even though the builtin
   * does in fact declare `stopAtr`, so that a future variant of it is judged by
   * the same rule.
   *
   * @param {Record<string, unknown>} record
   * @returns {{ok: boolean, reasons: string[], warnings: string[]}}
   */
  function riskReview(record) {
    const reasons = [];
    const warnings = [];
    const impl = implementations.get(keyOf(record.strategy_id, record.version)) ?? null;

    if (record.source === "ai") reasons.push(AI_SIGNOFF_REQUIRED_PAPER);

    if (!impl) {
      reasons.push("No executable implementation registered for this version");
      return { ok: false, reasons, warnings };
    }

    const stopAtr = record.params?.stopAtr ?? null;
    if (!isNumeric(stopAtr) && record.strategy_id !== "mean-reversion") {
      reasons.push("Strategy does not define a stop-loss distance parameter — stops are mandatory");
    }
    if (isNumeric(stopAtr)) {
      const value = Number(stopAtr);
      if (value <= 0) reasons.push("Stop distance must be positive");
      else if (value > WIDE_STOP_ATR) {
        warnings.push(
          `Stop distance ${stopAtr}x ATR is very wide — expect large per-trade risk`,
        );
      }
    }

    return { ok: reasons.length === 0, reasons, warnings };
  }

  /**
   * The `PAPER_TRADING` gate.
   *
   * Deploying to a paper account *is* this stage, so the gate and the transition
   * target are the same check. Requires `RISK_REVIEWED` or better, and refuses
   * AI-sourced strategies outright.
   *
   * A `RETIRED` record yields `ok: false` here (its index is `-1`), but
   * `transition` blocks retirement earlier with a clearer message; this function
   * is also called directly by the paper-trading path, where the generic refusal
   * is the right answer.
   *
   * @param {Record<string, unknown>} record
   * @returns {{ok: boolean, reasons: string[]}}
   */
  function canDeployToPaper(record) {
    const orderIndex = LIFECYCLE_ORDER.indexOf(record.lifecycle);
    const riskIndex = LIFECYCLE_ORDER.indexOf("RISK_REVIEWED");
    if (orderIndex < riskIndex) {
      return {
        ok: false,
        reasons: [
          `Strategy lifecycle is ${record.lifecycle} — paper deployment requires RISK_REVIEWED (advance through backtesting, validation and risk review first)`,
        ],
      };
    }
    if (record.source === "ai") {
      return { ok: false, reasons: [AI_SIGNOFF_REQUIRED_PAPER] };
    }
    return { ok: true, reasons: [] };
  }

  /**
   * The `APPROVED` gate: live approval requires real paper-trading evidence.
   *
   * Evidence means closed **paper** trades attributed to this strategy — at
   * least ten, net positive, with a profit factor above one. Backtest trades are
   * explicitly excluded by the `source: "paper"` filter, which is the whole
   * point: a backtest is a simulation of the strategy against history, while
   * paper trading is a simulation of the strategy against *the platform's own
   * order handling*. Only the second one tests what approval claims.
   *
   * When no journal is wired the gate fails closed with an explicit reason
   * rather than passing for lack of evidence.
   *
   * @param {Record<string, unknown>} record
   * @returns {Promise<{ok: boolean, reasons: string[], warnings: string[], evidence?: object}>}
   */
  async function approvalReview(record) {
    const reasons = [];
    const warnings = [];
    const id = record.strategy_id;

    if (
      LIFECYCLE_ORDER.indexOf(record.lifecycle) < LIFECYCLE_ORDER.indexOf("PAPER_TRADING")
    ) {
      reasons.push(
        `Strategy lifecycle is ${record.lifecycle} — live approval requires the PAPER_TRADING stage first`,
      );
    }
    if (record.source === "ai") reasons.push(AI_SIGNOFF_REQUIRED_LIVE);

    if (journal === null) {
      reasons.push("Paper-trading evidence is unavailable (journal not wired)");
      return { ok: false, reasons, warnings };
    }

    const listed = await journal.list({ source: "paper", strategy: id }, 200);
    const trades = listed.filter((trade) => (trade.strategy ?? null) === id);
    const count = trades.length;
    if (count < MIN_PAPER_TRADES_FOR_APPROVAL) {
      reasons.push(
        `Paper-trading evidence too thin: ${count} closed paper trades — at least ${MIN_PAPER_TRADES_FOR_APPROVAL} required`,
      );
    }

    let grossWin = 0;
    let grossLoss = 0;
    let net = 0;
    for (const trade of trades) {
      const pnl = Number(trade.pnl ?? 0);
      net += pnl;
      if (pnl > 0) grossWin += pnl;
      else grossLoss += -pnl;
    }
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

    if (count >= MIN_PAPER_TRADES_FOR_APPROVAL) {
      if (profitFactor !== null && profitFactor <= 1.0) {
        reasons.push(`Paper profit factor ${profitFactor.toFixed(2)} does not exceed 1.0`);
      }
      if (net <= 0) {
        reasons.push(
          `Paper expectancy is negative (${net.toFixed(2)} net over ${count} trades)`,
        );
      }
      if (profitFactor !== null && profitFactor > SUSPICIOUS_PAPER_PROFIT_FACTOR) {
        warnings.push(
          `Paper profit factor ${profitFactor.toFixed(2)} is unusually high — verify fills are realistic`,
        );
      }
    }

    return {
      ok: reasons.length === 0,
      reasons,
      warnings,
      evidence: {
        paperTrades: count,
        profitFactor: profitFactor !== null ? roundTo(profitFactor, 3) : null,
        netPnl: roundTo(net, 2),
      },
    };
  }

  /**
   * Persist a stage change, append to the history and audit it.
   *
   * The history entry is appended rather than replaced: the audit value of a
   * lifecycle is the sequence, and a strategy that was retired and re-registered
   * should show both.
   *
   * @param {Record<string, unknown>} record
   * @param {string} to
   * @param {string} reason
   * @param {string|null} actorId
   * @returns {Promise<Record<string, unknown>>} the updated record
   */
  async function apply(record, to, reason, actorId = null) {
    const from = record.lifecycle;
    const at = isoNow();
    const updated = {
      ...record,
      lifecycle: to,
      updated_at: at,
      lifecycle_history: [
        ...(Array.isArray(record.lifecycle_history) ? record.lifecycle_history : []),
        { from, to, at, reason },
      ],
    };
    await repo.save(updated);
    await emitAudit(
      "strategies.status-changed",
      `Strategy ${updated.strategy_id}@${updated.version}: ${from} -> ${to}`,
      {
        strategyId: updated.strategy_id,
        version: updated.version,
        from,
        to,
        reason,
      },
      actorId,
    );
    return updated;
  }

  /**
   * Attempt a lifecycle transition, running the target stage's gate first.
   *
   * Returns a result object rather than throwing: a rejected transition is an
   * expected outcome that the caller must render with its reasons, not an
   * exceptional one. The HTTP layer maps `ok: false` to 409.
   *
   * Warnings from every gate the transition passes through are accumulated and
   * returned — see the divergence note at the top of this file.
   *
   * @param {string} strategyId
   * @param {string} version
   * @param {string} to a member of `LIFECYCLE_STAGES`
   * @param {string|null} [reason]
   * @param {string|null} [actorId]
   * @returns {Promise<{ok: boolean, reasons: string[], warnings: string[], strategy?: object, evidence?: object}>}
   */
  async function transition(strategyId, version, to, reason = null, actorId = null) {
    const record = await repo.find(strategyId, version);
    if (!record) {
      return {
        ok: false,
        reasons: [`Strategy ${strategyId}@${version} not found`],
        warnings: [],
      };
    }
    if (record.lifecycle === RETIRED_STAGE) {
      return {
        ok: false,
        reasons: ["Strategy is RETIRED — lifecycle is terminal"],
        warnings: [],
      };
    }

    const from = record.lifecycle;

    // Retirement is always available and skips the stage-ordering rule: a
    // strategy can be withdrawn at any point without first being promoted.
    if (to === RETIRED_STAGE) {
      const updated = await apply(record, RETIRED_STAGE, reason ?? "retired by user", actorId);
      return { ok: true, reasons: [], warnings: [], strategy: updated };
    }

    const expected = nextStage(from);
    if (to !== expected) {
      return {
        ok: false,
        reasons: [
          `Invalid transition ${from} -> ${to}. Expected next stage: ${expected ?? "(terminal)"} (stages may not be skipped)`,
        ],
        warnings: [],
      };
    }

    const warnings = [];

    if (to === "BACKTESTED") {
      const count = await repo.countBacktests(strategyId, version);
      if (count === 0) {
        return {
          ok: false,
          reasons: [
            "No completed backtest for this strategy version — run a backtest first",
          ],
          warnings: [],
        };
      }
    }

    if (to === "VALIDATED") {
      const latest = await repo.latestBacktest(strategyId, version);
      if (!latest) {
        return { ok: false, reasons: ["No backtest results available"], warnings: [] };
      }
      const report = validateMetrics(latest.metrics ?? {}, latest.request?.symbol ?? "");
      if (!report.ok) return { ...report, strategy: record };
      warnings.push(...report.warnings);
    }

    if (to === "RISK_REVIEWED") {
      const report = riskReview(record);
      if (!report.ok) return { ...report, strategy: record };
      warnings.push(...report.warnings);
    }

    if (to === "PAPER_TRADING") {
      const gate = canDeployToPaper(record);
      if (!gate.ok) {
        return { ok: false, reasons: gate.reasons, warnings: [], strategy: record };
      }
    }

    let evidence = null;
    if (to === "APPROVED") {
      const report = await approvalReview(record);
      if (!report.ok) {
        return {
          ok: false,
          reasons: report.reasons,
          warnings: report.warnings,
          strategy: record,
          evidence: report.evidence,
        };
      }
      warnings.push(...report.warnings);
      evidence = report.evidence ?? null;
    }

    const updated = await apply(
      record,
      to,
      reason ?? `gate checks passed (${from} -> ${to})`,
      actorId,
    );
    return {
      ok: true,
      reasons: [],
      warnings,
      strategy: updated,
      ...(evidence !== null ? { evidence } : {}),
    };
  }

  return Object.freeze({
    seedBuiltins,
    implementation,
    registerImplementation,
    findRecord,
    findRecordForPaper,
    registerVariant,
    riskReview,
    canDeployToPaper,
    approvalReview,
    transition,
    /** Exposed for diagnostics: how many implementations are live in memory. */
    implementationCount: () => implementations.size,
  });
}
