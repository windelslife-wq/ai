<?php
use Aegis\Sports\DataQualityEngine;
use Aegis\Sports\SportsDataNormalizer;

test('sports fixture normalizer rejects incomplete provider payloads', function () {
    assert_throws(InvalidArgumentException::class, fn() => SportsDataNormalizer::fixture(['externalId' => 'x'], 'provider-a'));
});

test('sports fixture normalizer produces source-attributed canonical data', function () {
    $fixture = SportsDataNormalizer::fixture(['externalId' => 'f-1', 'homeTeam' => 'Home', 'awayTeam' => 'Away', 'competition' => 'League', 'kickoff' => '2026-09-01T12:00:00Z'], 'provider-a');
    assert_equals('provider-a', $fixture['provider']);
    assert_equals('SCHEDULED', $fixture['status']);
});

test('sports odds normalizer rejects non-positive-value odds', function () {
    assert_throws(InvalidArgumentException::class, fn() => SportsDataNormalizer::odds(['market' => '1X2', 'selection' => 'Home', 'decimalOdds' => 1, 'observedAt' => '2026-09-01T12:00:00Z'], 'provider-a'));
});

test('sports quality engine rejects stale and incomplete ticket data', function () {
    $fixture = SportsDataNormalizer::fixture(['externalId' => 'f-1', 'homeTeam' => 'Home', 'awayTeam' => 'Away', 'competition' => 'League', 'kickoff' => '2026-09-01T12:00:00Z'], 'provider-a');
    $q = (new DataQualityEngine())->assess($fixture, ['oddsAvailable' => false, 'recentFormAvailable' => false, 'providerReliability' => .5, 'dataAgeSeconds' => 99999]);
    assert_false($q['eligibleForTicket']);
    assert_contains('odds', implode(',', $q['missing']));
});
