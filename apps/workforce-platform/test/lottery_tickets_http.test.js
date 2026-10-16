/**
 * The slice-3 HTTP surface: the ticket record and its lifecycle over the file
 * adapter, with legacy's permission shape pinned exactly:
 *
 *   - list / create / check / archive:  `lottery.view` (a user manages their
 *     OWN records; checking is an analysis of their lines against stored draws)
 *   - detail:                            `lottery.view`, and an actor holding
 *     `lottery.manage` sees ANY ticket (legacy's `identity->can` branch)
 *
 * A ticket on this platform is a record of number lines — never a purchase.
 * Checking reports official prize-tier LABELS; no amount appears anywhere.
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

test("the ticket lifecycle: create (validated), list own, check against the stored draw, archive", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers, payload: { limit: 6 } });
  const targetDraw = (await instance.store.listLotteryDraws({ lotteryCode: "EUROMILLIONS" }, 1))[0];
  assert.ok(targetDraw, "the explicit sandbox sync stores a draw");
  assert.equal(targetDraw.verification_status, "VERIFIED");

  // Build an exact-match line from the stored draw, not from a clock-sensitive
  // hard-coded PRNG position: the sandbox walks backwards from the current date.
  const created = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lottery/tickets",
    headers,
    payload: {
      name: "My week",
      lines: [{ mains: [...targetDraw.payload.main].reverse(), stars: [...targetDraw.payload.stars].reverse() }],
      drawDate: targetDraw.draw_date,
      configuration: { note: "the big one" },
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const ticket = created.json().ticket;
  assert.equal(ticket.name, "My week");
  assert.equal(ticket.status, "OPEN");
  assert.deepEqual(ticket.lines[0].mains, [...targetDraw.payload.main].sort((a, b) => a - b), "the line is stored SORTED, whatever order arrived");
  assert.equal(ticket.draw_date, targetDraw.draw_date);
  assert.equal(ticket.configuration.note, "the big one");

  // Validation refusals are legacy's strings, one bad line rejects the ticket.
  for (const [payload, message] of [
    [{ name: "", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }] }, "ticket name is required"],
    [{ name: "X", lines: [] }, "at least one line is required"],
    [{ name: "X", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }], generationMethod: "TEA" }, "unknown generation method: TEA"],
    [{ name: "X", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }], drawDate: "2026-13-40" }, "invalid draw date: 2026-13-40"],
    [{ name: "X", lines: [{ mains: [1, 1, 3, 4, 5], stars: [2, 5] }] }, "line 1 invalid: duplicate main numbers"],
    [{ name: "X", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }, { mains: [1, 2, 3, 4], stars: [2, 5] }] }, "line 2 invalid: line must contain 5 main numbers (got 4)"],
  ]) {
    const refused = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets", headers, payload });
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(refused.json().error.message, message);
  }
  const { total } = await instance.store.listAuditEvents({ limit: 200 });
  const stillOpen = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets", headers });
  assert.equal(stillOpen.json().tickets.length, 1, "every refused create stored nothing");

  // Check: the stored VERIFIED draw for the ticket's date, per-line matches, the tier label.
  const checked = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/1/check", headers, payload: {} });
  assert.equal(checked.statusCode, 200, checked.body);
  const result = checked.json();
  assert.equal(result.drawDate, targetDraw.draw_date);
  assert.equal(result.lines[0].mainMatches, 5);
  assert.equal(result.lines[0].starMatches, 2);
  assert.equal(result.lines[0].prizeTier, "TIER_1 (5 mains + 2 stars)");
  assert.match(result.note, /amounts vary per draw and are not stored/);
  assert.equal(result.status, "CHECKED");
  // The row says so too.
  const detail = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/1", headers });
  assert.equal(detail.json().ticket.status, "CHECKED");
  assert.equal(detail.json().ticket.result.lines[0].prizeTier, "TIER_1 (5 mains + 2 stars)");
  const { events } = await instance.store.listAuditEvents({ limit: 100, action: "lottery.ticket.checked" });
  assert.equal(events.length, 1);

  // A ticket dated before any stored draw: legacy's 409, not a fake zero.
  const oldTicket = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/tickets", headers,
    payload: { name: "Before history", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }], drawDate: "2020-01-01" },
  });
  assert.equal(oldTicket.statusCode, 200);
  const noDraw = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/2/check", headers, payload: {} });
  assert.equal(noDraw.statusCode, 409);
  assert.equal(noDraw.json().error.code, "LOTTERY_NO_DRAW_TO_CHECK");
  assert.equal(noDraw.json().error.message, "no stored draw to compare yet (sync the provider first)");
  // The NO_DRAW check did NOT mark the ticket CHECKED.
  const untouched = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/2", headers });
  assert.equal(untouched.json().ticket.status, "OPEN");

  // Archive is a soft delete; the row stays readable with its status.
  const archived = await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/2/delete", headers, payload: {} });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().archived, 2);
  const afterArchive = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/2", headers });
  assert.equal(afterArchive.json().ticket.status, "ARCHIVED");
  const archivedEvents = await instance.store.listAuditEvents({ limit: 100, action: "lottery.ticket.archived" });
  assert.equal(archivedEvents.events.length, 1);

  // A missing ticket is legacy's 404 on every route.
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/999", headers })).statusCode, 404);
  assert.equal((await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/999/check", headers, payload: {} })).statusCode, 404);
  assert.equal((await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/999/delete", headers, payload: {} })).statusCode, 404);
});

test("user isolation travels through the HTTP surface: one user never sees another's ticket", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());

  const owner = await instance.store.createUser({
    username: "ticketowner",
    email: "owner@example.test",
    passwordHash: await bcrypt.hash("Ticket owner phrase", 4),
    displayName: "Ticket Owner",
  });
  const viewerRole = await instance.store.ensureRole("lottery_viewer", "Lottery viewer");
  const view = await instance.store.ensurePermission("lottery.view", "Read lottery intelligence");
  await instance.store.grantRolePermission(viewerRole.id, view.id);
  await instance.store.assignRole(owner.id, viewerRole.id);
  const ownerLogin = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "ticketowner", password: "Ticket owner phrase" } });
  const ownerHeaders = { cookie: cookieFrom(ownerLogin), "x-csrf-token": ownerLogin.json().csrfToken };

  const other = await instance.store.createUser({
    username: "ticketother",
    email: "other@example.test",
    passwordHash: await bcrypt.hash("Other user phrase", 4),
    displayName: "Other User",
  });
  await instance.store.assignRole(other.id, viewerRole.id);
  const otherLogin = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "ticketother", password: "Other user phrase" } });
  const otherHeaders = { cookie: cookieFrom(otherLogin), "x-csrf-token": otherLogin.json().csrfToken };

  const created = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/tickets", headers: ownerHeaders,
    payload: { name: "Owner's ticket", lines: [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }] },
  });
  assert.equal(created.statusCode, 200, created.body);

  // The other user's list does not contain it; the detail reads as not-found;
  // check and archive refuse the same way — the ticket is invisible, not forbidden.
  const otherList = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets", headers: otherHeaders });
  assert.deepEqual(otherList.json().tickets, []);
  assert.equal((await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/1", headers: otherHeaders })).statusCode, 404);
  assert.equal((await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/1/check", headers: otherHeaders, payload: {} })).statusCode, 404);
  assert.equal((await instance.app.inject({ method: "POST", url: "/api/v1/lottery/tickets/1/delete", headers: otherHeaders, payload: {} })).statusCode, 404);

  // The owner still sees exactly their one ticket.
  const ownerList = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets", headers: ownerHeaders });
  assert.deepEqual(ownerList.json().tickets.map((t) => t.name), ["Owner's ticket"]);

  // An administrator (lottery.manage) sees any ticket by id.
  const adminHeaders = await signIn(instance.app);
  const adminView = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/tickets/1", headers: adminHeaders });
  assert.equal(adminView.statusCode, 200);
  assert.equal(adminView.json().ticket.name, "Owner's ticket");
});

test("an anonymous caller gets nothing from the ticket surface", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  for (const [method, url] of [
    ["GET", "/api/v1/lottery/tickets"],
    ["POST", "/api/v1/lottery/tickets"],
    ["GET", "/api/v1/lottery/tickets/1"],
    ["POST", "/api/v1/lottery/tickets/1/check"],
    ["POST", "/api/v1/lottery/tickets/1/delete"],
  ]) {
    const response = await instance.app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});
