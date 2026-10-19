"use client";

import { useEffect, useState } from "react";
import { authApi, intelligenceApi, leadApi, type Coverage, type Duplicate, type SearchHistoryResponse } from "../../lib/leadDiscovery";
import { getAccessToken } from "../../lib/session";
import { Navigation } from "../layout/Navigation";

export function IntelligenceWorkspace() {
  const [token, setToken] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [history, setHistory] = useState<SearchHistoryResponse["history"]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [missing, setMissing] = useState("phone");
  const [authChecked, setAuthChecked] = useState(false);
  const [authValidated, setAuthValidated] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const canWrite = permissions.includes("lead.write") || permissions.includes("lead.admin");
  const canRead = canWrite || permissions.includes("lead.read");

  useEffect(() => {
    const current = getAccessToken();
    setToken(current);
    if (!current) { setAuthChecked(true); return; }
    void authApi.me(current)
      .then(result => { setPermissions(result.user.permissions); setAuthValidated(true); })
      .catch(exception => {
        setAuthFailed(true);
        setError(exception instanceof Error ? exception.message : "Unable to validate the session");
        if (!getAccessToken()) setToken("");
      })
      .finally(() => setAuthChecked(true));
  }, []);

  const load = async () => {
    if (!token || !canRead) return;
    setLoading(true); setError("");
    try {
      const [nextCoverage, nextHistory, nextDuplicates] = await Promise.all([
        leadApi.coverage(token, missing),
        intelligenceApi.history(token),
        intelligenceApi.duplicates(token),
      ]);
      setCoverage(nextCoverage);
      setHistory(nextHistory.history);
      setDuplicates(nextDuplicates.duplicates);
      setLoaded(true);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Unable to load intelligence");
    } finally { setLoading(false); }
  };
  useEffect(() => { if (authChecked && token && canRead) void load(); }, [token, missing, authChecked, canRead]);

  const resolve = async (id: string, action: "keep_a" | "keep_b" | "merge" | "ignore") => {
    if (!canWrite || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await intelligenceApi.resolveDuplicate(id, action, token);
      setNotice(`Duplicate ${action.replace("_", " ")} decision recorded.`);
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to resolve duplicate"); }
    finally { setBusy(false); }
  };

  const preview = async () => {
    if (!canRead || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await intelligenceApi.exportPreview({}, token);
      setNotice(`${result.count} records are ready for export; formula-safe preview generated.`);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to preview export"); }
    finally { setBusy(false); }
  };

  const csv = async () => {
    if (!canWrite || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const blob = await intelligenceApi.exportCsv({}, token);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "leads.csv"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("CSV export downloaded and recorded.");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "CSV export failed"); }
    finally { setBusy(false); }
  };

  return <><Navigation /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header><p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Quality &amp; audit</p><h1 className="mt-2 text-3xl font-bold text-white">Lead intelligence</h1><p className="mt-2 text-slate-400">Coverage, duplicate review, discovery history, and safe exports are calculated from stored organization data.</p></header>
    {!authChecked && <p role="status" className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Checking your session…</p>}
    {authChecked && !token && <p className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100">Sign in from <a className="underline" href="/login">the secure login</a> to inspect data quality.</p>}
    {authChecked && token && authFailed && <p className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100">Your session could not be verified. Check your connection or <a className="underline" href="/login">sign in again</a>.</p>}
    {authChecked && token && authValidated && !canRead && <p className="mt-6 rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">Your account does not have lead workspace access. Ask an administrator for <code>lead.read</code> or <code>lead.write</code>.</p>}
    {canRead && !canWrite && <p className="mt-5 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-100">Read-only access. Resolving duplicates and downloading CSV require <code>lead.write</code>; preview remains available.</p>}
    {notice && <p role="status" className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
    {error && <p role="alert" className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
    {canRead && <>
      <section className="mt-7 rounded-xl border border-slate-800 bg-slate-900 p-5" aria-busy={loading}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-white">Data coverage</h2><p className="mt-1 text-sm text-slate-500">{coverage ? `${coverage.leadCount} stored leads · missing values are not estimated.` : loading ? "Loading coverage…" : error ? "Coverage could not be loaded." : "Coverage has not been loaded."}</p></div><div className="flex gap-2"><select value={missing} onChange={event => setMissing(event.target.value)} className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"><option value="phone">Missing phone</option><option value="website">Missing website</option><option value="address">Missing address</option><option value="category">Missing category</option></select><button type="button" onClick={() => void load()} disabled={loading || busy} className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button><button onClick={() => void preview()} disabled={busy || !canRead} className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50">{busy ? "Working…" : "Preview export"}</button>{canWrite && <button onClick={() => void csv()} disabled={busy} className="rounded bg-cyan-400 px-3 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50">Export CSV</button>}</div></div>
        {coverage && <><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{coverage.fields.map(field => <article key={field.key} className="rounded-lg border border-slate-800 bg-slate-950 p-4"><p className="text-sm text-slate-400">{field.field}</p><p className="mt-2 text-2xl font-bold text-white">{field.coverage}%</p><p className="text-xs text-slate-500">{field.missing} missing</p></article>)}</div>{coverage.missingLeads.length > 0 && <div className="mt-5 border-t border-slate-800 pt-4"><p className="text-xs uppercase tracking-wide text-slate-500">Sample: missing {missing}</p><div className="mt-2 flex flex-wrap gap-2">{coverage.missingLeads.slice(0, 10).map(lead => <span key={lead.id} className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">{lead.name}</span>)}</div></div>}</>}
      </section>
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold text-white">Duplicate review</h2><p className="mt-1 text-sm text-slate-500">Secondary signals require a human decision.</p></div><span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-400">{loaded && !error ? duplicates.length : "—"} open</span></div><div className="mt-4 space-y-3">{duplicates.map(item => <div key={item.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-medium text-white">{item.leadAName} <span className="text-slate-600">↔</span> {item.leadBName}</p><p className="mt-1 text-xs text-slate-500">{item.ruleName} · {Math.round(item.confidence * 100)}% confidence</p></div></div>{canWrite && <div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} onClick={() => void resolve(item.id, "keep_a")} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">Keep A</button><button disabled={busy} onClick={() => void resolve(item.id, "keep_b")} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">Keep B</button><button disabled={busy} onClick={() => void resolve(item.id, "merge")} className="rounded bg-cyan-400 px-2 py-1 text-xs font-semibold text-slate-950 disabled:opacity-50">Merge</button><button disabled={busy} onClick={() => void resolve(item.id, "ignore")} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-500 disabled:opacity-50">Ignore</button></div>}</div>)}{loading && !loaded && <p role="status" className="py-8 text-center text-sm text-slate-500">Loading duplicate candidates…</p>}{loaded && !error && !duplicates.length && <p className="py-8 text-center text-sm text-slate-500">No open duplicate candidates.</p>}</div></article>
        <article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-white">Discovery ledger</h2><p className="mt-1 text-sm text-slate-500">Every search is recorded, including failures.</p><div className="mt-4 space-y-3">{history.map(item => <div key={item.id} className="border-b border-slate-800 pb-3"><div className="flex justify-between gap-3"><b className="text-sm text-white">{item.query}</b><span className="text-xs text-slate-600">{new Date(item.createdAt).toLocaleString()}</span></div><p className="mt-1 text-xs text-slate-400">{item.provider} · {item.resultsReturned} results · {item.newLeadsCreated} new · {item.duplicatesDetected} duplicate signals{item.errors ? " · failed" : ""}</p></div>)}{loading && !loaded && <p role="status" className="py-8 text-center text-sm text-slate-500">Loading discovery history…</p>}{loaded && !error && !history.length && <p className="py-8 text-center text-sm text-slate-500">No searches recorded yet.</p>}</div></article>
      </section>
    </>}
  </main></>;
}
