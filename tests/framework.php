<?php
/**
 * AEGIS micro test framework — zero dependencies, runs through CodeIgniter's
 * CLI so every test exercises the real stack (CI3 + database + domain).
 */
if (!defined('TESTSPATH')) {
    echo "TESTSPATH not defined\n";
    return;
}

$GLOBALS['__aegis_tests'] = [];

function test(string $name, callable $fn): void
{
    $GLOBALS['__aegis_tests'][] = ['name' => $name, 'fn' => $fn];
}

/** @var CI_Controller $CI — set by the caller (Tools::tests) */
function ci(): CI_Controller
{
    return get_instance();
}

function platform(): \Aegis\Platform
{
    return ci()->platform;
}

function assert_true(bool $cond, string $msg = 'expected true'): void
{
    if (!$cond) throw new RuntimeException('ASSERT: ' . $msg);
}

function assert_false(bool $cond, string $msg = 'expected false'): void
{
    if ($cond) throw new RuntimeException('ASSERT: ' . $msg);
}

function assert_equals($expected, $actual, string $msg = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException('ASSERT: ' . ($msg ?: 'expected ' . var_export($expected, true) . ' got ' . var_export($actual, true)));
    }
}

function assert_close(float $expected, float $actual, float $tol, string $msg = ''): void
{
    if (abs($expected - $actual) > $tol) {
        throw new RuntimeException(sprintf('ASSERT: %s expected %.8f got %.8f (tol %.8f)', $msg, $expected, $actual, $tol));
    }
}

function assert_throws(string $class, callable $fn, string $msg = ''): void
{
    try {
        $fn();
    } catch (Throwable $e) {
        if ($e instanceof $class) return;
        throw new RuntimeException('ASSERT: ' . ($msg ?: "expected {$class} got " . get_class($e) . ': ' . $e->getMessage()));
    }
    throw new RuntimeException('ASSERT: ' . ($msg ?: "expected {$class} to be thrown, nothing thrown"));
}

function assert_contains(string $needle, string $haystack, string $msg = ''): void
{
    if (!str_contains($haystack, $needle)) {
        throw new RuntimeException('ASSERT: ' . ($msg ?: "expected \"{$needle}\" in \"{$haystack}\""));
    }
}

function assert_in_array($needle, array $haystack, string $msg = ''): void
{
    if (!in_array($needle, $haystack, true)) {
        throw new RuntimeException('ASSERT: ' . ($msg ?: 'expected ' . var_export($needle, true) . ' in [' . implode(',', $haystack) . ']'));
    }
}

function assert_not_null($value, string $msg = 'expected non-null'): void
{
    if ($value === null) throw new RuntimeException('ASSERT: ' . $msg);
}

function assert_null($value, string $msg = 'expected null'): void
{
    if ($value !== null) throw new RuntimeException('ASSERT: ' . $msg . ' (got ' . var_export($value, true) . ')');
}

function run_all_tests(): int
{
    $tests = $GLOBALS['__aegis_tests'];
    $pass = 0; $fail = 0;
    echo "\nAEGIS test suite — " . count($tests) . " tests\n" . str_repeat('=', 60) . "\n";
    $start = microtime(true);
    foreach ($tests as $t) {
        $t0 = microtime(true);
        try {
            ($t['fn'])();
            $pass++;
            printf("[ OK ] %-58s %5.0fms\n", mb_substr($t['name'], 0, 58), (microtime(true) - $t0) * 1000);
        } catch (Throwable $e) {
            $fail++;
            printf("[FAIL] %-58s %5.0fms\n       → %s\n       → %s:%d\n", mb_substr($t['name'], 0, 58), (microtime(true) - $t0) * 1000, $e->getMessage(), $e->getFile(), $e->getLine());
        }
    }
    printf(str_repeat('=', 60) . "\n%d passed, %d failed in %.1fs\n", $pass, $fail, microtime(true) - $start);
    return $fail;
}

// ---- shared fixtures -------------------------------------------------------

function fx_candles(int $n, float $drift = 0.0, int $seed = 42, float $noise = 0.4): array
{
    $rand = \Aegis\MathUtils::seededRandom($seed);
    $out = [];
    $price = 100.0;
    $now = 1755000000000;
    $h = 3600000;
    for ($i = 0; $i < $n; $i++) {
        $open = $price;
        $close = $open + $drift + ($rand() - 0.5) * $noise;
        $out[] = [
            'timestamp' => $now - ($n - $i) * $h,
            'open' => $open,
            'high' => max($open, $close) + $rand() * 0.2,
            'low' => min($open, $close) - $rand() * 0.2,
            'close' => $close,
            'volume' => 100 + $rand() * 50,
        ];
        $price = $close;
    }
    return $out;
}

function fx_noise_range(int $n, int $seed = 7, float $amp = 0.8): array
{
    $rand = \Aegis\MathUtils::seededRandom($seed);
    $out = [];
    $price = 100.0;
    $now = 1755000000000;
    $h = 3600000;
    for ($i = 0; $i < $n; $i++) {
        $open = $price;
        $close = $open + (100.0 - $open) * 0.15 + ($rand() - 0.5) * $amp; // mean-reverting: keeps ADX low
        $out[] = [
            'timestamp' => $now - ($n - $i) * $h,
            'open' => $open,
            'high' => max($open, $close) + $rand() * 0.1,
            'low' => min($open, $close) - $rand() * 0.1,
            'close' => $close,
            'volume' => 100,
        ];
        $price = $close;
    }
    return $out;
}

