/**
 * Strategy Lab SQL for the MySQL/MariaDB adapter (Phase 6).
 *
 * Same rules as `analysis-repository.js` and `account-repository.js`: every value
 * is bound, LIMIT is coerced to a bounded integer before interpolation because
 * mysql2 does not bind it reliably in a `LIMIT` clause, and DECIMAL columns are
 * converted at this boundary because the pool runs with `decimalNumbers: false`
 * and would otherwise hand callers the string `"2.500000"`.
 *
 * Three tables, three legacy repositories collapsed into one adapter object:
 *   wf_strategies       (strategy_id, version)  — the lifecycle record
 *   wf_backtests        id                      — the evidence a gate reads
 *   wf_journal_entries  id                      — per-trade rows
 *
 * Writes are upserts. The legacy `StrategyRepository::save` did a `SELECT` and
 * then an `INSERT` or `UPDATE`; `ON DUPLICATE KEY UPDATE` is the same semantics
 * in one round trip and without the read/write race two workers could hit. This
 * matters more here than for analysis runs, because `wf_strategies` has a
 * COMPOSITE primary key and the seeding path writes four rows on every boot.
 *
 * `listBacktests` returns summary rows and `findBacktest` returns the decoded
 * payload. That split is deliberate: `payload` is a LONGTEXT copy of the whole
 * run (every trade, the equity curve), so a listing that fetched it would read
 * megabytes to render a table of ten rows. The headline numbers a listing does
 * show — `metrics`, `warnings`, `candles` — are promoted to their own columns,
 * which is what makes the split possible without losing route parity.
 */

/** Clamp a caller-supplied LIMIT before it is interpolated into SQL. */
function boundedLimit(value, fallback = 20, ceiling = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

/**
 * Decode a JSON column, distinguishing "absent" from "corrupt".
 *
 * A NULL or empty column is a row written before the column existed, or a
 * strategy with no params, and decodes to the supplied fallback. A column that
 * holds text which will not parse is a damaged row, and reporting it as an empty
 * object would let a lifecycle gate read `{}` as "no criteria declared" and pass
 * a strategy it should refuse. That is a 500, not a default.
 */
function decodeJson(raw, fallback, context) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`${context} has an unreadable JSON column`);
    error.statusCode = 500;
    throw error;
  }
}

/** Decode a `wf_strategies` row into the record shape the registry consumes. */
function strategyRow(row) {
  return {
    strategy_id: row.strategy_id,
    version: row.version,
    name: row.name,
    description: row.description ?? "",
    market_classes: decodeJson(row.market_classes, [], `Strategy ${row.strategy_id}@${row.version}`),
    timeframes: decodeJson(row.timeframes, [], `Strategy ${row.strategy_id}@${row.version}`),
    params: decodeJson(row.params, {}, `Strategy ${row.strategy_id}@${row.version}`),
    source: row.source,
    lifecycle: row.lifecycle,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lifecycle_history: decodeJson(row.lifecycle_history, [], `Strategy ${row.strategy_id}@${row.version}`),
  };
}

/**
 * Summary projection for a listing: the denormalised columns, never the payload.
 *
 * `metrics`, `warnings` and `candles` are here because the results listing shows
 * them for every row, and the legacy listing decoded each payload to get them.
 * `trades` and `equityCurve` are deliberately absent: they are the large parts of
 * a run, and only the detail route needs them. That split is what lets thirty rows
 * be listed with an indexed column read instead of thirty LONGTEXT fetches.
 */
function backtestSummary(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    strategy_id: row.strategy_id,
    strategy_version: row.strategy_version,
    symbol: row.symbol,
    timeframe: row.timeframe,
    synthetic: Boolean(Number(row.synthetic)),
    candles: Number(row.candles ?? 0),
    metrics: decodeJson(row.metrics, {}, `Backtest ${row.id}`),
    warnings: decodeJson(row.warnings, [], `Backtest ${row.id}`),
  };
}

