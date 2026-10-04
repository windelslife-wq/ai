import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";

// Isolated HTTP contract test; no real provider, credentials or MySQL is used.
test("public routes stay honest; admin generation and publication require authorization", async () => {
  const pool = {
    async execute(sql) {
      if (sql.includes("FROM fp_tickets WHERE day=?")) return [[]];
      if (sql.includes("FROM fp_generation WHERE day=?")) return [[]];
      if (sql.includes("FROM fp_users WHERE email=?")) return [[]];
      if (sql.includes("FROM fp_odds o JOIN")) return [[]];
      return [[]];
    },
  };
  const server = createApp(pool).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base + "/api/ticket/today");
    assert.equal(home.status, 200);
    assert.equal((await home.json()).status, "NOT_GENERATED");
    const odds = await fetch(base + "/api/odds");
    assert.deepEqual((await odds.json()).data, []);
    for (const endpoint of [
      "/api/admin/generate-ticket",
      "/api/admin/tickets/1/publish",
    ]) {
      const denied = await fetch(base + endpoint, { method: "POST" });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, "ADMIN_REQUIRED");
    }
    const noSession = await fetch(base + "/api/auth/me");
    assert.equal(noSession.status, 401);
    const html = await fetch(base + "/");
    assert.match(await html.text(), /AI FOOTBALL/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("authenticated admin mutations reject missing CSRF and immutable market changes", async () => {
  const { hash } = await import("../server/db.js");
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-only-session-secret-32-characters";
  const pool = {
    async execute(sql) {
      if (sql.startsWith("SELECT s.*,u.email"))
        return [
          [
            {
              active: 1,
              role: "ADMIN",
              user_id: 1,
              csrf_hash: hash("test-token"),
              id_hash: "session",
            },
          ],
        ];
      return [[]];
    },
  };
  const server = createApp(pool).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `fp_session=${"a".repeat(64)}` };
  try {
    for (const endpoint of [
      "/api/admin/generate-ticket",
      "/api/admin/tickets/1/publish",
    ]) {
      const res = await fetch(base + endpoint, { method: "POST", headers });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, "CSRF_INVALID");
    }
    const previousKey = process.env.API_FOOTBALL_KEY;
    process.env.API_FOOTBALL_KEY = "test-only-private-api-key";
    const status = await fetch(base + "/api/admin/api-status", { headers });
    assert.equal(status.status, 200);
    assert.equal(
      (await status.text()).includes(process.env.API_FOOTBALL_KEY),
      false,
    );
    if (previousKey === undefined) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previousKey;
    const res = await fetch(base + "/api/admin/settings", {
      method: "PUT",
      headers: {
        ...headers,
        "x-csrf-token": "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ market: "OVER_2_5", automaticGeneration: true }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "IMMUTABLE_OR_UNKNOWN_SETTING");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});