function fx_series(array $candles, string $symbol = 'TESTUSD', string $marketClass = 'crypto', bool $synthetic = true): array
{
    return [
        'symbol' => $symbol, 'marketClass' => $marketClass, 'timeframe' => '1h',
        'candles' => $candles,
        'provenance' => [
            'source' => $synthetic ? 'synthetic-demo' : 'test', 'synthetic' => $synthetic,
            'live' => !$synthetic, 'delayed' => false, 'fetchedAt' => 1755000000000,
            'dataTimestamp' => $candles ? end($candles)['timestamp'] : 0, 'dataAgeMs' => 0,
            'stale' => false, 'fallbackChain' => [],
        ],
        'validation' => ['ok' => true, 'droppedCount' => 0, 'gapCount' => 0, 'expectedIntervalMs' => 3600000,
            'coveredIntervalMs' => 0, 'minTimestamp' => 0, 'maxTimestamp' => 0, 'issues' => []],
    ];
}

function fx_ctx(array $series, int $now = 1755000000000): array
{
    return ['series' => $series, 'now' => $now, 'referenceSeries' => []];
}

/**
 * In-memory SportsRepository stub for tests (implements the full interface
 * without CI3). Used by sports engine tests that don't need SQL.
 */
class SportsRepositoryStub implements \Aegis\Persistence\SportsRepository
{
    public array $providers = [];
    public array $health = [];
    public array $matches = [];
    public array $odds = [];
    public array $results = [];
    public array $quality = [];
    public array $syncKeys = [];
    public array $syncRuns = [];
    public array $modelVersions = [];
    public array $predictions = [];
    public array $tickets = [];
    public array $ticketSelections = [];
    public array $configurations = [];
    public array $calibrations = [];
    public array $jobRuns = [];
    public array $jobKeys = [];
    public array $backtests = [];
    public array $modelMetrics = [];
    public array $dailyTickets = [];
    public array $perfSnapshots = [];

    private int $autoId = 0;

