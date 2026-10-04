<?php
defined('BASEPATH') or exit('No direct script access allowed');
/**
 * Lead Discovery workspace (Scout).
 *
 * This page used to demand a second, disconnected sign-in even when the
 * visitor already held a platform session — its "Sign in" button looked
 * broken. It now bootstraps from the existing session (/api/auth/me) and
 * only shows the credential form when the visitor is genuinely anonymous.
 *
 * @var bool $pipeline  true when rendering the /lead-pipeline variant
 */
if (!function_exists('e')) {
    function e($value): string { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); }
}
$isPipeline = !empty($pipeline);
$pageTitle = $isPipeline ? 'Lead Pipeline' : 'Lead Discovery';
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= e($pageTitle) ?> · WINDELS AI WORKFORCE</title>
<meta name="robots" content="noindex,nofollow">
<link rel="icon" type="image/png" href="/assets/images/windels-mark.png">
<style>
  :root{
    --bg:#0a0e17; --panel:#0f1623; --panel2:#131c2c; --line:#1e2738; --line2:#2a3548;
    --text:#e7ecf4; --muted:#9aa7bd; --dim:#5e6b82; --brand:#2f6bff; --brand-soft:#2f6bff22;
    --red:#fb5d6b; --green:#22c55e;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif}
  a{color:var(--brand);text-decoration:none}
  a:hover{text-decoration:underline}

  /* top navigation — matches the platform dashboard chrome */
  header{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:12px 22px;border-bottom:1px solid var(--line);background:#0a0f1a;position:sticky;top:0;z-index:10}
  .brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:800;font-size:14px;letter-spacing:.04em}
  .brand img{width:28px;height:28px;border-radius:8px;object-fit:cover}
  .brand small{display:block;font-weight:600;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
  nav{display:flex;gap:4px;flex-wrap:wrap}
  nav a{padding:7px 12px;border-radius:8px;color:var(--muted);font-weight:600;font-size:13px}
  nav a:hover{background:var(--panel2);color:#fff;text-decoration:none}
  nav a.active{background:var(--brand-soft);color:#fff}
  .who{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px}
  .who .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line2);background:var(--panel2);border-radius:999px;padding:4px 12px;color:var(--muted);font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.06em}

  .wrap{max-width:1280px;margin:24px auto;padding:0 22px}
  h1{font-size:20px;margin:0 0 4px;color:#fff}
  .sub{color:var(--muted);font-size:13px;margin:0 0 16px}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:16px}
  .card h2{margin:0 0 10px;font-size:13px;color:#fff;letter-spacing:.04em}
  .search{display:flex;flex-wrap:wrap;gap:10px;background:var(--panel);padding:14px;border:1px solid var(--line);border-radius:12px}
  .search input{flex:1;min-width:220px}
  input,select{border-radius:8px;border:1px solid var(--line2);padding:10px 12px;background:#0b1119;color:var(--text);font:inherit;font-size:13.5px}
  input:focus,select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  button{border-radius:8px;border:1px solid var(--brand);background:var(--brand);color:#fff;font:inherit;font-size:12.5px;font-weight:700;padding:10px 14px;cursor:pointer}
  button:hover{background:#1f5ae0;border-color:#1f5ae0}
  button.ghost{background:var(--panel2);border-color:var(--line2);color:var(--text)}
  button.ghost:hover{border-color:var(--brand);color:#fff;background:var(--panel2)}
  .muted{color:var(--muted);font-size:12.5px}
  .error{color:var(--red);font-size:12.5px;min-height:1.2em;margin:8px 0 0}

  #loginBox{max-width:440px;margin:9vh auto}
  #loginBox form{display:grid;gap:12px;margin-top:14px}
  #loginBox .actions{display:flex;align-items:center;gap:12px}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid #ffffff59;border-top-color:#fff;border-radius:50%;animation:ldspin .7s linear infinite;vertical-align:-2px}
  @keyframes ldspin{to{transform:rotate(360deg)}}

  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
  .stat{padding:14px 16px;background:var(--panel);border:1px solid var(--line);border-radius:10px;min-width:140px}
  .stat b{font-size:21px;display:block;color:#fff;margin-top:2px;font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12.5px}
  th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px;vertical-align:top}
  th{color:var(--dim);font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  tbody tr:hover{background:#0e1622}
  td select{padding:6px 8px;font-size:12px}
  .hidden{display:none !important}
  .board{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:12px;overflow:auto;padding-bottom:6px}
  .column{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px;min-height:280px}
  .column h3{margin:2px 0 8px;text-transform:uppercase;font-size:11px;color:var(--muted);letter-spacing:.08em}
  .leadCard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:11px;margin:8px 0}
  .leadCard b{color:#fff;font-size:12.5px}
  .leadCard p{margin:5px 0;color:var(--muted);font-size:12px}
  .leadCard button{font-size:11px;padding:6px 10px;margin:6px 4px 0 0}
  pre{background:#05070b;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:11px;overflow:auto;max-height:340px;color:#94a3b8}
</style>
</head>
<body>
<header>
  <a class="brand" href="/dashboard">
    <img src="/assets/images/windels-mark.png" alt="WINDELS AI WORKFORCE" onerror="this.onerror=null;this.src='/assets/images/aegis-mark.png'">
    <span>WINDELS<small>AI Workforce</small></span>
  </a>
  <nav aria-label="Lead workspace">
    <a href="/dashboard">← Dashboard</a>
    <a href="/leads" class="<?= $isPipeline ? '' : 'active' ?>">Discovery</a>
    <a href="/lead-pipeline" class="<?= $isPipeline ? 'active' : '' ?>">Pipeline</a>
  </nav>
  <div class="who">
    <span class="chip">Secure workspace</span>
    <span id="who">checking session…</span>
    <button type="button" class="ghost" id="signOutBtn" hidden>Sign out</button>
  </div>
</header>

<main class="wrap">
  <h1><?= e($pageTitle) ?></h1>
  <p class="sub"><?= $isPipeline ? 'Move stored leads through stages, assign an owner and review live counts.' : 'Search live businesses, store them, then organize collections. No synthetic companies.' ?></p>

  <!-- Shown only when the visitor has no platform session -->
  <section id="loginBox" class="card hidden">
    <h2>Sign in to your workspace</h2>
    <p class="muted">Lead data is isolated to your authenticated workspace. Use the same email and password as your platform account.</p>
    <form id="loginForm" novalidate>
      <input id="email" placeholder="Email address" type="email" autocomplete="username" required>
      <input id="password" placeholder="Password" type="password" autocomplete="current-password" required>
      <div class="actions">
        <button type="submit" id="loginBtn">Sign in</button>
        <a href="/login">Platform sign-in page →</a>
      </div>
    </form>
    <p id="loginErr" class="error" role="alert"></p>
  </section>

  <section id="app" class="hidden">
    <div class="search">
      <input id="query" value="Restaurants in Lagos" aria-label="Business search">
      <select id="provider" aria-label="Provider">
        <option value="google_places">Google Places · IMPLEMENTED</option>
      </select>
      <button type="button" id="searchBtn">Search businesses</button>
      <button type="button" class="ghost" id="exportBtn">Export CSV</button>
    </div>
    <p id="message" class="muted">Search uses live Google Places results only. No synthetic businesses are shown.</p>

    <div class="stats">
      <div class="stat"><span class="muted">Stored leads</span><b id="count">—</b></div>
      <div class="stat"><span class="muted">Phone coverage</span><b id="phone">—</b></div>
      <div class="stat"><span class="muted">Website coverage</span><b id="site">—</b></div>
    </div>

    <div class="card">
      <h2>Collections</h2>
      <div class="search" style="padding:0;border:0;background:transparent">
        <input id="collectionName" placeholder="New collection name">
        <button type="button" id="createCollectionBtn">Create</button>
        <select id="collectionSelect" aria-label="Collection"></select>
        <button type="button" class="ghost" id="addSelectedBtn">Add selected leads</button>
      </div>
      <p id="collectionInfo" class="muted">Create a collection, select lead rows, then add them in bulk.</p>
    </div>

    <div class="card" id="resultsCard">
      <h2>Lead results</h2>
      <div id="empty" class="muted">Your saved business leads will appear here.</div>
      <table id="table" class="hidden">
        <thead>
          <tr>
            <th><input type="checkbox" id="selectAllBox" aria-label="Select all"></th>
            <th>Business</th><th>Category</th><th>Address</th><th>Contact</th><th>Pipeline</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <div id="pipelineWorkspace" class="card hidden">
      <h2>Pipeline board</h2>
      <p class="muted">Move leads between stages, assign the current owner, and review live stage counts.</p>
      <div id="board" class="board"></div>
    </div>

    <div id="intelligenceWorkspace" class="card hidden">
      <h2>Data quality &amp; discovery ledger</h2>
      <div class="search" style="padding:0;border:0;background:transparent">
        <select id="missingField" aria-label="Missing field">
          <option value="phone">Missing phone</option>
          <option value="website">Missing website</option>
          <option value="address">Missing address</option>
          <option value="category">Missing category</option>
        </select>
        <button type="button" class="ghost" id="missingBtn">Review missing data</button>
        <button type="button" class="ghost" id="historyBtn">Search history</button>
        <button type="button" class="ghost" id="duplicatesBtn">Duplicate review</button>
        <button type="button" class="ghost" id="previewBtn">Export preview</button>
      </div>
      <div id="intelligenceOutput" class="muted" style="margin-top:12px">Choose a quality or ledger review action.</div>
    </div>
  </section>
</main>

<script>
(function () {
  'use strict';
  const isPipeline = <?= $isPipeline ? 'true' : 'false' ?>;
  const api = '/api/v1/lead-discovery';
  let currentUserId = null;
  let csrf = '';

  const $ = (id) => document.getElementById(id);
  const who = $('who'), loginBox = $('loginBox'), app = $('app'), message = $('message');

  function escapeHtml(v) {
    const d = document.createElement('div');
    d.textContent = v == null ? '' : String(v);
    return d.innerHTML;
  }

  async function request(path, opt = {}) {
    const r = await fetch(api + path, {
      ...opt,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(opt.headers || {}) },
    });
    const type = r.headers.get('content-type') || '';
    const d = type.includes('json') ? await r.json() : await r.blob();
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  function enterWorkspace(user, csrfToken) {
    csrf = csrfToken || '';
    currentUserId = user.id;
    who.textContent = user.email;
    $('signOutBtn').hidden = false;
    loginBox.classList.add('hidden');
    app.classList.remove('hidden');
    load();
  }

  function showLogin() {
    who.textContent = 'not signed in';
    app.classList.add('hidden');
    $('signOutBtn').hidden = true;
    loginBox.classList.remove('hidden');
  }

  // Reuse the platform session instead of forcing a second sign-in.
  async function boot() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) { showLogin(); return; }
      enterWorkspace(d.user, d.csrfToken);
    } catch (e) {
      showLogin();
    }
  }

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('loginBtn');
    const err = $('loginErr');
    err.textContent = '';
    if (!$('email').value.trim() || !$('password').value) {
      err.textContent = 'Enter your email address and password.';
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Signing in…';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Sign in failed');
      enterWorkspace(d.user, d.csrfToken);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('signOutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    } catch (_) {}
    window.location.assign('/login');
  });

  async function load() {
    try {
      const d = await request('/leads');
      render(d.leads);
      const c = await request('/coverage');
      $('count').textContent = c.leadCount;
      $('phone').textContent = (c.fields.find((x) => x.field === 'Phone') || {}).coverage + '%';
      $('site').textContent = (c.fields.find((x) => x.field === 'Website') || {}).coverage + '%';
      const collections = await request('/collections');
      $('collectionSelect').innerHTML = collections.collections.length
        ? collections.collections.map((x) => `<option value="${x.id}">${escapeHtml(x.name)} (${x.leadCount})</option>`).join('')
        : '<option value="">No collections yet</option>';
      if (isPipeline) {
        $('pipelineWorkspace').classList.remove('hidden');
        $('intelligenceWorkspace').classList.remove('hidden');
        $('resultsCard').classList.add('hidden');
        await loadPipeline();
      }
    } catch (e) {
      message.textContent = e.message;
    }
  }

  function render(leads) {
    $('empty').classList.toggle('hidden', leads.length);
    $('table').classList.toggle('hidden', !leads.length);
    $('rows').innerHTML = leads.map((x) => `<tr>
      <td><input class="leadSelect" type="checkbox" value="${x.id}"></td>
      <td><b>${escapeHtml(x.name)}</b><br><small class="muted">${escapeHtml(x.source)}</small></td>
      <td>${escapeHtml(x.category || '—')}</td>
      <td>${escapeHtml(x.address || '—')}</td>
      <td>${escapeHtml(x.phone || '—')}<br>${x.website ? `<a href="${escapeHtml(x.website)}" target="_blank" rel="noopener">Website</a>` : '—'}</td>
      <td><select onchange="window.scoutStatus('${x.id}', this.value)">
        ${['new', 'contacted', 'qualified', 'disqualified', 'converted'].map((s) => `<option ${x.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></td>
    </tr>`).join('');
  }

  window.scoutStatus = async function (id, v) {
    try {
      await request('/leads/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status: v }) });
      if (isPipeline) loadPipeline();
    } catch (e) {
      message.textContent = e.message;
      load();
    }
  };

  $('searchBtn').addEventListener('click', async () => {
    message.textContent = 'Searching Google Places…';
    try {
      const d = await request('/search', { method: 'POST', body: JSON.stringify({ query: $('query').value, provider: $('provider').value }) });
      message.textContent = `${d.results.length} live results · ${d.newLeadsCreated} new · ${d.duplicatesDetected} existing records refreshed`;
      await load();
    } catch (e) {
      message.textContent = e.message;
    }
  });

  $('missingBtn').addEventListener('click', async () => {
    const sel = $('missingField');
    try {
      const d = await request('/coverage?missing=' + sel.value);
      $('intelligenceOutput').innerHTML = `<h3>${escapeHtml(sel.options[sel.selectedIndex].text)} · ${d.missingLeads.length}</h3>`
        + (d.missingLeads.map((x) => `<p><b>${escapeHtml(x.name)}</b> <span class="muted">${escapeHtml(x.address || 'No address')}</span></p>`).join('')
          || '<p>All stored leads have this field.</p>');
    } catch (e) { $('intelligenceOutput').textContent = e.message; }
  });

  $('historyBtn').addEventListener('click', async () => {
    try {
      const d = await request('/history');
      $('intelligenceOutput').innerHTML = '<h3>Recent searches</h3>'
        + (d.history.map((x) => `<p><b>${escapeHtml(x.query)}</b> · ${x.results_returned} results · ${x.new_leads_created} new · ${escapeHtml(x.created_at)}</p>`).join('')
          || '<p>No searches recorded yet.</p>');
    } catch (e) { $('intelligenceOutput').textContent = e.message; }
  });

  $('duplicatesBtn').addEventListener('click', showDuplicates);
  async function showDuplicates() {
    try {
      const d = await request('/duplicates');
      $('intelligenceOutput').innerHTML = '<h3>Open duplicate candidates</h3>'
        + (d.duplicates.map((x) => `<p><b>${escapeHtml(x.leadAName)}</b> ↔ <b>${escapeHtml(x.leadBName)}</b> · ${escapeHtml(x.rule_name)} (${Math.round(x.confidence * 100)}%)
            <button type="button" onclick="window.scoutResolveDuplicate('${x.id}','merge')">Merge</button>
            <button type="button" class="ghost" onclick="window.scoutResolveDuplicate('${x.id}','ignore')">Ignore</button></p>`).join('')
          || '<p>No open duplicate candidates.</p>');
    } catch (e) { $('intelligenceOutput').textContent = e.message; }
  }

  window.scoutResolveDuplicate = async function (candidateId, action) {
    try {
      await request('/duplicates/resolve', { method: 'POST', body: JSON.stringify({ candidateId, action }) });
      showDuplicates();
      loadPipeline();
    } catch (e) { $('intelligenceOutput').textContent = e.message; }
  };

  $('previewBtn').addEventListener('click', async () => {
    try {
      const d = await request('/export/preview', { method: 'POST', body: JSON.stringify({}) });
      $('intelligenceOutput').innerHTML = `<h3>CSV-safe export preview · ${d.count} leads</h3><pre>${escapeHtml(JSON.stringify(d.rows, null, 2))}</pre>`;
    } catch (e) { $('intelligenceOutput').textContent = e.message; }
  });

  async function loadPipeline() {
    const d = await request('/pipeline');
    $('board').innerHTML = d.statuses.map((status) => `<div class="column">
      <h3>${status} · ${d.columns[status].length}</h3>
      ${d.columns[status].map((x) => `<article class="leadCard">
        <b>${escapeHtml(x.name)}</b>
        <p>${escapeHtml(x.category || 'Uncategorized')}</p>
        <select onchange="window.scoutStatus('${x.id}', this.value)">
          ${d.statuses.map((s) => `<option ${x.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select><br>
        <button type="button" class="ghost" onclick="window.scoutAssignMe('${x.id}')">${x.owner_id ? 'Reassign to me' : 'Assign to me'}</button>
        <button type="button" class="ghost" onclick="window.scoutLeadNotes('${x.id}')">Notes</button>
      </article>`).join('') || '<p class="muted">No leads</p>'}
    </div>`).join('');
  }

  window.scoutAssignMe = async function (id) {
    try {
      await request('/leads/' + id + '/owner', { method: 'PATCH', body: JSON.stringify({ ownerId: currentUserId }) });
      loadPipeline();
    } catch (e) { message.textContent = e.message; }
  };

  window.scoutLeadNotes = async function (id) {
    try {
      const d = await request('/leads/' + id + '/notes');
      const body = prompt('Notes:\n' + d.notes.map((n) => n.body).join('\n—\n') + '\n\nEnter a new note (optional):');
      if (body && body.trim()) {
        await request('/leads/' + id + '/notes', { method: 'POST', body: JSON.stringify({ body }) });
        loadPipeline();
      }
    } catch (e) { message.textContent = e.message; }
  };

  $('selectAllBox').addEventListener('change', (ev) => {
    document.querySelectorAll('.leadSelect').forEach((x) => { x.checked = ev.target.checked; });
  });

  $('createCollectionBtn').addEventListener('click', async () => {
    const name = $('collectionName').value.trim();
    if (!name) { $('collectionInfo').textContent = 'Enter a collection name.'; return; }
    try {
      await request('/collections', { method: 'POST', body: JSON.stringify({ name }) });
      $('collectionName').value = '';
      $('collectionInfo').textContent = 'Collection created.';
      load();
    } catch (e) { $('collectionInfo').textContent = e.message; }
  });

  $('addSelectedBtn').addEventListener('click', async () => {
    const id = $('collectionSelect').value;
    const leadIds = [...document.querySelectorAll('.leadSelect:checked')].map((x) => x.value);
    if (!id) { $('collectionInfo').textContent = 'Create or select a collection.'; return; }
    if (!leadIds.length) { $('collectionInfo').textContent = 'Select at least one lead.'; return; }
    try {
      const r = await request('/collections/' + id + '/leads', { method: 'POST', body: JSON.stringify({ leadIds }) });
      $('collectionInfo').textContent = `${r.added} lead(s) added to the collection.`;
      document.querySelectorAll('.leadSelect').forEach((x) => { x.checked = false; });
      load();
    } catch (e) { $('collectionInfo').textContent = e.message; }
  });

  $('exportBtn').addEventListener('click', async () => {
    try {
      const r = await fetch(api + '/export/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: '{}',
      });
      if (!r.ok) throw new Error('Export failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = 'leads.csv';
      a.click();
    } catch (e) { message.textContent = e.message; }
  });

  boot();
})();
</script>
</body>
</html>
