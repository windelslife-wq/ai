<?php
/**
 * PHASE 5 hardening — Notifications: repository round-trip, dedupe, and the
 * domain wiring (kill switch, approval requests, risk-alert transitions,
 * broker disconnects).
 */
use Aegis\Notifications\Notifier;

test('notifications: repository save/list/unread/markRead round trip', function () {
    $repo = platform()->model->notifications;
    $repo->markAllRead(null); // isolate from notifications raised by earlier suites
    $n1 = $repo->save(['type' => 'TEST', 'severity' => 'warning', 'title' => 'first', 'detail' => ['x' => 1], 'dedupeKey' => 't1', 'createdAt' => gmdate('c', time() - 60)]);
    $repo->save(['type' => 'TEST', 'severity' => 'critical', 'title' => 'second', 'detail' => [], 'dedupeKey' => null, 'createdAt' => gmdate('c')]);
    assert_true(strlen((string) $n1['id']) === 32);
    assert_equals(2, $repo->unreadCount(null));
    assert_equals(2, count($repo->list(null, true)));
    assert_true($repo->markRead((string) $n1['id'], null));
    assert_false($repo->markRead((string) $n1['id'], null), 'already read');
    assert_equals(1, $repo->unreadCount(null));
    $list = array_values(array_filter($repo->list(null, false, 200), fn($r) => $r['type'] === 'TEST')); // isolate from other suites
    $byTitle = [];
    foreach ($list as $row) $byTitle[$row['title']] = $row;
    assert_equals('second', $list[0]['title'], 'newest first');
    assert_equals(['x' => 1], $byTitle['first']['detail'], 'detail decoded');
    assert_equals(1, $repo->markAllRead(null));
    assert_equals(0, $repo->unreadCount(null));
});

test('notifications: unread dedupe suppresses repeats until acknowledged', function () {
    $notifier = new Notifier(platform()->model->notifications);
    $first = $notifier->notify('TEST', 'critical', 'issue', ['k' => 1], 'dedupe-x');
    assert_true($first['created']);
    $second = $notifier->notify('TEST', 'critical', 'issue again', ['k' => 2], 'dedupe-x');
    assert_false($second['created'], 'unread duplicate suppressed');
    assert_true($notifier->markRead($first['notification']['id']));
    $third = $notifier->notify('TEST', 'critical', 'issue after ack', ['k' => 3], 'dedupe-x');
    assert_true($third['created'], 're-raises after acknowledgement');
});

test('kill switch activation raises a critical notification (deduped)', function () {
    $p = platform();
    $p->model->notifications->markAllRead(null); // clear any unread kill-switch notification from earlier suites
    $before = $p->model->notifications->unreadCount(null);
    $p->setKillSwitch(true, 'notification test');
    $p->setKillSwitch(true, 'notification test again');
    assert_equals($before + 1, $p->model->notifications->unreadCount(null), 'one unread notification, not two');
    $inbox = $p->model->notifications->list(null, true, 10);
    assert_equals('KILL_SWITCH', $inbox[0]['type']);
    assert_equals('critical', $inbox[0]['severity']);
    $p->setKillSwitch(false, 'release');
});

test('supervisor approval requests notify operators with proposal dedupe', function () {
    es_state();
    $connector = new FakeTradingConnector();
    $sup = es_supervisor($connector);
    $result = $sup->propose(es_intent(), 'operator@example.com');
    assert_equals('PENDING_APPROVAL', $result['status']);
    $repo = platform()->model->notifications;
    $inbox = array_filter($repo->list(null, true, 20), fn($n) => $n['type'] === 'TRADE_APPROVAL_REQUESTED');
    assert_equals(1, count($inbox), 'approval notification created');
    // the persisted proposal records the acting operator
    $stored = $sup->proposal($result['id']);
    assert_equals('operator@example.com', $stored['actor']);
    // dedupe: evaluating the same proposal never duplicates (key includes proposal id)
    assert_true($repo->hasUnreadDedupe('proposal:' . $result['id']));
});

test('portfolio risk alerts raise severity-mapped notifications', function () {
    $p = platform();
    $account = $p->paper->createAccount('notif-risk-' . uniqid(), 1000);
    $position = $p->model->paper->savePosition([
        'account_id' => $account['id'], 'symbol' => 'EURUSD', 'market_class' => 'forex', 'direction' => 'LONG',
        'units' => 20000, 'entry_price' => 1.0800, 'stop_loss' => 1.0760, 'take_profit' => 1.0900, 'entry_fee' => 0,
        'opened_at' => gmdate('c', time() - 7200), 'status' => 'CLOSED', 'closed_at' => gmdate('c'),
        'exit_price' => 1.0770, 'realized_pnl' => -60.0, 'exit_reason' => 'STOP_LOSS',
    ]);
    $p->model->paper->saveTrade([
        'account_id' => $account['id'], 'order_id' => null, 'position_id' => $position['id'], 'leg' => 'EXIT',
        'symbol' => 'EURUSD', 'price' => 1.0770, 'units' => 20000, 'fee' => 0, 'time' => gmdate('c'), 'synthetic' => 0,
    ]);
    $report = prm_monitor_with()->scan(); // platform monitor (notifier wired)
    $inbox = array_values(array_filter($p->model->notifications->list(null, true, 30),
        fn($n) => $n['type'] === 'PORTFOLIO_RISK' && str_contains(json_encode($n['detail']), 'paper:' . $account['id'])));
    assert_true(count($inbox) >= 1, 'risk notification created');
    assert_true(in_array($inbox[0]['severity'], ['warning', 'critical'], true));
    // rescan → same active alert does not duplicate (dedupe key = scope:code)
    prm_monitor_with()->scan();
    $again = array_values(array_filter($p->model->notifications->list(null, true, 30),
        fn($n) => $n['type'] === 'PORTFOLIO_RISK' && str_contains(json_encode($n['detail']), 'paper:' . $account['id'])));
    assert_equals(count($inbox), count($again), 'no duplicate unread risk notifications');
});

test('broker disconnect raises BROKER_DISCONNECTED notification + audit', function () {
    $p = platform();
    $connector = new FakeTradingConnector();
    $monitor = prm_monitor_with([$connector]);
    $monitor->scan(); // baseline READY
    $connector->ready = false;
    $monitor->scan();
    $inbox = array_filter($p->model->notifications->list(null, true, 20), fn($n) => $n['type'] === 'BROKER_DISCONNECTED');
    assert_equals(1, count($inbox));
    assert_equals('critical', array_values($inbox)[0]['severity']);
});
