"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Lead } from "../../../../../packages/shared/src/leadDiscovery";
import { authApi, collectionsApi, type CollectionSummary } from "../../lib/leadDiscovery";
import { getAccessToken } from "../../lib/session";
import { Navigation } from "../layout/Navigation";

export function CollectionsWorkspace() {
  const [token, setToken] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [active, setActive] = useState<CollectionSummary | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authValidated, setAuthValidated] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
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
    setLoading(true);
    setError("");
    try {
      setItems((await collectionsApi.list(token)).collections);
      setLoaded(true);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Unable to load collections");
    } finally { setLoading(false); }
  };
  useEffect(() => { if (authChecked && token && canRead) void load(); }, [token, authChecked, canRead]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!canWrite || !trimmed || mutating) return;
    setMutating(true); setError(""); setNotice("");
    try {
      await collectionsApi.create(trimmed, token);
      setName(""); setNotice("Collection created.");
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to create collection"); }
    finally { setMutating(false); }
  };

  const open = async (item: CollectionSummary) => {
    if (openingId) return;
    setActive(item); setLeads([]); setError(""); setNotice(""); setOpeningId(item.id);
    try { setLeads((await collectionsApi.leads(item.id, token)).leads); }
    catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to load collection leads"); }
    finally { setOpeningId(null); }
  };

  const remove = async (item: CollectionSummary) => {
    if (!canWrite || mutating || !window.confirm(`Delete ${item.name}? Leads will not be deleted.`)) return;
    setMutating(true); setError(""); setNotice("");
    try {
      await collectionsApi.remove(item.id, token);
      if (active?.id === item.id) { setActive(null); setLeads([]); }
      setNotice("Collection deleted; source leads were retained.");
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to delete collection"); }
    finally { setMutating(false); }
  };

  const rename = async (item: CollectionSummary) => {
    if (!canWrite || mutating) return;
    const next = window.prompt("Collection name", item.name)?.trim();
    if (!next || next === item.name) return;
    if (next.length > 150) { setError("Collection names must be 150 characters or fewer."); return; }
    setMutating(true); setError(""); setNotice("");
    try {
      await collectionsApi.update(item.id, next, token);
      if (active?.id === item.id) setActive({ ...active, name: next });
      setNotice("Collection renamed.");
      await load();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to rename collection"); }
    finally { setMutating(false); }
  };

  const removeLead = async (lead: Lead) => {
    if (!canWrite || !active || mutating) return;
    setMutating(true); setError(""); setNotice("");
    try {
      await collectionsApi.removeLead(active.id, lead.id, token);
      setLeads(previous => previous.filter(item => item.id !== lead.id));
      setItems(previous => previous.map(item => item.id === active.id ? { ...item, leadCount: Math.max(0, item.leadCount - 1) } : item));
      setNotice("Lead removed from collection.");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to remove lead"); }
    finally { setMutating(false); }
  };

  return <><Navigation /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
    <header><p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">Organize</p><h1 className="mt-2 text-3xl font-bold text-white">Lead collections</h1><p className="mt-2 text-slate-400">Group the same source lead into multiple campaigns without duplicating its record.</p></header>
    {!authChecked && <p role="status" className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Checking your session…</p>}
    {authChecked && !token && <p className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100">Sign in from <a className="underline" href="/login">the secure login</a> to manage collections.</p>}
    {authChecked && token && authFailed && <p className="mt-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100">Your session could not be verified. Check your connection or <a className="underline" href="/login">sign in again</a>.</p>}
    {authChecked && token && authValidated && !canRead && <p className="mt-6 rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">Your account does not have lead workspace access. Ask an administrator for <code>lead.read</code> or <code>lead.write</code>.</p>}
    {canRead && !canWrite && <p className="mt-5 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-100">Read-only access. Creating, renaming, deleting and editing collection membership requires <code>lead.write</code>.</p>}
    {notice && <p role="status" className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
    {error && <p role="alert" className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
    {canRead && <div className="mt-5 flex justify-end"><button type="button" onClick={() => void load()} disabled={loading || mutating} className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh collections"}</button></div>}
    {canWrite && <section className="mt-7 rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-white">Create a collection</h2><form onSubmit={create} className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={name} onChange={event => setName(event.target.value)} required maxLength={150} placeholder="e.g. Lagos Restaurants" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white" /><button disabled={!token || mutating || !name.trim()} className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">{mutating ? "Saving…" : "Create collection"}</button></form></section>}
    {canRead && <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
      <section className="space-y-3" aria-busy={loading}>
        {loading && <p role="status" className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Loading collections…</p>}
        {items.map(item => <article key={item.id} className={`rounded-xl border p-4 ${active?.id === item.id ? "border-cyan-600 bg-cyan-950/20" : "border-slate-800 bg-slate-900"}`}><button type="button" onClick={() => void open(item)} disabled={openingId !== null} aria-pressed={active?.id === item.id} className="w-full text-left disabled:opacity-60"><h2 className="font-semibold text-white">{item.name}</h2><p className="mt-1 text-sm text-slate-400">{item.leadCount} lead{item.leadCount === 1 ? "" : "s"}</p></button>{canWrite && <div className="mt-3 flex gap-2"><button disabled={mutating || openingId !== null} onClick={() => void rename(item)} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">Rename</button><button disabled={mutating || openingId !== null} onClick={() => void remove(item)} className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 disabled:opacity-50">Delete</button></div>}</article>)}
        {!loading && !error && loaded && !items.length && <p className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500">No collections yet. Create one above, then add selected leads from Discover.</p>}
      </section>
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-busy={openingId !== null}><h2 className="font-semibold text-white">{active ? active.name : "Select a collection"}</h2>{active ? <div className="mt-4 space-y-2">{leads.map(lead => <div key={lead.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 p-3"><div><p className="font-medium text-white">{lead.name}</p><p className="mt-1 text-xs text-slate-500">{lead.address ?? lead.category ?? "No address"}</p></div>{canWrite && <button disabled={mutating} onClick={() => void removeLead(lead)} className="text-xs text-red-300 disabled:opacity-50">Remove</button>}</div>)}{!leads.length && <p role={openingId === active.id ? "status" : undefined} className="py-8 text-center text-sm text-slate-500">{openingId === active.id ? "Loading collection leads…" : error ? "Unable to load collection leads." : "This collection has no leads yet."}</p>}</div> : <p className="mt-4 text-sm text-slate-500">Choose a collection to inspect its leads.</p>}</section>
    </div>}
  </main></>;
}
