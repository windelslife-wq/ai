<?php defined('BASEPATH') or exit('No direct script access allowed');
/** @var array $tickets @var array $dailyRuns @var array $performance */
$perf = $performance ?? [];
?>
<div class="page-head">
  <div>
    <h2>Sports tickets</h2>
    <p>Generated tickets, approval state and stored settlements. Approve, reject and settle stay permission-gated. This deployment has no external bookmaker.</p>
  </div>
</div>
<?php if (!empty($notice)): ?><div class="notice ok"><?= e($notice) ?></div><?php endif; ?>
<?php if (!empty($error)): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

<div class="stack">
  <div class="panel">
    <h3>Performance (all stored settlements)</h3>
    <div class="body" style="padding-top:12px">
      <?php if (!empty($perf['demoBanner'])): ?><div class="notice warnbox"><?= e((string) $perf['demoBanner']) ?></div><?php endif; ?>
      <div class="stat-grid">
        <div class="stat"><div class="k">Tickets</div><div class="v"><?= (int) ($perf['totalTickets'] ?? 0) ?></div></div>
        <div class="stat"><div class="k">Settled</div><div class="v"><?= (int) ($perf['settledTickets'] ?? 0) ?></div></div>
        <div class="stat"><div class="k">Won / lost</div><div class="v"><span class="up"><?= (int) ($perf['won'] ?? 0) ?></span> / <span class="down"><?= (int) ($perf['lost'] ?? 0) ?></span></div></div>
        <div class="stat"><div class="k">Win rate</div><div class="v"><?= ($perf['winRate'] ?? null) !== null ? e(number_format((float) $perf['winRate'] * 100, 1)) . '%' : '—' ?></div></div>
        <div class="stat"><div class="k">ROI</div><div class="v <?= ($perf['roi'] ?? null) !== null && (float) $perf['roi'] >= 0 ? 'up' : 'down' ?>"><?= ($perf['roi'] ?? null) !== null ? e(number_format((float) $perf['roi'] * 100, 1)) . '%' : '—' ?></div></div>
        <div class="stat"><div class="k">Profit / loss</div><div class="v <?= ($perf['profitLoss'] ?? null) !== null && (float) $perf['profitLoss'] >= 0 ? 'up' : 'down' ?>"><?= ($perf['profitLoss'] ?? null) !== null ? e(number_format((float) $perf['profitLoss'], 2)) : '—' ?></div></div>
        <div class="stat"><div class="k">Model accuracy</div><div class="v"><?= ($perf['modelAccuracy'] ?? null) !== null ? e(number_format((float) $perf['modelAccuracy'] * 100, 1)) . '%' : '—' ?></div></div>
        <div class="stat"><div class="k">Avg EV / selection</div><div class="v mono"><?= ($perf['expectedValue'] ?? null) !== null ? e(number_format((float) $perf['expectedValue'], 3)) : '—' ?></div></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h3>Tickets</h3>
    <div class="body scroll" style="padding-top:12px">
      <?php if (empty($tickets)): ?>
        <p class="dim">No tickets generated yet.</p>
      <?php else: ?>
        <table class="tbl">
          <thead><tr><th>Ticket</th><th>Created (UTC)</th><th class="num">Odds</th><th class="num">Sel.</th><th class="num">Conf.</th><th>Risk</th><th>Approval</th><th>Settlement</th><th class="num">P/L</th><th></th></tr></thead>
          <tbody>
            <?php foreach ($tickets as $t): $pnl = $t['pnl'] ?? null; ?>
              <tr>
                <td class="mono" style="font-weight:700"><?= e((string) ($t['id'] ?? '')) ?></td>
                <td class="mono dim"><?= e(substr((string) ($t['created_at'] ?? ''), 0, 16)) ?></td>
                <td class="num mono"><?= e(number_format((float) ($t['total_odds'] ?? 0), 2)) ?></td>
                <td class="num"><?= (int) ($t['selection_count'] ?? 0) ?></td>
                <td class="num"><?= ($t['confidence'] ?? null) !== null ? e(number_format((float) $t['confidence'], 0)) : '—' ?></td>
                <td><span class="badge <?= (string) ($t['risk'] ?? '') === 'LOW' ? 'b-green' : ((string) ($t['risk'] ?? '') === 'HIGH' ? 'b-red' : 'b-violet') ?>"><?= e((string) ($t['risk'] ?? '—')) ?></span></td>
                <td><span class="badge b-gray"><?= e((string) ($t['approval_status'] ?? '—')) ?></span></td>
                <td><span class="badge <?= in_array(($t['settlement_status'] ?? ''), ['WON'], true) ? 'b-green' : (in_array(($t['settlement_status'] ?? ''), ['LOST'], true) ? 'b-red' : 'b-gray') ?>"><?= e((string) ($t['settlement_status'] ?? 'PENDING')) ?></span></td>
                <td class="num mono <?= $pnl !== null && (float) $pnl >= 0 ? 'up' : 'down' ?>"><?= $pnl !== null ? e(number_format((float) $pnl, 2)) : '—' ?></td>
                <td class="num" style="white-space:nowrap">
                  <?php if ((string) ($t['approval_status'] ?? '') === 'PENDING_USER_APPROVAL'): ?>
                    <form method="post" action="/sports/<?= e((string) $t['id']) ?>/decide" style="display:inline">
                      <input type="hidden" name="csrf_token" value="<?= e($csrfToken ?? '') ?>"><input type="hidden" name="approve" value="1"><button class="btn small primary">approve</button>
                    </form>
                    <form method="post" action="/sports/<?= e((string) $t['id']) ?>/decide" style="display:inline" onsubmit="return confirm('Reject this ticket?')">
                      <input type="hidden" name="csrf_token" value="<?= e($csrfToken ?? '') ?>"><input type="hidden" name="approve" value="0"><button class="btn small danger">reject</button>
                    </form>
                  <?php endif; ?>
                  <?php if ((string) ($t['settlement_status'] ?? '') === 'PENDING'): ?>
                    <form method="post" action="/sports/<?= e((string) $t['id']) ?>/settle" style="display:inline">
                      <input type="hidden" name="csrf_token" value="<?= e($csrfToken ?? '') ?>"><button class="btn small">settle</button>
                    </form>
                  <?php endif; ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
  </div>

  <div class="panel">
    <h3>Daily ticket runs</h3>
    <div class="body scroll" style="padding-top:12px">
      <?php if (empty($dailyRuns)): ?>
        <p class="dim">No daily runs recorded yet.</p>
      <?php else: ?>
        <table class="tbl">
          <thead><tr><th>Date</th><th>Status</th><th>Ticket</th><th class="num">Evaluated</th><th class="num">Recorded</th><th class="num">Rejected</th><th>Message</th></tr></thead>
          <tbody>
            <?php foreach ($dailyRuns as $r): ?>
              <tr>
                <td class="mono" style="font-weight:700"><?= e((string) ($r['date'] ?? '')) ?></td>
                <td><span class="badge <?= in_array(($r['status'] ?? ''), ['PENDING_USER_APPROVAL', 'APPROVED'], true) ? 'b-violet' : 'b-gray' ?>"><?= e((string) ($r['status'] ?? '')) ?></span></td>
                <td class="mono dim"><?= $r['ticket_id'] ? e((string) $r['ticket_id']) : '—' ?></td>
                <td class="num"><?= (int) ($r['candidates_evaluated'] ?? 0) ?></td>
                <td class="num"><?= (int) ($r['predictions_recorded'] ?? 0) ?></td>
                <td class="num"><?= (int) ($r['rejections'] ?? 0) ?></td>
                <td class="dim"><?= e(mb_substr((string) ($r['message'] ?? ''), 0, 120)) ?></td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>
  </div>
</div>
