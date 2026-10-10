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

export function WorkspaceNav({ permissions, current }) {
  const entries = [
    { to: "/app/", label: "Overview", permission: null },
    { to: "/app/account", label: "Account", permission: null },
    { to: "/app/status", label: "Platform status", permission: null },
    { to: "/app/admin/users", label: "Users", permission: "identity.users.view" },
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
          >
            {entry.label}
            {allowed ? null : <span className="nav-lock" title={`Requires ${entry.permission}`}>🔒</span>}
          </Link>
        );
      })}
    </nav>
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
 * they cannot. No module console exists yet for ANY ported module, which is
 * recorded as finding F-29 in docs/migration/PHASE6_STRATEGIES.md rather than
 * papered over by a vaguer label.
 */
export function ModuleCards() {
  const moduleCards = [
    { number: "01", title: "Market intelligence", text: "Multi-agent analysis, consensus, regime detection and a risk-reviewed proposal.", status: "API ported · no console", tone: "api", foot: "PHASE 5 · /api/v1/analysis" },
    { number: "02", title: "Strategy Lab", text: "Backtesting, walk-forward optimization, evidence-gated lifecycle and confidence calibration.", status: "API ported · no console", tone: "api", foot: "PHASE 6 · /api/v1/strategies" },
    { number: "03", title: "Sports research", text: "Evidence, data quality and publication review.", status: "Not yet ported to Node", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "04", title: "Lottery tools", text: "Historical statistics and ticket utilities.", status: "Not yet ported to Node", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "05", title: "Language learning", text: "Lessons, practice and learner progress.", status: "Not yet ported to Node", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "06", title: "Lead discovery", text: "Organization-aware discovery and pipeline tools.", status: "Not yet ported to Node", tone: "planned", foot: "MIGRATION BACKLOG" },
    { number: "07", title: "Account & access", text: "Identity, permissions and audited activity.", status: "Foundation slice", tone: "live", foot: "ACTIVE FOUNDATION" },
  ];
  const labelClass = { live: "live-label", api: "api-label", planned: "planned-label" };
  return (
    <div className="workspace-grid">
      {moduleCards.map((module) => (
        <article className="workspace-card" key={module.number}>
          <div className="workspace-card-top"><span>{module.number}</span><span className={labelClass[module.tone]}>{module.status}</span></div>
          <h3>{module.title}</h3>
          <p>{module.text}</p>
          <div className="workspace-card-bottom"><span>{module.foot}</span><span aria-hidden="true">↗</span></div>
        </article>
      ))}
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
