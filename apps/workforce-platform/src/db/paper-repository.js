/**
 * MySQL/MariaDB repository for paper trading and the persisted trading state.
 *
 * Every mutation that can affect account balance, positions, fills or the paper
 * journal is executed through `store.withPaperTransaction()`. Its transaction
 * view locks the account row and, for commands that can create exposure, the
 * singleton governance row. This serializes competing orders for one account and
 * makes the one-net-position-per-symbol rule true across Passenger workers, not
 * merely inside one process.
 */

function numeric(value) {
  return value === null || value === undefined ? null : Number(value);
}

function boundedLimit(value, fallback = 100, ceiling = 2_000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

function decodeState(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    const error = new Error("The persisted trading state is unreadable");
    error.statusCode = 500;
    throw error;
  }
}

function accountRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    starting_balance: Number(row.starting_balance),
    balance: Number(row.balance),
    peak_equity: Number(row.peak_equity),
    revision: Number(row.revision ?? 0),
  };
}

const ORDER_NUMERIC = Object.freeze(["id", "account_id", "units", "price", "stop_loss", "take_profit", "risk_amount", "ai_confidence", "fill_price"]);
const POSITION_NUMERIC = Object.freeze(["id", "account_id", "units", "entry_price", "stop_loss", "take_profit", "entry_fee", "risk_amount", "ai_confidence", "exit_price", "realized_pnl"]);
const TRADE_NUMERIC = Object.freeze(["id", "account_id", "order_id", "position_id", "price", "units", "fee", "net_pnl"]);
const DEPLOYMENT_NUMERIC = Object.freeze(["id", "account_id", "active"]);

function castRow(row, fields, booleanFields = []) {
  if (!row) return null;
  const result = { ...row };
  for (const field of fields) result[field] = numeric(row[field]);
  for (const field of booleanFields) result[field] = Boolean(Number(row[field]));
  return result;
}