/**
 * The DECIMAL columns of `wf_journal_entries`, converted to numbers.
 *
 * Every one of these is compared or summed by the approval gate, and the driver
 * returns them as strings. `"0.00" <= 1.0` is true only by JavaScript's string
 * coercion, and `"-3.00" > 0` is a lexicographic comparison that happens to give
 * the right answer for the wrong reason — so the conversion is done once, here,
 * rather than left to each caller to remember.
 */
const JOURNAL_NUMERIC_COLUMNS = Object.freeze([
  "entry_price",
  "exit_price",
  "position_size",
  "stop_loss",
  "take_profit",
  "fees",
  "slippage",
  "pnl",
  "pnl_pct",
  "r_multiple",
  "ai_confidence",
  "risk_score",
]);

function journalRow(row) {
  const entry = { ...row };
  for (const column of JOURNAL_NUMERIC_COLUMNS) {
    entry[column] = row[column] === null || row[column] === undefined ? null : Number(row[column]);
  }
  return entry;
}

export function createStrategyRepository(pool) {
  return {
    // ---- strategies -----------------------------------------------------

    async saveStrategy(record) {
      await pool.execute(
        `INSERT INTO wf_strategies
           (strategy_id, version, name, description, market_classes, timeframes, params,
            source, lifecycle, created_at, updated_at, lifecycle_history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           description = VALUES(description),
           market_classes = VALUES(market_classes),
           timeframes = VALUES(timeframes),
           params = VALUES(params),
           source = VALUES(source),
           lifecycle = VALUES(lifecycle),
           updated_at = VALUES(updated_at),
           lifecycle_history = VALUES(lifecycle_history)`,
        [
          String(record.strategy_id),
          String(record.version),
          String(record.name ?? ""),
          record.description === null || record.description === undefined ? null : String(record.description),
          JSON.stringify(record.market_classes ?? []),
          JSON.stringify(record.timeframes ?? []),
          JSON.stringify(record.params ?? {}),
          String(record.source ?? "builtin"),
          String(record.lifecycle ?? "DRAFT"),
          String(record.created_at),
          String(record.updated_at),
          JSON.stringify(record.lifecycle_history ?? []),
        ],
      );
      // `created_at` is deliberately absent from the UPDATE list: it records when
      // the version first existed, and rewriting it on every save would make a
      // strategy look newly registered after a stage change.
      return { strategy_id: String(record.strategy_id), version: String(record.version) };
    },

    async findStrategy(strategyId, version) {
      const [rows] = await pool.execute(
        `SELECT strategy_id, version, name, description, market_classes, timeframes, params,
                source, lifecycle, created_at, updated_at, lifecycle_history
           FROM wf_strategies
          WHERE strategy_id = ? AND version = ?
          LIMIT 1`,
        [String(strategyId), String(version)],
      );
      return rows.length ? strategyRow(rows[0]) : null;
    },

    /**
     * Every strategy, ordered `strategy_id ASC, updated_at ASC`.
     *
     * That ordering is the legacy `all()` ordering and it is load-bearing for two
     * callers: the strategy index groups rows by id and expects them contiguous,
     * and "latest version" picks the last row of a group — so within one strategy
     * the most recently updated version must come last. Both depend on `updated_at`
     * sorting chronologically as text, which is why migration 006 pins one format.
     */
    async listStrategies() {
      const [rows] = await pool.query(
        `SELECT strategy_id, version, name, description, market_classes, timeframes, params,
                source, lifecycle, created_at, updated_at, lifecycle_history
           FROM wf_strategies
          ORDER BY strategy_id ASC, updated_at ASC`,
      );
      return rows.map(strategyRow);
    },

    // ---- backtests ------------------------------------------------------

    async saveBacktest(record) {
      await pool.execute(
        `INSERT INTO wf_backtests
           (id, created_at, strategy_id, strategy_version, symbol, timeframe, synthetic,
            candles, metrics, warnings, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           created_at = VALUES(created_at),
           strategy_id = VALUES(strategy_id),
           strategy_version = VALUES(strategy_version),
           symbol = VALUES(symbol),
           timeframe = VALUES(timeframe),
           synthetic = VALUES(synthetic),
           candles = VALUES(candles),
           metrics = VALUES(metrics),
           warnings = VALUES(warnings),
           payload = VALUES(payload)`,
        [
          String(record.id),
          String(record.created_at),
          String(record.request?.strategyId ?? ""),
          String(record.request?.strategyVersion ?? ""),
          String(record.request?.symbol ?? ""),
          String(record.request?.timeframe ?? ""),
          Boolean(record.dataProvenance?.synthetic) ? 1 : 0,
          Number(record.dataProvenance?.candles ?? 0),
          JSON.stringify(record.metrics ?? {}),
          JSON.stringify(record.warnings ?? []),
          JSON.stringify(record),
        ],
      );
      return { id: String(record.id), created_at: String(record.created_at) };
    },

    async findBacktest(id) {
      const [rows] = await pool.execute("SELECT payload FROM wf_backtests WHERE id = ? LIMIT 1", [String(id)]);
      if (!rows.length) return null;
      // A payload that will not parse is a corrupt row, not a missing backtest:
      // a 404 here would tell an operator the evidence for a promoted strategy
      // never existed.
      return decodeJson(rows[0].payload, null, `Backtest ${id}`);
    },

    /**
     * Newest first, optionally narrowed to one strategy id (all of its versions).
     *
     * The filter is built from bound parameters only — the column names are fixed
     * literals and no caller-supplied string is ever interpolated.
     */
    async listBacktests({ strategyId = null, limit = 20 } = {}) {
      const bounded = boundedLimit(limit);
      const clauses = [];
      const params = [];
      if (strategyId !== null && strategyId !== undefined && strategyId !== "") {
        clauses.push("strategy_id = ?");
        params.push(String(strategyId));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await pool.query(
        `SELECT id, created_at, strategy_id, strategy_version, symbol, timeframe, synthetic,
                candles, metrics, warnings
           FROM wf_backtests
           ${where}
          ORDER BY created_at DESC, id ASC
          LIMIT ${bounded}`,
        params,
      );
      return rows.map(backtestSummary);
    },

    // ---- the two queries the lifecycle gates need -----------------------

    async countStrategyBacktests(strategyId, version) {
      const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS total
           FROM wf_backtests
          WHERE strategy_id = ? AND strategy_version = ?`,
        [String(strategyId), String(version)],
      );
      return Number(row?.total ?? 0);
    },

    /**
     * The most recent backtest for one exact version, payload decoded.
     *
     * The VALIDATED gate reads `.metrics` from this, so unlike `listBacktests` it
     * must return the payload rather than a summary. It is scoped to a single
     * (strategy, version) pair and limited to one row, which the composite index
     * `ix_wf_backtests_strategy` serves directly.
     */
    async latestStrategyBacktest(strategyId, version) {
      const [rows] = await pool.execute(
        `SELECT payload
           FROM wf_backtests
          WHERE strategy_id = ? AND strategy_version = ?
          ORDER BY created_at DESC, id ASC
          LIMIT 1`,
        [String(strategyId), String(version)],
      );
      return rows.length ? decodeJson(rows[0].payload, null, `Latest backtest for ${strategyId}@${version}`) : null;
    },

    // ---- journal --------------------------------------------------------

    async saveJournalEntry(entry) {
      await pool.execute(
        `INSERT INTO wf_journal_entries
           (id, source, symbol, market, strategy, strategy_version, direction, entry_time,
            entry_price, exit_time, exit_price, position_size, stop_loss, take_profit, fees,
            slippage, pnl, pnl_pct, r_multiple, reason, ai_confidence, confidence_source,
            agent_consensus, risk_score, execution_time, backtest_id, paper_position_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           source = VALUES(source),
           symbol = VALUES(symbol),
           market = VALUES(market),
           strategy = VALUES(strategy),
           strategy_version = VALUES(strategy_version),
           direction = VALUES(direction),
           entry_time = VALUES(entry_time),
           entry_price = VALUES(entry_price),
           exit_time = VALUES(exit_time),
           exit_price = VALUES(exit_price),
           position_size = VALUES(position_size),
           stop_loss = VALUES(stop_loss),
           take_profit = VALUES(take_profit),
           fees = VALUES(fees),
           slippage = VALUES(slippage),
           pnl = VALUES(pnl),
           pnl_pct = VALUES(pnl_pct),
           r_multiple = VALUES(r_multiple),
           reason = VALUES(reason),
           ai_confidence = VALUES(ai_confidence),
           confidence_source = VALUES(confidence_source),
           agent_consensus = VALUES(agent_consensus),
           risk_score = VALUES(risk_score),
           execution_time = VALUES(execution_time),
           backtest_id = VALUES(backtest_id)`,
        [
          String(entry.id),
          String(entry.source),
          String(entry.symbol),
          String(entry.market ?? ""),
          entry.strategy === null || entry.strategy === undefined ? null : String(entry.strategy),
          entry.strategy_version === null || entry.strategy_version === undefined ? null : String(entry.strategy_version),
          String(entry.direction),
          String(entry.entry_time),
          Number(entry.entry_price),
          entry.exit_time === null || entry.exit_time === undefined ? null : String(entry.exit_time),
          entry.exit_price === null || entry.exit_price === undefined ? null : Number(entry.exit_price),
          Number(entry.position_size),
          entry.stop_loss === null || entry.stop_loss === undefined ? null : Number(entry.stop_loss),
          entry.take_profit === null || entry.take_profit === undefined ? null : Number(entry.take_profit),
          Number(entry.fees ?? 0),
          Number(entry.slippage ?? 0),
          entry.pnl === null || entry.pnl === undefined ? null : Number(entry.pnl),
          entry.pnl_pct === null || entry.pnl_pct === undefined ? null : Number(entry.pnl_pct),
          entry.r_multiple === null || entry.r_multiple === undefined ? null : Number(entry.r_multiple),
          entry.reason === null || entry.reason === undefined ? null : String(entry.reason),
          entry.ai_confidence === null || entry.ai_confidence === undefined ? null : Number(entry.ai_confidence),
          entry.confidence_source === null || entry.confidence_source === undefined ? null : String(entry.confidence_source),
          entry.agent_consensus === null || entry.agent_consensus === undefined ? null : String(entry.agent_consensus),
          entry.risk_score === null || entry.risk_score === undefined ? null : Number(entry.risk_score),
          String(entry.execution_time),
          entry.backtest_id === null || entry.backtest_id === undefined ? null : String(entry.backtest_id),
          // Never written by this module: it belongs to paper trading (row 10 of
          // UNFINISHED_MODULES.md). Bound as NULL so an import can set it later.
          entry.paper_position_id === null || entry.paper_position_id === undefined ? null : Number(entry.paper_position_id),
        ],
      );
      return { id: String(entry.id) };
    },

    /**
     * Journal rows, newest execution first.
     *
     * The approval gate calls this with `{source: "paper", strategy: id}` and then
     * re-filters in memory, so the `source` and `strategy` predicates are the ones
     * that matter; `symbol` is supported because the trade history route filters by
     * instrument. All three are bound, and the index
     * `ix_wf_journal_strategy (strategy, source, execution_time)` covers the gate's
     * query.
     */
    async listJournalEntries({ source = null, strategy = null, symbol = null, limit = 200 } = {}) {
      const bounded = boundedLimit(limit, 200, 1_000);
      const clauses = [];
      const params = [];
      if (source) {
        clauses.push("source = ?");
        params.push(String(source));
      }
      if (strategy) {
        clauses.push("strategy = ?");
        params.push(String(strategy));
      }
      if (symbol) {
        clauses.push("symbol = ?");
        params.push(String(symbol));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await pool.query(
        `SELECT id, source, symbol, market, strategy, strategy_version, direction, entry_time,
                entry_price, exit_time, exit_price, position_size, stop_loss, take_profit, fees,
                slippage, pnl, pnl_pct, r_multiple, reason, ai_confidence, confidence_source,
                agent_consensus, risk_score, execution_time, backtest_id, paper_position_id
           FROM wf_journal_entries
           ${where}
          ORDER BY execution_time DESC, id ASC
          LIMIT ${bounded}`,
        params,
      );
      return rows.map(journalRow);
    },
  };
}
