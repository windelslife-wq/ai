/**
 * Outbound mail (row 5) — the port of `Aegis\Mailer`.
 *
 * Three layers are tested, and each is tested where it can actually fail:
 *
 *  - configuration (`loadConfig`'s mail block) — legacy's `enabled()` rule, the
 *    `VP_`-prefixed names, coercion, and the one deliberate divergence (MA-1:
 *    credentials are never sent unencrypted in production);
 *  - the SMTP conversation — against `test/smtp-server.js`, a real socket on
 *    127.0.0.1, so the assertions are about bytes a server received and codes it
 *    sent, not about a mocked return value;
 *  - the two administrator routes and the contact-form copy — through the
 *    assembled HTTP app, with the same local server behind the transport.
 *
 * No test opens a connection to a public host, and none can: the transport only
 * dials the host/port it was configured with, and every configured host here is
 * 127.0.0.1 with an ephemeral port.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import bcrypt from "bcryptjs";
import { buildMessage, encodeHeaderText, formatAddress, isEmailAddress } from "../src/mail/mime.js";
import { createSmtpTransport } from "../src/mail/smtp-transport.js";
import { createMailService, MAIL_MESSAGES, shortError } from "../src/modules/mail/service.js";
import { loadConfig } from "../src/config.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { startSmtpServer } from "./smtp-server.js";

const ENV_BASE = {
  NODE_ENV: "test",
  STORAGE_ADAPTER: "file",
  SESSION_SECRET: "test-session-secret-with-at-least-32-bytes-long",
};

function mailEnv(overrides = {}) {
  return {
    ...ENV_BASE,
    VP_SMTP_ENABLED: "1",
    VP_SMTP_HOST: "127.0.0.1",
    VP_SMTP_PORT: "2525",
    VP_SMTP_CRYPTO: "tls",
    VP_SMTP_USER: "mailer@example.test",
    VP_SMTP_PASS: "smtp-secret-pass",
    VP_MAIL_FROM: "no-reply@example.test",
    VP_MAIL_FROM_NAME: "WINDELS AI WORKFORCE",
    ...overrides,
  };
}

function loadMail(overrides = {}) {
  const config = loadConfig(mailEnv(overrides));
  return config.mail;
}

/** A transport factory that records calls and returns a scripted result. */
function recordingTransport(result = { ok: true }) {
  const calls = [];
  const factory = (settings) => ({
    settings,
    async send(message) {
      calls.push({ settings, message });
      return result;
    },
  });
  return { factory, calls };
}

async function signIn(app, identifier, password) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  const body = response.statusCode === 200 ? response.json() : null;
  return { response, cookie: cookieFrom(response), headers: { cookie: cookieFrom(response), "x-csrf-token": body?.csrfToken ?? "" } };
}

// ------------------------------------------------------------------ configuration

