import assert from "node:assert/strict";
import { test } from "node:test";

import { createTradingConnector } from "../src/modules/brokers/connector.js";
import { createSimulatedMt5Bridge } from "../src/modules/brokers/simulator.js";

function connectorFor(bridge, { ordersEnabled = false, now = () => Date.parse("2026-10-18T12:00:00Z") } = {}) {
  return createTradingConnector({
    id: "test-simulator",
    displayName: "Test simulator",
    url: "http://in-process-simulator.invalid",
    token: "never-sent",
    enabled: true,
    tradingEnabled: ordersEnabled,
    liveAllowed: false,
    transport: bridge.transport,
    now,
  });
}

test("the simulator serves normalized demo account, quote, candles, positions and history without a socket", async () => {
  const now = () => Date.parse("2026-10-18T12:00:00Z");
  const bridge = createSimulatedMt5Bridge({ now, initialBalance: 25_000, accountId: "SIM-TEST" });
  const connector = connectorFor(bridge, { now });

  const status = await connector.status();
  assert.equal(status.state, "READY");
  assert.equal(status.simulated, true);
  assert.equal(status.accountType, "demo");
  assert.equal(status.orderSubmissionEffective, false);

  assert.deepEqual(await connector.account(), {
    broker: "test-simulator",
    accountId: "SIM-TEST",
    currency: "USD",
    balance: 25_000,
    equity: 25_000,
    margin: 0,
    freeMargin: 25_000,
    leverage: 30,
    timestamp: "2026-10-18T12:00:00+00:00",
  });
  const quote = await connector.quote("eurusd");
  assert.equal(quote.symbol, "EURUSD");
  assert.equal(quote.bid, 1.075);
  assert.equal(quote.ask, 1.0752);
  assert.equal(quote.last, 1.0751);
  assert.equal(quote.timestamp, "2026-10-18T12:00:00+00:00");

  const candles = await connector.candles("EURUSD", "1h", 12);
  assert.equal(candles.length, 12);
  assert.ok(candles.every((candle) => candle.high >= Math.max(candle.open, candle.close)));
  assert.deepEqual(await connector.positions(), []);
  assert.deepEqual(await connector.pendingOrders(), []);
  assert.deepEqual(await connector.history(), []);
  assert.equal(bridge.state.account.balance, 25_000);
});

test("orders stay refused unless the simulator's separate order flag is enabled", async () => {
  const bridge = createSimulatedMt5Bridge();
  const connector = connectorFor(bridge);
  await assert.rejects(
    connector.placeOrder({ symbol: "EURUSD", side: "BUY", volume: 0.1, stopLoss: 1.07, takeProfit: 1.09 }),
    /order submission is disabled/,
  );
  assert.deepEqual(bridge.state.positions, []);
});

test("the enabled simulator fills, verifies, modifies and closes a market order in memory", async () => {
  const now = () => Date.parse("2026-10-18T12:00:00Z");
  const bridge = createSimulatedMt5Bridge({ now, ordersEnabled: true });
  const connector = connectorFor(bridge, { now, ordersEnabled: true });
  assert.equal((await connector.status()).orderSubmissionEffective, true);

  const placed = await connector.placeOrder({
    symbol: "EURUSD",
    side: "BUY",
    type: "MARKET",
    volume: 0.1,
    stopLoss: 1.07,
    takeProfit: 1.09,
  });
  assert.equal(placed.broker, "test-simulator");
  assert.equal(placed.price, 1.0752);
  const positions = await connector.positions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].ticket, placed.ticket);
  assert.equal(positions[0].side, "LONG");
  assert.equal(positions[0].entry, 1.0752);
  assert.equal(positions[0].stopLoss, 1.07);

  const modified = await connector.modifyOrder(placed.ticket, { stopLoss: 1.071 });
  assert.equal(modified.confirmed, true);
  assert.equal((await connector.positions())[0].stopLoss, 1.071);

  const closed = await connector.closePosition(placed.ticket);
  assert.equal(closed.ticket, placed.ticket);
  assert.equal(closed.price, 1.075);
  assert.equal((await connector.positions()).length, 0);
  assert.equal((await connector.history()).length, 1);
  assert.equal((await connector.history())[0].side, "LONG");
  assert.equal(bridge.state.account.accountId, "SIM-0001");
});

test("pending simulator orders can be listed and cancelled; duplicate-symbol orders are refused", async () => {
  const bridge = createSimulatedMt5Bridge({ ordersEnabled: true });
  const connector = connectorFor(bridge, { ordersEnabled: true });
  const pending = await connector.placeOrder({
    symbol: "EURUSD",
    side: "BUY",
    type: "LIMIT",
    volume: 0.1,
    price: 1.07,
    stopLoss: 1.06,
    takeProfit: 1.09,
  });
  const orders = await connector.pendingOrders();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].type, "LIMIT");
  assert.equal(orders[0].price, 1.07);
  await assert.rejects(
    connector.placeOrder({ symbol: "EURUSD", side: "SELL", volume: 0.1, stopLoss: 1.08, takeProfit: 1.06 }),
    /already has a position or pending order/,
  );
  assert.equal((await connector.cancelOrder(pending.ticket)).confirmed, true);
  assert.deepEqual(await connector.pendingOrders(), []);
});
