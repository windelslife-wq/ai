/**
 * The administrator control centre against the API it reads (row 3, Phase 35).
 *
 * `views/admin/index.php` → `Admin::index` is legacy's privileged page: four
 * statistics, the access policy, the user directory, the SMTP panel (ported in row 5) and the
 * feature-readiness table. The port split it — the directory has been at
 * `/app/admin/users` since the identity slice, and this screen is the rest.
 *
 * The suite has two jobs beyond the usual contract checks, because this screen's
 * failure modes are specific:
 *
 *  1. **The panel must describe the policy the server enforces.** `ACCESS_POLICY`
 *     carries machine-readable role and permission keys, and every claim is
 *     asserted against `ROLE_GRANTS`/`PLATFORM_PERMISSIONS` (the Node mirror of
 *     `tools/rbac.php`) and against the grants the seeded store actually holds.
 *  2. **The wiring must reach the API.** The directory shipped with a hard-coded
 *     role list (`member`, `analyst`, `operator`, `supervisor`,
 *     `compliance_officer`, `admin`) — six values `POST /admin/users` refuses — and
 *     a status button that sent `suspended`, which `USER_STATUS_UPDATE` also
 *     refuses. Both are pinned here so the form can only offer what the server
 *     accepts.
 *
 * Hermetic like the other client suites: the file adapter, `createFileStoreApp`,
 * no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACCESS_POLICY, ACCEPTANCE_TONES, ACTIVATE_LABEL, ADMIN_COPY, ADMIN_PERMISSION, ADMIN_READS, ADMIN_STATS,
  DEACTIVATE_LABEL, LANGUAGE_STAT_NOTE, MAIL_PANEL, ROLE_LABELS, USER_STATUS,
  acceptanceTone, featureRows, holdsPermission, legendRows, mailPanelState, mailSummaryRows, roleOptions,
  statCards, strategyShape, unassignableRoles,
} from "../client/src/admin.js";
import { MODULE_STATUS } from "../src/modules/platform/health.js";
import { ADMIN_ROLES } from "../src/modules/identity/contracts.js";
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, ROLE_GRANTS, seedPlatformBaseline } from "../src/db/platform-baseline.js";
import { hashPassword } from "../src/security/passwords.js";
import { cookieFrom, createFileStoreApp } from "./helpers.js";

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const LEGACY_ADMIN_VIEW = path.resolve(import.meta.dirname, "..", "..", "..", "application", "views", "admin", "index.php");

async function adminInstance(t, env = {}) {
  const instance = await createFileStoreApp({ configOverrides: { env: { MARKET_DATA_REAL_PROVIDERS: "0", ...env } } });
  t.after(() => instance.cleanup());
  return instance;
}

/**
 * The same instance, seeded with the platform's real baseline (`tools/rbac.php`'s
 * Node mirror): the eight assignable roles, the whole permission vocabulary and
 * the legacy-schema `user` role. The generic test helper seeds only two roles, so
 * the policy panel and the role list are asserted against the deployment shape.
 */
async function platformInstance(t) {
  const instance = await adminInstance(t);
  await seedPlatformBaseline(instance.store, { logger: { warn() {}, info() {} } });
  return instance;
}

async function signIn(instance, { identifier, password }) {
  const response = await instance.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": body.csrfToken }, user: body.user, permissions: body.permissions };
}

const rootSession = (instance) => signIn(instance, { identifier: "rootadmin", password: "Root administrator pass" });

/** A signed-in member with no role grants: `platform_member` is seeded empty here. */
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

const get = (instance, url, headers) => instance.app.inject({ method: "GET", url, headers: headers || instance.headers });

// ------------------------------------------------------------- the page's text

