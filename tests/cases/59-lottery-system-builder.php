<?php
/**
 * WINDELS Lottery Intelligence — Phase 16 (spec §18/§19): system builder.
 *
 * Exact combinatorics (C(N,5) x C(S,2), never hardcoded), lazy/paginated
 * enumeration, honest cost handling, and the idempotent background build
 * path (execution-key queue + lottery-cron systems) through the real DB.
 */
use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryCronService;
use Aegis\Lottery\LotteryIntelligence;
use Aegis\Lottery\SystemBuilder;

function fx_lotto_system_builder(): SystemBuilder
{
    return new SystemBuilder(new EuroMillionsRules());
}

test('lottery system builder: exact combinatorics and lazy enumeration', function () {
    $b = fx_lotto_system_builder();

    // minimal system: exactly one line
    $p1 = $b->plan([1, 2, 3, 4, 5], [1, 2]);
    assert_equals(1, $p1['mainCombos']);
    assert_equals(1, $p1['starCombos']);
    assert_equals(1, $p1['totalLines']);
    assert_equals('C(5,5) x C(2,2) = 1 x 1', $p1['formula']);
    assert_equals([['mains' => [1, 2, 3, 4, 5], 'stars' => [1, 2]]], $b->allLines([1, 2, 3, 4, 5], [1, 2]));

    // C(8,5) = 56 main combos x C(4,2) = 6 star combos = 336 lines
    $p2 = $b->plan(range(1, 8), [1, 2, 3, 4]);
    assert_equals(56, $p2['mainCombos']);
    assert_equals(6, $p2['starCombos']);
    assert_equals(336, $p2['totalLines']);
    assert_false($p2['requiresBackground']);
    $all = $b->allLines($p2['mainPool'], $p2['starPool']);
    assert_equals(336, count($all));

    $rules = new EuroMillionsRules();
    $seen = [];
    foreach ($all as $line) {
        assert_true($rules->validateLine($line['mains'], $line['stars'])['valid'], 'every line validates');
        $seen[implode(',', $line['mains']) . '|' . implode(',', $line['stars'])] = true;
    }
    assert_equals(336, count($seen), 'no duplicate lines');

    // lexicographic order: first / last line
    assert_equals([1, 2, 3, 4, 5], $all[0]['mains']);
    assert_equals([1, 2], $all[0]['stars']);
    assert_equals([4, 5, 6, 7, 8], $all[335]['mains']);
    assert_equals([3, 4], $all[335]['stars']);
});

test('lottery system builder: pagination and laziness', function () {
    $b = fx_lotto_system_builder();
    $mains = range(1, 8);
    $stars = [1, 2, 3, 4];

    $p0 = $b->page($mains, $stars, 0, 50);
    $p1 = $b->page($mains, $stars, 50, 50);
    $p2 = $b->page($mains, $stars, 300, 100);
    assert_equals(50, count($p0));
    assert_equals(50, count($p1));
    assert_equals(36, count($p2), '336 - 300 = 36 remaining');

    $all = $b->allLines($mains, $stars);
    assert_equals($all[0], $p0[0]);
    assert_equals($all[49], $p0[49]);
    assert_equals($all[50], $p1[0], 'pages are contiguous');
    assert_equals($all[335], $p2[35]);

    // the enumerator is a true lazy generator
    $it = $b->lines($mains, $stars);
    assert_equals($all[0], $it->current());
    $it->next();
    assert_equals($all[1], $it->current());
});

test('lottery system builder: pool validation and combinatoric identity', function () {
    $b = fx_lotto_system_builder();
    assert_throws(InvalidArgumentException::class, fn () => $b->plan([1, 2, 3, 4], [1, 2]), '4 mains < 5');
    assert_throws(InvalidArgumentException::class, fn () => $b->plan(range(1, 5), [1]), '1 star < 2');
    assert_throws(InvalidArgumentException::class, fn () => $b->plan([1, 1, 2, 3, 4, 5], [1, 2]), 'duplicate pool main');
    assert_throws(InvalidArgumentException::class, fn () => $b->plan([1, 2, 3, 4, 5, 51], [1, 2]), 'main 51 out of range');
    assert_throws(InvalidArgumentException::class, fn () => $b->plan(range(1, 5), [1, 13]), 'star 13 out of range');

    // binomial identities (computed, not hardcoded)
    assert_equals(252, SystemBuilder::comb(10, 5));
    assert_equals(45, SystemBuilder::comb(10, 2));
    assert_equals(1, SystemBuilder::comb(5, 5));
    assert_equals(0, SystemBuilder::comb(3, 5));
    assert_equals(SystemBuilder::comb(16, 5), SystemBuilder::comb(15, 5) + SystemBuilder::comb(15, 4), 'Pascal identity: C(16,5)=C(15,5)+C(15,4)');
    assert_equals(4368, SystemBuilder::comb(16, 5));
});

test('lottery system builder: honest cost and pool coverage', function () {
    $b = fx_lotto_system_builder();
    $p = $b->plan(range(1, 8), [1, 2, 3, 4]);
    assert_null($p['estimatedCost'], 'no official pricing available — cost must stay null');
    assert_true(str_contains($p['costNote'], 'not available') && str_contains($p['costNote'], 'no cost is fabricated'), 'cost note explains the absence honestly');
    assert_equals(100.0, $p['coverage']['mainNumbersPct']);
    assert_equals(100.0, $p['coverage']['mainPairsPct']);
    assert_equals(100.0, $p['coverage']['starPairsPct']);
    assert_true(str_contains($p['coverage']['note'], 'not a statement about winning'));
    assert_true(str_contains($p['disclaimer'], 'independent'));
});

