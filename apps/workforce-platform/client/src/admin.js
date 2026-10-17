/**
 * The administrator control centre (row 3, Phase 35).
 *
 * `views/admin/index.php` (`Admin::index`) is the super administrator's page: the
 * four platform statistics, the access policy, the user directory with its
 * create/deactivate controls, an SMTP panel and the feature-readiness table. The
 * port split it in two — the directory has been at `/app/admin/users` since the
 * identity slice, and this module is the rest of the page, which had no screen.
 *
 * Everything here is either legacy's own text or the server's own answer:
 *
 *  - `ADMIN_COPY` is the page's eyebrow, heading and lede, transcribed;
 *  - `ADMIN_STATS` is legacy's four cards with legacy's captions, each naming the
 *    source it reads — including the one card **no Node module can answer**
 *    (language learning, row 16), which renders an em dash rather than a zero,
 *    exactly as the workspace dashboard's language card does;
 *  - `ACCESS_POLICY` is the page's hand-written policy list, with one addition
 *    legacy could not make: every row carries the **machine-readable** role keys
 *    and permission keys it describes, so a test can assert the panel against the
 *    grants the server actually seeds (`src/db/platform-baseline.js`, the Node
 *    mirror of `tools/rbac.php`) instead of asking a reader to trust prose;
 *  - `MAIL_PANEL` is the SMTP panel, ported in row 5: the server's
 *    credential-free summary and the legacy test send.
 *
 * Two rules from the dashboard apply unchanged: no card prints a number the
 * server did not send (an unread or gated source is an em dash and a sentence),
 * and nothing is offered that the API would refuse.
 */

/** Legacy: `Admin::index` → `requireAdmin()` → `isAdmin()` → `can($user, 'system.super_admin')`. */
export const ADMIN_PERMISSION = "system.super_admin";

/**
 * Whether the session holds a permission, mirroring the server's rule: the
 * `system.super_admin` grant **short-circuits every check** (`identity/service.js`
 * → `userHasPermission`, exactly as `Identity::can()` did). A panel that ignored
 * the shortcut would withhold a read the API answers, which is the same class of
 * error as showing one it refuses.
 */
export function holdsPermission(permissions, permission) {
  if (!permission) return true;
  const held = Array.isArray(permissions) ? permissions : [];
  return held.includes(permission) || held.includes(ADMIN_PERMISSION);
}

export const ADMIN_COPY = Object.freeze({
  eyebrow: "Restricted area",
  title: "Administrator control center",
  lede: "Manage users and inspect platform readiness. Privileged actions require a super administrator and a CSRF token.",
  directoryTitle: "User accounts",
  directoryNote: "Create an account with a scoped role. Passwords are hashed and never displayed again.",
  policyTitle: "Access policy",
  policyFoot: "A deactivated account cannot authenticate. Existing audit history is retained.",
  readinessTitle: "Platform feature readiness",
});

/**
 * Legacy's four cards, in legacy's order, with legacy's captions and the source
 * each one reads here. `languages` has no source on this edition: it is the one
 * number the port cannot answer, and its card says so.
 */
export const ADMIN_STATS = Object.freeze([
  { key: "users", label: "Users", caption: "accounts in database", source: "/api/v1/admin/users", permission: "identity.users.view" },
  // The strategy and lottery counts are legacy's too; the language count is the one
  // this edition cannot answer, and its card says so rather than printing a zero.
  { key: "strategies", label: "Strategies", caption: "versioned implementations", source: "/api/v1/strategies", permission: null },
  { key: "languages", label: "Languages", caption: "registry entries", source: null, permission: null },
  { key: "lotteryDraws", label: "Lottery draws", caption: "verified or sandbox rows", source: "/api/v1/lottery/status", permission: null },
]);

/** The card that has no Node module behind it: row 16, language learning. */
export const LANGUAGE_STAT_NOTE = "No Node module can answer this: language learning is not ported (row 16).";