test("MAIL the configuration follows legacy's enabled() rule and the VP_ names", () => {
  const configured = loadMail();
  assert.equal(configured.enabled, true);
  assert.equal(configured.host, "127.0.0.1");
  assert.equal(configured.port, 2525);
  assert.equal(configured.crypto, "tls");
  assert.equal(configured.fromEmail, "no-reply@example.test");
  assert.equal(configured.timeoutMs, 10_000, "VP_SMTP_TIMEOUT is seconds, as CodeIgniter read it");

  const off = loadMail({ VP_SMTP_ENABLED: "0" });
  assert.equal(off.enabled, false, "the switch alone is not enough");
  assert.equal(off.host, "127.0.0.1", "and the host is still reported for the panel");

  // legacy: the switch is 1 AND a host is non-empty. A host alone leaves mail off
  // rather than looking ready and failing at send time.
  const hostOnly = loadConfig({ ...mailEnv({ VP_SMTP_ENABLED: "" }), SMTP_ENABLED: "" }).mail;
  assert.equal(hostOnly.enabled, false);

  // Bare names are accepted with the same meaning; VP_ wins when both are set.
  const bare = loadConfig({
    ...ENV_BASE,
    SMTP_ENABLED: "1",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_CRYPTO: "ssl",
    SMTP_USER: "bare@example.test",
    SMTP_PASS: "bare-pass",
    MAIL_FROM: "bare@example.test",
  }).mail;
  assert.equal(bare.enabled, true);
  assert.equal(bare.host, "smtp.example.test");
  assert.equal(bare.port, 465);
  assert.equal(bare.crypto, "ssl");
  assert.equal(bare.fromEmail, "bare@example.test", "VP_MAIL_FROM falls through to MAIL_FROM");

  const precedence = loadConfig(mailEnv({ SMTP_HOST: "ignored.example.test", VP_SMTP_PORT: "587" })).mail;
  assert.equal(precedence.host, "127.0.0.1", "the VP_ host wins");
  assert.equal(precedence.port, 587);

  // email.php coerced an unrecognised crypto value to tls rather than failing.
  assert.equal(loadMail({ VP_SMTP_CRYPTO: "rot13" }).crypto, "tls");
  // `none` is the explicit "no encryption" value; PHP could not express it
  // through the environment, and production refuses it with credentials.
  assert.equal(loadMail({ VP_SMTP_CRYPTO: "none" }).crypto, "");
  assert.equal(loadMail({ VP_SMTP_CRYPTO: "off" }).crypto, "");
  assert.equal(loadMail({ VP_SMTP_TIMEOUT: "5" }).timeoutMs, 5_000);

  assert.throws(() => loadMail({ VP_SMTP_PORT: "70000" }), /VP_SMTP_PORT/);
  assert.throws(() => loadMail({ VP_SMTP_TIMEOUT: "0" }), /VP_SMTP_TIMEOUT/);

  // MA-1: a production host may not put credentials on a clear-text socket.
  assert.throws(
    () => loadConfig({
      ...mailEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://wf.example.test",
        ALLOW_FILE_STORE_IN_PRODUCTION: "1",
        VP_SMTP_CRYPTO: "none",
      }),
    }),
    /unencrypted connection/,
  );
  // A relay with no credentials is still allowed: there is nothing to leak.
  assert.doesNotThrow(() => loadConfig({
    ...mailEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://wf.example.test",
      ALLOW_FILE_STORE_IN_PRODUCTION: "1",
      VP_SMTP_CRYPTO: "none",
      VP_SMTP_USER: "",
      VP_SMTP_PASS: "",
    }),
  }));
});

// ----------------------------------------------------------------------- messages

test("MAIL the message is multipart/alternative with an ASCII-safe envelope", () => {
  assert.equal(isEmailAddress("no-reply@example.test"), true);
  assert.equal(isEmailAddress("not an address"), false);
  assert.equal(isEmailAddress("a@b"), false, "a dot in the domain is required, as every route already requires");
  assert.equal(isEmailAddress("x@y.test\r\nBcc: victim@example.test"), false, "CRLF can never be an address");

  const { payload, boundary } = buildMessage({
    from: "no-reply@example.test",
    fromName: "WINDELS AI WORKFORCE",
    to: "operator@example.test",
    subject: "WINDELS AI WORKFORCE — test email (html)",
    html: "<p>Hello &amp; welcome</p>",
    text: "Hello & welcome",
    now: Date.parse("2026-10-17T12:00:00.000Z"),
    messageId: "<fixed@example.test>",
    boundary: "----fixed-boundary",
  });

  assert.match(payload, /^From: "WINDELS AI WORKFORCE" <no-reply@example\.test>\r\n/);
  assert.match(payload, /^To: <operator@example\.test>\r\n/m);
  assert.match(payload, /^Date: Sat, 17 Oct 2026 12:00:00 \+0000\r\n/m);
  assert.match(payload, /^Message-ID: <fixed@example\.test>\r\n/m);
  assert.match(payload, /^Content-Type: multipart\/alternative; boundary="----fixed-boundary"\r\n/m);
  assert.ok(payload.includes("------fixed-boundary"));
  assert.ok(payload.endsWith("--\r\n"), "the multipart body is terminated");

  // The subject is an RFC 2047 encoded-word because of the em dash, and the
  // encoded word decodes to exactly the subject legacy sent.
  const subject = payload.split("\r\n").find((line) => line.startsWith("Subject: "));
  assert.match(subject, /^Subject: =\?UTF-8\?B\?/);
  const encoded = subject.slice("Subject: =?UTF-8?B?".length, -2);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "WINDELS AI WORKFORCE — test email (html)");
  assert.equal(encodeHeaderText("plain ascii"), "plain ascii");

  // Each part is base64 and decodes to the body that was handed in.
  const parts = payload.split("------fixed-boundary");
  assert.equal(parts.length, 4, "preamble, text part, html part, and the closing delimiter's tail");
  const decodePart = (part) => Buffer.from(part.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(decodePart(parts[1]), "Hello & welcome");
  assert.equal(decodePart(parts[2].split("--")[0]), "<p>Hello &amp; welcome</p>");

  // A reply-to is included only when supplied and valid; name quoting escapes.
  const replied = buildMessage({
    from: "no-reply@example.test", to: "operator@example.test", subject: "s",
    html: "<p>x</p>", replyTo: "visitor@example.test", replyName: 'Ada "Lovelace"',
  });
  assert.match(replied.payload, /^Reply-To: "Ada \\"Lovelace\\"" <visitor@example\.test>\r\n/m);
  const injected = buildMessage({
    from: "no-reply@example.test", to: "operator@example.test", subject: "s",
    html: "<p>x</p>", replyTo: "visitor@example.test\r\nBcc: x@y.test",
  });
  assert.doesNotMatch(injected.payload, /Bcc:/, "an invalid reply-to is dropped, never injected");

  assert.equal(formatAddress("a@b.test", "One\r\nTwo"), '"One Two" <a@b.test>');
  assert.throws(() => buildMessage({ from: "not-an-address", to: "a@b.test", subject: "s", html: "x" }), /sender/);
  assert.throws(() => buildMessage({ from: "a@b.test", to: "nope", subject: "s", html: "x" }), /recipient/);
});