test("the page's heading, lede and policy list are the legacy view's own words", () => {
  const legacy = readFileSync(LEGACY_ADMIN_VIEW, "utf8");
  assert.ok(legacy.includes("Restricted area"), "the eyebrow");
  assert.ok(legacy.includes("Administrator control center"), "the heading");
  assert.ok(legacy.includes("Manage users and inspect platform readiness."), "the lede");
  assert.equal(ADMIN_COPY.eyebrow, "Restricted area");
  assert.equal(ADMIN_COPY.title, "Administrator control center");
  assert.match(ADMIN_COPY.lede, /^Manage users and inspect platform readiness\. Privileged actions require a super administrator and a CSRF token\.$/);
  assert.equal(ADMIN_COPY.policyTitle, "Access policy");
  assert.equal(ADMIN_COPY.readinessTitle, "Platform feature readiness");
  // Legacy's `.policy-list` lines, in legacy's order, each still described the same way.
  const titles = ACCESS_POLICY.map((entry) => entry.title);
  assert.deepEqual(titles, ["Super administrator", "Trading operator", "Sports administrator", "Lottery administrator", "Viewer roles", "Platform member"]);
  for (const [title, detail] of [
    ["Super administrator", "All platform permissions"],
    ["Trading operator", "Trading view, control and execution"],
    ["Sports administrator", "Sports provider, approval and settlement controls"],
    ["Lottery administrator", "Lottery viewing, sync and management"],
    ["Viewer roles", "Read-only access to their module"],
  ]) {
    assert.equal(ACCESS_POLICY.find((entry) => entry.title === title).detail, detail, `${title} reads as the legacy panel wrote it`);
  }
  // The one line legacy's panel could not carry: the role the create form defaults to.
  assert.match(ACCESS_POLICY.find((entry) => entry.key === "platform_member").detail, /Signed-in baseline/);
  assert.equal(ADMIN_PERMISSION, "system.super_admin", "legacy's requireAdmin() called can($user, 'system.super_admin')");
});

test("the policy panel describes the grants the server enforces", () => {
  for (const entry of ACCESS_POLICY) {
    for (const role of entry.roles) {
      assert.ok(PLATFORM_ROLES.some((candidate) => candidate.key === role.key), `${role.key} is a role this platform seeds`);
      const seeded = ROLE_GRANTS[role.key];
      assert.ok(seeded, `${role.key} has seeded grants`);
      if (role.permissions === null) {
        // The super administrator's row says "all platform permissions" and it is
        // granted every key in the vocabulary, which is also what the service's
        // short-circuit makes true at runtime.
        assert.deepEqual([...seeded].sort(), PLATFORM_PERMISSIONS.map((permission) => permission.key).sort(), "the super administrator holds the whole vocabulary");
      } else {
        assert.deepEqual([...role.permissions].sort(), [...seeded].sort(), `${role.key}: the panel and the seeded grant agree`);
      }
      for (const permission of role.permissions || []) {
        assert.ok(PLATFORM_PERMISSIONS.some((entry2) => entry2.key === permission), `${permission} is a real permission key`);
      }
    }
  }
  // Every seeded role is described by the panel or explicitly declared unassignable.
  const described = new Set(ACCESS_POLICY.flatMap((entry) => entry.roles.map((role) => role.key)));
  for (const role of PLATFORM_ROLES) {
    if (role.key === "user") continue; // the legacy-schema role, listed through `unassignableRoles`
    assert.ok(described.has(role.key), `${role.key} is covered by the access policy panel`);
  }
  // The create form may only offer what the API accepts.
  assert.deepEqual([...ADMIN_ROLES], ["super_admin", "sports_admin", "sports_viewer", "trading_operator", "trading_viewer", "lottery_admin", "lottery_viewer", "platform_member"]);
  for (const key of ADMIN_ROLES) assert.ok(ROLE_LABELS[key], `${key} has a legacy label`);
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), [...ADMIN_ROLES].sort(), "the labels cover exactly the assignable roles");
});

// ------------------------------------------------------- the four statistics

test("the statistics are legacy's four cards, and an unloaded source renders an em dash", () => {
  assert.deepEqual(ADMIN_STATS.map((stat) => stat.label), ["Users", "Strategies", "Languages", "Lottery draws"]);
  assert.deepEqual(ADMIN_STATS.map((stat) => stat.caption), ["accounts in database", "versioned implementations", "registry entries", "verified or sandbox rows"]);
  const legacy = readFileSync(LEGACY_ADMIN_VIEW, "utf8");
  for (const caption of ADMIN_STATS.map((stat) => stat.caption)) assert.ok(legacy.includes(caption), `${caption} is legacy's caption`);

  const cards = statCards({ permissions: [ADMIN_PERMISSION] });
  const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
  assert.equal(byKey.languages.value, "—", "an unloaded language registry renders an em dash");
  assert.equal(byKey.languages.note, LANGUAGE_STAT_NOTE);
  assert.match(byKey.languages.note, /row 16/);
  // A source that was not read is never printed as a number.
  assert.equal(byKey.users.value, "—");
  assert.equal(byKey.strategies.value, "—");
  assert.equal(byKey.lotteryDraws.value, "—");
  for (const card of cards) assert.ok(!/^0$/.test(card.value), `${card.key} must not fabricate a zero`);
});

