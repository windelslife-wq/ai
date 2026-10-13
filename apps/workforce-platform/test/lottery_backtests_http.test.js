/**
 * The slice-4 HTTP surface: the Strategy Lab and the performance overview, on
 * the file adapter, with legacy's permission shape pinned exactly — the whole
 * measured half is `lottery.view` (analysis records are not managed ingestion),
 * so a viewer-only user can run a backtest; only probe/sync/system-build need
 * `lottery.manage`.
 *
 * Honesty contract, pinned over the wire: reports are labelled HISTORICAL
 * SIMULATION, simulated cost/winnings are null with their notes, the random
 * baseline is mandatory in every comparison, and the performance overview's
 * ACTUAL / HISTORICAL / DEMO sections never mix.
 */

import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken };
}

function sandboxApp(t) {
  return createFileStoreApp({ configOverrides: { env: { WINDELS_LOTTERY_SANDBOX: "1" } } });
}

/** Seed deterministic VERIFIED draws (the same shape the golden's history has). */
async function seedDraws(store, count, { offset = 0 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const day = ((offset + i) % 28) + 1;
    const seed = 1000 + (offset + i) * 7;
    const mains = [(seed * 3) % 50 + 1, (seed * 7) % 50 + 1, (seed * 11) % 50 + 1, (seed * 13) % 50 + 1, (seed * 17) % 50 + 1];
    const stars = [(seed % 12) + 1, ((seed * 5) % 12) + 1];
    await store.saveLotteryDraw({
      lotteryCode: "EUROMILLIONS",
      providerId: 1,
      externalId: `SIM-2026-01-${String(day).padStart(2, "0")}-${offset}`,
      drawDate: `2026-01-${String(day).padStart(2, "0")}`,
      jackpot: "10000000.00",
      rollover: false,
      source: "sandbox-simulation",
      sourceTimestamp: `2026-01-${String(day).padStart(2, "0")}T21:00:00+00:00`,
      verificationStatus: "VERIFIED",
      payload: { main: [...new Set(mains)].slice(0, 5), stars: [...new Set(stars)], source: "sandbox-simulation" },
    });
  }
}

test("the Strategy Lab over the wire: run, compare, list, detail, models — and the refusals", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);
  await seedDraws(instance.store, 15);

  const run = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/backtest", headers,
    payload: { strategy: "RANDOM_BASELINE", lines: 2, window: 5 },
  });
  assert.equal(run.statusCode, 200, run.body);
  const report = run.json();
  assert.equal(report.label, "HISTORICAL SIMULATION");
  assert.equal(report.strategy, "RANDOM_BASELINE");
  assert.equal(report.period.drawsTested, 5);
  assert.equal(report.period.windowCap, 100);
  assert.equal(report.totalLines, 10);
  assert.equal(report.simulatedCost, null, "no cost is fabricated");
  assert.match(report.costNote, /no cost is fabricated/);
  assert.equal(report.simulatedWinnings, null);
  assert.match(report.note, /without look-ahead/);
  assert.equal(report.saved.backtestId, 1);

  // The refusals are legacy's strings at the 400 layer.
  const unknown = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/backtest", headers, payload: { strategy: "MARTINGALE" } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error.message, "unknown strategy: MARTINGALE (expected RANDOM_BASELINE, BALANCED_PROFILE, HISTORICAL_FREQ, ANTI_POPULAR)");

  // The comparison: dedup + uppercase + baseline mandatory; persisted under COMPARISON.
  const compare = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/backtest-compare", headers,
    payload: { strategies: ["random_baseline", "ANTI_POPULAR", "RANDOM_BASELINE"] },
  });
  assert.equal(compare.statusCode, 200, compare.body);
  assert.equal(compare.json().label, "HISTORICAL SIMULATION — strategy comparison");
  assert.deepEqual(compare.json().strategies.map((s) => s.strategy), ["RANDOM_BASELINE", "ANTI_POPULAR"]);
  assert.equal(compare.json().saved.backtestId, 2);

  const noBaseline = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/backtest-compare", headers,
    payload: { strategies: ["BALANCED_PROFILE"] },
  });
  assert.equal(noBaseline.statusCode, 400);
  assert.equal(noBaseline.json().error.message, "the random baseline must be part of every comparison (spec §25)");
  const emptyCompare = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/backtest-compare", headers, payload: { strategies: [] } });
  assert.equal(emptyCompare.statusCode, 400);
  assert.equal(emptyCompare.json().error.message, "at least one strategy is required");

  // Persisted rows: newest first, report decoded on detail, 404 for the missing.
  const list = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/backtests?limit=1", headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().backtests.length, 1);
  assert.equal(list.json().backtests[0].strategy, "COMPARISON");
  const detail = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/backtests/1", headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().backtest.report.label, "HISTORICAL SIMULATION", "the stored report reads back decoded");
  assert.equal(detail.json().backtest.dataset_version, "n=15;last=2026-01-15");
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/lottery/backtests/999", headers })).statusCode, 404);
  const missing = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/backtests/999", headers });
  assert.equal(missing.json().error.message, "backtest not found");

  // Models: the ensure ran inside every backtest; exactly one row exists.
  const models = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/models", headers });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(models.json().models.map((m) => m.model_version), ["1.0"]);
  assert.deepEqual(models.json().models[0].config.backtester, { minHistory: 10, maxWindow: 100, maxLines: 10 });

  const audits = await instance.store.listAuditEvents({ limit: 100, action: "lottery.backtest.run" });
  assert.equal(audits.events.length, 2, "every persisted run is audited");
});