/**
 * `GET /strategies` groups its rows by strategy id, and each row of the legacy
 * table was one (strategy, version) pair — so legacy's `count(all())` is the sum
 * of the version counts, not the number of groups. Both numbers are reported:
 * conflating them would have quietly understated the count the card is named for.
 */
export function strategyShape(payload) {
  const list = payload?.strategies;
  if (!Array.isArray(list)) return null;
  const versions = list.reduce((total, entry) => total + (Array.isArray(entry?.versions) ? entry.versions.length : 0), 0);
  return { implementations: list.length, versions };
}

const EM_DASH = "—";

/**
 * The four cards, each resolved against what was actually read.
 *
 * @param {{permissions?: string[], users?: object|null, strategies?: object|null, lottery?: object|null}} input
 * @returns {Array<{key: string, label: string, value: string, caption: string, note: string}>}
 */
export function statCards({ permissions = [], users = null, strategies = null, lottery = null } = {}) {
  const shape = strategyShape(strategies);
  const lotteryCount = Number(lottery?.drawsTracked);
  return ADMIN_STATS.map((stat) => {
    const base = { key: stat.key, label: stat.label, caption: stat.caption, note: "" };
    if (stat.key === "languages") return { ...base, value: EM_DASH, note: LANGUAGE_STAT_NOTE };
    if (stat.key === "users") {
      if (!holdsPermission(permissions, stat.permission)) {
        return { ...base, value: EM_DASH, note: `This session does not hold ${stat.permission}, so the count is not requested.` };
      }
      const total = users?.meta?.total;
      return typeof total === "number" && Number.isFinite(total)
        ? { ...base, value: String(total), note: `Every account row, from ${stat.source}.` }
        : { ...base, value: EM_DASH, note: `The account count could not be read (${stat.source}).` };
    }
    if (stat.key === "strategies") {
      if (!shape) return { ...base, value: EM_DASH, note: `The strategy list could not be read (${stat.source}).` };
      return {
        ...base,
        value: String(shape.versions),
        note: `${shape.versions} version rows across ${shape.implementations} ${shape.implementations === 1 ? "strategy" : "strategies"} — legacy counted the rows.`,
      };
    }
    if (lotteryCount === undefined || Number.isNaN(lotteryCount)) {
      return { ...base, value: EM_DASH, note: `The stored draw count could not be read (${stat.source}).` };
    }
    const code = lottery?.activeLottery;
    return { ...base, value: String(lotteryCount), note: code ? `Stored rows for the active lottery ${code}.` : "Stored rows for the active lottery." };
  });
}

/**
 * The acceptance states the ledger can report, with the shell's badge tones. The
 * legend text is the server's (`GET /system/features` → `legend`), never a
 * client-side paraphrase.
 */
export const ACCEPTANCE_TONES = Object.freeze({ ported: "badge-live", partial: "badge-amber", "not-ported": "badge-muted" });

export function acceptanceTone(state) {
  return ACCEPTANCE_TONES[state] || "badge-gray";
}

/**
 * `GET /system/status` → `modules` is the readiness table. Legacy's own table was
 * `Api_system::FEATURES` (name/category/status/details, statuses
 * TESTED/IMPLEMENTED/PLANNED) describing the PHP build; `INVENTORY.md` records the
 * port decision — this edition reports per Node module with `ported` / `partial` /
 * `not-ported` and the checks behind each row, so no row claims a feature this
 * build does not ship.
 */
export function featureRows(modules) {
  return (Array.isArray(modules) ? modules : []).map((module) => ({
    key: module.key,
    label: module.label || module.key,
    state: module.state || "unknown",
    stateLabel: module.state || "unknown",
    tone: acceptanceTone(module.state),
    tests: typeof module.tests === "string" ? module.tests : "",
  }));
}

/** The server's own legend, as rows, so the table's vocabulary is explained on screen. */
export function legendRows(legend) {
  return Object.entries(legend || {}).map(([state, text]) => ({ state, text, tone: acceptanceTone(state) }));
}