// ------------------------------------------------------------------------ refusals

test("MAIL legacy's refusals come back in legacy's order and words", async () => {
  const { factory, calls } = recordingTransport();

  const disabled = createMailService({ config: loadMail({ VP_SMTP_ENABLED: "0" }), transportFactory: factory });
  assert.deepEqual(await disabled.send({ to: "operator@example.test", subject: "s", html: "x" }), {
    ok: false, message: MAIL_MESSAGES.disabled,
  });
  assert.equal(calls.length, 0, "a disabled mailer never constructs a transport");

  const noCredentials = createMailService({
    config: { ...loadMail(), user: "", pass: "" },
    transportFactory: factory,
  });
  assert.deepEqual(await noCredentials.send({ to: "operator@example.test", subject: "s", html: "x" }), {
    ok: false, message: MAIL_MESSAGES.noCredentials,
  });

  const noSender = createMailService({
    config: { ...loadMail(), fromEmail: "" },
    transportFactory: factory,
  });
  assert.deepEqual(await noSender.send({ to: "operator@example.test", subject: "s", html: "x" }), {
    ok: false, message: MAIL_MESSAGES.noSender,
  });

  const configured = createMailService({ config: loadMail(), transportFactory: factory });
  assert.deepEqual(await configured.send({ to: "not an address", subject: "s", html: "x" }), {
    ok: false, message: MAIL_MESSAGES.invalidRecipient,
  }, "the recipient is checked before the transport, exactly as Mailer::send did");
  assert.equal(calls.length, 0);
});

