<?php
namespace Aegis\Sports;

use Aegis\Persistence\AuditRepository;
use Aegis\Persistence\SportsRepository;

/**
 * Ticket-engine configuration (spec §16/§34).
 *
 * Append-only, versioned: every change inserts a new configuration row with
 * a monotonically increasing version and an audit event carrying the acting
 * administrator, timestamp, the original values, the new values, and the
 * reason. Tickets always store the configuration version that produced them
 * so any historical decision can be reconstructed.
 *
 * AUTOMATED_EXECUTION is refused unless the operator explicitly passes
 * allowAutomatedExecution (spec §20): automated external execution stays
 * disabled by default and there is no external execution connector at all.
 */
class ConfigurationService
{
    public const PLATFORM_MODES = ['SANDBOX', 'PAPER', 'PRODUCTION'];
    public const ENGINE_MODES = ['VIEW_ONLY', 'AI_ANALYSIS', 'AI_TICKET_GENERATION', 'USER_APPROVAL_REQUIRED', 'AUTOMATED_EXECUTION'];
    public const RISK_LEVELS = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'];
    public const CORRELATION_LIMITS = ['LOW', 'MEDIUM'];
    public const VOID_POLICIES = ['RESTITUTE_ODDS', 'ALL_VOID_ONLY'];

    public function __construct(private SportsRepository $repo, private AuditRepository $audit) {}

    /** Current active configuration (latest version), or a safe default when none exists yet. */
    public function active(): array
    {
        $row = $this->repo->activeConfiguration();
        if ($row === null) return self::defaults();
        $row['allowed_markets'] = $row['allowed_markets'] ?? [];
        $row['allowed_leagues'] = $row['allowed_leagues'] ?? [];
        return $row;
    }

    public static function defaults(): array
    {
        return [
            'version' => 0,
            'module_enabled' => 1,
            'ticket_engine_enabled' => 1,
            'platform_mode' => 'SANDBOX',
            'engine_mode' => 'USER_APPROVAL_REQUIRED',
            'target_odds_min' => 5.0,
            'target_odds_max' => 8.0,
            'max_selections' => 5,
            'risk_level' => 'CONSERVATIVE',
            'min_confidence' => 75.0,
            'min_expected_value' => 0.02,
            'max_correlation' => 'MEDIUM',
            'min_data_quality' => 80,
            'min_liquidity' => null,
            'allowed_markets' => [],
            'allowed_leagues' => [],
            'max_exposure' => 100.0,
            'stake_amount' => 10.0,
            'void_policy' => 'RESTITUTE_ODDS',
            'require_calibration' => 1,
            'updated_by' => 'system',
            'reason' => 'built-in defaults',
        ];
    }

    /**
     * Validate a patch and persist it as the next configuration version.
     * Returns ['ok' => bool, 'reason' => string, 'configuration' => array].
     */
    public function update(array $patch, string $actor, string $reason = '', bool $allowAutomatedExecution = false): array
    {
        $base = $this->active();
        $next = array_merge($base, array_intersect_key($patch, array_flip([
            'module_enabled', 'ticket_engine_enabled', 'platform_mode', 'engine_mode',
            'target_odds_min', 'target_odds_max', 'max_selections', 'risk_level',
            'min_confidence', 'min_expected_value', 'max_correlation', 'min_data_quality',
            'min_liquidity', 'allowed_markets', 'allowed_leagues', 'max_exposure',
            'stake_amount', 'void_policy', 'require_calibration',
        ])));

        $error = $this->validate($next, $allowAutomatedExecution);
        if ($error !== null) return ['ok' => false, 'reason' => $error, 'configuration' => null];

        $present = fn($v) => $this->presentable($v);
        $previous = array_map($present, $base);
        $row = [
            'version' => (int) $base['version'] + 1,
            'module_enabled' => (int) (bool) $next['module_enabled'],
            'ticket_engine_enabled' => (int) (bool) $next['ticket_engine_enabled'],
            'platform_mode' => (string) $next['platform_mode'],
            'engine_mode' => (string) $next['engine_mode'],
            'target_odds_min' => (float) $next['target_odds_min'],
            'target_odds_max' => (float) $next['target_odds_max'],
            'max_selections' => (int) $next['max_selections'],
            'risk_level' => (string) $next['risk_level'],
            'min_confidence' => (float) $next['min_confidence'],
            'min_expected_value' => (float) $next['min_expected_value'],
            'max_correlation' => (string) $next['max_correlation'],
            'min_data_quality' => (int) $next['min_data_quality'],
            'min_liquidity' => $next['min_liquidity'] === null ? null : (float) $next['min_liquidity'],
            'allowed_markets' => json_encode(array_values((array) $next['allowed_markets'])),
            'allowed_leagues' => json_encode(array_values((array) $next['allowed_leagues'])),
            'max_exposure' => (float) $next['max_exposure'],
            'stake_amount' => (float) $next['stake_amount'],
            'void_policy' => (string) $next['void_policy'],
            'require_calibration' => (int) (bool) $next['require_calibration'],
            'updated_by' => $actor,
            'reason' => mb_substr($reason, 0, 500),
            'created_at' => gmdate('c'),
        ];
        $id = $this->repo->saveConfiguration($row);
        $stored = $this->repo->findConfiguration($id);
        $this->audit->emit('SPORTS_CONFIGURATION_UPDATED', 'Sports ticket-engine configuration updated to v' . $row['version'], [
            'version' => $row['version'], 'changed' => array_diff_assoc(array_map($present, $stored), $previous),
            'previous' => $previous, 'new' => array_map($present, $stored), 'reason' => $row['reason'],
        ], $actor);
        return ['ok' => true, 'reason' => 'configuration saved', 'configuration' => $stored];
    }

