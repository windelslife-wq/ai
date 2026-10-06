import { useCallback, useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const NATIVE_BUILD = __NATIVE_BUILD__;

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    throw new Error(data?.error?.message || `Request failed (${response.status})`);
  }
  return data;
}

function Brand({ compact = false }) {
  return (
    <a className={`app-brand${compact ? " app-brand-compact" : ""}`} href="/" aria-label="WINDELS AI WORKFORCE home">
      <span className="app-brand-mark" aria-hidden="true">W</span>
      <span>WINDELS <b>AI WORKFORCE</b></span>
    </a>
  );
}

function StatusPill({ status }) {
  const good = status === "ready" || status === "ok";
  return <span className={`status-pill ${good ? "status-good" : "status-warn"}`}><i />{status || "checking"}</span>;
}

function LoginPanel({ onLogin, busy, error, native }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  return (
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-panel-top"><span className="overline">MEMBER ACCESS</span><span className="login-orbit" aria-hidden="true">✳</span></div>
      <h2 id="login-title">Welcome<br /><em>back.</em></h2>
      <p className="login-copy">Sign in to continue to your private workspace.</p>
      {native ? (
        <div className="notice-box" role="status">
          <strong>Native sign-in is not enabled yet.</strong>
          <span>This build needs the reviewed native token and secure-storage flow before it can authenticate. No credentials are stored in the app.</span>
        </div>
      ) : (
        <form className="login-form" onSubmit={(event) => {
          event.preventDefault();
          onLogin({ identifier, password });
        }}>
          <label htmlFor="identifier">Username, email or user ID</label>
          <input id="identifier" name="identifier" autoComplete="username" maxLength="254" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" maxLength="1024" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Checking…" : "Sign in"}<span aria-hidden="true">→</span></button>
        </form>
      )}
      <div className="login-foot"><span className="secure-dot" /> Protected by server-side sessions and permission checks.</div>
    </section>
  );
}