test("MAIL the summary is credential-free and the send returns legacy's sentence", async () => {
  const { factory, calls } = recordingTransport();
  const mail = createMailService({ config: loadMail(), transportFactory: factory, now: () => Date.parse("2026-10-17T12:00:00.000Z") });

  const summary = mail.configSummary();
  assert.deepEqual(Object.keys(summary).sort(), [
    "crypto", "enabled", "fromEmail", "fromName", "host", "passwordConfigured", "port", "protocol", "usernameConfigured",
  ]);
  assert.equal(summary.passwordConfigured, true);
  assert.equal(summary.usernameConfigured, true);
  assert.ok(!JSON.stringify(summary).includes("smtp-secret-pass"), "the password never reaches a summary");
  assert.equal(summary.protocol, "smtp");

  const result = await mail.send({ to: "operator@example.test", subject: "Hello", html: "<p>Hi</p>", text: "Hi" });
  assert.deepEqual(result, { ok: true, message: "Message accepted for delivery to operator@example.test." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.from, "no-reply@example.test");
  assert.equal(calls[0].message.to, "operator@example.test");
  assert.equal(calls[0].settings.pass, "smtp-secret-pass", "the transport is handed the credentials, and only the transport");

  const test = await mail.sendTest({ to: "operator@example.test", variant: "plain" });
  assert.equal(test.ok, true);
  assert.equal(calls[1].message.subject, "WINDELS AI WORKFORCE — test email (plain)");
  assert.match(calls[1].message.text, /Protocol: smtp/);
  assert.match(calls[1].message.html, /WINDELS AI WORKFORCE — test email/, "the plain variant still sends the text as the body");
});

test("MAIL a transport failure is reported as a refusal, never thrown and never with a secret", async () => {
  const failing = createMailService({
    config: loadMail(),
    transportFactory: () => ({ async send() { return { ok: false, error: { code: "ECONNREFUSED" }, transcript: ["250 ok", "smtp-secret-pass"] }; } }),
  });
  const result = await failing.send({ to: "operator@example.test", subject: "s", html: "x" });
  assert.equal(result.ok, false);
  assert.match(result.message, /^The SMTP server did not accept the message\. /);
  assert.match(result.message, /Could not connect to the SMTP host\/port/);
  assert.ok(!result.message.includes("smtp-secret-pass"), "the transcript is scrubbed before a person sees it");

  assert.match(shortError({ code: "STARTTLS_UNAVAILABLE" }), /does not offer STARTTLS/);
  assert.match(shortError({ code: "AUTH_UNSUPPORTED" }), /no supported authentication mechanism/);
  assert.equal(shortError({ code: 550 }, ["550 5.7.1 Rejected"]), 'SMTP responded "550 5.7.1 Rejected".');
  assert.equal(shortError({}, []), MAIL_MESSAGES.transport);

  const throwing = createMailService({
    config: loadMail(),
    transportFactory: () => ({ send() { throw new Error("factory exploded"); } }),
  });
  const thrown = await throwing.send({ to: "operator@example.test", subject: "s", html: "x" });
  assert.equal(thrown.ok, false);
  assert.match(thrown.message, /^The SMTP server did not accept the message\./);
});

// ------------------------------------------------------------------ real socket

test("MAIL the transport speaks SMTP to a real socket and the server receives the message", async (t) => {
  const server = await startSmtpServer();
  t.after(() => server.close());

  const transport = createSmtpTransport({
    host: "127.0.0.1",
    port: server.port,
    crypto: "",
    user: "mailer@example.test",
    pass: "smtp-secret-pass",
    timeoutMs: 5_000,
  });

  const result = await transport.send({
    from: "no-reply@example.test",
    fromName: "WINDELS AI WORKFORCE",
    to: "operator@example.test",
    subject: "Protocol test — plain",
    html: "<p>Hello</p>",
    text: ".a text line that starts with a dot\nsecond line",
  });
  assert.equal(result.ok, true, JSON.stringify(result.error?.message));

  assert.equal(server.messages.length, 1);
  const received = server.messages[0];
  assert.match(received.from, /^FROM:<no-reply@example\.test>$/);
  assert.deepEqual(received.rcpt, ["TO:<operator@example.test>"]);
  assert.match(received.data, /^Subject: /m);
  assert.match(received.data, /^Content-Type: multipart\/alternative/m);
  // Dot-stuffing is undone by the server, so the text part must decode with the
  // leading dot intact.
  const parts = received.data.split(/--[-]+/).filter((part) => part.includes("Content-Type: text/plain"));
  assert.equal(parts.length, 1);
  const body = Buffer.from(parts[0].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(body, ".a text line that starts with a dot\r\nsecond line", "MIME parts carry CRLF");

  // The transcript records the conversation, and the AUTH line is redacted.
  assert.ok(result.transcript.some((line) => line.startsWith("250")), "the server's replies are recorded");
  assert.ok(result.transcript.includes("[credentials redacted]"), "the AUTH line never stores the token");
  assert.ok(!result.transcript.join(" ").includes("smtp-secret-pass"));
});

test("MAIL the transport reports an authentication refusal and a refused recipient", async (t) => {
  const rejectingAuth = await startSmtpServer({ rejectAuth: true });
  t.after(() => rejectingAuth.close());
  const authFailure = await createSmtpTransport({
    host: "127.0.0.1", port: rejectingAuth.port, crypto: "", user: "mailer@example.test", pass: "wrong", timeoutMs: 5_000,
  }).send({ from: "no-reply@example.test", to: "operator@example.test", subject: "s", html: "<p>x</p>" });
  assert.equal(authFailure.ok, false);
  assert.equal(authFailure.error?.code, 535);
  assert.match(shortError(authFailure.error, authFailure.transcript), /^SMTP responded "535 /);

  const rejectingRcpt = await startSmtpServer({ rejectRcpt: true });
  t.after(() => rejectingRcpt.close());
  const rcptFailure = await createSmtpTransport({
    host: "127.0.0.1", port: rejectingRcpt.port, crypto: "", user: "mailer@example.test", pass: "smtp-secret-pass", timeoutMs: 5_000,
  }).send({ from: "no-reply@example.test", to: "operator@example.test", subject: "s", html: "<p>x</p>" });
  assert.equal(rcptFailure.ok, false);
  assert.equal(rcptFailure.error?.code, 550);
  assert.equal(rejectingRcpt.messages.length, 0, "a refused recipient means no message was ever sent");
});

test("MAIL a TLS configuration refuses to downgrade, and a dead port is a connection failure", async (t) => {
  const plainOnly = await startSmtpServer();
  t.after(() => plainOnly.close());
  const downgrade = await createSmtpTransport({
    host: "127.0.0.1", port: plainOnly.port, crypto: "tls", user: "mailer@example.test", pass: "smtp-secret-pass", timeoutMs: 5_000,
  }).send({ from: "no-reply@example.test", to: "operator@example.test", subject: "s", html: "<p>x</p>" });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.error?.code, "STARTTLS_UNAVAILABLE");
  assert.equal(plainOnly.messages.length, 0, "nothing was sent over the unencrypted connection");

  // Grab an ephemeral port, close the listener, and let the client dial the hole.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const dead = await createSmtpTransport({
    host: "127.0.0.1", port: deadPort, crypto: "", user: "mailer@example.test", pass: "smtp-secret-pass", timeoutMs: 2_000,
  }).send({ from: "no-reply@example.test", to: "operator@example.test", subject: "s", html: "<p>x</p>" });
  assert.equal(dead.ok, false);
  assert.equal(dead.error?.code, "ECONNREFUSED");
});