    private function presentable($v)
    {
        if (is_string($v) && $v !== '' && (str_starts_with($v, '[') || str_starts_with($v, '{'))) return json_decode($v, true);
        return $v;
    }

    /** @return string|null error message, or null when valid */
    private function validate(array $c, bool $allowAutomatedExecution): ?string
    {
        if (!in_array($c['platform_mode'], self::PLATFORM_MODES, true)) return 'platform_mode must be one of ' . implode(', ', self::PLATFORM_MODES);
        if (!in_array($c['engine_mode'], self::ENGINE_MODES, true)) return 'engine_mode must be one of ' . implode(', ', self::ENGINE_MODES);
        if ($c['engine_mode'] === 'AUTOMATED_EXECUTION' && !$allowAutomatedExecution) {
            return 'AUTOMATED_EXECUTION requires explicit authorization (allowAutomatedExecution) and remains disabled in this deployment';
        }
        if (!in_array($c['risk_level'], self::RISK_LEVELS, true)) return 'risk_level must be one of ' . implode(', ', self::RISK_LEVELS);
        if (!in_array($c['max_correlation'], self::CORRELATION_LIMITS, true)) return 'max_correlation must be LOW or MEDIUM';
        if (!in_array($c['void_policy'], self::VOID_POLICIES, true)) return 'void_policy must be one of ' . implode(', ', self::VOID_POLICIES);
        $min = (float) $c['target_odds_min']; $max = (float) $c['target_odds_max'];
        if ($min <= 1.0 || $max <= $min) return 'target odds range must satisfy 1.0 < min <= max';
        $maxSel = (int) $c['max_selections'];
        if ($maxSel < 1 || $maxSel > 12) return 'max_selections must be within [1, 12]';
        $conf = (float) $c['min_confidence'];
        if ($conf < 50 || $conf > 100) return 'min_confidence must be within [50, 100]';
        if ((float) $c['min_expected_value'] < 0) return 'min_expected_value must be >= 0';
        $dq = (int) $c['min_data_quality'];
        if ($dq < 60 || $dq > 100) return 'min_data_quality must be within [60, 100]';
        if ((float) $c['max_exposure'] <= 0) return 'max_exposure must be > 0';
        if ((float) $c['stake_amount'] <= 0) return 'stake_amount must be > 0';
        if ((float) $c['stake_amount'] > (float) $c['max_exposure']) return 'stake_amount cannot exceed max_exposure';
        if ($c['min_liquidity'] !== null && (float) $c['min_liquidity'] < 0) return 'min_liquidity must be >= 0';
        foreach (['allowed_markets', 'allowed_leagues'] as $listKey) {
            $list = $c[$listKey];
            if (!is_array($list)) return "{$listKey} must be an array";
            foreach ($list as $item) if (!is_string($item) || trim($item) === '') return "{$listKey} entries must be non-empty strings";
        }
        return null;
    }
}
