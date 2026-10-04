<?php
/**
 * WINDELS Lottery Intelligence — Phases 4/7 (spec §4/§6): rule engine and
 * data validation. EuroMillions format is CONFIGURATION (counts/ranges from
 * the rules object), never hard-coded analysis logic.
 */
use Aegis\Lottery\EuroMillionsRules;
use Aegis\Lottery\LotteryResultValidator;

test('lottery rules: EuroMillions format is configuration, not hard-coding', function () {
    $r = new EuroMillionsRules();
    assert_equals('EUROMILLIONS', $r->code());
    assert_equals(5, $r->mainCount());
    assert_equals(1, $r->mainMin());
    assert_equals(50, $r->mainMax());
    assert_equals(2, $r->starCount());
    assert_equals(1, $r->starMin());
    assert_equals(12, $r->starMax());
    assert_equals([2, 5], $r->drawSchedule()['days']);
    // Rules reconstructed from a stored DB row (admin-updatable without rebuild)
    $from = EuroMillionsRules::fromArray('EUROMILLIONS', 'EuroMillions', [
        'version' => '2.0', 'main_count' => 5, 'main_min' => 1, 'main_max' => 49,
        'star_count' => 2, 'star_min' => 1, 'star_max' => 11,
        'schedule' => json_encode(['days' => [2, 5], 'time' => '21:00', 'timezone' => 'UTC']),
    ]);
    assert_equals('2.0', $from->version());
    assert_equals(49, $from->mainMax());
    assert_equals(11, $from->starMax());
    assert_false($from->validateLine([1, 2, 3, 4, 50], [1, 11])['valid'], '50 is now out of range under v2.0 rules');
    assert_false($from->validateLine([1, 2, 3, 4, 5], [1, 12])['valid'], 'star 12 is now out of range under v2.0 rules');
});

test('lottery rules: line validation rejects every malformed shape', function () {
    $r = new EuroMillionsRules();
    assert_true($r->validateLine([1, 7, 23, 34, 48], [3, 11])['valid'], 'valid line accepted');
    assert_false($r->validateLine([1, 7, 23, 34], [3, 11])['valid'], '4 mains rejected');
    assert_false($r->validateLine([1, 7, 23, 34, 48, 50], [3, 11])['valid'], '6 mains rejected');
    assert_false($r->validateLine([1, 1, 23, 34, 48], [3, 11])['valid'], 'duplicate mains rejected');
    assert_false($r->validateLine([0, 7, 23, 34, 48], [3, 11])['valid'], 'main 0 out of range');
    assert_false($r->validateLine([1, 7, 23, 34, 51], [3, 11])['valid'], 'main 51 out of range');
    assert_false($r->validateLine([1, 7, 23, 34, 48], [3])['valid'], '1 star rejected');
    assert_false($r->validateLine([1, 7, 23, 34, 48], [0, 11])['valid'], 'star 0 out of range');
    assert_false($r->validateLine([1, 7, 23, 34, 48], [13, 11])['valid'], 'star 13 out of range');
    assert_false($r->validateLine([1, 7, 23, 34, 48], [3, 3])['valid'], 'duplicate stars rejected');
});

function fx_valid_draw(array $over = []): array
{
    return array_merge([
        'externalId' => '2026-188', 'drawDate' => '2026-08-21',
        'main' => [4, 17, 23, 34, 48], 'stars' => [3, 11],
        'jackpot' => '12000000.00', 'rollover' => false,
        'source' => 'test-official-source', 'sourceTimestamp' => '2026-08-21T21:15:00+00:00',
    ], $over);
}

test('lottery validation: every spec §6 check is enforced and failed draws are marked', function () {
    $v = new LotteryResultValidator(new EuroMillionsRules());
    $ok = $v->validate(fx_valid_draw());
    assert_true($ok['valid'], 'well-formed draw accepted');
    assert_equals('VALID', $ok['status']);
    $cases = [
        ['missing draw ID', ['externalId' => '']],
        ['bad date format', ['drawDate' => '21/08/2026']],
        ['impossible calendar date', ['drawDate' => '2026-02-30']],
        ['missing mains', ['main' => []]],
        ['4 mains', ['main' => [1, 2, 3, 4]]],
        ['main out of range', ['main' => [1, 2, 3, 4, 51]]],
        ['duplicate mains', ['main' => [5, 5, 3, 4, 44]]],
        ['1 star', ['stars' => [3]]],
        ['star out of range', ['stars' => [0, 11]]],
        ['duplicate stars', ['stars' => [3, 3]]],
        ['missing source', ['source' => '']],
        ['missing source timestamp', ['sourceTimestamp' => '']],
    ];
    foreach ($cases as [$label, $over]) {
        $r = $v->validate(fx_valid_draw($over));
        assert_false($r['valid'], $label . ' must fail validation');
        assert_equals('DATA_VALIDATION_FAILED', $r['status'], $label . ' must be marked, never stored as official');
        assert_true(count($r['errors']) > 0, $label . ' must report concrete errors');
    }
});