// ---------------------------------------------------------------- HTTP surface

test("MAIL the administrator mail routes are super-admin only and audit a test send", async (t) => {
  const server = await startSmtpServer();
  t.after(() => server.close());
  const app = await createFileStoreApp({
    configOverrides: {
      env: {
        VP_SMTP_ENABLED: "1",
        VP_SMTP_HOST: "127.0.0.1",
        VP_SMTP_PORT: String(server.port),
        VP_SMTP_CRYPTO: "none",
        VP_SMTP_USER: "mailer@example.test",
        VP_SMTP_PASS: "smtp-secret-pass",
        VP_MAIL_FROM: "no-reply@example.test",
      },
    },
  });
  t.after(() => app.cleanup());

  const anonymous = await app.app.inject({ method: "GET", url: "/api/v1/admin/mail" });
  assert.equal(anonymous.statusCode, 401);

  // A signed-in member without system.super_admin is refused, not shown the panel.
  await app.store.createUser({
    username: "member1",
    email: "member1@example.test",
    passwordHash: await bcrypt.hash("Member one password", 4),
    displayName: "Member One",
  });
  const member = await signIn(app.app, "member1", "Member one password");
  const denied = await app.app.inject({ method: "GET", url: "/api/v1/admin/mail", headers: { cookie: member.cookie } });
  assert.equal(denied.statusCode, 403);

  const admin = await signIn(app.app, "rootadmin", "Root administrator pass");
  const summary = await app.app.inject({ method: "GET", url: "/api/v1/admin/mail", headers: { cookie: admin.cookie } });
  assert.equal(summary.statusCode, 200);
  const body = summary.json();
  assert.equal(body.summary.enabled, true);
  assert.equal(body.transport, "smtp");
  assert.equal(body.summary.passwordConfigured, true);
  assert.ok(!JSON.stringify(body).includes("smtp-secret-pass"), "no route ever returns the password");
  assert.deepEqual(body.variants, ["html", "plain"]);

  const invalid = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/mail/test",
    headers: admin.headers,
    payload: { to: "not-an-address" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.message, "Enter a valid recipient email address.");

  const sent = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/mail/test",
    headers: admin.headers,
    payload: { to: "operator@example.test", variant: "html" },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(
    { ok: sent.json().ok, message: sent.json().message, variant: sent.json().variant },
    { ok: true, message: "Message accepted for delivery to operator@example.test.", variant: "html" },
  );
  assert.equal(server.messages.length, 1);
  assert.match(server.messages[0].data, /^Subject: =\?UTF-8\?B\?/m);

  const audit = await app.store.listAuditEvents({ action: "ADMIN_TEST_EMAIL" });
  assert.equal(audit.total, 1, "the audit vocabulary is the legacy one");
  assert.deepEqual(audit.events[0].details, { to: "operator@example.test", ok: true });
});

