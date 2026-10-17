/**
 * The slice-3 repository surface: saved tickets and their lines, on both
 * adapters — with the user isolation that is the slice's whole point pinned as
 * a REPOSITORY property (spec §38): find/list filter by user_id in the
 * adapter itself, so a route cannot leak another user's ticket by forgetting
 * the clause. The SQL shapes are pinned against a recording pool.
 */

import bcrypt from "bcryptjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { REPOSITORY_METHODS } from "../src/persistence/contract.js";
import { LOTTERY_REPOSITORY_METHODS } from "../src/db/lottery-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

function tempStore(t) {
  return mkdtemp(path.join(tmpdir(), "wf-lot-ticket-")).then(async (dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { storeDir: path.join(dir, "store") };
  });
}

function ticketInput(overrides = {}) {
  return {
    userId: 4,
    lotteryCode: "EUROMILLIONS",
    name: "Week 42",
    drawDate: "2026-10-09",
    generationMethod: "MANUAL",
    modelVersion: "MANUAL",
    configuration: { note: "my numbers" },
    status: "OPEN",
    result: null,
    createdAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    ...overrides,
  };
}

test("the seven slice-3 methods are part of the 180-method contract, on both adapters", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  assert.equal(REPOSITORY_METHODS.length, 250, "180 (slice 3) + 5 measured-half methods + 3 row-5 retention methods + 22 row-17 Lead Discovery methods + 40 row-16 Language Learning methods");
  for (const name of ["saveLotteryTicket", "findLotteryTicket", "listLotteryTickets", "listAllLotteryTickets", "updateLotteryTicket", "listLotteryTicketLines", "saveLotteryTicketLines"]) {
    assert.equal(typeof store[name], "function", `the file adapter implements ${name}`);
    assert.ok(LOTTERY_REPOSITORY_METHODS.includes(name), `the SQL adapter declares ${name}`);
  }
});

test("a ticket round-trips with its configuration decoded, its lines in given order, and survives reopen", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  const saved = await store.saveLotteryTicket(ticketInput());
  assert.equal(saved.created, true);
  assert.equal(saved.row.id, 1);
  assert.equal(saved.row.configuration.note, "my numbers", "JSON decoded on read");
  assert.equal(saved.row.result, null);
  assert.equal(saved.row.status, "OPEN");

  // The STORE preserves lines exactly as given — normalizing (sorting) is the
  // service's job before it calls save, and a store that reordered would hide a
  // service regression instead of exposing it.
  await store.saveLotteryTicketLines(saved.row.id, [
    { mains: [9, 8, 7, 6, 5], stars: [2, 1] },
    { mains: [1, 2, 3, 4, 5], stars: [3, 11] },
  ]);
  const lines = await store.listLotteryTicketLines(saved.row.id);
  assert.deepEqual(lines.map((l) => l.mains.join("-")), ["9-8-7-6-5", "1-2-3-4-5"], "positions and values AS GIVEN — sorting is the service's contract");
  assert.deepEqual(lines.map((l) => l.position), [0, 1]);

  // Re-saving lines REPLACES them (delete-then-insert), and the positions renumber from the caller's order.
  await store.saveLotteryTicketLines(saved.row.id, [{ mains: [11, 12, 13, 14, 15], stars: [4, 5] }]);
  const replaced = await store.listLotteryTicketLines(saved.row.id);
  assert.deepEqual(replaced.map((l) => l.mains.join("-")), ["11-12-13-14-15"]);

  // close/reopen: the WAL replay reconstructs ticket and lines.
  await store.close();
  const second = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => second.close());
  const reopened = await second.findLotteryTicket(1);
  assert.equal(reopened.name, "Week 42");
  assert.equal((await second.listLotteryTicketLines(1)).length, 1);
});

test("user isolation is a repository property: the wrong user finds nothing", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveLotteryTicket(ticketInput({ userId: 4 }));
  await store.saveLotteryTicket(ticketInput({ userId: 7, name: "Someone else" }));

  // findTicket with a user scope filters INSIDE the adapter.
  assert.equal(await store.findLotteryTicket(1, 4).then((r) => r?.name), "Week 42");
  assert.equal(await store.findLotteryTicket(1, 7), null, "user 7 cannot even see that ticket 1 exists");
  assert.equal(await store.findLotteryTicket(1, null).then((r) => r?.name), "Week 42", "null scope = admin/system");

  // listTickets is per-user; listAllTickets is the admin scope.
  assert.deepEqual((await store.listLotteryTickets(4, 50)).map((r) => r.name), ["Week 42"]);
  assert.deepEqual((await store.listLotteryTickets(7, 50)).map((r) => r.name), ["Someone else"]);
  assert.equal((await store.listAllLotteryTickets(200)).length, 2, "newest first across users");
  assert.deepEqual((await store.listAllLotteryTickets(200)).map((r) => r.id), [2, 1]);
});

