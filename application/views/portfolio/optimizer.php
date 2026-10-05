<?php defined('BASEPATH') or exit('No direct script access allowed'); ?>
<div class="page-head">
  <div>
    <p class="eyebrow">Phase 6 · Research only</p>
    <h2>Portfolio Optimizer</h2>
    <p>Compare long-only allocations using aligned historical market data. The optimizer is analytical only and never submits orders.</p>
  </div>
</div>

<div class="notice warnbox">
  Historical estimates are not forecasts. Currency conversion, fees, slippage, taxes, liquidity and future market changes are not modeled. Synthetic data is refused unless you explicitly enable the simulation option below.
</div>

<?php if (empty($canOptimize)): ?>
  <div class="panel"><div class="body"><div class="notice err">Your account does not have the <code>trading.view</code> permission required to run portfolio analysis.</div></div></div>
<?php else: ?>
  <div class="grid cols-main portfolio-layout">
    <section class="panel">
      <h3>Optimization inputs</h3>
      <div class="body">
        <form id="portfolio-optimizer-form" class="portfolio-form" action="/api/portfolio/optimize" method="post" data-endpoint="/api/portfolio/optimize">
          <input type="hidden" id="portfolio-csrf" value="<?= e($csrfToken) ?>">
          <div class="portfolio-form-grid">
            <label class="portfolio-field">Timeframe
              <select name="timeframe" class="sel">
                <option value="1d" selected>1 day</option><option value="4h">4 hours</option><option value="1h">1 hour</option><option value="15m">15 minutes</option>
              </select>
            </label>
            <label class="portfolio-field">Historical bars
              <input class="sel" name="limit" type="number" min="31" max="2000" step="1" value="365" required>
            </label>
            <label class="portfolio-field">Objective
              <select name="objective" class="sel">
                <option value="max_sharpe" selected>Maximum Sharpe (approximate)</option>
                <option value="min_variance">Minimum variance</option>
              </select>
            </label>
            <label class="portfolio-field">Maximum weight per asset (0–1)
              <input class="sel" name="maxWeight" type="number" min="0.01" max="1" step="0.01" value="0.60" required>
            </label>
            <label class="portfolio-field">Annual risk-free rate (%)
              <input class="sel" name="riskFreeRatePct" type="number" min="-10" max="100" step="0.1" value="0">
            </label>
            <label class="portfolio-field">Periods per year <span class="dim">(optional override)</span>
              <input class="sel" name="periodsPerYear" type="number" min="1" max="100000" step="1" placeholder="Auto for one market class">
            </label>
          </div>

          <div class="portfolio-assets-head">
            <div><h4>Asset universe</h4><p class="dim">Use symbols served by a configured provider. All assets must share timestamps.</p></div>
            <button class="btn small" id="portfolio-add-asset" type="button">+ Add asset</button>
          </div>
          <div id="portfolio-assets" class="portfolio-assets">
            <div class="portfolio-asset-row">
              <label>Symbol<input name="symbol" value="BTCUSDT" maxlength="64" required autocomplete="off"></label>
              <label>Market class<select name="marketClass">
                <option value="crypto" selected>Crypto</option><option value="forex">Forex</option><option value="commodity">Commodity</option><option value="stock">Stock</option><option value="etf">ETF</option><option value="futures">Futures</option><option value="options">Options</option><option value="indices">Indices</option><option value="bonds">Bonds</option>
              </select></label>
              <button class="btn small ghost portfolio-remove-asset" type="button" aria-label="Remove asset" disabled>Remove</button>
            </div>
            <div class="portfolio-asset-row">
              <label>Symbol<input name="symbol" value="ETHUSDT" maxlength="64" required autocomplete="off"></label>
              <label>Market class<select name="marketClass">
                <option value="crypto" selected>Crypto</option><option value="forex">Forex</option><option value="commodity">Commodity</option><option value="stock">Stock</option><option value="etf">ETF</option><option value="futures">Futures</option><option value="options">Options</option><option value="indices">Indices</option><option value="bonds">Bonds</option>
              </select></label>
              <button class="btn small ghost portfolio-remove-asset" type="button" aria-label="Remove asset">Remove</button>
            </div>
          </div>

          <label class="portfolio-checkbox"><input type="checkbox" name="allowSyntheticData" value="1"> Allow clearly labeled synthetic simulation data</label>
          <p class="dim portfolio-synthetic-note">Keep this unchecked for real-data-only analysis. Synthetic and live series can never be mixed.</p>
          <button class="btn primary" id="portfolio-submit" type="submit">Run portfolio analysis</button>
        </form>
      </div>
    </section>

    <aside class="panel portfolio-method-panel">
      <h3>How to read this</h3>
      <div class="body">
        <ul class="portfolio-method-list">
          <li><b>Expected return</b> is the annualized arithmetic mean of historical returns.</li>
          <li><b>Risk</b> is annualized sample volatility using diagonal covariance shrinkage.</li>
          <li><b>Maximum Sharpe</b> is a deterministic approximate search; it is not guaranteed to find a global optimum.</li>
          <li><b>Minimum variance</b> minimizes estimated portfolio variance under long-only, fully invested and per-asset cap constraints.</li>
          <li><b>Equal weight</b> is included as a reference baseline, not as a recommendation.</li>
        </ul>
        <p class="dim">No short selling, leverage, order sizing, tax, fee, slippage, liquidity or currency conversion is modeled. Review the input source, timestamp coverage and warnings before interpreting any result.</p>
      </div>
    </aside>
  </div>

  <div id="portfolio-error" class="notice err" role="alert" hidden></div>
  <section id="portfolio-result" class="portfolio-result" aria-live="polite" hidden>
    <div class="panel">
      <h3>Optimization report <span id="portfolio-simulation-badge" class="badge b-amber" hidden>SIMULATION</span></h3>
      <div class="body">
        <div id="portfolio-summary" class="portfolio-summary"></div>
        <div id="portfolio-warnings" class="portfolio-warnings"></div>
        <h4>Selected allocation</h4>
        <div class="scroll"><table class="tbl mono"><thead><tr><th>Asset</th><th>Selected weight</th><th>Expected return / year</th><th>Volatility / year</th><th>Source</th></tr></thead><tbody id="portfolio-assets-result"></tbody></table></div>
        <h4>Portfolio comparisons</h4>
        <div class="scroll"><table class="tbl mono"><thead><tr><th>Allocation</th><th>Expected return / year</th><th>Volatility / year</th><th>Sharpe</th><th>Concentration index</th></tr></thead><tbody id="portfolio-comparisons"></tbody></table></div>
      </div>
    </div>
  </section>
  <script src="/assets/js/portfolio-optimizer.js" defer></script>
<?php endif; ?>
