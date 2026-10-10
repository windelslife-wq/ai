/**
 * Workspace SPA shell.
 *
 * The session is loaded once (`GET /auth/me` + `/auth/csrf`), the router decides
 * which view renders, and every guard here is a *presentation* decision only —
 * the API re-checks the same permission and refuses with 403 regardless of what
 * the browser rendered. Views show loading, empty, error and offline states
 * rather than assuming the happy path.
 *
 * Native (Capacitor) builds stay a preview: no session load, no sign-in, because
 * the native token contract is not implemented yet.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { endpoints, setCsrfToken, setUnauthorizedHandler } from "./api.js";
import { Link, matchRoute, RouterProvider, useRouter } from "./router.jsx";
import { ConnectivityBanner, Notice, UpdateBanner } from "./ui.jsx";
import {
  AccountView, AdminUsersView, Brand, InquiriesView, LoginPanel, ModuleCards,
  NotFoundView, RegisterPanel, StatusPill, StatusView, WorkspaceNav,
} from "./views.jsx";

const NATIVE_BUILD = __NATIVE_BUILD__;

/**
 * Declared workspace surfaces. Exact paths only: the server already answers any
 * unknown `/app/*` URL with this shell, so a wildcard route here would make an
 * undeclared path look intentional.
 */
const ROUTES = [
  { path: "/app", view: "workspace", requiresAuth: true },
  { path: "/app/account", view: "account", requiresAuth: true },
  { path: "/app/status", view: "status" },
  { path: "/app/admin/users", view: "admin-users", requiresAuth: true, permission: "identity.users.view" },
  { path: "/app/admin/inquiries", view: "inquiries", requiresAuth: true, permission: "system.super_admin" },
  { path: "/app/login", view: "login", guestOnly: true },
  { path: "/app/register", view: "register", guestOnly: true },
];

function EntryLayout({ children, side, health, online }) {
  return (
    <main className="entry-layout">
      <div className="entry-main">
        <header className="entry-header"><Brand /><a href="/" className="back-link">Public site <span aria-hidden="true">↗</span></a></header>
        <div className="entry-content">
          <div className="overline">WINDELS AI WORKFORCE <span className="overline-line" /></div>
          <h1>Intelligence<br />with <em>guardrails.</em></h1>
          <p className="entry-copy">A shared workspace for research, learning and operations. The new Node.js platform is being built in carefully verified stages.</p>
          <div className="entry-metrics">
            <div><span className="metric-symbol">◈</span><strong>Human-led</strong><small>People stay in control</small></div>
            <div><span className="metric-symbol">⌁</span><strong>Evidence-aware</strong><small>Status is never implied</small></div>
          </div>
        </div>
        <div className="entry-bottom"><span>STAGED MIGRATION · ROLLBACK PRESERVED</span><span>NODE FOUNDATION</span></div>
      </div>
      <div className="entry-side">
        <div className="side-glow" aria-hidden="true" />
        {children}
        {side || (
          <div className="side-status">
            <span className={`status-dot ${health?.status === "ready" ? "" : "status-dot-muted"}`} />
            API <b>{health?.status === "ready" ? "ready" : health?.status === "not_ready" ? "not ready" : "checking"}</b>
            <span className="status-divider">/</span>{online ? "online" : "offline"}
          </div>
        )}
      </div>
    </main>
  );
}

function WorkspaceShell({ user, permissions, health, current, busy, onLogout, children }) {
  return (
    <div className="workspace-view">
      <header className="workspace-header">
        <Brand compact />
        <div className="workspace-header-right">
          <StatusPill status={health?.status || "checking"} />
          <span className="signed-in-as">{user ? user.username : "guest"}</span>
          {user ? <button className="text-button" type="button" onClick={onLogout} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button> : null}
        </div>
      </header>
      <div className="workspace-body">
        <WorkspaceNav permissions={permissions} current={current} />
        <main className="workspace-main">{children}</main>
      </div>
      <footer className="workspace-footer">
        <Brand compact />
        <span>Migration in progress · Existing PHP platform remains authoritative.</span>
        <a href="/">Public site ↗</a>
      </footer>
    </div>
  );
}

