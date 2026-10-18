/**
 * In-process, deterministic MT5 bridge simulator.
 *
 * This adapter implements the documented bridge JSON contract without opening a
 * socket, writing to the configured broker roster, or contacting a provider. Its
 * state is process-local and resets on restart. It exists for isolated demos and
 * contract testing only; every response is marked `simulated: true`, and it must
 * never be used as evidence of a real broker connection or real execution.
 */

const DEFAULT_QUOTES = Object.freeze({
  EURUSD: Object.freeze([1.075, 1.0752]),
  GBPUSD: Object.freeze([1.265, 1.2653]),
  USDJPY: Object.freeze([149.95, 149.98]),
  AUDUSD: Object.freeze([0.655, 0.6552]),
  BTCUSDT: Object.freeze([67_000, 67_020]),
  ETHUSDT: Object.freeze([3_500, 3_502]),
  XAUUSD: Object.freeze([2_650, 2_650.5]),
});

const ISO = (milliseconds) => new Date(milliseconds).toISOString();
const integerTicket = (value) => /^\d{1,15}$/.test(String(value ?? "")) ? Number(value) : null;
const envelope = (data) => ({ ok: true, data });
const failed = (error) => ({ ok: false, error });

function parseRoute(path) {
  const raw = String(path ?? "");
  const queryAt = raw.indexOf("?");
  const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? "" : raw.slice(queryAt + 1));
  return { pathname, query };
}

/**
 * Create one isolated simulated account. Callers may create one bridge per
 * paper-account id so demo positions are not shared between workspace users.
 *
 * @param {{now?:()=>number, initialBalance?:number, accountId?:string, ordersEnabled?:boolean, quoteTable?:object}} options
 */
