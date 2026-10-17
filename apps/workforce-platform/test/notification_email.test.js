/**
 * Row-5 completion, Phase 49 (divergence DV-28): the opt-in email copy of a stored
 * operator notification.
 *
 * Four layers, each tested where it can actually fail:
 *
 *  - configuration (`VP_NOTIFY_EMAIL_*`) — fail-fast parsing, sane defaults, dedupe
 *    of the recipient list, and the boot refusals (invalid address, >10 recipients,
 *    unknown severity), because a silently mis-typed recipient is a silently
 *    un-notified operator;
 *  - the message copy builder — subject shaping, escaping, the honesty disclaimer,
 *    and the bounded detail render;
 *  - the service — with an injected fake mailer: the severity gate, dedupe
 *    suppression of the copy, failure-never-rolls-back guarantees, audit masking,
 *    and the `emailDeliveryAvailable` gate;
 *  - the assembled HTTP app against a real loopback SMTP server — proving the
 *    lift-the-kill-switch path actually emails the operator list when configured.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { createFileStore } from "../src/persistence/file-store.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import {
  DETAIL_RENDER_MAX_CHARS,
  buildNotificationEmail,
  escapeHtml,
  maskEmail,
} from "../src/modules/notifications/email-copy.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";
import { startSmtpServer } from "./smtp-server.js";

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    DB_HOST: "localhost",
    DB_NAME: "windels",
    DB_USER: "app_user",
    DB_PASSWORD: "db-password",
    SESSION_SECRET: "a-secure-session-secret-at-least-32-bytes-long",
    PUBLIC_BASE_URL: "https://node.example.test",
    ...overrides,
  };
}

// --------------------------------------------------------------------- config

test("the listener defaults to off: no flag, no recipients, critical-only severities", () => {
  const { notifyEmail } = loadConfig(validEnv());
  assert.equal(notifyEmail.enabled, false);
  assert.equal(notifyEmail.flag, false);
  assert.deepEqual(notifyEmail.recipients, []);
  assert.deepEqual(notifyEmail.severities, ["critical"], "the most conservative default filters everything but criticals");
});

test("enabled requires the literal 1 AND recipients AND a severity list", () => {
  const flagOnly = loadConfig(validEnv({ VP_NOTIFY_EMAIL_ENABLED: "1" }));
  assert.equal(flagOnly.notifyEmail.enabled, false, "a flag with no recipients cannot deliver");
  const recipientsOnly = loadConfig(validEnv({ VP_NOTIFY_EMAIL_TO: "ops@example.test" }));
  assert.equal(recipientsOnly.notifyEmail.enabled, false, "recipients without the flag cannot deliver");
  const on = loadConfig(validEnv({ VP_NOTIFY_EMAIL_ENABLED: "1", VP_NOTIFY_EMAIL_TO: "ops@example.test" }));
  assert.equal(on.notifyEmail.enabled, true);
  assert.deepEqual(on.notifyEmail.recipients, ["ops@example.test"]);
});

test("recipients are parsed, trimmed, deduplicated, and an invalid entry refuses boot", () => {
  const { notifyEmail } = loadConfig(validEnv({
    VP_NOTIFY_EMAIL_ENABLED: "1",
    VP_NOTIFY_EMAIL_TO: " ops@example.test ,, oncall@example.test , ops@example.test ",
  }));
  assert.deepEqual(notifyEmail.recipients, ["ops@example.test", "oncall@example.test"], "empties dropped, duplicates collapsed");

  assert.throws(
    () => loadConfig(validEnv({ VP_NOTIFY_EMAIL_ENABLED: "1", VP_NOTIFY_EMAIL_TO: "ops@example.test, not-an-address" })),
    /invalid address: not-an-address/,
    "a typo in the operator list is a boot error, not a silently un-notified alert",
  );
});

test("more than ten recipients refuses boot — the list is a deliberate, reviewable size", () => {
  const tooMany = Array.from({ length: 11 }, (_, index) => `ops-${index}@example.test`).join(",");
  assert.throws(
    () => loadConfig(validEnv({ VP_NOTIFY_EMAIL_ENABLED: "1", VP_NOTIFY_EMAIL_TO: tooMany })),
    /at most 10 recipient addresses/,
  );
});

test("severities parse case-insensitively, dedupe, and refuse unknown values", () => {
  const { notifyEmail } = loadConfig(validEnv({
    VP_NOTIFY_EMAIL_ENABLED: "1",
    VP_NOTIFY_EMAIL_TO: "ops@example.test",
    VP_NOTIFY_EMAIL_SEVERITIES: " Critical , INFO ,critical,Warning",
  }));
  assert.deepEqual(notifyEmail.severities, ["critical", "info", "warning"]);

  assert.throws(
    () => loadConfig(validEnv({ VP_NOTIFY_EMAIL_ENABLED: "1", VP_NOTIFY_EMAIL_TO: "ops@example.test", VP_NOTIFY_EMAIL_SEVERITIES: "urgent" })),
    /unknown severity: urgent/,
  );
});

// ----------------------------------------------------------------- email copy

test("maskEmail keeps the first character and the domain, nothing else", () => {
  assert.equal(maskEmail("operator@example.com"), "o***@example.com");
  assert.equal(maskEmail("a@b.co"), "a***@b.co");
  assert.equal(maskEmail(""), "***");
  assert.equal(maskEmail(undefined), "***");
});

test("the copy says it is a copy, carries no action links, and one-lines its subject", () => {
  const { subject, html, text } = buildNotificationEmail({
    type: "KILL_SWITCH",
    severity: "critical",
    title: "Kill switch\nengaged — all orders blocked",
    detail: { reason: "operator action" },
    createdAt: "2026-10-17T09:00:00.000Z",
  });
  assert.equal(subject, "[CRITICAL] Kill switch engaged — all orders blocked — KILL_SWITCH");
  assert.match(html, /copy of an in-product operator notification/);
  assert.match(text, /copy of an in-product operator notification/);
  assert.match(text, /no action is possible from this email/);
  assert.ok(!html.includes("<a ") && !html.includes("href="), "an emailed copy must never carry an actionable link");
  assert.match(html, /KILL_SWITCH/);
  assert.match(text, /Severity: CRITICAL/);
});

test("user-controlled values are HTML-escaped before they reach the body", () => {
  const { html } = buildNotificationEmail({
    type: "ORDER_FILLED",
    severity: "info",
    title: `<img src=x onerror=alert(1)> order ${"<b>"}filled`,
    detail: { note: "<script>alert(1)</script>" },
    createdAt: "2026-10-17T00:00:00.000Z",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(escapeHtml(`&<>"`), "&amp;&lt;&gt;&quot;");
});

test("a worst-case detail is rendered bounded, and the cut is admitted", () => {
  const { html, text, detailTruncated } = buildNotificationEmail({
    type: "PORTFOLIO_RISK",
    severity: "warning",
    title: "Risk alert",
    detail: { payload: "x".repeat(DETAIL_RENDER_MAX_CHARS * 2) },
    createdAt: "2026-10-17T00:00:00.000Z",
  });
  assert.equal(detailTruncated, true);
  assert.ok(html.length < DETAIL_RENDER_MAX_CHARS * 2, "the body itself stays bounded");
  assert.match(text, /truncated: detail exceeded/, "the render says it was cut");

  const small = buildNotificationEmail({ type: "ORDER_FILLED", severity: "info", title: "t", detail: { a: 1 }, createdAt: "" });
  assert.equal(small.detailTruncated, false);
});

// ------------------------------------------------------------- service + fake mail

async function harness(t, { notifyEmail = null, mailResult = { ok: true }, mailThrows = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notify-email-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => store.close());
  const sent = [];
  const calls = [];
  const mail = {
    send: async (message) => {
      calls.push(message);
      if (mailThrows) throw new Error("simulated TLS failure");
      sent.push(message);
      return mailResult;
    },
    configSummary: () => ({
      enabled: true, protocol: "smtp", host: "mail.example.test", port: 587, crypto: "tls",
      fromEmail: "no-reply@example.test", fromName: "WINDELS AI WORKFORCE",
      usernameConfigured: true, passwordConfigured: true,
    }),
  };
  let clock = Date.parse("2026-10-17T09:00:00.000Z");
  const service = createNotificationService({ store, log: { warn() {}, error() {} }, now: () => clock, mail, notifyEmail });
  const auditEvents = async () => (await store.listAuditEvents({ action: "notification.email" })).events;
  return { store, service, sent, calls, auditEvents, advance: (ms) => { clock += ms; } };
}

const ON = Object.freeze({
  enabled: true,
  flag: true,
  recipients: Object.freeze(["ops@example.test", "oncall@example.test"]),
  severities: Object.freeze(["critical", "warning"]),
});

test("a stored alert over the configured severity is emailed once per operator, after it exists", async (t) => {
  const { service, sent } = await harness(t, { notifyEmail: ON });
  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", { reason: "test" }, "kill:1");
  assert.equal(result.created, true);
  assert.deepEqual(result.email, {
    attempted: 2,
    sent: 2,
    failed: 0,
    recipients: ["o***@example.test", "o***@example.test"],
  }, "summary is mask-only");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((message) => message.to).sort(), ["oncall@example.test", "ops@example.test"]);
  assert.equal(sent[0].subject, "[CRITICAL] Kill switch engaged — KILL_SWITCH");
  assert.match(sent[0].html, /copy of an in-product operator notification/);
  assert.match(sent[0].text, /Stored at 2026-10-17T09:00:00.000Z/);
});

test("a severity outside the configured list stores the alert without any send", async (t) => {
  const { service, sent } = await harness(t, { notifyEmail: ON });
  const result = await service.notify("BROKER_CONNECTED", "info", "Broker connected", {}, null);
  assert.equal(result.created, true);
  assert.equal(result.email, undefined, "no `email` field when nothing was attempted");
  assert.equal(sent.length, 0, "info alerts are not paged when the operator asked for critical+warning only");
});

test("dedupe suppresses the email copy exactly as it suppresses the badge", async (t) => {
  const { service, sent, advance } = await harness(t, { notifyEmail: ON });
  const first = await service.notify("PORTFOLIO_RISK", "warning", "Drawdown limit", {}, "risk:3");
  assert.equal(first.created, true);
  assert.equal(sent.length, 2);

  // A recurring scan republishing while unread must not mail-bomb the list.
  for (let index = 0; index < 5; index += 1) {
    advance(60_000);
    const again = await service.notify("PORTFOLIO_RISK", "warning", "Drawdown limit", {}, "risk:3");
    assert.equal(again.deduped, true);
  }
  assert.equal(sent.length, 2, "five suppressed republishes sent nothing further");
});

test("a failed persistence sends nothing — the copy can never outlive the row it copies", async (t) => {
  const { store, service, sent } = await harness(t, { notifyEmail: ON });
  const original = store.createNotification.bind(store);
  store.createNotification = async () => { throw new Error("disk full"); };
  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", {}, "kill:x");
  assert.equal(result.created, false);
  assert.equal(result.error.code, "NOTIFICATION_PERSISTENCE_FAILED");
  assert.equal(sent.length, 0);
  store.createNotification = original;
});

test("a refusal from the mailer changes nothing: the alert is stored, the failure is counted and audited", async (t) => {
  const { store, service, sent } = await harness(t, { notifyEmail: ON, mailResult: { ok: false, message: "Outgoing email is disabled" } });
  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", {}, "kill:2");
  assert.equal(result.created, true, "delivery failure never rolls back the stored alert");
  assert.deepEqual(result.email, { attempted: 2, sent: 0, failed: 2, recipients: ["o***@example.test", "o***@example.test"] });
  assert.equal(sent.length, 2, "both recipients were attempted");

  const audit = await store.listAuditEvents({ action: "notification.email" });
  assert.equal(audit.total, 1);
  const event = audit.events[0];
  assert.equal(event.action, "notification.email");
  assert.equal(event.entityType, "notification");
  assert.equal(event.actor.kind, "system", "delivery is the platform acting, not a named operator");
  assert.equal(event.details.severity, "critical");
  assert.equal(event.details.sent, 0);
  assert.equal(event.details.failed, 2);
  assert.ok(event.details.recipients.every((address) => address.includes("***@")), "the audit trail holds masked addresses only");
  assert.ok(!JSON.stringify(event.details).includes("ops@example.test"), "no full address is persisted anywhere");
});

test("a throwing transport is caught the same way: stored alert stays created, failure is logged", async (t) => {
  const logs = [];
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notify-email-throw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => store.close());
  const service = createNotificationService({
    store,
    log: { warn() {}, error: (entry, message) => logs.push({ entry, message }) },
    mail: { send: async () => { throw new Error("TLS handshake blew up"); }, configSummary: () => ({ enabled: true, fromEmail: "no-reply@example.test", usernameConfigured: true, passwordConfigured: true }) },
    notifyEmail: { ...ON, recipients: Object.freeze(["ops@example.test"]) },
  });
  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", {}, "kill:throw");
  assert.equal(result.created, true);
  assert.equal(result.email.failed, 1);
  assert.equal(result.email.sent, 0);
  assert.ok(logs.some((entry) => /send threw/.test(entry.message)), "the throw was recorded, not raised");
});

test("a service without the opt-in collaborators behaves exactly as before Phase 49", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-notify-email-off-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore({ dir, syncWrites: false, logger: { warn() {} } });
  t.after(() => store.close());
  let called = 0;
  const service = createNotificationService({
    store,
    log: { warn() {}, error() {} },
    mail: { send: async () => { called += 1; return { ok: true }; } },
  });
  const result = await service.notify("KILL_SWITCH", "critical", "Kill switch engaged", {}, "kill:off");
  assert.equal(result.created, true);
  assert.equal(result.email, undefined, "no delivery vocabulary leaks into the pre-Phase-49 shape");
  assert.equal(called, 0, "a mailer passed without the opt-in is never used");
});

test("broadcast and targeted alerts both email the single operator list", async (t) => {
  const { store, service, sent } = await harness(t, { notifyEmail: ON });
  const operator = await store.createUser({ username: "target", email: "target@example.test", passwordHash: "x", displayName: "Target" });
  const broadcast = await service.notify("PORTFOLIO_RISK", "warning", "Broadcast risk", {}, "risk:b");
  assert.equal(broadcast.notification.broadcast, true);
  const targeted = await service.notify("TRADE_APPROVAL_REQUESTED", "critical", "Approval needed", {}, null, operator.id);
  assert.equal(targeted.notification.userId, operator.id);
  assert.equal(sent.length, 4, "two alerts × two operators");
  assert.ok(sent.every((message) => ON.recipients.includes(message.to)), "recipient is never the targeted user — the list is the list");
});

test("emailDeliveryAvailable is an AND gate: opt-in AND complete SMTP configuration", async (t) => {
  const { service } = await harness(t, { notifyEmail: ON });
  const ready = service.statusSnapshot();
  assert.equal(ready.emailDeliveryAvailable, true);
  assert.deepEqual(ready.deliveryChannels, ["in-product", "email-copy"]);
  assert.match(ready.reason, /opt-in copy/);
  assert.match(ready.reason, /critical, warning/);

  // Each clause missing disables the badge, honestly.
  const noPassword = createNotificationService({
    store: null,
    mail: { send: async () => ({ ok: true }), configSummary: () => ({ enabled: true, fromEmail: "no-reply@example.test", usernameConfigured: true, passwordConfigured: false }) },
    notifyEmail: ON,
  });
  assert.equal(noPassword.statusSnapshot().emailDeliveryAvailable, false);

  const noSender = createNotificationService({
    store: null,
    mail: { send: async () => ({ ok: true }), configSummary: () => ({ enabled: true, fromEmail: "", usernameConfigured: true, passwordConfigured: true }) },
    notifyEmail: ON,
  });
  assert.equal(noSender.statusSnapshot().emailDeliveryAvailable, false);

  const noTransport = createNotificationService({ store: null, mail: null, notifyEmail: ON });
  assert.equal(noTransport.statusSnapshot().emailDeliveryAvailable, false);

  const noOptIn = createNotificationService({
    store: null,
    mail: { send: async () => ({ ok: true }), configSummary: () => ({ enabled: true, fromEmail: "no-reply@example.test", usernameConfigured: true, passwordConfigured: true }) },
    notifyEmail: { enabled: false, flag: false, recipients: Object.freeze([]), severities: Object.freeze(["critical"]) },
  });
  const offSnapshot = noOptIn.statusSnapshot();
  assert.equal(offSnapshot.emailDeliveryAvailable, false);
  assert.deepEqual(offSnapshot.deliveryChannels, ["in-product"]);
  assert.match(offSnapshot.reason, /is off/);
});

// ---------------------------------------------------------------- the assembled app

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = cookieFrom(response);
  return { cookie, csrf: response.json().csrfToken, headers: { cookie, "x-csrf-token": response.json().csrfToken } };
}

test("a configured host emails the kill-switch alert through a real SMTP conversation and audits it", async (t) => {
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
        VP_NOTIFY_EMAIL_ENABLED: "1",
        VP_NOTIFY_EMAIL_TO: "ops@example.test, oncall@example.test",
      },
    },
  });
  t.after(() => app.cleanup());

  // The status surface now advertises the channel, because it can actually send.
  const status = await app.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json();
  assert.equal(statusBody.notifications.emailDeliveryAvailable, true);
  assert.deepEqual(statusBody.notifications.deliveryChannels, ["in-product", "email-copy"]);

  const admin = await signIn(app.app);
  // The platform boots stopped, so re-affirming `active: true` changes nothing and
  // publishes nothing; release first, then engage, for a real transition.
  const release = await app.app.inject({
    method: "POST",
    url: "/api/v1/trading/kill-switch",
    headers: admin.headers,
    payload: { active: false },
  });
  assert.equal(release.statusCode, 200, release.body);
  assert.equal(release.json().changed, true, "the boot state was engaged");
  assert.equal(server.messages.length, 0, "the release is an info alert and the default filter is critical-only");

  const flip = await app.app.inject({
    method: "POST",
    url: "/api/v1/trading/kill-switch",
    headers: admin.headers,
    payload: { active: true, reason: "phase49 drill" },
  });
  assert.equal(flip.statusCode, 200, flip.body);
  assert.equal(flip.json().changed, true);
  assert.equal(flip.json().killSwitch.active, true);

  // Two operator copies went down the wire — one envelope per recipient.
  assert.equal(server.messages.length, 2);
  const envelopes = server.messages.map((message) => message.rcpt.join(" "));
  assert.deepEqual(envelopes.sort(), ["TO:<oncall@example.test>", "TO:<ops@example.test>"]);
  assert.ok(server.messages.every((message) => /^FROM:<no-reply@example\.test>$/i.test(message.from)));

  /** Decode the one encoded-word subject header a messageDATA carries. */
  const subjectOf = (data) => {
    const match = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/i.exec(data);
    return match ? Buffer.from(match[1], "base64").toString("utf8") : null;
  };
  /** Decode the base64 part of a given content-type out of one message body. */
  const partOf = (data, contentType) => {
    const marker = `Content-Type: ${contentType}`;
    const index = data.indexOf(marker);
    assert.notEqual(index, -1, `the message carries a ${contentType} part`);
    const bodyStart = data.indexOf("\r\n\r\n", index) + 4;
    const encoded = data.slice(bodyStart).split("\r\n").filter((line) => /^[A-Za-z0-9+/=]+$/.test(line)).join("");
    return Buffer.from(encoded, "base64").toString("utf8");
  };

  for (const message of server.messages) {
    assert.equal(subjectOf(message.data), "[CRITICAL] KILL SWITCH ACTIVATED — all order placement blocked — KILL_SWITCH");
    const text = partOf(message.data, "text/plain");
    assert.match(text, /copy of an in-product operator notification/);
    assert.match(text, /no action is possible from this email/);
    const html = partOf(message.data, "text/html");
    assert.ok(!html.includes("href="), "the copy links nowhere — governance happens signed-in only");
  }

  const audit = await app.store.listAuditEvents({ action: "notification.email" });
  assert.equal(audit.total, 1, "one delivery event, not one per recipient");
  assert.equal(audit.events[0].details.sent, 2);
  assert.equal(audit.events[0].details.failed, 0);
  assert.equal(audit.events[0].details.type, "KILL_SWITCH");
  assert.ok(!JSON.stringify(audit.events[0].details).includes("ops@example.test"), "audit carries masked addresses only");
});

test("without the opt-in the assembled host advertises no delivery channel beyond the inbox", async (t) => {
  const app = await createFileStoreApp();
  t.after(() => app.cleanup());
  const status = await app.app.inject({ method: "GET", url: "/api/v1/system/status" });
  const statusBody = status.json();
  assert.equal(statusBody.notifications.emailDeliveryAvailable, false);
  assert.deepEqual(statusBody.notifications.deliveryChannels, ["in-product"]);
  assert.match(statusBody.notifications.reason, /is off/);
});
