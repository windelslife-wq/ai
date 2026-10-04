"""
Contract tests for the AEGIS MT5 bridge against a FAKE terminal.

These verify the bridge's HTTP contract and its safety gates — they do NOT
verify MetaTrader integration itself (that requires a Windows host with a
running demo terminal; see README "Status").

Run: python -m pytest test_bridge.py -q
"""
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

import app as bridge


class FakeMT5:
    TIMEFRAME_M1 = 1; TIMEFRAME_M5 = 5; TIMEFRAME_M15 = 15; TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385; TIMEFRAME_H4 = 16388; TIMEFRAME_D1 = 16408; TIMEFRAME_W1 = 32769
    POSITION_TYPE_BUY = 0; POSITION_TYPE_SELL = 1
    ORDER_TYPE_BUY = 0; ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2; ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4; ORDER_TYPE_SELL_STOP = 5
    DEAL_TYPE_BUY = 0; DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0; DEAL_ENTRY_OUT = 1
    TRADE_ACTION_DEAL = 1; TRADE_ACTION_PENDING = 5; TRADE_ACTION_SLTP = 6
    TRADE_ACTION_MODIFY = 7; TRADE_ACTION_REMOVE = 8
    TRADE_RETCODE_DONE = 10009

    def __init__(self):
        self.trade_mode = 0  # demo
        self.sent = []
        self.next_ticket = 7001
        self._position = NS(ticket=5001, symbol="EURUSD", type=0, volume=0.5,
                            price_open=1.0800, sl=1.0750, tp=1.0900, profit=12.5, time=1755900000)
        self._pending = NS(ticket=6001, symbol="XAUUSD", type=2, volume=0.1,
                           volume_current=0.1, price_open=2350.0, sl=2340.0, tp=2380.0, time_setup=1755900000)

    def initialize(self):
        return True

    def account_info(self):
        return NS(login=1234567, currency="USD", balance=10000.0, equity=10012.5,
                  margin=50.0, margin_free=9962.5, leverage=100, trade_mode=self.trade_mode)

    def symbol_info_tick(self, symbol):
        return NS(bid=1.08000, ask=1.08012, time=1755900060)

    def symbol_select(self, symbol, enable):
        return True

    def copy_rates_from_pos(self, symbol, tf, start, count):
        return [
            {"time": 1755900000, "open": 1.0800, "high": 1.0810, "low": 1.0795, "close": 1.0808, "tick_volume": 120},
            {"time": 1755903600, "open": 1.0808, "high": 1.0820, "low": 1.0805, "close": 1.0815, "tick_volume": 98},
        ]

    def positions_get(self):
        return [self._position] if self._position else []

    def orders_get(self):
        return [self._pending] if self._pending else []

    def history_deals_get(self, start, end):
        return [
            NS(ticket=1, order=1, position_id=5001, symbol="EURUSD", type=0, entry=0, volume=0.5, price=1.0800, profit=0.0, time=1755800000),
            NS(ticket=2, order=2, position_id=5001, symbol="EURUSD", type=1, entry=1, volume=0.5, price=1.0840, profit=20.0, time=1755800600),
        ]

    def order_send(self, request):
        self.sent.append(request)
        return NS(retcode=self.TRADE_RETCODE_DONE, order=self.next_ticket, price=request.get("price", 0.0), comment="")


@pytest.fixture()
def client(monkeypatch):
    fake = FakeMT5()
    bridge.set_terminal(fake)
    monkeypatch.setattr(bridge, "TOKEN", "test-token")
    monkeypatch.setattr(bridge, "TRADING_ENABLED", False)
    monkeypatch.setattr(bridge, "ALLOW_LIVE", False)
    return TestClient(bridge.app), fake


def auth(client):
    return {"Authorization": "Bearer test-token"}


def test_health_reports_demo_and_trading_disabled(client):
    http, _ = client
    r = http.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["accountType"] == "demo"
    assert body["tradingEnabled"] is False