test("a count is printed only from the payload that carries it, and legacy's strategy count is versions", () => {
  const users = { users: [{ id: 1 }], meta: { total: 7, limit: 1, offset: 0 } };
  const strategies = { strategies: [{ strategyId: "a", versions: [{}, {}] }, { strategyId: "b", versions: [{}] }] };
  const languages = { languages: { en: { code: "en" }, fr: { code: "fr" }, es: { code: "es" }, de: { code: "de" } } };
  const lottery = { drawsTracked: 2, activeLottery: "eurojackpot" };
  const cards = statCards({ permissions: ["identity.users.view"], users, strategies, languages, lottery });
  const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
  assert.equal(byKey.users.value, "7", "the directory's total, not the page length");
  assert.match(byKey.users.note, /Every account row/);
  assert.equal(byKey.strategies.value, "3", "legacy counted rows, not strategies");
  assert.match(byKey.strategies.note, /3 version rows across 2 strategies/);
  assert.equal(byKey.languages.value, "4", "counts the authored language registry entries");
  assert.match(byKey.languages.note, /4 authored languages in the registry/);
  assert.equal(byKey.lotteryDraws.value, "2");
  assert.match(byKey.lotteryDraws.note, /eurojackpot/);

  // A member without `identity.users.view` never sees a count for the read the
  // server would refuse, and is told which permission stood there.
  const gated = Object.fromEntries(statCards({ permissions: [], users, strategies, lottery }).map((card) => [card.key, card]));
  assert.equal(gated.users.value, "—");
  assert.match(gated.users.note, /identity\.users\.view/);
  assert.equal(gated.strategies.value, "3", "the strategy list is session-only, so it still resolves");

  // ...and the super-admin shortcut is mirrored rather than ignored: the server
  // answers this read for a super administrator however the grant row is shaped.
  assert.deepEqual(holdsPermission([ADMIN_PERMISSION], "identity.users.view"), true);
  assert.deepEqual(holdsPermission(["identity.users.view"], "identity.users.view"), true);
  assert.deepEqual(holdsPermission([], "identity.users.view"), false);
  assert.deepEqual(holdsPermission(null, "identity.users.view"), false);
  assert.deepEqual(holdsPermission([], null), true, "a route with no permission is open to any session");
  assert.equal(Object.fromEntries(statCards({ permissions: [ADMIN_PERMISSION], users, strategies, lottery }).map((card) => [card.key, card])).users.value, "7");

  assert.deepEqual(strategyShape(null), null);
  assert.deepEqual(strategyShape({ strategies: [] }), { implementations: 0, versions: 0 });
  assert.equal(strategyShape({ strategies: "nope" }), null);
});

// ----------------------------------------------------------- readiness table

test("the readiness table is the ledger itself, with the server's own legend", () => {
  const rows = featureRows(MODULE_STATUS);
  assert.equal(rows.length, MODULE_STATUS.length);
  for (const row of rows) {
    assert.equal(row.stateLabel, row.state);
    assert.equal(row.tone, ACCEPTANCE_TONES[row.state]);
    assert.ok(row.label.length > 0, `${row.key} has a label`);
    assert.equal(typeof row.tests, "string");
  }
  // Phase 46 ported `languageLearning` (row 16), so every module in MODULE_STATUS now
  // declares its test suites.
  const withoutTests = rows.filter((row) => row.tests === "").map((row) => row.key);
  assert.deepEqual(withoutTests, []);
  assert.match(readFileSync(path.join(CLIENT, "views.jsx"), "utf8"), /\{row\.tests \|\| "not stated"\}/);
  for (const row of rows) {
  }
  // The tones are the shell's own badge classes, and the three states the ledger
  // uses all have one.
  assert.deepEqual(ACCEPTANCE_TONES, { ported: "badge-live", partial: "badge-amber", "not-ported": "badge-muted" });
  assert.equal(acceptanceTone("nonsense"), "badge-gray");

  // The legend is the server's text, not a client paraphrase.
  const legend = { ported: "implemented and tested on Node", partial: "some behaviour ported", "not-ported": "only the legacy application provides this" };
  assert.deepEqual(legendRows(legend), [
    { state: "ported", text: legend.ported, tone: "badge-live" },
    { state: "partial", text: legend.partial, tone: "badge-amber" },
    { state: "not-ported", text: legend["not-ported"], tone: "badge-muted" },
  ]);
  assert.deepEqual(legendRows(null), []);

  // Legacy's own table said TESTED / IMPLEMENTED / PLANNED about the PHP build;
  // the port records that decision rather than reusing statuses it cannot support.
  const legacy = readFileSync(LEGACY_ADMIN_VIEW, "utf8");
  assert.ok(legacy.includes("Platform feature readiness"));
  assert.ok(!Object.keys(ACCEPTANCE_TONES).includes("TESTED"));
});