export function createPaperRepository(executor, { lockRows = false } = {}) {
  const lock = lockRows ? " FOR UPDATE" : "";

  return {
    async loadTradingState() {
      const [rows] = await executor.execute(
        `SELECT state_json, updated_by_user_id, updated_at
           FROM wf_trading_state
          WHERE state_key = 'global'
          LIMIT 1${lock}`,
      );
      if (!rows.length) return null;
      return {
        ...decodeState(rows[0].state_json),
        updatedByUserId: numeric(rows[0].updated_by_user_id),
        updatedAt: rows[0].updated_at,
      };
    },

    async saveTradingState(state, { updatedByUserId = null, updatedAt = new Date().toISOString() } = {}) {
      const { updatedByUserId: _storedActor, updatedAt: _storedAt, ...stateJson } = state;
      await executor.execute(
        `INSERT INTO wf_trading_state (state_key, state_json, updated_by_user_id, updated_at)
         VALUES ('global', ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           state_json = VALUES(state_json),
           updated_by_user_id = VALUES(updated_by_user_id),
           updated_at = VALUES(updated_at)`,
        [JSON.stringify(stateJson), updatedByUserId, String(updatedAt)],
      );
      return { ...stateJson, updatedByUserId, updatedAt: String(updatedAt) };
    },

    async createPaperAccount(record) {
      const [result] = await executor.execute(
        `INSERT INTO wf_paper_accounts
           (owner_user_id, name, currency, starting_balance, balance, peak_equity, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(record.owner_user_id), String(record.name), String(record.currency || "USD"),
          Number(record.starting_balance), Number(record.balance), Number(record.peak_equity),
          Number(record.revision ?? 0), String(record.created_at),
        ],
      );
      return accountRow({ ...record, id: result.insertId });
    },

    async savePaperAccount(record) {
      if (!record.id) return this.createPaperAccount(record);
      await executor.execute(
        `UPDATE wf_paper_accounts
            SET name = ?, currency = ?, starting_balance = ?, balance = ?, peak_equity = ?, revision = ?
          WHERE id = ? AND owner_user_id = ?`,
        [
          String(record.name), String(record.currency || "USD"), Number(record.starting_balance),
          Number(record.balance), Number(record.peak_equity), Number(record.revision ?? 0),
          Number(record.id), Number(record.owner_user_id),
        ],
      );
      return this.findPaperAccount(record.id, record.owner_user_id);
    },

    async findPaperAccount(id, ownerUserId = null) {
      const clauses = ["id = ?"];
      const values = [Number(id)];
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      const [rows] = await executor.execute(
        `SELECT id, owner_user_id, name, currency, starting_balance, balance, peak_equity, revision, created_at
           FROM wf_paper_accounts WHERE ${clauses.join(" AND ")} LIMIT 1${lock}`,
        values,
      );
      return accountRow(rows[0] || null);
    },

    async listPaperAccounts(ownerUserId = null, limit = 500) {
      const bounded = boundedLimit(limit, 500, 5_000);
      const where = ownerUserId === null || ownerUserId === undefined ? "" : "WHERE owner_user_id = ?";
      const values = ownerUserId === null || ownerUserId === undefined ? [] : [Number(ownerUserId)];
      const [rows] = await executor.query(
        `SELECT id, owner_user_id, name, currency, starting_balance, balance, peak_equity, revision, created_at
           FROM wf_paper_accounts ${where}
          ORDER BY id ASC LIMIT ${bounded}`,
        values,
      );
      return rows.map(accountRow);
    },

    /** Move a high-water mark forward only; a valuation can never lower it. */
    async markPaperAccountPeak(id, ownerUserId, equity) {
      await executor.execute(
        `UPDATE wf_paper_accounts
            SET revision = revision + 1,
                peak_equity = GREATEST(peak_equity, ?)
          WHERE id = ? AND owner_user_id = ? AND peak_equity < ?`,
        [Number(equity), Number(id), Number(ownerUserId), Number(equity)],
      );
      return this.findPaperAccount(id, ownerUserId);
    },

    async savePaperOrder(record) {
      const values = [
        Number(record.account_id), String(record.symbol), String(record.market_class || "forex"),
        String(record.side), String(record.type), Number(record.units ?? 0),
        record.price === null || record.price === undefined ? null : Number(record.price),
        record.stop_loss === null || record.stop_loss === undefined ? null : Number(record.stop_loss),
        record.take_profit === null || record.take_profit === undefined ? null : Number(record.take_profit),
        String(record.status), record.reject_reason ?? null,
        record.risk_amount === null || record.risk_amount === undefined ? null : Number(record.risk_amount),
        record.reason ?? null,
        record.ai_confidence === null || record.ai_confidence === undefined ? null : Number(record.ai_confidence),
        record.strategy ?? null,
        record.strategy_version ?? null,
        record.synthetic ? 1 : 0,
        String(record.created_at), record.filled_at ?? null,
        record.fill_price === null || record.fill_price === undefined ? null : Number(record.fill_price),
      ];
      if (!record.id) {
        const [result] = await executor.execute(
          `INSERT INTO wf_paper_orders
             (account_id, symbol, market_class, side, type, units, price, stop_loss, take_profit,
              status, reject_reason, risk_amount, reason, ai_confidence, strategy, strategy_version,
              synthetic, created_at, filled_at, fill_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        );
        return castRow({ ...record, id: result.insertId }, ORDER_NUMERIC, ["synthetic"]);
      }
      await executor.execute(
        `UPDATE wf_paper_orders SET
           symbol = ?, market_class = ?, side = ?, type = ?, units = ?, price = ?, stop_loss = ?, take_profit = ?,
           status = ?, reject_reason = ?, risk_amount = ?, reason = ?, ai_confidence = ?, strategy = ?,
           strategy_version = ?, synthetic = ?, created_at = ?, filled_at = ?, fill_price = ?
         WHERE id = ? AND account_id = ?`,
        [...values.slice(1), Number(record.id), Number(record.account_id)],
      );
      return this.findPaperOrder(Number(record.id), Number(record.account_id));
    },

    async findPaperOrder(id, accountId) {
      const [rows] = await executor.execute(
        `SELECT * FROM wf_paper_orders WHERE id = ? AND account_id = ? LIMIT 1${lock}`,
        [Number(id), Number(accountId)],
      );
      return castRow(rows[0] || null, ORDER_NUMERIC, ["synthetic"]);
    },

    async listPaperOrders({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
      const clauses = ["o.account_id = ?"];
      const values = [Number(accountId)];
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("a.owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      if (status) {
        clauses.push("o.status = ?");
        values.push(String(status));
      }
      const bounded = boundedLimit(limit, 200, 2_000);
      const [rows] = await executor.query(
        `SELECT o.* FROM wf_paper_orders o
           JOIN wf_paper_accounts a ON a.id = o.account_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY o.id DESC LIMIT ${bounded}`,
        values,
      );
      return rows.map((row) => castRow(row, ORDER_NUMERIC, ["synthetic"]));
    },

    async findOpenPaperOrder(accountId, symbol) {
      const [rows] = await executor.execute(
        `SELECT * FROM wf_paper_orders
          WHERE account_id = ? AND symbol = ? AND status = 'PENDING'
          ORDER BY id DESC LIMIT 1${lock}`,
        [Number(accountId), String(symbol)],
      );
      return castRow(rows[0] || null, ORDER_NUMERIC, ["synthetic"]);
    },

    async listAllPendingPaperOrders(limit = 2_000) {
      const bounded = boundedLimit(limit, 2_000, 5_000);
      const [rows] = await executor.query(
        `SELECT * FROM wf_paper_orders WHERE status = 'PENDING' ORDER BY id ASC LIMIT ${bounded}`,
      );
      return rows.map((row) => castRow(row, ORDER_NUMERIC, ["synthetic"]));
    },

    async savePaperPosition(record) {
      const values = [
        Number(record.account_id), String(record.symbol), String(record.market_class || "forex"),
        String(record.direction), Number(record.units), Number(record.entry_price),
        Number(record.stop_loss), Number(record.take_profit), Number(record.entry_fee ?? 0),
        record.risk_amount === null || record.risk_amount === undefined ? null : Number(record.risk_amount),
        record.strategy ?? null, record.strategy_version ?? null, record.reason ?? null,
        record.ai_confidence === null || record.ai_confidence === undefined ? null : Number(record.ai_confidence),
        record.synthetic ? 1 : 0,
        String(record.opened_at), String(record.status || "OPEN"), record.closed_at ?? null,
        record.exit_price === null || record.exit_price === undefined ? null : Number(record.exit_price),
        record.realized_pnl === null || record.realized_pnl === undefined ? null : Number(record.realized_pnl),
        record.exit_reason ?? null,
      ];
      if (!record.id) {
        const [result] = await executor.execute(
          `INSERT INTO wf_paper_positions
             (account_id, symbol, market_class, direction, units, entry_price, stop_loss, take_profit,
              entry_fee, risk_amount, strategy, strategy_version, reason, ai_confidence, synthetic,
              opened_at, status, closed_at, exit_price, realized_pnl, exit_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        );
        return castRow({ ...record, id: result.insertId }, POSITION_NUMERIC, ["synthetic"]);
      }
      await executor.execute(
        `UPDATE wf_paper_positions SET
           symbol = ?, market_class = ?, direction = ?, units = ?, entry_price = ?, stop_loss = ?, take_profit = ?,
           entry_fee = ?, risk_amount = ?, strategy = ?, strategy_version = ?, reason = ?, ai_confidence = ?,
           synthetic = ?, opened_at = ?, status = ?, closed_at = ?, exit_price = ?, realized_pnl = ?, exit_reason = ?
         WHERE id = ? AND account_id = ?`,
        [...values.slice(1), Number(record.id), Number(record.account_id)],
      );
      return this.findPaperPosition(Number(record.account_id), Number(record.id));
    },

    async findPaperPosition(accountId, positionId, ownerUserId = null) {
      const clauses = ["p.account_id = ?", "p.id = ?"];
      const values = [Number(accountId), Number(positionId)];
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("a.owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      const [rows] = await executor.execute(
        `SELECT p.* FROM wf_paper_positions p
           JOIN wf_paper_accounts a ON a.id = p.account_id
          WHERE ${clauses.join(" AND ")} LIMIT 1${lock}`,
        values,
      );
      return castRow(rows[0] || null, POSITION_NUMERIC, ["synthetic"]);
    },

    async findOpenPaperPosition(accountId, symbol) {
      const [rows] = await executor.execute(
        `SELECT * FROM wf_paper_positions
          WHERE account_id = ? AND symbol = ? AND status = 'OPEN'
          ORDER BY id DESC LIMIT 1${lock}`,
        [Number(accountId), String(symbol)],
      );
      return castRow(rows[0] || null, POSITION_NUMERIC, ["synthetic"]);
    },

    async listPaperPositions({ accountId, ownerUserId = null, status = null, limit = 200 } = {}) {
      const clauses = ["p.account_id = ?"];
      const values = [Number(accountId)];
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("a.owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      if (status) {
        clauses.push("p.status = ?");
        values.push(String(status));
      }
      const bounded = boundedLimit(limit, 200, 2_000);
      const [rows] = await executor.query(
        `SELECT p.* FROM wf_paper_positions p
           JOIN wf_paper_accounts a ON a.id = p.account_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY p.id DESC LIMIT ${bounded}`,
        values,
      );
      return rows.map((row) => castRow(row, POSITION_NUMERIC, ["synthetic"]));
    },

    async savePaperTrade(record) {
      if (record.id) throw new TypeError("paper trade legs are append-only");
      const [result] = await executor.execute(
        `INSERT INTO wf_paper_trades
           (account_id, order_id, position_id, leg, symbol, price, units, fee, time, synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(record.account_id), record.order_id === null || record.order_id === undefined ? null : Number(record.order_id),
          Number(record.position_id), String(record.leg), String(record.symbol), Number(record.price),
          Number(record.units), Number(record.fee ?? 0), String(record.time), record.synthetic ? 1 : 0,
        ],
      );
      return { ...record, id: Number(result.insertId) };
    },

    async listPaperTrades({ accountId, ownerUserId = null, limit = 1_000 } = {}) {
      const clauses = ["t.account_id = ?"];
      const values = [Number(accountId)];
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("a.owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      const bounded = boundedLimit(limit, 1_000, 5_000);
      const [rows] = await executor.query(
        `SELECT t.*, CASE WHEN t.leg = 'EXIT' THEN p.realized_pnl ELSE NULL END AS net_pnl
           FROM wf_paper_trades t
           JOIN wf_paper_accounts a ON a.id = t.account_id
           LEFT JOIN wf_paper_positions p ON p.id = t.position_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY t.id DESC LIMIT ${bounded}`,
        values,
      );
      return rows.map((row) => castRow(row, TRADE_NUMERIC, ["synthetic"]));
    },

    async savePaperDeployment(record) {
      const values = [
        Number(record.account_id), String(record.strategy_id), String(record.strategy_version), String(record.symbol),
        String(record.market_class), String(record.timeframe), record.active ? 1 : 0, String(record.deployed_at),
        record.last_evaluated_at ?? null, record.last_signal ?? null,
      ];
      if (!record.id) {
        const [result] = await executor.execute(
          `INSERT INTO wf_paper_deployments
             (account_id, strategy_id, strategy_version, symbol, market_class, timeframe, active,
              deployed_at, last_evaluated_at, last_signal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        );
        return castRow({ ...record, id: result.insertId }, DEPLOYMENT_NUMERIC);
      }
      await executor.execute(
        `UPDATE wf_paper_deployments SET
           account_id = ?, strategy_id = ?, strategy_version = ?, symbol = ?, market_class = ?, timeframe = ?,
           active = ?, deployed_at = ?, last_evaluated_at = ?, last_signal = ? WHERE id = ?`,
        [...values, Number(record.id)],
      );
      return this.findPaperDeployment(Number(record.id));
    },

    async findPaperDeployment(id, ownerUserId = null) {
      const values = [Number(id)];
      const ownerClause = ownerUserId === null || ownerUserId === undefined ? "" : " AND a.owner_user_id = ?";
      if (ownerClause) values.push(Number(ownerUserId));
      const [rows] = await executor.execute(
        `SELECT d.* FROM wf_paper_deployments d
           JOIN wf_paper_accounts a ON a.id = d.account_id
          WHERE d.id = ?${ownerClause} LIMIT 1${lock}`,
        values,
      );
      return castRow(rows[0] || null, DEPLOYMENT_NUMERIC, ["active"]);
    },

    async listPaperDeployments({ accountId = null, ownerUserId = null, active = null, limit = 500 } = {}) {
      const clauses = [];
      const values = [];
      if (accountId !== null && accountId !== undefined) {
        clauses.push("d.account_id = ?");
        values.push(Number(accountId));
      }
      if (ownerUserId !== null && ownerUserId !== undefined) {
        clauses.push("a.owner_user_id = ?");
        values.push(Number(ownerUserId));
      }
      if (active !== null && active !== undefined) {
        clauses.push("d.active = ?");
        values.push(active ? 1 : 0);
      }
      const bounded = boundedLimit(limit, 500, 5_000);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await executor.query(
        `SELECT d.* FROM wf_paper_deployments d
           JOIN wf_paper_accounts a ON a.id = d.account_id
          ${where} ORDER BY d.id ASC LIMIT ${bounded}`,
        values,
      );
      return rows.map((row) => castRow(row, DEPLOYMENT_NUMERIC, ["active"]));
    },

    async listAllActivePaperDeployments(limit = 2_000) {
      const bounded = boundedLimit(limit, 2_000, 5_000);
      const [rows] = await executor.query(
        `SELECT * FROM wf_paper_deployments WHERE active = 1 ORDER BY id ASC LIMIT ${bounded}`,
      );
      return rows.map((row) => castRow(row, DEPLOYMENT_NUMERIC, ["active"]));
    },
  };
}
