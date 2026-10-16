/**
 * Workspace views.
 *
 * Every view here is a thin binding over a documented API surface — no data is
 * invented, and nothing renders as "working" that the server has not answered
 * for. Where a surface needs a permission the signed-in role does not carry, the
 * view says so instead of hiding the entry point: the same check runs server-side
 * either way.
 */

import { useEffect, useState } from "react";
import { endpoints } from "./api.js";
import {
  ALLOCATION_ROWS, MAX_ASSETS, MAX_LIMIT, MAX_SYMBOL_LENGTH, MARKET_CLASSES, MIN_ASSETS, MIN_LIMIT,
  OBJECTIVES, TIMEFRAMES, buildOptimizeBody, defaultForm, emptyAsset, formatNumber, formatPercent,
  formatWindowBound, isSimulation, provenanceBySymbol, provenanceLabel, reportSummary, validateOptimizeForm,
} from "./portfolio.js";
import {
  BACKTEST_STRATEGIES, DEFAULT_TICKET_METHOD, GENERATOR_MODES, MAX_GENERATE_COUNT, STATISTICS_KINDS,
  buildAnalyzeQuery, buildBacktestBody, buildCompareBody, buildGenerateBody, buildTicketBody, distributionMetrics,
  drawNumbers, formatCount, formatDate, formatDateTime, generatedLineText, listToText,
  matchDistribution, parseTicketLines, providerTone, statisticsRows, tierRows, validateAnalyzeForm,
  validateGenerateForm, verificationTone,
} from "./lottery.js";
// The three aliases below collide by name with the portfolio optimizer's own
// exports (both modules have a timeframe list and an optimize form) — aliasing
// here keeps each module's vocabulary natural instead of prefixing every export
// in one of them. `test/client_strategy_console.test.js` imports the module
// directly, so what is tested is the unaliased function.
import {
  BACKTEST_BARS, LIFECYCLE_ORDER, OPTIMIZE_BARS, RETIRED_STAGE, SYMBOLS,
  TIMEFRAMES as STRATEGY_TIMEFRAMES,
  backtestSummary, buildSignOffBody, buildTransitionBody, finalistRows,
  buildBacktestBody as buildStrategyBacktestBody,
  historyRows, lifecycleTone, marketClassFor, metricPairs, needsSignOff, optimizeHeadline, optimizeRecommendation,
  pctText, plainNumber, provenanceNote, ratioPctText, stageSteps, transitionFailure,
  buildOptimizeBody as buildStrategyOptimizeBody,
  validateBacktestForm, validateSignOffForm,
  validateOptimizeForm as validateStrategyOptimizeForm,
} from "./strategy.js";
// The AI Workforce console's module. Two names collide with the blocks above —
// `historyRows` (this one reads `GET /analysis/history`) and nothing else — so the
// import is aliased where it does rather than prefixing the module's exports.
import {
  MAX_WATCHLIST, REFUSED_MODES, RUN_TIMEFRAMES, SYMBOL_GROUPS, TRADING_MODES, WATCHLIST,
  agentPanels, biasTone, buildConsensusBody, buildKillSwitchBody, buildModeBody, buildRunBody,
  candleGeometry, consensusSummary, debateView,
  historyRows as analysisHistoryRows,
  meterRows, numberText, priceText, provenanceFacts, riskContextFacts,
  riskDecisionView, runHeadline, signalRows, structureLevels, tradeSetupView,
  validateRunForm, validateWatchlistForm, watchlistRows,
} from "./workforce.js";
import { Link } from "./router.jsx";
import { ConnectivityBanner, Field, Notice, StateBox, useResource } from "./ui.jsx";

export function Brand({ compact = false }) {
  return (
    <a className={`app-brand${compact ? " app-brand-compact" : ""}`} href="/" aria-label="WINDELS AI WORKFORCE home">
      <span className="app-brand-mark" aria-hidden="true">W</span>
      <span>WINDELS <b>AI WORKFORCE</b></span>
    </a>
  );
}

export function StatusPill({ status }) {
  const good = status === "ready" || status === "ok";
  return <span className={`status-pill ${good ? "status-good" : "status-warn"}`}><i />{status || "checking"}</span>;
}

function formFailure(error) {
  return error?.message || "The request did not complete.";
}

/* ------------------------------------------------------------------ entry */

export function LoginPanel({ onLogin, busy, error, native, notice }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  return (
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-panel-top"><span className="overline">MEMBER ACCESS</span><span className="login-orbit" aria-hidden="true">✳</span></div>
      <h2 id="login-title">Welcome<br /><em>back.</em></h2>
      <p className="login-copy">Sign in to continue to your private workspace.</p>
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {native ? (
        <div className="notice-box" role="status">
          <strong>Native sign-in is not enabled yet.</strong>
          <span>This build needs the reviewed native token and secure-storage flow before it can authenticate. No credentials are stored in the app.</span>
        </div>
      ) : (
        <form className="login-form" onSubmit={(event) => { event.preventDefault(); onLogin({ identifier, password }); }}>
          <label htmlFor="identifier">Username, email or user ID</label>
          <input id="identifier" name="identifier" autoComplete="username" maxLength="254" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" maxLength="1024" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}<span aria-hidden="true">→</span></button>
        </form>
      )}
      <div className="login-foot">
        <span className="secure-dot" /> Protected by server-side sessions and permission checks.
        <Link className="panel-switch" to="/app/register">Create an account</Link>
      </div>
    </section>
  );
}

export function RegisterPanel({ onRegister, busy, error, fieldErrors, native }) {
  const [form, setForm] = useState({ username: "", displayName: "", email: "", password: "", passwordConfirm: "", termsAccepted: false });
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  if (native) {
    return (
      <section className="login-panel" aria-labelledby="register-title">
        <div className="login-panel-top"><span className="overline">MEMBER ACCESS</span><span className="login-orbit" aria-hidden="true">✳</span></div>
        <h2 id="register-title">Create an<br /><em>account.</em></h2>
        <div className="notice-box" role="status">
          <strong>Registration is not enabled in the native shell.</strong>
          <span>Account creation needs the same reviewed session contract as native sign-in.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="login-panel" aria-labelledby="register-title">
      <div className="login-panel-top"><span className="overline">MEMBER ACCESS</span><span className="login-orbit" aria-hidden="true">✳</span></div>
      <h2 id="register-title">Create an<br /><em>account.</em></h2>
      <p className="login-copy">One account per person. Registration is rate limited and every attempt is audited.</p>
      <form className="login-form" onSubmit={(event) => { event.preventDefault(); onRegister(form); }}>
        <label htmlFor="reg-username">Username</label>
        <input id="reg-username" name="username" autoComplete="username" maxLength="64" value={form.username} onChange={set("username")} required />
        {fieldErrors?.username ? <span className="field-error" role="alert">{fieldErrors.username}</span> : null}

        <label htmlFor="reg-display">Display name <small>(optional)</small></label>
        <input id="reg-display" name="displayName" autoComplete="nickname" maxLength="120" value={form.displayName} onChange={set("displayName")} />

        <label htmlFor="reg-email">Email</label>
        <input id="reg-email" name="email" type="email" autoComplete="email" maxLength="190" value={form.email} onChange={set("email")} required />
        {fieldErrors?.email ? <span className="field-error" role="alert">{fieldErrors.email}</span> : null}

        <label htmlFor="reg-password">Password</label>
        <input id="reg-password" name="password" type="password" autoComplete="new-password" maxLength="1024" value={form.password} onChange={set("password")} required />

        <label htmlFor="reg-confirm">Confirm password</label>
        <input id="reg-confirm" name="passwordConfirm" type="password" autoComplete="new-password" maxLength="1024" value={form.passwordConfirm} onChange={set("passwordConfirm")} required />

        <label className="checkbox-row" htmlFor="reg-terms">
          <input id="reg-terms" name="termsAccepted" type="checkbox" checked={form.termsAccepted} onChange={set("termsAccepted")} />
          <span>I accept the Terms of Use and the Privacy Policy.</span>
        </label>

        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}<span aria-hidden="true">→</span></button>
      </form>
      <div className="login-foot">
        <span className="secure-dot" /> Passwords are hashed server-side; the platform never sees them in plain text after submit.
        <Link className="panel-switch" to="/app/login">Sign in instead</Link>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- workspace */

export function WorkspaceNav({ permissions, current, signedIn = true, notificationVersion = 0 }) {
  const inbox = useResource(
    () => signedIn ? endpoints.notificationInbox("?limit=1") : Promise.resolve({ unread: 0 }),
    [signedIn, notificationVersion],
  );
  const unreadCount = Math.max(0, Number(inbox.data?.unread) || 0);
  const entries = [
    { to: "/app/", label: "Overview", permission: null },
    // Session-only, like the legacy controller: the analysis routes guard on
    // authentication alone, so an entry that required a permission would hide a
    // screen the API serves to every signed-in role.
    { to: "/app/analysis", label: "AI Workforce", permission: null },
    { to: "/app/account", label: "Account", permission: null },
    { to: "/app/notifications", label: "Notifications", permission: null, unread: true },
    { to: "/app/status", label: "Platform status", permission: null },
    { to: "/app/portfolio/optimizer", label: "Portfolio optimizer", permission: "trading.view" },
    { to: "/app/lottery", label: "Lottery operations", permission: "lottery.view" },
    { to: "/app/lottery/lab", label: "Lottery lab", permission: "lottery.view" },
    { to: "/app/strategy", label: "Strategy Lab", permission: null },
    { to: "/app/admin/users", label: "Users", permission: "identity.users.view" },
    { to: "/app/admin/audit", label: "Audit trail", permission: "identity.users.view" },
    { to: "/app/admin/inquiries", label: "Contact messages", permission: "system.super_admin" },
  ];
  return (
    <nav className="app-nav" aria-label="Workspace">
      {entries.map((entry) => {
        const allowed = !entry.permission || permissions.includes(entry.permission);
        return (
          <Link
            key={entry.to}
            to={entry.to}
            className={`nav-link${current === entry.to ? " nav-current" : ""}${allowed ? "" : " nav-locked"}`}
            aria-current={current === entry.to ? "page" : undefined}
            aria-label={entry.unread && inbox.status === "ready" && unreadCount > 0 ? `Notifications, ${unreadCount} unread` : undefined}
          >
            <span>{entry.label}</span>
            {entry.unread && inbox.status === "ready" && unreadCount > 0
              ? <span className="nav-unread-badge" aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>
              : null}
            {allowed ? null : <span className="nav-lock" title={`Requires ${entry.permission}`}>🔒</span>}
          </Link>
        );
      })}
    </nav>
  );
}

const NOTIFICATION_TYPES = Object.freeze([
  "KILL_SWITCH",
  "TRADING_MODE_CHANGED",
  "TRADE_APPROVAL_REQUESTED",
  "PROPOSAL_EXPIRED",
  "ORDER_FILLED",
  "EXECUTION_FAILED",
  "ROUTING_BLOCKED",
  "PORTFOLIO_RISK",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "SPORTS_MODEL_DRIFT",
]);

function notificationDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : String(value || "Time unavailable");
}

/** In-product notification inbox backed only by the authenticated inbox APIs. */
export function NotificationsView({ onNotificationsChanged }) {
  const [draftFilters, setDraftFilters] = useState({ unread: false, severity: "", type: "" });
  const [appliedFilters, setAppliedFilters] = useState({ unread: false, severity: "", type: "" });
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const params = new URLSearchParams({ limit: "200" });
  if (appliedFilters.unread) params.set("unread", "1");
  if (appliedFilters.severity) params.set("severity", appliedFilters.severity);
  if (appliedFilters.type) params.set("type", appliedFilters.type);
  const query = params.toString();
  const inbox = useResource(() => endpoints.notificationInbox(`?${query}`), [query]);
  const notifications = inbox.data?.notifications || [];
  const unreadCount = Math.max(0, Number(inbox.data?.unread) || 0);

  async function markRead(notificationId) {
    setBusyId(String(notificationId));
    setMessage(null);
    try {
      await endpoints.markNotificationRead(notificationId);
      setMessage({ tone: "info", text: "Notification marked as read." });
      inbox.retry();
      onNotificationsChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: formFailure(error) });
      // A concurrent read elsewhere is a normal 404 from the API; refresh the
      // inbox so the screen converges on the server's current read state.
      if (error?.status === 404) inbox.retry();
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    setBusyId("all");
    setMessage(null);
    try {
      const result = await endpoints.markAllNotificationsRead();
      const count = Number(result?.markedRead) || 0;
      setMessage({ tone: "info", text: count ? `${count} notification${count === 1 ? "" : "s"} marked as read.` : "There were no unread notifications to update." });
      inbox.retry();
      onNotificationsChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: formFailure(error) });
    } finally {
      setBusyId(null);
    }
  }

  const noMatches = notifications.length === 0
    ? <p className="empty">{appliedFilters.unread || appliedFilters.severity || appliedFilters.type ? "No notifications match these filters." : "You are all caught up. There are no notifications to show."}</p>
    : null;

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">WORKSPACE INBOX <span className="overline-line" /></div><h1>Notifications.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="info">This is an in-product inbox for stored alerts. Email and device delivery are not configured; no external delivery is claimed.</Notice>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <section className="panel">
        <div className="notification-panel-heading">
          <div><h2>Inbox</h2><p className="muted">{unreadCount} unread notification{unreadCount === 1 ? "" : "s"} across your inbox.</p></div>
          {unreadCount > 0 ? <button className="primary-button notification-read-all" type="button" onClick={markAllRead} disabled={busyId !== null}>{busyId === "all" ? "Updating…" : "Mark all as read"}</button> : null}
        </div>
        <form className="panel-form inline notification-filters" onSubmit={(event) => { event.preventDefault(); setAppliedFilters({ ...draftFilters }); }}>
          <Field label="Severity" htmlFor="notification-severity">
            <select id="notification-severity" value={draftFilters.severity} onChange={(event) => setDraftFilters((current) => ({ ...current, severity: event.target.value }))}>
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </Field>
          <Field label="Type" htmlFor="notification-type">
            <select id="notification-type" value={draftFilters.type} onChange={(event) => setDraftFilters((current) => ({ ...current, type: event.target.value }))}>
              <option value="">All types</option>
              {NOTIFICATION_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
            </select>
          </Field>
          <label className="checkbox-row notification-unread-filter" htmlFor="notification-unread">
            <input id="notification-unread" type="checkbox" checked={draftFilters.unread} onChange={(event) => setDraftFilters((current) => ({ ...current, unread: event.target.checked }))} />
            <span>Unread only</span>
          </label>
          <button className="primary-button" type="submit">Apply filters</button>
        </form>
      </section>

      <section className="panel">
        <div className="notification-panel-heading">
          <div><h2>Recent alerts</h2><p className="muted">Showing {inbox.data?.returned ?? 0} of up to 200 latest notifications. Older history is not paginated yet.</p></div>
          <button className="text-button" type="button" onClick={inbox.retry} disabled={inbox.status === "loading"}>Refresh</button>
        </div>
        <StateBox status={inbox.status} error={inbox.error} retry={inbox.retry} label="Loading notifications" empty={noMatches}>
          <ul className="notification-list">
            {notifications.map((notification) => {
              const detail = notification.detail && typeof notification.detail === "object" ? notification.detail : {};
              const hasDetail = Object.keys(detail).length > 0;
              return (
                <li className={`notification-card${notification.unread ? " notification-unread" : ""}`} key={notification.id}>
                  <article>
                    <div className="notification-card-heading">
                      <div className="notification-labels">
                        <span className={`badge notification-severity notification-severity-${notification.severity}`}>{notification.severity}</span>
                        <code>{notification.type}</code>
                        {notification.broadcast ? <span className="badge badge-muted">Broadcast</span> : null}
                        {!notification.unread ? <span className="badge badge-muted">Read</span> : null}
                      </div>
                      <time dateTime={notification.createdAt}>{notificationDate(notification.createdAt)}</time>
                    </div>
                    <h3>{notification.title}</h3>
                    {notification.broadcast ? <p className="notification-visibility">Visible to all signed-in operators.</p> : null}
                    {hasDetail ? <details className="notification-details"><summary>View event details</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details> : null}
                    {notification.unread ? <button className="text-button notification-mark-read" type="button" onClick={() => markRead(notification.id)} disabled={busyId !== null}>{busyId === String(notification.id) ? "Updating…" : "Mark as read"}</button> : null}
                  </article>
                </li>
              );
            })}
          </ul>
        </StateBox>
      </section>
    </div>
  );
}

/**
 * Port status per module, stated precisely enough to act on.
 *
 * Three states, because two are not enough and the difference matters:
 *
 *  - `live`  — has a workspace screen you can use here.
 *  - `api`   — the module's endpoints exist, are tested and are served, but there
 *              is no console for them yet. Usable with an API client; not clickable
 *              in this UI.
 *  - `planned` — not ported at all.
 *
 * This used to be a two-state list that labelled market intelligence "Not yet
 * ported to Node". That stopped being true when Phase 5 ported the analysis
 * engine, and it stayed on screen through Phase 6 — an understatement that would
 * have someone re-port a finished module. The opposite error is just as bad:
 * calling an API-only module "ported" implies an operator can use it here, and
 * they cannot. The shared shell now has an in-product notification inbox plus the
 * portfolio-optimizer, lottery, Strategy Lab and AI Workforce consoles, so the cards
 * name the one each of them opens; the sports dashboard and the settings screens
 * remain open work under F-29.
 */
