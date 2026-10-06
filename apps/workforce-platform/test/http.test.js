import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestApp } from "./helpers.js";

function responseText(response) {
  return response.body || "";
}

test("core HTTP server serves the Vanilla public site with defensive headers", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.match(responseText(response), /WINDELS AI WORKFORCE/);
});

test("static file serving excludes dotfiles, traversal and unsupported methods", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const hidden = await app.inject({ method: "GET", url: "/.env.example" });
  assert.equal(hidden.statusCode, 404);
  assert.doesNotMatch(responseText(hidden), /DB_PASSWORD/);

  const traversal = await app.inject({ method: "GET", url: "/%2e%2e%2f.env.example" });
  assert.equal(traversal.statusCode, 404);
  assert.doesNotMatch(responseText(traversal), /DB_PASSWORD/);

  const write = await app.inject({ method: "POST", url: "/" });
  assert.equal(write.statusCode, 405);
  assert.equal(write.headers.allow, "GET, HEAD");
});

test("SPA deep links fall back to its built index while symlinks cannot escape the public root", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "windels-public-"));
  const publicDir = path.join(temporaryRoot, "public");
  await mkdir(path.join(publicDir, "app"), { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "public shell");
  await writeFile(path.join(publicDir, "app", "index.html"), "spa shell");
  await writeFile(path.join(temporaryRoot, "private.txt"), "private marker");
  await symlink(path.join(temporaryRoot, "private.txt"), path.join(publicDir, "leak.txt"));

  const { app } = await createTestApp({ publicDir });
  t.after(async () => {
    await app.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const deepLink = await app.inject({ method: "GET", url: "/app/account/settings", headers: { accept: "text/html" } });
  assert.equal(deepLink.statusCode, 200);
  assert.equal(responseText(deepLink), "spa shell");
  const dottedRoute = await app.inject({ method: "GET", url: "/app/users/alice.smith", headers: { accept: "text/html" } });
  assert.equal(dottedRoute.statusCode, 200);
  assert.equal(responseText(dottedRoute), "spa shell");

  const missingScript = await app.inject({ method: "GET", url: "/app/assets/missing.js", headers: { accept: "text/javascript" } });
  assert.equal(missingScript.statusCode, 404);
  assert.doesNotMatch(responseText(missingScript), /spa shell/);

  const symlinkedFile = await app.inject({ method: "GET", url: "/leak.txt" });
  assert.equal(symlinkedFile.statusCode, 404);
  assert.doesNotMatch(responseText(symlinkedFile), /private marker/);
});

test("PWA shell and install manifest are served without caching authenticated API responses", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(manifest.statusCode, 200);
  assert.match(manifest.headers["content-type"], /manifest\+json/);
  assert.equal(manifest.json().start_url, "/app/");

  const worker = await app.inject({ method: "GET", url: "/service-worker.js" });
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers["cache-control"], "no-cache");
  assert.match(responseText(worker), /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(responseText(worker), /request\.method !== "GET"/);

  const api = await app.inject({ method: "GET", url: "/api/v1/health/live" });
  assert.equal(api.headers["cache-control"], "no-store");
});

test("core router enforces JSON body limits, syntax and content type", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());

  const malformed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: "{not-json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "INVALID_JSON");

  const wrongType = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "content-type": "text/plain" },
    payload: "login",
  });
  assert.equal(wrongType.statusCode, 415);
  assert.equal(wrongType.json().error.code, "UNSUPPORTED_MEDIA_TYPE");

  const tooLarge = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier: "alice", password: "x".repeat(17_000) },
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().error.code, "BODY_TOO_LARGE");
});

test("cross-site browser mutations are rejected before route execution", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "sec-fetch-site": "cross-site" },
    payload: { identifier: "alice", password: "not checked" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ORIGIN_INVALID");
});

test("login endpoint has a per-route rate limit in addition to the API limit", async (t) => {
  const { app } = await createTestApp();
  t.after(() => app.close());
  const attempts = [];
  for (let index = 0; index < 6; index += 1) {
    attempts.push(await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "alice", password: "wrong password" },
    }));
  }
  assert.ok(attempts.slice(0, 5).every((response) => response.statusCode === 401));
  assert.equal(attempts[5].statusCode, 429);
  assert.equal(attempts[5].json().error.code, "RATE_LIMITED");
  assert.ok(Number(attempts[5].headers["retry-after"]) > 0);
});
