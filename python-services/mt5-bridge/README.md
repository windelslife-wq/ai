# AEGIS MT5 Bridge

Deployable Phase 4 broker bridge: exposes a MetaTrader 5 terminal to the
AEGIS Trade Execution Supervisor (CodeIgniter 3 application) over an
authenticated HTTP contract. **PHP cannot talk to MT5 natively** — this
service runs on the Windows host where the MT5 terminal is installed and uses
the official `MetaTrader5` python package.

```
CodeIgniter app (PHP)  ──HTTP+Bearer──▶  mt5-bridge (FastAPI)  ──▶  MT5 terminal
```

## Status

**IMPLEMENTED, unit-tested against a simulated terminal; NOT verified against
a real MetaTrader 5 account yet.** Before trusting it with money: deploy on a
DEMO account, run the PHP connector tests against it, and only then consider
`MT5_ALLOW_LIVE=1` (which AEGIS additionally gates behind
`AEGIS_MT5_LIVE_ALLOWED=1`).

## Deploy

```powershell
# Windows host with a running, logged-in MT5 terminal (demo account first!)
py -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
set MT5_BRIDGE_TOKEN=<long-random-secret>
set MT5_TRADING_ENABLED=0        # start read-only; flip to 1 to allow orders
set MT5_ALLOW_LIVE=0             # demo accounts only (default)
uvicorn app:app --host 0.0.0.0 --port 8787
```

Then in the AEGIS environment:

```
AEGIS_MT5_BRIDGE_URL=http://<bridge-host>:8787
AEGIS_MT5_BRIDGE_TOKEN=<same secret>
AEGIS_MT5_BRIDGE_ENABLED=1
AEGIS_MT5_TRADING_ENABLED=1     # optional — enables order submission
AEGIS_MT5_LIVE_ALLOWED=0        # demo only (default)
```

Use HTTPS or an isolated network between AEGIS and the bridge — the token is
a shared secret and quotes/accounts cross the wire.

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ok, version, tradingEnabled, accountType}` — no auth |
| GET | `/v1/account` | balance / equity / margin / leverage |
| GET | `/v1/quotes/{SYMBOL}` | bid / ask / timestamp |
| GET | `/v1/candles/{SYMBOL}?tf=1h&limit=500` | OHLCV candles |
| GET | `/v1/positions` | open positions (tickets, SL/TP, P&L) |
| GET | `/v1/orders` | pending orders |
| GET | `/v1/history?limit=100` | closed trades (last 30 days) |
| POST | `/v1/orders` | place MARKET/LIMIT BUY/SELL with SL/TP |
| POST | `/v1/orders/{ticket}/modify` | modify SL/TP (and pending price) |
| POST | `/v1/orders/{ticket}/cancel` | cancel a pending order |
| POST | `/v1/positions/{ticket}/close` | close a position |

Every `/v1/*` call requires `Authorization: Bearer <MT5_BRIDGE_TOKEN>`.
All trading endpoints refuse unless `MT5_TRADING_ENABLED=1` **and** the
account is demo (unless `MT5_ALLOW_LIVE=1`). Every order response carries
`{ok, data:{ticket, price, placedAt}}` or `{ok:false, error}`.

## Tests

`test_bridge.py` exercises the whole contract against a fake terminal —
runnable anywhere python runs (no MT5 needed):

```bash
python -m pytest test_bridge.py -q
```