// ------------------------------------------------------------- the SMTP panel

test("the SMTP panel renders the server's credential-free summary and its two states", () => {
  assert.equal(MAIL_PANEL.title, "Email / SMTP");
  assert.equal(MAIL_PANEL.submitLabel, "Send test email");
  assert.deepEqual(MAIL_PANEL.variants.map((option) => option.value), ["html", "plain"], "legacy's two formats");

  const rows = mailSummaryRows({
    enabled: true, protocol: "smtp", host: "mail.example.test", port: 587, crypto: "tls",
    fromEmail: "no-reply@example.test", fromName: "WINDELS AI WORKFORCE",
    usernameConfigured: true, passwordConfigured: true,
  });
  assert.deepEqual(rows.map((row) => row.label), ["Status", "Protocol", "Host", "Port", "Encryption", "From", "Username", "Password"]);
  assert.equal(rows.find((row) => row.key === "status").value, "Enabled");
  assert.equal(rows.find((row) => row.key === "encryption" || row.key === "crypto").value, "TLS");
  assert.equal(rows.find((row) => row.key === "from").value, "no-reply@example.test (WINDELS AI WORKFORCE)");
  assert.equal(rows.find((row) => row.key === "password").value, "Configured (never shown)", "the panel says a password exists, never what it is");

  // A disabled mailer renders dashes, not zeros, and every blank field is an em dash.
  const off = mailSummaryRows({ enabled: false, protocol: "disabled", host: "", port: 587, crypto: "", fromEmail: "", fromName: "", usernameConfigured: false, passwordConfigured: false });
  assert.equal(off.find((row) => row.key === "status").value, "Disabled");
  assert.equal(off.find((row) => row.key === "protocol").value, "disabled");
  assert.equal(off.find((row) => row.key === "host").value, "—");
  assert.equal(off.find((row) => row.key === "crypto").value, "None");
  assert.equal(off.find((row) => row.key === "from").value, "—");
  assert.equal(off.find((row) => row.key === "password").value, "Not configured");

  assert.equal(mailPanelState({ enabled: true }).tone, "badge-live");
  assert.equal(mailPanelState({ enabled: false }).tone, "badge-muted");
  assert.equal(mailPanelState(null).label, "Disabled");

  // The panel is the ported one now: the view reads the route and posts the form.
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.match(views, /endpoints\.adminMail\(\)/);
  assert.match(views, /endpoints\.adminTestEmail\(mailForm\)/);
  assert.match(views, /id="smtp-to"/);
  assert.match(views, /id="smtp-variant"/);
  assert.doesNotMatch(views, /SMTP_PANEL/, "the not-ported panel is gone");

  // Legacy's panel was a live SMTP send and the route it posted to is named here.
  const legacy = readFileSync(LEGACY_ADMIN_VIEW, "utf8");
  assert.ok(legacy.includes("/admin/test-email"), "legacy's panel posted a real test send");
});

// --------------------------------------------------------- the routes behind it