test("insufficient history is a 400 naming the count, and a viewer-only user can run the Lab", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  await seedDraws(instance.store, 8);

  const viewerRole = await instance.store.ensureRole("lottery_viewer_bt", "Lottery viewer");
  const view = await instance.store.ensurePermission("lottery.view", "Read lottery intelligence");
  await instance.store.grantRolePermission(viewerRole.id, view.id);
  const viewer = await instance.store.createUser({
    username: "btviewer",
    email: "btviewer@example.test",
    passwordHash: await bcrypt.hash("Backtest viewer phrase", 4),
    displayName: "Backtest Viewer",
  });
  await instance.store.assignRole(viewer.id, viewerRole.id);
  const login = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "btviewer", password: "Backtest viewer phrase" } });
  const headers = { cookie: cookieFrom(login), "x-csrf-token": login.json().csrfToken };

  const short = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/backtest", headers, payload: { strategy: "RANDOM_BASELINE" } });
  assert.equal(short.statusCode, 400);
  assert.equal(short.json().error.message, "backtesting needs at least 11 stored draws (got 8)");

  // History arrives; the same viewer runs the Lab.
  await seedDraws(instance.store, 7, { offset: 8 });
  const run = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/backtest", headers, payload: { strategy: "ANTI_POPULAR" } });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().label, "HISTORICAL SIMULATION");
});

test("the performance overview keeps ACTUAL, HISTORICAL and DEMO separate", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);
  // Draw 15 draws; the LAST one exactly matches the ticket below (TIER_1).
  await seedDraws(instance.store, 14);
  await instance.store.saveLotteryDraw({
    lotteryCode: "EUROMILLIONS",
    providerId: 1,
    externalId: "SIM-2026-01-15-match",
    drawDate: "2026-01-15",
    jackpot: "10000000.00",
    rollover: false,
    source: "sandbox-simulation",
    sourceTimestamp: "2026-01-15T21:00:00+00:00",
    verificationStatus: "VERIFIED",
    payload: { main: [1, 2, 3, 4, 5], stars: [2, 5], source: "sandbox-simulation" },
  });

  const ticket = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/tickets", headers,
    payload: { name: "The straight five", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }], drawDate: "2026-01-15" },
  });
  assert.equal(ticket.statusCode, 200, ticket.body);
  const checked = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/1/check", headers, payload: {} });
  assert.equal(checked.statusCode, 200, checked.body);
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/backtest", headers, payload: { strategy: "RANDOM_BASELINE", window: 3 } });

  const performance = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/performance", headers });
  assert.equal(performance.statusCode, 200, performance.body);
  const body = performance.json();
  assert.match(body.label, /sections are separate and never mixed/);
  assert.equal(body.actualTicketResults.section, "ACTUAL TICKET RESULTS");
  assert.equal(body.actualTicketResults.ticketsTotal, 1);
  assert.equal(body.actualTicketResults.ticketsChecked, 1);
  assert.equal(body.actualTicketResults.linesChecked, 1);
  assert.deepEqual(body.actualTicketResults.byTier, { "TIER_1 (5 mains + 2 stars)": 1 });
  assert.match(body.actualTicketResults.note, /official amounts are never stored/);
  assert.equal(body.historicalBacktestResults.section, "HISTORICAL BACKTEST RESULTS");
  assert.equal(body.historicalBacktestResults.count, 1);
  assert.equal(body.historicalBacktestResults.recent[0].strategy, "RANDOM_BASELINE");
  assert.equal(body.demoSandboxData.section, "DEMO / SANDBOX DATA");
  assert.equal(body.demoSandboxData.drawsTracked, 15);
  assert.equal(body.demoSandboxData.synthetic, true, "the double-gated sandbox is labelled synthetic, never official");
  assert.match(body.separationNote, /never mixed/);
  assert.match(body.disclaimer, /independent random events/);

  // An empty overview still holds the PHP shape: an empty tier map is [].
  const other = await sandboxApp(t);
  t.after(() => other.cleanup());
  const otherHeaders = await signIn(other.app);
  const empty = await other.app.inject({ method: "GET", url: "/api/v1/lottery/performance", headers: otherHeaders });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().actualTicketResults.byTier, []);
});

test("an anonymous caller gets nothing from the measured half", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  for (const [method, url] of [
    ["POST", "/api/v1/lottery/backtest"],
    ["POST", "/api/v1/lottery/backtest-compare"],
    ["GET", "/api/v1/lottery/backtests"],
    ["GET", "/api/v1/lottery/backtests/1"],
    ["GET", "/api/v1/lottery/models"],
    ["GET", "/api/v1/lottery/performance"],
  ]) {
    const response = await instance.app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});
