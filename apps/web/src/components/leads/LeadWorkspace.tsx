"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Lead, LeadStatus } from "../../../../../packages/shared/src/leadDiscovery";
import { authApi, collectionsApi, intelligenceApi, leadApi, leadDiscoveryApi, leadPipelineApi, membersApi, type CollectionSummary, type LeadDetails, type OrganizationMember, type ProviderOption } from "../../lib/leadDiscovery";
import { getAccessToken } from "../../lib/session";
import { Navigation } from "../layout/Navigation";

const statuses: LeadStatus[] = ["new", "contacted", "qualified", "disqualified", "converted"];
const statusLabel: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", qualified: "Qualified", disqualified: "Disqualified", converted: "Converted" };
const statusTone: Record<LeadStatus, string> = { new: "border-slate-700 bg-slate-800 text-slate-200", contacted: "border-blue-900/70 bg-blue-950/50 text-blue-200", qualified: "border-emerald-900/70 bg-emerald-950/50 text-emerald-200", disqualified: "border-red-900/70 bg-red-950/50 text-red-200", converted: "border-violet-900/70 bg-violet-950/50 text-violet-200" };

export function LeadWorkspace({ mode }: { mode: "discovery" | "pipeline" }) {
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("Restaurants in Lagos");
  const [category, setCategory] = useState("");
  const [country, setCountry] = useState("");
  const [provider, setProvider] = useState("google_places");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [columns, setColumns] = useState<Record<LeadStatus, Lead[]> | null>(null);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collectionId, setCollectionId] = useState("");
  const [detail, setDetail] = useState<LeadDetails | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [owner, setOwner] = useState("");
  const [view, setView] = useState<"table" | "kanban">(mode === "pipeline" ? "kanban" : "table");
  const [busy, setBusy] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [authChecked, setAuthChecked] = useState(false);
  const [authValidated, setAuthValidated] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
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
    setBusy(true); setError("");
    try {
      const [providerResult, collectionResult] = await Promise.all([leadDiscoveryApi.providers(token), collectionsApi.list(token)]);
      const leadResult = mode === "pipeline" ? null : await leadApi.list(token);
      const pipelineResult = mode === "pipeline" ? await leadPipelineApi.pipeline(token) : null;
      setProviders(providerResult.providers);
      setCollections(collectionResult.collections);
      if (providerResult.providers.length && !providerResult.providers.some(item => item.name === provider)) setProvider(providerResult.providers[0]!.name);
      if (pipelineResult) setColumns(pipelineResult.columns);
      if (leadResult) setLeads(leadResult.leads);
      setDataLoaded(true);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Unable to load the workspace");
    } finally { setBusy(false); }
  };
  useEffect(() => { if (token && authChecked && canRead) void load(); }, [token, mode, authChecked, canRead]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) { setError("Sign in before searching for businesses."); return; }
    if (!canWrite) { setError("Searching for businesses requires lead.write permission."); return; }
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setSelected(new Set());
    try {
      const result = await leadDiscoveryApi.search({ query, provider, limit: 20, ...(category ? { category } : {}), ...(country ? { country } : {}) }, token);
      setLeads(result.results);
      setNotice(`${result.results.length} businesses returned · ${result.newLeadsCreated} new leads · ${result.duplicatesDetected} duplicate signals`);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Search failed"); }
    finally { setBusy(false); }
  };

  const updateStatus = async (lead: Lead, status: LeadStatus) => {
    if (!canWrite || busy || lead.status === status) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await leadApi.updateStatus(lead.id, status, token);
      setLeads(previous => previous.map(item => item.id === lead.id ? { ...item, status } : item));
      setColumns(previous => {
        if (!previous) return previous;
        const updatedLead = { ...lead, status };
        const next = Object.fromEntries(statuses.map(key => [key, previous[key].filter(item => item.id !== lead.id)])) as Record<LeadStatus, Lead[]>;
        next[status] = [...next[status], updatedLead];
        return next;
      });
      setDetail(previous => previous?.lead.id === lead.id ? { ...previous, lead: { ...previous.lead, status } } : previous);
      setNotice(`${lead.name} moved to ${statusLabel[status]}.`);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Status update failed"); }
    finally { setBusy(false); }
  };

  const openDetail = async (lead: Lead) => {
    if (detailLoading) return;
    setDetailLoading(true); setError(""); setNotice(""); setMembersError(""); setMembers([]);
    try {
      const result = await leadApi.detail(lead.id, token);
      setDetail(result); setOwner(result.lead.ownerId ?? ""); setNote("");
      setMembersLoading(true);
      try { setMembers((await membersApi.list(token)).members); }
      catch (exception) { setMembersError(exception instanceof Error ? exception.message : "Unable to load organization members"); }
      finally { setMembersLoading(false); }
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to load lead details"); }
    finally { setDetailLoading(false); }
  };

  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const visibleLeads = mode === "pipeline" ? Object.values(columns ?? {}).flat() : leads;
  const allSelected = visibleLeads.length > 0 && visibleLeads.every(lead => selected.has(lead.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleLeads.map(lead => lead.id)));

  const addToCollection = async () => {
    if (!canWrite || busy || !collectionId || !selected.size) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await collectionsApi.addLeads(collectionId, [...selected], token);
      setNotice(`${result.added} lead${result.added === 1 ? "" : "s"} added to the collection.`);
      setSelected(new Set());
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to add leads to collection"); }
    finally { setBusy(false); }
  };

  const exportCsv = async () => {
    if (!canWrite || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const blob = await intelligenceApi.exportCsv({}, token);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "leads.csv"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("CSV export created and recorded in the activity ledger.");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "CSV export failed"); }
    finally { setBusy(false); }
  };

  const saveOwner = async () => {
    if (!canWrite || busy || !detail) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await leadApi.updateOwner(detail.lead.id, owner || null, token);
      setDetail(previous => previous ? { ...previous, lead: { ...previous.lead, ownerId: owner || null } } : previous);
      setNotice("Lead ownership updated.");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Owner update failed"); }
    finally { setBusy(false); }
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || busy || !detail || !note.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await leadPipelineApi.addNote(detail.lead.id, note, token);
      setDetail(previous => previous ? { ...previous, notes: [saved, ...previous.notes] } : previous);
      setNote(""); setNotice("Note added to the lead activity history.");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "Unable to add note"); }
    finally { setBusy(false); }
  };

  const countLabel = dataLoaded ? `${visibleLeads.length} leads` : "— leads";
  return <>
    <Navigation />
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[.24em] text-cyan-400">WINDELS AI WORKFORCE / Lead Intelligence</p><h1 className="mt-2 text-3xl font-bold text-white">{mode === "pipeline" ? "Lead pipeline" : "Lead discovery"}</h1><p className="mt-2 max-w-2xl text-slate-400">Discover real businesses via WINDELS AI WORKFORCE, keep an auditable source record, and move qualified prospects through your pipeline. No public Admin Login — role checked server-side.</p></div>
        <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300">{countLabel}</span>{canRead && <button type="button" onClick={() => void load()} disabled={busy} className="rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>}{mode === "pipeline" && <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-1"><button type="button" onClick={() => setView("kanban")} aria-pressed={view === "kanban"} className={`rounded px-3 py-1 text-xs ${view === "kanban" ? "bg-cyan-400 text-slate-950" : "text-slate-400"}`}>Kanban</button><button type="button" onClick={() => setView("table")} aria-pressed={view === "table"} className={`rounded px-3 py-1 text-xs ${view === "table" ? "bg-cyan-400 text-slate-950" : "text-slate-400"}`}>Table</button></div>}</div>
      </header>

      {!authChecked && <p role="status" className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Checking your session…</p>}
      {authChecked && !token && <section className="mb-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100"><b>Sign in to use the live workspace.</b> <a className="ml-2 underline" href="/login">Open secure sign-in</a></section>}
      {authChecked && token && authFailed && <section className="mb-6 rounded-xl border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-100">Your session could not be verified. Check your connection or <a className="underline" href="/login">sign in again</a>.</section>}
      {authChecked && token && authValidated && !canRead && <section className="mb-6 rounded-xl border border-red-900/70 bg-red-950/30 p-4 text-sm text-red-200">Your account does not have lead workspace access. Ask an administrator for <code>lead.read</code> or <code>lead.write</code>.</section>}
      {canRead && !canWrite && <p className="mb-4 rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-100">Read-only access. Searching, editing, notes, collections and exports require <code>lead.write</code>.</p>}
      {mode === "discovery" && <form onSubmit={search} className="mb-5 rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_auto]"><label className="text-xs uppercase tracking-wide text-slate-400">Business search<input value={query} onChange={event => setQuery(event.target.value)} required minLength={3} maxLength={300} aria-label="Business query" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400" /></label><label className="text-xs uppercase tracking-wide text-slate-400">Category<input value={category} onChange={event => setCategory(event.target.value)} maxLength={120} placeholder="Restaurants" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" /></label><label className="text-xs uppercase tracking-wide text-slate-400">Country<input value={country} onChange={event => setCountry(event.target.value)} maxLength={120} placeholder="Nigeria" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" /></label><label className="text-xs uppercase tracking-wide text-slate-400">Provider<select value={provider} onChange={event => setProvider(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" disabled={!providers.length || busy}>{providers.length ? providers.map(item => <option key={item.name} value={item.name}>{item.name} · {item.health.status}</option>) : <option value="">Providers unavailable</option>}</select></label><button disabled={busy || !token || !canWrite} className="self-end rounded-lg bg-cyan-400 px-5 py-2.5 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Working…" : canWrite ? "Search businesses" : "Requires lead.write"}</button></div><p className="mt-3 text-xs text-slate-500">Results are saved to PostgreSQL and deduplicated by provider plus stable source ID. No synthetic businesses are used.</p></form>}

      {notice && <p role="status" className="mb-4 rounded-lg border border-emerald-900/70 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
      {canRead && busy && !dataLoaded && <p role="status" className="mb-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Loading organization data…</p>}
      {detailLoading && <p role="status" className="mb-4 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Loading lead details…</p>}

      {canRead && dataLoaded && canWrite && !!visibleLeads.length && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3"><label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={busy} aria-label="Select all visible leads" />Select all</label><span className="text-xs text-slate-500">{selected.size} selected</span><select value={collectionId} onChange={event => setCollectionId(event.target.value)} disabled={busy} aria-label="Target collection" className="ml-auto rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"><option value="">Add to collection…</option>{collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" onClick={() => void addToCollection()} disabled={busy || !collectionId || !selected.size} className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white disabled:opacity-40">{busy ? "Saving…" : "Add selected"}</button><button type="button" onClick={() => void exportCsv()} disabled={busy} className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50">Export CSV</button></div>}

      {canRead && dataLoaded && (mode === "pipeline" && view === "kanban"
        ? <Pipeline columns={columns} selected={selected} toggle={toggle} openDetail={openDetail} updateStatus={updateStatus} canWrite={canWrite} busy={busy} detailLoading={detailLoading} />
        : <LeadTable leads={visibleLeads} selected={selected} toggle={toggle} openDetail={openDetail} updateStatus={updateStatus} canWrite={canWrite} busy={busy} detailLoading={detailLoading} />)}
      {!busy && !error && canRead && dataLoaded && !visibleLeads.length && <section className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-14 text-center"><p className="text-lg font-semibold text-white">{mode === "discovery" ? "Search for businesses to start your lead list." : "No leads are in the pipeline yet."}</p><p className="mt-2 text-sm text-slate-500">{mode === "discovery" ? canWrite ? "Choose an active provider and search a city, category, or business type." : "A user with lead.write permission can search and save businesses." : "New discoveries will appear in the New column."}</p></section>}
    </main>
    {detail && <LeadDetail detail={detail} owner={owner} setOwner={setOwner} members={members} membersLoading={membersLoading} membersError={membersError} saveOwner={saveOwner} note={note} setNote={setNote} addNote={addNote} updateStatus={updateStatus} canWrite={canWrite} busy={busy} close={() => setDetail(null)} />}
  </>;
}

function LeadTable({ leads, selected, toggle, openDetail, updateStatus, canWrite, busy, detailLoading }: { leads: Lead[]; selected: Set<string>; toggle: (id: string) => void; openDetail: (lead: Lead) => void; updateStatus: (lead: Lead, status: LeadStatus) => void; canWrite: boolean; busy: boolean; detailLoading: boolean }) {
  return <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500"><tr>{canWrite && <th className="w-12 p-4"></th>}<th className="p-4">Business</th><th>Category</th><th>Location</th><th>Contact</th><th>Status</th></tr></thead><tbody>{leads.map(lead => <tr key={lead.id} className="border-b border-slate-800/70 transition hover:bg-slate-800/30">{canWrite && <td className="p-4"><input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} disabled={busy} aria-label={`Select ${lead.name}`} /></td>}<td className="p-4"><button type="button" disabled={detailLoading} onClick={() => void openDetail(lead)} className="text-left font-semibold text-white hover:text-cyan-300 disabled:opacity-60">{lead.name}<span className="mt-1 block max-w-xs truncate text-xs font-normal text-slate-500">{lead.address ?? "Address not supplied"}</span></button></td><td className="max-w-40 text-slate-300">{lead.category ?? "—"}</td><td className="text-slate-400">{[lead.city, lead.region, lead.country].filter(Boolean).join(", ") || "—"}</td><td className="text-slate-300">{lead.phone ?? lead.website ?? "—"}</td><td>{canWrite ? <select value={lead.status} disabled={busy} onChange={event => void updateStatus(lead, event.target.value as LeadStatus)} aria-label={`Status for ${lead.name}`} className={`rounded-full border px-2 py-1 text-xs disabled:opacity-50 ${statusTone[lead.status]}`}>{statuses.map(status => <option key={status} value={status}>{statusLabel[status]}</option>)}</select> : <span className={`rounded-full border px-2 py-1 text-xs ${statusTone[lead.status]}`}>{statusLabel[lead.status]}</span>}</td></tr>)}</tbody></table></section>;
}

function Pipeline({ columns, selected, toggle, openDetail, updateStatus, canWrite, busy, detailLoading }: { columns: Record<LeadStatus, Lead[]> | null; selected: Set<string>; toggle: (id: string) => void; openDetail: (lead: Lead) => void; updateStatus: (lead: Lead, status: LeadStatus) => void; canWrite: boolean; busy: boolean; detailLoading: boolean }) {
  return <section className="grid gap-4 overflow-x-auto lg:grid-cols-5">{statuses.map(status => <div key={status} className="min-h-72 min-w-56 rounded-xl border border-slate-800 bg-slate-900 p-3"><div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{statusLabel[status]}</h2><span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{columns ? columns[status].length : "—"}</span></div>{columns?.[status]?.map(lead => <article key={lead.id} className="mb-2 rounded-lg border border-slate-700 bg-slate-950 p-3"><div className="flex gap-2">{canWrite && <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} disabled={busy} aria-label={`Select ${lead.name}`} />}<button type="button" disabled={detailLoading} onClick={() => void openDetail(lead)} className="text-left text-sm font-semibold text-white hover:text-cyan-300 disabled:opacity-60">{lead.name}</button></div><p className="mt-2 line-clamp-2 text-xs text-slate-500">{lead.address ?? lead.category ?? "No address or category"}</p>{canWrite ? <select value={lead.status} disabled={busy} onChange={event => void updateStatus(lead, event.target.value as LeadStatus)} aria-label={`Status for ${lead.name}`} className={`mt-3 w-full rounded border px-2 py-1 text-xs disabled:opacity-50 ${statusTone[status]}`}>{statuses.map(next => <option key={next} value={next}>{statusLabel[next]}</option>)}</select> : <span className={`mt-3 inline-block rounded border px-2 py-1 text-xs ${statusTone[status]}`}>{statusLabel[status]}</span>}</article>)}</div>)}</section>;
}

function LeadDetail({ detail, owner, setOwner, members, membersLoading, membersError, saveOwner, note, setNote, addNote, updateStatus, canWrite, busy, close }: { detail: LeadDetails; owner: string; setOwner: (value: string) => void; members: OrganizationMember[]; membersLoading: boolean; membersError: string; saveOwner: () => void; note: string; setNote: (value: string) => void; addNote: (event: FormEvent) => void; updateStatus: (lead: Lead, status: LeadStatus) => void; canWrite: boolean; busy: boolean; close: () => void }) {
  const lead = detail.lead;
  const ownerMember = members.find(member => member.id === owner);
  const ownerDisplay = owner ? ownerMember?.displayName || `Member ${owner.slice(0, 8)}` : "Unassigned";
  const ownerMissingFromRoster = !!owner && !ownerMember;
  return <div className="fixed inset-0 z-20 flex justify-end bg-black/60" role="dialog" aria-modal="true" aria-labelledby="lead-detail-title" onClick={event => { if (event.target === event.currentTarget) close(); }}><aside className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-700 bg-slate-950 p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[.2em] text-cyan-400">{lead.source} · {lead.sourceId}</p><h2 id="lead-detail-title" className="mt-2 text-2xl font-bold text-white">{lead.name}</h2><p className="mt-2 text-sm text-slate-400">{lead.address ?? "Address not supplied"}</p></div><button type="button" onClick={close} className="rounded border border-slate-700 px-2 py-1 text-slate-400" aria-label="Close details">×</button></div><div className="mt-6 grid grid-cols-2 gap-3 text-sm"><Info label="Category" value={lead.category} /><Info label="Phone" value={lead.phone} /><Info label="Website" value={lead.website} /><Info label="Location" value={[lead.city, lead.region, lead.country].filter(Boolean).join(", ")} /></div><div className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4"><label htmlFor="lead-status" className="text-xs uppercase tracking-wide text-slate-500">Status</label>{canWrite ? <select id="lead-status" value={lead.status} disabled={busy} onChange={event => void updateStatus(lead, event.target.value as LeadStatus)} className={`mt-2 w-full rounded border px-3 py-2 disabled:opacity-50 ${statusTone[lead.status]}`}>{statuses.map(status => <option key={status} value={status}>{statusLabel[status]}</option>)}</select> : <p className={`mt-2 inline-block rounded border px-3 py-2 text-sm ${statusTone[lead.status]}`}>{statusLabel[lead.status]}</p>}<label htmlFor="lead-owner" className="mt-4 block text-xs uppercase tracking-wide text-slate-500">Owner</label>{canWrite ? <div className="mt-2 flex gap-2"><select id="lead-owner" value={owner} onChange={event => setOwner(event.target.value)} disabled={busy || membersLoading} className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"><option value="">Unassigned</option>{ownerMissingFromRoster && <option value={owner}>Current assignee · {owner.slice(0, 8)}</option>}{members.map(member => <option key={member.id} value={member.id}>{member.displayName?.trim() || "Unnamed member"} · {member.id.slice(0, 8)}{member.active ? "" : " · inactive"}</option>)}</select><button type="button" onClick={() => void saveOwner()} disabled={busy || membersLoading || (!members.length && !owner)} className="rounded bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button></div> : <p className="mt-2 break-all text-sm text-slate-300">{ownerDisplay}{owner && <span className="ml-2 text-xs text-slate-500">({owner})</span>}</p>}{membersLoading && <p role="status" className="mt-2 text-xs text-slate-500">Loading organization members…</p>}{membersError && <p role="alert" className="mt-2 text-xs text-red-300">Member list unavailable: {membersError}</p>}{canWrite && <p className="mt-2 text-xs text-slate-500">Member names and short IDs are loaded from this organization; inactive accounts are labelled.</p>}</div><section className="mt-6"><h3 className="font-semibold text-white">Notes</h3>{canWrite ? <form onSubmit={addNote} className="mt-3 flex gap-2"><label htmlFor="lead-note" className="sr-only">Add a sales note</label><textarea id="lead-note" value={note} onChange={event => setNote(event.target.value)} disabled={busy} placeholder="Add a sales note…" rows={2} className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" /><button disabled={busy || !note.trim()} className="self-end rounded bg-slate-700 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? "Saving…" : "Add"}</button></form> : <p className="mt-2 text-xs text-slate-500">Adding notes requires lead.write permission.</p>}<div className="mt-3 space-y-2">{detail.notes.map(item => <p key={item.id} className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">{item.body}<span className="mt-1 block text-xs text-slate-600">{new Date(item.createdAt).toLocaleString()}</span></p>)}{!detail.notes.length && <p className="text-sm text-slate-500">No notes yet.</p>}</div></section><section className="mt-6"><h3 className="font-semibold text-white">Activity</h3><div className="mt-3 space-y-2">{detail.activity.map(item => <div key={item.id} className="border-l border-cyan-800 pl-3 text-xs"><p className="font-semibold text-cyan-300">{item.type}</p><p className="mt-1 text-slate-500">{new Date(item.createdAt).toLocaleString()}</p></div>)}{!detail.activity.length && <p className="text-sm text-slate-500">No activity recorded.</p>}</div></section></aside></div>;
}

function Info({ label, value }: { label: string; value: string | null | undefined }) { return <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 break-words text-slate-200">{value || "—"}</p></div>; }