test("every read is a registered route with the permission the server enforces", async (t) => {
  const instance = await adminInstance(t);
  const inventory = (await get(instance, "/api/v1/system/routes")).json().routes;

  for (const read of ADMIN_READS) {
    const route = inventory.find((entry) => entry.method === read.method && entry.path === read.path);
    assert.ok(route, `${read.path} must be registered`);
    assert.equal(route.permission, read.permission, `${read.path} is declared with the wrong permission`);
    assert.equal(route.auth, read.auth, `${read.path} session requirement`);
  }
  // The two administration reads are the same gate the directory uses; the language
  // and lottery reads carry their modules' sign-in baseline; the strategy list and
  // the two ledger reads need a session or nothing at all.
  assert.deepEqual(ADMIN_READS.filter((read) => read.permission).map((read) => read.key), ["users", "roles", "languages", "lottery", "mail"]);
  assert.equal(ADMIN_READS.find((read) => read.key === "users").permission, "identity.users.view");
  assert.equal(ADMIN_READS.find((read) => read.key === "languages").permission, "system.authenticated");
  assert.equal(ADMIN_READS.find((read) => read.key === "lottery").permission, "system.authenticated");
  assert.equal(ADMIN_READS.find((read) => read.key === "mail").permission, "system.super_admin");

  // The test send is a POST and is guarded by the same permission; ADMIN_READS
  // covers reads only, so the write is asserted here.
  const testSend = inventory.find((entry) => entry.method === "POST" && entry.path === "/api/v1/admin/mail/test");
  assert.ok(testSend, "the test send must be a registered route");
  assert.equal(testSend.permission, "system.super_admin");
  assert.equal(testSend.auth, true);
  assert.equal(testSend.validated, true, "the recipient body is schema-validated");

  // The screen is declared where the router will find it, gated on legacy's own
  // permission, and it is the view that is rendered.
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  assert.match(app, /path: "\/app\/admin", view: "admin-control-centre", requiresAuth: true, permission: "system\.super_admin"/);
  assert.equal(ADMIN_PERMISSION, "system.super_admin");
  assert.match(app, /"admin-control-centre": <AdminControlCentreView permissions=\{permissions\} \/>/);
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.match(views, /export function AdminControlCentreView\(\{ permissions \}\)/);
  assert.match(views, /\{ to: "\/app\/admin", label: "Control centre", permission: "system\.super_admin" \}/, "the navigation entry carries the same gate");
});

