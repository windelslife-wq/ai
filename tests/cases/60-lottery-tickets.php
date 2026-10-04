<?php
/**
 * WINDELS Lottery Intelligence — Phases 17/18 (spec §20/§29/§38):
 * ticket builder + saved tickets.
 *
 * Every line validated before saving, user isolation (own tickets only
 * unless lottery.manage), check against stored VERIFIED draws with the
 * official prize tier structure (no amounts), idempotent post-draw cron,
 * actual outcomes kept separate from backtests/demo (spec §30).
 */
use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryCronService;
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SandboxLotteryProvider;

/** n numbers (ascending) that are NOT in $drawMains. */
function fx_lotto_fillers(array $drawMains, int $need): array
{
    $out = [];
    for ($n = 1; $n <= 50 && count($out) < $need; $n++) {
        if (!in_array($n, $drawMains, true)) $out[] = $n;
    }
    return $out;
}

/** A star that is NOT in $drawStars (12 stars total, 2 in the draw → always found). */
function fx_lotto_star_filler(array $drawStars): int
{
    for ($s = 1; $s <= 12; $s++) {
        if (!in_array($s, $drawStars, true)) return $s;
    }
    return 12;
}

test('lottery tickets: creation validates every line, stores user-scoped rows', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit);

    $t = $intel->createTicket(
        7, 'My Tuesday ticket',
        [
            ['mains' => [5, 10, 15, 20, 25], 'stars' => [1, 6]],
            ['mains' => [49, 48, 47, 46, 45], 'stars' => [12, 11]],
        ],
        'BALANCED', '2026-08-25', 'WINDELS Lottery Model v1.0',
        ['locks' => ['mains' => [5]], 'excludes' => ['mains' => [49]]]
    );
    assert_equals(7, (int) $t['user_id']);
    assert_equals('OPEN', $t['status']);
    assert_equals('BALANCED', $t['generation_method']);
    assert_equals('WINDELS Lottery Model v1.0', $t['model_version'], 'ticket stamped with the model that generated it');

    $detail = $intel->ticketDetail((int) $t['id'], 7);
    assert_not_null($detail);
    assert_equals(2, count($detail['lines']));
    assert_equals([5, 10, 15, 20, 25], $detail['lines'][0]['mains']);
    assert_equals([45, 46, 47, 48, 49], $detail['lines'][1]['mains'], 'lines normalized sorted on save');
    assert_equals([11, 12], $detail['lines'][1]['stars']);
    assert_equals(['mains' => [5]], $detail['configuration']['locks'], 'configuration round-trips');
    assert_equals(1, count($intel->listMyTickets(7)));

    // user isolation (spec §38)
    assert_null($intel->ticketDetail((int) $t['id'], 8), 'other users cannot read the ticket');
    assert_equals(0, count($intel->listMyTickets(8)));
    assert_not_null($intel->ticketDetail((int) $t['id']), 'system/admin scope (no user filter) sees it');
    assert_false($intel->archiveTicket((int) $t['id'], 8), 'other users cannot archive it');
    assert_equals('OPEN', $intel->ticketDetail((int) $t['id'], 7)['status']);

    // validation: every line checked before anything is stored
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', [['mains' => [1, 2, 3, 4], 'stars' => [1, 2]]]), '4 mains');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', [['mains' => [1, 2, 3, 4, 51], 'stars' => [1, 2]]]), '51 out of range');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', [['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]], ['mains' => [1, 1, 2, 3, 4], 'stars' => [1, 2]]]), 'duplicate in line 2 rejects the ticket');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', []), 'no lines');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, '  ', [['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]]]), 'empty name');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', [['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]]], 'SPLURGE'), 'unknown method');
    assert_throws(InvalidArgumentException::class, fn () => $intel->createTicket(7, 'bad', [['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]]], 'MANUAL', '2026-02-30'), 'invalid date');
    assert_equals(1, count($intel->listMyTickets(7)), 'failed creations stored nothing');
});

test('lottery tickets: prize tier map covers the official structure', function () {
    assert_equals('TIER_1 (5 mains + 2 stars)', LotteryIntelligence::prizeTier(5, 2));
    assert_equals('TIER_2 (5 mains + 1 star)', LotteryIntelligence::prizeTier(5, 1));
    assert_equals('TIER_3 (5 mains)', LotteryIntelligence::prizeTier(5, 0));
    assert_equals('TIER_4 (4 mains + 2 stars)', LotteryIntelligence::prizeTier(4, 2));
    assert_equals('TIER_5 (4 mains + 1 star)', LotteryIntelligence::prizeTier(4, 1));
    assert_equals('TIER_6 (3 mains + 2 stars)', LotteryIntelligence::prizeTier(3, 2));
    assert_equals('TIER_7 (3 mains + 1 star)', LotteryIntelligence::prizeTier(3, 1));
    assert_equals('TIER_8 (2 mains + 2 stars)', LotteryIntelligence::prizeTier(2, 2));
    assert_equals('TIER_9 (1 main + 2 stars)', LotteryIntelligence::prizeTier(1, 2));
    assert_equals('TIER_10 (2 stars)', LotteryIntelligence::prizeTier(0, 2));
    assert_null(LotteryIntelligence::prizeTier(2, 1), 'no tier for 2 mains + 1 star');
    assert_null(LotteryIntelligence::prizeTier(0, 1));
    assert_null(LotteryIntelligence::prizeTier(0, 0));
});

test('lottery tickets: check compares against the stored draw and settles tiers', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(11));
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $intel->sync(8);
        $rows = $intel->listDraws(1);
        assert_true(count($rows) > 0, 'sandbox draws stored');
        $draw = $rows[0];
        $payload = $draw['payload'];
        $drawDate = (string) $draw['draw_date'];
        $drawMains = array_map('intval', $payload['main']);
        $drawStars = array_map('intval', $payload['stars']);

        // line 1: exact match -> TIER_1; line 2: 3 mains + 1 star -> TIER_7
        $line1 = ['mains' => $drawMains, 'stars' => $drawStars];
        $line2 = [
            'mains' => array_merge(array_slice($drawMains, 0, 3), fx_lotto_fillers($drawMains, 2)),
            'stars' => [$drawStars[0], fx_lotto_star_filler($drawStars)],
        ];
        $t = $intel->createTicket(9, 'Check me', [$line1, $line2], 'MANUAL', $drawDate);
        $r = $intel->checkTicket((int) $t['id'], 9);
        assert_equals('CHECKED', $r['status']);
        assert_equals($drawDate, $r['drawDate']);
        assert_equals('sandbox-simulation', $r['drawSource'], 'result attributed to its source');

        assert_equals(5, $r['lines'][0]['mainMatches']);
        assert_equals(2, $r['lines'][0]['starMatches']);
        assert_equals('TIER_1 (5 mains + 2 stars)', $r['lines'][0]['prizeTier']);
        assert_equals(3, $r['lines'][1]['mainMatches']);
        assert_equals(1, $r['lines'][1]['starMatches']);
        assert_equals('TIER_7 (3 mains + 1 star)', $r['lines'][1]['prizeTier']);
        assert_true(str_contains($r['note'], 'kept separate from backtest'), 'actual outcomes separated from backtests (spec §30)');

        // ticket row is CHECKED with the result persisted
        $detail = $intel->ticketDetail((int) $t['id'], 9);
        assert_equals('CHECKED', $detail['status']);
        assert_equals(2, count($detail['result']['lines']));
        assert_equals('TIER_1 (5 mains + 2 stars)', $detail['result']['lines'][0]['prizeTier']);

        // user isolation on check
        assert_null($intel->checkTicket((int) $t['id'], 10), 'other users cannot check another users ticket');

        // NO_DRAW: a ticket dated before any stored draw
        $t2 = $intel->createTicket(9, 'Too early', [$line1], 'MANUAL', '2020-01-01');
        $r2 = $intel->checkTicket((int) $t2['id'], 9);
        assert_equals('NO_DRAW', $r2['status']);
        assert_equals('OPEN', $intel->ticketDetail((int) $t2['id'], 9)['status'], 'NO_DRAW leaves the ticket OPEN for the next sweep');
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery tickets: post-draw auto-check cron is idempotent', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit, new SandboxLotteryProvider(11));
    putenv('WINDELS_LOTTERY_SANDBOX=1');
    try {
        $intel->sync(8);
        $latest = $intel->listDraws(1);
        $drawDate = (string) $latest[0]['draw_date'];
        $t = $intel->createTicket(11, 'Auto check', [['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]]], 'MANUAL', $drawDate);

        $cron = new LotteryCronService($model->lottery, $model->audit, $intel);
        $out = $cron->run('tickets');
        assert_true($out['checked'] >= 1, 'open ticket was auto-checked');
        $detail = $intel->ticketDetail((int) $t['id'], 11);
        assert_equals('CHECKED', $detail['status']);
        assert_not_null($detail['result']);

        // second sweep: already CHECKED — never re-checked (idempotent)
        $out2 = $cron->run('tickets');
        assert_equals(0, $out2['checked'], 'no re-check of settled tickets');

        // archive (soft delete) keeps history, hides from open sweeps
        assert_true($intel->archiveTicket((int) $t['id'], 11));
        assert_equals('ARCHIVED', $intel->ticketDetail((int) $t['id'], 11)['status']);
        $out3 = $cron->run('tickets');
        assert_equals(0, $out3['checked']);
    } finally {
        putenv('WINDELS_LOTTERY_SANDBOX');
    }
});

test('lottery tickets: api routes, permissions and user-scoping wiring', function () {
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['api/lottery/tickets'] = 'api_lottery/tickets';", $routes);
    assert_contains("\$route['api/lottery/tickets/(:num)/check'] = 'api_lottery/check_ticket/\$1';", $routes);
    assert_contains("\$route['api/lottery/tickets/(:num)/delete'] = 'api_lottery/delete_ticket/\$1';", $routes);
    assert_contains("\$route['api/lottery/tickets/(:num)'] = 'api_lottery/show_ticket/\$1';", $routes);

    $c = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    assert_contains('public function create_ticket()', $c);
    assert_contains('public function tickets()', $c);
    assert_contains('$admin ? null : (int) $user[\'id\']', $c, 'non-admin ticket reads are user-scoped');
    assert_contains('(int) $user[\'id\'], (string) $user[\'id\']', $c, 'check is scoped to the caller');

    // honesty scan stays clean on the modified controller
    $lc = strtolower($c);
    foreach (['guarantee', 'win chance', 'win probability', 'winning numbers', 'certain win', 'secret formula', 'sure win', 'jackpot prediction', '90% chance', 'ai knows the next draw', 'predict'] as $banned) {
        assert_false(str_contains($lc, $banned), 'controller contains banned wording: ' . $banned);
    }

    require_once FCPATH . 'application/controllers/Api_system.php';
    $rows = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'Ticket Builder'));
    assert_equals(1, count($rows), 'feature matrix row present');
    foreach ($rows as $row) assert_equals('IMPLEMENTED', $row['status']);
});
