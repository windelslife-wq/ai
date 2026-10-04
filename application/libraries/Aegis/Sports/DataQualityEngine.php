<?php
namespace Aegis\Sports;

/** Conservative quality scoring. Missing critical inputs cap confidence and reject ticket eligibility. */
class DataQualityEngine
{
    public function assess(array $fixture, array $context = []): array
    {
        $checks = [];
        $required = ['externalId', 'homeTeam', 'awayTeam', 'competition', 'kickoff'];
        foreach ($required as $field) $checks[] = ['field' => $field, 'ok' => !empty($fixture[$field]), 'weight' => 12];
        $checks[] = ['field' => 'odds', 'ok' => !empty($context['oddsAvailable']), 'weight' => 18];
        $checks[] = ['field' => 'recentForm', 'ok' => !empty($context['recentFormAvailable']), 'weight' => 12];
        $checks[] = ['field' => 'providerReliability', 'ok' => ($context['providerReliability'] ?? 0) >= 0.75, 'weight' => 10];
        $checks[] = ['field' => 'freshness', 'ok' => ($context['dataAgeSeconds'] ?? PHP_INT_MAX) <= ($context['maxAgeSeconds'] ?? 3600), 'weight' => 8];
        $total = array_sum(array_column($checks, 'weight'));
        $earned = array_sum(array_map(fn($c) => $c['ok'] ? $c['weight'] : 0, $checks));
        $score = (int) round(100 * $earned / $total);
        $freshness = ($context['dataAgeSeconds'] ?? PHP_INT_MAX) <= ($context['maxAgeSeconds'] ?? 3600) ? 100 : 0;
        $reliability = (int) round(100 * min(1, max(0, (float) ($context['providerReliability'] ?? 0))));
        $missing = array_values(array_map(fn($c) => $c['field'], array_filter($checks, fn($c) => !$c['ok'])));
        $band = $score >= 90 ? 'EXCELLENT' : ($score >= 75 ? 'GOOD' : ($score >= 60 ? 'LIMITED' : 'REJECT'));
        return ['score' => $score, 'band' => $band, 'freshnessScore' => $freshness, 'providerReliabilityScore' => $reliability,
            'eligibleForPrediction' => $score >= 60, 'eligibleForTicket' => $score >= 75 && $freshness > 0, 'missing' => $missing, 'checks' => $checks];
    }
}
