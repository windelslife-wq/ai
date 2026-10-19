"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { adminApi, type AdminOverview, type AdminUser } from "../../lib/admin";
import type { SeoSettings } from "../../lib/seo";
import { authApi, type AuthUser } from "../../lib/leadDiscovery";
import { clearSessionTokens, getAccessToken } from "../../lib/session";
import { Navigation } from "../layout/Navigation";

export function AdminWorkspace({ seo }: { seo: SeoSettings }) {
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState<AuthUser | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [mutatingUserId, setMutatingUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isAdmin = identity?.permissions.includes("lead.admin") ?? false;

  useEffect(() => {
    const current = getAccessToken();
    setToken(current);
    if (!current) { setAuthChecked(true); return; }
    void authApi.me(current)
      .then(result => setIdentity(result.user))
      .catch(exception => {
        setAuthFailed(true);
        setError(exception instanceof Error ? exception.message : "Unable to validate administrator access");
        if (!getAccessToken()) setToken("");
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const load = async () => {
    if (!token || !isAdmin) return;
    setBusy(true); setError("");
    try {
      const [summary, list] = await Promise.all([adminApi.overview(token), adminApi.users(token)]);
      setOverview(summary); setUsers(list.users); setDataLoaded(true);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to load admin controls"); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (authChecked && token && isAdmin) void load(); }, [token, authChecked, isAdmin]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await adminApi.createUser({ email, displayName, password, role }, token);
      setEmail(""); setDisplayName(""); setPassword(""); setRole("member");
      setNotice("User account created and added to this organization.");
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to create user"); }
    finally { setBusy(false); }
  };

  const update = async (user: AdminUser, patch: { active?: boolean; role?: "admin" | "member" }) => {
    if (!isAdmin || mutatingUserId) return;
    setMutatingUserId(user.id); setError(""); setNotice("");
    try {
      await adminApi.updateUser(user.id, patch, token);
      setNotice(`${user.email} updated.`);
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to update user"); }
    finally { setMutatingUserId(null); }
  };

  const signOut = async () => {
    const refreshToken = window.localStorage.getItem("lead-refresh-token");
    setBusy(true); setError("");
    try {
      if (refreshToken) await authApi.logout(refreshToken);
      clearSessionTokens();
      window.location.assign("/admin/login");
    } catch (exception) {
      clearSessionTokens(); setToken(""); setIdentity(null); setOverview(null); setUsers([]);
      setError(`Signed out on this device, but the server session could not be revoked: ${exception instanceof Error ? exception.message : "request failed"}`);
      setBusy(false);
    }
  };

  const cards = [
    ["Members", overview?.members ?? "—"],
    ["Stored leads", overview?.leads ?? "—"],
    ["Collections", overview?.collections ?? "—"],
    ["Searches", overview?.searches ?? "—"],
  ] as const;

  return <><Navigation /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-4"><Image src="/images/ai-agent-avatar.png" alt="WINDELS AI Workforce assistant" width={64} height={64} className="rounded-2xl border border-cyan-700 object-cover" /><div><p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">WINDELS AI WORKFORCE · Control Center</p><h1 className="mt-1 text-3xl font-bold text-white">Admin workspace</h1><p className="mt-1 text-sm text-slate-400">Manage access and understand the organization footprint. Admins authenticate through the normal secure system — role determined by backend.</p></div></div>{token && isAdmin && <button disabled={busy} onClick={() => void signOut()} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-red-800 hover:text-red-200 disabled:opacity-50">{busy ? "Signing out…" : "Sign out"}</button>}</header>
    {error && <p role="alert" className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
    {notice && <p role="status" className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
    {!authChecked && <p role="status" className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Checking administrator access…</p>}
    {authChecked && !token && <section className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-5 text-sm text-amber-100"><p>Sign in with an administrator account to open the control centre.</p><a className="mt-3 inline-block underline" href="/admin/login">Open administrator sign-in</a></section>}
    {authChecked && token && authFailed && <section className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-5 text-sm text-amber-100"><p>Your administrator session could not be verified. Check your connection or sign in again.</p><a className="mt-3 inline-block underline" href="/admin/login">Open administrator sign-in</a></section>}
    {authChecked && token && identity && !isAdmin && <section className="mt-6 rounded-xl border border-red-900/70 bg-red-950/30 p-5 text-sm text-red-200"><h2 className="font-semibold">Administrator permission required</h2><p className="mt-2">Your account does not hold <code>lead.admin</code>. The server has not loaded or changed organization data.</p><a className="mt-3 inline-block underline" href="/account">Review account access</a></section>}
    {authChecked && token && isAdmin && <>
      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value]) => <article key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold text-white">{value}</p></article>)}</section>
      <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-white">SEO settings</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">These deployment-level settings control metadata, canonical URLs, sitemap.xml, robots.txt, and social previews. They are read from environment configuration.</p></div><span className="rounded-full border border-cyan-800 bg-cyan-950/40 px-2 py-1 text-xs text-cyan-300">Configured at deploy time</span></div><div className="mt-5 grid gap-3 md:grid-cols-2"><Info label="Site title" value={seo.title} /><Info label="Site URL" value={seo.siteUrl} /><Info label="Description" value={seo.description} /><Info label="Robots" value={seo.robots} /><Info label="Keywords" value={seo.keywords.join(", ")} /><Info label="Social image" value={seo.ogImage} /></div></section>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]"><section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-lg font-semibold text-white">Create user account</h2><p className="mt-1 text-sm leading-6 text-slate-500">Accounts are organization-scoped. Passwords are hashed and never returned. The temporary password is used only for a new account; an existing user keeps their current password.</p><form onSubmit={create} className="mt-5 space-y-3"><label className="block text-sm text-slate-300">Full name<input required value={displayName} onChange={event => setDisplayName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Temporary password<input required minLength={12} type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Role<select value={role} onChange={event => setRole(event.target.value as "admin" | "member")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"><option value="member">Member · leads access</option><option value="admin">Admin · users and leads</option></select></label><button disabled={busy} className="w-full rounded-lg bg-cyan-400 px-4 py-2.5 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Saving…" : "Create account"}</button></form></section>
      <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-5" aria-busy={busy}><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold text-white">Organization users</h2><p className="mt-1 text-sm text-slate-500">Deactivate access without deleting audit history.</p></div><button onClick={() => void load()} disabled={busy} className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50">Refresh</button></div>{busy && !dataLoaded && <p role="status" className="py-5 text-sm text-slate-400">Loading organization data…</p>}<table className="mt-5 w-full min-w-[680px] text-left text-sm"><thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-3">User</th><th className="pb-3">Role</th><th className="pb-3">Status</th><th className="pb-3 text-right">Controls</th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-b border-slate-800/70"><td className="py-4"><p className="font-medium text-white">{user.displayName}</p><p className="mt-1 text-xs text-slate-500">{user.email}</p></td><td>{user.role === "owner" || user.id === identity?.id ? <span className="text-xs text-slate-300">{user.role === "owner" ? "Owner" : `${user.role} · you`}</span> : <select value={user.role} disabled={mutatingUserId === user.id || !!mutatingUserId} onChange={event => void update(user, { role: event.target.value as "admin" | "member" })} className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"><option value="admin">Admin</option><option value="member">Member</option></select>}</td><td><span className={`rounded-full px-2 py-1 text-xs ${user.active ? "bg-emerald-950 text-emerald-200" : "bg-slate-800 text-slate-500"}`}>{user.active ? "Active" : "Inactive"}</span></td><td className="text-right">{user.id === identity?.id ? <span className="text-xs text-slate-500">Current account</span> : <button disabled={mutatingUserId === user.id || !!mutatingUserId} onClick={() => void update(user, { active: !user.active })} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">{user.active ? "Deactivate" : "Activate"}</button>}</td></tr>)}</tbody></table>{dataLoaded && !error && !users.length && <p className="py-10 text-center text-sm text-slate-500">No organization members found.</p>}</section></div>
    </>}
  </main></>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 break-words text-sm text-slate-200">{value || "—"}</p></div>; }
