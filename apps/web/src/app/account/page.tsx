"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Navigation } from "../../components/layout/Navigation";
import { authApi, type AuthSession } from "../../lib/leadDiscovery";
import { clearSessionTokens, getAccessToken } from "../../lib/session";

export default function AccountPage() {
  const [token, setToken] = useState(""); const [user, setUser] = useState<AuthSession["user"] | null>(null); const [organizationId, setOrganizationId] = useState(""); const [permissions, setPermissions] = useState<string[]>([]); const [error, setError] = useState("");
  useEffect(() => { const current = getAccessToken(); setToken(current); if (!current) return; void authApi.me(current).then(result => { setUser(result.user); setOrganizationId(result.user.organizationId); setPermissions(result.user.permissions); }).catch(exception => setError(exception instanceof Error ? exception.message : "Session expired")); }, []);
  const logout = async () => { const refresh = window.localStorage.getItem("lead-refresh-token"); if (refresh) await authApi.logout(refresh).catch(() => undefined); clearSessionTokens(); window.location.assign("/login"); };
  return <><Navigation /><main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"><div className="h-32 bg-gradient-to-r from-cyan-950 via-slate-900 to-amber-950" /><div className="-mt-12 px-6 pb-7"><Image src="/images/windels-mark.png" alt="WINDELS AI WORKFORCE" width={88} height={88} className="rounded-2xl border-4 border-slate-900 shadow-xl object-cover" /><p className="mt-5 text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Account</p><h1 className="mt-2 text-3xl font-bold text-white">Your WINDELS AI WORKFORCE account</h1>{error ? <p className="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}. <a href="/login" className="underline">Sign in again</a></p> : user ? <div className="mt-6 space-y-3"><Info label="Email" value={user.email} /><Info label="Organization" value={organizationId} /><Info label="Access" value={permissions.join(" · ")} /><div className="pt-3"><button onClick={() => void logout()} className="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 hover:bg-red-950/40">Sign out</button></div></div> : <p className="mt-6 text-sm text-slate-500">Loading your session…</p>}</div></section></main></>;
}
function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-slate-800 bg-slate-950 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 break-all text-sm text-slate-200">{value || "—"}</p></div>; }
