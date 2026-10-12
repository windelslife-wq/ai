/**
 * The ticket storage rules (row 14, slice 4), on both adapters.
 *
 * No MySQL server runs in this sandbox, so the MySQL half proves the adapter's own rules
 * against a scripted connection: a ticket is written whole or not at all, a decision is a
 * compare-and-set, a run is claimed once, and a run is finished once. The file half runs the
 * same rules against the real file store, and pins F-40: concurrent inserts must get distinct
 * ids. The HTTP tests (`sports_tickets_http.test.js`) cover the same rules end to end.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFileStore } from "../src/persistence/file-store.js";
import { createSportsRepository, SPORTS_REPOSITORY_METHODS } from "../src/db/sports-repository.js";
import { createSportsTicketRepository, SPORTS_TICKET_METHODS } from "../src/db/sports-ticket-repository.js";
import { buildTicket } from "../src/modules/sports/ticket-governance.js";
import { optimizeTicket } from "../src/modules/sports/ticket-optimizer.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/sports-parity-golden.json", import.meta.url), "utf8"));

/** A real ticket, built by the same functions the service uses, from a legacy-verified pool. */
function builtTicket() {
  const entry = golden.cases.slice4.optimize["the best in-window combination by summed expected value"];
  const config = { ...entry.input.config, stake_amount: 10 };
  const optimized = optimizeTicket(entry.input.pool, entry.input.config, { ticketId: "tkt_0123456789abcdef" });
  return buildTicket(optimized, {
    configurationVersion: 0, modelVersionId: 1, config, createdAt: "2026-10-12T10:00:00.000Z",
  });
}

const duplicate = () => Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", sqlState: "23000" });

/**
 * A scripted pool: `query` and `execute` answer from queues, and `getConnection` hands out a
 * connection that records its transaction calls. Every SQL statement sent is kept for assertions.
 */
function scripted({ queries = [], executes = [], connectionExecutes = [] } = {}) {
  const calls = [];
  const connection = {
    began: 0, committed: 0, rolled: 0, released: 0,
    async beginTransaction() { this.began += 1; },
    async commit() { this.committed += 1; },
    async rollback() { this.rolled += 1; },
    release() { this.released += 1; },
    async execute(sql, params = []) {
      calls.push({ kind: "connection.execute", sql, params });
      const next = connectionExecutes.shift();
      if (next instanceof Error) throw next;
      return [next ?? { affectedRows: 1, insertId: 0 }, []];
    },
  };
  return {
    calls,
    connection,
    async getConnection() { return connection; },
    async query(sql, params = []) {
      calls.push({ kind: "query", sql, params });
      const next = queries.shift();
      if (next instanceof Error) throw next;
      return [next ?? [], []];
    },
    async execute(sql, params = []) {
      calls.push({ kind: "execute", sql, params });
      const next = executes.shift();
      if (next instanceof Error) throw next;
      return [next ?? { affectedRows: 1, insertId: 0 }, []];
    },
  };
}

test("the MySQL ticket repository implements exactly the nine names, and the composed repository carries them", () => {
  assert.equal(SPORTS_TICKET_METHODS.length, 9);
  const repo = createSportsTicketRepository(scripted());
  assert.deepEqual(Object.keys(repo).sort(), [...SPORTS_TICKET_METHODS].sort());
  for (const name of SPORTS_TICKET_METHODS) assert.ok(SPORTS_REPOSITORY_METHODS.includes(name), `${name} is in the shared contract`);
  const composed = createSportsRepository(scripted());
  for (const name of SPORTS_TICKET_METHODS) assert.equal(typeof composed[name], "function", name);
});

test("a ticket and its selections are written on one transaction: committed once, with every leg", async () => {
  const pool = scripted();
  const repo = createSportsTicketRepository(pool);
  const built = builtTicket();
  await repo.saveSportsTicket(built);

  assert.equal(pool.connection.began, 1);
  assert.equal(pool.connection.committed, 1, "the whole ticket is committed together");
  assert.equal(pool.connection.rolled, 0);
  assert.equal(pool.connection.released, 1, "the connection is returned to the pool");
  const inserts = pool.calls.filter((call) => call.kind === "connection.execute");
  assert.match(inserts[0].sql, /INSERT INTO wf_sports_tickets/);
  const legs = inserts.filter((call) => /INSERT INTO wf_sports_ticket_selections/.test(call.sql));
  assert.equal(legs.length, built.selections.length, "every leg is written");
});

test("a ticket whose leg fails to write is rolled back whole, and never committed as a combination with no legs", async () => {
  // The first insert (the ticket) succeeds; the first leg fails. Nothing may be committed.
  const pool = scripted({ connectionExecutes: [{ affectedRows: 1, insertId: 0 }, new Error("deadlock found")] });
  const repo = createSportsTicketRepository(pool);
  await assert.rejects(repo.saveSportsTicket(builtTicket()), /deadlock found/);
  assert.equal(pool.connection.committed, 0, "a ticket without its legs is never committed");
  assert.equal(pool.connection.rolled, 1);
  assert.equal(pool.connection.released, 1);
});

test("a decision is a compare-and-set on PENDING_USER_APPROVAL: a lost race is null, and the SQL says so", async () => {
  const pool = scripted({ executes: [{ affectedRows: 0, insertId: 0 }] });
  const repo = createSportsTicketRepository(pool);
  const result = await repo.decideSportsTicket("tkt_0123456789abcdef", {
    approvalStatus: "APPROVED_NOT_EXECUTED", status: "APPROVED", reason: "ok", decidedBy: 1, decidedAt: "2026-10-12T11:00:00.000Z",
  });
  assert.equal(result, null, "another request decided first");
  const update = pool.calls.find((call) => call.kind === "execute");
  assert.match(update.sql, /WHERE id = \? AND approval_status = 'PENDING_USER_APPROVAL'/);
});

