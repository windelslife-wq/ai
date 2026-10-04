<?php
/**
 * Shared idempotent index upgrades for pre-existing sports tables
 * (spec §30 index requirements). Plain SQL cannot conditionally create
 * indexes on MySQL, so the installers call this once after schema install.
 *
 * @param PDO $pdo
 * @param string $driver 'pdo_sqlite' or mysqli-style
 */
function aegis_ensure_sports_indexes(PDO $pdo, string $driver): void
{
    $sqlite = $driver === 'pdo_sqlite';
    $indexes = [
        ['idx_sports_odds_provider', 'sports_odds', 'provider_id, observed_at'],
        ['idx_sports_matches_provider_kickoff', 'sports_matches', 'provider_id, kickoff_at'],
        ['idx_sports_predictions_market', 'sports_predictions', 'market, created_at'],
        ['idx_sports_selections_market', 'sports_ticket_selections', 'market, selection'],
        ['idx_sports_selections_match', 'sports_ticket_selections', 'match_id'],
        ['idx_sports_predictions_created', 'sports_predictions', 'created_at'],
        ['idx_sports_health_provider', 'sports_provider_health', 'provider_id, observed_at'],
    ];
    foreach ($indexes as [$name, $table, $cols]) {
        $sql = $sqlite
            ? "CREATE INDEX IF NOT EXISTS {$name} ON {$table} ({$cols})"
            : "CREATE INDEX {$name} ON {$table} ({$cols})";
        try {
            $pdo->exec($sql);
        } catch (Throwable $e) {
            if (!$sqlite) continue; // duplicate index on re-run
        }
    }
}
