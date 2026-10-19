"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Navigation } from "../../components/layout/Navigation";
import { authApi, type AuthUser } from "../../lib/leadDiscovery";
import { clearSessionTokens, getAccessToken } from "../../lib/session";

export default function AccountPage() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const checkSession = useCallback(async (current = getAccessToken()) => {
    setAuthChecked(false); setError(""); setToken(current);
    if (!current) { setUser(null); setAuthChecked(true); return; }
    try {
      const result = await authApi.me(current);
      setUser(result.user);
      setToken(getAccessToken() || current);
    } catch (exception) {
      setUser(null);
      setError(exception instanceof Error ? exception.message : "Unable to load your account");
      if (!getAccessToken()) setToken("");
    } finally { setAuthChecked(true); }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  const logout = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const refresh = window.localStorage.getItem("lead-refresh-token");
    try {
      if (refresh) await authApi.logout(refresh);
      clearSessionTokens();
      window.location.assign("/login");
    } catch (exception) {
      clearSessionTokens(); setToken(""); setUser(null);
      setError(`Signed out on this device, but the server session could not be revoked: ${exception instanceof Error ? exception.message : "request failed"}`);
      setBusy(false);
    }
  };

  return <><Navigation /><main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"><div className="h-32 bg-gradient-to-r from-cyan-950 via-slate-900 to-amber-950" /><div className="-mt-12 px-6 pb-7"><Image src="/images/windels-mark.png" alt="WINDELS AI WORKFORCE" width={88} height={88} className="rounded-2xl border-4 border-slate-900 object-cover shadow-xl" /><p className="mt-5 text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Account</p><h1 className="mt-2 text-3xl font-bold text-white">Your WINDELS AI WORKFORCE account</h1>
    {error && <div role="alert" className="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200"><p>{error}</p><div className="mt-2 flex flex-wrap gap-4"><a href="/login" className="underline">Sign in again</a>{token && !user && <button type="button" onClick={() => void checkSession()} disabled={!authChecked} className="underline disabled:opacity-50">Retry session check</button>}</div></div>}
    {!authChecked && <p role="status" className="mt-6 text-sm text-slate-400">Checking your session…</p>}
    {authChecked && !token && !error && <div className="mt-6 rounded-lg border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100"><p>You are not signed in.</p><a href="/login" className="mt-2 inline-block underline">Open secure sign-in</a></div>}
    {authChecked && user && <div className="mt-6 space-y-3"><Info label="Name" value={user.displayName} /><Info label="Email" value={user.email} /><Info label="Organization" value={user.organizationId} /><Info label="Access" value={user.permissions.length ? user.permissions.join(" · ") : "No permissions returned"} /><div className="pt-3"><button disabled={busy} onClick={() => void logout()} className="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-200 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Signing out…" : "Sign out"}</button></div></div>}
  </div></section></main></>;
}

function Info({ label, value }: { label: string; value: string | null | undefined }) { return <div className="rounded-xl border border-slate-800 bg-slate-950 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 break-all text-sm text-slate-200">{value || "—"}</p></div>; }
