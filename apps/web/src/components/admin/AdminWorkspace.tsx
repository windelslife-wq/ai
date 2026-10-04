"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { adminApi, type AdminOverview, type AdminUser } from "../../lib/admin";
import type { SeoSettings } from "../../lib/seo";
import { clearSessionTokens, getAccessToken } from "../../lib/session";
import { Navigation } from "../layout/Navigation";

export function AdminWorkspace({ seo }: { seo: SeoSettings }) {
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => setToken(getAccessToken()), []);
  const load = async () => {
    if (!token) return;
    setBusy(true); setError("");
    try { const [summary, list] = await Promise.all([adminApi.overview(token), adminApi.users(token)]); setOverview(summary); setUsers(list.users); }
    catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to load admin controls"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [token]);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await adminApi.createUser({ email, displayName, password, role }, token); setEmail(""); setDisplayName(""); setPassword(""); setRole("member"); setNotice("User account created and added to this organization."); await load(); }
    catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to create user"); }
    finally { setBusy(false); }
  };
  const update = async (user: AdminUser, patch: { active?: boolean; role?: "admin" | "member" }) => {
    try { await adminApi.updateUser(user.id, patch, token); setNotice(`${user.email} updated.`); await load(); }
    catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to update user"); }
  };
  const signOut = () => { clearSessionTokens(); window.location.assign("/admin/login"); };
  const cards = [["Members", overview?.members ?? 0], ["Stored leads", overview?.leads ?? 0], ["Collections", overview?.collections ?? 0], ["Searches", overview?.searches ?? 0]];

  return <><Navigation /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-4"><Image src="/images/ai-agent-avatar.png" alt="WINDELS AI Workforce assistant" width={64} height={64} className="rounded-2xl border border-cyan-700 object-cover" /><div><p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">WINDELS AI WORKFORCE · Control Center</p><h1 className="mt-1 text-3xl font-bold text-white">Admin workspace</h1><p className="mt-1 text-sm text-slate-400">Manage access and understand the organization footprint. Admins authenticate through the normal secure system — role determined by backend.</p></div></div><button onClick={signOut} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-red-800 hover:text-red-200">Sign out</button></header>
    {error && <p role="alert" className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}{notice && <p className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
    <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value]) => <article key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold text-white">{value}</p></article>)}</section>
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-white">SEO settings</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">These deployment-level settings control metadata, canonical URLs, sitemap.xml, robots.txt, and social previews. They are read from environment configuration.</p></div><span className="rounded-full border border-cyan-800 bg-cyan-950/40 px-2 py-1 text-xs text-cyan-300">Configured at deploy time</span></div><div className="mt-5 grid gap-3 md:grid-cols-2"><Info label="Site title" value={seo.title} /><Info label="Site URL" value={seo.siteUrl} /><Info label="Description" value={seo.description} /><Info label="Robots" value={seo.robots} /><Info label="Keywords" value={seo.keywords.join(", ")} /><Info label="Social image" value={seo.ogImage} /></div></section>
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]"><section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="text-lg font-semibold text-white">Create user account</h2><p className="mt-1 text-sm leading-6 text-slate-500">Accounts are organization-scoped. Passwords are hashed and never returned.</p><form onSubmit={create} className="mt-5 space-y-3"><label className="block text-sm text-slate-300">Full name<input required value={displayName} onChange={event => setDisplayName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Temporary password<input required minLength={12} type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white" /></label><label className="block text-sm text-slate-300">Role<select value={role} onChange={event => setRole(event.target.value as "admin" | "member")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"><option value="member">Member · leads access</option><option value="admin">Admin · users and leads</option></select></label><button disabled={busy || !token} className="w-full rounded-lg bg-cyan-400 px-4 py-2.5 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Saving…" : "Create account"}</button></form></section>
    <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold text-white">Organization users</h2><p className="mt-1 text-sm text-slate-500">Deactivate access without deleting audit history.</p></div><button onClick={() => void load()} disabled={busy} className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Refresh</button></div><table className="mt-5 w-full min-w-[680px] text-left text-sm"><thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-3">User</th><th className="pb-3">Role</th><th className="pb-3">Status</th><th className="pb-3 text-right">Controls</th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-b border-slate-800/70"><td className="py-4"><p className="font-medium text-white">{user.displayName}</p><p className="mt-1 text-xs text-slate-500">{user.email}</p></td><td><select value={user.role} onChange={event => void update(user, { role: event.target.value as "admin" | "member" })} className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"><option value="admin">Admin</option><option value="member">Member</option></select></td><td><span className={`rounded-full px-2 py-1 text-xs ${user.active ? "bg-emerald-950 text-emerald-200" : "bg-slate-800 text-slate-500"}`}>{user.active ? "Active" : "Inactive"}</span></td><td className="text-right"><button onClick={() => void update(user, { active: !user.active })} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300">{user.active ? "Deactivate" : "Activate"}</button></td></tr>)}</tbody></table>{!users.length && <p className="py-10 text-center text-sm text-slate-500">No organization members found.</p>}</section></div>
  </main></>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-slate-800 bg-slate-950 p-3"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 break-words text-sm text-slate-200">{value || "—"}</p></div>; }