test("a run is claimed once per (day, version): a duplicate key is null, and any other error propagates", async () => {
  const claim = { runDate: "2026-10-12", configurationVersion: 0, requestedBy: 1, createdAt: "2026-10-12T10:00:00.000Z" };

  const taken = createSportsTicketRepository(scripted({ executes: [duplicate()] }));
  assert.equal(await taken.claimSportsDailyTicketRun(claim), null, "a second claim loses, whatever the first run's status");

  const broken = createSportsTicketRepository(scripted({ executes: [new Error("connection lost")] }));
  await assert.rejects(broken.claimSportsDailyTicketRun(claim), /connection lost/, "a lost connection is not a lost claim");
});

test("a run is finished once: only a RUNNING row can be finished, and a second finish is null", async () => {
  const pool = scripted({ executes: [{ affectedRows: 0, insertId: 0 }] });
  const repo = createSportsTicketRepository(pool);
  const finished = await repo.finishSportsDailyTicketRun(3, {
    status: "NO_QUALIFIED_TICKET", ticketId: null, message: "x", fixturesRead: 0, candidatesEvaluated: 0,
    predictionsRecorded: 0, rejections: 0, simulatedRefused: 0, rejectionSummary: {}, errors: [],
  }, "2026-10-12T10:05:00.000Z");
  assert.equal(finished, null);
  assert.match(pool.calls[0].sql, /WHERE id = \? AND status = 'RUNNING'/);
});

test("configuration version 0 is a valid key (the defaults), and a negative version is refused", async () => {
  const pool = scripted({ queries: [[]] });
  const repo = createSportsTicketRepository(pool);
  assert.equal(await repo.findSportsDailyTicketRun("2026-10-12", 0), null);
  assert.equal(pool.calls[0].params[1], 0, "version 0 is sent as 0, not dropped");
  await assert.rejects(repo.findSportsDailyTicketRun("2026-10-12", -1), TypeError);
});

test("a ticket list filtered by day joins through the daily run, and the limit is bounded", async () => {
  const pool = scripted({ queries: [[]] });
  const repo = createSportsTicketRepository(pool);
  await repo.listSportsTickets({ runDate: "2026-10-12" }, 99999);
  const sql = pool.calls[0].sql;
  assert.match(sql, /id IN \(SELECT ticket_id FROM wf_sports_daily_tickets WHERE run_date = \? AND ticket_id IS NOT NULL\)/);
  assert.match(sql, /LIMIT 500/, "a huge limit is capped, not passed through");
  assert.deepEqual(pool.calls[0].params, ["2026-10-12"]);
});

test("the file store round-trips a ticket and its legs, and enforces the same compare-and-set and claim rules", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "tickets-store-"));
  const store = await createFileStore({ dir: path.join(dir, "store"), logger: { warn() {} } });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  const built = builtTicket();
  const saved = await store.saveSportsTicket(built);
  assert.equal(saved.id, built.ticket.id);
  assert.equal((await store.listSportsTicketSelections(built.ticket.id)).length, built.selections.length);
  assert.equal((await store.listSportsTickets({ approvalStatus: "PENDING_USER_APPROVAL" }, 10)).length, 1);

  const decision = { approvalStatus: "REJECTED", status: "CANCELLED", reason: "no", decidedBy: 1, decidedAt: "2026-10-12T11:00:00.000Z" };
  assert.ok(await store.decideSportsTicket(built.ticket.id, decision), "the first decision applies");
  assert.equal(await store.decideSportsTicket(built.ticket.id, decision), null, "the second is refused");

  const claim = { runDate: "2026-10-12", configurationVersion: 0, requestedBy: 1, createdAt: "2026-10-12T10:00:00.000Z" };
  const run = await store.claimSportsDailyTicketRun(claim);
  assert.ok(run, "the first claim wins");
  assert.equal(await store.claimSportsDailyTicketRun(claim), null, "the second claim loses");
  const outcome = {
    status: "PENDING_USER_APPROVAL", ticketId: built.ticket.id, message: "ok", fixturesRead: 1, candidatesEvaluated: 1,
    predictionsRecorded: 1, rejections: 0, simulatedRefused: 0, rejectionSummary: {}, errors: [],
  };
  assert.ok(await store.finishSportsDailyTicketRun(run.id, outcome, "2026-10-12T10:05:00.000Z"));
  assert.equal(await store.finishSportsDailyTicketRun(run.id, outcome, "2026-10-12T10:06:00.000Z"), null, "a run is finished once");
  assert.equal((await store.listSportsTickets({ runDate: "2026-10-12" }, 10)).length, 1, "the ticket is found through its run's day");
});

test("F-40: concurrent inserts get distinct ids, so two rows never share one (the file adapter)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "f40-"));
  const store = await createFileStore({ dir: path.join(dir, "store"), logger: { warn() {} } });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  const provider = await store.ensureSportsProvider("f40", "F-40");
  const base = { sport: "football", competition: "C", homeTeam: "H", awayTeam: "A", kickoff: "2026-10-12T15:00:00.000Z", status: "SCHEDULED", sourceTimestamp: "2026-10-12T10:00:00.000Z" };
  const rows = await Promise.all([1, 2, 3, 4].map((i) => store.saveSportsMatch(provider.id, { ...base, externalId: `e-${i}` })));
  const ids = rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `ids were ${ids.join(", ")}`);
});