/**
 * The page's access policy, `views/admin/index.php`'s five lines plus the
 * baseline role the legacy panel did not name.
 *
 * Every row carries the role keys it covers and, per role, the permission keys the
 * role is supposed to hold — `null` meaning the whole vocabulary (the super
 * administrator, which also short-circuits every check). `test/client_admin_console.test.js`
 * asserts those claims against `ROLE_GRANTS` and `PLATFORM_PERMISSIONS`, so a
 * seeded grant that drifts from this panel fails the suite rather than shipping a
 * screen that describes a policy the server does not enforce.
 */
export const ACCESS_POLICY = Object.freeze([
  {
    key: "super_admin",
    title: "Super administrator",
    detail: "All platform permissions",
    roles: [{ key: "super_admin", permissions: null }],
  },
  {
    key: "trading_operator",
    title: "Trading operator",
    detail: "Trading view, control and execution",
    roles: [{ key: "trading_operator", permissions: ["trading.view", "trading.control", "trading.execute"] }],
  },
  {
    key: "sports_admin",
    title: "Sports administrator",
    detail: "Sports provider, approval and settlement controls",
    roles: [{ key: "sports_admin", permissions: ["sports.view", "sports.manage", "sports.approve", "sports.settle"] }],
  },
  {
    key: "lottery_admin",
    title: "Lottery administrator",
    detail: "Lottery viewing, sync and management",
    roles: [{ key: "lottery_admin", permissions: ["lottery.view", "lottery.manage"] }],
  },
  {
    key: "viewers",
    title: "Viewer roles",
    detail: "Read-only access to their module",
    roles: [
      { key: "trading_viewer", permissions: ["trading.view"] },
      { key: "sports_viewer", permissions: ["sports.view"] },
      { key: "lottery_viewer", permissions: ["lottery.view"] },
    ],
  },
  {
    key: "platform_member",
    title: "Platform member",
    detail: "Signed-in baseline: view access to the trading, sports and lottery surfaces, nothing else",
    roles: [{ key: "platform_member", permissions: ["trading.view", "sports.view", "lottery.view"] }],
  },
]);

/**
 * The role labels of legacy's create form (`views/admin/index.php`'s `<select>`),
 * keyed by the role keys `POST /admin/users` accepts. The panel labels a role with
 * the store's own display name when this deployment has one, and falls back to
 * these.
 */
export const ROLE_LABELS = Object.freeze({
  super_admin: "Super administrator",
  sports_admin: "Sports admin",
  sports_viewer: "Sports viewer",
  trading_operator: "Trading operator",
  trading_viewer: "Trading viewer",
  lottery_admin: "Lottery admin",
  lottery_viewer: "Lottery viewer",
  platform_member: "Platform member",
});

/**
 * The create form's options: the server's `assignable` list (`GET /admin/roles`,
 * which is `contracts.ADMIN_ROLES`) in the server's own order. A client that
 * offered roles of its own invention — or defaulted to one — would be inviting a
 * refusal the member cannot act on.
 */
export function roleOptions(assignable, roles = []) {
  const names = new Map((Array.isArray(roles) ? roles : []).map((role) => [role.key, role.displayName]));
  return (Array.isArray(assignable) ? assignable : []).map((key) => ({ value: key, label: names.get(key) || ROLE_LABELS[key] || key }));
}

/** Roles the store holds that the create form cannot assign (the legacy-schema `user` role). */
export function unassignableRoles(roles, assignable) {
  const allowed = new Set(Array.isArray(assignable) ? assignable : []);
  return (Array.isArray(roles) ? roles : []).filter((role) => !allowed.has(role.key));
}

/** The two account states the API accepts, and the words legacy used for them. */
export const USER_STATUS = Object.freeze({ active: "active", disabled: "disabled" });
export const DEACTIVATE_LABEL = "Deactivate";
export const ACTIVATE_LABEL = "Activate";

