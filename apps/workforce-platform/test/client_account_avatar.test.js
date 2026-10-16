/**
 * The account screen's profile image (row 3, Phase 34).
 *
 * `POST`/`DELETE /api/v1/account/avatar` and the private read route have existed
 * since the identity slice with no screen calling them: legacy's `/account` held
 * the 84px hero, an upload form and a remove form, and the port kept the routes
 * while dropping the control. This suite asserts the two halves of that gap — the
 * routes' real behaviour (upload, replacement, removal, ownership, the disabled
 * host, the size and type refusals) and the control's own words, taken from
 * `views/auth/account.php`.
 *
 * Its failure mode is a generic sentence: "Upload failed." for a refusal that has
 * a reason, or a byte count where legacy said "Profile image must be 2 MB or
 * smaller." Every refusal asserted here is the sentence the server actually sends,
 * routed through `avatarFailureMessage`.
 *
 * Hermetic like the other client suites (`createFileStoreApp`, file adapter, no
 * network); the uploads directory is a throwaway under `tmpdir`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AVATAR_ACCEPT, AVATAR_FALLBACK_INITIAL, AVATAR_HINT, AVATAR_NO_FILE_MESSAGE,
  AVATAR_REMOVED_NOTICE, AVATAR_UPLOADED_NOTICE,
  avatarFailureMessage, avatarInitials, avatarView,
} from "../client/src/avatar.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const LEGACY_ACCOUNT_VIEW = path.resolve(import.meta.dirname, "..", "..", "..", "application", "views", "auth", "account.php");

/** A genuine 1x1 RGBA PNG: IHDR 1x1, one deflated scanline, IEND. */
const PNG_ONE_PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082",
  "hex",
);

const ADMIN = { identifier: "rootadmin", password: "Root administrator pass" };

async function avatarInstance(t, env = {}) {
  const instance = await createFileStoreApp({ configOverrides: { env } });
  t.after(() => instance.cleanup());
  return instance;
}

async function signIn(instance, { identifier, password }) {
  const response = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken }, user: body.user, permissions: body.permissions };
}

const adminSession = (instance) => signIn(instance, ADMIN);