def test_account_requires_token(client):
    http, _ = client
    assert http.get("/v1/account").status_code == 401
    assert http.get("/v1/account", headers={"Authorization": "Bearer wrong"}).status_code == 401
    body = http.get("/v1/account", headers=auth(client)).json()
    assert body["ok"] is True
    assert body["data"]["freeMargin"] == pytest.approx(9962.5)


def test_quote_contract(client):
    http, _ = client
    data = http.get("/v1/quotes/eurusd", headers=auth(client)).json()["data"]
    assert data["symbol"] == "EURUSD"
    assert data["ask"] > data["bid"] > 0


def test_positions_orders_history_contracts(client):
    http, _ = client
    pos = http.get("/v1/positions", headers=auth(client)).json()["data"]
    assert pos[0]["side"] == "LONG" and pos[0]["stopLoss"] == 1.0750
    orders = http.get("/v1/orders", headers=auth(client)).json()["data"]
    assert orders[0]["type"] == "LIMIT" and orders[0]["side"] == "BUY"
    hist = http.get("/v1/history", headers=auth(client)).json()["data"]
    assert hist[0]["exit"] == 1.0840 and hist[0]["profit"] == 20.0


def test_orders_refused_without_trading_flag(client):
    http, _ = client
    r = http.post("/v1/orders", headers=auth(client),
                  json={"action": "BUY", "type": "MARKET", "symbol": "EURUSD", "volume": 0.1, "stopLoss": 1.07})
    assert r.status_code == 403


def test_market_order_placed_on_demo_when_trading_enabled(client, monkeypatch):
    http, fake = client
    monkeypatch.setattr(bridge, "TRADING_ENABLED", True)
    r = http.post("/v1/orders", headers=auth(client),
                  json={"action": "BUY", "type": "MARKET", "symbol": "EURUSD", "volume": 0.1,
                        "stopLoss": 1.0750, "takeProfit": 1.0900})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["data"]["ticket"] > 0
    sent = fake.sent[0]
    assert sent["type"] == fake.ORDER_TYPE_BUY and sent["sl"] == 1.0750


def test_live_account_refused_without_allow_live(client, monkeypatch):
    http, fake = client
    monkeypatch.setattr(bridge, "TRADING_ENABLED", True)
    fake.trade_mode = 2  # real account
    r = http.post("/v1/orders", headers=auth(client),
                  json={"action": "BUY", "type": "MARKET", "symbol": "EURUSD", "volume": 0.1, "stopLoss": 1.07})
    assert r.status_code == 403
    # and the same call succeeds when live is explicitly allowed
    monkeypatch.setattr(bridge, "ALLOW_LIVE", True)
    r = http.post("/v1/orders", headers=auth(client),
                  json={"action": "BUY", "type": "MARKET", "symbol": "EURUSD", "volume": 0.1, "stopLoss": 1.07})
    assert r.json()["ok"] is True


def test_limit_order_requires_price(client, monkeypatch):
    http, _ = client
    monkeypatch.setattr(bridge, "TRADING_ENABLED", True)
    r = http.post("/v1/orders", headers=auth(client),
                  json={"action": "BUY", "type": "LIMIT", "symbol": "EURUSD", "volume": 0.1, "stopLoss": 1.07})
    assert r.status_code == 400


def test_modify_cancel_close(client, monkeypatch):
    http, fake = client
    monkeypatch.setattr(bridge, "TRADING_ENABLED", True)
    r = http.post("/v1/orders/5001/modify", headers=auth(client), json={"stopLoss": 1.0700})
    assert r.json()["ok"] is True
    assert fake.sent[0]["action"] == fake.TRADE_ACTION_SLTP and fake.sent[0]["sl"] == 1.0700

    r = http.post("/v1/orders/6001/cancel", headers=auth(client))
    assert r.json()["ok"] is True
    assert fake.sent[1]["action"] == fake.TRADE_ACTION_REMOVE

    r = http.post("/v1/positions/5001/close", headers=auth(client))
    assert r.json()["ok"] is True
    assert r.json()["data"]["ticket"] == 5001

    assert http.post("/v1/positions/9999/close", headers=auth(client)).status_code == 404