/**
 * The Email / SMTP panel (row 5, Phase 42).
 *
 * Legacy's panel read the server's mail configuration
 * (`Aegis\Mailer::configSummary()`) and its button performed a real SMTP send
 * (`POST /admin/test-email`). Both are here: the summary is the server's own
 * credential-free object, and the form posts to the ported route. Nothing about
 * the configuration is editable from a browser — it lives in the server
 * environment, exactly as the PHP application required.
 *
 * The panel never prints a password. It prints whether one is set, which is what
 * legacy's `passwordConfigured` field was for.
 */
export const MAIL_PANEL = Object.freeze({
  title: "Email / SMTP",
  lede: "The server's mail configuration, read from the environment, and a real test send. Credentials are never shown — only whether they are set.",
  // Legacy's form fields, in legacy's order.
  recipientLabel: "Recipient",
  variantLabel: "Format",
  submitLabel: "Send test email",
  variants: Object.freeze([{ value: "html", label: "HTML" }, { value: "plain", label: "Plain text" }]),
  footnote: "The test send is audited as ADMIN_TEST_EMAIL with its recipient and outcome. Operator notifications are still stored and read in-product only: SMTP is used by this test and by the contact-form copy, never by an alert.",
  disabledNote: "Outbound email is disabled. Set VP_SMTP_ENABLED=1 and a VP_SMTP_HOST on the server, restart, then send a test.",
});

/** One row per `configSummary()` field, in the order the panel renders them. */
export function mailSummaryRows(summary) {
  const value = summary && typeof summary === "object" ? summary : {};
  const dash = (text) => (text === null || text === undefined || text === "" ? "—" : String(text));
  return [
    { key: "status", label: "Status", value: value.enabled ? "Enabled" : "Disabled" },
    { key: "protocol", label: "Protocol", value: dash(value.protocol) },
    { key: "host", label: "Host", value: dash(value.host) },
    { key: "port", label: "Port", value: dash(value.port) },
    { key: "crypto", label: "Encryption", value: value.crypto ? String(value.crypto).toUpperCase() : "None" },
    { key: "from", label: "From", value: value.fromEmail ? `${value.fromEmail}${value.fromName ? ` (${value.fromName})` : ""}` : "—" },
    { key: "username", label: "Username", value: value.usernameConfigured ? "Configured" : "Not configured" },
    { key: "password", label: "Password", value: value.passwordConfigured ? "Configured (never shown)" : "Not configured" },
  ];
}

/** The badge the panel carries: a configured transport is live, a disabled one is not. */
export function mailPanelState(summary) {
  return summary?.enabled ? { state: "smtp", tone: "badge-live", label: "Enabled" } : { state: "none", tone: "badge-muted", label: "Disabled" };
}

/**
 * Every read this screen makes, with the permission the server enforces. The
 * suite asserts each against `GET /api/v1/system/routes`, and the view refuses to
 * attempt the two administration reads when the session does not hold their
 * permission — the same rule the dashboard follows.
 */
export const ADMIN_READS = Object.freeze([
  { key: "users", method: "GET", path: "/api/v1/admin/users", permission: "identity.users.view", auth: true },
  { key: "roles", method: "GET", path: "/api/v1/admin/roles", permission: "identity.users.view", auth: true },
  { key: "strategies", method: "GET", path: "/api/v1/strategies", permission: null, auth: true },
  // The lottery status route carries the module's own sign-in baseline rather than
  // `lottery.view`: it reports configured state, and the console's data reads are
  // the ones behind the module permission.
  { key: "lottery", method: "GET", path: "/api/v1/lottery/status", permission: "system.authenticated", auth: true },
  // Row 5: the mail summary is super-admin only, like the panel that showed it.
  { key: "mail", method: "GET", path: "/api/v1/admin/mail", permission: "system.super_admin", auth: true },
  { key: "status", method: "GET", path: "/api/v1/system/status", permission: null, auth: false },
  { key: "features", method: "GET", path: "/api/v1/system/features", permission: null, auth: false },
]);

export const USERS_LIST_QUERY = "?limit=1";
