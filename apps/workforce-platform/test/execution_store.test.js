import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExecutionRepository } from "../src/db/execution-repository.js";
import { createFileStore } from "../src/persistence/file-store.js";

const NOW = "2026-10-11T12:00:00.000Z";

function mysqlRow(overrides = {}) {
  return {
    proposal_id: "330e8400-e29b-41d4-a716-446655440000",
    owner_user_id: "7",
    account_id: "19",
    status: "PENDING_APPROVAL",
    intent_json: JSON.stringify({ symbol: "EURUSD", side: "BUY" }),
    checks_json: JSON.stringify([{ check: "trading-mode", ok: true }]),
    result_json: null,
    decision_by_user_id: null,
    decision_reason: null,
    decided_at: null,
    paper_order_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function recordingExecutor({ rows = [mysqlRow()], affectedRows = 1 } = {}) {
  const calls = [];
  const savedRows = rows.map((row) => ({ ...row }));
  return {
    calls,
    async execute(sql, values = []) {
      calls.push({ kind: "execute", sql, values });
      if (/^\s*SELECT/i.test(sql)) return [savedRows, []];
      if (/^\s*UPDATE/i.test(sql) && savedRows[0]) {
        const status = /SET p\.status = 'EXPIRED'/.test(sql) ? "EXPIRED"
          : /SET p\.status = 'PAPER_SUBMITTING'/.test(sql) ? "PAPER_SUBMITTING"
            : String(values[0]);
        savedRows[0] = { ...savedRows[0], status };
      }
      return [{ affectedRows }, []];
    },
    async query(sql, values = []) {
      calls.push({ kind: "query", sql, values });
      return [savedRows, []];
    },
  };
}

function proposal(id = "330e8400-e29b-41d4-a716-446655440000", overrides = {}) {
  return {
    id,
    owner_user_id: 7,
    account_id: 1,
    status: "PENDING_APPROVAL",
    intent: { symbol: "EURUSD", side: "BUY" },
    checks: [{ check: "trading-mode", ok: true }],
    result: null,
    decision_by_user_id: null,
    decision_reason: null,
    decided_at: null,
    paper_order_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test("MySQL proposal reads bind owner and paper-account owner for detail and list", async () => {
  const executor = recordingExecutor();
  const repository = createExecutionRepository(executor);

  const found = await repository.findExecutionProposal("330e8400-e29b-41d4-a716-446655440000", 7);
  assert.equal(found.owner_user_id, 7);
  assert.deepEqual(found.intent, { symbol: "EURUSD", side: "BUY" });
  assert.deepEqual(executor.calls[0].values, ["330e8400-e29b-41d4-a716-446655440000", 7, 7]);
  assert.match(executor.calls[0].sql, /JOIN wf_paper_accounts a ON a\.id = p\.account_id/);
  assert.match(executor.calls[0].sql, /p\.owner_user_id = \? AND a\.owner_user_id = \?/);

  await repository.listExecutionProposals(7, { status: "PENDING_APPROVAL", limit: 25 });
  assert.deepEqual(executor.calls[1].values, [7, 7, "PENDING_APPROVAL"]);
  assert.match(executor.calls[1].sql, /ORDER BY p\.created_at DESC/);
  assert.match(executor.calls[1].sql, /LIMIT 25$/);
});

test("MySQL proposal decisions, expiry and submission use owner-bound compare-and-set SQL", async () => {
  const executor = recordingExecutor({ rows: [mysqlRow({ status: "PAPER_SUBMITTING" })] });
  const repository = createExecutionRepository(executor);
  const id = "330e8400-e29b-41d4-a716-446655440000";

  assert.equal(await repository.expireExecutionProposal(id, 7, NOW), true);
  assert.deepEqual(executor.calls[0].values, [NOW, id, 7, 7]);
  assert.match(executor.calls[0].sql, /p\.status = 'PENDING_APPROVAL'/);

  assert.equal(await repository.decideExecutionProposal(id, 7, {
    status: "APPROVED", decisionByUserId: 7, reason: "Reviewed and approved", decidedAt: NOW, updatedAt: NOW,
  }), true);
  assert.match(executor.calls[1].sql, /p\.status = 'PENDING_APPROVAL'/);
  assert.deepEqual(executor.calls[1].values.slice(-3), [id, 7, 7]);

  assert.equal(await repository.claimExecutionProposal(id, 7, NOW), true);
  assert.match(executor.calls[2].sql, /p\.status = 'APPROVED'/);
  assert.deepEqual(executor.calls[2].values, [NOW, id, 7, 7]);

  const completed = await repository.completeExecutionProposal(id, 7, {
    status: "PAPER_EXECUTED", paperOrderId: 41, result: { synthetic: true }, updatedAt: NOW,
  });
  assert.equal(completed.status, "PAPER_EXECUTED", "the repository reads back the finalized proposal state");
  assert.match(executor.calls[3].sql, /p\.status = 'PAPER_SUBMITTING'/);
  assert.deepEqual(executor.calls[3].values.slice(0, 3), ["PAPER_EXECUTED", 41, JSON.stringify({ synthetic: true })]);
  assert.deepEqual(executor.calls[3].values.slice(-3), [id, 7, 7]);
});

test("file proposals persist in the WAL and remain private across restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-execution-store-"));
  let store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.withPaperTransaction(async (tx) => {
    await tx.createPaperAccount({
      id: 19,
      owner_user_id: 7,
      name: "Private",
      currency: "USD",
      starting_balance: 10_000,
      balance: 10_000,
      peak_equity: 10_000,
      revision: 0,
      created_at: NOW,
    });
    await tx.createExecutionProposal(proposal());
  });

  assert.equal((await store.findExecutionProposal("330e8400-e29b-41d4-a716-446655440000", 7)).account_id, 1);
  assert.equal(await store.findExecutionProposal("330e8400-e29b-41d4-a716-446655440000", 8), null);
  assert.equal((await store.listExecutionProposals(8)).length, 0);
  assert.equal((await store.listExecutionProposals(7, { status: "PENDING_APPROVAL" })).length, 1);

  await store.close();
  store = await createFileStore({ dir: path.join(directory, "store"), syncWrites: false });
  const restored = await store.findExecutionProposal("330e8400-e29b-41d4-a716-446655440000", 7);
  assert.equal(restored.status, "PENDING_APPROVAL");
  assert.deepEqual(restored.intent, { symbol: "EURUSD", side: "BUY" });
});
