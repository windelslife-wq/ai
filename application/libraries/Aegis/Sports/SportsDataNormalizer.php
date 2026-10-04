<?php
namespace Aegis\Sports;

/** Validates and converts a provider fixture into the WINDELS-neutral shape. */
class SportsDataNormalizer
{
    public static function fixture(array $raw, string $provider): array
    {
        foreach (['externalId', 'homeTeam', 'awayTeam', 'competition', 'kickoff'] as $field) {
            if (!isset($raw[$field]) || trim((string) $raw[$field]) === '') throw new \InvalidArgumentException("fixture missing {$field}");
        }
        try { $kickoff = (new \DateTimeImmutable((string) $raw['kickoff']))->setTimezone(new \DateTimeZone('UTC'))->format('c'); }
        catch (\Throwable $e) { throw new \InvalidArgumentException('fixture kickoff is invalid'); }
        $status = strtoupper((string) ($raw['status'] ?? 'SCHEDULED'));
        if (!in_array($status, ['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED', 'SUSPENDED'], true)) throw new \InvalidArgumentException('fixture status is invalid');
        return [
            'provider' => $provider, 'externalId' => (string) $raw['externalId'],
            'sport' => strtolower((string) ($raw['sport'] ?? 'football')),
            'homeTeam' => trim((string) $raw['homeTeam']), 'awayTeam' => trim((string) $raw['awayTeam']),
            'competition' => trim((string) $raw['competition']), 'kickoff' => $kickoff, 'status' => $status,
            'sourceTimestamp' => self::timestamp($raw['sourceTimestamp'] ?? null),
            'simulated' => !empty($raw['simulated']),
            'context' => self::context($raw['context'] ?? null),
            'fieldsPresent' => array_keys($raw),
        ];
    }

    /**
     * Validates optional verified match context. Missing or malformed context
     * is dropped (returned as null), never guessed or invented.
     */
    private static function context($raw): ?array
    {
        if (!is_array($raw)) return null;
        $out = [];
        if (isset($raw['recentForm']) && is_array($raw['recentForm'])) {
            $form = [];
            foreach (['homeGoalsPerMatch', 'awayGoalsPerMatch', 'homeConcededPerMatch', 'awayConcededPerMatch'] as $k) {
                if (isset($raw['recentForm'][$k]) && is_numeric($raw['recentForm'][$k]) && $raw['recentForm'][$k] >= 0) $form[$k] = (float) $raw['recentForm'][$k];
            }
            if (count($form) === 4) {
                $form['source'] = is_string($raw['recentForm']['source'] ?? null) ? $raw['recentForm']['source'] : null;
                $out['recentForm'] = $form;
            }
        }
        foreach (['marketLiquidity', 'restDays'] as $k) {
            if (isset($raw[$k]) && is_numeric($raw[$k]) && $raw[$k] >= 0) $out[$k] = (float) $raw[$k];
        }
        return $out === null ? null : (count($out) ? $out : null);
    }
    public static function odds(array $raw, string $provider): array
    {
        foreach (['market', 'selection', 'decimalOdds', 'observedAt'] as $field) if (!isset($raw[$field]) || $raw[$field] === '') throw new \InvalidArgumentException("odds missing {$field}");
        if (!is_numeric($raw['decimalOdds']) || (float) $raw['decimalOdds'] <= 1.0 || !is_finite((float) $raw['decimalOdds'])) throw new \InvalidArgumentException('decimal odds are invalid');
        return ['provider' => $provider, 'market' => trim((string) $raw['market']), 'selection' => trim((string) $raw['selection']), 'decimalOdds' => (float) $raw['decimalOdds'], 'observedAt' => self::timestamp($raw['observedAt'])];
    }

    private static function timestamp($value): string
    {
        if ($value === null || $value === '') return gmdate('c');
        try { return (new \DateTimeImmutable((string) $value))->setTimezone(new \DateTimeZone('UTC'))->format('c'); }
        catch (\Throwable $e) { throw new \InvalidArgumentException('sourceTimestamp is invalid'); }
    }
}
