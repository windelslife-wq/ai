(() => {
  const form = document.getElementById('portfolio-optimizer-form');
  if (!form) return;

  const assetsRoot = document.getElementById('portfolio-assets');
  const addButton = document.getElementById('portfolio-add-asset');
  const submitButton = document.getElementById('portfolio-submit');
  const csrfToken = document.getElementById('portfolio-csrf')?.value ?? '';
  const errorBox = document.getElementById('portfolio-error');
  const resultSection = document.getElementById('portfolio-result');
  const classes = [
    ['crypto', 'Crypto'], ['forex', 'Forex'], ['commodity', 'Commodity'],
    ['stock', 'Stock'], ['etf', 'ETF'], ['futures', 'Futures'],
    ['options', 'Options'], ['indices', 'Indices'], ['bonds', 'Bonds'],
  ];

  function rows() {
    return Array.from(assetsRoot.querySelectorAll('.portfolio-asset-row'));
  }

  function updateRowControls() {
    const allRows = rows();
    allRows.forEach((row) => {
      const remove = row.querySelector('.portfolio-remove-asset');
      if (remove) remove.disabled = allRows.length <= 2;
    });
    addButton.disabled = allRows.length >= 12;
  }

  function makeRow() {
    const row = document.createElement('div');
    row.className = 'portfolio-asset-row';

    const symbolLabel = document.createElement('label');
    symbolLabel.append(document.createTextNode('Symbol'));
    const symbol = document.createElement('input');
    symbol.name = 'symbol';
    symbol.maxLength = 64;
    symbol.required = true;
    symbol.autocomplete = 'off';
    symbol.placeholder = 'e.g. BTCUSDT';
    symbolLabel.append(symbol);

    const classLabel = document.createElement('label');
    classLabel.append(document.createTextNode('Market class'));
    const select = document.createElement('select');
    select.name = 'marketClass';
    classes.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    classLabel.append(select);

    const remove = document.createElement('button');
    remove.className = 'btn small ghost portfolio-remove-asset';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove asset');

    row.append(symbolLabel, classLabel, remove);
    return row;
  }

  function clearTable(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function cell(row, value, className = '') {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = value;
    row.append(td);
  }

  function percent(value) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—';
  }

  function fixed(value, decimals = 3) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(decimals) : '—';
  }

  function render(report) {
    const selected = report.allocations.selected;
    const synthetic = (report.dataProvenance ?? []).some((source) => source.synthetic);
    const badge = document.getElementById('portfolio-simulation-badge');
    badge.hidden = !synthetic;

    const summary = document.getElementById('portfolio-summary');
    clearTable(summary);
    const summaryText = document.createElement('p');
    summaryText.className = 'dim';
    summaryText.textContent = `${report.status} · ${report.objective.replaceAll('_', ' ')} · ${report.window.returnObservations} aligned ${report.window.timeframe} return observations · ${report.window.periodsPerYear} periods/year · as of ${report.computedAt}`;
    summary.append(summaryText);
    const note = document.createElement('p');
    note.textContent = report.disclaimer;
    note.className = 'portfolio-disclaimer';
    summary.append(note);

    const warnings = document.getElementById('portfolio-warnings');
    clearTable(warnings);
    (report.warnings ?? []).forEach((warning) => {
      const item = document.createElement('div');
      item.className = 'notice warnbox';
      item.textContent = warning;
      warnings.append(item);
    });

    const provenance = new Map((report.dataProvenance ?? []).map((source) => [source.symbol, source]));
    const assetBody = document.getElementById('portfolio-assets-result');
    clearTable(assetBody);
    (report.assets ?? []).forEach((asset) => {
      const row = document.createElement('tr');
      cell(row, asset.symbol, 'mono');
      cell(row, percent(asset.selectedWeight));
      cell(row, percent(asset.expectedReturnAnnualized));
      cell(row, percent(asset.volatilityAnnualized));
      const source = provenance.get(asset.symbol);
      cell(row, source ? `${source.source}${source.synthetic ? ' · SIMULATION' : ''}${source.stale ? ' · STALE' : ''}` : 'unknown', 'dim');
      assetBody.append(row);
    });

    const comparisonBody = document.getElementById('portfolio-comparisons');
    clearTable(comparisonBody);
    const labels = [
      ['selected', 'Selected'],
      ['minimumVariance', 'Minimum variance'],
      ['maximumSharpe', 'Maximum Sharpe (approximate)'],
      ['equalWeightBenchmark', 'Equal-weight benchmark'],
    ];
    labels.forEach(([key, label]) => {
      const allocation = report.allocations[key];
      if (!allocation) return;
      const row = document.createElement('tr');
      cell(row, label);
      cell(row, percent(allocation.expectedReturnAnnualized));
      cell(row, percent(allocation.volatilityAnnualized));
      cell(row, fixed(allocation.sharpeRatio, 3));
      cell(row, fixed(allocation.concentrationIndex, 4));
      comparisonBody.append(row);
    });

    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  addButton.addEventListener('click', () => {
    if (rows().length >= 12) return;
    assetsRoot.append(makeRow());
    updateRowControls();
  });

  assetsRoot.addEventListener('click', (event) => {
    const button = event.target.closest('.portfolio-remove-asset');
    if (!button || rows().length <= 2) return;
    button.closest('.portfolio-asset-row').remove();
    updateRowControls();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    resultSection.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Loading market history…';
    try {
      const assets = rows().map((row) => ({
        symbol: row.querySelector('[name="symbol"]').value.trim(),
        marketClass: row.querySelector('[name="marketClass"]').value,
      }));
      const data = new FormData(form);
      const body = {
        assets,
        timeframe: data.get('timeframe'),
        limit: Number(data.get('limit')),
        objective: data.get('objective'),
        maxWeight: Number(data.get('maxWeight')),
        riskFreeRate: Number(data.get('riskFreeRatePct') || 0) / 100,
        allowSyntheticData: data.get('allowSyntheticData') === '1',
      };
      const periods = String(data.get('periodsPerYear') ?? '').trim();
      if (periods !== '') body.periodsPerYear = Number(periods);

      const response = await fetch(form.dataset.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
      if (!payload.optimization) throw new Error('The server returned no optimization report.');
      render(payload.optimization);
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : 'Portfolio optimization failed.';
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Run portfolio analysis';
    }
  });

  updateRowControls();
})();
