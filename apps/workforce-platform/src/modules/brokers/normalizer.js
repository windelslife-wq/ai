/**
 * Canonical, read-only broker data contracts — a port of
 * `application/libraries/Aegis/Brokers/BrokerDataNormalizer.php` (row 13).
 *
 * Every connector returns these shapes and nothing else. The class exists so a
 * bridge cannot hand the execution supervisor a payload it has to interpret:
 * validation happens once, here, and a malformed provider response is refused
 * rather than passed along with a plausible-looking zero in it.
 *
 * Two deliberate choices make this file comparable against the PHP original:
 *
 *  1. **Error messages are byte-identical to legacy** (`"broker quote bid/ask is
 *     invalid"`, not a rewritten sentence). They are the only part of a refused
 *     provider payload an operator ever sees, and matching them means a
 *     differential test can compare PHP and Node rejections directly instead of
 *     maintaining a translation table.
 *  2. **Timestamps use legacy's `gmdate('c')` shape** — `2026-10-12T01:02:03+00:00`,
 *     no milliseconds, explicit `+00:00` offset — rather than the `…Z` shape
 *     `Date#toISOString()` produces everywhere else on this platform. Recorded as
 *     divergence BC-1. This is the one module where an offset-suffixed instant is
 *     the right answer: the whole point is that a normalized broker payload should
 *     be diffable against the payload the PHP normalizer produced from the same
 *     bridge response (F-26), and a format difference would fail every comparison
 *     on a technicality.
 *
 * These functions are pure and synchronous, throw plain `Error`, and never touch
 * the store, the clock or the network — `now` is injected where an instant is
 * needed. The broker routes map the failures to HTTP at the boundary.
 */

/** Symbols legacy accepted: uppercase alphanumerics with dot, underscore, hyphen. */
const SYMBOL = /^[A-Z0-9._-]{1,32}$/;
/** ISO-4217-ish: legacy required exactly three uppercase letters and nothing more. */
const CURRENCY = /^[A-Z]{3}$/;

const POSITION_SIDES = Object.freeze(["LONG", "SHORT"]);
const ORDER_SIDES = Object.freeze(["BUY", "SELL"]);
const PENDING_TYPES = Object.freeze(["LIMIT", "STOP"]);

/**
 * PHP's `is_numeric()`: a finite number, or a string that is entirely a number
 * (optional surrounding whitespace, sign, decimal point, exponent). Booleans,
 * `null`, arrays and empty strings are **not** numeric — matching PHP matters
 * because `is_numeric(true)` is false there while `Number(true)` is 1 here.
 */
function isNumericLike(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    return Number.isFinite(Number(trimmed));
  }
  return false;
}

/**
 * PHP's `isset($raw[$key])` — false for a missing key *and* for an explicit
 * `null`. Several legacy defaults hinge on that (`quote.last`, the optional
 * numbers), so the distinction is preserved rather than collapsed into `??`.
 */
function phpIsset(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== null && raw[key] !== undefined;
}