    public function ensureProvider(string $code, string $name): array
    {
        foreach ($this->providers as $p) if ($p['provider_code'] === $code) return $p;
        $row = ['id' => ++$this->autoId, 'provider_code' => $code, 'display_name' => $name, 'enabled' => 0, 'created_at' => gmdate('c'), 'updated_at' => gmdate('c')];
        $this->providers[] = $row;
        return $row;
    }
    public function listProviders(bool $enabledOnly = false): array { return $enabledOnly ? array_values(array_filter($this->providers, fn($p) => $p['enabled'])) : $this->providers; }
    public function setProviderEnabled(int $id, bool $enabled): void { foreach ($this->providers as &$p) if ($p['id'] === $id) { $p['enabled'] = $enabled ? 1 : 0; $p['updated_at'] = gmdate('c'); } }
    public function listHealth(int $providerId, int $limit = 20): array { return array_slice(array_values(array_filter($this->health, fn($h) => $h['provider_id'] === $providerId)), -$limit); }
    public function latestHealth(int $providerId): ?array { $rows = $this->listHealth($providerId, 1); return $rows ? end($rows) : null; }
    public function saveHealth(int $providerId, array $health): void { $this->health[] = array_merge($health, ['provider_id' => $providerId, 'observed_at' => gmdate('c')]); }
    public function findMatchById(int $id): ?array { foreach ($this->matches as $m) if ($m['id'] === $id) return $m; return null; }
    public function listMatches(array $filter = [], int $limit = 200): array
    {
        $rows = $this->matches;
        if (!empty($filter['status'])) $rows = array_values(array_filter($rows, fn($m) => ($m['status'] ?? '') === $filter['status']));
        if (!empty($filter['from'])) $rows = array_values(array_filter($rows, fn($m) => ($m['kickoff_at'] ?? '') >= $filter['from']));
        if (!empty($filter['to'])) $rows = array_values(array_filter($rows, fn($m) => ($m['kickoff_at'] ?? '') <= $filter['to']));
        if (!empty($filter['competition'])) $rows = array_values(array_filter($rows, fn($m) => str_contains((string) ($m['competition'] ?? ''), (string) $filter['competition'])));
        if (!empty($filter['providerId'])) $rows = array_values(array_filter($rows, fn($m) => (int) ($m['provider_id'] ?? 0) === (int) $filter['providerId']));
        return array_slice($rows, 0, $limit);
    }
    public function saveMatch(int $providerId, array $m): array
    {
        foreach ($this->matches as &$row) {
            if ((int) $row['provider_id'] === $providerId && $row['external_id'] === $m['externalId']) {
                $row = array_merge($row, ['sport' => $m['sport'], 'competition' => $m['competition'], 'home_team' => $m['homeTeam'], 'away_team' => $m['awayTeam'], 'kickoff_at' => $m['kickoff'], 'status' => $m['status'], 'source_timestamp' => $m['sourceTimestamp'], 'payload' => $m, 'updated_at' => gmdate('c')]);
                return $row;
            }
        }
        $row = ['id' => ++$this->autoId, 'provider_id' => $providerId, 'external_id' => $m['externalId'], 'sport' => $m['sport'], 'competition' => $m['competition'], 'home_team' => $m['homeTeam'], 'away_team' => $m['awayTeam'], 'kickoff_at' => $m['kickoff'], 'status' => $m['status'], 'source_timestamp' => $m['sourceTimestamp'], 'payload' => $m, 'created_at' => gmdate('c'), 'updated_at' => gmdate('c')];
        $this->matches[] = $row;
        return $row;
    }
    public function findMatch(int $providerId, string $externalId): ?array { foreach ($this->matches as $m) if ((int) $m['provider_id'] === $providerId && $m['external_id'] === $externalId) return $m; return null; }
    public function saveOdds(int $matchId, int $providerId, array $odds): void { $this->odds[] = ['id' => ++$this->autoId, 'match_id' => $matchId, 'provider_id' => $providerId, 'market' => $odds['market'], 'selection' => $odds['selection'], 'decimal_odds' => $odds['decimalOdds'], 'observed_at' => $odds['observedAt'], 'payload' => $odds]; }
    public function latestOdds(int $matchId, ?string $market = null, ?string $selection = null): ?array
    {
        $rows = array_values(array_filter($this->odds, fn($o) => (int) $o['match_id'] === $matchId && ($market === null || $o['market'] === $market) && ($selection === null || $o['selection'] === $selection)));
        usort($rows, fn($a, $b) => strcmp($b['observed_at'], $a['observed_at']));
        return $rows ? $rows[0] : null;
    }
    public function listOdds(int $matchId, int $limit = 50): array { $rows = array_values(array_filter($this->odds, fn($o) => (int) $o['match_id'] === $matchId)); usort($rows, fn($a, $b) => strcmp($b['observed_at'], $a['observed_at'])); return array_slice($rows, 0, $limit); }
    public function latestQuality(int $matchId): ?array { $rows = array_values(array_filter($this->quality, fn($q) => (int) $q['match_id'] === $matchId)); return $rows ? end($rows) : null; }
    public function saveQuality(int $matchId, array $a): void { $this->quality[] = array_merge($a, ['match_id' => $matchId, 'assessed_at' => gmdate('c')]); }
    public function saveResult(int $matchId, int $providerId, array $r): void
    {
        foreach ($this->results as &$row) if ((int) $row['match_id'] === $matchId && (int) $row['provider_id'] === $providerId) { $row = array_merge($row, ['home_score' => $r['homeScore'], 'away_score' => $r['awayScore'], 'status' => $r['status'], 'verified' => 0, 'source_timestamp' => $r['sourceTimestamp'], 'verified_at' => null, 'payload' => $r['payload']]); return; }
        $this->results[] = ['id' => ++$this->autoId, 'match_id' => $matchId, 'provider_id' => $providerId, 'home_score' => $r['homeScore'], 'away_score' => $r['awayScore'], 'status' => $r['status'], 'verified' => 0, 'source_timestamp' => $r['sourceTimestamp'], 'verified_at' => null, 'payload' => $r['payload']];
    }
    public function findResult(int $matchId, int $providerId): ?array { foreach ($this->results as $r) if ((int) $r['match_id'] === $matchId && (int) $r['provider_id'] === $providerId) return $r; return null; }
    public function findResultByMatch(int $matchId): ?array { $rows = array_values(array_filter($this->results, fn($r) => (int) $r['match_id'] === $matchId)); if (!$rows) return null; usort($rows, fn($a, $b) => ($b['verified'] ?? 0) <=> ($a['verified'] ?? 0)); return $rows[0]; }
    public function verifyResult(int $id): void { foreach ($this->results as &$r) if ((int) $r['id'] === $id) { $r['verified'] = 1; $r['verified_at'] = gmdate('c'); } }
    public function startSync(array $run): ?array { if (isset($this->syncKeys[$run['executionKey']])) return null; $this->syncKeys[$run['executionKey']] = true; $this->syncRuns[] = $run; return $run; }
    public function finishSync(string $id, array $result): void { foreach ($this->syncRuns as &$r) if ($r['id'] === $id) $r = array_merge($r, ['status' => $result['status'], 'result' => $result]); }
    public function ensureModelVersion(array $m): int
    {
        foreach ($this->modelVersions as $v) if ($v['model_name'] === $m['modelName'] && $v['model_version'] === $m['modelVersion']) return (int) $v['id'];
        $row = ['id' => ++$this->autoId, 'model_name' => $m['modelName'], 'model_version' => $m['modelVersion'], 'feature_version' => $m['featureVersion'], 'calibration_version' => $m['calibrationVersion'] ?? null, 'status' => $m['status'] ?? 'APPROVED', 'created_at' => gmdate('c')];
        $this->modelVersions[] = $row;
        return (int) $row['id'];
    }
    public function listModelVersions(): array { return $this->modelVersions; }
    public function findModelVersion(int $id): ?array { foreach ($this->modelVersions as $v) if ((int) $v['id'] === $id) return $v; return null; }
    public function savePrediction(array $p): void { $this->predictions[] = $p; }
    public function listPredictions(array $filter = [], int $limit = 200): array
    {
        $rows = $this->predictions;
        if (!empty($filter['matchId'])) $rows = array_values(array_filter($rows, fn($p) => (int) $p['match_id'] === (int) $filter['matchId']));
        if (!empty($filter['modelVersionId'])) $rows = array_values(array_filter($rows, fn($p) => (int) $p['model_version_id'] === (int) $filter['modelVersionId']));
        if (!empty($filter['decision'])) $rows = array_values(array_filter($rows, fn($p) => ($p['decision'] ?? '') === $filter['decision']));
        if (!empty($filter['market'])) $rows = array_values(array_filter($rows, fn($p) => ($p['market'] ?? '') === $filter['market']));
        if (!empty($filter['from'])) $rows = array_values(array_filter($rows, fn($p) => ($p['created_at'] ?? '') >= $filter['from']));
        if (!empty($filter['to'])) $rows = array_values(array_filter($rows, fn($p) => ($p['created_at'] ?? '') <= $filter['to']));
        $this->decodePredictionJson($rows);
        return array_slice($rows, 0, $limit);
    }
    /** Mirrors the real repository: factors/rejection_reasons are stored as JSON. */
    private function decodePredictionJson(array &$rows): void
    {
        foreach ($rows as &$row) {
            if (isset($row['factors']) && is_string($row['factors'])) $row['factors'] = json_decode($row['factors'], true) ?? [];
            if (isset($row['rejection_reasons']) && is_string($row['rejection_reasons'])) $row['rejection_reasons'] = json_decode($row['rejection_reasons'], true) ?? [];
        }
        unset($row);
    }
    public function findPrediction(string $id): ?array { foreach ($this->predictions as $p) if ($p['id'] === $id) { $rows = [$p]; $this->decodePredictionJson($rows); return $rows[0]; } return null; }
    public function predictionOutcomes(?int $modelVersionId = null): array
    {
        $out = [];
        foreach ($this->predictions as $p) {
            if ($modelVersionId !== null && (int) $p['model_version_id'] !== $modelVersionId) continue;
            $match = $this->findMatchById((int) $p['match_id']);
            $result = $this->findResultByMatch((int) $p['match_id']);
            if ($match === null || $result === null || !(bool) $result['verified'] || ($result['status'] ?? '') !== 'FINISHED') continue;
            $total = (int) $result['home_score'] + (int) $result['away_score'];
            if ($p['market'] === 'TOTAL_GOALS' && $p['selection'] === 'OVER_1_5') $outcome = $total > 1 ? 1 : 0;
            elseif ($p['market'] === 'TOTAL_GOALS' && $p['selection'] === 'UNDER_1_5') $outcome = $total <= 1 ? 1 : 0;
            else continue;
            $out[] = array_merge($p, ['outcome' => $outcome, 'competition' => $match['competition'] ?? null, 'home_score' => $result['home_score'], 'away_score' => $result['away_score']]);
        }
        return $out;
    }
    public function activeConfiguration(): ?array
    {
        if (!$this->configurations) return null;
        usort($this->configurations, fn($a, $b) => (int) $b['version'] <=> (int) $a['version']);
        return $this->decodeConfig($this->configurations[0]);
    }
    public function listConfigurations(int $limit = 20): array { usort($this->configurations, fn($a, $b) => (int) $b['version'] <=> (int) $a['version']); return array_map(fn($c) => $this->decodeConfig($c), array_slice($this->configurations, 0, $limit)); }
    public function saveConfiguration(array $c): int { $row = array_merge(['id' => ++$this->autoId, 'created_at' => gmdate('c')], $c); $this->configurations[] = $row; return (int) $row['id']; }
    public function findConfiguration(int $id): ?array { foreach ($this->configurations as $c) if ((int) $c['id'] === $id) return $this->decodeConfig($c); return null; }
    private function decodeConfig(array $c): array { $c['allowed_markets'] = json_decode((string) ($c['allowed_markets'] ?? '[]'), true) ?: []; $c['allowed_leagues'] = json_decode((string) ($c['allowed_leagues'] ?? '[]'), true) ?: []; return $c; }
    public function saveCalibration(array $c): int { $row = array_merge(['id' => ++$this->autoId, 'created_at' => gmdate('c'), 'status' => 'PENDING'], $c); $this->calibrations[] = $row; return (int) $row['id']; }
    public function findCalibration(int $id): ?array { foreach ($this->calibrations as $c) if ((int) $c['id'] === $id) return $c; return null; }
    public function listCalibrations(?int $modelVersionId = null, ?string $status = null, int $limit = 50): array { $rows = array_values(array_filter($this->calibrations, fn($c) => ($modelVersionId === null || (int) $c['model_version_id'] === $modelVersionId) && ($status === null || ($c['status'] ?? '') === $status))); return array_slice($rows, -$limit); }
    public function activeCalibration(int $modelVersionId): ?array
    {
        $rows = array_values(array_filter($this->calibrations, fn($c) => (int) $c['model_version_id'] === $modelVersionId && ($c['status'] ?? '') === 'APPROVED'));
        if (!$rows) return null;
        usort($rows, fn($a, $b) => strcmp($b['created_at'], $a['created_at']));
        return $rows[0];
    }
    public function updateCalibrationStatus(int $id, string $status, ?string $actor = null): void { foreach ($this->calibrations as &$c) if ((int) $c['id'] === $id) { $c['status'] = $status; if ($actor !== null) { $c['approved_by'] = $actor; $c['approved_at'] = gmdate('c'); } } }
    public function startJobRun(array $run): ?array { if (isset($this->jobKeys[$run['executionKey']])) return null; $this->jobKeys[$run['executionKey']] = true; $this->jobRuns[] = $run; return $run; }
    public function finishJobRun(string $id, array $result): void { foreach ($this->jobRuns as &$r) if ($r['id'] === $id) $r = array_merge($r, ['status' => $result['status'], 'result' => $result]); }
    public function listJobRuns(?string $jobType = null, int $limit = 50): array { $rows = $jobType === null ? $this->jobRuns : array_values(array_filter($this->jobRuns, fn($r) => ($r['job_type'] ?? '') === $jobType)); return array_slice(array_reverse($rows), 0, $limit); }
    public function saveBacktest(array $b): void { $this->backtests[] = $b; }
    public function findBacktest(string $id): ?array { foreach ($this->backtests as $b) if ($b['id'] === $id) return $b; return null; }
    public function listBacktests(int $limit = 20): array { return array_slice(array_reverse($this->backtests), 0, $limit); }
    public function saveModelMetrics(array $m): void { $this->modelMetrics[] = $m; }
    public function listModelMetrics(?int $modelVersionId = null, ?int $windowDays = null, ?string $sampleType = null, int $limit = 200): array { return array_slice(array_reverse(array_values(array_filter($this->modelMetrics, fn($m) => ($modelVersionId === null || (int) $m['model_version_id'] === $modelVersionId) && ($windowDays === null || (int) $m['window_days'] === $windowDays) && ($sampleType === null || ($m['sample_type'] ?? '') === $sampleType)))), 0, $limit); }
    public function findDailyTicket(string $date): ?array { foreach ($this->dailyTickets as $d) if ($d['date'] === $date) { $d['rejection_summary'] = is_string($d['rejection_summary'] ?? null) ? (json_decode($d['rejection_summary'], true) ?? []) : ($d['rejection_summary'] ?? []); return $d; } return null; }
    public function saveDailyTicket(array $d): void { foreach ($this->dailyTickets as &$x) if ($x['date'] === $d['date']) { $x = $d; return; } $this->dailyTickets[] = $d; }
    public function updateDailyTicket(string $date, array $patch): void { foreach ($this->dailyTickets as &$x) if ($x['date'] === $date) $x = array_merge($x, $patch, ['updated_at' => gmdate('c')]); }
    public function listDailyTickets(int $limit = 60): array { usort($this->dailyTickets, fn($a, $b) => strcmp($b['date'], $a['date'])); $rows = array_slice($this->dailyTickets, 0, $limit); foreach ($rows as &$d) if (is_string($d['rejection_summary'] ?? null)) $d['rejection_summary'] = json_decode($d['rejection_summary'], true) ?? []; unset($d); return $rows; }
    public function savePerformanceSnapshot(string $asOf, string $window, array $payload): void { foreach ($this->perfSnapshots as &$s) if ($s['as_of'] === $asOf && $s['window'] === $window) { $s['payload'] = $payload; return; } $this->perfSnapshots[] = ['as_of' => $asOf, 'window' => $window, 'payload' => $payload]; }
    public function performanceSnapshots(string $window, int $limit = 30): array { $rows = array_values(array_filter($this->perfSnapshots, fn($s) => $s['window'] === $window)); return array_slice(array_reverse($rows), 0, $limit); }
    public function settledSelections(array $filter = []): array
    {
        $out = [];
        foreach ($this->ticketSelections as $s) {
            $ticket = null;
            foreach ($this->tickets as $t) if ($t['id'] === $s['ticket_id']) { $ticket = $t; break; }
            if ($ticket === null) continue;
            $match = $this->findMatchById((int) $s['match_id']);
            $model = $this->findModelVersion((int) ($ticket['model_version_id'] ?? 0));
            $row = array_merge($s, ['ticket_odds' => $ticket['total_odds'] ?? null, 'ticket_status' => $ticket['settlement_status'] ?? null, 'ticket_stake' => $ticket['stake'] ?? null, 'ticket_created_at' => $ticket['created_at'] ?? null, 'competition' => $match['competition'] ?? null, 'kickoff_at' => $match['kickoff_at'] ?? null, 'model_name' => $model['model_name'] ?? null, 'model_version' => $model['model_version'] ?? null]);
            if (!empty($filter['from']) && ($ticket['created_at'] ?? '') < $filter['from']) continue;
            if (!empty($filter['to']) && ($ticket['created_at'] ?? '') > $filter['to']) continue;
            if (!empty($filter['market']) && ($s['market'] ?? '') !== $filter['market']) continue;
            if (!empty($filter['modelVersionId']) && (int) ($ticket['model_version_id'] ?? 0) !== (int) $filter['modelVersionId']) continue;
            $row['_settled'] = in_array($s['status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true) ? 1 : 0;
            $out[] = $row;
        }
        return $out;
    }
    public function saveTicket(array $t): void { $this->tickets[] = $t; }
    public function findTicket(string $id): ?array { foreach ($this->tickets as $t) if ($t['id'] === $id) return $t; return null; }
    public function listTickets(array $filter = [], int $limit = 500): array
    {
        $rows = $this->tickets;
        if (!empty($filter['from'])) $rows = array_values(array_filter($rows, fn($t) => ($t['created_at'] ?? '') >= $filter['from']));
        if (!empty($filter['to'])) $rows = array_values(array_filter($rows, fn($t) => ($t['created_at'] ?? '') <= $filter['to']));
        if (!empty($filter['status'])) $rows = array_values(array_filter($rows, fn($t) => ($t['settlement_status'] ?? '') === $filter['status']));
        if (!empty($filter['modelVersionId'])) $rows = array_values(array_filter($rows, fn($t) => (int) ($t['model_version_id'] ?? 0) === (int) $filter['modelVersionId']));
        usort($rows, fn($a, $b) => strcmp($b['created_at'] ?? '', $a['created_at'] ?? ''));
        return array_slice($rows, 0, $limit);
    }
    public function updateTicket(string $id, array $patch): void { foreach ($this->tickets as &$t) if ($t['id'] === $id) $t = array_merge($t, $patch); }
    public function saveTicketSelection(array $s): void { $this->ticketSelections[] = array_merge(['id' => count($this->ticketSelections) + 1], $s); }
    public function ticketSelections(string $ticketId): array { return array_values(array_filter($this->ticketSelections, fn($s) => $s['ticket_id'] === $ticketId)); }
    public function updateTicketSelection(int $id, array $patch): void { foreach ($this->ticketSelections as &$s) if ((int) $s['id'] === $id) $s = array_merge($s, $patch); }
    public function oddsBefore(int $matchId, string $timestamp): ?array {
        $limit = strtotime($timestamp);
        if ($limit === false) return null;
        $rows = array_values(array_filter($this->odds, fn($o) => (int) $o['match_id'] === $matchId && strtotime((string) $o['observed_at']) !== false && strtotime((string) $o['observed_at']) < $limit));
        if (!$rows) return null;
        usort($rows, fn($a, $b) => strcmp($b['observed_at'], $a['observed_at']));
        return $rows[0];
    }
    public function recordTicketOutcome(string $ticketId, float $pnl): void { foreach ($this->tickets as &$t) if ($t['id'] === $ticketId) $t['pnl'] = $pnl; }
    public function deleteOldJobRuns(string $cutoff): void { $this->jobRuns = array_values(array_filter($this->jobRuns, fn($r) => ($r['started_at'] ?? '') >= $cutoff)); }
    public function deleteOldHealth(string $cutoff): void { $this->health = array_values(array_filter($this->health, fn($h) => ($h['observed_at'] ?? '') >= $cutoff)); }
}

/** clean risk context */
function fx_risk_ctx(array $over = []): array
{
    return array_merge([
        'killSwitchActive' => false, 'dataQuality' => 0.9, 'syntheticData' => false, 'staleData' => false,
        'equity' => 10000, 'openRiskBySymbol' => [], 'openPositions' => 0, 'dailyPnl' => 0, 'weeklyPnl' => 0, 'peakEquity' => 10000,
    ], $over);
}

function fx_setup(array $over = []): array
{
    return array_merge([
        'action' => 'BUY', 'symbol' => 'EURUSD',
        'entry' => ['type' => 'ZONE', 'min' => 1.0810, 'max' => 1.0820, 'reference' => 1.0815],
        'stopLoss' => 1.0785, 'takeProfit' => [1.0855], 'riskReward' => 2.0,
    ], $over);
}

/** In-memory LotteryRepository for unit tests (mirrors the CI3 model layer). */
class LotteryRepositoryStub implements \Aegis\Persistence\LotteryRepository
{
    public array $lotteries = [];
    public array $rules = [];
    public array $providers = [];
    public array $health = [];
    public array $draws = [];
    public array $numbers = [];
    public array $jobRuns = [];

    private int $autoId = 0;

    public function ensureLottery(string $code, string $name, string $rulesVersion): array
    {
        foreach ($this->lotteries as $l) if ($l['code'] === $code) return $l;
        $row = ['id' => ++$this->autoId, 'code' => $code, 'name' => $name, 'enabled' => 1, 'rules_version' => $rulesVersion, 'created_at' => gmdate('c'), 'updated_at' => gmdate('c')];
        $this->lotteries[] = $row;
        return $row;
    }
    public function listLotteries(): array { return $this->lotteries; }
    public function activeRules(string $lotteryCode): ?array
    {
        foreach (array_reverse($this->rules) as $r) if ($r['lottery_code'] === $lotteryCode && (int) $r['active'] === 1) return $r;
        return null;
    }
    public function saveRules(array $r): int { $row = array_merge(['id' => ++$this->autoId, 'created_at' => gmdate('c')], $r); $this->rules[] = $row; return (int) $row['id']; }
    public function ensureProvider(string $code, string $name): array
    {
        foreach ($this->providers as $p) if ($p['provider_code'] === $code) return $p;
        $row = ['id' => ++$this->autoId, 'provider_code' => $code, 'display_name' => $name, 'enabled' => 0, 'synthetic' => str_contains($code, 'sandbox') ? 1 : 0, 'created_at' => gmdate('c'), 'updated_at' => gmdate('c')];
        $this->providers[] = $row;
        return $row;
    }
    public function listProviders(bool $enabledOnly = false): array { return $enabledOnly ? array_values(array_filter($this->providers, fn($p) => $p['enabled'])) : $this->providers; }
    public function saveHealth(int $providerId, array $h): void { $this->health[] = array_merge($h, ['id' => ++$this->autoId, 'provider_id' => $providerId, 'observed_at' => gmdate('c')]); }
    public function latestHealth(int $providerId): ?array { $rows = $this->listHealth($providerId, 1); return $rows ? $rows[0] : null; }
    public function listHealth(int $providerId, int $limit = 20): array
    {
        $rows = array_values(array_filter($this->health, fn($h) => (int) $h['provider_id'] === $providerId));
        return array_slice(array_reverse($rows), 0, $limit);
    }
    private function decodedDraw(array $d): array { $d['payload'] = json_decode((string) ($d['payload'] ?? ''), true); return $d; }
    public function findDraw(int $id): ?array { foreach ($this->draws as $d) if ((int) $d['id'] === $id) return $this->decodedDraw($d); return null; }
    public function findDrawByExternal(string $lotteryCode, string $externalId): ?array
    {
        foreach ($this->draws as $d) if ($d['lottery_code'] === $lotteryCode && $d['external_id'] === $externalId) return $this->decodedDraw($d);
        return null;
    }
    public function listDraws(array $filter = [], int $limit = 100, string $order = 'DESC'): array
    {
        $rows = $this->draws;
        if (!empty($filter['lotteryCode'])) $rows = array_values(array_filter($rows, fn($d) => $d['lottery_code'] === $filter['lotteryCode']));
        if (!empty($filter['from'])) $rows = array_values(array_filter($rows, fn($d) => $d['draw_date'] >= $filter['from']));
        if (!empty($filter['to'])) $rows = array_values(array_filter($rows, fn($d) => $d['draw_date'] <= $filter['to']));
        if (!empty($filter['verificationStatus'])) $rows = array_values(array_filter($rows, fn($d) => $d['verification_status'] === $filter['verificationStatus']));
        usort($rows, fn($a, $b) => $order === 'ASC' ? strcmp($a['draw_date'], $b['draw_date']) : strcmp($b['draw_date'], $a['draw_date']));
        return array_map(fn($d) => $this->decodedDraw($d), array_slice($rows, 0, $limit));
    }
    public function saveDraw(array $d): array
    {
        $existing = $this->findDrawByExternal($d['lottery_code'], $d['external_id']);
        if ($existing) {
            foreach ($this->draws as &$row) {
                if ((int) $row['id'] === (int) $existing['id']) {
                    $row = array_merge($row, $d, ['updated_at' => gmdate('c')]);
                    break;
                }
            }
            return ['row' => $this->findDraw((int) $existing['id']), 'created' => false];
        }
        $row = array_merge(['id' => ++$this->autoId], $d);
        $this->draws[] = $row;
        return ['row' => $this->findDraw((int) $row['id']), 'created' => true];
    }
    public function listDrawNumbers(int $drawId): array
    {
        $rows = array_values(array_filter($this->numbers, fn($n) => (int) $n['draw_id'] === $drawId));
        usort($rows, fn($a, $b) => strcmp($a['kind'], $b['kind']) ?: $a['position'] <=> $b['position']);
        return $rows;
    }
    public function saveDrawNumbers(int $drawId, array $numbers): void
    {
        $this->numbers = array_values(array_filter($this->numbers, fn($n) => (int) $n['draw_id'] !== $drawId));
        foreach (['main' => 'MAIN', 'stars' => 'STAR'] as $field => $kind) {
            foreach (array_values((array) ($numbers[$field] ?? [])) as $i => $n) {
                $this->numbers[] = ['id' => ++$this->autoId, 'draw_id' => $drawId, 'kind' => $kind, 'position' => $i, 'number' => (int) $n];
            }
        }
    }
    public function drawsForStats(string $lotteryCode, int $limit = 10000): array
    {
        $rows = $this->listDraws(['lotteryCode' => $lotteryCode], $limit, 'ASC');
        $out = [];
        foreach ($rows as $r) {
            $p = is_array($r['payload'] ?? null) ? $r['payload'] : [];
            if (!is_array($p['main'] ?? null) || !is_array($p['stars'] ?? null)) continue;
            $out[] = ['drawDate' => (string) $r['draw_date'], 'main' => array_map('intval', $p['main']), 'stars' => array_map('intval', $p['stars'])];
        }
        return $out;
    }
    public function countDraws(string $lotteryCode): int { return count(array_filter($this->draws, fn($d) => $d['lottery_code'] === $lotteryCode)); }
    public function startJobRun(array $run): ?array
    {
        foreach ($this->jobRuns as $r) if (($r['execution_key'] ?? null) === ($run['executionKey'] ?? null)) return null;
        // store the DB row shape (snake_case columns), not the input shape
        $row = [
            'id' => $run['id'],
            'provider_id' => $run['providerId'] ?? null,
            'job_type' => $run['jobType'],
            'status' => 'RUNNING',
            'started_at' => gmdate('c'),
            'payload' => $run['payload'] ?? null,
            'execution_key' => $run['executionKey'],
        ];
        $this->jobRuns[] = $row;
        return $run;
    }
    public function finishJobRun(string $id, array $result): void
    {
        foreach ($this->jobRuns as &$r) if ((string) $r['id'] === $id) { $r['status'] = $result['status']; $r['ended_at'] = gmdate('c'); $r['records_processed'] = $result['processed'] ?? 0; $r['records_created'] = $result['created'] ?? 0; $r['records_updated'] = $result['updated'] ?? 0; $r['errors'] = json_encode($result['errors'] ?? []); }
    }
    public function listJobRuns(?string $jobType = null, int $limit = 50): array
    {
        $rows = $jobType !== null ? array_values(array_filter($this->jobRuns, fn($r) => $r['job_type'] === $jobType)) : $this->jobRuns;
        return array_slice(array_reverse($rows), 0, $limit);
    }
    public function findJobRunByKey(string $key): ?array
    {
        foreach ($this->jobRuns as $r) if ($r['execution_key'] === $key) return $r;
        return null;
    }
    public function deleteOldJobRuns(string $cutoff): void { $this->jobRuns = array_values(array_filter($this->jobRuns, fn($r) => $r['started_at'] >= $cutoff)); }
    public function deleteOldHealth(string $cutoff): void { $this->health = array_values(array_filter($this->health, fn($h) => $h['observed_at'] >= $cutoff)); }
    public array $combinations = [];
    public array $aiDecisions = [];
    public function saveCombination(array $c): array
    {
        $row = array_merge(['id' => ++$this->autoId], $c);
        $this->combinations[] = $row;
        return ['row' => $this->findCombination((int) $row['id']), 'created' => true];
    }
    public function findCombination(int $id): ?array
    {
        foreach ($this->combinations as $c) if ((int) $c['id'] === $id) {
            $r = $c;
            $r['lines'] = json_decode((string) $r['lines'], true);
            $r['constraints'] = json_decode((string) $r['constraints'], true);
            $r['score_summary'] = json_decode((string) $r['score_summary'], true);
            return $r;
        }
        return null;
    }
    public function listCombinations(int $limit = 50, int $offset = 0): array
    {
        $rows = array_slice(array_reverse($this->combinations), max(0, $offset), min(200, max(1, $limit)));
        return array_map(fn($c) => $this->findCombination((int) $c['id']), $rows);
    }
    public function saveAiDecision(array $d): array
    {
        $row = array_merge(['id' => ++$this->autoId], $d);
        $this->aiDecisions[] = $row;
        return ['row' => $this->findAiDecision((int) $row['id']), 'created' => true];
    }
    public function findAiDecision(int $id): ?array
    {
        foreach ($this->aiDecisions as $d) if ((int) $d['id'] === $id) {
            $r = $d;
            $r['decision'] = json_decode((string) $r['decision'], true);
            return $r;
        }
        return null;
    }
    public function listAiDecisions(?int $combinationId = null, int $limit = 50): array
    {
        $rows = $combinationId !== null
            ? array_values(array_filter($this->aiDecisions, fn($d) => (int) $d['combination_id'] === $combinationId))
            : $this->aiDecisions;
        return array_map(fn($d) => $this->findAiDecision((int) $d['id']), array_slice(array_reverse($rows), 0, min(500, max(1, $limit))));
    }
    public array $tickets = [];
    public array $ticketLines = [];
    public function saveTicket(array $t): array
    {
        $row = array_merge(['id' => ++$this->autoId], $t);
        $this->tickets[] = $row;
        return ['row' => $this->findTicket((int) $row['id']), 'created' => true];
    }
    public function findTicket(int $id, ?int $userId = null): ?array
    {
        foreach ($this->tickets as $t) if ((int) $t['id'] === $id && ($userId === null || (int) $t['user_id'] === $userId)) {
            $r = $t;
            $r['configuration'] = json_decode((string) $r['configuration'], true);
            $r['result'] = $r['result'] !== null ? json_decode((string) $r['result'], true) : null;
            return $r;
        }
        return null;
    }
    public function listTickets(int $userId, int $limit = 50): array
    {
        $rows = array_values(array_filter($this->tickets, fn($t) => (int) $t['user_id'] === $userId));
        usort($rows, fn($a, $b) => (int) $b['id'] <=> (int) $a['id']);
        return array_map(fn($t) => $this->findTicket((int) $t['id'], $userId), array_slice($rows, 0, min(500, max(1, $limit))));
    }
    public function listAllTickets(int $limit = 200): array
    {
        $rows = $this->tickets;
        usort($rows, fn($a, $b) => (int) $b['id'] <=> (int) $a['id']);
        return array_map(fn($t) => $this->findTicket((int) $t['id']), array_slice($rows, 0, min(1000, max(1, $limit))));
    }
    public function updateTicket(int $id, array $patch): void
    {
        foreach ($this->tickets as &$t) if ((int) $t['id'] === $id) $t = array_merge($t, $patch);
    }
    public function ticketLines(int $ticketId): array
    {
        $rows = array_values(array_filter($this->ticketLines, fn($l) => (int) $l['ticket_id'] === $ticketId));
        usort($rows, fn($a, $b) => $a['position'] <=> $b['position']);
        foreach ($rows as &$r) { $r['mains'] = json_decode((string) $r['mains'], true); $r['stars'] = json_decode((string) $r['stars'], true); }
        return $rows;
    }
    public function saveTicketLines(int $ticketId, array $lines): void
    {
        $this->ticketLines = array_values(array_filter($this->ticketLines, fn($l) => (int) $l['ticket_id'] !== $ticketId));
        foreach ($lines as $i => $line) {
            $this->ticketLines[] = ['id' => ++$this->autoId, 'ticket_id' => $ticketId, 'position' => $i, 'mains' => json_encode($line['mains']), 'stars' => json_encode($line['stars']), 'created_at' => gmdate('c')];
        }
    }
    public array $modelVersions = [];
    public array $backtests = [];
    public function ensureModelVersion(array $m): array
    {
        foreach ($this->modelVersions as $v) {
            if ($v['model_name'] === $m['model_name'] && $v['model_version'] === $m['model_version']) {
                $r = $v;
                $r['config'] = json_decode((string) $r['config'], true);
                return $r;
            }
        }
        $row = array_merge(['id' => ++$this->autoId], $m);
        $this->modelVersions[] = $row;
        $row['config'] = json_decode((string) $row['config'], true);
        return $row;
    }
    public function listModelVersions(): array
    {
        $rows = $this->modelVersions;
        foreach ($rows as &$r) { $r['config'] = json_decode((string) $r['config'], true); }
        return $rows;
    }
    public function saveBacktest(array $b): array
    {
        $row = array_merge(['id' => ++$this->autoId], $b);
        $this->backtests[] = $row;
        return ['row' => $this->findBacktest((int) $row['id']), 'created' => true];
    }
    public function findBacktest(int $id): ?array
    {
        foreach ($this->backtests as $b) {
            if ((int) $b['id'] === $id) {
                $r = $b;
                $r['report'] = json_decode((string) $r['report'], true);
                return $r;
            }
        }
        return null;
    }
    public function listBacktests(int $limit = 50): array
    {
        $rows = $this->backtests;
        usort($rows, fn($a, $b) => (int) $b['id'] <=> (int) $a['id']);
        return array_map(fn($b) => $this->findBacktest((int) $b['id']), array_slice($rows, 0, min(500, max(1, $limit))));
    }
}
