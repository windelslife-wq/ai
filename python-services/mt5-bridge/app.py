"""
AEGIS MT5 Bridge — Phase 4 broker service.

A small FastAPI service that exposes a MetaTrader 5 terminal (via the
MetaTrader5 python package) to the AEGIS Trade Execution Supervisor over an
authenticated HTTP contract. Deploy it on the Windows host that runs the MT5
terminal; point AEGIS at it with:

    AEGIS_MT5_BRIDGE_URL=http://<host>:8787
    AEGIS_MT5_BRIDGE_TOKEN=<shared secret>
    AEGIS_MT5_BRIDGE_ENABLED=1
    AEGIS_MT5_TRADING_ENABLED=1     # only when order submission is wanted
    AEGIS_MT5_LIVE_ALLOWED=0        # demo accounts only (default)

Bridge safety flags (this service):
    MT5_BRIDGE_TOKEN   required — every /v1/* call must carry it as a Bearer token
    MT5_TRADING_ENABLED  default 0 — POST/DELETE endpoints refuse to trade when 0
    MT5_ALLOW_LIVE       default 0 — orders on non-demo accounts are refused when 0

The `mt5` module is imported lazily so the contract layer can be unit-tested
without a terminal (tests inject a fake through `set_terminal`).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

BRIDGE_VERSION = "1.0.0"
TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "")
TRADING_ENABLED = os.environ.get("MT5_TRADING_ENABLED", "0") == "1"
ALLOW_LIVE = os.environ.get("MT5_ALLOW_LIVE", "0") == "1"

app = FastAPI(title="AEGIS MT5 Bridge", version=BRIDGE_VERSION)

_terminal: Any = None  # the MetaTrader5 module (or a test fake)


def set_terminal(fake: Any) -> None:
    """Inject a terminal implementation (used by tests)."""
    global _terminal
    _terminal = fake


def terminal() -> Any:
    global _terminal
    if _terminal is None:
        import MetaTrader5 as mt5  # noqa: N813 — lazy on purpose
        _terminal = mt5
    return _terminal


def ensure_initialized() -> None:
    mt5 = terminal()
    if not mt5.initialize():
        raise HTTPException(status_code=503, detail="MT5 terminal is not available")


def iso(ts: Optional[int]) -> str:
    if not ts:
        return datetime.now(timezone.utc).isoformat()
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def require_token(authorization: str) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="bridge token is not configured (MT5_BRIDGE_TOKEN)")
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="invalid or missing bridge token")


def require_trading() -> None:
    ensure_initialized()
    mt5 = terminal()
    if not TRADING_ENABLED:
        raise HTTPException(status_code=403, detail="MT5_TRADING_ENABLED is not 1 — trading is disabled on this bridge")
    info = mt5.account_info()
    if info is None:
        raise HTTPException(status_code=503, detail="MT5 account info unavailable")
    # trade_mode: 0 demo, 1 contest, 2 real
    account_type = ("demo", "contest", "live")[info.trade_mode] if info.trade_mode in (0, 1, 2) else "unknown"
    if not ALLOW_LIVE and account_type != "demo":
        raise HTTPException(status_code=403, detail=f"bridge is on a '{account_type}' account — demo only unless MT5_ALLOW_LIVE=1")


def account_type() -> str:
    info = terminal().account_info()
    if info is None or info.trade_mode not in (0, 1, 2):
        return "unknown"
    return ("demo", "contest", "live")[info.trade_mode]


TIMEFRAMES: dict[str, int] = {}  # filled after import; resolved via mt5 constants


def timeframe_code(tf: str, mt5: Any) -> int:
    mapping = {
        "1m": mt5.TIMEFRAME_M1, "5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15, "30m": mt5.TIMEFRAME_M30,
        "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4, "1d": mt5.TIMEFRAME_D1, "1w": mt5.TIMEFRAME_W1,
    }
    if tf not in mapping:
        raise HTTPException(status_code=400, detail=f"unsupported timeframe {tf}")
    return mapping[tf]


class OrderIn(BaseModel):
    action: str = Field(..., pattern="^(BUY|SELL)$")
    type: str = Field(..., pattern="^(MARKET|LIMIT)$")
    symbol: str = Field(..., min_length=1, max_length=32)
    volume: float = Field(..., gt=0)
    price: Optional[float] = None
    stopLoss: Optional[float] = None
    takeProfit: Optional[float] = None


class ModifyIn(BaseModel):
    stopLoss: Optional[float] = None
    takeProfit: Optional[float] = None
    price: Optional[float] = None


@app.get("/health")
def health() -> dict:
    try:
        ensure_initialized()
        mt5 = terminal()
        info = mt5.account_info()
        return {
            "ok": info is not None,
            "version": BRIDGE_VERSION,
            "tradingEnabled": TRADING_ENABLED and info is not None,
            "accountType": account_type() if info is not None else "unknown",
        }
    except HTTPException:
        return {"ok": False, "version": BRIDGE_VERSION, "tradingEnabled": False, "accountType": "unknown"}


@app.get("/v1/account")
def account(authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    info = terminal().account_info()
    if info is None:
        raise HTTPException(status_code=503, detail="account info unavailable")
    return {"ok": True, "data": {
        "accountId": str(info.login), "currency": info.currency,
        "balance": float(info.balance), "equity": float(info.equity),
        "margin": float(info.margin), "freeMargin": float(info.margin_free),
        "leverage": float(info.leverage), "timestamp": iso(None),
    }}


@app.get("/v1/quotes/{symbol}")
def quote(symbol: str, authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    tick = terminal().symbol_info_tick(symbol)
    if tick is None:
        raise HTTPException(status_code=404, detail=f"symbol {symbol} not available")
    return {"ok": True, "data": {
        "symbol": symbol.upper(), "bid": float(tick.bid), "ask": float(tick.ask),
        "timestamp": iso(getattr(tick, "time", None)),
    }}


@app.get("/v1/candles/{symbol}")
def candles(symbol: str, tf: str = "1h", limit: int = Query(default=500, ge=10, le=1000),
            authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    mt5 = terminal()
    rates = mt5.copy_rates_from_pos(symbol, timeframe_code(tf, mt5), 0, limit)
    if rates is None:
        raise HTTPException(status_code=404, detail=f"candles for {symbol} unavailable")
    data = [{
        "t": iso(int(r["time"])), "o": float(r["open"]), "h": float(r["high"]),
        "l": float(r["low"]), "c": float(r["close"]), "v": float(r["tick_volume"]),
    } for r in rates]
    return {"ok": True, "data": data}


@app.get("/v1/positions")
def positions(authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    mt5 = terminal()
    data = []
    for p in mt5.positions_get() or []:
        data.append({
            "ticket": int(p.ticket), "symbol": p.symbol, "side": "LONG" if p.type == mt5.POSITION_TYPE_BUY else "SHORT",
            "volume": float(p.volume), "entry": float(p.price_open),
            "stopLoss": float(p.sl) if p.sl else None, "takeProfit": float(p.tp) if p.tp else None,
            "profit": float(p.profit), "openedAt": iso(int(p.time)),
        })
    return {"ok": True, "data": data}


@app.get("/v1/orders")
def orders(authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    mt5 = terminal()
    data = []
    for o in mt5.orders_get() or []:
        otype = "LIMIT" if o.type == mt5.ORDER_TYPE_BUY_LIMIT or o.type == mt5.ORDER_TYPE_SELL_LIMIT else "STOP"
        data.append({
            "ticket": int(o.ticket), "symbol": o.symbol,
            "side": "BUY" if o.type in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP) else "SELL",
            "type": otype, "volume": float(o.volume_current), "price": float(o.price_open),
            "stopLoss": float(o.sl) if o.sl else None, "takeProfit": float(o.tp) if o.tp else None,
            "placedAt": iso(int(o.time_setup)),
        })
    return {"ok": True, "data": data}


@app.get("/v1/history")
def history(limit: int = Query(default=100, ge=1, le=500), authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    ensure_initialized()
    from datetime import timedelta
    mt5 = terminal()
    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=30)
    deals = mt5.history_deals_get(start, end) or []
    # Rebuild closed trades from exit deals (entry-out)
    entries: dict[int, dict] = {}
    data = []
    for d in sorted(deals, key=lambda d: d.time):
        if d.entry != mt5.DEAL_ENTRY_OUT:
            if d.entry == mt5.DEAL_ENTRY_IN:
                entries[d.position_id] = {
                    "ticket": int(d.position_id), "symbol": d.symbol,
                    "side": "LONG" if d.type == mt5.DEAL_TYPE_BUY else "SHORT",
                    "volume": float(d.volume), "entry": float(d.price),
                    "openedAt": iso(int(d.time)), "exit": 0.0, "profit": 0.0, "closedAt": iso(int(d.time)),
                }
            continue
        base = entries.get(d.position_id)
        trade = base or {"ticket": int(d.position_id), "symbol": d.symbol, "side": "SHORT",
                         "volume": float(d.volume), "entry": 0.0, "openedAt": iso(int(d.time))}
        data.append({
            "ticket": trade["ticket"], "symbol": d.symbol, "side": trade["side"],
            "volume": trade["volume"], "entry": trade.get("entry", 0.0), "exit": float(d.price),
            "profit": float(d.profit), "openedAt": trade["openedAt"], "closedAt": iso(int(d.time)),
        })
    return {"ok": True, "data": list(reversed(data))[:limit]}


@app.post("/v1/orders")
def place_order(order: OrderIn, authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    require_trading()
    mt5 = terminal()
    if order.type == "LIMIT" and (order.price is None or order.price <= 0):
        raise HTTPException(status_code=400, detail="LIMIT orders require a positive price")
    if not mt5.symbol_select(order.symbol, True):
        raise HTTPException(status_code=400, detail=f"symbol {order.symbol} is not available")
    tick = mt5.symbol_info_tick(order.symbol)
    if tick is None:
        raise HTTPException(status_code=400, detail=f"symbol {order.symbol} has no quotes")

    request: dict[str, Any] = {
        "action": mt5.TRADE_ACTION_DEAL if order.type == "MARKET" else mt5.TRADE_ACTION_PENDING,
        "symbol": order.symbol,
        "volume": float(order.volume),
        "type": (mt5.ORDER_TYPE_BUY if order.action == "BUY" else mt5.ORDER_TYPE_SELL) if order.type == "MARKET"
        else (mt5.ORDER_TYPE_BUY_LIMIT if order.action == "BUY" else mt5.ORDER_TYPE_SELL_LIMIT),
        "sl": float(order.stopLoss) if order.stopLoss else 0.0,
        "tp": float(order.takeProfit) if order.takeProfit else 0.0,
        "deviation": 10,
        "magic": 20260823,
        "comment": "AEGIS supervisor",
    }
    if order.type == "MARKET":
        request["price"] = float(tick.ask if order.action == "BUY" else tick.bid)
    else:
        request["price"] = float(order.price)

    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        detail = f"order_send failed: {getattr(result, 'retcode', 'none')} {getattr(result, 'comment', '')}"
        return {"ok": False, "error": detail}
    fill_price = float(result.price) if getattr(result, "price", 0) else request["price"]
    return {"ok": True, "data": {"ticket": int(result.order), "price": fill_price, "placedAt": iso(None)}}


@app.post("/v1/orders/{ticket}/modify")
def modify_order(ticket: int, changes: ModifyIn, authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    require_trading()
    mt5 = terminal()
    position = next((p for p in mt5.positions_get() or [] if p.ticket == ticket), None)
    pending = next((o for o in mt5.orders_get() or [] if o.ticket == ticket), None)
    if position is not None:
        request = {
            "action": mt5.TRADE_ACTION_SLTP, "symbol": position.symbol, "position": ticket,
            "sl": float(changes.stopLoss) if changes.stopLoss is not None else float(position.sl),
            "tp": float(changes.takeProfit) if changes.takeProfit is not None else float(position.tp),
        }
    elif pending is not None:
        request = {
            "action": mt5.TRADE_ACTION_MODIFY, "symbol": pending.symbol, "order": ticket,
            "sl": float(changes.stopLoss) if changes.stopLoss is not None else float(pending.sl),
            "tp": float(changes.takeProfit) if changes.takeProfit is not None else float(pending.tp),
        }
        if changes.price is not None and changes.price > 0:
            request["price"] = float(changes.price)
        else:
            request["price"] = float(pending.price_open)
    else:
        raise HTTPException(status_code=404, detail=f"ticket {ticket} is neither a position nor a pending order")
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"modify failed: {getattr(result, 'retcode', 'none')} {getattr(result, 'comment', '')}"}
    return {"ok": True, "data": {"ticket": ticket}}


@app.post("/v1/orders/{ticket}/cancel")
def cancel_order(ticket: int, authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    require_trading()
    mt5 = terminal()
    pending = next((o for o in mt5.orders_get() or [] if o.ticket == ticket), None)
    if pending is None:
        raise HTTPException(status_code=404, detail=f"pending order {ticket} not found")
    request = {
        "action": mt5.TRADE_ACTION_REMOVE, "order": ticket,
    }
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"cancel failed: {getattr(result, 'retcode', 'none')}"}
    return {"ok": True, "data": {"ticket": ticket}}


@app.post("/v1/positions/{ticket}/close")
def close_position(ticket: int, authorization: str = Header(default="")) -> dict:
    require_token(authorization)
    require_trading()
    mt5 = terminal()
    position = next((p for p in mt5.positions_get() or [] if p.ticket == ticket), None)
    if position is None:
        raise HTTPException(status_code=404, detail=f"position {ticket} not found")
    tick = mt5.symbol_info_tick(position.symbol)
    is_long = position.type == mt5.POSITION_TYPE_BUY
    request = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": position.symbol, "position": ticket,
        "volume": float(position.volume),
        "type": mt5.ORDER_TYPE_SELL if is_long else mt5.ORDER_TYPE_BUY,
        "price": float(tick.bid if is_long else tick.ask),
        "deviation": 10, "magic": 20260823, "comment": "AEGIS supervisor close",
    }
    result = mt5.order_send(request)
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"ok": False, "error": f"close failed: {getattr(result, 'retcode', 'none')} {getattr(result, 'comment', '')}"}
    return {"ok": True, "data": {"ticket": ticket, "price": float(result.price), "profit": float(position.profit)}}
