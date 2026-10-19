import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { adminApi } from "../src/lib/admin.js";
import { authApi, collectionsApi, intelligenceApi, leadDiscoveryApi, leadApi, membersApi } from "../src/lib/leadDiscovery.js";
import { clearSessionTokens, getAccessToken, refreshKey, saveSessionTokens, tokenKey } from "../src/lib/session.js";
import { loginDestination } from "../src/lib/loginDestination.js";

type MemoryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function makeStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browserSession() {
  const localStorage = makeStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  return localStorage;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const renewedSession = {
  token: "fresh-access-token",
  refreshToken: "fresh-refresh-token",
  organizationId: "org-1",
  permissions: ["lead.read", "lead.write", "lead.admin"],
  user: { id: "user-1", email: "admin@example.test", displayName: "Admin" },
};

test("login sends administrators to admin controls and rejects non-admin admin sign-in", () => {
  assert.equal(loginDestination(["lead.read"], false), "/app/leads");
  assert.equal(loginDestination(["lead.read", "lead.write", "lead.admin"], false), "/admin");
  assert.equal(loginDestination(["lead.read"], true), null);
  assert.equal(loginDestination(["lead.admin"], true), "/admin");
});

test("parallel dashboard reads rotate an expired refresh token exactly once", async () => {
  const storage = browserSession();
  saveSessionTokens("expired-access-token", "one-use-refresh-token");
  let refreshCalls = 0;
  const authenticatedCalls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: "one-use-refresh-token" });
      return json(renewedSession);
    }
    if (url.endsWith("/providers") || url.endsWith("/collections")) {
      authenticatedCalls.push(authorization ?? "");
      if (authorization === "Bearer expired-access-token") return json({ error: "expired" }, 401);
      return url.endsWith("/providers") ? json({ providers: [] }) : json({ collections: [] });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const [providers, collections] = await Promise.all([
    leadDiscoveryApi.providers("expired-access-token"),
    collectionsApi.list("expired-access-token"),
  ]);

  assert.deepEqual(providers.providers, []);
  assert.deepEqual(collections.collections, []);
  assert.equal(refreshCalls, 1, "parallel 401s must share the one-use refresh call");
  assert.deepEqual(authenticatedCalls.sort(), [
    "Bearer expired-access-token",
    "Bearer expired-access-token",
    "Bearer fresh-access-token",
    "Bearer fresh-access-token",
  ].sort());
  assert.equal(storage.getItem(tokenKey), "fresh-access-token");
  assert.equal(storage.getItem(refreshKey), "fresh-refresh-token");
  assert.equal(getAccessToken(), "fresh-access-token");
});

test("account and admin reads use the refreshed token after page/session expiry", async () => {
  const storage = browserSession();
  saveSessionTokens("expired-access-token", "one-use-refresh-token");
  const seen: Array<{ url: string; authorization: string | null }> = [];
  let refreshCalls = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    seen.push({ url, authorization });
    if (url.endsWith("/auth/refresh")) { refreshCalls += 1; return json(renewedSession); }
    if (authorization === "Bearer expired-access-token") return json({ error: "expired" }, 401);
    if (url.endsWith("/auth/me")) return json({ user: { ...renewedSession.user, organizationId: "org-1", permissions: renewedSession.permissions } });
    if (url.endsWith("/admin/overview")) return json({ organizationId: "org-1", members: 1, leads: 2, collections: 3, searches: 4 });
    throw new Error(`unexpected request: ${url}`);
  };

  const account = await authApi.me("expired-access-token");
  const overview = await adminApi.overview("expired-access-token");

  assert.equal(account.user.permissions.includes("lead.admin"), true);
  assert.equal(overview.leads, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(storage.getItem(tokenKey), "fresh-access-token");
  assert.ok(seen.some(call => call.url.endsWith("/admin/overview") && call.authorization === "Bearer fresh-access-token"));
});

test("CSV export retries after token rotation and preserves provider/API errors", async () => {
  browserSession();
  saveSessionTokens("expired-access-token", "one-use-refresh-token");
  let refreshCalls = 0;
  let csvCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/auth/refresh")) { refreshCalls += 1; return json(renewedSession); }
    if (url.endsWith("/export/csv")) {
      csvCalls += 1;
      if (authorization === "Bearer expired-access-token") return json({ error: "expired" }, 401);
      return new Response("name\r\nExample Ltd\r\n", { headers: { "content-type": "text/csv" } });
    }
    if (url.endsWith("/leads/lead-1/status")) return json({ error: "forbidden" }, 403);
    throw new Error(`unexpected request: ${url}`);
  };

  const csv = await intelligenceApi.exportCsv({}, "expired-access-token");
  assert.equal(await csv.text(), "name\r\nExample Ltd\r\n");
  assert.equal(refreshCalls, 1);
  assert.equal(csvCalls, 2, "the expired request is retried once with the new access token");
  await assert.rejects(leadApi.updateStatus("lead-1", "qualified", "fresh-access-token"), /forbidden/);
  assert.equal(refreshCalls, 1, "403 permission refusals are not retried as token expiry");
});

test("organization member picker uses authenticated, organization-scoped API data", async () => {
  browserSession();
  saveSessionTokens("active-access-token", "active-refresh-token");
  let seenUrl = "";
  let seenAuthorization: string | null = null;
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenAuthorization = new Headers(init?.headers).get("authorization");
    return json({ members: [{ id: "member-1", displayName: "Team Member", active: true }] });
  };

  const result = await membersApi.list("active-access-token");
  assert.deepEqual(result.members, [{ id: "member-1", displayName: "Team Member", active: true }]);
  assert.ok(seenUrl.endsWith("/lead-discovery/members"));
  assert.equal(seenAuthorization, "Bearer active-access-token");
});

test("sign-out preserves server revocation failures for the account UI", async () => {
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).endsWith("/auth/logout"));
    assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: "refresh-to-revoke" });
    return json({ error: "revocation unavailable" }, 503);
  };
  await assert.rejects(authApi.logout("refresh-to-revoke"), /revocation unavailable/);
});

test("a rejected refresh token clears the local session and reports the server refusal", async () => {
  const storage = browserSession();
  saveSessionTokens("expired-access-token", "revoked-refresh-token");
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) return json({ error: "invalid or expired refresh token" }, 401);
    if (url.endsWith("/providers")) return json({ error: "expired" }, 401);
    throw new Error(`unexpected request: ${url}`);
  };

  await assert.rejects(leadDiscoveryApi.providers("expired-access-token"), /invalid or expired refresh token/);
  assert.equal(storage.getItem(tokenKey), null);
  assert.equal(storage.getItem(refreshKey), null);
  clearSessionTokens();
});