function Workspace({ user, permissions, health, csrfToken, onLogout, busy, native }) {
  const moduleCards = [
    { number: "01", title: "Market intelligence", text: "Analysis and risk-aware research workflows.", status: "Not yet ported to Node" },
    { number: "02", title: "Sports research", text: "Evidence, data quality and publication review.", status: "Not yet ported to Node" },
    { number: "03", title: "Lottery tools", text: "Historical statistics and ticket utilities.", status: "Not yet ported to Node" },
    { number: "04", title: "Language learning", text: "Lessons, practice and learner progress.", status: "Not yet ported to Node" },
    { number: "05", title: "Lead discovery", text: "Organization-aware discovery and pipeline tools.", status: "Not yet ported to Node" },
    { number: "06", title: "Account & access", text: "Identity, permissions and audited activity.", status: "Foundation slice" },
  ];
  return (
    <div className="workspace-view">
      <header className="workspace-header">
        <Brand compact />
        <div className="workspace-header-right"><StatusPill status={health?.status || "checking"} />
          <button className="text-button" type="button" onClick={() => onLogout(csrfToken)} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>
        </div>
      </header>
      <main className="workspace-main">
        <div className="workspace-welcome"><div>
          <div className="overline">PRIVATE WORKSPACE <span className="overline-line" /></div>
          <h1>Good to see you,<br /><em>{user.displayName || user.username}.</em></h1>
          <p className="workspace-lede">Your workspace foundation is online. Product modules are being migrated and will appear here only after their security and parity checks are complete.</p>
        </div><div className="welcome-seal"><span>W</span><small>YOUR<br />WORKSPACE</small></div></div>
        <section className="system-status" aria-label="Platform status">
          <div className="system-status-heading"><span className="overline">PLATFORM READINESS</span><StatusPill status={health?.status || "checking"} /></div>
          <div className="status-grid"><div><small>NODE API</small><strong>{health?.status === "ready" ? "Operational" : health?.status === "not_ready" ? "Database or schema unavailable" : "Checking"}</strong></div><div><small>DATABASE</small><strong>{health?.database ? "Connected" : "Not ready"}</strong></div><div><small>SCHEMA</small><strong>{health?.schema ? "Foundation ready" : "Migration needed"}</strong></div><div><small>TRADING MODE</small><strong>Not enabled in this shell</strong></div></div>
        </section>
        <div className="modules-heading"><div><div className="overline">YOUR MODULES</div><h2>Tools, with status in view.</h2></div><span className="permission-count">{permissions.length} permission{permissions.length === 1 ? "" : "s"}</span></div>
        <div className="workspace-grid">{moduleCards.map((module) => <article className="workspace-card" key={module.number}>
          <div className="workspace-card-top"><span>{module.number}</span><span className={module.status === "Foundation slice" ? "live-label" : "planned-label"}>{module.status}</span></div>
          <h3>{module.title}</h3><p>{module.text}</p><div className="workspace-card-bottom"><span>{module.status === "Foundation slice" ? "ACTIVE FOUNDATION" : "MIGRATION BACKLOG"}</span><span aria-hidden="true">↗</span></div>
        </article>)}</div>
        <section className="account-strip"><div><span className="overline">SIGNED IN AS</span><strong>{user.username}</strong><span>{user.email || "Email not set"}{user.legacyUid ? ` · ID ${user.legacyUid}` : ""}</span></div><div className="permission-list"><span className="overline">PERMISSIONS</span><div>{permissions.length ? permissions.map((permission) => <span className="permission-tag" key={permission}>{permission}</span>) : <span className="permission-empty">No permissions assigned</span>}</div></div></section>
        {native && <p className="native-notice">Native UI preview only: authentication and sensitive actions remain disabled until the secure native session flow is implemented.</p>}
      </main>
      <footer className="workspace-footer"><Brand compact /><span>Migration in progress · Existing PHP platform remains authoritative.</span><a href="/">Public site ↗</a></footer>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [csrfToken, setCsrfToken] = useState("");
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);

  const loadSession = useCallback(async () => {
    if (NATIVE_BUILD) return;
    try {
      const [me, csrf] = await Promise.all([
        request("/api/v1/auth/me"),
        request("/api/v1/auth/csrf"),
      ]);
      setUser(me.user);
      setPermissions(me.permissions || []);
      setCsrfToken(csrf.csrfToken || "");
    } catch {
      setUser(null);
      setPermissions([]);
      setCsrfToken("");
    }
  }, []);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    if (!NATIVE_BUILD) {
      request("/api/v1/health/ready").then(setHealth).catch((failure) => {
        setHealth((current) => current || { status: "not_ready", database: false, schema: false, message: failure.message });
      });
      void loadSession();
      if ("serviceWorker" in navigator && window.isSecureContext) {
        navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
      }
    } else {
      setHealth({ status: "native-shell", database: false, schema: false });
    }
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [loadSession]);

  async function login(credentials) {
    setBusy(true);
    setError("");
    try {
      const session = await request("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      setUser(session.user);
      setPermissions(session.permissions || []);
      setCsrfToken(session.csrfToken || "");
    } catch (failure) {
      setError(failure.message || "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function logout(token) {
    setBusy(true);
    setError("");
    try {
      await request("/api/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": token },
        body: "{}",
      });
      setUser(null);
      setPermissions([]);
      setCsrfToken("");
    } catch (failure) {
      setError(failure.message || "Unable to sign out.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      {user && !NATIVE_BUILD ? <Workspace user={user} permissions={permissions} health={health} csrfToken={csrfToken} onLogout={logout} busy={busy} native={false} /> : (
        <main className="entry-layout">
          <div className="entry-main">
            <header className="entry-header"><Brand /><a href="/" className="back-link">Public site <span aria-hidden="true">↗</span></a></header>
            <div className="entry-content">
              <div className="overline">WINDELS AI WORKFORCE <span className="overline-line" /></div>
              <h1>Intelligence<br />with <em>guardrails.</em></h1>
              <p className="entry-copy">A shared workspace for research, learning and operations. The new Node.js platform is being built in carefully verified stages.</p>
              <div className="entry-metrics"><div><span className="metric-symbol">◈</span><strong>Human-led</strong><small>People stay in control</small></div><div><span className="metric-symbol">⌁</span><strong>Evidence-aware</strong><small>Status is never implied</small></div></div>
            </div>
            <div className="entry-bottom"><span>STAGED MIGRATION · ROLLBACK PRESERVED</span><span>NODE FOUNDATION</span></div>
          </div>
          <div className="entry-side">
            <div className="side-glow" aria-hidden="true" />
            <LoginPanel onLogin={login} busy={busy} error={error} native={NATIVE_BUILD} />
            {NATIVE_BUILD ? <div className="side-status"><span className="status-dot status-dot-muted" /> Secure native sign-in awaiting implementation</div> : (
              <div className="side-status"><span className={`status-dot ${health?.status === "ready" ? "" : "status-dot-muted"}`} /> API <b>{health?.status === "ready" ? "ready" : health?.status === "not_ready" ? "not ready" : "checking"}</b><span className="status-divider">/</span>{online ? "online" : "offline"}</div>
            )}
          </div>
        </main>
      )}
      {error && user && <div className="floating-error" role="alert">{error}</div>}
    </div>
  );
}