test("MAIL a disabled mailer answers the legacy sentence and still audits the attempt", async (t) => {
  const app = await createFileStoreApp();
  t.after(() => app.cleanup());
  const admin = await signIn(app.app, "rootadmin", "Root administrator pass");

  const summary = await app.app.inject({ method: "GET", url: "/api/v1/admin/mail", headers: { cookie: admin.cookie } });
  assert.equal(summary.json().transport, "none");
  assert.equal(summary.json().summary.enabled, false);
  assert.match(summary.json().note, /VP_SMTP_ENABLED=1/);

  const refused = await app.app.inject({
    method: "POST",
    url: "/api/v1/admin/mail/test",
    headers: admin.headers,
    payload: { to: "operator@example.test" },
  });
  assert.equal(refused.statusCode, 200, "a server-side refusal is not a malformed request");
  assert.equal(refused.json().ok, false);
  assert.equal(refused.json().message, MAIL_MESSAGES.disabled);

  const audit = await app.store.listAuditEvents({ action: "ADMIN_TEST_EMAIL" });
  assert.equal(audit.total, 1);
  assert.deepEqual(audit.events[0].details, { to: "operator@example.test", ok: false });
});

test("MAIL the contact form's copy goes to the operator with the visitor as Reply-To", async (t) => {
  const server = await startSmtpServer();
  t.after(() => server.close());
  const app = await createFileStoreApp({
    configOverrides: {
      env: {
        VP_SMTP_ENABLED: "1",
        VP_SMTP_HOST: "127.0.0.1",
        VP_SMTP_PORT: String(server.port),
        VP_SMTP_CRYPTO: "none",
        VP_SMTP_USER: "mailer@example.test",
        VP_SMTP_PASS: "smtp-secret-pass",
        VP_MAIL_FROM: "no-reply@example.test",
      },
    },
  });
  t.after(() => app.cleanup());

  const response = await app.app.inject({
    method: "POST",
    url: "/api/v1/site/contact",
    payload: { name: "Ada", email: "ada@example.test", message: "Does outbound mail work on this host?" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mail.sent, true, body.mail.reason);
  assert.equal(body.mail.reason, "Message accepted for delivery to no-reply@example.test.");
  assert.match(body.notice, /If outbound mail is configured, a copy was sent to the site operator\./);
  assert.equal(body.recorded, true, "the inquiry is stored whether or not the copy was sent");

  assert.equal(server.messages.length, 1);
  const sent = server.messages[0];
  assert.deepEqual(sent.rcpt, ["TO:<no-reply@example.test>"]);
  assert.match(sent.data, /^Reply-To: "Ada" <ada@example\.test>\r\n/m);
  assert.match(sent.data, /^Subject: WINDELS AI WORKFORCE contact form\r\n/m);
  const htmlPart = sent.data.split(/--[-]+/).find((part) => part.includes("Content-Type: text/html"));
  const html = Buffer.from(htmlPart.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(html, /New contact message — WINDELS AI WORKFORCE/);
  assert.match(html, /Ada/);
  assert.match(html, /ada@example\.test/);
  assert.match(html, /Does outbound mail work on this host\?/);
});