test("the control centre answers for an administrator and refuses a member", async (t) => {
  const instance = await platformInstance(t);
  const root = await rootSession(instance);
  assert.ok(root.permissions.includes(ADMIN_PERMISSION), "the seeded administrator holds the gate legacy used");

  const directory = await get(instance, "/api/v1/admin/users?limit=1", root.headers);
  assert.equal(directory.statusCode, 200, directory.body);
  const roles = await get(instance, "/api/v1/admin/roles", root.headers);
  assert.equal(roles.statusCode, 200, roles.body);
  const assignable = roles.json().assignable;
  assert.deepEqual(assignable, [...ADMIN_ROLES], "the form's options are the server's own list");
  assert.equal(roles.json().permissions.length, PLATFORM_PERMISSIONS.length, "the vocabulary the policy panel counts");
  assert.equal(assignable.length, 8);

  const strategies = await get(instance, "/api/v1/strategies", root.headers);
  assert.equal(strategies.statusCode, 200, strategies.body);
  const lottery = await get(instance, "/api/v1/lottery/status", root.headers);
  assert.equal(lottery.statusCode, 200, lottery.body);
  const status = await get(instance, "/api/v1/system/status");
  assert.equal(status.statusCode, 200, "the ledger is readable without a session, as the status surface has always been");
  assert.equal(status.json().modules.length, MODULE_STATUS.length);
  const features = await get(instance, "/api/v1/system/features");
  assert.equal(features.statusCode, 200);
  const legend = legendRows(features.json().legend);
  assert.equal(legend.length, 3, "the server explains its own three states");

  // A member with nothing granted: the two administration reads are refused with
  // the code the screen's own withholding rule is written against.
  const member = await memberSession(instance);
  for (const url of ["/api/v1/admin/users?limit=1", "/api/v1/admin/roles"]) {
    const refused = await get(instance, url, member.headers);
    assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`);
    assert.equal(refused.json().error.code, "PERMISSION_DENIED");
  }
  assert.equal((await get(instance, "/api/v1/strategies", member.headers)).statusCode, 200, "the strategy list is session-only, so the third card still resolves");
});

test("the portal stores one unassignable role, and the form names it as such", async (t) => {
  const instance = await platformInstance(t);
  const root = await rootSession(instance);
  const roles = (await get(instance, "/api/v1/admin/roles", root.headers)).json();
  const held = roles.roles.map((role) => role.key);
  const assignable = roles.assignable;

  // The seeded store holds exactly the eight assignable roles plus the
  // legacy-schema one the create API refuses.
  for (const key of assignable) assert.ok(held.includes(key), `${key} is held`);
  const extra = held.filter((key) => !assignable.includes(key));
  assert.deepEqual(extra, ["user"], "the legacy-schema role is the only unassignable one");

  const options = roleOptions(assignable, roles.roles);
  assert.deepEqual(options.map((option) => option.value), assignable, "options follow the server's order");
  const byValue = Object.fromEntries(options.map((option) => [option.value, option.label]));
  assert.equal(byValue.super_admin, "Super administrator", "the store's display name wins");
  assert.deepEqual(unassignableRoles(roles.roles, assignable).map((role) => role.key), ["user"]);
  assert.deepEqual(roleOptions(null), [], "no list, no options — never a fabricated default");
});

test("the create form offers only roles the API accepts, and the toggle sends only accepted states", async (t) => {
  const instance = await platformInstance(t);
  const root = await rootSession(instance);
  // The row the toggle acts on: a member account with no grants.
  await memberSession(instance);

  // Every role the form can now offer is accepted by the create route...
  for (const role of ADMIN_ROLES) {
    const created = await instance.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root.headers,
      payload: { email: `${role}@example.test`, displayName: `Probe ${role}`, password: "Correct horse battery staple", role },
    });
    assert.equal(created.statusCode, 201, `${role}: ${created.body}`);
    assert.equal(created.json().role, role);
  }
  // ...and the six the old hard-coded list offered are refused, which is the defect.
  for (const role of ["member", "analyst", "operator", "supervisor", "compliance_officer", "admin"]) {
    const refused = await instance.app.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: root.headers,
      payload: { email: `${role}@example.test`, displayName: `Probe ${role}`, password: "Correct horse battery staple", role },
    });
    assert.equal(refused.statusCode, 400, `${role} must be refused: ${refused.body}`);
    assert.equal(refused.json().error.code, "INVALID_REQUEST");
  }

  // The status route accepts exactly the two words the buttons now send.
  const target = (await get(instance, "/api/v1/admin/users?limit=200", root.headers)).json().users.find((row) => row.username === "member");
  assert.ok(target, "the member row is in the directory");
  const disabled = await instance.app.inject({ method: "PATCH", url: `/api/v1/admin/users/${target.id}/status`, headers: root.headers, payload: { status: USER_STATUS.disabled } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().status, "disabled");
  for (const status of ["suspended", "pending"]) {
    const refused = await instance.app.inject({ method: "PATCH", url: `/api/v1/admin/users/${target.id}/status`, headers: root.headers, payload: { status } });
    assert.equal(refused.statusCode, 400, `the old filter/button vocabulary must be refused: ${status}`);
  }
  const active = await instance.app.inject({ method: "PATCH", url: `/api/v1/admin/users/${target.id}/status`, headers: root.headers, payload: { status: USER_STATUS.active } });
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(DEACTIVATE_LABEL, "Deactivate");
  assert.equal(ACTIVATE_LABEL, "Activate");
  assert.equal(USER_STATUS.active, "active");
  assert.equal(USER_STATUS.disabled, "disabled");

  // The signed-in administrator's own row is the one the API refuses, which is why
  // the table leaves it without a control.
  const self = await instance.app.inject({ method: "PATCH", url: `/api/v1/admin/users/${root.user.id}/status`, headers: root.headers, payload: { status: "disabled" } });
  assert.equal(self.statusCode, 400, self.body);
  assert.equal(self.json().error.code, "SELF_DEACTIVATION");

  // No client-stated role default can drift from the server's list.
  const app = readFileSync(path.join(CLIENT, "App.jsx"), "utf8");
  assert.match(app, /"admin-users": <AdminUsersView user=\{user\} permissions=\{permissions\} \/>/);
  const views = readFileSync(path.join(CLIENT, "views.jsx"), "utf8");
  assert.match(views, /const options = roleOptions\(roles\.data\?\.assignable, roles\.data\?\.roles\);/);
  for (const stale of ["value=\"analyst\"", "value=\"compliance_officer\"", "setStatus(row, \"suspended\")", "<option value=\"pending\">"]) {
    assert.ok(!views.includes(stale), `${stale} is gone`);
  }
  assert.match(views, /<option value="">any<\/option>/);
});
