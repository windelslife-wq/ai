<?php
defined('BASEPATH') or exit('No direct script access allowed');
$lotteryStatus = is_array($lotteryStatus ?? null) ? $lotteryStatus : [];
$providerHealth = is_array($providerHealth ?? null) ? $providerHealth : [];
$live = is_array($providerHealth['live'] ?? null) ? $providerHealth['live'] : [];
$latestHealth = is_array($providerHealth['latest'] ?? null) ? $providerHealth['latest'] : null;
$healthHistory = is_array($providerHealth['history'] ?? null) ? $providerHealth['history'] : [];
$providers = is_array($providers ?? null) ? $providers : [];
$decisions = is_array($decisions ?? null) ? $decisions : [];
$rules = is_array($lotteryStatus['rules'] ?? null) ? $lotteryStatus['rules'] : [];
$state = strtoupper((string) ($live['state'] ?? 'UNKNOWN'));
$stateClass = $state === 'ONLINE' ? 'b-green' : (in_array($state, ['DEGRADED', 'OFFLINE'], true) ? 'b-amber' : 'b-gray');
?>
<div class="page-head lottery-page-head">
  <div>
    <p class="eyebrow">Lottery Intelligence · Operations</p>
    <h2>Lottery Operations</h2>
    <p>Review provider health, stored draw provenance and the exact inputs behind recent AI-generated combinations.</p>
  </div>
  <?php if (!empty($canManage)): ?>
    <div class="lottery-actions" aria-label="Lottery administrator actions">
      <button class="btn small" type="button" data-lottery-action="health" data-endpoint="/api/lottery/providers/check">Check provider health</button>
      <button class="btn primary small" type="button" data-lottery-action="sync" data-endpoint="/api/lottery/sync">Sync draw history</button>
    </div>
  <?php endif; ?>
</div>

<div class="notice warnbox lottery-honesty-note">
  EuroMillions draws are independent random events. Historical frequency, balance scores and generation modes do not predict or improve a line's chance of winning. Sandbox records remain synthetic and are never presented as official results.
</div>
<div id="lottery-console-message" class="notice" role="status" aria-live="polite" hidden></div>

<?php if (empty($canView ?? true)): ?>
  <div class="panel"><div class="body"><div class="notice err">Your account does not have <code>lottery.view</code> permission for this console.</div></div></div>
