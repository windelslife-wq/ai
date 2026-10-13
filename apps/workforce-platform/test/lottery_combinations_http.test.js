/**
 * The slice-2 HTTP surface over the file adapter: the analyzer, the five-mode
 * generator, diversification, the system builder and their persistence — with
 * the permission matrix exactly as legacy's `Api_lottery` declares it:
 *
 *   - analyze/combinations/ai-decisions reads:        GET  + lottery.view
 *   - generate/diversity/system POSTs:                POST + CSRF + lottery.view
 *     (they create ANALYSIS RECORDS, not managed ingestion — legacy's own
 *      requirePostPermission('lottery.view'), kept deliberately)
 *   - system-build (writes a job-run row):            POST + CSRF + lottery.manage
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

test("analyze answers with the full profile, the dataset version and the disclaimer", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);
  await instance.app.inject({ method: "POST", url: "/api/v1/lottery/sync", headers, payload: { limit: 10 } });

  const analyzed = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/analyze?mains=7,14,21,28,35&stars=4,5", headers });
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  const body = analyzed.json();
  assert.deepEqual(body.mains, [7, 14, 21, 28, 35], "the line comes back sorted");
  assert.match(body.datasetVersion, /^n=10;last=\d{4}-\d{2}-\d{2}$/, "n is the stored count; last is the newest stored draw date");
  assert.equal(body.scoreLabel, `STATISTICAL BALANCE SCORE: ${body.balanceScore}/100`);
  assert.match(body.scoreMeaning, /NOT a probability/);
  assert.match(body.disclaimer, /independent random events/);
  assert.equal(body.numberProfile.length, 5);

  // An invalid line is legacy's 400 with the rules error text.
  const invalid = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/analyze?mains=1,1,3,4,5&stars=2,5", headers });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "LOTTERY_INVALID_ARGUMENT");
  assert.match(invalid.json().error.message, /duplicate main numbers/);
});

test("generate persists a combination and a decision, audited, reproducible by seed", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);

  const generated = await instance.app.inject({
    method: "POST",
    url: "/api/v1/lottery/generate",
    headers,
    payload: { mode: "RANDOM", count: 3, seed: 42 },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  const report = generated.json();
  assert.equal(report.mode, "RANDOM");
  assert.equal(report.lineCount, 3);
  assert.equal(report.inputs.seed, 42);
  assert.equal(report.inputs.datasetVersion, "n=0;last=none");
  assert.match(report.honestyNote, /exactly the same mathematical chance/);
  assert.equal(report.saved.combinationId, 1);
  assert.equal(report.saved.decisionId, 1);

  // The same seed regenerates the same lines — the reproducibility contract.
  const replay = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/generate", headers, payload: { mode: "RANDOM", count: 3, seed: 42 },
  });
  assert.deepEqual(replay.json().lines, report.lines);

  // The combination read-back carries the decoded lines and its decision.
  const combination = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/combinations/1", headers });
  assert.equal(combination.statusCode, 200);
  assert.equal(combination.json().combination.line_count, 3, "stored rows are snake_case, like every draw row before them");
  assert.equal(combination.json().combination.decisions.length, 1);

  const list = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/combinations?limit=1&offset=0", headers });
  assert.equal(list.json().combinations.length, 1);
  assert.equal(list.json().combinations[0].id, 2, "newest first — the replay is id 2");

  const decisions = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/ai-decisions?limit=10", headers });
  assert.equal(decisions.statusCode, 200);
  assert.equal(decisions.json().decisions.length, 2);
  assert.equal(decisions.json().limit, 10);
  assert.equal(decisions.json().combinationId, null);

  const detail = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/ai-decisions/1", headers });
  assert.equal(detail.json().decision.mode, "RANDOM", "the row's mode column");
  assert.equal(detail.json().decision.decision.lineCount, 3, "the persisted REPORT travels inside the row");

  // A non-numeric limit falls back to 50 (legacy's own soft fallback), and a bad
  // combinationId is a 400 that says so.
  const soft = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/ai-decisions?limit=tea", headers });
  assert.equal(soft.statusCode, 200);
  assert.equal(soft.json().limit, 50);
  const badId = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/ai-decisions?combinationId=zero", headers });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error.message, "combinationId must be a positive integer");

  // Misses are 404s in legacy's words.
  const noCombination = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/combinations/999", headers });
  assert.equal(noCombination.statusCode, 404);
  assert.equal(noCombination.json().error.message, "combination not found");
  const noDecision = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/ai-decisions/999", headers });
  assert.equal(noDecision.statusCode, 404);
  assert.equal(noDecision.json().error.message, "AI decision report not found");

  // Both writes were audited with the actor.
  const { events } = await instance.store.listAuditEvents({ limit: 100, action: "lottery.combination.generated" });
  assert.equal(events.length, 2);
  assert.equal(events[0].actor.userId, 1);
  assert.equal(events[0].details.mode, "RANDOM");
});

test("the generation permission is legacy's split: lottery.view may generate, manage is for system builds", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);

  // A user with lottery.view but NOT lottery.manage can generate and score diversity.
  const viewer = await instance.store.createUser({
    username: "lotteryviewer2",
    email: "viewer2@example.test",
    passwordHash: await bcrypt.hash("Viewer pass phrase 2", 4),
    displayName: "Lottery Viewer 2",
  });
  const role = await instance.store.ensureRole("lottery_viewer", "Lottery viewer");
  const view = await instance.store.ensurePermission("lottery.view", "Read lottery intelligence");
  await instance.store.grantRolePermission(role.id, view.id);
  await instance.store.assignRole(viewer.id, role.id);
  const viewerLogin = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: "lotteryviewer2", password: "Viewer pass phrase 2" } });
  assert.equal(viewerLogin.statusCode, 200, viewerLogin.body);
  const viewerHeaders = { cookie: cookieFrom(viewerLogin), "x-csrf-token": viewerLogin.json().csrfToken };

  const generated = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/generate", headers: viewerHeaders, payload: { mode: "RANDOM", count: 1, seed: 5 },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  assert.equal(generated.json().saved.combinationId, 1, "a viewer's generation persists, audited to them");

  const diverse = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/diversity", headers: viewerHeaders,
    payload: { lines: [{ mains: [1, 2, 3, 4, 5], stars: [1, 2] }, { mains: [46, 47, 48, 49, 50], stars: [11, 12] }] },
  });
  assert.equal(diverse.statusCode, 200);
  assert.match(diverse.json().scoreLabel, /DIVERSITY SCORE: \d+\/100/);

  // ...but the background build is a manage write: the viewer is refused.
  const refusedBuild = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system-build", headers: viewerHeaders,
    payload: { mains: Array.from({ length: 29 }, (_, i) => i + 1), stars: [1, 2] },
  });
  assert.equal(refusedBuild.statusCode, 403);

  // The administrator's build queues: the pool exceeds the synchronous limit,
  // the run carries the execution key, and the note names the missing consumer.
  const built = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system-build", headers: root,
    payload: { mains: Array.from({ length: 29 }, (_, i) => i + 1), stars: [1, 2] },
  });
  assert.equal(built.statusCode, 200, built.body);
  const build = built.json();
  assert.equal(build.queued, true);
  assert.equal(build.plan.totalLines, 118755);
  // Slice 5 landed the consumer; the note names it instead of promising a ghost.
  assert.match(build.note, /consumed by the lottery cron/);
  assert.ok(build.run.execution_key.startsWith("system:EUROMILLIONS:"), "the execution key is the pool's md5");
  const { events } = await instance.store.listAuditEvents({ limit: 50, action: "lottery.system.queued" });
  assert.equal(events.length, 1);
  // Idempotent: a second build of the same pool reports the existing run.
  const again = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system-build", headers: root,
    payload: { mains: Array.from({ length: 29 }, (_, i) => i + 1), stars: [1, 2] },
  });
  assert.match(again.json().note, /already RUNNING \(idempotent\)/);
  const { events: stillOne } = await instance.store.listAuditEvents({ limit: 50, action: "lottery.system.queued" });
  assert.equal(stillOne.length, 1, "the duplicate queues nothing");
});

test("the small system builds inline and saves a SYSTEM row; the big plan is a 409", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  const headers = await signIn(instance.app);

  const system = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system", headers,
    payload: { mains: [1, 2, 3, 4, 5, 6, 7], stars: [1, 2, 3], page: 0, limit: 5 },
  });
  assert.equal(system.statusCode, 200, system.body);
  const body = system.json();
  assert.equal(body.plan.totalLines, 63);
  assert.equal(body.plan.formula, "C(7,5) x C(3,2) = 21 x 3");
  assert.equal(body.plan.estimatedCost, null);
  assert.match(body.plan.costNote, /no cost is fabricated/);
  assert.equal(body.limit, 5);
  assert.equal(body.lines.length, 5);
  assert.deepEqual(body.lines[0], { mains: [1, 2, 3, 4, 5], stars: [1, 2] });

  // The plan endpoint writes nothing.
  const combos = await instance.app.inject({ method: "GET", url: "/api/v1/lottery/combinations", headers });
  assert.equal(combos.json().combinations.length, 0, "a paginated plan read must not persist anything");

  // A pool above the synchronous limit: legacy's 409 with its own message shape.
  const tooBig = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system", headers,
    payload: { mains: Array.from({ length: 29 }, (_, i) => i + 1), stars: [1, 2] },
  });
  assert.equal(tooBig.statusCode, 409);
  assert.equal(tooBig.json().error.code, "LOTTERY_SYSTEM_TOO_LARGE");
  assert.match(tooBig.json().error.message, /above the synchronous limit \(10000\)/);

  // Refusals keep the engine's message.
  const badPool = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/system", headers, payload: { mains: [1, 2, 3, 4], stars: [1, 2] },
  });
  assert.equal(badPool.statusCode, 400);
  assert.equal(badPool.json().error.message, "a system needs at least 5 main numbers in the pool (got 4)");

  const unknownMode = await instance.app.inject({
    method: "POST", url: "/api/v1/lottery/generate", headers, payload: { mode: "TEA-LEAVES", seed: 1 },
  });
  assert.equal(unknownMode.statusCode, 400);
  assert.match(unknownMode.json().error.message, /unknown generation mode: TEA-LEAVES/);
});

test("an anonymous caller gets nothing from the slice-2 surface, like every other", async (t) => {
  const instance = await sandboxApp(t);
  t.after(() => instance.cleanup());
  for (const [method, url] of [
    ["GET", "/api/v1/lottery/analyze?mains=1,2,3,4,5&stars=2,5"],
    ["GET", "/api/v1/lottery/combinations"],
    ["GET", "/api/v1/lottery/ai-decisions"],
    ["POST", "/api/v1/lottery/generate"],
    ["POST", "/api/v1/lottery/diversity"],
    ["POST", "/api/v1/lottery/system"],
    ["POST", "/api/v1/lottery/system-build"],
  ]) {
    const response = await instance.app.inject({ method, url });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});
