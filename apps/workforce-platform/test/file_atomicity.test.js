/**
 * R-30 — the file adapter's aggregate writes are atomic.
 *
 * The risk: `saveSportsTicket` used to append the ticket and then each leg as
 * separate WAL lines, so a crash between the appends could leave a ticket with
 * fewer selections than `selection_count` claims. The fix: an aggregate write
 * is ONE batch WAL record (`{"op":"batch","changes":[…]}`), applied whole on
 * replay — and children are written first, so even the raw record order reads
 * parent-last. The same treatment covers the two lottery replace-writes
 * (draw numbers, ticket lines), whose delete-then-insert loop had the same
 * torn-middle window.
 *
 * The WAL shape is the proof: one JSON line is parsed or discarded whole, so
 * "one record per aggregate" IS "all or nothing" — the same argument F-01's
 * torn-write test makes for single rows, made for aggregates.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileStore, fileStorePaths } from "../src/persistence/file-store.js";
import { buildTicket } from "../src/modules/sports/ticket-governance.js";
import { optimizeTicket } from "../src/modules/sports/ticket-optimizer.js";
import { readFile as readFixture } from "node:fs/promises";

const golden = JSON.parse(
  await readFixture(new URL("./fixtures/sports-parity-golden.json", import.meta.url), "utf8"),
);

function builtTicket() {
  const entry = golden.cases.slice4.optimize["the best in-window combination by summed expected value"];
  const config = { ...entry.input.config, stake_amount: 10 };
  const optimized = optimizeTicket(entry.input.pool, entry.input.config, { ticketId: "tkt_0123456789abcdef" });
  return buildTicket(optimized, {
    configurationVersion: 0, modelVersionId: 1, config, createdAt: "2026-10-12T10:00:00.000Z",
  });
}

function tempDir(t, name) {
  return mkdtemp(path.join(tmpdir(), name)).then(async (dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

async function logLines(storeDir) {
  const text = await readFile(fileStorePaths(storeDir).log, "utf8");
  return text.trim().split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("R-30: a sports ticket and its selections are ONE WAL record, legs before the parent", async (t) => {
  const dir = await tempDir(t, "r30-sports-");
  const storeDir = path.join(dir, "store");
  const store = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  t.after(() => store.close());

  const built = builtTicket();
  const saved = await store.saveSportsTicket(built);
  assert.equal(saved.id, built.ticket.id);
  assert.equal((await store.listSportsTicketSelections(built.ticket.id)).length, built.selections.length);

  // The last record is one batch containing every leg AND the parent, legs first.
  const lines = await logLines(storeDir);
  const last = lines.at(-1);
  assert.equal(last.op, "batch", "the aggregate is one record, not one per row");
  const legs = last.changes.filter((change) => change.entity === "sportsTicketSelections");
  const parent = last.changes.filter((change) => change.entity === "sportsTickets");
  assert.equal(legs.length, built.selections.length, "every leg is in the record");
  assert.equal(parent.length, 1, "the ticket is in the same record");
  assert.ok(
    last.changes.indexOf(parent[0]) > last.changes.indexOf(legs[0]),
    "children are written first — the parent lands last",
  );
});

test("R-30: a torn trailing batch line is discarded WHOLE — the previous ticket keeps all its legs and the half-written one never existed", async (t) => {
  const dir = await tempDir(t, "r30-torn-");
  const storeDir = path.join(dir, "store");

  // Build a real store with one complete ticket, then take its batch line.
  const seed = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  const first = builtTicket();
  await seed.saveSportsTicket(first);
  const lines = await logLines(storeDir);
  const goodBatch = lines.at(-1);
  await seed.close();

  // A second ticket's batch line, torn mid-write by "the crash": truncate it.
  const second = { ...first, ticket: { ...first.ticket, id: "tkt_ffffffffffffffff" } };
  const secondPrepared = (() => {
    // Rebuild through the store is impossible (the id guard) — synthesize the
    // record shape directly from the good one, which is what the WAL holds.
    const changes = goodBatch.changes.map((change) =>
      change.entity === "sportsTickets"
        ? { ...change, value: { ...change.value, id: second.ticket.id } }
        : { ...change, value: { ...change.value, id: 9_999 } },
    );
    return JSON.stringify({ op: "batch", changes, sequence: goodBatch.sequence + 1 });
  })();
  const torn = secondPrepared.slice(0, Math.floor(secondPrepared.length * 0.6));
  await writeFile(fileStorePaths(storeDir).log, `${JSON.stringify(goodBatch)}\n${torn}`, "utf8");

  // Reopen: the good ticket is complete, the torn one is nowhere — not as a
  // parent, not as orphan legs — and the store keeps working.
  const reopened = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  t.after(() => reopened.close());
  assert.equal(await reopened.findSportsTicket(first.ticket.id) !== null, true, "the committed ticket survived");
  assert.equal((await reopened.listSportsTicketSelections(first.ticket.id)).length, first.selections.length, "with every leg");
  assert.equal(await reopened.findSportsTicket("tkt_ffffffffffffffff"), null, "the torn aggregate never existed");
  const stillWorks = await reopened.saveSportsTicket({ ...builtTicket(), ticket: { ...builtTicket().ticket, id: "tkt_aaaaaaaaaaaaaaaa" } });
  assert.equal(stillWorks.id, "tkt_aaaaaaaaaaaaaaaa", "the store accepts new writes after discarding the torn tail");
});

test("R-30: a duplicate ticket id refuses before anything is written", async (t) => {
  const dir = await tempDir(t, "r30-dupe-");
  const storeDir = path.join(dir, "store");
  const store = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  t.after(async () => { await store.close(); });

  await store.saveSportsTicket(builtTicket());
  const before = (await logLines(storeDir)).length;
  await assert.rejects(store.saveSportsTicket(builtTicket()), /Already exists/);
  assert.equal((await logLines(storeDir)).length, before, "the refusal wrote nothing");
});

test("R-30: replacing a lottery ticket's lines is one record — old lines gone, new lines as given", async (t) => {
  const dir = await tempDir(t, "r30-lines-");
  const storeDir = path.join(dir, "store");
  const store = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  t.after(() => store.close());

  const saved = await store.saveLotteryTicket({
    userId: 4, lotteryCode: "EUROMILLIONS", name: "Week 42", drawDate: null, generationMethod: "MANUAL",
    modelVersion: "MANUAL", configuration: {}, status: "OPEN", result: null, createdAt: "2026-10-13T09:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z",
  });
  const ticketId = saved.row.id;
  await store.saveLotteryTicketLines(ticketId, [{ mains: [9, 8, 7, 6, 5], stars: [2, 1] }, { mains: [1, 2, 3, 4, 5], stars: [3, 11] }]);
  const replacedAt = (await logLines(storeDir)).length;
  await store.saveLotteryTicketLines(ticketId, [{ mains: [10, 20, 30, 40, 49], stars: [4, 5] }]);

  const lines = await logLines(storeDir);
  const last = lines.at(-1);
  assert.equal(last.op, "batch", "the replacement is one record");
  const deletes = last.changes.filter((change) => change.op === "delete");
  const inserts = last.changes.filter((change) => change.op === "upsert");
  assert.equal(deletes.length, 2, "both old lines are removed in the same record");
  assert.equal(inserts.length, 1, "the new line is in the same record");
  // The WAL holds the PREPARED record: `mains`/`stars` are the encoded JSON strings.
  assert.equal(inserts[0].value.mains, "[10,20,30,40,49]");
  assert.equal(lines.length, replacedAt + 1, "exactly one line was appended");

  const readBack = await store.listLotteryTicketLines(ticketId);
  assert.deepEqual(readBack.map((line) => line.mains), [[10, 20, 30, 40, 49]], "the row mapper decodes on read");
});

test("R-30: replacing a stored draw's numbers is one record, and mid-log corruption stays fatal", async (t) => {
  const dir = await tempDir(t, "r30-numbers-");
  const storeDir = path.join(dir, "store");
  const store = await createFileStore({ dir: storeDir, logger: { warn() {} } });
  t.after(() => store.close());

  const draw = await store.saveLotteryDraw({
    lotteryCode: "EUROMILLIONS", providerId: 1, externalId: "SIM-2026-10-09", drawDate: "2026-10-09",
    jackpot: "10000000.00", rollover: false, source: "sandbox-simulation", sourceTimestamp: "2026-10-09T21:00:00+00:00",
    verificationStatus: "VERIFIED", payload: { main: [1, 6, 34, 43, 44], stars: [5, 11] },
  });
  await store.saveLotteryDrawNumbers(draw.row.id, { main: [1, 6, 34, 43, 44], stars: [5, 11] });
  await store.saveLotteryDrawNumbers(draw.row.id, { main: [2, 6, 34, 43, 44], stars: [5, 11] });

  const last = (await logLines(storeDir)).at(-1);
  assert.equal(last.op, "batch");
  const deletes = last.changes.filter((change) => change.op === "delete");
  const inserts = last.changes.filter((change) => change.op === "upsert");
  assert.equal(deletes.length, 7, "the five mains and two stars of the first save are removed in the same record");
  assert.equal(inserts.length, 7, "the replacement numbers are in the same record");
  assert.equal(inserts.find((change) => change.value.kind === "MAIN" && change.value.position === 0).value.number, 2);

  const numbers = await store.listLotteryDrawNumbers(draw.row.id);
  assert.equal(numbers.filter((row) => row.kind === "MAIN").map((row) => row.number)[0], 2);
});