/** A signed-in member with no role grants: `platform_member` is seeded empty. */
async function memberSession(instance) {
  const role = (await instance.store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const user = await instance.store.createUser({
    username: "member",
    email: "member@example.test",
    passwordHash: await hashPassword("Correct horse battery staple", { minLength: 14 }),
    displayName: "Plain Member",
  });
  await instance.store.assignRole(user.id, role.id);
  return signIn(instance, { identifier: "member", password: "Correct horse battery staple" });
}

/** A multipart body as a Buffer: the binary part must not pass through UTF-8. */
function multipart(parts, { boundary = "wf-avatar-boundary" } = {}) {
  const chunks = [];
  for (const { name, filename, value, contentType } of parts) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const isFile = filename !== undefined;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${isFile ? `; filename="${filename}"` : ""}\r\n` +
      `${isFile ? `Content-Type: ${contentType || "application/octet-stream"}\r\n` : ""}\r\n`,
      "utf8",
    ));
    chunks.push(data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(instance, session, { filename = "photo.png", value = PNG_ONE_PIXEL, contentType, headers = {} } = {}) {
  const body = multipart([{ name: "avatar", filename, value, contentType }]);
  return instance.app.inject({
    method: "POST",
    url: "/api/v1/account/avatar",
    headers: { ...session.headers, "content-type": body.contentType, ...headers },
    payload: body.body,
  });
}

const get = (instance, url, headers) => instance.app.inject({ method: "GET", url, headers });

// ------------------------------------------------------- the control's vocabulary

test("the control's words are the legacy form's: accept list, hint, notices", () => {
  const legacy = readFileSync(LEGACY_ACCOUNT_VIEW, "utf8");
  // `views/auth/account.php`: the file input's `accept=`, the hint beside it and
  // the two flash notices `Auth::upload_avatar`/`remove_avatar` redirected with.
  assert.ok(legacy.includes(`accept="${AVATAR_ACCEPT}"`), `the legacy accept list is ${AVATAR_ACCEPT}`);
  assert.ok(legacy.includes("PNG, JPEG, GIF or WebP · up to 2 MB."), "the legacy hint line");
  assert.equal(AVATAR_HINT, "PNG, JPEG, GIF or WebP · up to 2 MB.");
  assert.equal(AVATAR_UPLOADED_NOTICE, "Your profile image has been updated.");
  assert.equal(AVATAR_REMOVED_NOTICE, "Your profile image has been removed.");
  // The one sentence the control states without a round trip, because the browser
  // does not submit an empty file input: it is the server's own `NO_FILE` wording.
  assert.equal(AVATAR_NO_FILE_MESSAGE, "Choose an image to upload");
});

test("initials follow the legacy rule, and a leading space no longer renders blank", () => {
  // `strtoupper(mb_substr(preg_replace('/[^A-Za-z0-9 ]/', '', $displayName), 0, 1) ?: 'W')`
  assert.equal(avatarInitials("Ada Lovelace"), "A");
  assert.equal(avatarInitials("zoe"), "Z");
  assert.equal(avatarInitials("1st Place"), "1");
  assert.equal(avatarInitials("ünïcode"), "N", "non-ASCII is stripped before the first letter is taken");
  assert.equal(avatarInitials("Ada-Lovelace"), "A");
  assert.equal(avatarInitials("  spaced"), "S", "legacy returned a blank circle here; the deviation is deliberate");
  assert.equal(avatarInitials("   "), AVATAR_FALLBACK_INITIAL);
  assert.equal(avatarInitials(""), AVATAR_FALLBACK_INITIAL);
  assert.equal(avatarInitials("!!!"), AVATAR_FALLBACK_INITIAL);
  assert.equal(avatarInitials(null), AVATAR_FALLBACK_INITIAL);
  assert.equal(AVATAR_FALLBACK_INITIAL, "W");
});

test("the hero renders the stored image or the initial, never an empty frame", () => {
  const url = "/api/v1/files/avatars/u1_0123456789abcdef0123456789abcdef.png";
  assert.deepEqual(avatarView({ displayName: "Ada Lovelace", avatarUrl: url }), { kind: "image", url, initials: "A" });
  assert.deepEqual(avatarView({ displayName: "Ada Lovelace", avatarUrl: null }), { kind: "initials", url: null, initials: "A" });
  assert.deepEqual(avatarView({ displayName: "Ada Lovelace" }), { kind: "initials", url: null, initials: "A" });
  assert.equal(avatarView({ displayName: "Ada", avatarUrl: "   " }).kind, "initials", "a blank stored path is not an image");
  assert.equal(avatarView({ username: "zoe" }).initials, "Z", "the username is the fallback name, as in the legacy header");
  assert.equal(avatarView(null).kind, "initials");
});

test("a refusal keeps the server's reason; the disabled host gets its remedy, not a retry", () => {
  assert.equal(avatarFailureMessage({ message: "Only PNG, JPEG, GIF or WebP images are allowed", code: "UNSUPPORTED_TYPE" }),
    "Only PNG, JPEG, GIF or WebP images are allowed");
  const disabled = avatarFailureMessage({ message: "Profile image storage is not enabled on this host", code: "UPLOADS_DISABLED", retryAfter: 3600 });
  assert.ok(disabled.startsWith("Profile image storage is not enabled on this host"), disabled);
  assert.ok(disabled.includes("UPLOADS_ENABLED=1"), "the state is named with the switch that causes it");
  assert.ok(!disabled.includes("Try again"), "a switched-off feature is not a busy one: no 3600s retry advice");
  assert.equal(avatarFailureMessage({ message: "Too many uploads from this address", code: "RATE_LIMITED", retryAfter: 42 }),
    "Too many uploads from this address Try again in about 42s.");
  // A non-`ApiError` throw still produces a sentence rather than "undefined".
  assert.equal(avatarFailureMessage(new Error("network down")), "network down");
  assert.ok(avatarFailureMessage(null).length > 0);
});

// --------------------------------------------------------- the routes it speaks to

test("the two avatar routes and the private read are exactly the ones registered", async (t) => {
  const instance = await avatarInstance(t);
  const routes = (await get(instance, "/api/v1/system/routes")).json().routes;

  const post = routes.find((route) => route.method === "POST" && route.path === "/api/v1/account/avatar");
  assert.ok(post, "the upload route must be registered");
  assert.equal(post.auth, true, "an avatar is stored for a session, never for an anonymous caller");
  assert.equal(post.permission, null, "self-service: the legacy controller required a session, not a permission");
  assert.equal(post.rateLimited, true, "ten uploads per ten minutes, as declared");
  assert.equal(post.validated, false, "the body is multipart, not schema-validated");

  const remove = routes.find((route) => route.method === "DELETE" && route.path === "/api/v1/account/avatar");
  assert.ok(remove, "the removal route must be registered");
  assert.equal(remove.auth, true);
  assert.equal(remove.permission, null);

  const read = routes.find((route) => route.method === "GET" && route.path === "/api/v1/files/avatars/:fileId");
  assert.ok(read, "the private read route must be registered");
  assert.equal(read.auth, true, "avatars live outside the static root: this route is the only way to the bytes");
  assert.equal(read.permission, null, "own file or super admin, checked in the handler against the file's owner");

  const avatarRoutes = routes.filter((route) => route.path.includes("avatar"));
  assert.equal(avatarRoutes.length, 3, "no fourth avatar surface has appeared");

  // The control is a screen for a signed-in member; nothing about it needs a role.
  const view = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.ok(view.includes('{ to: "/app/account", label: "Account", permission: null }'), "the account entry is session-only, like the legacy nav");
  const appSource = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  assert.ok(appSource.includes('account: <AccountView user={user} permissions={permissions} onSessionChanged={applySession} />'),
    "the control's screen is the rendered account view");
});

test("an empty form is refused in the legacy words, not with a generic failure", async (t) => {
  const instance = await avatarInstance(t);
  const session = await adminSession(instance);

  const noBody = await instance.app.inject({ method: "POST", url: "/api/v1/account/avatar", headers: session.headers, payload: {} });
  assert.equal(noBody.statusCode, 400, noBody.body);
  assert.equal(noBody.json().error.code, "NO_FILE");
  assert.equal(noBody.json().error.message, AVATAR_NO_FILE_MESSAGE);

  const fieldOnly = await instance.app.inject({
    method: "POST",
    url: "/api/v1/account/avatar",
    headers: { ...session.headers, "content-type": "multipart/form-data; boundary=wf-avatar-boundary" },
    payload: multipart([{ name: "csrf_token", value: "irrelevant" }]).body,
  });
  assert.equal(fieldOnly.statusCode, 400, fieldOnly.body);
  assert.equal(fieldOnly.json().error.code, "NO_FILE", "a form with no file part is the same refusal");
  assert.equal(fieldOnly.json().error.message, AVATAR_NO_FILE_MESSAGE);
});

test("the bytes decide the type: an image name does not make a file an image", async (t) => {
  const instance = await avatarInstance(t);
  const session = await adminSession(instance);

  const text = await upload(instance, session, {
    filename: "notes.png",
    value: Buffer.from("this is not a png, whatever the name says", "utf8"),
    contentType: "image/png",
  });
  assert.equal(text.statusCode, 422, text.body);
  assert.equal(text.json().error.code, "UNSUPPORTED_TYPE");
  assert.equal(text.json().error.message, "Only PNG, JPEG, GIF or WebP images are allowed");
});

test("an oversized image is refused in the legacy sentence, not in bytes", async (t) => {
  const instance = await avatarInstance(t);
  const session = await adminSession(instance);
  const { maxBytes, bodyLimitBytes } = instance.config.uploads;

  // A part over the limit is caught while the multipart body is read.
  const partOverLimit = await upload(instance, session, { value: Buffer.concat([PNG_ONE_PIXEL, Buffer.alloc(maxBytes + 1024)]) });
  assert.equal(partOverLimit.statusCode, 413, partOverLimit.body.slice(0, 200));
  const partMessage = partOverLimit.json().error.message;
  assert.equal(partMessage, `Profile image must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`);
  assert.ok(!partMessage.includes("bytes"), "the member is told the rule, not a byte count");

  // A body over the connection limit answers with the same sentence.
  const bodyOverLimit = await upload(instance, session, { value: Buffer.concat([PNG_ONE_PIXEL, Buffer.alloc(bodyLimitBytes)]) });
  assert.equal(bodyOverLimit.statusCode, 413, bodyOverLimit.body.slice(0, 200));
  assert.equal(bodyOverLimit.json().error.message, partMessage, "both layers use the route's wording");
  assert.equal(partMessage.endsWith("or smaller"), true);
});

test("an upload is stored behind the private read, replaced whole, and removed clean", async (t) => {
  const instance = await avatarInstance(t);
  const session = await adminSession(instance);

  const created = await upload(instance, session);
  assert.equal(created.statusCode, 201, created.body);
  const stored = created.json();
  assert.match(stored.avatarUrl, /^\/api\/v1\/files\/avatars\/u1_[a-f0-9]{32}\.png$/, "the generated name carries the owner id and a random tail");
  assert.equal(stored.contentType, "image/png");
  assert.equal(stored.bytes, PNG_ONE_PIXEL.length);

  const me = await get(instance, "/api/v1/auth/me", session.headers);
  assert.equal(me.json().user.avatarUrl, stored.avatarUrl, "the session's own snapshot is what the hero renders");

  const read = await get(instance, stored.avatarUrl, session.headers);
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["content-type"], "image/png");
  assert.equal(read.headers["cache-control"], `private, max-age=${instance.config.uploads.cacheSeconds}`);
  // `inject` hands a streamed reply back as a Buffer on `.buffer`, so the bytes can
  // be compared exactly rather than through a decoded string.
  assert.deepEqual(read.buffer, PNG_ONE_PIXEL, "the stored bytes are the bytes that were uploaded");

  // Replacing an image deletes the file it replaced, and the old URL stops working
  // rather than serving a removed picture to a cached copy of the page.
  const replaced = await upload(instance, session, { filename: "second.png" });
  assert.equal(replaced.statusCode, 201, replaced.body);
  const second = replaced.json().avatarUrl;
  assert.notEqual(second, stored.avatarUrl);
  const stale = await get(instance, stored.avatarUrl, session.headers);
  assert.equal(stale.statusCode, 404, "the replaced file is gone, not orphaned");

  // An owner-only surface: another signed-in member cannot read someone else's image.
  const member = await memberSession(instance);
  const foreign = await get(instance, second, member.headers);
  assert.equal(foreign.statusCode, 403, foreign.body);
  assert.equal(foreign.json().error.code, "NOT_OWNER");
  assert.equal(foreign.json().error.message, "You may only read your own profile image");

  // CSRF and the session are both required on the unsafe methods.
  const noSession = await instance.app.inject({ method: "DELETE", url: "/api/v1/account/avatar" });
  assert.equal(noSession.statusCode, 401, noSession.body);
  const noToken = await instance.app.inject({
    method: "DELETE",
    url: "/api/v1/account/avatar",
    headers: { cookie: session.headers.cookie },
  });
  assert.equal(noToken.statusCode, 403, noToken.body);
  assert.equal(noToken.json().error.code, "CSRF_INVALID");

  const removed = await instance.app.inject({ method: "DELETE", url: "/api/v1/account/avatar", headers: session.headers });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { avatarUrl: null });
  assert.equal(await instance.store.findAvatarPath(1), null, "the stored path is cleared, so the hero falls back to initials");
  assert.equal((await get(instance, "/api/v1/auth/me", session.headers)).json().user.avatarUrl, null);
  assert.equal((await get(instance, second, session.headers)).statusCode, 404, "the file itself is deleted");

  const activity = (await get(instance, "/api/v1/account/activity?limit=50", session.headers)).json().events.map((event) => event.action);
  assert.ok(activity.includes("identity.user.avatar-updated"), "an upload is audited");
  assert.ok(activity.includes("identity.user.avatar-removed"), "a removal is audited");
});

test("the upload limit is enforced, and its refusal is the one the control words", async (t) => {
  const instance = await avatarInstance(t);
  const session = await adminSession(instance);
  assert.equal(instance.config.rateLimit.enabled, true, "the limiter is on by default");

  // Ten uploads per ten minutes is the route's declared budget; the eleventh is
  // refused before the file is read, so a member cannot hammer the store.
  const first = await upload(instance, session);
  assert.equal(first.statusCode, 201, first.body);
  let last = first;
  for (let attempt = 0; attempt < 10; attempt += 1) last = await upload(instance, session);
  assert.equal(last.statusCode, 429, last.body);
  assert.equal(last.json().error.code, "RATE_LIMITED");
  const wait = Number(last.headers["retry-after"]);
  assert.ok(wait > 0 && wait <= 600, `the refusal says how long to wait (${wait}s)`);
  // The client reads `retry-after` from the header (the error body carries the code
  // only), which is exactly what `ApiError.retryAfter` does in the browser.
  assert.ok(avatarFailureMessage({ ...last.json().error, retryAfter: wait }).includes("Try again in about"), "and the control repeats it");
});

test("a host with image storage switched off says so, and still lets an old image go", async (t) => {
  const instance = await avatarInstance(t, { UPLOADS_ENABLED: "0" });
  const session = await adminSession(instance);

  const refused = await upload(instance, session);
  assert.equal(refused.statusCode, 503, refused.body);
  const error = refused.json().error;
  assert.equal(error.code, "UPLOADS_DISABLED");
  assert.equal(error.message, "Profile image storage is not enabled on this host");
  assert.equal(Number(refused.headers["retry-after"]), 3600, "the server's own retryAfter");

  const sentence = avatarFailureMessage({ ...error, retryAfter: Number(refused.headers["retry-after"]), status: 503 });
  assert.ok(sentence.includes("UPLOADS_ENABLED=1"), sentence);
  assert.ok(!sentence.includes("Try again in about 3600s"), "no thousand-second retry advice on a configuration state");

  // The removal route has no such switch: it deletes what a previous host stored.
  const removed = await instance.app.inject({ method: "DELETE", url: "/api/v1/account/avatar", headers: session.headers });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { avatarUrl: null });
});