test("the CHECKED result round-trips through updateLotteryTicket, and a missing id updates nothing", async (t) => {
  const { storeDir, cleanup } = await tempStore(t);
  t.after(cleanup);
  const store = await createFileStore({ dir: storeDir, syncWrites: false });
  t.after(() => store.close());

  await store.saveLotteryTicket(ticketInput());
  const resultJson = JSON.stringify({ drawDate: "2026-10-09", lines: [{ mainMatches: 2, starMatches: 1, prizeTier: null }] });
  await store.updateLotteryTicket(1, { status: "CHECKED", result: resultJson, updated_at: "2026-10-13T00:00:00.000Z" });
  const checked = await store.findLotteryTicket(1, null);
  assert.equal(checked.status, "CHECKED");
  assert.equal(checked.result.lines[0].mainMatches, 2, "the stored result comes back decoded");
  assert.equal(checked.updated_at, "2026-10-13T00:00:00.000Z");

  // An empty patch is a silent no-op (legacy: UPDATE with no SET is not issued);
  // a patch for a missing ticket matches no row and is silent too.
  await store.updateLotteryTicket(1, {});
  await store.updateLotteryTicket(999, { status: "CHECKED", updated_at: "2026-10-13T00:00:00.000Z" });
  assert.equal((await store.findLotteryTicket(1, null)).status, "CHECKED");

  // A non-whitelisted patch key never reaches the row.
  await store.updateLotteryTicket(1, { user_id: 99, status: "ARCHIVED", updated_at: "2026-10-13T01:00:00.000Z" });
  const after = await store.findLotteryTicket(1, null);
  assert.equal(after.user_id, 4, "user_id is not a patchable column");
  assert.equal(after.status, "ARCHIVED");
});

test("the SQL adapter's statements keep user isolation in the WHERE, and the insert matches legacy's column list", async () => {
  const calls = [];
  let nextId = 1;
  const rows = [];
  const pool = {
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (/INSERT INTO wf_lottery_tickets/.test(sql)) {
        const id = nextId++;
        rows.push({
          id, user_id: values[0], lottery_code: values[1], name: values[2], draw_date: values[3],
          generation_method: values[4], model_version: values[5], configuration: values[6],
          status: values[7], result: values[8], created_at: values[9], updated_at: values[10],
        });
        return [{ affectedRows: 1, insertId: id }, []];
      }
      if (/INSERT INTO wf_lottery_ticket_lines/.test(sql)) {
        rows.push({ id: nextId++, ticket_id: values[0], position: values[1], mains: values[2], stars: values[3], created_at: values[4] });
        return [{ affectedRows: 1, insertId: nextId - 1 }, []];
      }
      if (/DELETE FROM wf_lottery_ticket_lines/.test(sql)) {
        for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].position !== undefined && rows[i].ticket_id === values[0]) rows.splice(i, 1);
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      const match = (pattern) => new RegExp(pattern).test(sql);
      let candidate = rows.filter((r) => r.position === undefined);
      if (match(/FROM wf_lottery_tickets WHERE id = \? AND user_id = \?/)) candidate = candidate.filter((r) => r.id === values[0] && r.user_id === values[1]);
      else if (match(/FROM wf_lottery_tickets WHERE id = \?/)) candidate = candidate.filter((r) => r.id === values[0]);
      else if (match(/FROM wf_lottery_tickets WHERE user_id = \?/)) candidate = candidate.filter((r) => r.user_id === values[0]);
      if (match(/FROM wf_lottery_ticket_lines WHERE ticket_id = \?/)) candidate = rows.filter((r) => r.position !== undefined && r.ticket_id === values[0]);
      const limitMatch = /LIMIT (\d+)/.exec(sql);
      return [candidate.slice(0, limitMatch ? Number(limitMatch[1]) : undefined), []];
    },
  };
  const { createStore } = await import("../src/db/store.js");
  const store = createStore(pool);

  const saved = await store.saveLotteryTicket(ticketInput({ result: null }));
  assert.equal(saved.row.id, 1, "insert_id flows back through the re-read");
  const insert = calls.find((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_tickets"));
  assert.match(insert.sql, /user_id, lottery_code, name, draw_date, generation_method, model_version, configuration, status, result, created_at, updated_at/);

  // The user filter is part of the statement, not an afterthought.
  const scoped = await store.findLotteryTicket(1, 7);
  assert.equal(scoped, null, "user 7's query filters user_id = 7 and finds nothing");
  const scopedCall = calls.filter((c) => c.kind === "query" && c.sql.includes("AND user_id = ?")).at(-1);
  assert.match(scopedCall.sql, /WHERE id = \? AND user_id = \? LIMIT 1/);
  assert.deepEqual(scopedCall.values, [1, 7]);

  await store.listLotteryTickets(4, 25);
  const list = calls.filter((c) => c.kind === "query" && c.sql.includes("WHERE user_id = ?")).at(-1);
  assert.match(list.sql, /ORDER BY id DESC LIMIT 25/);

  await store.updateLotteryTicket(1, { status: "CHECKED", result: "{}", updated_at: "2026-10-13T00:00:00.000Z" });
  const update = calls.find((c) => c.kind === "execute" && c.sql.includes("UPDATE wf_lottery_tickets"));
  assert.equal(update.sql, "UPDATE wf_lottery_tickets SET status = ?, result = ?, updated_at = ? WHERE id = ?", "the SET list is a fixed map, never caller-supplied key names");
  assert.deepEqual(update.values, ["CHECKED", "{}", "2026-10-13T00:00:00.000Z", 1]);

  await store.saveLotteryTicketLines(1, [{ mains: [1, 2, 3, 4, 5], stars: [2, 5] }, { mains: [6, 7, 8, 9, 10], stars: [1, 3] }]);
  const deleteCall = calls.find((c) => c.kind === "execute" && c.sql.includes("DELETE FROM wf_lottery_ticket_lines"));
  assert.match(deleteCall.sql, /WHERE ticket_id = \?/);
  const lineInserts = calls.filter((c) => c.kind === "execute" && c.sql.includes("INSERT INTO wf_lottery_ticket_lines"));
  assert.deepEqual(lineInserts.map((c) => c.values[1]), [0, 1], "positions AS GIVEN");
});
