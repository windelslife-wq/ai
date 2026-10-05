(() => {
  const root = document.querySelector('[data-lottery-console]');
  if (!root) return;

  const csrf = root.dataset.csrf ?? '';
  const message = document.getElementById('lottery-console-message');
  const buttons = Array.from(document.querySelectorAll('[data-lottery-action]'));
  const stateNode = document.querySelector('[data-health-state]');
  const historyBody = document.querySelector('[data-health-history]');
  const emptyHistory = document.querySelector('[data-health-empty]');
  const historyWrap = document.querySelector('[data-health-table-wrap]');
  const providerRegistryBody = document.querySelector('[data-provider-registry]');
  const providerRegistryEmpty = document.querySelector('[data-provider-registry-empty]');
  const providerRegistryWrap = document.querySelector('[data-provider-registry-wrap]');

  function showMessage(text, type = 'ok') {
    if (!message) return;
    message.textContent = text;
    message.className = `notice ${type === 'error' ? 'err' : type === 'warning' ? 'warnbox' : 'ok'}`;
    message.hidden = false;
  }

  function display(value, fallback = '—') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function cell(row, text, className = '') {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    row.append(td);
  }

  function stateClass(state) {
    if (state === 'ONLINE') return 'b-green';
    if (state === 'DEGRADED' || state === 'OFFLINE') return 'b-amber';
    return 'b-gray';
  }

  function renderHealth(report) {
    const live = report?.live ?? {};
    const latest = report?.latest ?? {};
    const state = display(live.state ?? latest.status, 'UNKNOWN').toUpperCase();
    if (stateNode) {
      stateNode.textContent = state;
      stateNode.classList.remove('b-green', 'b-amber', 'b-gray');
      stateNode.classList.add(stateClass(state));
    }
    const messageNode = document.querySelector('[data-provider-message]');
    if (messageNode) messageNode.textContent = display(live.message, 'No provider health message available.');
    const sourceNode = document.querySelector('[data-health-source]');
    if (sourceNode) sourceNode.textContent = live.synthetic ? 'Synthetic sandbox' : (live.licensed ? 'Authorized provider' : 'No live source confirmed');
    const licenseNode = document.querySelector('[data-health-license]');
    if (licenseNode) licenseNode.textContent = live.licenseConfigured || live.licensed ? 'Configured / confirmed' : 'Not confirmed';
    const observedNode = document.querySelector('[data-health-observed]');
    if (observedNode) observedNode.textContent = display(latest.observed_at ?? report.checkedAt, 'No persisted health check');
    const responseNode = document.querySelector('[data-health-response]');
    if (responseNode) responseNode.textContent = latest.response_ms !== undefined ? `${latest.response_ms} ms` : (report.responseMs !== undefined ? `${report.responseMs} ms` : '—');
    const drawNode = document.querySelector('[data-health-last-draw]');
    if (drawNode) drawNode.textContent = display(latest.last_draw_retrieved);
    const syntheticNode = document.querySelector('[data-health-synthetic]');
    if (syntheticNode) syntheticNode.textContent = live.synthetic || latest.synthetic ? 'Yes — simulation only' : 'No / not reported';

    if (historyBody && Array.isArray(report?.history)) {
      historyBody.replaceChildren();
      report.history.slice(0, 20).forEach((record) => {
        const row = document.createElement('tr');
        cell(row, display(record.observed_at), 'mono dim');
        const stateCell = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `badge ${stateClass(display(record.status, 'UNKNOWN').toUpperCase())}`;
        badge.textContent = display(record.status, 'UNKNOWN');
        stateCell.append(badge);
        row.append(stateCell);
        cell(row, record.response_ms !== undefined && record.response_ms !== null ? `${record.response_ms} ms` : '—');
        cell(row, display(record.records_received, '0'));
        cell(row, display(record.invalid_records, '0'));
        const labelCell = document.createElement('td');
        if (record.synthetic) {
          const badge = document.createElement('span');
          badge.className = 'badge b-amber';
          badge.textContent = 'SYNTHETIC';
          labelCell.append(badge);
        } else {
          labelCell.textContent = 'reported live / unavailable';
          labelCell.className = 'dim';
        }
        row.append(labelCell);
        historyBody.append(row);
      });
      const hasHistory = report.history.length > 0;
      if (historyWrap) historyWrap.hidden = !hasHistory;
      if (emptyHistory) emptyHistory.hidden = hasHistory;
    }
  }

  async function refreshHealth() {
    const response = await fetch('/api/lottery/health', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not refresh provider health.');
    renderHealth(data);
  }

  async function refreshProviderRegistry() {
    if (!providerRegistryBody) return;
    try {
      const response = await fetch('/api/lottery/providers', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.providers)) return;
      providerRegistryBody.replaceChildren();
      data.providers.forEach((provider) => {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const name = document.createElement('b');
        name.textContent = display(provider.display_name ?? provider.provider_code, 'Unknown');
        const code = document.createElement('span');
        code.className = 'mono dim';
        code.textContent = display(provider.provider_code);
        nameCell.append(name, document.createElement('br'), code);
        row.append(nameCell);
        cell(row, Number(provider.enabled) === 1 ? 'Enabled' : 'Not enabled');
        const dataCell = document.createElement('td');
        if (Number(provider.synthetic) === 1) {
          const badge = document.createElement('span');
          badge.className = 'badge b-amber';
          badge.textContent = 'SYNTHETIC';
          dataCell.append(badge);
        } else {
          dataCell.textContent = 'Non-synthetic';
        }
        row.append(dataCell);
        providerRegistryBody.append(row);
      });
      const hasProviders = data.providers.length > 0;
      if (providerRegistryWrap) providerRegistryWrap.hidden = !hasProviders;
      if (providerRegistryEmpty) providerRegistryEmpty.hidden = hasProviders;
    } catch (_) {
      // The provider registry is supplementary; keep current health feedback visible.
    }
  }

  async function runAction(button) {
    const endpoint = button.dataset.endpoint;
    const action = button.dataset.lotteryAction;
    button.disabled = true;
    buttons.forEach((item) => { item.disabled = true; });
    if (message) message.hidden = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(action === 'sync' ? { limit: 100 } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Action failed (${response.status}).`);

      if (action === 'health') {
        renderHealth(data);
        await refreshProviderRegistry();
        const state = data?.live?.state ?? 'UNKNOWN';
        showMessage(`Provider health check recorded: ${state}.`, state === 'ONLINE' ? 'ok' : 'warning');
      } else {
        const result = data.result ?? {};
        const status = display(result.status, 'UNKNOWN');
        if (status !== 'NO_PROVIDER') {
          try { await refreshHealth(); } catch (_) { /* keep the sync outcome visible */ }
        }
        await refreshProviderRegistry();
        const imported = Number(result.imported ?? 0);
        const failed = Number(result.failed ?? 0);
        const conflicts = Number(result.conflicts ?? 0);
        const text = status === 'NO_PROVIDER'
          ? 'Sync was not run: no online provider is configured. No draw data was added.'
          : `Sync ${status.toLowerCase()}: ${imported} imported, ${failed} rejected, ${conflicts} verified-data conflicts preserved.`;
        showMessage(text, status === 'OK' && failed === 0 && conflicts === 0 ? 'ok' : 'warning');
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Lottery operation failed.', 'error');
    } finally {
      buttons.forEach((item) => { item.disabled = false; });
    }
  }

  buttons.forEach((button) => button.addEventListener('click', () => runAction(button)));
})();