export function createSimulatedMt5Bridge({
  now = () => Date.now(),
  initialBalance = 10_000,
  accountId = "SIM-0001",
  ordersEnabled = false,
  quoteTable = DEFAULT_QUOTES,
} = {}) {
  const balanceSeed = Number(initialBalance);
  if (!Number.isFinite(balanceSeed) || balanceSeed <= 0) throw new TypeError("simulated account balance must be positive");
  const id = String(accountId).slice(0, 32) || "SIM-0001";
  const quotes = new Map(Object.entries(quoteTable).map(([symbol, pair]) => [
    String(symbol).toUpperCase(), [Number(pair[0]), Number(pair[1])],
  ]));
  const positions = new Map();
  const pending = new Map();
  const history = [];
  let balance = balanceSeed;
  let nextTicket = 1;

  function quote(symbol) {
    const key = String(symbol ?? "").trim().toUpperCase();
    const pair = quotes.get(key);
    if (!/^[A-Z0-9._-]{1,32}$/.test(key) || !pair || pair.length !== 2
      || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1]) || pair[0] <= 0 || pair[1] < pair[0]) {
      throw new Error("simulated bridge does not provide this symbol");
    }
    const [bid, ask] = pair;
    return { symbol: key, bid, ask, last: (bid + ask) / 2, timestamp: ISO(now()) };
  }

  function profitFor(position, mark = quote(position.symbol).last) {
    return (position.side === "BUY" ? 1 : -1) * (mark - position.entry) * position.volume;
  }

  function account() {
    let margin = 0;
    let unrealized = 0;
    for (const position of positions.values()) {
      const market = quote(position.symbol);
      const entry = position.side === "BUY" ? market.ask : market.bid;
      margin += position.volume * entry * 0.033;
      unrealized += profitFor(position, market.last);
    }
    const equity = Math.max(0, balance + unrealized);
    const usedMargin = Math.max(0, margin);
    return {
      accountId: id,
      accountType: "demo",
      currency: "USD",
      balance,
      equity,
      margin: usedMargin,
      freeMargin: Math.max(0, equity - usedMargin),
      leverage: 30,
      timestamp: ISO(now()),
    };
  }

  function positionRows() {
    return [...positions.values()].map((position) => ({
      ticket: position.ticket,
      symbol: position.symbol,
      side: position.side === "BUY" ? "LONG" : "SHORT",
      volume: position.volume,
      entry: position.entry,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      profit: profitFor(position),
      openedAt: position.openedAt,
    }));
  }

  function orderRows() {
    return [...pending.values()].map((order) => ({ ...order }));
  }

  function historyRows(limit = 100) {
    return history.slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse().map((row) => ({ ...row }));
  }

  function order(body = {}) {
    if (!ordersEnabled) throw new Error("simulated bridge order submission is disabled");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("simulated order body is invalid");
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    const side = String(body.action ?? "").trim().toUpperCase();
    const type = String(body.type ?? "MARKET").trim().toUpperCase();
    const volume = Number(body.volume);
    if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) throw new Error("simulated order symbol is invalid");
    if (!quotes.has(symbol)) throw new Error("simulated bridge does not provide this symbol");
    if (!["BUY", "SELL"].includes(side)) throw new Error("action must be BUY or SELL");
    if (!["MARKET", "LIMIT"].includes(type)) throw new Error("type must be MARKET or LIMIT");
    if (!Number.isFinite(volume) || volume <= 0) throw new Error("volume must be positive");
    const market = quote(symbol);
    const entry = type === "LIMIT" ? Number(body.price) : side === "BUY" ? market.ask : market.bid;
    if (!Number.isFinite(entry) || entry <= 0) throw new Error("a positive price is required for this simulated order");
    const stopLoss = body.stopLoss === null || body.stopLoss === undefined ? null : Number(body.stopLoss);
    const takeProfit = body.takeProfit === null || body.takeProfit === undefined ? null : Number(body.takeProfit);
    if (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss <= 0)) throw new Error("stopLoss must be positive");
    if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0)) throw new Error("takeProfit must be positive");
    if (stopLoss !== null && (side === "BUY" ? stopLoss >= entry : stopLoss <= entry)) {
      throw new Error("stopLoss is on the wrong side of the simulated entry price");
    }
    if (takeProfit !== null && (side === "BUY" ? takeProfit <= entry : takeProfit >= entry)) {
      throw new Error("takeProfit is on the wrong side of the simulated entry price");
    }
    if ([...positions.values(), ...pending.values()].some((row) => row.symbol === symbol)) {
      throw new Error(`simulated account already has a position or pending order in ${symbol}`);
    }
    const requiredMargin = volume * entry * 0.033;
    if (requiredMargin > account().freeMargin) throw new Error("simulated order exceeds free margin");

    const ticket = nextTicket++;
    const placedAt = ISO(now());
    if (type === "LIMIT") {
      pending.set(ticket, {
        ticket,
        symbol,
        side,
        type,
        volume,
        price: entry,
        stopLoss,
        takeProfit,
        placedAt,
      });
    } else {
      positions.set(ticket, {
        ticket,
        symbol,
        side,
        volume,
        entry,
        stopLoss,
        takeProfit,
        openedAt: placedAt,
      });
    }
    return { ticket, price: entry, placedAt, simulated: true };
  }

  function modifyOrder(ticketValue, changes = {}) {
    if (!ordersEnabled) throw new Error("simulated bridge order submission is disabled");
    const ticket = integerTicket(ticketValue);
    const row = ticket === null ? null : (pending.get(ticket) ?? positions.get(ticket));
    if (!row) throw new Error("simulated order ticket not found");
    for (const field of ["price", "stopLoss", "takeProfit"]) {
      if (changes[field] === undefined) continue;
      const value = Number(changes[field]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
      row[field] = value;
    }
    return { ticket };
  }

  function cancelOrder(ticketValue) {
    if (!ordersEnabled) throw new Error("simulated bridge order submission is disabled");
    const ticket = integerTicket(ticketValue);
    if (ticket === null || !pending.delete(ticket)) throw new Error("simulated pending order not found");
    return { ticket };
  }

  function closePosition(ticketValue) {
    if (!ordersEnabled) throw new Error("simulated bridge order submission is disabled");
    const ticket = integerTicket(ticketValue);
    const position = ticket === null ? null : positions.get(ticket);
    if (!position) throw new Error("simulated position not found");
    const market = quote(position.symbol);
    const exit = position.side === "BUY" ? market.bid : market.ask;
    const profit = profitFor(position, exit);
    positions.delete(ticket);
    balance = Math.max(0, balance + profit);
    history.push({
      ticket,
      symbol: position.symbol,
      side: position.side === "BUY" ? "LONG" : "SHORT",
      volume: position.volume,
      entry: position.entry,
      exit,
      profit,
      openedAt: position.openedAt,
      closedAt: ISO(now()),
    });
    return { ticket, price: exit, profit };
  }

  function candles(symbol, timeframe, limit) {
    const anchor = quote(symbol);
    const count = Math.max(10, Math.min(1000, Math.trunc(Number(limit) || 100)));
    const tfMs = ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 })[timeframe];
    if (!tfMs) throw new Error("simulated timeframe is invalid");
    const midpoint = anchor.last;
    const unit = Math.max(midpoint * 0.0001, 0.00001);
    const start = now() - (count - 1) * tfMs;
    return Array.from({ length: count }, (_, index) => {
      const drift = ((index % 9) - 4) * unit / 3;
      const open = midpoint + drift;
      const close = open + (index % 2 === 0 ? unit / 2 : -unit / 2);
      return {
        t: Math.floor((start + index * tfMs) / 1000),
        o: open,
        h: Math.max(open, close) + unit / 2,
        l: Math.min(open, close) - unit / 2,
        c: close,
        v: 100 + (index % 17) * 5,
      };
    });
  }

  async function transport(method, path, _token, body) {
    const verb = String(method ?? "GET").toUpperCase();
    const route = parseRoute(path);
    try {
      if (verb === "GET" && route.pathname === "/health") {
        return { ok: true, version: "windels-in-process-simulator/1", accountType: "demo", tradingEnabled: ordersEnabled, simulated: true };
      }
      if (verb === "GET" && route.pathname === "/v1/account") return envelope(account());
      if (verb === "GET" && route.pathname === "/v1/positions") return envelope(positionRows());
      if (verb === "GET" && route.pathname === "/v1/orders") return envelope(orderRows());
      if (verb === "GET" && route.pathname === "/v1/history") return envelope(historyRows(route.query.get("limit")));

      const quoteMatch = route.pathname.match(/^\/v1\/quotes\/([^/]+)$/);
      if (verb === "GET" && quoteMatch) return envelope(quote(decodeURIComponent(quoteMatch[1])));
      const candleMatch = route.pathname.match(/^\/v1\/candles\/([^/]+)$/);
      if (verb === "GET" && candleMatch) {
        return envelope(candles(decodeURIComponent(candleMatch[1]), route.query.get("tf"), route.query.get("limit")));
      }
      if (verb === "POST" && route.pathname === "/v1/orders") return envelope(order(body));

      const orderMatch = route.pathname.match(/^\/v1\/orders\/(\d+)\/(modify|cancel)$/);
      if (verb === "POST" && orderMatch && orderMatch[2] === "modify") return envelope(modifyOrder(orderMatch[1], body));
      if (verb === "POST" && orderMatch && orderMatch[2] === "cancel") return envelope(cancelOrder(orderMatch[1]));
      const closeMatch = route.pathname.match(/^\/v1\/positions\/(\d+)\/close$/);
      if (verb === "POST" && closeMatch) return envelope(closePosition(closeMatch[1]));
      return failed("simulated bridge route not found");
    } catch (error) {
      return failed(String(error?.message ?? "simulated bridge request failed").slice(0, 200));
    }
  }

  return Object.freeze({
    transport,
    account,
    quote,
    positionRows,
    orderRows,
    historyRows,
    reset() {
      positions.clear();
      pending.clear();
      history.splice(0, history.length);
      balance = balanceSeed;
      nextTicket = 1;
    },
    get ordersEnabled() { return ordersEnabled; },
    get state() {
      return Object.freeze({
        account: Object.freeze({ ...account() }),
        positions: Object.freeze(positionRows().map((row) => Object.freeze(row))),
        pendingOrders: Object.freeze(orderRows().map((row) => Object.freeze(row))),
        history: Object.freeze(historyRows(500).map((row) => Object.freeze(row))),
      });
    },
  });
}