function WorkspaceOverview({ user, permissions, health }) {
  return (
    <div className="view">
      <div className="workspace-welcome">
        <div>
          <div className="overline">PRIVATE WORKSPACE <span className="overline-line" /></div>
          <h1>Good to see you,<br /><em>{user.displayName || user.username}.</em></h1>
          <p className="workspace-lede">Your workspace foundation is online. Product modules are being migrated and will appear here only after their security and parity checks are complete.</p>
        </div>
        <div className="welcome-seal"><span>W</span><small>YOUR<br />WORKSPACE</small></div>
      </div>

      <section className="system-status" aria-label="Platform status">
        <div className="system-status-heading"><span className="overline">PLATFORM READINESS</span><StatusPill status={health?.status || "checking"} /></div>
        <div className="status-grid">
          <div><small>NODE API</small><strong>{health?.status === "ready" ? "Operational" : health?.status === "not_ready" ? "Database or schema unavailable" : "Checking"}</strong></div>
          <div><small>DATABASE</small><strong>{health?.database ? "Connected" : "Not ready"}</strong></div>
          <div><small>SCHEMA</small><strong>{health?.schema ? "Foundation ready" : "Migration needed"}</strong></div>
          <div><small>TRADING MODE</small><strong>Not enabled in this shell</strong></div>
        </div>
        <Link className="text-button" to="/app/status">Open the full module status →</Link>
      </section>

      <div className="modules-heading">
        <div><div className="overline">YOUR MODULES</div><h2>Tools, with status in view.</h2></div>
        <span className="permission-count">{permissions.length} permission{permissions.length === 1 ? "" : "s"}</span>
      </div>
      <ModuleCards />

      <section className="account-strip">
        <div>
          <span className="overline">SIGNED IN AS</span>
          <strong>{user.username}</strong>
          <span>{user.email || "Email not set"}{user.legacyUid ? ` · ID ${user.legacyUid}` : ""}</span>
        </div>
        <div className="permission-list">
          <span className="overline">PERMISSIONS</span>
          <div>{permissions.length ? permissions.map((permission) => <span className="permission-tag" key={permission}>{permission}</span>) : <span className="permission-empty">No permissions assigned</span>}</div>
        </div>
      </section>
    </div>
  );
}