export function ModuleCards() {
  const moduleCards = [
    { number: "01", title: "Market intelligence", text: "Multi-agent analysis, consensus, regime detection and a risk-reviewed proposal.", status: "Console available", tone: "live", foot: "PHASE 32 · /app/analysis", to: "/app/analysis" },
    { number: "02", title: "Strategy Lab", text: "Backtesting, walk-forward optimization, evidence-gated lifecycle and confidence calibration.", status: "Console available", tone: "live", foot: "PHASE 31 · /app/strategy", to: "/app/strategy" },
    { number: "03", title: "Sports research", text: "Ingestion, decision chain, ticket engine, settlement and measured performance.", status: "Measured half ported · no console", tone: "api", foot: "PHASES 15–20 · /api/v1/sports" },
    { number: "04", title: "Lottery tools", text: "Draw statistics, combinations, saved tickets and the no-look-ahead Strategy Lab.", status: "Console available", tone: "live", foot: "PHASE 30 · /app/lottery", to: "/app/lottery", permission: "lottery.view" },
    { number: "05", title: "Language learning", text: "Lessons, practice and learner progress.", status: "PHP only · not ported", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "06", title: "Lead discovery", text: "Organization-aware discovery and pipeline tools.", status: "PHP only · not ported", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "07", title: "Account & access", text: "Identity, permissions and audited activity.", status: "Foundation slice", tone: "live", foot: "ACTIVE FOUNDATION" },
    { number: "08", title: "Notifications", text: "Review stored alerts, filter the inbox and mark items read.", status: "Inbox available", tone: "live", foot: "PHASE 9 · /app/notifications", to: "/app/notifications" },
    { number: "09", title: "Portfolio optimizer", text: "Long-only mean-variance research under a per-asset cap, with per-asset provenance.", status: "Console available", tone: "live", foot: "PHASE 29 · /app/portfolio/optimizer", to: "/app/portfolio/optimizer", permission: "trading.view" },
  ];
  const labelClass = { live: "live-label", api: "api-label", planned: "planned-label" };
  return (
    <div className="workspace-grid">
      {moduleCards.map((module) => {
        const body = (
          <>
            <div className="workspace-card-top"><span>{module.number}</span><span className={labelClass[module.tone]}>{module.status}</span></div>
            <h3>{module.title}</h3>
            <p>{module.text}</p>
            <div className="workspace-card-bottom"><span>{module.foot}</span><span aria-hidden="true">{module.to ? "→" : "↗"}</span></div>
          </>
        );
        // Only a card with a real target is a link; a card whose console does not
        // exist yet must not look clickable. Permission-gated cards keep their
        // target so the locked-entry pattern stays visible in the workspace.
        return module.to
          ? <Link className="workspace-card workspace-card-link" key={module.number} to={module.to}>{body}</Link>
          : <article className="workspace-card" key={module.number}>{body}</article>;
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- account */

export function AccountView({ user, permissions, onSessionChanged }) {
  const [message, setMessage] = useState(null);
  const [displayName, setDisplayName] = useState(user.displayName || "");
  const [username, setUsername] = useState(user.username || "");
  const [email, setEmail] = useState(user.email || "");
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", newPasswordConfirm: "", signOutOtherSessions: true });
  const [busy, setBusy] = useState(false);

  const sessions = useResource(() => endpoints.sessions(), []);
  const activity = useResource(() => endpoints.activity("?limit=20"), []);

  async function submit(label, call) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await call();
      setMessage({ tone: "ok", text: `${label} saved.` });
      if (result?.csrfToken) onSessionChanged?.(result);
      return result;
    } catch (error) {
      setMessage({ tone: "error", text: formFailure(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">ACCOUNT <span className="overline-line" /></div><h1>Your details, sessions and audit trail.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      {message ? <Notice tone={message.tone === "ok" ? "info" : "error"}>{message.text}</Notice> : null}

      <section className="panel">
        <h2>Profile</h2>
        <form className="panel-form" onSubmit={(event) => { event.preventDefault(); void submit("Display name", () => endpoints.updateProfile({ displayName })); }}>
          <Field label="Display name" htmlFor="acct-display" error={null}>
            <input id="acct-display" maxLength="120" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
          </Field>
          <button className="primary-button" type="submit" disabled={busy}>Save</button>
        </form>
        <form className="panel-form" onSubmit={(event) => { event.preventDefault(); void submit("Username", () => endpoints.updateUsername({ username })); }}>
          <Field label="Username" htmlFor="acct-username" hint="Changing it does not sign you out.">
            <input id="acct-username" maxLength="64" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </Field>
          <button className="primary-button" type="submit" disabled={busy}>Save</button>
        </form>
        <form className="panel-form" onSubmit={(event) => { event.preventDefault(); void submit("Email", () => endpoints.updateEmail({ email })); }}>
          <Field label="Email" htmlFor="acct-email" hint="No confirmation mail is sent: the platform has no outbound mail transport yet.">
            <input id="acct-email" type="email" maxLength="190" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <button className="primary-button" type="submit" disabled={busy}>Save</button>
        </form>
      </section>

      <section className="panel">
        <h2>Password</h2>
        <form
          className="panel-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("Password", async () => {
              const result = await endpoints.changePassword(passwords);
              setPasswords({ currentPassword: "", newPassword: "", newPasswordConfirm: "", signOutOtherSessions: true });
              sessions.retry();
              return result;
            });
          }}
        >
          <Field label="Current password" htmlFor="pw-current">
            <input id="pw-current" type="password" autoComplete="current-password" maxLength="1024" value={passwords.currentPassword} onChange={(event) => setPasswords((current) => ({ ...current, currentPassword: event.target.value }))} required />
          </Field>
          <Field label="New password" htmlFor="pw-new">
            <input id="pw-new" type="password" autoComplete="new-password" maxLength="1024" value={passwords.newPassword} onChange={(event) => setPasswords((current) => ({ ...current, newPassword: event.target.value }))} required />
          </Field>
          <Field label="Confirm new password" htmlFor="pw-confirm">
            <input id="pw-confirm" type="password" autoComplete="new-password" maxLength="1024" value={passwords.newPasswordConfirm} onChange={(event) => setPasswords((current) => ({ ...current, newPasswordConfirm: event.target.value }))} required />
          </Field>
          <label className="checkbox-row" htmlFor="pw-others">
            <input id="pw-others" type="checkbox" checked={passwords.signOutOtherSessions} onChange={(event) => setPasswords((current) => ({ ...current, signOutOtherSessions: event.target.checked }))} />
            <span>Sign out my other sessions after the change.</span>
          </label>
          <button className="primary-button" type="submit" disabled={busy}>Change password</button>
        </form>
      </section>

      <section className="panel">
        <h2>Sessions</h2>
        <StateBox status={sessions.status} error={sessions.error} retry={sessions.retry} label="Loading sessions"
          empty={<p className="empty">No active sessions reported.</p>}>
          <table className="data-table">
            <thead><tr><th>Device</th><th>Created</th><th>Expires</th><th>State</th></tr></thead>
            <tbody>
              {(sessions.data?.sessions || []).map((session) => (
                <tr key={session.id}>
                  <td>{session.deviceLabel || session.device_label || "This device"}</td>
                  <td>{String(session.createdAt || session.created_at || "").replace("T", " ").slice(0, 19)}</td>
                  <td>{String(session.expiresAt || session.expires_at || "").replace("T", " ").slice(0, 19)}</td>
                  <td>{session.current ? <span className="badge badge-live">current</span> : <span className="badge">active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="text-button" type="button" disabled={busy}
            onClick={() => void submit("Other sessions", async () => { const result = await endpoints.revokeSessions(); sessions.retry(); return result; })}>
            Sign out every other session
          </button>
        </StateBox>
      </section>

      <section className="panel">
        <h2>Recent activity</h2>
        <StateBox status={activity.status} error={activity.error} retry={activity.retry} label="Loading activity"
          empty={<p className="empty">No audit events recorded for your account yet.</p>}>
          <ul className="activity-list">
            {(activity.data?.events || []).map((event) => (
              <li key={`${event.id || event.action}-${event.createdAt || event.created_at}`}>
                <code>{event.action}</code>
                <span>{String(event.createdAt || event.created_at || "").replace("T", " ").slice(0, 19)}</span>
                {event.entityType || event.entity_type ? <span className="activity-entity">{event.entityType || event.entity_type} #{event.entityId || event.entity_id}</span> : null}
              </li>
            ))}
          </ul>
        </StateBox>
      </section>

      <section className="panel">
        <h2>Permissions</h2>
        {permissions.length ? (
          <ul className="permission-list vertical">{permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul>
        ) : <p className="empty">No permissions are assigned to your account. Surfaces that need one will refuse you.</p>}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- audit browser */

const DEFAULT_AUDIT_FILTERS = Object.freeze({
  action: "",
  entityType: "",
  entityId: "",
  actorMode: "any",
  actorId: "",
  from: "",
  to: "",
  sort: "createdAt",
  direction: "desc",
  limit: 50,
  offset: 0,
});

function auditLocalTimeToUtc(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function formatAuditTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZoneName: "short" }).format(date)
    : String(value || "Time unavailable");
}

function auditActorLabel(actor) {
  if (!actor || typeof actor !== "object") return "Actor unavailable";
  if (actor.kind === "system") return "System";
  if (actor.kind === "user") {
    const name = actor.username || "Deleted user";
    return actor.userId == null ? name : `${name} · user #${actor.userId}`;
  }
  return "Actor unavailable";
}

function auditDetailsText(value) {
  if (value === undefined || value === null) return "No details recorded.";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Read-only, permission-gated workspace view over the platform audit API. */
export function AuditView() {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_AUDIT_FILTERS }));
  const [applied, setApplied] = useState(() => ({ ...DEFAULT_AUDIT_FILTERS }));
  const params = new URLSearchParams({
    limit: String(applied.limit),
    offset: String(applied.offset),
    sort: applied.sort,
    direction: applied.direction,
  });
  if (applied.action) params.set("action", applied.action);
  if (applied.entityType) params.set("entityType", applied.entityType);
  if (applied.entityId) params.set("entityId", applied.entityId);
  if (applied.actorMode === "system") params.set("actor", "system");
  if (applied.actorMode === "user" && applied.actorId) params.set("actor", applied.actorId);
  const from = auditLocalTimeToUtc(applied.from);
  const to = auditLocalTimeToUtc(applied.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  const audit = useResource(() => endpoints.adminAudit(`?${query}`), [query]);
  const events = audit.data?.events || [];
  const meta = audit.data?.meta || null;

  useEffect(() => { document.title = "Audit trail · WINDELS AI WORKFORCE"; }, []);

  function applyFilters(event) {
    event.preventDefault();
    setApplied({
      ...draft,
      action: draft.action.trim(),
      entityType: draft.entityType.trim(),
      entityId: draft.entityId.trim(),
      actorId: draft.actorId.trim(),
      limit: Number(draft.limit),
      offset: 0,
    });
  }

  function clearFilters() {
    const cleared = { ...DEFAULT_AUDIT_FILTERS };
    setDraft(cleared);
    setApplied(cleared);
  }

  const emptyMessage = meta?.total === 0
    ? <p className="empty">No audit events match these filters.</p>
    : <p className="empty">No events are returned for this page. Try the previous page or adjust the filters.</p>;

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">ADMINISTRATION <span className="overline-line" /></div><h1>Audit trail.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="warn">
        Platform-wide audit events may include sensitive account and operational details. Access requires <code>identity.users.view</code>. This screen is read-only: it cannot edit or delete evidence.
      </Notice>

      <section className="panel">
        <div className="audit-section-heading">
          <div><h2>Filter events</h2><p className="muted">Filters are applied on the server; time inputs use your local timezone and are sent as UTC.</p></div>
        </div>
        <form className="panel-form inline audit-filters" onSubmit={applyFilters}>
          <Field label="Action prefix" htmlFor="audit-action" hint="Matches the action and its dotted descendants.">
            <input id="audit-action" maxLength="96" value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} placeholder="governance" />
          </Field>
          <Field label="Entity type" htmlFor="audit-entity-type">
            <input id="audit-entity-type" maxLength="64" value={draft.entityType} onChange={(event) => setDraft((current) => ({ ...current, entityType: event.target.value }))} placeholder="identity, notification…" />
          </Field>
          <Field label="Entity ID" htmlFor="audit-entity-id">
            <input id="audit-entity-id" maxLength="96" value={draft.entityId} onChange={(event) => setDraft((current) => ({ ...current, entityId: event.target.value }))} placeholder="exact ID" />
          </Field>
          <Field label="Actor" htmlFor="audit-actor-mode">
            <select id="audit-actor-mode" value={draft.actorMode} onChange={(event) => setDraft((current) => ({ ...current, actorMode: event.target.value }))}>
              <option value="any">Any actor</option>
              <option value="system">System events</option>
              <option value="user">User ID</option>
            </select>
          </Field>
          {draft.actorMode === "user" ? (
            <Field label="User ID" htmlFor="audit-actor-id">
              <input id="audit-actor-id" type="text" inputMode="numeric" maxLength="16" pattern="[1-9][0-9]{0,15}" value={draft.actorId} onChange={(event) => setDraft((current) => ({ ...current, actorId: event.target.value }))} required placeholder="e.g. 42" />
            </Field>
          ) : null}
          <Field label="From" htmlFor="audit-from" hint="Inclusive; converted to UTC.">
            <input id="audit-from" type="datetime-local" value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
          </Field>
          <Field label="To" htmlFor="audit-to" hint="Inclusive; converted to UTC.">
            <input id="audit-to" type="datetime-local" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
          </Field>
          <Field label="Sort by" htmlFor="audit-sort">
            <select id="audit-sort" value={draft.sort} onChange={(event) => setDraft((current) => ({ ...current, sort: event.target.value }))}>
              <option value="createdAt">Created time</option>
              <option value="action">Action</option>
              <option value="id">Event ID</option>
            </select>
          </Field>
          <Field label="Direction" htmlFor="audit-direction">
            <select id="audit-direction" value={draft.direction} onChange={(event) => setDraft((current) => ({ ...current, direction: event.target.value }))}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </Field>
          <Field label="Rows per page" htmlFor="audit-limit">
            <select id="audit-limit" value={draft.limit} onChange={(event) => setDraft((current) => ({ ...current, limit: Number(event.target.value) }))}>
              {[25, 50, 100, 200].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
            </select>
          </Field>
          <div className="audit-filter-actions">
            <button className="primary-button" type="submit">Apply filters</button>
            <button className="text-button" type="button" onClick={clearFilters}>Clear</button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="audit-section-heading">
          <div>
            <h2>Platform events</h2>
            <p className="muted">{meta ? `Showing ${events.length} of ${meta.total} matching events.` : "The trail is read-only and paginated."}</p>
          </div>
          {meta?.mutable === false ? <span className="badge badge-live">READ ONLY</span> : null}
        </div>
        <StateBox status={audit.status} error={audit.error} retry={audit.retry} label="Loading audit events" empty={emptyMessage}>
          <ul className="audit-list">
            {events.map((event) => {
              const entityType = event.entityType || "—";
              const entityId = event.entityId == null || event.entityId === "" ? "—" : event.entityId;
              return (
                <li className="audit-card" key={event.id}>
                  <article>
                    <div className="audit-card-heading">
                      <span className="badge badge-muted">Event #{event.id}</span>
                      <time dateTime={event.createdAt}>{formatAuditTime(event.createdAt)}</time>
                    </div>
                    <h3><code>{event.action || "Unknown action"}</code></h3>
                    <dl className="audit-meta">
                      <dt>Actor</dt><dd>{auditActorLabel(event.actor)}</dd>
                      <dt>Entity</dt><dd><code>{entityType}</code> · {entityId}</dd>
                    </dl>
                    <details className="audit-details">
                      <summary>View event details</summary>
                      <pre>{auditDetailsText(event.details)}</pre>
                    </details>
                  </article>
                </li>
              );
            })}
          </ul>
          <Pagination meta={meta} applied={applied} onNavigate={(offset) => setApplied((current) => ({ ...current, offset }))} />
        </StateBox>
      </section>
    </div>
  );
}

/* ------------------------------------------------------ portfolio optimizer */

/**
 * Research-only portfolio optimizer console (Phase 29, row 9).
 *
 * The screen over `POST /api/v1/portfolio/optimize`, replacing the legacy
 * `views/portfolio/optimizer.php` + `assets/js/portfolio-optimizer.js` pair. It is
 * an *action* screen rather than a reading screen, so it does not use
 * `useResource`: a run is submitted deliberately, and the three states that matter
 * are form problems (caught before the request), a server refusal (rendered with
 * its code) and a report.
 *
 * Three things this screen deliberately does not do:
 *
 *  - It does not persist a report or offer a history. The endpoint computes and
 *    returns; the only durable trace is the audit event the server writes itself.
 *    A "saved runs" list here would be a fiction.
 *  - It does not summarise provenance. Every asset row carries its own source,
 *    because a universe where one series is synthetic and another is not must
 *    never read as one clean input.
 *  - It does not require or offer an account, an amount or a broker. The body
 *    cannot express an order, and the screen has no control that implies otherwise.
 */
export function PortfolioOptimizerView({ permissions }) {
  const canRun = permissions.includes("trading.view");
  const [form, setForm] = useState(defaultForm);
  const [run, setRun] = useState({ status: "idle", report: null, error: null, problems: [] });

  useEffect(() => { document.title = "Portfolio optimizer · WINDELS AI WORKFORCE"; }, []);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const updateAsset = (index, patch) => setForm((current) => ({
    ...current,
    assets: current.assets.map((asset, position) => (position === index ? { ...asset, ...patch } : asset)),
  }));
  const addAsset = () => setForm((current) => (current.assets.length >= MAX_ASSETS
    ? current
    : { ...current, assets: [...current.assets, emptyAsset()] }));
  const removeAsset = (index) => setForm((current) => (current.assets.length <= MIN_ASSETS
    ? current
    : { ...current, assets: current.assets.filter((_, position) => position !== index) }));

  async function submit(event) {
    event.preventDefault();
    const problems = validateOptimizeForm(form);
    if (problems.length) {
      setRun({ status: "invalid", report: null, error: null, problems });
      return;
    }
    setRun({ status: "running", report: null, error: null, problems: [] });
    try {
      const payload = await endpoints.optimizePortfolio(buildOptimizeBody(form));
      const report = payload?.optimization ?? null;
      if (!report) {
        setRun({ status: "error", report: null, problems: [], error: Object.assign(new Error("The server returned no optimization report."), { code: "NO_REPORT" }) });
        return;
      }
      setRun({ status: "ready", report, error: null, problems: [] });
    } catch (error) {
      setRun({ status: "error", report: null, problems: [], error });
    }
  }

  const fieldProblem = (field) => (run.status === "invalid" ? run.problems.find((entry) => entry.field === field)?.message : null);
  const busy = run.status === "running";

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">RESEARCH · ROW 9 <span className="overline-line" /></div><h1>Portfolio optimizer.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="warn">
        <strong>Research only.</strong> Output is long-only historical analysis under a per-asset cap — not investment advice, not a forecast, and never an order.
        Fees, slippage, taxes, liquidity, currency conversion and future market changes are not modeled. Synthetic data is refused unless you explicitly enable the simulation option below.
      </Notice>

      {!canRun ? (
        <section className="panel">
          <h2>Permission required</h2>
          <Notice tone="error">
            Your account does not have the <code>trading.view</code> permission required to run portfolio analysis.
            The API refuses this path with your session, so nothing here is a client-side decision.
          </Notice>
        </section>
      ) : (
        <>
          <div className="portfolio-layout">
            <section className="panel">
              <h2>Optimization inputs</h2>
              <form className="panel-form portfolio-form" onSubmit={submit}>
                <div className="portfolio-grid">
                  <Field label="Timeframe" htmlFor="po-timeframe">
                    <select id="po-timeframe" value={form.timeframe} onChange={(event) => update({ timeframe: event.target.value })}>
                      {TIMEFRAMES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Historical bars" htmlFor="po-limit" error={fieldProblem("limit")} hint={`${MIN_LIMIT}–${MAX_LIMIT}; 31 is the floor a return series needs.`}>
                    <input id="po-limit" type="number" min={MIN_LIMIT} max={MAX_LIMIT} step="1" value={form.limit} required
                      onChange={(event) => update({ limit: event.target.value })} />
                  </Field>
                  <Field label="Objective" htmlFor="po-objective">
                    <select id="po-objective" value={form.objective} onChange={(event) => update({ objective: event.target.value })}>
                      {OBJECTIVES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Maximum weight per asset (0–1)" htmlFor="po-max-weight" error={fieldProblem("maxWeight")} hint="Must leave room to be fully invested: at least 1 ÷ asset count.">
                    <input id="po-max-weight" type="number" min="0.01" max="1" step="0.01" value={form.maxWeight} required
                      onChange={(event) => update({ maxWeight: event.target.value })} />
                  </Field>
                  <Field label="Annual risk-free rate (%)" htmlFor="po-risk-free" error={fieldProblem("riskFreeRatePct")} hint="Sent to the API as a decimal: 4 → 0.04.">
                    <input id="po-risk-free" type="number" min="-10" max="100" step="0.1" value={form.riskFreeRatePct}
                      onChange={(event) => update({ riskFreeRatePct: event.target.value })} />
                  </Field>
                  <Field label="Periods per year (optional)" htmlFor="po-periods" error={fieldProblem("periodsPerYear")} hint="Left blank it is inferred — only for a single market class.">
                    <input id="po-periods" type="number" min="1" max="100000" step="1" value={form.periodsPerYear} placeholder="Auto for one market class"
                      onChange={(event) => update({ periodsPerYear: event.target.value })} />
                  </Field>
                </div>

                <div className="portfolio-assets-head">
                  <div>
                    <h3>Asset universe</h3>
                    <p className="muted">Use symbols served by a configured provider. Assets must share timestamps, and every symbol must be unique.</p>
                  </div>
                  <button className="secondary-button" type="button" onClick={addAsset} disabled={form.assets.length >= MAX_ASSETS}>+ Add asset</button>
                </div>

                <div className="portfolio-assets">
                  {form.assets.map((asset, index) => (
                    <div className="portfolio-asset-row" key={index}>
                      <Field label={`Symbol ${index + 1}`} htmlFor={`po-symbol-${index}`} error={fieldProblem(`assets.${index}.symbol`)}>
                        <input id={`po-symbol-${index}`} value={asset.symbol} maxLength={MAX_SYMBOL_LENGTH} autoComplete="off" required
                          onChange={(event) => updateAsset(index, { symbol: event.target.value })} />
                      </Field>
                      <Field label="Market class" htmlFor={`po-class-${index}`} error={fieldProblem(`assets.${index}.marketClass`)}>
                        <select id={`po-class-${index}`} value={asset.marketClass} onChange={(event) => updateAsset(index, { marketClass: event.target.value })}>
                          {MARKET_CLASSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                        </select>
                      </Field>
                      <button className="text-button portfolio-remove" type="button" onClick={() => removeAsset(index)}
                        disabled={form.assets.length <= MIN_ASSETS} aria-label={`Remove asset ${index + 1}`}>Remove</button>
                    </div>
                  ))}
                </div>

                <label className="checkbox-row" htmlFor="po-synthetic">
                  <input id="po-synthetic" type="checkbox" checked={form.allowSyntheticData}
                    onChange={(event) => update({ allowSyntheticData: event.target.checked })} />
                  Allow clearly labeled synthetic simulation data
                </label>
                <p className="field-hint">Keep this unchecked for real-data-only analysis. Synthetic and live series can never be mixed — the API refuses that combination regardless of this flag.</p>

                {run.status === "invalid" ? (
                  <div className="notice notice-error" role="alert">
                    <strong>{run.problems.length} problem{run.problems.length === 1 ? "" : "s"} to fix before running:</strong>
                    <ul className="portfolio-problems">{run.problems.map((problem, index) => <li key={`${problem.field}-${index}`}>{problem.message}</li>)}</ul>
                  </div>
                ) : null}

                {run.status === "error" ? (
                  <div className="notice notice-error" role="alert">
                    <strong>{formFailure(run.error)}</strong>
                    {run.error?.code ? <span className="state-code"> {run.error.code}</span> : null}
                    {run.error?.retryAfter ? <span> Try again in about {run.error.retryAfter}s.</span> : null}
                    {Array.isArray(run.error?.details) && run.error.details.length ? (
                      <ul className="portfolio-problems">
                        {run.error.details.map((issue, index) => <li key={index}>{issue.field ? `${issue.field}: ` : ""}{issue.message}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                <button className="primary-button" id="po-submit" type="submit" disabled={busy}>
                  {busy ? "Loading market history…" : "Run portfolio analysis"}
                </button>
                <p className="field-hint">A run can take a while: the API fetches every series in sequence and then solves. One session may keep a limited number of runs in flight.</p>
              </form>
            </section>

            <aside className="panel portfolio-method">
              <h2>How to read this</h2>
              <ul className="portfolio-method-list">
                <li><b>Expected return</b> is the annualized arithmetic mean of historical returns.</li>
                <li><b>Risk</b> is annualized sample volatility using diagonal covariance shrinkage.</li>
                <li><b>Maximum Sharpe</b> is a deterministic approximate search; it is not guaranteed to find a global optimum.</li>
                <li><b>Minimum variance</b> minimizes estimated portfolio variance under long-only, fully invested and per-asset cap constraints.</li>
                <li><b>Equal weight</b> is included as a reference baseline, not as a recommendation.</li>
              </ul>
              <p className="muted">
                No short selling, leverage, order sizing, tax, fee, slippage, liquidity or currency conversion is modeled.
                The correlation matrix is reported from the unshrunk sample, while the solver uses the shrunk estimate.
                Review the input source, timestamp coverage and warnings before interpreting any result.
              </p>
            </aside>
          </div>

          <section className="portfolio-result" aria-live="polite">
            {run.status === "idle" ? (
              <div className="state-box">No run in this tab yet. Results appear here and are not stored on the server — the audit trail records that a run happened, never the report itself.</div>
            ) : null}

            {run.status === "ready" ? <PortfolioReport report={run.report} /> : null}
          </section>
        </>
      )}
    </div>
  );
}

/** One computed report. Every figure comes from the response; nothing is recomputed here. */
function PortfolioReport({ report }) {
  const provenance = provenanceBySymbol(report);
  const symbols = (report.assets ?? []).map((asset) => asset.symbol);
  const correlations = report.correlations ?? null;
  return (
    <div className="panel">
      <div className="portfolio-report-heading">
        <div>
          <h2>Optimization report</h2>
          <p className="muted">{reportSummary(report)}</p>
        </div>
        <div className="portfolio-report-badges">
          <span className="badge badge-live">{report.status || "RESEARCH_ONLY"}</span>
          {isSimulation(report) ? <span className="badge badge-warn">SIMULATION</span> : null}
        </div>
      </div>

      {(report.warnings ?? []).length ? (
        <div className="portfolio-warnings">
          {report.warnings.map((warning, index) => <div className="notice notice-warn" key={index}>{warning}</div>)}
        </div>
      ) : null}

      <h3>Selected allocation</h3>
      <div className="scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Asset</th><th>Selected weight</th><th>Expected return / year</th><th>Volatility / year</th>
              <th>Min-variance weight</th><th>Max-Sharpe weight</th><th>Source</th>
            </tr>
          </thead>
          <tbody>
            {(report.assets ?? []).map((asset) => (
              <tr key={asset.symbol}>
                <td><code>{asset.symbol}</code><span className="muted"> · {asset.marketClass}</span></td>
                <td>{formatPercent(asset.selectedWeight)}</td>
                <td>{formatPercent(asset.expectedReturnAnnualized)}</td>
                <td>{formatPercent(asset.volatilityAnnualized)}</td>
                <td>{formatPercent(asset.minimumVarianceWeight)}</td>
                <td>{formatPercent(asset.maximumSharpeWeight)}</td>
                <td className="muted">{provenanceLabel(provenance.get(asset.symbol))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Portfolio comparisons</h3>
      <div className="scroll">
        <table className="data-table">
          <thead>
            <tr><th>Allocation</th><th>Expected return / year</th><th>Volatility / year</th><th>Sharpe</th><th>Concentration index</th></tr>
          </thead>
          <tbody>
            {ALLOCATION_ROWS.map((row) => {
              const allocation = report.allocations?.[row.key];
              if (!allocation) return null;
              return (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{formatPercent(allocation.expectedReturnAnnualized)}</td>
                  <td>{formatPercent(allocation.volatilityAnnualized)}</td>
                  <td>{formatNumber(allocation.sharpeRatio, 3)}</td>
                  <td>{formatNumber(allocation.concentrationIndex, 4)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {correlations && symbols.length ? (
        <details className="portfolio-details">
          <summary>Sample correlation matrix ({symbols.length} × {symbols.length}, unshrunk)</summary>
          <div className="scroll">
            <table className="data-table">
              <thead><tr><th />{symbols.map((symbol) => <th key={symbol}>{symbol}</th>)}</tr></thead>
              <tbody>
                {symbols.map((rowSymbol) => (
                  <tr key={rowSymbol}>
                    <th><code>{rowSymbol}</code></th>
                    {symbols.map((columnSymbol) => (
                      <td key={columnSymbol}>{formatNumber(correlations[rowSymbol]?.[columnSymbol], 3)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <details className="portfolio-details">
        <summary>Window, estimation and constraints</summary>
        <dl className="portfolio-meta">
          <dt>Model</dt><dd><code>{report.model || "—"}</code></dd>
          <dt>Window</dt>
          <dd>
            {report.window?.alignedPriceObservations ?? "—"} aligned {report.window?.timeframe ?? ""} price observations ·
            {" "}{report.window?.returnObservations ?? "—"} returns ·
            {" "}{report.window?.periodsPerYear ?? "—"} periods/year ·
            {" "}{formatWindowBound(report.window?.firstTimestamp)} → {formatWindowBound(report.window?.lastTimestamp)}
          </dd>
          <dt>Expected return</dt><dd>{report.estimation?.expectedReturn || "—"}</dd>
          <dt>Covariance</dt>
          <dd>{report.estimation?.covariance || "—"}{report.estimation?.shrinkage !== undefined ? ` · shrinkage ${formatNumber(report.estimation.shrinkage, 4)}` : ""}</dd>
          <dt>Risk-free rate</dt><dd>{formatPercent(report.estimation?.riskFreeRateAnnualized)} annualized</dd>
          <dt>Constraints</dt>
          <dd>
            {report.constraints?.longOnly ? "long-only" : "long-only: unknown"} ·
            {report.constraints?.fullyInvested ? " fully invested" : " fully invested: unknown"} ·
            {" "}cap {formatPercent(report.constraints?.maximumWeightPerAsset)} ·
            {" "}gross leverage {formatNumber(report.constraints?.grossLeverage, 2)}
          </dd>
          <dt>Requested</dt>
          <dd>{(report.request?.assets ?? []).map((asset) => `${asset.symbol} (${asset.marketClass})`).join(", ") || "—"} · {report.request?.timeframe ?? "—"} · {report.request?.limit ?? "—"} bars</dd>
        </dl>
      </details>

      <div className="portfolio-disclaimer">
        <p><strong>{report.disclaimer}</strong></p>
        <p className="muted">{report.methodNote}</p>
        <p className="muted">This report is not stored: it exists in this tab only. The run itself is recorded in the audit trail.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ admin users */

export function AdminUsersView({ permissions }) {
  const [query, setQuery] = useState({ search: "", status: "", limit: 25, offset: 0 });
  const [applied, setApplied] = useState({ search: "", status: "", limit: 25, offset: 0 });
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ email: "", displayName: "", password: "", role: "member", username: "" });
  const canManage = permissions.includes("identity.users.manage");

  const params = new URLSearchParams({ limit: String(applied.limit), offset: String(applied.offset), sort: "id", direction: "asc" });
  if (applied.search) params.set("search", applied.search);
  if (applied.status) params.set("status", applied.status);
  const users = useResource(() => endpoints.adminUsers(`?${params.toString()}`), [params.toString()]);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const payload = { email: draft.email, displayName: draft.displayName, password: draft.password, role: draft.role };
      if (draft.username) payload.username = draft.username;
      const created = await endpoints.adminCreateUser(payload);
      setMessage({ tone: "ok", text: `Created ${created.username} (${created.role}).` });
      setDraft({ email: "", displayName: "", password: "", role: "member", username: "" });
      users.retry();
    } catch (error) {
      setMessage({ tone: "error", text: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(user, status) {
    setBusy(true);
    setMessage(null);
    try {
      await endpoints.adminSetUserStatus(user.id, { status });
      setMessage({ tone: "ok", text: `${user.username} is now ${status}.` });
      users.retry();
    } catch (error) {
      setMessage({ tone: "error", text: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">ADMINISTRATION <span className="overline-line" /></div><h1>Accounts.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      {message ? <Notice tone={message.tone === "ok" ? "info" : "error"}>{message.text}</Notice> : null}

      {canManage ? (
        <section className="panel">
          <h2>Create an account</h2>
          <form className="panel-form grid" onSubmit={create}>
            <Field label="Email" htmlFor="nu-email"><input id="nu-email" type="email" maxLength="190" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} required /></Field>
            <Field label="Display name" htmlFor="nu-name"><input id="nu-name" maxLength="120" value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} required /></Field>
            <Field label="Password" htmlFor="nu-password" hint="Admins set the first password; the account owner changes it at first sign-in.">
              <input id="nu-password" type="password" autoComplete="new-password" maxLength="1024" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} required />
            </Field>
            <Field label="Role" htmlFor="nu-role">
              <select id="nu-role" value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}>
                <option value="member">member</option>
                <option value="analyst">analyst</option>
                <option value="operator">operator</option>
                <option value="supervisor">supervisor</option>
                <option value="compliance_officer">compliance_officer</option>
                <option value="admin">admin</option>
                <option value="super_admin">super_admin</option>
              </select>
            </Field>
            <Field label="Username (optional)" htmlFor="nu-username"><input id="nu-username" maxLength="64" value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} /></Field>
            <button className="primary-button" type="submit" disabled={busy}>Create</button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <h2>Directory</h2>
        <form className="panel-form inline" onSubmit={(event) => { event.preventDefault(); setApplied({ ...query, offset: 0 }); }}>
          <Field label="Search" htmlFor="u-search"><input id="u-search" maxLength="80" value={query.search} onChange={(event) => setQuery((current) => ({ ...current, search: event.target.value }))} placeholder="username, email or ID" /></Field>
          <Field label="Status" htmlFor="u-status">
            <select id="u-status" value={query.status} onChange={(event) => setQuery((current) => ({ ...current, status: event.target.value }))}>
              <option value="">any</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="pending">pending</option>
            </select>
          </Field>
          <button className="primary-button" type="submit">Apply</button>
        </form>

        <StateBox status={users.status} error={users.error} retry={users.retry} label="Loading accounts"
          empty={<p className="empty">No accounts match that filter.</p>}>
          <table className="data-table">
            <thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Status</th><th>Last login</th>{canManage ? <th>Actions</th> : null}</tr></thead>
            <tbody>
              {(users.data?.users || []).map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.username}{row.displayName || row.display_name ? <small className="muted"> · {row.displayName || row.display_name}</small> : null}</td>
                  <td>{row.email || <span className="muted">not set</span>}</td>
                  <td><span className={`badge badge-${row.status === "active" ? "live" : "warn"}`}>{row.status}</span></td>
                  <td>{row.lastLoginAt || row.last_login_at ? String(row.lastLoginAt || row.last_login_at).replace("T", " ").slice(0, 19) : <span className="muted">never</span>}</td>
                  {canManage ? (
                    <td className="row-actions">
                      {row.status === "active"
                        ? <button className="text-button" type="button" disabled={busy} onClick={() => void setStatus(row, "suspended")}>Suspend</button>
                        : <button className="text-button" type="button" disabled={busy} onClick={() => void setStatus(row, "active")}>Activate</button>}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination meta={users.data?.meta} applied={applied} onNavigate={(offset) => setApplied((current) => ({ ...current, offset }))} />
        </StateBox>
      </section>
    </div>
  );
}

function Pagination({ meta, applied, onNavigate }) {
  if (!meta) return null;
  const total = Number(meta.total || 0);
  const limit = Number(applied.limit || 25);
  const offset = Number(applied.offset || 0);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="pagination">
      <button className="text-button" type="button" disabled={offset === 0} onClick={() => onNavigate(Math.max(0, offset - limit))}>← Previous</button>
      <span>{from}–{to} of {total}</span>
      <button className="text-button" type="button" disabled={to >= total} onClick={() => onNavigate(offset + limit)}>Next →</button>
    </div>
  );
}

/* ------------------------------------------------------------- inquiries */

export function InquiriesView() {
  const [query, setQuery] = useState({ search: "", limit: 25, offset: 0 });
  const [applied, setApplied] = useState({ search: "", limit: 25, offset: 0 });
  const [open, setOpen] = useState(null);

  const params = new URLSearchParams({ limit: String(applied.limit), offset: String(applied.offset), sort: "createdAt", direction: "desc" });
  if (applied.search) params.set("search", applied.search);
  const inquiries = useResource(() => endpoints.adminInquiries(`?${params.toString()}`), [params.toString()]);

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">PUBLIC SITE <span className="overline-line" /></div><h1>Contact messages.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      {inquiries.data?.mail ? (
        <Notice tone="warn">Outbound mail: <strong>{inquiries.data.mail.transport}</strong>. {inquiries.data.mail.note}</Notice>
      ) : null}

      <section className="panel">
        <h2>Inbox</h2>
        <form className="panel-form inline" onSubmit={(event) => { event.preventDefault(); setApplied({ ...query, offset: 0 }); }}>
          <Field label="Search" htmlFor="i-search"><input id="i-search" maxLength="80" value={query.search} onChange={(event) => setQuery((current) => ({ ...current, search: event.target.value }))} placeholder="name, email or reference" /></Field>
          <button className="primary-button" type="submit">Apply</button>
        </form>

        <StateBox status={inquiries.status} error={inquiries.error} retry={inquiries.retry} label="Loading messages"
          empty={<p className="empty">No visitor messages have been recorded yet.</p>}>
          <ul className="inquiry-list">
            {(inquiries.data?.inquiries || []).map((row) => (
              <li key={row.id} className="inquiry">
                <button className="inquiry-head" type="button" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>
                  <strong>{row.name}</strong>
                  <span className="muted">{row.email}</span>
                  <code>{row.reference}</code>
                  <span className="badge badge-warn">{row.status}</span>
                  <span className="muted">{String(row.createdAt).replace("T", " ").slice(0, 19)}</span>
                </button>
                {open === row.id ? (
                  <div className="inquiry-body">
                    <p>{row.message}</p>
                    <dl className="inquiry-meta">
                      <dt>Fingerprint</dt><dd><code>{row.clientFingerprint ? `${row.clientFingerprint.slice(0, 12)}…` : "not recorded"}</code></dd>
                      <dt>Request</dt><dd><code>{row.requestId || "not recorded"}</code></dd>
                      <dt>Handled</dt><dd>{row.handledAt ? `${String(row.handledAt).replace("T", " ").slice(0, 19)} by ${row.handledBy}` : "not handled"}</dd>
                    </dl>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <Pagination meta={{ total: inquiries.data?.total }} applied={applied} onNavigate={(offset) => setApplied((current) => ({ ...current, offset }))} />
        </StateBox>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- status */

export function StatusView() {
  const status = useResource(() => endpoints.status(), []);
  const features = useResource(() => endpoints.features(), []);
  const legend = features.data?.legend || {};

  useEffect(() => { document.title = "Platform status · WINDELS AI WORKFORCE"; }, []);

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">PLATFORM <span className="overline-line" /></div><h1>What is actually running.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      <ConnectivityBanner />

      <section className="panel">
        <h2>Runtime</h2>
        <StateBox status={status.status} error={status.error} retry={status.retry} label="Loading status">
          <dl className="status-list">
            <dt>Platform</dt><dd>{status.data.platform}</dd>
            <dt>Version</dt><dd><code>{status.data.version}</code></dd>
            <dt>Node</dt><dd><code>{status.data.runtime?.node}</code> · {status.data.runtime?.env} · adapter {status.data.runtime?.adapter}</dd>
            <dt>Origin</dt><dd>{status.data.origin || <span className="muted">not configured (relative URLs)</span>}</dd>
            <dt>Database</dt><dd>{status.data.readiness?.database ? <span className="badge badge-live">connected</span> : <span className="badge badge-warn">not ready</span>}</dd>
            <dt>Schema</dt><dd>{status.data.readiness?.schema ? <span className="badge badge-live">migrated</span> : <span className="badge badge-warn">migration needed</span>}</dd>
            <dt>Trading</dt><dd><span className="badge badge-warn">{status.data.trading?.enabled ? "enabled" : "disabled"}</span> {status.data.trading?.reason}</dd>
          </dl>
        </StateBox>
      </section>

      <section className="panel">
        <h2>Module port status</h2>
        <StateBox status={features.status} error={features.error} retry={features.retry} label="Loading feature map">
          <p className="muted">{features.data?.honesty}</p>
          <table className="data-table">
            <thead><tr><th>Module</th><th>State</th><th>Meaning</th></tr></thead>
            <tbody>
              {(status.data?.modules || []).map((module) => (
                <tr key={module.key}>
                  <td>{module.label}</td>
                  <td><span className={`badge badge-${module.state === "ported" ? "live" : module.state === "partial" ? "warn" : "muted"}`}>{module.state}</span></td>
                  <td className="muted">{legend[module.state] || ""}{module.tests ? ` · tests: ${module.tests}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </StateBox>
      </section>
    </div>
  );
}

/* ------------------------------------------------------ lottery operations */

/** Badge for a mutation the console is running, finished or failed. */
function RunState({ state, onDismiss }) {
  if (!state || state.status === "idle") return null;
  if (state.status === "running") return <div className="state-box state-loading"><span className="state-dot" />{state.label}…</div>;
  const tone = state.status === "error" ? "error" : "info";
  return (
    <Notice tone={tone}>
      {state.message}
      {onDismiss ? <button className="text-button lottery-dismiss" type="button" onClick={onDismiss}>Dismiss</button> : null}
    </Notice>
  );
}

/** A draw's numbers, mains then stars, from the typed rows when present. */
function DrawNumbers({ draw }) {
  return (
    <>
      <p className="lottery-number-line"><span>Mains</span><b>{listToText(drawNumbers(draw, "MAIN"))}</b></p>
      <p className="lottery-number-line"><span>Lucky Stars</span><b>{listToText(drawNumbers(draw, "STAR"))}</b></p>
    </>
  );
}

function LotteryDrawTable({ draws }) {
  if (!draws.length) return <p className="empty">No draws are stored. The console does not generate or substitute official results — run a sync when a provider is configured.</p>;
  return (
    <div className="scroll">
      <table className="data-table">
        <thead><tr><th>Draw date</th><th>Mains</th><th>Lucky Stars</th><th>Source</th><th>Verification</th><th>Jackpot (recorded)</th><th>Retrieved (UTC)</th></tr></thead>
        <tbody>
          {draws.map((draw) => (
            <tr key={draw.id}>
              <td><code>{draw.draw_date || "—"}</code></td>
              <td>{listToText(drawNumbers(draw, "MAIN"))}</td>
              <td>{listToText(drawNumbers(draw, "STAR"))}</td>
              <td className="muted">{draw.source || "unknown"}{draw.payload?.source ? ` · ${draw.payload.source}` : ""}</td>
              <td><span className={`badge ${verificationTone(draw.verification_status)}`}>{draw.verification_status || "UNKNOWN"}</span></td>
              <td className="muted">{draw.jackpot ?? "—"}{Number(draw.rollover) === 1 ? " · rollover" : ""}</td>
              <td className="muted">{formatDateTime(draw.retrieved_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Lottery operations console (Phase 30, row 15) — the port of
 * `application/views/lottery/index.php` plus the surfaces the Node module added
 * afterwards (draws browser, statistics, jobs, performance).
 *
 * The screen is evidence-only apart from two administrator actions (a provider
 * probe and a sync), and both are explicit POSTs under `lottery.manage`: the legacy
 * console had the same rule, and no panel load may trigger outbound I/O.
 */
export function LotteryOperationsView({ permissions }) {
  const canView = permissions.includes("lottery.view");
  const canManage = permissions.includes("lottery.manage");
  const [refresh, setRefresh] = useState(0);
  const [drawFilters, setDrawFilters] = useState({ limit: 25, from: "", to: "" });
  const [drawQuery, setDrawQuery] = useState({ limit: 25, from: "", to: "" });
  const [statisticsKind, setStatisticsKind] = useState("numbers");
  const [statisticsWindow, setStatisticsWindow] = useState(45);
  const [run, setRun] = useState(null);

  useEffect(() => { document.title = "Lottery operations · WINDELS AI WORKFORCE"; }, []);

  const status = useResource(() => endpoints.lotteryStatus(), [refresh]);
  const health = useResource(() => (canView ? endpoints.lotteryHealth() : Promise.resolve(null)), [canView, refresh]);
  const providers = useResource(() => (canView ? endpoints.lotteryProviders() : Promise.resolve(null)), [canView, refresh]);
  const draws = useResource(() => {
    if (!canView) return Promise.resolve(null);
    const params = new URLSearchParams({ limit: String(drawQuery.limit) });
    if (drawQuery.from) params.set("from", drawQuery.from);
    if (drawQuery.to) params.set("to", drawQuery.to);
    return endpoints.lotteryDraws(`?${params.toString()}`);
  }, [canView, drawQuery, refresh]);
  const statistics = useResource(
    () => (canView ? endpoints.lotteryStatistics(statisticsKind, `?window=${statisticsWindow}`) : Promise.resolve(null)),
    [canView, statisticsKind, statisticsWindow, refresh],
  );
  const decisions = useResource(() => (canView ? endpoints.lotteryDecisions("?limit=10") : Promise.resolve(null)), [canView, refresh]);
  const jobs = useResource(() => (canView ? endpoints.lotteryJobs("?limit=15") : Promise.resolve(null)), [canView, refresh]);
  const performance = useResource(() => (canView ? endpoints.lotteryPerformance() : Promise.resolve(null)), [canView, refresh]);

  const rules = status.data?.rules ?? null;
  const live = health.data?.live ?? status.data?.provider ?? null;
  const latestHealth = health.data?.latest ?? null;
  const history = health.data?.history ?? [];
  const registry = providers.data?.providers ?? [];
  const drawRows = draws.data?.draws ?? [];
  const lastDraw = status.data?.lastDraw ?? drawRows[0] ?? null;

  async function manage(action) {
    setRun({ status: "running", label: action === "probe" ? "Probing the provider" : "Syncing draw history" });
    try {
      if (action === "probe") {
        const result = await endpoints.lotteryCheckProvider();
        setRun({ status: "done", message: `Provider check recorded: ${result.provider ?? "unknown"} is ${result.live?.state ?? "UNKNOWN"}${result.persisted === false ? " (not persisted on this host)" : ""}. ${result.live?.message ?? ""}` });
      } else {
        const { result } = await endpoints.lotterySync({ limit: 200 });
        setRun({ status: "done", message: `Sync ${result.status ?? "UNKNOWN"} via ${result.provider ?? "unknown"}: ${formatCount(result.imported)} imported, ${formatCount(result.unchanged)} unchanged, ${formatCount(result.failed)} failed, ${formatCount(result.conflicts)} conflicts.` });
      }
      setRefresh((value) => value + 1);
    } catch (error) {
      setRun({ status: "error", message: formFailure(error) });
    }
  }

  if (!canView) {
    return (
      <div className="view">
        <header className="view-header">
          <div><div className="overline">LOTTERY · OPERATIONS <span className="overline-line" /></div><h1>Lottery operations.</h1></div>
          <Link className="text-button" to="/app/">Back to overview</Link>
        </header>
        <section className="panel">
          <h2>Permission required</h2>
          <Notice tone="error">Your account does not have <code>lottery.view</code> permission for this console.</Notice>
        </section>
      </div>
    );
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">LOTTERY · OPERATIONS <span className="overline-line" /></div><h1>Lottery operations.</h1></div>
        <div className="lottery-head-actions">
          <Link className="text-button" to="/app/lottery/lab">Open the lab →</Link>
          <Link className="text-button" to="/app/">Back to overview</Link>
        </div>
      </header>

      <Notice tone="warn">
        Lottery draws are independent random events. Historical frequency, balance scores and generation modes do not predict or improve a line&apos;s chance of winning.
        Sandbox records remain synthetic and are never presented as official results.
      </Notice>

      {canManage ? (
        <div className="lottery-actions" aria-label="Lottery administrator actions">
          <button className="secondary-button" type="button" onClick={() => manage("probe")} disabled={run?.status === "running"}>Check provider health</button>
          <button className="primary-button" type="button" onClick={() => manage("sync")} disabled={run?.status === "running"}>Sync draw history</button>
          <span className="field-hint">Health probes and synchronization requests are CSRF-protected and audited. Provider activation and credentials stay server-side.</span>
        </div>
      ) : null}
      <RunState state={run} onDismiss={() => setRun(null)} />

      <StateBox status={status.status} error={status.error} retry={status.retry} label="Loading lottery status">
        <section className="system-status" aria-label="Lottery engine status">
          <div className="system-status-heading"><span className="overline">ENGINE &amp; STORED EVIDENCE</span>
            <span className={`badge ${providerTone(live?.state)}`}>{live?.state || "UNKNOWN"}</span>
          </div>
          <div className="status-grid">
            <div><small>ENGINE STATE</small><strong>{status.data?.engine || "—"}</strong></div>
            <div><small>TRACKED DRAWS</small><strong>{formatCount(status.data?.drawsTracked)}</strong></div>
            <div><small>ACTIVE RULES</small><strong>{rules?.version ?? "—"}</strong><span className="muted">{formatCount(rules?.main?.count)} mains · {formatCount(rules?.stars?.count)} Lucky Stars</span></div>
            <div><small>MODEL VERSION</small><strong>{status.data?.modelVersion || "—"}</strong></div>
          </div>
        </section>
      </StateBox>

      <div className="lottery-grid">
        <section className="panel">
          <h2>Provider health</h2>
          <StateBox status={health.status} error={health.error} retry={health.retry} label="Loading provider health">
            <div className="lottery-provider-heading">
              <div>
                <div className="lottery-provider-name">{health.data?.provider || "unknown"}</div>
                <p className="muted">{live?.message || "Provider health is unavailable."}</p>
              </div>
              <span className={`badge ${providerTone(live?.state)}`}>{live?.state || "UNKNOWN"}</span>
            </div>
            <dl className="lottery-meta">
              <dt>Source class</dt><dd>{live?.synthetic ? "Synthetic sandbox" : live?.licensed ? "Authorized provider" : "No live source confirmed"}</dd>
              <dt>License metadata</dt><dd>{live?.licensed ? "Configured / confirmed" : "Not confirmed"}</dd>
              <dt>Last recorded check</dt><dd>{latestHealth ? formatDateTime(latestHealth.observed_at) : "No persisted health check"}</dd>
              <dt>Last response time</dt><dd>{latestHealth?.response_ms === undefined || latestHealth?.response_ms === null ? "—" : `${formatCount(latestHealth.response_ms)} ms`}</dd>
              <dt>Last draw retrieved</dt><dd>{latestHealth?.last_draw_retrieved || "—"}</dd>
              <dt>Synthetic data</dt><dd>{live?.synthetic || Number(latestHealth?.synthetic) === 1 ? "Yes — simulation only" : "No / not reported"}</dd>
            </dl>
            <h3 className="lottery-subheading">Health history</h3>
            {history.length ? (
              <div className="scroll">
                <table className="data-table">
                  <thead><tr><th>Observed (UTC)</th><th>State</th><th>Response</th><th>Records</th><th>Invalid</th><th>Data label</th></tr></thead>
                  <tbody>
                    {history.map((record) => (
                      <tr key={record.id}>
                        <td className="muted">{formatDateTime(record.observed_at)}</td>
                        <td><span className="badge badge-muted">{record.status || "UNKNOWN"}</span></td>
                        <td>{record.response_ms === null ? "—" : `${formatCount(record.response_ms)} ms`}</td>
                        <td>{formatCount(record.records_received)}</td>
                        <td>{formatCount(record.invalid_records)}</td>
                        <td>{Number(record.synthetic) === 1 ? <span className="badge badge-warn">SYNTHETIC</span> : <span className="muted">reported live / unavailable</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="empty">No health observations have been saved yet. An administrator can record a probe when the source is configured.</p>}
          </StateBox>
        </section>

        <aside className="panel">
          <h2>Latest stored draw</h2>
          {lastDraw ? (
            <>
              <dl className="lottery-meta">
                <dt>Draw date</dt><dd>{formatDate(lastDraw.draw_date)}</dd>
                <dt>Source</dt><dd>{lastDraw.source || "unknown"}</dd>
                <dt>Verification</dt><dd><span className={`badge ${verificationTone(lastDraw.verification_status)}`}>{lastDraw.verification_status || "UNKNOWN"}</span></dd>
                <dt>Retrieved</dt><dd>{formatDateTime(lastDraw.retrieved_at)}</dd>
              </dl>
              <DrawNumbers draw={lastDraw} />
            </>
          ) : <p className="empty">No draws are stored. The console does not generate or substitute official results.</p>}
          <p className="muted lottery-rules-note">
            Rules: {formatCount(rules?.main?.count)} mains from {formatCount(rules?.main?.min)}–{formatCount(rules?.main?.max)};
            {" "}{formatCount(rules?.stars?.count)} Lucky Stars from {formatCount(rules?.stars?.min)}–{formatCount(rules?.stars?.max)}.
            {" "}The schedule ({listToText(rules?.schedule?.days)} · {rules?.schedule?.time ?? "—"} {rules?.schedule?.timezone ?? ""}) is stored configuration, not an odds forecast.
          </p>
          <h3 className="lottery-subheading">Provider registry</h3>
          {registry.length ? (
            <div className="scroll">
              <table className="data-table">
                <thead><tr><th>Provider</th><th>Registry flag</th><th>Data class</th></tr></thead>
                <tbody>
                  {registry.map((entry) => (
                    <tr key={entry.id ?? entry.provider_code}>
                      <td><b>{entry.display_name || entry.provider_code || "Unknown"}</b><br /><span className="muted"><code>{entry.provider_code}</code></span></td>
                      <td>{Number(entry.enabled) === 1 ? "Enabled" : "Not enabled"}</td>
                      <td>{Number(entry.synthetic) === 1 ? <span className="badge badge-warn">SYNTHETIC</span> : "Non-synthetic"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">No provider registry rows yet. A health probe or a successful ingestion creates a source record.</p>}
          <p className="field-hint">Registry metadata does not activate a provider. Effective access is controlled by server-side environment settings and source authorization.</p>
        </aside>
      </div>

      <section className="panel">
        <div className="audit-section-heading">
          <div><h2>Stored draws</h2><p className="muted">Every row is what the provider returned, with its source and verification state. A closed draw is not evidence of a verified one.</p></div>
          <form className="lottery-draw-filters" onSubmit={(event) => { event.preventDefault(); setDrawQuery({ ...drawFilters }); }}>
            <Field label="From" htmlFor="lottery-from"><input id="lottery-from" type="date" value={drawFilters.from} onChange={(event) => setDrawFilters((current) => ({ ...current, from: event.target.value }))} /></Field>
            <Field label="To" htmlFor="lottery-to"><input id="lottery-to" type="date" value={drawFilters.to} onChange={(event) => setDrawFilters((current) => ({ ...current, to: event.target.value }))} /></Field>
            <Field label="Rows" htmlFor="lottery-draw-limit">
              <select id="lottery-draw-limit" value={drawFilters.limit} onChange={(event) => setDrawFilters((current) => ({ ...current, limit: Number(event.target.value) }))}>
                {[10, 25, 50, 100].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
              </select>
            </Field>
            <button className="secondary-button" type="submit">Apply</button>
          </form>
        </div>
        <StateBox status={draws.status} error={draws.error} retry={draws.retry} label="Loading stored draws">
          <LotteryDrawTable draws={drawRows} />
        </StateBox>
      </section>

      <section className="panel">
        <div className="audit-section-heading">
          <div>
            <h2>Statistics</h2>
            <p className="muted">Historical observations over the stored draws. Every figure describes the past; none is a probability of a future draw.</p>
          </div>
          <div className="lottery-stat-controls">
            <Field label="Kind" htmlFor="lottery-stat-kind">
              <select id="lottery-stat-kind" value={statisticsKind} onChange={(event) => setStatisticsKind(event.target.value)}>
                {STATISTICS_KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </Field>
            <Field label="Window (0 = all)" htmlFor="lottery-stat-window">
              <input id="lottery-stat-window" type="number" min="0" max="10000" value={statisticsWindow}
                onChange={(event) => setStatisticsWindow(Math.max(0, Number(event.target.value) || 0))} />
            </Field>
          </div>
        </div>
        <StateBox status={statistics.status} error={statistics.error} retry={statistics.retry} label="Loading statistics">
          {statisticsKind === "distribution" ? (
            <dl className="lottery-meta lottery-meta-wide">
              {distributionMetrics(statistics.data?.data).map((pair) => (
                <span className="lottery-metric-pair" key={pair.label}><dt>{pair.label}</dt><dd>{pair.value}</dd></span>
              ))}
            </dl>
          ) : (() => {
            const table = statisticsRows(statisticsKind, statistics.data?.data);
            if (!table.rows.length) return <p className="empty">No observations for this kind yet — the table fills once draws are stored.</p>;
            return (
              <div className="scroll">
                <table className="data-table">
                  <thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                  <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          })()}
        </StateBox>
        <p className="muted lottery-note">{statistics.data?.data?.disclaimer || statistics.data?.data?.observation || ""}</p>
      </section>

      <section className="panel">
        <h2>AI decision reports <span className="badge badge-muted">Historical records · not predictions</span></h2>
        <p className="muted">Each report records the model, mode, seed, dataset/rules version, actual factors and generated lines for reproducibility. Scores are balance statistics only — not probability estimates.</p>
        <StateBox status={decisions.status} error={decisions.error} retry={decisions.retry} label="Loading decision reports">
          {(decisions.data?.decisions ?? []).length ? (
            <div className="scroll">
              <table className="data-table">
                <thead><tr><th>ID</th><th>Created</th><th>Mode</th><th>Model</th><th>Combination</th><th>Report</th></tr></thead>
                <tbody>
                  {(decisions.data?.decisions ?? []).map((row) => {
                    const decision = row.decision ?? {};
                    const inputs = decision.inputs ?? {};
                    const lines = Array.isArray(decision.lines) ? decision.lines : [];
                    return (
                      <tr key={row.id}>
                        <td><code>#{row.id}</code></td>
                        <td className="muted">{formatDateTime(row.created_at)}</td>
                        <td><span className="badge badge-muted">{row.mode || decision.mode || "UNKNOWN"}</span></td>
                        <td>{row.model_version || decision.model || "—"}</td>
                        <td>{row.combination_id ? <code>#{row.combination_id}</code> : "—"}</td>
                        <td>
                          <details className="lottery-details">
                            <summary>Inspect report</summary>
                            <dl className="lottery-meta">
                              <dt>Method</dt><dd>{decision.factors?.method || "Not recorded"}</dd>
                              <dt>Seed</dt><dd><code>{inputs.seed === undefined || inputs.seed === null ? "—" : String(inputs.seed)}</code></dd>
                              <dt>Rules / dataset</dt><dd>{inputs.rulesVersion || "—"} · {inputs.datasetVersion || "—"}</dd>
                              <dt>Generated lines</dt><dd>{formatCount(lines.length)}</dd>
                            </dl>
                            {lines.length ? <ul className="lottery-lines">{lines.map((line, index) => <li key={index}>{generatedLineText(line)}</li>)}</ul> : null}
                            <details className="lottery-details"><summary>Full decision payload</summary><pre>{JSON.stringify(decision, null, 2)}</pre></details>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No decision reports stored yet. Generate a combination in the lab to create a report linked to its saved combination.</p>
          )}
        </StateBox>
      </section>

      <div className="lottery-grid">
        <section className="panel">
          <h2>Sync runs</h2>
          <p className="muted">The ingestion evidence: one row per sync, system build or cron job, with its execution key.</p>
          <StateBox status={jobs.status} error={jobs.error} retry={jobs.retry} label="Loading job runs">
            {(jobs.data?.jobs ?? []).length ? (
              <div className="scroll">
                <table className="data-table">
                  <thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Ended</th><th>Processed</th><th>Created</th><th>Updated</th></tr></thead>
                  <tbody>
                    {(jobs.data?.jobs ?? []).map((job) => (
                      <tr key={job.id}>
                        <td><code>{job.job_type}</code></td>
                        <td><span className={`badge ${String(job.status).toUpperCase() === "OK" ? "badge-live" : "badge-muted"}`}>{job.status}</span></td>
                        <td className="muted">{formatDateTime(job.started_at)}</td>
                        <td className="muted">{job.ended_at ? formatDateTime(job.ended_at) : "—"}</td>
                        <td>{formatCount(job.records_processed)}</td>
                        <td>{formatCount(job.records_created)}</td>
                        <td>{formatCount(job.records_updated)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="empty">No job runs recorded yet. A sync or a system build writes one.</p>}
          </StateBox>
        </section>

        <section className="panel">
          <h2>Performance overview</h2>
          <StateBox status={performance.status} error={performance.error} retry={performance.retry} label="Loading performance">
            {(() => {
              const data = performance.data;
              if (!data) return null;
              const tiers = tierRows(data.actualTicketResults?.byTier);
              return (
                <>
                  <p className="muted">{data.label}</p>
                  <h3 className="lottery-subheading">{data.actualTicketResults?.section}</h3>
                  <dl className="lottery-meta">
                    <dt>Tickets total</dt><dd>{formatCount(data.actualTicketResults?.ticketsTotal)}</dd>
                    <dt>Tickets checked</dt><dd>{formatCount(data.actualTicketResults?.ticketsChecked)}</dd>
                    <dt>Lines checked</dt><dd>{formatCount(data.actualTicketResults?.linesChecked)}</dd>
                  </dl>
                  {tiers.length ? (
                    <table className="data-table"><thead><tr><th>Prize tier</th><th>Lines</th></tr></thead>
                      <tbody>{tiers.map(([tier, count]) => <tr key={tier}><td>{tier}</td><td>{count}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="empty">No checked lines yet — prize tiers appear here, never amounts.</p>}
                  <h3 className="lottery-subheading">{data.historicalBacktestResults?.section}</h3>
                  <p className="muted">{formatCount(data.historicalBacktestResults?.count)} stored backtest report(s). {data.historicalBacktestResults?.note}</p>
                  {(data.historicalBacktestResults?.recent ?? []).length ? (
                    <ul className="lottery-lines">
                      {data.historicalBacktestResults.recent.map((row) => (
                        <li key={row.id}>#{row.id} · {row.strategy} · {formatCount(row.drawsTested)} draws · {formatDate(row.periodFrom)} → {formatDate(row.periodTo)}</li>
                      ))}
                    </ul>
                  ) : null}
                  <h3 className="lottery-subheading">{data.demoSandboxData?.section}</h3>
                  <p className="muted">{data.demoSandboxData?.provider} · {data.demoSandboxData?.state} · {formatCount(data.demoSandboxData?.drawsTracked)} draws tracked. {data.demoSandboxData?.note}</p>
                  <p className="field-hint">{data.separationNote}</p>
                </>
              );
            })()}
          </StateBox>
        </section>
      </div>

      <section className="panel lottery-boundary">
        <h2>Module boundary</h2>
        <p className="muted">Reported by <code>/api/v1/lottery/status</code> — what this module does not do.</p>
        {(status.data?.notPorted ?? []).length ? (
          <ul className="lottery-lines">
            {status.data.notPorted.map((entry) => <li key={entry.area}><b>{entry.area}</b> — {entry.state}: {entry.detail}</li>)}
          </ul>
        ) : <p className="empty">The status route reports no unported area.</p>}
        <p className="muted lottery-disclaimer">{status.data?.disclaimer}</p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- lottery lab */

/**
 * Lottery lab (Phase 30, row 15) — the writing half: the generator, combination
 * history, the diversity check, saved tickets, the Strategy Lab and the model
 * versions.
 *
 * Everything here either creates an **analysis record** (combination, decision,
 * backtest) or a **saved ticket** — a record of numbers a person holds, never a
 * purchase. Nothing in this screen can reach a payment path, and the ticket copy
 * says so in the same words the module's own documentation uses.
 */
export function LotteryLabView({ permissions }) {
  const canView = permissions.includes("lottery.view");
  const canManage = permissions.includes("lottery.manage");
  const [refresh, setRefresh] = useState(0);
  const [generateForm, setGenerateForm] = useState({ mode: "BALANCED", count: 1, seed: "", locks: "", excludes: "" });
  const [generate, setGenerate] = useState({ status: "idle", report: null, error: null, problems: [] });
  const [ticketForm, setTicketForm] = useState({ name: "", drawDate: "", lines: "" });
  const [ticketState, setTicketState] = useState({ status: "idle", error: null, problems: [], message: "" });
  const [ticketResults, setTicketResults] = useState({});
  const [backtestForm, setBacktestForm] = useState({ strategy: "RANDOM_BASELINE", lines: 1, window: 20 });
  const [compareStrategies, setCompareStrategies] = useState(["RANDOM_BASELINE", "BALANCED_PROFILE"]);
  const [backtest, setBacktest] = useState({ status: "idle", report: null, error: null });
  const [systemForm, setSystemForm] = useState({ mains: "", stars: "" });
  const [system, setSystem] = useState({ status: "idle", data: null, error: null });

  useEffect(() => { document.title = "Lottery lab · WINDELS AI WORKFORCE"; }, []);

  const combinations = useResource(() => (canView ? endpoints.lotteryCombinations("?limit=15") : Promise.resolve(null)), [canView, refresh]);
  const tickets = useResource(() => (canView ? endpoints.lotteryTickets("?limit=25") : Promise.resolve(null)), [canView, refresh]);
  const backtests = useResource(() => (canView ? endpoints.lotteryBacktests("?limit=10") : Promise.resolve(null)), [canView, refresh]);
  const models = useResource(() => (canView ? endpoints.lotteryModels() : Promise.resolve(null)), [canView, refresh]);

  async function runGenerate(event) {
    event.preventDefault();
    const problems = validateGenerateForm(generateForm);
    if (problems.length) {
      setGenerate({ status: "invalid", report: null, error: null, problems });
      return;
    }
    setGenerate({ status: "running", report: null, error: null, problems: [] });
    try {
      const report = await endpoints.lotteryGenerate(buildGenerateBody(generateForm));
      setGenerate({ status: "ready", report, error: null, problems: [] });
      setRefresh((value) => value + 1);
    } catch (error) {
      setGenerate({ status: "error", report: null, error, problems: [] });
    }
  }

  async function saveTicket(event) {
    event.preventDefault();
    const { lines, problems } = parseTicketLines(ticketForm.lines);
    if (problems.length) {
      setTicketState({ status: "invalid", error: null, problems, message: "" });
      return;
    }
    setTicketState({ status: "running", error: null, problems: [], message: "" });
    try {
      await endpoints.lotteryCreateTicket(buildTicketBody(ticketForm, { lines }));
      setTicketState({ status: "done", error: null, problems: [], message: "Ticket saved as a record. It is not a purchase and no money changed hands." });
      setTicketForm({ name: "", drawDate: "", lines: "" });
      setRefresh((value) => value + 1);
    } catch (error) {
      setTicketState({ status: "error", error, problems: [], message: formFailure(error) });
    }
  }

  async function checkTicket(ticketId) {
    setTicketResults((current) => ({ ...current, [ticketId]: { status: "running" } }));
    try {
      const result = await endpoints.lotteryCheckTicket(ticketId);
      setTicketResults((current) => ({ ...current, [ticketId]: { status: "ready", result } }));
      setRefresh((value) => value + 1);
    } catch (error) {
      setTicketResults((current) => ({ ...current, [ticketId]: { status: "error", message: formFailure(error) } }));
    }
  }

  async function archiveTicket(ticketId) {
    setTicketResults((current) => ({ ...current, [ticketId]: { status: "running" } }));
    try {
      await endpoints.lotteryDeleteTicket(ticketId);
      setTicketResults((current) => ({ ...current, [ticketId]: { status: "archived" } }));
      setRefresh((value) => value + 1);
    } catch (error) {
      setTicketResults((current) => ({ ...current, [ticketId]: { status: "error", message: formFailure(error) } }));
    }
  }

  async function runBacktest(event) {
    event.preventDefault();
    setBacktest({ status: "running", report: null, error: null });
    try {
      const report = await endpoints.lotteryBacktest(buildBacktestBody(backtestForm));
      setBacktest({ status: "ready", report, error: null });
      setRefresh((value) => value + 1);
    } catch (error) {
      setBacktest({ status: "error", report: null, error });
    }
  }

  async function runCompare() {
    setBacktest({ status: "running", report: null, error: null });
    try {
      const report = await endpoints.lotteryBacktestCompare(buildCompareBody({ ...backtestForm, strategies: compareStrategies }));
      setBacktest({ status: "ready", report, error: null });
      setRefresh((value) => value + 1);
    } catch (error) {
      setBacktest({ status: "error", report: null, error });
    }
  }

  async function runSystem(event, { background = false } = {}) {
    event?.preventDefault();
    setSystem({ status: "running", data: null, error: null });
    const payload = {
      mains: (systemForm.mains.match(/\d{1,2}/g) ?? []).map(Number),
      stars: (systemForm.stars.match(/\d{1,2}/g) ?? []).map(Number),
    };
    try {
      const data = background
        ? await endpoints.lotterySystemBuild(payload)
        : await endpoints.lotterySystem({ ...payload, page: 0, limit: 25 });
      setSystem({ status: "ready", data, error: null });
      setRefresh((value) => value + 1);
    } catch (error) {
      setSystem({ status: "error", data: null, error });
    }
  }

  if (!canView) {
    return (
      <div className="view">
        <header className="view-header">
          <div><div className="overline">LOTTERY · LAB <span className="overline-line" /></div><h1>Lottery lab.</h1></div>
          <Link className="text-button" to="/app/">Back to overview</Link>
        </header>
        <section className="panel">
          <h2>Permission required</h2>
          <Notice tone="error">Your account does not have <code>lottery.view</code> permission for this console.</Notice>
        </section>
      </div>
    );
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">LOTTERY · LAB <span className="overline-line" /></div><h1>Lottery lab.</h1></div>
        <div className="lottery-head-actions">
          <Link className="text-button" to="/app/lottery">← Operations</Link>
          <Link className="text-button" to="/app/">Back to overview</Link>
        </div>
      </header>

      <Notice tone="warn">
        Generation, scoring and backtests are <b>analysis records</b>, not predictions, and every report is a historical simulation where it replays the past.
        Saved tickets are records of numbers you hold — the platform cannot buy a ticket.
      </Notice>

      <div className="lottery-grid">
        <section className="panel">
          <h2>Generate a combination</h2>
          <form className="panel-form" onSubmit={runGenerate}>
            <Field label="Mode" htmlFor="lottery-mode">
              <select id="lottery-mode" value={generateForm.mode} onChange={(event) => setGenerateForm((current) => ({ ...current, mode: event.target.value }))}>
                {GENERATOR_MODES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </Field>
            <Field label="Lines" htmlFor="lottery-count" error={generate.problems?.find((problem) => problem.field === "count")?.message} hint={`1–${MAX_GENERATE_COUNT}; each line is generated and stored with its report.`}>
              <input id="lottery-count" type="number" min="1" max={MAX_GENERATE_COUNT} value={generateForm.count}
                onChange={(event) => setGenerateForm((current) => ({ ...current, count: event.target.value }))} />
            </Field>
            <Field label="Seed (optional)" htmlFor="lottery-seed" error={generate.problems?.find((problem) => problem.field === "seed")?.message} hint="The same seed and dataset reproduce the same lines.">
              <input id="lottery-seed" type="number" value={generateForm.seed} placeholder="blank = random"
                onChange={(event) => setGenerateForm((current) => ({ ...current, seed: event.target.value }))} />
            </Field>
            <Field label="Locked numbers (optional)" htmlFor="lottery-locks" error={generate.problems?.find((problem) => problem.field === "locks")?.message}>
              <input id="lottery-locks" value={generateForm.locks} placeholder="e.g. 7, 21"
                onChange={(event) => setGenerateForm((current) => ({ ...current, locks: event.target.value }))} />
            </Field>
            <Field label="Excluded numbers (optional)" htmlFor="lottery-excludes" error={generate.problems?.find((problem) => problem.field === "excludes")?.message}>
              <input id="lottery-excludes" value={generateForm.excludes} placeholder="e.g. 13"
                onChange={(event) => setGenerateForm((current) => ({ ...current, excludes: event.target.value }))} />
            </Field>
            {generate.status === "invalid" ? (
              <div className="notice notice-error" role="alert">
                <ul className="portfolio-problems">{generate.problems.map((problem, index) => <li key={index}>{problem.message}</li>)}</ul>
              </div>
            ) : null}
            {generate.status === "error" ? <div className="notice notice-error" role="alert">{formFailure(generate.error)}{generate.error?.code ? <span className="state-code"> {generate.error.code}</span> : null}</div> : null}
            <button className="primary-button" type="submit" disabled={generate.status === "running"}>{generate.status === "running" ? "Generating…" : "Generate and store"}</button>
          </form>
        </section>

        <section className="panel">
          <h2>Generated report</h2>
          {generate.status === "ready" && generate.report ? (
            <>
              <dl className="lottery-meta">
                <dt>Model</dt><dd>{generate.report.model} · {generate.report.mode}</dd>
                <dt>Seed</dt><dd><code>{generate.report.inputs?.seed ?? "—"}</code></dd>
                <dt>Draws used</dt><dd>{formatCount(generate.report.inputs?.drawsUsed)} · dataset {generate.report.inputs?.datasetVersion || "—"}</dd>
                <dt>Average balance score</dt><dd>{formatNumber(generate.report.averageBalanceScore, 1)}</dd>
                <dt>Stored as</dt><dd>combination <code>#{generate.report.saved?.combinationId}</code> · decision <code>#{generate.report.saved?.decisionId}</code></dd>
              </dl>
              <ul className="lottery-lines">
                {(generate.report.lines ?? []).map((line, index) => <li key={index}>{generatedLineText(line)} <span className="muted">score {formatNumber(line.score, 0)}</span></li>)}
              </ul>
              <details className="lottery-details">
                <summary>Method and targets</summary>
                <p className="muted">{(generate.report.factors?.method) || "—"}</p>
                <dl className="lottery-meta">
                  <dt>Sum range</dt><dd>{listToText(generate.report.factors?.targets?.sumRange)}</dd>
                  <dt>Odd range</dt><dd>{listToText(generate.report.factors?.targets?.oddRange)}</dd>
                  <dt>Low range</dt><dd>{listToText(generate.report.factors?.targets?.lowRange)}</dd>
                  <dt>Max adjacent pairs</dt><dd>{formatCount(generate.report.factors?.targets?.maxAdjacentPairs)}</dd>
                </dl>
              </details>
              <p className="muted">{generate.report.honestyNote}</p>
            </>
          ) : <p className="empty">No generation in this tab yet. Every generation is stored with its report so it can be reproduced.</p>}
        </section>
      </div>

      <section className="panel">
        <h2>Saved combinations</h2>
        <StateBox status={combinations.status} error={combinations.error} retry={combinations.retry} label="Loading combinations">
          {(combinations.data?.combinations ?? []).length ? (
            <div className="scroll">
              <table className="data-table">
                <thead><tr><th>ID</th><th>Created</th><th>Mode</th><th>Model</th><th>Seed</th><th>Lines</th><th>Lines</th></tr></thead>
                <tbody>
                  {(combinations.data?.combinations ?? []).map((row) => (
                    <tr key={row.id}>
                      <td><code>#{row.id}</code></td>
                      <td className="muted">{formatDateTime(row.created_at)}</td>
                      <td><span className="badge badge-muted">{row.mode}</span></td>
                      <td>{row.model_version || "—"}</td>
                      <td><code>{row.seed ?? "—"}</code></td>
                      <td>{formatCount(row.line_count)}</td>
                      <td className="muted">{(row.lines ?? []).map((line) => generatedLineText(line)).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">No combinations stored yet.</p>}
        </StateBox>
      </section>

      <section className="panel">
        <h2>Saved tickets</h2>
        <p className="muted">Tickets are records of numbers you hold and are visible only to you. Checking compares them against a stored <b>VERIFIED</b> draw and reports official prize-tier labels — never an amount.</p>
        <form className="panel-form" onSubmit={saveTicket}>
          <Field label="Name" htmlFor="lottery-ticket-name"><input id="lottery-ticket-name" value={ticketForm.name} maxLength="200" placeholder="e.g. Friday family line" onChange={(event) => setTicketForm((current) => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="Draw date (optional)" htmlFor="lottery-ticket-date"><input id="lottery-ticket-date" type="date" value={ticketForm.drawDate} onChange={(event) => setTicketForm((current) => ({ ...current, drawDate: event.target.value }))} /></Field>
          <Field label="Lines" htmlFor="lottery-ticket-lines" hint="One line per row: 1,2,3,4,5 | 1,2 (mains | Lucky Stars).">
            <textarea id="lottery-ticket-lines" rows="3" value={ticketForm.lines} placeholder={"1,2,3,4,5 | 1,2"} onChange={(event) => setTicketForm((current) => ({ ...current, lines: event.target.value }))} />
          </Field>
          {ticketState.status === "invalid" ? (
            <div className="notice notice-error" role="alert"><ul className="portfolio-problems">{ticketState.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></div>
          ) : null}
          {ticketState.status === "error" ? <div className="notice notice-error" role="alert">{ticketState.message}</div> : null}
          {ticketState.status === "done" ? <Notice tone="info">{ticketState.message}</Notice> : null}
          <button className="secondary-button" type="submit" disabled={ticketState.status === "running"}>{ticketState.status === "running" ? "Saving…" : `Save ticket (${DEFAULT_TICKET_METHOD.toLowerCase()} method)`}</button>
        </form>

        <StateBox status={tickets.status} error={tickets.error} retry={tickets.retry} label="Loading tickets">
          {(tickets.data?.tickets ?? []).length ? (
            <div className="scroll">
              <table className="data-table">
                <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Draw date</th><th>Lines</th><th>Actions</th></tr></thead>
                <tbody>
                  {(tickets.data?.tickets ?? []).map((ticket) => {
                    const state = ticketResults[ticket.id];
                    return (
                      <tr key={ticket.id}>
                        <td><code>#{ticket.id}</code></td>
                        <td>{ticket.name}</td>
                        <td><span className="badge badge-muted">{ticket.status}</span></td>
                        <td className="muted">{ticket.draw_date ? formatDate(ticket.draw_date) : "—"}</td>
                        <td className="muted">{(ticket.lines ?? []).map((line) => generatedLineText(line)).join(" · ") || "—"}</td>
                        <td>
                          <div className="row-actions">
                            <button className="text-button" type="button" onClick={() => checkTicket(ticket.id)} disabled={state?.status === "running"}>Check</button>
                            <button className="text-button" type="button" onClick={() => archiveTicket(ticket.id)} disabled={state?.status === "running"}>Archive</button>
                          </div>
                          {state?.status === "ready" ? (
                            <div className="lottery-ticket-result">
                              <p className="muted">Against draw {state.result.drawDate} ({state.result.drawSource})</p>
                              <ul className="lottery-lines">
                                {(state.result.lines ?? []).map((line, index) => (
                                  <li key={index}>{generatedLineText(line)} — {formatCount(line.mainMatches)} mains, {formatCount(line.starMatches)} stars{line.prizeTier ? ` · ${line.prizeTier}` : " · no prize tier"}</li>
                                ))}
                              </ul>
                              <p className="field-hint">{state.result.note}</p>
                            </div>
                          ) : null}
                          {state?.status === "archived" ? <p className="muted">Archived.</p> : null}
                          {state?.status === "error" ? <p className="field-error" role="alert">{state.message}</p> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">No saved tickets yet.</p>}
        </StateBox>
      </section>

      <div className="lottery-grid">
        <section className="panel">
          <h2>Strategy Lab <span className="badge badge-muted">HISTORICAL SIMULATION</span></h2>
          <form className="panel-form" onSubmit={runBacktest}>
            <Field label="Strategy" htmlFor="lottery-strategy">
              <select id="lottery-strategy" value={backtestForm.strategy} onChange={(event) => setBacktestForm((current) => ({ ...current, strategy: event.target.value }))}>
                {BACKTEST_STRATEGIES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </Field>
            <Field label="Lines per draw" htmlFor="lottery-bt-lines"><input id="lottery-bt-lines" type="number" min="1" max="10" value={backtestForm.lines} onChange={(event) => setBacktestForm((current) => ({ ...current, lines: event.target.value }))} /></Field>
            <Field label="Window" htmlFor="lottery-bt-window" hint="Draws replayed; blank or 0 uses the engine's own window."><input id="lottery-bt-window" type="number" min="0" max="100" value={backtestForm.window} onChange={(event) => setBacktestForm((current) => ({ ...current, window: event.target.value }))} /></Field>
            <div className="lottery-inline-actions">
              <button className="secondary-button" type="submit" disabled={backtest.status === "running"}>Run backtest</button>
              <button className="text-button" type="button" onClick={runCompare} disabled={backtest.status === "running"}>Compare strategies</button>
            </div>
            <fieldset className="lottery-compare">
              <legend>Strategies to compare (the random baseline is always included)</legend>
              {BACKTEST_STRATEGIES.map((entry) => (
                <label className="checkbox-row" key={entry.value} htmlFor={`compare-${entry.value}`}>
                  <input id={`compare-${entry.value}`} type="checkbox" checked={compareStrategies.includes(entry.value)} disabled={entry.value === "RANDOM_BASELINE"}
                    onChange={(event) => setCompareStrategies((current) => (event.target.checked ? [...current, entry.value] : current.filter((value) => value !== entry.value)))} />
                  {entry.label}
                </label>
              ))}
            </fieldset>
          </form>
          {backtest.status === "error" ? <div className="notice notice-error" role="alert">{formFailure(backtest.error)}{backtest.error?.code ? <span className="state-code"> {backtest.error.code}</span> : null}</div> : null}
          {backtest.status === "running" ? <div className="state-box state-loading"><span className="state-dot" />Replaying stored draws…</div> : null}
          {backtest.status === "ready" && backtest.report ? (
            <div className="lottery-backtest-result">
              <p className="muted">{backtest.report.label} · saved as <code>#{backtest.report.saved?.backtestId}</code></p>
              <p className="muted">{backtest.report.period ? `${formatCount(backtest.report.period.drawsTested)} draws · ${formatDate(backtest.report.period.from)} → ${formatDate(backtest.report.period.to)} · ${formatCount(backtest.report.totalLines)} lines` : `${formatCount((backtest.report.strategies ?? []).length)} strategies compared`}</p>
              <ul className="lottery-lines">
                {(backtest.report.strategy ? [backtest.report] : (backtest.report.strategies ?? [])).map((report) => (
                  <li key={report.strategy}>{report.strategy}: {matchDistribution(report).map((pair) => `${pair.label} ${pair.value}`).join(" · ")}</li>
                ))}
              </ul>
              <p className="muted">{backtest.report.costNote} {backtest.report.winningsNote}</p>
              <p className="muted">{backtest.report.note}</p>
            </div>
          ) : null}
        </section>

        <aside className="panel">
          <h2>Stored backtests</h2>
          <StateBox status={backtests.status} error={backtests.error} retry={backtests.retry} label="Loading backtests">
            {(backtests.data?.backtests ?? []).length ? (
              <ul className="lottery-lines">
                {(backtests.data?.backtests ?? []).map((row) => (
                  <li key={row.id}>#{row.id} · {row.strategy} · {formatCount(row.draws_tested)} draws · {formatDate(row.period_from)} → {formatDate(row.period_to)}</li>
                ))}
              </ul>
            ) : <p className="empty">No stored backtest reports yet.</p>}
          </StateBox>

          <h2 className="lottery-subheading">Model versions</h2>
          <StateBox status={models.status} error={models.error} retry={models.retry} label="Loading model versions">
            {(models.data?.models ?? []).length ? (
              <ul className="lottery-lines">
                {(models.data?.models ?? []).map((model) => (
                  <li key={model.id}>{model.model_name} v{model.model_version} · {model.status}
                    <span className="muted"> · modes: {listToText(model.config?.generatorModes)} · backtests: {listToText(model.config?.backtesterStrategies)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="empty">No model versions recorded yet.</p>}
          </StateBox>
          <p className="field-hint">A model version is ensured once and never replaced, so a stored report always names the model that produced it.</p>
        </aside>
      </div>

      <section className="panel">
        <h2>System builder</h2>
        <p className="muted">Expand a pool into its full combination grid. A system above the synchronous limit is queued for the lottery cron instead of being built in the request.</p>
        <form className="panel-form lottery-system-form" onSubmit={(event) => runSystem(event)}>
          <Field label="Main pool" htmlFor="lottery-sys-mains" hint="At least five numbers, e.g. 1,2,3,4,5,6"><input id="lottery-sys-mains" value={systemForm.mains} onChange={(event) => setSystemForm((current) => ({ ...current, mains: event.target.value }))} /></Field>
          <Field label="Star pool" htmlFor="lottery-sys-stars" hint="Optional, e.g. 1,2,3"><input id="lottery-sys-stars" value={systemForm.stars} onChange={(event) => setSystemForm((current) => ({ ...current, stars: event.target.value }))} /></Field>
          <div className="lottery-inline-actions">
            <button className="secondary-button" type="submit" disabled={system.status === "running"}>Plan and preview</button>
            {canManage ? <button className="text-button" type="button" onClick={(event) => runSystem(event, { background: true })} disabled={system.status === "running"}>Queue background build</button> : null}
          </div>
        </form>
        {system.status === "error" ? <div className="notice notice-error" role="alert">{formFailure(system.error)}{system.error?.code ? <span className="state-code"> {system.error.code}</span> : null}</div> : null}
        {system.status === "ready" && system.data ? (
          <>
            <dl className="lottery-meta">
              <dt>Formula</dt><dd><code>{system.data.plan?.formula ?? "—"}</code></dd>
              <dt>Total lines</dt><dd>{formatCount(system.data.plan?.totalLines ?? system.data.totalLines)}</dd>
              <dt>Cost</dt><dd>{system.data.plan?.estimatedCost === null || system.data.plan?.estimatedCost === undefined ? system.data.plan?.costNote ?? "—" : system.data.plan.estimatedCost}</dd>
              <dt>Queued</dt><dd>{system.data.queued ? "Yes — background build" : "No — built inline"}</dd>
            </dl>
            {system.data.note ? <p className="muted">{system.data.note}</p> : null}
            {(system.data.lines ?? []).length ? (
              <ul className="lottery-lines">
                {system.data.lines.slice(0, 25).map((line, index) => <li key={index}>{generatedLineText({ mains: line.main ?? line.mains, stars: line.stars })}</li>)}
              </ul>
            ) : null}
            {system.data.saved ? <p className="muted">Saved as {system.data.saved.combinationId ? `combination #${system.data.saved.combinationId}` : JSON.stringify(system.data.saved)}</p> : null}
          </>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ strategy lab */

/** The lifecycle stepper, with legacy's "Paper trading (deploy)" label kept. */
function StrategySteps({ lifecycle }) {
  const steps = stageSteps(lifecycle);
  const retired = String(lifecycle ?? "").toUpperCase() === RETIRED_STAGE;
  return (
    <ol className="strategy-steps">
      {steps.map((step) => (
        <li key={step.stage} className={`strategy-step strategy-step-${step.state}`}>
          <span className="strategy-step-mark" aria-hidden="true">{step.state === "done" ? "✓" : step.state === "current" ? "•" : "·"}</span>
          <span>{step.label}</span>
          {step.state === "current" ? <span className="badge badge-sky">current</span> : null}
        </li>
      ))}
      {retired ? <li className="strategy-step strategy-step-retired"><span className="strategy-step-mark" aria-hidden="true">■</span><span>Retired</span></li> : null}
    </ol>
  );
}

/** Metrics as a definition list — every figure comes from the report. */
function MetricsList({ metrics }) {
  return (
    <dl className="strategy-metrics">
      {metricPairs(metrics).map((pair) => (
        <span className="strategy-metric" key={pair.label}>
          <dt>{pair.label}</dt>
          <dd>{pair.value}</dd>
        </span>
      ))}
    </dl>
  );
}

/**
 * Strategy Lab console (Phase 31, row 8) — the port of `views/strategy/index.php`
 * and of the three form posts behind it (`Strategy_lab::run_backtest`,
 * `::optimize`, `::advance`), which the SPA performs as API calls instead of a
 * redirect each.
 *
 * The screen inherits legacy's own guard: those routes are session-only, with no
 * permission (`Api_controller`, no `PUBLIC_ACTIONS` entry) — so this console
 * declares no permission either, and the only permissioned control it can render
 * is the human sign-off, which the API checks under `trading.control` anyway.
 *
 * Nothing here claims a result is live: every report carries its provenance, the
 * SIMULATION badge is on the row and the report, and a synthetic run is never
 * presented as market performance.
 */
export function StrategyLabView() {
  const [selected, setSelected] = useState("");
  const [backtest, setBacktest] = useState({ strategyId: "", strategyVersion: "", symbol: "BTCUSDT", timeframe: "1h", limit: BACKTEST_BARS.default, allowShorts: false });
  const [optimizer, setOptimizer] = useState({ strategyId: "", strategyVersion: "", symbol: "BTCUSDT", timeframe: "1h", limit: OPTIMIZE_BARS.default, register: false });
  const [advance, setAdvance] = useState({ reason: "" });
  const [signOff, setSignOff] = useState({ reason: "" });
  const [run, setRun] = useState(null);
  const [report, setReport] = useState(null);
  const [optimizeReport, setOptimizeReport] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = "Strategy Lab · WINDELS AI WORKFORCE"; }, []);

  const list = useResource(() => endpoints.strategies(), []);
  const strategies = list.data?.strategies ?? [];
  const detail = strategies.find((entry) => entry.strategyId === selected) ?? strategies[0] ?? null;
  const latest = detail?.latest ?? null;
  const strategyId = detail?.strategyId ?? "";
  const history = useResource(
    () => (strategyId ? endpoints.backtestHistory(`?strategyId=${encodeURIComponent(strategyId)}&limit=15`) : Promise.resolve({ results: [] })),
    [strategyId],
  );

  // The forms follow the selection, so a run is always recorded against the
  // strategy and version on screen rather than whatever was typed before.
  useEffect(() => {
    if (!detail) return;
    setBacktest((current) => ({ ...current, strategyId, strategyVersion: latest?.version ?? "" }));
    setOptimizer((current) => ({ ...current, strategyId, strategyVersion: latest?.version ?? "" }));
  }, [strategyId, latest?.version]);

  async function submit(action) {
    setRun(null);
    const problems = action === "backtest" ? validateBacktestForm(backtest) : action === "optimize" ? validateStrategyOptimizeForm(optimizer) : [];
    if (problems.length) {
      setRun({ status: "error", message: problems.map((problem) => problem.message).join(" ") });
      return;
    }
    setBusy(true);
    try {
      if (action === "backtest") {
        const result = await endpoints.runBacktest(buildStrategyBacktestBody(backtest));
        setReport(result);
        setOptimizeReport(null);
        setRun({ status: "done", message: backtestSummary(result) });
        history.retry();
      } else if (action === "optimize") {
        const result = await endpoints.strategyOptimize(strategyId, buildStrategyOptimizeBody(optimizer));
        setOptimizeReport(result);
        setReport(null);
        const bits = [optimizeHeadline(result), optimizeRecommendation(result)];
        if (result.registeredVariant) bits.push(`registered variant @${result.registeredVariant.version} (DRAFT, source ai — human sign-off required)`);
        for (const warning of result.overfitWarnings ?? []) bits.push(`⚠ ${warning}`);
        setRun({ status: "done", message: `Optimization complete — ${bits.filter(Boolean).join(" · ")}` });
        list.retry();
      } else if (action === "advance") {
        const target = latest?.nextStage;
        const result = await endpoints.strategyTransition(strategyId, buildTransitionBody({ to: target, version: latest?.version, reason: advance.reason }));
        setRun({ status: "done", message: `Strategy advanced to ${result.strategy?.lifecycle ?? target}` });
        setAdvance({ reason: "" });
        list.retry();
      } else if (action === "signOff") {
        const problems2 = validateSignOffForm(signOff);
        if (problems2.length) {
          setRun({ status: "error", message: problems2.map((problem) => problem.message).join(" ") });
          return;
        }
        await endpoints.strategySignOff(strategyId, buildSignOffBody({ version: latest?.version, reason: signOff.reason }));
        setRun({ status: "done", message: `Human risk sign-off recorded for ${strategyId}@${latest?.version}.` });
        setSignOff({ reason: "" });
        list.retry();
      }
    } catch (error) {
      const { reasons, warnings } = transitionFailure(error);
      const extra = reasons.length ? ` ${reasons.join(" · ")}` : "";
      const caution = warnings.length ? ` Warnings: ${warnings.join(" · ")}` : "";
      setRun({ status: "error", message: `${formFailure(error)}${extra}${caution}` });
    } finally {
      setBusy(false);
    }
  }

  const rows = historyRows(history.data?.results);

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">STRATEGY LAB <span className="overline-line" /></div><h1>Versioned strategies, evidence-gated.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="warn">
        Walk-forward optimization recommends new parameters <b>only</b> when they survive out-of-sample verification and
        beat the baseline there. A registered variant is source <code>ai</code> and starts at DRAFT — it needs a human
        sign-off before it can reach paper or live stages, and nothing on this screen deploys it.
      </Notice>

      <RunState state={run} onDismiss={() => setRun(null)} />

      <StateBox status={list.status} error={list.error} retry={list.retry} label="Loading strategies">
        {strategies.length === 0 ? (
          <p className="empty">No strategies are registered on this platform yet.</p>
        ) : (
          <div className="strategy-grid">
            <div className="strategy-main">
              {latest ? (
                <section className="panel">
                  <div className="audit-section-heading">
                    <div>
                      <h2>{latest.name}</h2>
                      <p className="muted"><code>{latest.strategy_id}</code> v{latest.version} · source <code>{latest.source}</code> · {latest.description}</p>
                    </div>
                    <span className={`badge ${lifecycleTone(latest.lifecycle)}`}>{latest.lifecycle}</span>
                  </div>
                  <StrategySteps lifecycle={latest.lifecycle} />
                  <p className="muted lottery-note">
                    params: {Object.entries(latest.params ?? {}).map(([key, value]) => `${key}=${value}`).join(", ") || "—"}
                    {" · "}class(es): {listToText(latest.market_classes)} · timeframes: {listToText(latest.timeframes)} · shorts {latest.supportsShorts ? "supported" : "not supported"}
                  </p>
                  {latest.human_signoff ? (
                    <p className="muted lottery-note">
                      Human sign-off recorded {formatDateTime(latest.human_signoff.at)}: {latest.human_signoff.reason}
                    </p>
                  ) : null}

                  {latest.nextStage ? (
                    <div className="strategy-advance">
                      <Field label="Reason (optional)" htmlFor="strategy-advance-reason">
                        <input id="strategy-advance-reason" type="text" value={advance.reason} maxLength={500}
                          onChange={(event) => setAdvance({ reason: event.target.value })} placeholder="advanced from Strategy Lab" />
                      </Field>
                      <button className="primary-button" type="button" disabled={busy} onClick={() => submit("advance")}>
                        Request advance → {latest.nextStage}
                      </button>
                      <span className="field-hint">A refusal is the lifecycle's own evidence gate: the reasons are shown verbatim, and stages may not be skipped.</span>
                    </div>
                  ) : <p className="muted lottery-note">This version is at the end of its lifecycle; retirement is the only remaining transition.</p>}

                  {needsSignOff(latest) ? (
                    <div className="strategy-signoff">
                      <h3 className="lottery-subheading">Human risk sign-off (trading.control)</h3>
                      <Field label="Review reason" htmlFor="strategy-signoff-reason" hint="Required for an AI-generated variant; kept with the strategy's record.">
                        <input id="strategy-signoff-reason" type="text" value={signOff.reason} maxLength={1000}
                          onChange={(event) => setSignOff({ reason: event.target.value })} />
                      </Field>
                      <button className="secondary-button" type="button" disabled={busy} onClick={() => submit("signOff")}>Record sign-off</button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {latest ? (
                <section className="panel">
                  <h2>Backtest runner</h2>
                  <form className="strategy-form" onSubmit={(event) => { event.preventDefault(); submit("backtest"); }}>
                    <Field label="Symbol" htmlFor="backtest-symbol">
                      <select id="backtest-symbol" value={backtest.symbol} onChange={(event) => setBacktest((current) => ({ ...current, symbol: event.target.value }))}>
                        {SYMBOLS.map((entry) => <option key={entry.value} value={entry.value}>{entry.value}</option>)}
                      </select>
                    </Field>
                    <Field label="Timeframe" htmlFor="backtest-timeframe">
                      <select id="backtest-timeframe" value={backtest.timeframe} onChange={(event) => setBacktest((current) => ({ ...current, timeframe: event.target.value }))}>
                        {STRATEGY_TIMEFRAMES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Bars" htmlFor="backtest-limit" hint={`${BACKTEST_BARS.min}–${BACKTEST_BARS.max}; the engine clamps`}>
                      <input id="backtest-limit" type="number" min={BACKTEST_BARS.min} max={BACKTEST_BARS.max} step="100" value={backtest.limit}
                        onChange={(event) => setBacktest((current) => ({ ...current, limit: event.target.value }))} />
                    </Field>
                    <label className="strategy-check">
                      <input type="checkbox" checked={backtest.allowShorts === true}
                        onChange={(event) => setBacktest((current) => ({ ...current, allowShorts: event.target.checked }))} />
                      allow shorts
                    </label>
                    <button className="primary-button" type="submit" disabled={busy}>▶ Run backtest</button>
                  </form>
                  <p className="field-hint">Fills at the NEXT bar open after a signal, half-spread + slippage + commission per side, stop-before-target when a bar touches both, hard look-ahead guard.</p>

                  {report ? (
                    <div className="strategy-report">
                      <h3 className="lottery-subheading">Result — {report.request?.strategyId}@{report.request?.strategyVersion} on {report.request?.symbol} {report.request?.timeframe}</h3>
                      <p className="muted">{provenanceNote(report.dataProvenance)}</p>
                      {report.dataProvenance?.synthetic ? <Notice tone="warn">These fills were simulated on SYNTHETIC candles. They measure the strategy's logic, not market performance.</Notice> : null}
                      <MetricsList metrics={report.metrics} />
                      {(report.warnings ?? []).length ? (
                        <ul className="strategy-warnings">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                      ) : null}
                      <p className="muted lottery-note">
                        {formatCount((report.trades ?? []).length)} trade(s) simulated · {(report.equityCurve ?? []).length} equity points · {report.request?.allowShorts ? "shorts allowed" : "shorts ignored"} · risk {(Number(report.request?.riskPct ?? 0) * 100).toFixed(2)}% per trade · fees {report.request?.feeBps}bps + spread {report.request?.spreadBps}bps + slippage {report.request?.slippageBps}bps
                      </p>
                      <details className="lottery-details">
                        <summary>Simulated trades</summary>
                        <div className="scroll">
                          <table className="data-table">
                            <thead><tr><th>Direction</th><th>Entry</th><th>Exit</th><th>Entry price</th><th>Exit price</th><th>P&L</th><th>R</th><th>Reason</th></tr></thead>
                            <tbody>
                              {(report.trades ?? []).map((trade, index) => (
                                <tr key={index}>
                                  <td>{trade.direction}</td>
                                  <td className="muted">{formatDateTime(trade.entryTime)}</td>
                                  <td className="muted">{formatDateTime(trade.exitTime)}</td>
                                  <td>{plainNumber(trade.entryPrice, 4)}</td>
                                  <td>{plainNumber(trade.exitPrice, 4)}</td>
                                  <td className={Number(trade.pnl) >= 0 ? "strategy-up" : "strategy-down"}>{plainNumber(trade.pnl, 2)}</td>
                                  <td>{plainNumber(trade.rMultiple, 2)}</td>
                                  <td className="muted">{trade.exitReason ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {latest ? (
                <section className="panel">
                  <h2>Optimizer — walk-forward parameter search</h2>
                  <form className="strategy-form" onSubmit={(event) => { event.preventDefault(); submit("optimize"); }}>
                    <Field label="Symbol" htmlFor="optimize-symbol">
                      <select id="optimize-symbol" value={optimizer.symbol} onChange={(event) => setOptimizer((current) => ({ ...current, symbol: event.target.value }))}>
                        {SYMBOLS.map((entry) => <option key={entry.value} value={entry.value}>{entry.value}</option>)}
                      </select>
                    </Field>
                    <Field label="Timeframe" htmlFor="optimize-timeframe">
                      <select id="optimize-timeframe" value={optimizer.timeframe} onChange={(event) => setOptimizer((current) => ({ ...current, timeframe: event.target.value }))}>
                        {STRATEGY_TIMEFRAMES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Bars" htmlFor="optimize-limit" hint={`${OPTIMIZE_BARS.min}–${OPTIMIZE_BARS.max}; the engine clamps`}>
                      <input id="optimize-limit" type="number" min={OPTIMIZE_BARS.min} max={OPTIMIZE_BARS.max} step="20" value={optimizer.limit}
                        onChange={(event) => setOptimizer((current) => ({ ...current, limit: event.target.value }))} />
                    </Field>
                    <label className="strategy-check">
                      <input type="checkbox" checked={optimizer.register === true}
                        onChange={(event) => setOptimizer((current) => ({ ...current, register: event.target.checked }))} />
                      register variant
                    </label>
                    <button className="secondary-button" type="submit" disabled={busy}>⚙ Optimize</button>
                  </form>
                  <p className="field-hint">
                    Grid search on the first 70% (in-sample), verification on the last 30% (out-of-sample). A candidate is
                    recommended ONLY if it survives out-of-sample and beats the baseline there; in-sample-only performance
                    is never adopted. Registered variants are source <b>ai</b> — DRAFT lifecycle, human sign-off required.
                  </p>

                  {optimizeReport ? (
                    <div className="strategy-report">
                      <h3 className="lottery-subheading">Optimization — {optimizeReport.request?.strategyId} on {optimizeReport.request?.symbol} {optimizeReport.request?.timeframe}</h3>
                      <p className="muted">{optimizeHeadline(optimizeReport)} · {provenanceNote(optimizeReport.dataProvenance)}</p>
                      <p className={optimizeReport.recommendation?.adopt ? "strategy-up" : "muted"}>{optimizeRecommendation(optimizeReport)}</p>
                      {optimizeReport.registeredVariant ? (
                        <p className="muted">Registered variant v{optimizeReport.registeredVariant.version} — source <code>ai</code>, lifecycle DRAFT. {optimizeReport.registeredVariant.note}</p>
                      ) : null}
                      {(optimizeReport.overfitWarnings ?? []).length ? (
                        <ul className="strategy-warnings">{optimizeReport.overfitWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                      ) : null}
                      {finalistRows(optimizeReport).length ? (
                        <div className="scroll">
                          <table className="data-table">
                            <thead><tr><th>Params</th><th>In-sample return</th><th>Out-of-sample return</th><th>OOS trades</th></tr></thead>
                            <tbody>
                              {finalistRows(optimizeReport).map((row, index) => (
                                <tr key={index}>
                                  <td><code>{Object.entries(row.params).map(([key, value]) => `${key}=${value}`).join(", ")}</code></td>
                                  <td>{pctText(row.inSample)}</td>
                                  <td>{pctText(row.outOfSample)}</td>
                                  <td>{plainNumber(row.trades, 0)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                      <details className="lottery-details">
                        <summary>Baseline and search space</summary>
                        <dl className="lottery-meta">
                          <dt>Baseline params</dt><dd><code>{Object.entries(optimizeReport.baseline?.params ?? {}).map(([key, value]) => `${key}=${value}`).join(", ")}</code></dd>
                          <dt>Baseline in-sample</dt><dd>{pctText(optimizeReport.baseline?.inSample?.totalReturnPct)}</dd>
                          <dt>Baseline out-of-sample</dt><dd>{pctText(optimizeReport.baseline?.outOfSample?.totalReturnPct)}</dd>
                          <dt>Grid</dt><dd><code>{JSON.stringify(optimizeReport.searchSpace?.grid ?? {})}</code></dd>
                        </dl>
                        <p className="muted">{optimizeReport.methodNote}</p>
                      </details>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="panel">
                <h2>Backtest history {latest ? `— ${latest.strategy_id}` : ""}</h2>
                <StateBox status={history.status} error={history.error} retry={history.retry} label="Loading backtests">
                  {rows.length ? (
                    <div className="scroll">
                      <table className="data-table">
                        <thead><tr><th>Date</th><th>Sym</th><th>TF</th><th>Trades</th><th>Return</th><th>Win%</th><th>PF</th><th>Sharpe</th><th>MaxDD</th><th>Data</th></tr></thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.id}>
                              <td className="muted">{formatDateTime(row.created)}</td>
                              <td>{row.symbol}</td>
                              <td className="muted">{row.timeframe}</td>
                              <td>{plainNumber(row.metrics.trades, 0)}</td>
                              <td className={Number(row.metrics.totalReturnPct) >= 0 ? "strategy-up" : "strategy-down"}>{pctText(row.metrics.totalReturnPct)}</td>
                              <td>{ratioPctText(row.metrics.winRate)}</td>
                              <td>{plainNumber(row.metrics.profitFactor, 2)}</td>
                              <td>{plainNumber(row.metrics.sharpe, 2)}</td>
                              <td className="strategy-down">{pctText(row.metrics.maxDrawdownPct, 1)}</td>
                              <td>{row.synthetic ? <span className="badge badge-warn">SIM</span> : <span className="badge badge-live">LIVE</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="empty">No backtests recorded for this strategy yet. A run records itself as lifecycle evidence.</p>}
                </StateBox>
              </section>
            </div>

            <aside className="strategy-list">
              <h2>Strategies</h2>
              {strategies.map((entry) => {
                const record = entry.latest ?? {};
                const isSelected = entry.strategyId === strategyId;
                return (
                  <button key={entry.strategyId} type="button" className={`strategy-card${isSelected ? " strategy-card-selected" : ""}`}
                    onClick={() => setSelected(entry.strategyId)} aria-pressed={isSelected}>
                    <span className="strategy-card-head">
                      <code>{entry.strategyId}</code>
                      <span className="muted">v{record.version}</span>
                      <span className={`badge ${lifecycleTone(record.lifecycle)}`}>{record.lifecycle}</span>
                    </span>
                    <span className="muted strategy-card-name">{record.name}</span>
                    <span className="muted strategy-card-params">
                      {Object.entries(record.params ?? {}).map(([key, value]) => `${key}=${value}`).join(", ")}
                    </span>
                    {entry.versions?.length > 1 ? <span className="muted">{entry.versions.length} versions</span> : null}
                  </button>
                );
              })}
              <p className="field-hint">
                A version is a separate record: a registered variant does not replace the version it came from, and
                backtests stay attached to the version that produced them.
              </p>
            </aside>
          </div>
        )}
      </StateBox>
    </div>
  );
}

/* ------------------------------------------------------------- not found */

/* ------------------------------------------------------------ AI workforce */

/** One of the three ratio meters (`Confidence`, `Confluence`, `Agreement`). */
function WorkforceMeter({ meter }) {
  return (
    <div className="workforce-meter">
      <div className="workforce-meter-row"><span>{meter.label}</span><span className="mono">{meter.text}</span></div>
      <div className="workforce-meter-bar"><div className={`workforce-meter-fill meter-${meter.tone}`} style={{ width: `${Math.max(0, Math.min(100, meter.pct))}%` }} /></div>
    </div>
  );
}

/**
 * The candlestick chart: `views/welcome/partials/chart.php` rendered as SVG from
 * `candleGeometry`'s numbers. Same canvas (1000×380), same 140-bar window, same
 * EMA overlays and support/resistance dashes, same entry/SL/TP overlay — the only
 * difference is that the geometry is computed in JS instead of PHP, which is what
 * the contract test pins.
 */
function WorkforceChart({ geometry, provenance }) {
  if (!geometry) return null;
  const { width, height, padL, padR, bars, gridlines, ema20, ema50, setup } = geometry;
  const facts = provenanceFacts(provenance);
  return (
    <section className="panel">
      <h2>Candles · EMA · structure{setup ? " · setup" : ""}</h2>
      <div className="workforce-chart-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} className="workforce-chart" role="img" aria-label="candlestick chart with EMA overlays and structure levels">
          {gridlines.map((line) => (
            <g key={line.price}>
              <line x1={padL} x2={width - padR} y1={line.y} y2={line.y} className="workforce-grid" />
              <text x={width - padR + 6} y={line.y + 3} className="workforce-axis-label">{line.label}</text>
            </g>
          ))}
          {geometry.resistance.map((level) => (
            <line key={`r${level.price}`} x1={padL} x2={width - padR} y1={level.y} y2={level.y} className="workforce-level-resistance">
              <title>Resistance {level.label}</title>
            </line>
          ))}
          {geometry.support.map((level) => (
            <line key={`s${level.price}`} x1={padL} x2={width - padR} y1={level.y} y2={level.y} className="workforce-level-support">
              <title>Support {level.label}</title>
            </line>
          ))}
          {setup ? (
            <>
              <rect x={padL} y={setup.zoneY} width={setup.zoneWidth} height={setup.zoneHeight} fill={setup.tone} opacity="0.12" />
              <line x1={padL} x2={width - padR} y1={setup.stopY} y2={setup.stopY} className="workforce-stop" />
              <text x={padL + 4} y={setup.stopY - 3} className="workforce-stop-label">SL {setup.stopLabel}</text>
              {setup.targets.map((target) => (
                <g key={target.label}>
                  <line x1={padL} x2={width - padR} y1={target.y} y2={target.y} className="workforce-target" opacity={target.opacity} />
                  <text x={padL + 4} y={target.y - 3} className="workforce-target-label">{target.label}</text>
                </g>
              ))}
            </>
          ) : null}
          {bars.map((bar) => (
            <rect key={`v${bar.index}`} x={bar.volume.x} y={bar.volume.y} width={bar.volume.width} height={bar.volume.height}
              fill={bar.volume.up ? "#134e4a" : "#4c1d24"}>
              <title>vol {bar.volume.label}</title>
            </rect>
          ))}
          {bars.map((bar) => (
            <g key={`c${bar.index}`} className={bar.up ? "workforce-candle-up" : "workforce-candle-down"}>
              <title>{new Date(bar.timestamp).toISOString().slice(0, 16).replace("T", " ")}Z · O {bar.open} H {bar.high} L {bar.low} C {bar.close}</title>
              <line x1={bar.wick.x1} x2={bar.wick.x2} y1={bar.wick.y1} y2={bar.wick.y2} />
              <rect x={bar.body.x} y={bar.body.y} width={bar.body.width} height={bar.body.height} />
            </g>
          ))}
          <polyline points={ema20.points} fill="none" className="workforce-ema-20"><title>EMA20</title></polyline>
          <polyline points={ema50.points} fill="none" className="workforce-ema-50"><title>EMA50</title></polyline>
        </svg>
      </div>
      <p className="field-hint">
        EMA20 (amber) · EMA50 (violet) · support/resistance dashed{setup ? " · entry zone, stop and target ladder" : ""} ·{" "}
        {geometry.visibleCount} of {geometry.totalCount} bars
        {facts ? ` · source: ${provenance?.source ?? "—"}${facts.synthetic ? " (SYNTHETIC)" : ""}` : ""}
      </p>
    </section>
  );
}

/**
 * AI Workforce console (Phase 32, row 3) — the port of `/analysis`
 * (`Welcome::index` + `views/welcome/index.php` + `partials/chart.php`) and of the
 * two governance posts behind it (`Welcome::mode`, `Welcome::kill_switch`), which
 * this screen performs as API calls instead of a redirect each.
 *
 * The screen is **session-only**, like the legacy controller: the analysis routes
 * are guarded by `authenticate` alone and the marketplace routes likewise, so the
 * exact-path route declares no permission. The two governance controls inside are
 * `trading.control` on the server, so they render as disabled with the reason when
 * the role does not carry it — never as a button that would 403.
 *
 * Nothing here places an order: the run endpoint returns a proposal and a risk
 * verdict, the screen says so, and the trading-mode select offers only the two
 * modes this edition can be put into.
 */
export function AnalysisWorkforceView({ permissions }) {
  const [form, setForm] = useState({ symbol: "BTCUSDT", timeframe: "1h" });
  const [watchForm, setWatchForm] = useState({ symbols: WATCHLIST.join(", "), timeframe: "1h" });
  const [mode, setMode] = useState("");
  const [killReason, setKillReason] = useState("");
  const [state, setState] = useState(null);
  const [result, setResult] = useState(null);
  const [watch, setWatch] = useState(null);
  const [candles, setCandles] = useState(null);
  const [busy, setBusy] = useState(false);
  const canControl = permissions.includes("trading.control");
  const canAudit = permissions.includes("identity.users.view");

  useEffect(() => { document.title = "AI Workforce · WINDELS AI WORKFORCE"; }, []);

  const governance = useResource(() => endpoints.tradingMode(), []);
  const history = useResource(() => endpoints.analysisHistory("?limit=8"), []);
  const panel = useResource(() => endpoints.analysisAgents(), []);
  // Legacy showed the last twelve audit events to any signed-in member. The port
  // deliberately tightened that to `identity.users.view` (AV-1), so the panel loads
  // only when the role carries it and says why when it does not.
  const audit = useResource(() => (canAudit ? endpoints.adminAudit("?limit=12") : Promise.resolve(null)), [canAudit]);

  const tradingState = governance.data ?? null;
  const killSwitchActive = tradingState?.killSwitch?.active === true;
  const currentMode = tradingState?.tradingMode ?? "";
  const runAuditEvents = audit.data?.events ?? [];
  const levels = structureLevels(result?.agents);
  const geometry = result && candles?.candles ? candleGeometry({ candles: candles.candles, support: levels.support, resistance: levels.resistance, setup: result.tradeSetup }) : null;
  const setup = tradeSetupView(result?.tradeSetup);
  const decision = riskDecisionView(result?.riskDecision);
  const debate = debateView(result?.debate);
  const facts = result ? provenanceFacts(result.provenance) : null;
  const context = result ? riskContextFacts(result.riskContext) : null;
  const consensus = result ? consensusSummary(result) : null;

  async function runAnalysis(target) {
    const nextForm = target ?? form;
    const problems = validateRunForm(nextForm);
    if (problems.length) {
      setState({ status: "error", message: problems.map((problem) => problem.message).join(" ") });
      return;
    }
    setForm(nextForm);
    setState(null);
    setBusy(true);
    try {
      const body = buildRunBody(nextForm);
      const payload = await endpoints.analysisRun(body);
      setResult(payload);
      setWatch(null);
      setState({ status: "done", message: `Analysis complete — ${runHeadline(payload)}` });
      history.retry();
      const query = `?symbol=${encodeURIComponent(body.symbol)}&marketClass=${encodeURIComponent(body.marketClass)}&timeframe=${encodeURIComponent(body.timeframe)}&limit=200`;
      try {
        setCandles(await endpoints.candles(query));
      } catch {
        // The chart is decorative relative to the analysis: a candle fetch that
        // fails must not take the run off the screen, and the panel says so by
        // simply not appearing.
        setCandles(null);
      }
    } catch (error) {
      setState({ status: "error", message: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  async function scanWatchlist() {
    const problems = validateWatchlistForm(watchForm);
    if (problems.length) {
      setState({ status: "error", message: problems.map((problem) => problem.message).join(" ") });
      return;
    }
    setState(null);
    setBusy(true);
    try {
      const body = buildConsensusBody(watchForm);
      const payload = await endpoints.analysisConsensus(body);
      setWatch(payload);
      setState({ status: "done", message: `Scan complete — ${watchlistRows(payload).length} symbol(s) scored at ${body.timeframe}.` });
      history.retry();
    } catch (error) {
      setState({ status: "error", message: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  async function applyMode() {
    const target = mode || currentMode;
    setState(null);
    setBusy(true);
    try {
      const payload = await endpoints.setTradingMode(buildModeBody(target));
      setState({ status: "done", message: payload.message ?? `Trading mode set to ${target}` });
      setMode("");
      governance.retry();
    } catch (error) {
      setState({ status: "error", message: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKillSwitch() {
    setState(null);
    setBusy(true);
    try {
      const payload = await endpoints.setKillSwitch(buildKillSwitchBody(!killSwitchActive, killReason));
      setState({ status: "done", message: `Kill switch ${payload.killSwitch?.active ? "engaged" : "released"}${payload.killSwitch?.reason ? ` — ${payload.killSwitch.reason}` : ""}.` });
      setKillReason("");
      governance.retry();
    } catch (error) {
      setState({ status: "error", message: formFailure(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">AI WORKFORCE <span className="overline-line" /></div><h1>Multi-agent market analysis.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>

      <Notice tone="info">
        Agents agree on a bias, the risk engine can veto a setup, and <b>this screen never places an order</b>. Proposals are
        analysis output; executing one means the Paper Trading console, where the order re-passes the full governance chain.
      </Notice>

      <RunState state={state} onDismiss={() => setState(null)} />

      <section className="panel">
        <div className="workforce-start">
          <div>
            <h2>Start an analysis</h2>
            <p className="muted">Choose a market and timeframe. Five agents produce a consensus, a regime read, a setup and a risk decision.</p>
            <form className="workforce-form" onSubmit={(event) => { event.preventDefault(); runAnalysis(); }}>
              <Field label="Symbol" htmlFor="workforce-symbol">
                <select id="workforce-symbol" value={form.symbol} onChange={(event) => setForm((current) => ({ ...current, symbol: event.target.value }))}>
                  {SYMBOL_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <Field label="Timeframe" htmlFor="workforce-timeframe">
                <select id="workforce-timeframe" value={form.timeframe} onChange={(event) => setForm((current) => ({ ...current, timeframe: event.target.value }))}>
                  {RUN_TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
                </select>
              </Field>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Working…" : "Run analysis"}</button>
            </form>
            <p className="field-hint">
              The endpoint accepts six timeframes; this form keeps the legacy page's four. The market class is derived the way
              legacy derived it (<code>XAUUSD</code> → commodity, a <code>USDT</code> pair → crypto, everything else forex).
            </p>
          </div>
          <aside className="workforce-governance">
            <StateBox status={governance.status} error={governance.error} retry={governance.retry} label="Loading trading state">
              <div className="workforce-governance-body">
                {killSwitchActive
                  ? <span className="badge badge-amber">Kill switch active</span>
                  : <span className="badge badge-sky">Mode {currentMode}</span>}
                <p className="muted">
                  {tradingState?.simulationOnly ? "Simulation only" : "Live trading"} · {killSwitchActive
                    ? tradingState?.killSwitch?.reason ?? "orders blocked until explicitly released"
                    : "kill switch released"}
                </p>
                <Field label="Trading mode" htmlFor="workforce-mode" hint={canControl ? "The two modes this edition supports." : "Needs trading.control."}>
                  <select id="workforce-mode" value={mode || currentMode} disabled={!canControl || busy}
                    onChange={(event) => setMode(event.target.value)}>
                    {TRADING_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                <button className="secondary-button" type="button" disabled={!canControl || busy} onClick={applyMode}>Set mode</button>
                <ul className="workforce-refused-modes">
                  {REFUSED_MODES.map((entry) => (
                    <li key={entry.mode}><code>{entry.mode}</code> — unavailable: {entry.reason}</li>
                  ))}
                </ul>
                <Field label="Kill-switch reason (optional)" htmlFor="workforce-kill-reason" hint="Recorded in the audit trail with the change.">
                  <input id="workforce-kill-reason" type="text" maxLength={500} value={killReason} disabled={!canControl}
                    onChange={(event) => setKillReason(event.target.value)} placeholder="engaged from the AI Workforce screen" />
                </Field>
                <button className={killSwitchActive ? "secondary-button" : "danger-button"} type="button" disabled={!canControl || busy} onClick={toggleKillSwitch}>
                  {killSwitchActive ? "Release kill switch" : "Activate kill switch"}
                </button>
                {canControl ? null : <p className="field-hint">Your role does not carry <code>trading.control</code>; the API refuses these two writes with 403, so they are disabled here rather than failing on click.</p>}
              </div>
            </StateBox>
          </aside>
        </div>
      </section>

      <section className="panel">
        <h2>Watchlist consensus</h2>
        <form className="workforce-watchlist-form" onSubmit={(event) => { event.preventDefault(); scanWatchlist(); }}>
          <Field label="Symbols" htmlFor="workforce-watch-symbols" hint={`1–${MAX_WATCHLIST} distinct symbols, comma or space separated.`}>
            <input id="workforce-watch-symbols" type="text" value={watchForm.symbols} maxLength={260}
              onChange={(event) => setWatchForm((current) => ({ ...current, symbols: event.target.value }))} />
          </Field>
          <Field label="Timeframe" htmlFor="workforce-watch-timeframe">
            <select id="workforce-watch-timeframe" value={watchForm.timeframe} onChange={(event) => setWatchForm((current) => ({ ...current, timeframe: event.target.value }))}>
              {RUN_TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
            </select>
          </Field>
          <button className="secondary-button" type="submit" disabled={busy}>Scan watchlist</button>
        </form>
        <p className="field-hint">
          A scan is up to {MAX_WATCHLIST} full runs, so it holds its own rate limit and concurrency slot. Sending no symbols makes the server
          use its own default watchlist; this form only sends the list when one is typed.
        </p>
        {watch ? (
          watchlistRows(watch).length === 0 ? <p className="empty">The scan returned no rows.</p> : (
            <div className="workforce-watchlist">
              {watchlistRows(watch).map((row) => (
                <button key={row.symbol} type="button" className="workforce-watch-row" disabled={busy}
                  onClick={() => runAnalysis({ symbol: row.symbol, timeframe: watchForm.timeframe })}>
                  <span className="workforce-watch-head">
                    <b className="mono">{row.symbol}</b>
                    <span className={`badge ${row.tone}`}>{row.short}</span>
                    {row.synthetic ? <span className="badge badge-amber">SIM</span> : null}
                  </span>
                  <span className="workforce-watch-meta">conf {row.confidence} · {row.regime}</span>
                </button>
              ))}
            </div>
          )
        ) : <p className="muted">No scan has run in this session. The row list above is the legacy page's own default watchlist.</p>}
      </section>

      {result ? (
        <>
          {facts ? (
            <Notice tone={facts.tone === "error" ? "error" : facts.tone === "warn" ? "warn" : "info"}>
              <b>{facts.label}</b>{facts.note ? ` — ${facts.note}` : ""}
              <div className="workforce-provenance">{facts.facts.map((fact) => <span key={fact}>{fact}</span>)}</div>
            </Notice>
          ) : null}

          <div className="workforce-grid">
            <div className="workforce-main">
              <section className="panel">
                <div className="audit-section-heading">
                  <div>
                    <h2>Trading Intelligence Consensus</h2>
                    <p className="muted">
                      Recommendation <b>{result.recommendation}</b> · regime <code>{result.marketRegime}</code>
                      {" · ADX "}{numberText(result.regimeAssessment?.adx, 1)}
                      {result.quote ? ` · last ${priceText(result.quote.last)}` : ""}
                    </p>
                  </div>
                  <span className={`badge ${biasTone(result.bias)}`}>{result.bias}</span>
                </div>
                {meterRows(result).map((meter) => <WorkforceMeter key={meter.label} meter={meter} />)}
                <p className="muted lottery-note">
                  net score {consensus.netScore} · voting: {consensus.voting} · abstaining: {consensus.abstaining}
                </p>
                {debate ? (
                  <div className={`notice notice-${debate.tone === "badge-red" ? "error" : debate.tone === "badge-amber" ? "warn" : "info"}`}>
                    <b>Agent debate verdict: {debate.bias}</b>{debate.adjustment < 0 ? ` (confidence ${debate.adjustment})` : ""}
                    {debate.reasoning.length ? ` — ${debate.reasoning.join("; ")}` : ""}
                    <details>
                      <summary className="text-button">debate transcript</summary>
                      {debate.rounds.map((round) => (
                        <div key={round.role} className="workforce-debate-round">
                          <b>{round.role}</b>
                          {round.items.map((item, index) => (
                            <div key={`${round.role}-${index}`} className="muted">
                              • {item.text}
                              {item.evidence ? <span className="mono"> [{item.evidence}]</span> : null}
                              {item.severity ? <span className="badge badge-gray"> {item.severity}</span> : null}
                            </div>
                          ))}
                        </div>
                      ))}
                    </details>
                  </div>
                ) : null}
                {Array.isArray(result.conflicts) && result.conflicts.length ? (
                  <div className="notice notice-warn">
                    <b>Signal conflicts:</b>
                    {result.conflicts.map((conflict) => (
                      <div key={`${conflict.agent}-${conflict.theirBias}`}>• {conflict.agent} leans {conflict.theirBias} — {conflict.reason}</div>
                    ))}
                  </div>
                ) : null}
                <details className="workforce-raw">
                  <summary className="text-button">regime evidence &amp; reasoning</summary>
                  <ul>
                    {(result.regimeAssessment?.evidence ?? []).map((evidence) => <li key={evidence}>▸ {evidence}</li>)}
                    {(result.reasoning ?? []).slice(0, 6).map((line) => <li key={line}>· {line}</li>)}
                  </ul>
                </details>
                {result.gates?.hardBlocks?.length ? (
                  <Notice tone="error">Hard blocks: {result.gates.hardBlocks.join(" · ")}</Notice>
                ) : null}
              </section>

              <WorkforceChart geometry={geometry} provenance={result.provenance} />

              <section className="panel">
                <h2>Technical signals</h2>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Indicator</th><th className="num">Value</th><th className="num">Signal</th></tr></thead>
                    <tbody>
                      {signalRows(result.signals).map((signal) => (
                        <tr key={signal.name}>
                          <td>{signal.name} <span className="muted">{signal.detail}</span></td>
                          <td className="num mono">{signal.value}</td>
                          <td className="num"><span className={`badge ${signal.tone}`}>{signal.signal}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {agentPanels(result.agents).map((agent) => (
                <section className="panel" key={agent.id}>
                  <h2>{agent.title}</h2>
                  <div className="workforce-agent-head">
                    <span className={`badge ${agent.voteTone}`}>{agent.voteLabel}</span>
                    <span className="muted">data quality {agent.quality} · score {agent.score}</span>
                    <span className="muted">{agent.reason}</span>
                  </div>
                  {agent.currencyStrength.length ? (
                    <div className="workforce-strength">
                      {agent.currencyStrength.map((entry) => (
                        <span key={entry.currency} className={`badge ${entry.tone}`}>{entry.currency} {entry.text}</span>
                      ))}
                    </div>
                  ) : null}
                  {agent.warnings.length ? (
                    <ul className="workforce-limits">
                      {agent.warnings.slice(0, 4).map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  ) : null}
                </section>
              ))}
            </div>

            <div className="workforce-side">
              <section className="panel">
                <h2>Trade proposal + Risk Engine</h2>
                {setup ? (
                  <>
                    <div className="workforce-proposal-head">
                      <span className={`badge ${setup.tone}`}>{setup.action}</span>
                      <div className="muted"><b className="mono">{setup.symbol}</b> · {setup.timeframe}<br />R:R <b>{setup.riskReward}</b> · conf <b>{setup.confidence}</b></div>
                    </div>
                    <dl className="workforce-proposal">
                      {setup.rows.map((row) => (
                        <span key={row.label}><dt>{row.label}</dt><dd className={`mono ${row.tone}`}>{row.value}</dd></span>
                      ))}
                    </dl>
                    {decision ? (
                      <div className="workforce-decision">
                        <span className={`badge ${decision.tone}`}>{decision.label}</span>
                        {decision.reasons.map((reason) => <div key={reason} className="down">✕ {reason}</div>)}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="muted">No tradeable setup — consensus lacked sufficient evidence. <b>NO_TRADE is a deliberate outcome.</b></p>
                )}
                <p className="field-hint">
                  Proposals are analysis output. Execute manually, or switch to PAPER_TRADING and submit through the Paper Trading
                  console — where every order re-passes the full governance chain.
                </p>
                {context ? (
                  <dl className="workforce-context">
                    <span><dt>Decision state</dt><dd>{context.mode}{context.killSwitch ? " · kill switch active" : ""}</dd></span>
                    <span><dt>Equity</dt><dd className="mono">{context.equity}</dd></span>
                    <span><dt>Open positions</dt><dd className="mono">{context.openPositions}</dd></span>
                    <span><dt>Risk limits source</dt><dd>{context.source}</dd></span>
                  </dl>
                ) : null}
                {context?.note ? <p className="field-hint">{context.note}</p> : null}
              </section>

              <section className="panel">
                <h2>Recent analysis runs</h2>
                <StateBox status={history.status} error={history.error} retry={history.retry} label="Loading history">
                  {analysisHistoryRows(history.data).length === 0 ? <p className="empty">No analysis runs stored yet.</p> : (
                    <table className="data-table">
                      <thead><tr><th>Symbol</th><th>TF</th><th>Bias</th><th className="num">Conf</th><th className="num">At</th></tr></thead>
                      <tbody>
                        {analysisHistoryRows(history.data).map((row) => (
                          <tr key={row.id}>
                            <td className="mono"><b>{row.symbol}</b></td>
                            <td className="muted">{row.timeframe}</td>
                            <td><span className={`badge ${row.tone}`}>{row.bias.slice(0, 4)}</span>{row.synthetic ? <span className="badge badge-amber">SIM</span> : null}</td>
                            <td className="num mono">{row.confidence}</td>
                            <td className="num mono muted">{row.time}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </StateBox>
              </section>

              <section className="panel">
                <h2>Agent panel</h2>
                <StateBox status={panel.status} error={panel.error} retry={panel.retry} label="Loading agents">
                  <ul className="workforce-agents">
                    {(panel.data?.agents ?? []).map((agent) => (
                      <li key={agent.id}><b>{agent.title}</b><span className="muted"> <code>{agent.id}</code> — {agent.description}</span></li>
                    ))}
                  </ul>
                </StateBox>
              </section>

              <section className="panel">
                <h2>Audit trail</h2>
                {canAudit ? (
                  <StateBox status={audit.status} error={audit.error} retry={audit.retry} label="Loading audit events">
                    {runAuditEvents.length === 0 ? <p className="empty">No audit events are recorded yet.</p> : (
                      <ul className="workforce-audit">
                        {runAuditEvents.slice(0, 12).map((event) => (
                          <li key={event.id ?? `${event.action}-${event.createdAt}`}>
                            <span className="mono muted">{String(event.createdAt ?? "").slice(11, 19)}</span>
                            <code>{event.action}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </StateBox>
                ) : (
                  <p className="muted">
                    Legacy showed the last twelve audit events to any signed-in member. The port requires{" "}
                    <code>identity.users.view</code> for the whole trail (AV-1, a deliberate tightening), so this panel stays empty
                    rather than showing a subset the API does not serve.
                  </p>
                )}
              </section>
            </div>
          </div>
        </>
      ) : (
        <section className="panel">
          <p className="empty">Choose a symbol above and start using AI. Consensus, regime, signals and a risk-reviewed proposal will appear here.</p>
        </section>
      )}
    </div>
  );
}

export function NotFoundView({ path }) {
  return (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">WORKSPACE <span className="overline-line" /></div><h1>Nothing is served here.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      <Notice tone="warn"><code>{path}</code> is not a declared workspace surface. The server routes every path it does not know to this shell, so an undeclared URL renders this page instead of failing silently.</Notice>
    </div>
  );
}
