<?php
/**
 * PHASE 5 hardening — proposal expiry (spec §5 invalidation) and the
 * scheduled-operations worker.
 */
/** Real-clock supervisor (expiry compares against wall time, not the session-test clock). */
function cron_supervisor(FakeTradingConnector $connector)
{
    $p = platform();
    $brokers = new \Aegis\Brokers\BrokerManager();
    $brokers->register($connector);
    return new \Aegis\ExecutionSupervisor($p->model->audit, $p->model->state, $p->model->proposals, $p->risk, $brokers, $p->strategies,
        fn(): int => time(), $p->notifications);
}

function cron_btc_intent(array $patch = []): array
{
    return array_merge([
        'symbol' => 'BTCUSDT', 'marketClass' => 'crypto', 'side' => 'BUY', 'type' => 'MARKET',
        'volume' => 0.01, 'stopLoss' => 55000, 'takeProfit' => 70000, 'reason' => 'expiry test',
    ], $patch);
}

test('stale PENDING_APPROVAL proposals expire; fresh ones survive', function () {
    $p = platform();
    es_state();
    $connector = new FakeTradingConnector();
    $connector->now = time();
    $sup = cron_supervisor($connector);

    $stale = $sup->propose(cron_btc_intent(['reason' => 'stale']));
    $fresh = $sup->propose(cron_btc_intent(['reason' => 'fresh']));
    assert_equals('PENDING_APPROVAL', $stale['status']);
    assert_equals('PENDING_APPROVAL', $fresh['status']);

    // age the first proposal beyond the default 240-minute window
    // (saveProposal intentionally keeps created_at immutable on update — age it at the persistence layer)
    $p->model->db->where('id', $stale['id'])->update('trade_proposals', ['created_at' => gmdate('c', time() - 5 * 3600)]);

    $expired = $sup->expireStaleProposals();
    assert_equals([$stale['id']], $expired);
    assert_equals('EXPIRED', $sup->proposal($stale['id'])['status']);
    assert_equals('PENDING_APPROVAL', $sup->proposal($fresh['id'])['status'], 'fresh proposal untouched');

    // expiry is audited and notified
    $events = array_filter($p->model->audit->recent(100), fn($e) => $e['type'] === 'EXECUTION_PROPOSAL_EXPIRED' && str_contains($e['summary'], $stale['id']));
    assert_equals(1, count($events));
    assert_true($p->model->notifications->hasUnreadDedupe("proposal:{$stale['id']}:expired"));

    // an expired proposal can no longer be decided
    assert_throws(RuntimeException::class, fn() => $sup->decide($stale['id'], true, 'user', 'late'));
    // and it can never be routed
    $blocked = $sup->route($stale['id'], 'user');
    assert_equals('ROUTING_BLOCKED', $blocked['status']);
});

test('expiry window is configurable via platform state', function () {
    $p = platform();
    es_state();
    $connector = new FakeTradingConnector();
    $connector->now = time();
    $sup = cron_supervisor($connector);
    $result = $sup->propose(cron_btc_intent());

    $state = $p->model->state->load();
    $state['proposalExpiryMinutes'] = 1; // one minute
    $p->model->state->save($state);
    $p->model->db->where('id', $result['id'])->update('trade_proposals', ['created_at' => gmdate('c', time() - 120)]);

    assert_equals([$result['id']], $sup->expireStaleProposals());
    assert_equals([], $sup->expireStaleProposals(), 'expiry is idempotent');
});

test('cron worker runs the full scheduled sweep and audits a summary', function () {
    $p = platform();
    $before = count(array_filter($p->model->audit->recent(500), fn($e) => $e['type'] === 'CRON_RUN'));
    ob_start();
    ci()->cron();
    $out = ob_get_clean();
    $summary = json_decode($out, true);
    assert_true(is_array($summary), 'cron prints a JSON summary');
    assert_true(isset($summary['ranAt'], $summary['riskAlerts'], $summary['proposalsExpired']));
    $after = count(array_filter($p->model->audit->recent(500), fn($e) => $e['type'] === 'CRON_RUN'));
    assert_equals($before + 1, $after, 'CRON_RUN audit event emitted');
});