function isRow(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Legacy `self::number()`. A missing key uses the default when one was supplied
 * and throws otherwise; a present-but-unusable value always throws.
 */
function number(raw, key, fallback = null) {
  // `key in raw` is PHP's `array_key_exists`, which is true for an explicit null.
  // That distinction is load-bearing: an absent key may take a default, but a key
  // present-and-null is a malformed response and must throw.
  if (!(key in raw)) {
    if (fallback !== null) return fallback;
    throw new Error(`broker response missing ${key}`);
  }
  if (!isNumericLike(raw[key])) throw new Error(`broker response ${key} is invalid`);
  return Number(raw[key]);
}

/** Legacy `self::optionalNumber()` — absent, `null` or `''` normalizes to `null`. */
function optionalNumber(raw, key) {
  if (!phpIsset(raw, key) || raw[key] === "") return null;
  return number(raw, key);
}

/** Legacy `self::enum()` — uppercased and checked against a closed vocabulary. */
function oneOf(raw, key, allowed) {
  const value = String(phpIsset(raw, key) ? raw[key] : "").toUpperCase();
  if (!allowed.includes(value)) throw new Error(`broker response ${key} is invalid`);
  return value;
}

function symbolOf(raw) {
  const symbol = String(phpIsset(raw, "symbol") ? raw.symbol : "").trim().toUpperCase();
  if (!SYMBOL.test(symbol)) throw new Error("broker symbol is invalid");
  return symbol;
}

/**
 * Legacy `self::timestamp()`, including its three input shapes:
 *   - `null` / `''`        → the current instant
 *   - a number or numeric string → **epoch seconds**, truncated like PHP's `(int)`
 *   - anything else        → parsed as a date string, converted to UTC
 *
 * An unparseable value throws rather than silently becoming "now": a bridge that
 * cannot say when a quote was produced must not be allowed to claim it is fresh.
 */
function timestamp(value, now) {
  if (value === null || value === undefined || value === "") return formatUtc(new Date(now()));
  if (isNumericLike(value)) {
    const seconds = Math.trunc(Number(value));
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) throw new Error("broker response timestamp is invalid");
    return formatUtc(date);
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("broker response timestamp is invalid");
  return formatUtc(date);
}

/**
 * `gmdate('c')` parity: second precision with an explicit `+00:00` offset.
 * `Date#toISOString()` gives `…T01:02:03.000Z`; this drops the milliseconds and
 * swaps the `Z`, and nothing else.
 */
function formatUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Normalized account snapshot (legacy `account()`). */
export function normalizeAccount(raw, broker, { now } = {}) {
  if (!isRow(raw)) throw new Error("broker response is invalid");
  const clock = now ?? (() => Date.now());
  const currency = String(phpIsset(raw, "currency") ? raw.currency : "").toUpperCase();
  if (!CURRENCY.test(currency)) throw new Error("broker account currency is invalid");

  const balance = number(raw, "balance");
  const equity = number(raw, "equity");
  const margin = number(raw, "margin", 0);
  // Legacy derived free margin when the bridge did not report it, and floored the
  // derivation at zero so a margin call cannot produce a negative-looking figure.
  const freeMargin = number(raw, "freeMargin", Math.max(0, equity - margin));
  if (balance < 0 || equity < 0 || margin < 0 || freeMargin < 0) {
    throw new Error("broker account values cannot be negative");
  }

  return Object.freeze({
    broker,
    accountId: String(phpIsset(raw, "accountId") ? raw.accountId : (phpIsset(raw, "login") ? raw.login : "")),
    currency,
    balance,
    equity,
    margin,
    freeMargin,
    leverage: number(raw, "leverage", 0),
    timestamp: timestamp(raw.timestamp ?? null, clock),
  });
}

/** Normalized quote (legacy `quote()`). */
export function normalizeQuote(raw, broker, { now } = {}) {
  if (!isRow(raw)) throw new Error("broker response is invalid");
  const clock = now ?? (() => Date.now());
  const symbol = String(phpIsset(raw, "symbol") ? raw.symbol : "").toUpperCase();
  if (!SYMBOL.test(symbol)) throw new Error("broker quote symbol is invalid");

  const bid = number(raw, "bid");
  const ask = number(raw, "ask");
  // `ask < bid` is refused as well as non-positive sides: an inverted quote is a
  // bridge bug, and sizing an order from it would be worse than having no quote.
  if (bid <= 0 || ask <= 0 || ask < bid) throw new Error("broker quote bid/ask is invalid");
  const last = phpIsset(raw, "last") ? number(raw, "last") : (bid + ask) / 2;

  return Object.freeze({
    broker,
    symbol,
    bid,
    ask,
    last,
    spread: ask - bid,
    timestamp: timestamp(raw.timestamp ?? null, clock),
  });
}

/** Normalized open positions (legacy `positions()`). */
export function normalizePositions(raw, broker, { now } = {}) {
  const clock = now ?? (() => Date.now());
  return Object.freeze(rowsOf(raw).map((row) => Object.freeze({
    broker,
    ticket: Math.trunc(number(row, "ticket")),
    symbol: symbolOf(row),
    side: oneOf(row, "side", POSITION_SIDES),
    volume: number(row, "volume"),
    entry: number(row, "entry"),
    stopLoss: optionalNumber(row, "stopLoss"),
    takeProfit: optionalNumber(row, "takeProfit"),
    profit: number(row, "profit", 0),
    openedAt: timestamp(row.openedAt ?? null, clock),
  })));
}

/** Normalized pending orders (legacy `pendingOrders()`). */
export function normalizePendingOrders(raw, broker, { now } = {}) {
  const clock = now ?? (() => Date.now());
  return Object.freeze(rowsOf(raw).map((row) => Object.freeze({
    broker,
    ticket: Math.trunc(number(row, "ticket")),
    symbol: symbolOf(row),
    side: oneOf(row, "side", ORDER_SIDES),
    type: oneOf(row, "type", PENDING_TYPES),
    volume: number(row, "volume"),
    price: number(row, "price"),
    stopLoss: optionalNumber(row, "stopLoss"),
    takeProfit: optionalNumber(row, "takeProfit"),
    placedAt: timestamp(row.placedAt ?? null, clock),
  })));
}

/** Normalized closed trades (legacy `history()`). */
export function normalizeHistory(raw, broker, { now } = {}) {
  const clock = now ?? (() => Date.now());
  return Object.freeze(rowsOf(raw).map((row) => Object.freeze({
    broker,
    ticket: Math.trunc(number(row, "ticket")),
    symbol: symbolOf(row),
    side: oneOf(row, "side", POSITION_SIDES),
    volume: number(row, "volume"),
    entry: number(row, "entry"),
    exit: number(row, "exit"),
    profit: number(row, "profit", 0),
    openedAt: timestamp(row.openedAt ?? null, clock),
    closedAt: timestamp(row.closedAt ?? null, clock),
  })));
}

/**
 * Normalized OHLCV candles (legacy `candles()`).
 *
 * The bridge sends short keys (`o`, `h`, `l`, `c`, `v`, `t`) and this returns
 * long ones — the asymmetry is legacy's and is preserved, because the short form
 * is what the documented bridge contract specifies on the wire.
 */
export function normalizeCandles(raw, broker, { now } = {}) {
  const clock = now ?? (() => Date.now());
  return Object.freeze(rowsOf(raw).map((row) => {
    const open = number(row, "o");
    const close = number(row, "c");
    const high = number(row, "h");
    const low = number(row, "l");
    // A candle whose high is below its low, or whose body sits outside its own
    // range, is not a candle. Refusing it here stops a corrupt series from
    // reaching an indicator or a backtest, where it would only show up as a
    // plausible-looking wrong number.
    if (high < low || high < open || high < close || low > open || low > close) {
      throw new Error("broker candle OHLC relationship is invalid");
    }
    return Object.freeze({
      broker,
      time: timestamp(row.t ?? null, clock),
      open,
      high,
      low,
      close,
      volume: number(row, "v", 0),
    });
  }));
}

/** Normalized order-placement result (legacy `orderResult()`). */
export function normalizeOrderResult(raw, broker, { now } = {}) {
  if (!isRow(raw)) throw new Error("broker response is invalid");
  const clock = now ?? (() => Date.now());
  return Object.freeze({
    broker,
    ticket: Math.trunc(number(raw, "ticket")),
    price: number(raw, "price"),
    placedAt: timestamp(raw.placedAt ?? null, clock),
  });
}

/**
 * Normalized modify/cancel acknowledgement (legacy `ticketResult()`).
 *
 * `confirmed: true` is hard-coded in legacy and stays hard-coded here — but note
 * what that means: the field asserts only that the bridge returned a ticket, not
 * that the exchange accepted the change. Execution step 13's "never trust a bare
 * success" principle is why the supervisor re-reads state afterwards rather than
 * believing this flag.
 */
export function normalizeTicketResult(raw, broker) {
  if (!isRow(raw)) throw new Error("broker response is invalid");
  return Object.freeze({ broker, ticket: Math.trunc(number(raw, "ticket")), confirmed: true });
}

/** Normalized position-close result (legacy `closeResult()`). */
export function normalizeCloseResult(raw, broker, { now } = {}) {
  if (!isRow(raw)) throw new Error("broker response is invalid");
  const clock = now ?? (() => Date.now());
  return Object.freeze({
    broker,
    ticket: Math.trunc(number(raw, "ticket")),
    price: number(raw, "price"),
    profit: number(raw, "profit", 0),
  });
}

/**
 * Legacy `foreach ($raw as $row) { if (!is_array($row)) continue; … }`.
 *
 * Preserved exactly, including the part that is arguably wrong: a row that is not
 * an object is **silently dropped** instead of refusing the whole payload. A
 * bridge that returns `[position, "garbage"]` therefore normalizes to one
 * position. Legacy chose tolerance here and validation everywhere else; changing
 * it would be a behaviour change disguised as a bug fix, so it is recorded as
 * divergence BC-2 instead.
 */
function rowsOf(raw) {
  if (!Array.isArray(raw)) throw new Error("broker response is invalid");
  return raw.filter(isRow);
}

export const BROKER_SYMBOL_PATTERN = SYMBOL;
export const BROKER_CURRENCY_PATTERN = CURRENCY;