test('lottery system builder: background build queue, idempotency and cron processing', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit);
    $mains = range(1, 16); // C(16,5) = 4368
    $stars = [1, 2, 3];    // C(3,2) = 3  -> 13,104 lines > 10,000 limit

    $before = count(array_filter($model->lottery->listCombinations(200), fn($c) => $c['mode'] === 'SYSTEM'));

    $q = $intel->buildSystem(['mains' => $mains, 'stars' => $stars], '1');
    assert_true($q['queued'], 'large system is queued, not dumped');
    assert_equals(13104, $q['plan']['totalLines']);
    assert_equals('C(16,5) x C(3,2) = 4368 x 3', $q['plan']['formula']);
    assert_not_null($q['run']['id']);

    // idempotent queue: same pool = same execution key, no duplicate run
    $q2 = $intel->buildSystem(['mains' => $mains, 'stars' => $stars], '1');
    assert_true($q2['queued']);
    assert_equals($q['run']['id'], $q2['run']['id'], 'no duplicate queue entry');

    // cron processes the queued build
    $cron = new LotteryCronService($model->lottery, $model->audit, $intel);
    $out = $cron->run('systems');
    assert_equals(1, $out['built']);
    assert_equals(0, $out['failed']);

    $runs = $model->lottery->listJobRuns('system', 10);
    assert_equals(1, count($runs), 'exactly one job run row for the execution key');
    assert_equals('OK', $runs[0]['status']);
    assert_equals(13104, (int) $runs[0]['records_processed']);

    // the system was saved as a SYSTEM combination row
    $rows = array_filter($model->lottery->listCombinations(200), fn($c) => $c['mode'] === 'SYSTEM');
    assert_equals($before + 1, count($rows));
    $sys = end($rows);
    assert_equals(13104, (int) $sys['line_count']);
    assert_equals(13104, count($sys['lines']), 'all 13,104 lines round-trip decoded');
    assert_equals('WINDELS Lottery Model v1.0', $sys['model_version'], 'system stamped with its model');
    assert_equals(range(1, 16), $sys['constraints']['mainPool']);
    assert_equals([1, 2, 3], $sys['constraints']['starPool']);
    $rules = new EuroMillionsRules();
    assert_true($rules->validateLine($sys['lines'][0]['mains'], $sys['lines'][0]['stars'])['valid']);
    assert_true($rules->validateLine($sys['lines'][6000]['mains'], $sys['lines'][6000]['stars'])['valid']);
    assert_true($rules->validateLine($sys['lines'][13103]['mains'], $sys['lines'][13103]['stars'])['valid']);

    // second cron sweep: nothing pending (idempotent)
    $out2 = $cron->run('systems');
    assert_equals(0, $out2['built']);
    assert_equals(0, $out2['pending']);

    // re-requesting the same pool does not create a new run or a new build
    $q3 = $intel->buildSystem(['mains' => $mains, 'stars' => $stars], '1');
    assert_true($q3['queued']);
    assert_equals($q['run']['id'], $q3['run']['id']);
    $rows3 = array_filter($model->lottery->listCombinations(200), fn($c) => $c['mode'] === 'SYSTEM');
    assert_equals($before + 1, count($rows3), 'no duplicate system build');

    // audit trail
    $recent = array_column($model->audit->recent(30), 'type');
    assert_in_array('LOTTERY_SYSTEM_QUEUED', $recent, 'queue audited');
    assert_in_array('LOTTERY_SYSTEM_BUILT', $recent, 'build audited');
});

test('lottery system builder: small systems build inline through the real DB', function () {
    $p = platform();
    $model = $p->model;
    $intel = new LotteryIntelligence($model->lottery, $model->audit);

    $r = $intel->buildSystem(['mains' => range(1, 7), 'stars' => [1, 2, 3]], 'system');
    assert_false($r['queued'], 'C(7,5) x C(3,2) = 21 x 3 = 63 lines builds inline');
    assert_equals(63, $r['plan']['totalLines']);
    assert_not_null($r['saved']['combinationId']);
    $found = $model->lottery->findCombination($r['saved']['combinationId']);
    assert_equals('SYSTEM', $found['mode']);
    assert_equals(63, count($found['lines']));
    assert_equals([1, 2, 3, 4, 5], $found['lines'][0]['mains']);

    // API surface: routes + permissions + feature matrix
    $routes = file_get_contents(FCPATH . 'application/config/routes.php');
    assert_contains("\$route['api/lottery/system'] = 'api_lottery/system';", $routes);
    assert_contains("\$route['api/lottery/system-build'] = 'api_lottery/system_build';", $routes);
    $c = file_get_contents(FCPATH . 'application/controllers/Api_lottery.php');
    assert_true(substr_count($c, "requirePermission('lottery.view')") >= 3, 'generate/diversity/system use CSRF-protected lottery.view');
    assert_contains("requirePermission('lottery.manage')", $c, 'system-build requires lottery.manage');

    require_once FCPATH . 'application/controllers/Api_system.php';
    $rows = array_filter(Api_system::FEATURES, fn($x) => str_contains($x['name'], 'Lottery System Builder'));
    assert_equals(1, count($rows), 'feature matrix row present');
    foreach ($rows as $row) assert_equals('IMPLEMENTED', $row['status']);
});
