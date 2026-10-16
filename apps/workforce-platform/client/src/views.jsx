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
    { to: "/app/account", label: "Account", permission: null },
    { to: "/app/notifications", label: "Notifications", permission: null, unread: true },
    { to: "/app/status", label: "Platform status", permission: null },
    { to: "/app/portfolio/optimizer", label: "Portfolio optimizer", permission: "trading.view" },
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
 * they cannot. The shared shell now has an in-product notification inbox, but
 * domain consoles (analysis, strategy, portfolio, sports and lottery) remain open
 * work under F-29; the inbox does not imply those APIs have usable screens.
 */
export function ModuleCards() {
  const moduleCards = [
    { number: "01", title: "Market intelligence", text: "Multi-agent analysis, consensus, regime detection and a risk-reviewed proposal.", status: "API ported · no console", tone: "api", foot: "PHASE 5 · /api/v1/analysis" },
    { number: "02", title: "Strategy Lab", text: "Backtesting, walk-forward optimization, evidence-gated lifecycle and confidence calibration.", status: "API ported · no console", tone: "api", foot: "PHASE 6 · /api/v1/strategies" },
    { number: "03", title: "Sports research", text: "Ingestion, decision chain, ticket engine, settlement and measured performance.", status: "Measured half ported · no console", tone: "api", foot: "PHASES 15–20 · /api/v1/sports" },
    { number: "04", title: "Lottery tools", text: "Draw statistics, combinations, saved tickets and the no-look-ahead Strategy Lab.", status: "Slices 1–5 ported · no console", tone: "api", foot: "PHASES 21–25 · /api/v1/lottery" },
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

/* ------------------------------------------------------------- not found */

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
