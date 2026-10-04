<?php
use Aegis\Sports\TicketOptimizer;
function fx_candidate(int $match, float $odds, float $ev): array { return ['matchId' => $match, 'competition' => 'League', 'value' => ['qualified' => true, 'odds' => $odds, 'expectedValue' => $ev], 'risk' => ['approved' => true, 'classification' => 'LOW']]; }
test('ticket optimizer returns no qualified ticket instead of padding invalid odds', function () {
    $out = (new TicketOptimizer())->optimize([fx_candidate(1, 1.3, .1)], ['targetOddsMin' => 5, 'targetOddsMax' => 8]);
    assert_equals('NO_QUALIFIED_TICKET', $out['status']);
});
test('ticket optimizer selects qualifying low-correlation combination', function () {
    $out = (new TicketOptimizer())->optimize([fx_candidate(1, 2, .05), fx_candidate(2, 3, .08), fx_candidate(3, 1.5, .02)], ['targetOddsMin' => 5, 'targetOddsMax' => 7, 'maxSelections' => 3]);
    assert_equals('QUALIFIED', $out['status']); assert_close(6, $out['totalOdds'], .001); assert_equals(2, $out['selectionCount']);
});
test('ticket optimizer never combines same-match selections', function () {
    $out = (new TicketOptimizer())->optimize([fx_candidate(1, 2.5, .1), fx_candidate(1, 2.5, .1)], ['targetOddsMin' => 5, 'targetOddsMax' => 7]);
    assert_equals('NO_QUALIFIED_TICKET', $out['status']);
});