<?php else: ?>
  <div class="grid four lottery-summary-grid">
    <div class="kp-card"><span class="kp-k">Engine state</span><b class="kp-v"><?= e((string) ($lotteryStatus['engine'] ?? 'DISABLED_NO_PROVIDER')) ?></b><small class="dim">Runtime ingestion only activates with an available configured source.</small></div>
    <div class="kp-card"><span class="kp-k">Tracked draws</span><b class="kp-v"><?= (int) ($lotteryStatus['drawsTracked'] ?? 0) ?></b><small class="dim">Stored EuroMillions history; inspect each draw's source and verification state.</small></div>
    <div class="kp-card"><span class="kp-k">Active rules</span><b class="kp-v"><?= e((string) ($rules['version'] ?? '—')) ?></b><small class="dim"><?= (int) ($rules['main']['count'] ?? 0) ?> mains · <?= (int) ($rules['stars']['count'] ?? 0) ?> Lucky Stars</small></div>
    <div class="kp-card"><span class="kp-k">Model version</span><b class="kp-v"><?= e((string) ($lotteryStatus['modelVersion'] ?? '—')) ?></b><small class="dim">Reports retain the model that produced them.</small></div>
  </div>

  <div class="grid cols-main lottery-ops-grid">
    <section class="panel">
      <h3>Provider health</h3>
      <div class="body">
        <div class="lottery-provider-heading">
          <div>
            <div class="lottery-provider-name"><?= e((string) ($providerHealth['provider'] ?? 'unknown')) ?></div>
            <p class="dim" data-provider-message><?= e((string) ($live['message'] ?? 'Provider health is unavailable.')) ?></p>
          </div>
          <span class="badge <?= e($stateClass) ?>" data-health-state><?= e($state) ?></span>
        </div>
        <dl class="lottery-health-facts">
          <div><dt>Source class</dt><dd data-health-source><?= !empty($live['synthetic']) ? 'Synthetic sandbox' : (!empty($live['licensed']) ? 'Authorized provider' : 'No live source confirmed') ?></dd></div>
          <div><dt>License metadata</dt><dd data-health-license><?= !empty($live['licenseConfigured']) || !empty($live['licensed']) ? 'Configured / confirmed' : 'Not confirmed' ?></dd></div>
          <div><dt>Last recorded check</dt><dd data-health-observed><?= e((string) ($latestHealth['observed_at'] ?? 'No persisted health check')) ?></dd></div>
          <div><dt>Last response time</dt><dd data-health-response><?= isset($latestHealth['response_ms']) ? e((string) $latestHealth['response_ms']) . ' ms' : '—' ?></dd></div>
          <div><dt>Last draw retrieved</dt><dd data-health-last-draw><?= e((string) ($latestHealth['last_draw_retrieved'] ?? '—')) ?></dd></div>
          <div><dt>Synthetic data</dt><dd data-health-synthetic><?= !empty($live['synthetic']) || !empty($latestHealth['synthetic']) ? 'Yes — simulation only' : 'No / not reported' ?></dd></div>
        </dl>
        <?php if (!empty($canManage)): ?>
          <p class="dim lottery-ops-hint">Health probes and synchronization requests are CSRF-protected and audited. Provider activation and credentials stay server-side; only use an official feed after its source contract and authorization are verified.</p>
        <?php endif; ?>
      </div>
    </section>

    <aside class="panel">
      <h3>Latest stored draw</h3>
      <div class="body">
        <?php $lastDraw = $lotteryStatus['lastDraw'] ?? null; ?>
        <?php if (is_array($lastDraw)): ?>
          <dl class="lottery-draw-facts">
            <div><dt>Draw date</dt><dd><?= e((string) ($lastDraw['draw_date'] ?? '—')) ?></dd></div>
            <div><dt>Source</dt><dd><?= e((string) ($lastDraw['source'] ?? 'unknown')) ?></dd></div>
            <div><dt>Verification</dt><dd><span class="badge b-gray"><?= e((string) ($lastDraw['verification_status'] ?? 'UNKNOWN')) ?></span></dd></div>
            <div><dt>Retrieved</dt><dd><?= e((string) ($lastDraw['retrieved_at'] ?? '—')) ?></dd></div>
          </dl>
          <?php $payload = is_array($lastDraw['payload'] ?? null) ? $lastDraw['payload'] : []; ?>
          <?php if (isset($payload['main'], $payload['stars'])): ?>
            <p class="lottery-number-line"><span>Mains</span><b><?= e(implode(' · ', array_map('strval', (array) $payload['main']))) ?></b></p>
            <p class="lottery-number-line"><span>Lucky Stars</span><b><?= e(implode(' · ', array_map('strval', (array) $payload['stars']))) ?></b></p>
          <?php endif; ?>
        <?php else: ?>
          <p class="dim">No draws are stored. The console does not generate or substitute official results.</p>
        <?php endif; ?>
        <p class="dim lottery-rules-note">Rules: <?= (int) ($rules['main']['count'] ?? 0) ?> mains from <?= (int) ($rules['main']['min'] ?? 0) ?>–<?= (int) ($rules['main']['max'] ?? 0) ?>; <?= (int) ($rules['stars']['count'] ?? 0) ?> Lucky Stars from <?= (int) ($rules['stars']['min'] ?? 0) ?>–<?= (int) ($rules['stars']['max'] ?? 0) ?>. Active schedule is stored as configuration, not an odds forecast.</p>
      </div>
    </aside>
  </div>

  <div class="grid cols-main lottery-ops-grid">
    <section class="panel">
      <h3>Provider health history</h3>
      <div class="body">
        <p class="dim" data-health-empty <?= $healthHistory === [] ? '' : 'hidden' ?>>No health observations have been saved yet. An administrator can record a probe when the source is configured.</p>
        <div class="table-scroll" data-health-table-wrap <?= $healthHistory === [] ? 'hidden' : '' ?>><table class="tbl lottery-health-table">
          <thead><tr><th>Observed (UTC)</th><th>State</th><th>Response</th><th>Records</th><th>Invalid</th><th>Data label</th></tr></thead>
          <tbody data-health-history>
            <?php foreach ($healthHistory as $record): ?>
              <tr>
                <td class="mono dim"><?= e((string) ($record['observed_at'] ?? '—')) ?></td>
                <td><span class="badge b-gray"><?= e((string) ($record['status'] ?? 'UNKNOWN')) ?></span></td>
                <td><?= isset($record['response_ms']) ? e((string) $record['response_ms']) . ' ms' : '—' ?></td>
                <td><?= (int) ($record['records_received'] ?? 0) ?></td>
                <td><?= (int) ($record['invalid_records'] ?? 0) ?></td>
                <td><?= !empty($record['synthetic']) ? '<span class="badge b-amber">SYNTHETIC</span>' : '<span class="dim">reported live / unavailable</span>' ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table></div>
      </div>
    </section>

    <aside class="panel">
      <h3>Provider registry</h3>
      <div class="body">
        <p class="dim" data-provider-registry-empty <?= $providers === [] ? '' : 'hidden' ?>>No provider registry rows yet. A health probe or a successful ingestion creates a source record.</p>
        <div class="table-scroll" data-provider-registry-wrap <?= $providers === [] ? 'hidden' : '' ?>><table class="tbl">
          <thead><tr><th>Provider</th><th>Registry flag</th><th>Data class</th></tr></thead>
          <tbody data-provider-registry>
            <?php foreach ($providers as $provider): ?>
              <tr>
                <td><b><?= e((string) ($provider['display_name'] ?? $provider['provider_code'] ?? 'Unknown')) ?></b><br><span class="mono dim"><?= e((string) ($provider['provider_code'] ?? '')) ?></span></td>
                <td><?= !empty($provider['enabled']) ? 'Enabled' : 'Not enabled' ?></td>
                <td><?= !empty($provider['synthetic']) ? '<span class="badge b-amber">SYNTHETIC</span>' : 'Non-synthetic' ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table></div>
        <p class="dim lottery-ops-hint">Registry metadata does not activate a provider. Effective access is controlled by server-side environment settings and source authorization.</p>
      </div>
    </aside>
  </div>

  <section class="panel lottery-decisions-panel">
    <h3>AI decision reports <span class="badge b-gray">Historical records · not predictions</span></h3>
    <div class="body">
      <p class="dim lottery-report-intro">Each report records the model, mode, seed, dataset/rules version, actual factors and generated lines for reproducibility. Scores are balance statistics only—not probability estimates.</p>
      <?php if ($decisions === []): ?>
        <div class="lottery-empty-state"><b>No decision reports stored yet.</b><span>Generate a combination through the existing Lottery API to create a report linked to its saved combination.</span></div>
      <?php else: ?>
        <div class="table-scroll"><table class="tbl lottery-decision-table">
          <thead><tr><th>ID</th><th>Created</th><th>Mode</th><th>Model</th><th>Combination</th><th>Report</th></tr></thead>
          <tbody>
            <?php foreach ($decisions as $row): ?>
              <?php
                $decision = is_array($row['decision'] ?? null) ? $row['decision'] : [];
                $inputs = is_array($decision['inputs'] ?? null) ? $decision['inputs'] : [];
                $factors = is_array($decision['factors'] ?? null) ? $decision['factors'] : [];
                $lines = is_array($decision['lines'] ?? null) ? $decision['lines'] : [];
                $json = json_encode($decision, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
              ?>
              <tr>
                <td class="mono">#<?= (int) ($row['id'] ?? 0) ?></td>
                <td class="mono dim"><?= e((string) ($row['created_at'] ?? '—')) ?></td>
                <td><span class="badge b-gray"><?= e((string) ($row['mode'] ?? $decision['mode'] ?? 'UNKNOWN')) ?></span></td>
                <td><?= e((string) ($row['model_version'] ?? $decision['model'] ?? '—')) ?></td>
                <td><?= !empty($row['combination_id']) ? '<a href="/api/lottery/combinations/' . (int) $row['combination_id'] . '" target="_blank" rel="noopener">#' . (int) $row['combination_id'] . '</a>' : '—' ?></td>
                <td>
                  <details class="lottery-report-details">
                    <summary>Inspect report</summary>
                    <div class="lottery-report-content">
                      <dl class="lottery-report-facts">
                        <div><dt>Method</dt><dd><?= e((string) ($factors['method'] ?? 'Not recorded')) ?></dd></div>
                        <div><dt>Seed</dt><dd class="mono"><?= e(isset($inputs['seed']) ? (string) $inputs['seed'] : '—') ?></dd></div>
                        <div><dt>Rules / dataset</dt><dd><?= e((string) ($inputs['rulesVersion'] ?? '—')) ?> · <?= e((string) ($inputs['datasetVersion'] ?? '—')) ?></dd></div>
                        <div><dt>Generated lines</dt><dd><?= count($lines) ?></dd></div>
                      </dl>
                      <?php if ($lines !== []): ?>
                        <ul class="lottery-report-lines">
                          <?php foreach ($lines as $line): ?>
                            <?php if (!is_array($line)) continue; ?>
                            <li><span>Mains</span> <?= e(implode(' · ', array_map('strval', (array) ($line['mains'] ?? [])))) ?> <span>Stars</span> <?= e(implode(' · ', array_map('strval', (array) ($line['stars'] ?? [])))) ?></li>
                          <?php endforeach; ?>
                        </ul>
                      <?php endif; ?>
                      <details class="lottery-raw-report"><summary>Full decision payload</summary><pre><?= e(is_string($json) ? $json : '{}') ?></pre></details>
                    </div>
                  </details>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table></div>
        <p class="lottery-report-api"><a href="/api/lottery/ai-decisions?limit=50">Open recent report API</a> · Individual reports are also available by ID for authorized users.</p>
      <?php endif; ?>
    </div>
  </section>
  <p class="lottery-disclaimer"><?= e((string) ($lotteryStatus['disclaimer'] ?? 'Lottery outcomes are random and every draw is independent.')) ?></p>

  <?php if (!empty($canManage)): ?>
    <div data-lottery-console data-csrf="<?= e((string) ($csrfToken ?? '')) ?>" hidden></div>
    <script src="/assets/js/lottery-console.js" defer></script>
  <?php endif; ?>
<?php endif; ?>