function SessionApp() {
  const { path, navigate } = useRouter();
  const [session, setSession] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(!NATIVE_BUILD);
  const [health, setHealth] = useState(NATIVE_BUILD ? { status: "native-shell", database: false, schema: false } : null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [online, setOnline] = useState(navigator.onLine);
  const [afterLogin, setAfterLogin] = useState(null);

  const applySession = useCallback((payload) => {
    setSession({ user: payload.user, permissions: payload.permissions || [] });
    if (payload.csrfToken) setCsrfToken(payload.csrfToken);
    setBootstrapping(false);
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setCsrfToken("");
    setBootstrapping(false);
  }, []);

  // A 401 from any view means the session ended (expiry, rotation, revocation).
  // One handler here keeps every view from re-implementing the same redirect.
  useEffect(() => {
    if (NATIVE_BUILD) return undefined;
    setUnauthorizedHandler(() => { clearSession(); });
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (NATIVE_BUILD) return;
    endpoints.ready().then(setHealth).catch((failure) => {
      setHealth({ status: "not_ready", database: false, schema: false, message: failure.message });
    });
    let cancelled = false;
    (async () => {
      try {
        const [me, csrf] = await Promise.all([endpoints.me(), endpoints.csrf()]);
        if (cancelled) return;
        setCsrfToken(csrf?.csrfToken || me.csrfToken || "");
        applySession(me);
      } catch {
        if (!cancelled) clearSession();
      }
    })();
    return () => { cancelled = true; };
  }, [applySession, clearSession]);

  const route = useMemo(() => matchRoute(ROUTES, path), [path]);
  const user = session?.user || null;
  const permissions = session?.permissions || [];

  // A signed-in member landing on /app/login or /app/register goes to the workspace.
  useEffect(() => {
    if (!user || !route?.guestOnly) return;
    navigate("/app/", { replace: true });
  }, [user, route, navigate]);

  async function login(credentials) {
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    try {
      applySession(await endpoints.login(credentials));
      navigate(afterLogin || "/app/", { replace: true });
      setAfterLogin(null);
    } catch (error) {
      setFormError(error?.message || "Unable to sign in.");
      if (error?.status === 429) setFormError(`${error.message}${error.retryAfter ? ` Try again in about ${error.retryAfter}s.` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function register(payload) {
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    try {
      applySession(await endpoints.register({
        username: payload.username.trim(),
        email: payload.email.trim(),
        displayName: payload.displayName.trim() || undefined,
        password: payload.password,
        passwordConfirm: payload.passwordConfirm,
        termsAccepted: payload.termsAccepted,
      }));
      navigate("/app/", { replace: true });
    } catch (error) {
      const fields = {};
      for (const issue of error?.details || []) {
        const field = String(issue.field || "").replace(/^body\./, "");
        if (field && !fields[field]) fields[field] = issue.message;
      }
      setFieldErrors(fields);
      setFormError(error?.message || "Unable to create the account.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await endpoints.logout();
    } catch {
      // The session is gone either way; leaving the user signed in after a failed
      // logout would be the dishonest outcome.
    } finally {
      clearSession();
      setBusy(false);
      navigate("/app/login", { replace: true });
    }
  }

  if (NATIVE_BUILD) {
    return (
      <div className="app-shell">
        <EntryLayout health={health} online={online}>
          <LoginPanel onLogin={login} busy={busy} error={formError} native />
        </EntryLayout>
        <p className="native-notice">Native UI preview only: authentication and sensitive actions remain disabled until the secure native session flow is implemented.</p>
      </div>
    );
  }

  if (bootstrapping) {
    return (
      <div className="app-shell">
        <EntryLayout health={health} online={online}>
          <section className="login-panel"><div className="login-panel-top"><span className="overline">MEMBER ACCESS</span></div>
            <h2>Checking<br /><em>your session…</em></h2>
            <p className="login-copy">The server holds the session; the browser never does.</p>
          </section>
        </EntryLayout>
      </div>
    );
  }

  // Remember where the member was heading so sign-in lands them there, not on a
  // generic dashboard. Set in an effect: a render-phase setState here would loop.
  const wantsAuth = Boolean(route?.requiresAuth && !user);
  useEffect(() => {
    if (wantsAuth) setAfterLogin(path);
  }, [wantsAuth, path]);

  if (wantsAuth) {
    return (
      <div className="app-shell">
        <UpdateBanner />
        <EntryLayout health={health} online={online}>
          <LoginPanel onLogin={login} busy={busy} error={formError} native={false}
            notice={`Sign in to continue to ${path}.`} />
        </EntryLayout>
      </div>
    );
  }

  if (!route) {
    return (
      <div className="app-shell">
        <UpdateBanner />
        {user ? (
          <WorkspaceShell user={user} permissions={permissions} health={health} current={path} busy={busy} onLogout={logout}>
            <NotFoundView path={path} />
          </WorkspaceShell>
        ) : (
          <EntryLayout health={health} online={online}>
            <LoginPanel onLogin={login} busy={busy} error={formError} native={false} />
          </EntryLayout>
        )}
      </div>
    );
  }

  if (route.guestOnly && !user) {
    return (
      <div className="app-shell">
        <UpdateBanner />
        <EntryLayout health={health} online={online}>
          {route.view === "register"
            ? <RegisterPanel onRegister={register} busy={busy} error={formError} fieldErrors={fieldErrors} native={false} />
            : <LoginPanel onLogin={login} busy={busy} error={formError} native={false} />}
        </EntryLayout>
      </div>
    );
  }

  if (route.guestOnly && user) {
    return <div className="app-shell"><UpdateBanner /><EntryLayout health={health} online={online}><Notice tone="info">You are signed in — taking you to your workspace.</Notice></EntryLayout></div>;
  }

  const denied = route.permission && !permissions.includes(route.permission);
  const body = denied ? (
    <div className="view">
      <header className="view-header">
        <div><div className="overline">ACCESS <span className="overline-line" /></div><h1>This surface needs a permission you do not hold.</h1></div>
        <Link className="text-button" to="/app/">Back to overview</Link>
      </header>
      <Notice tone="warn">
        <code>{route.view}</code> requires <code>{route.permission}</code>. Your role carries {permissions.length} permission{permissions.length === 1 ? "" : "s"}.
        The API returns <strong>403</strong> for this path with your session, so nothing here is a client-side guess.
      </Notice>
    </div>
  ) : (
    {
      workspace: <WorkspaceOverview user={user} permissions={permissions} health={health} />,
      account: <AccountView user={user} permissions={permissions} onSessionChanged={applySession} />,
      status: <StatusView />,
      "admin-users": <AdminUsersView permissions={permissions} />,
      inquiries: <InquiriesView />,
    }[route.view]
  );

  return (
    <div className="app-shell">
      <UpdateBanner />
      <WorkspaceShell user={user} permissions={permissions} health={health} current={route.path} busy={busy} onLogout={logout}>
        <ConnectivityBanner />
        {body}
      </WorkspaceShell>
    </div>
  );
}

export default function App() {
  return (
    <RouterProvider basePath="/app">
      <SessionApp />
    </RouterProvider>
  );
}
