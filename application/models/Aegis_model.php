<?php
defined('BASEPATH') or exit('No direct script access allowed');

require_once __DIR__ . '/../libraries/Aegis/autoload.php';

/**
 * AEGIS persistence layer — the ONLY place SQL lives. Exposes typed
 * repositories (implementing the domain interfaces) over CodeIgniter 3's
 * database abstraction: MySQL/MariaDB (mysqli) in production, pdo_sqlite
 * available for the offline dev runtime. JSON documents (agent reports,
 * equity curves…) are stored as TEXT for maximum engine compatibility.
 *
 * insert()-style saves RETURN the record with its generated id.
 */
class Aegis_model extends CI_Model
{
    public object $strategies;
    public object $backtests;
    public object $journal;
    public object $audit;
    public object $identity;
    public object $sports;
    public object $analysis;
    public object $state;
    public object $paper;
    public object $proposals;
    public object $notifications;
    public object $langlearn;

    public function __construct()
    {
        parent::__construct();
        $this->load->database();
        $db = $this->db;

        $this->strategies = new class($db) implements Aegis\Persistence\StrategyRepository {
            public function __construct(private object $db) {}
            public function find(string $id, string $version): ?array {
                $q = $this->db->get_where('strategies', ['strategy_id' => $id, 'version' => $version], 1);
                $row = ($q && is_object($q)) ? $q->row_array() : null;
                return $row ? self::decode($row) : null;
            }
            public function all(): array {
                $rows = $this->db->order_by('strategy_id', 'ASC')->order_by('updated_at', 'ASC')->get('strategies')->result_array();
                return array_map(fn($r) => self::decode($r), $rows);
            }
            public function save(array $record): void {
                $exists = $this->db->from('strategies')
                    ->where(['strategy_id' => $record['strategy_id'], 'version' => $record['version']])
                    ->count_all_results() > 0;
                if ($exists) {
                    $this->db->where(['strategy_id' => $record['strategy_id'], 'version' => $record['version']])
                        ->update('strategies', self::encode($record));
                } else {
                    $this->db->insert('strategies', self::encode($record));
                }
            }
            public function countBacktests(string $strategyId, string $version): int {
                return $this->db->from('backtests')
                    ->where('strategy_id', $strategyId)->where('strategy_version', $version)
                    ->count_all_results();
            }
            public function latestBacktest(string $strategyId, string $version): ?array {
                $row = $this->db->order_by('created_at', 'DESC')->limit(1)
                    ->get_where('backtests', ['strategy_id' => $strategyId, 'strategy_version' => $version])->row_array();
                return $row ? BacktestRepo::decode($row) : null;
            }
            private static function decode(array $row): array {
                return [
                    'strategy_id' => $row['strategy_id'], 'version' => $row['version'],
                    'name' => $row['name'], 'description' => $row['description'],
                    'market_classes' => json_decode($row['market_classes'] ?: '[]', true),
                    'timeframes' => json_decode($row['timeframes'] ?: '[]', true),
                    'params' => json_decode($row['params'] ?: '{}', true),
                    'source' => $row['source'], 'lifecycle' => $row['lifecycle'],
                    'created_at' => $row['created_at'], 'updated_at' => $row['updated_at'],
                    'lifecycle_history' => json_decode($row['lifecycle_history'] ?: '[]', true),
                ];
            }
            private static function encode(array $r): array {
                return [
                    'strategy_id' => $r['strategy_id'], 'version' => $r['version'],
                    'name' => $r['name'], 'description' => $r['description'],
                    'market_classes' => json_encode($r['market_classes']),
                    'timeframes' => json_encode($r['timeframes']),
                    'params' => json_encode($r['params']),
                    'source' => $r['source'], 'lifecycle' => $r['lifecycle'],
                    'created_at' => $r['created_at'], 'updated_at' => $r['updated_at'],
                    'lifecycle_history' => json_encode($r['lifecycle_history']),
                ];
            }
        };

        $this->backtests = new class($db) implements Aegis\Persistence\BacktestRepository {
            public function __construct(private object $db) {}
            public function save(array $record): void {
                $exists = $this->db->from('backtests')->where('id', $record['id'])->count_all_results() > 0;
                if ($exists) $this->db->where('id', $record['id'])->update('backtests', BacktestRepo::encode($record));
                else $this->db->insert('backtests', BacktestRepo::encode($record));
            }
            public function find(string $id): ?array {
                $row = $this->db->get_where('backtests', ['id' => $id], 1)->row_array();
                return $row ? BacktestRepo::decode($row) : null;
            }
            public function list(?string $strategyId = null, int $limit = 50): array {
                if ($strategyId !== null) $this->db->where('strategy_id', $strategyId);
                $rows = $this->db->order_by('created_at', 'DESC')->limit($limit)->get('backtests')->result_array();
                return array_map(fn($r) => BacktestRepo::decode($r), $rows);
            }
        };

        $this->journal = new class($db) implements Aegis\Persistence\JournalRepository {
            public function __construct(private object $db) {}
            public function save(array $e): void {
                $exists = isset($e['id']) && $this->db->from('journal_entries')->where('id', $e['id'])->count_all_results() > 0;
                if ($exists) $this->db->where('id', $e['id'])->update('journal_entries', $e);
                else $this->db->insert('journal_entries', $e);
            }
            public function list(array $filter = [], int $limit = 200): array {
                if (!empty($filter['source'])) $this->db->where('source', $filter['source']);
                if (!empty($filter['strategy'])) $this->db->where('strategy', $filter['strategy']);
                if (!empty($filter['symbol'])) $this->db->where('symbol', $filter['symbol']);
                $rows = $this->db->order_by('execution_time', 'DESC')->limit($limit)->get('journal_entries')->result_array();
                $out = [];
                foreach ($rows as $row) {
                    foreach (['pnl', 'r_multiple', 'ai_confidence', 'entry_price', 'exit_price', 'fees', 'slippage'] as $k) {
                        $row[$k] = $row[$k] !== null ? (float)$row[$k] : null;
                    }
                    $out[] = $row;
                }
                return $out;
            }
        };

        $this->audit = new class($db) implements Aegis\Persistence\AuditRepository {
            public function __construct(private object $db) {}
            public function emit(string $type, string $summary, array $detail = [], string $actor = 'system'): void {
                try {
                    $this->db->insert('audit_logs', [
                        'type' => $type, 'at' => gmdate('c'), 'actor' => $actor,
                        'summary' => mb_substr($summary, 0, 500), 'detail' => json_encode($detail),
                    ]);
                } catch (Throwable $e) { /* audit must never break the pipeline */ }
            }
            public function recent(int $limit = 100): array {
                $rows = $this->db->order_by('id', 'DESC')->limit($limit)->get('audit_logs')->result_array();
                foreach ($rows as &$row) {
                    $row['detail'] = json_decode($row['detail'] ?: 'null', true);
                }
                return $rows;
            }
        };

        $this->sports = new class($db) implements Aegis\Persistence\SportsRepository {
            public function __construct(private object $db) {}
            public function ensureProvider(string $code, string $name): array {
                $row = $this->db->get_where('sports_data_sources', ['provider_code' => $code], 1)->row_array();
                if ($row) return $row;
                $now = gmdate('c'); $this->db->insert('sports_data_sources', ['provider_code' => $code, 'display_name' => $name, 'enabled' => 0, 'created_at' => $now, 'updated_at' => $now]);
                return $this->db->get_where('sports_data_sources', ['id' => $this->db->insert_id()], 1)->row_array();
            }
            public function listProviders(bool $enabledOnly = false): array { if ($enabledOnly) $this->db->where('enabled', 1); return $this->db->order_by('id', 'ASC')->get('sports_data_sources')->result_array(); }
            public function setProviderEnabled(int $id, bool $enabled): void { $this->db->where('id', $id)->update('sports_data_sources', ['enabled' => $enabled ? 1 : 0, 'updated_at' => gmdate('c')]); }
            public function listHealth(int $providerId, int $limit = 20): array { return $this->db->where('provider_id', $providerId)->order_by('observed_at', 'DESC')->limit(min(200, max(1, $limit)))->get('sports_provider_health')->result_array(); }
            public function latestHealth(int $providerId): ?array { $row = $this->db->where('provider_id', $providerId)->order_by('observed_at', 'DESC')->limit(1)->get('sports_provider_health')->row_array(); if ($row) $row['missing_fields'] = json_decode((string) ($row['missing_fields'] ?: '[]'), true); return $row ?: null; }
            public function findMatchById(int $id): ?array { $row = $this->db->get_where('sports_matches', ['id' => $id], 1)->row_array(); if ($row) $row['payload'] = json_decode((string) $row['payload'], true); return $row ?: null; }
            public function listMatches(array $filter = [], int $limit = 200): array {
                if (!empty($filter['status'])) $this->db->where('status', $filter['status']);
                if (!empty($filter['from'])) $this->db->where('kickoff_at >=', $filter['from']);
                if (!empty($filter['to'])) $this->db->where('kickoff_at <=', $filter['to']);
                if (!empty($filter['competition'])) $this->db->like('competition', $filter['competition'], 'after');
                if (!empty($filter['providerId'])) $this->db->where('provider_id', (int) $filter['providerId']);
                $rows = $this->db->order_by('kickoff_at', 'ASC')->limit(min(1000, max(1, $limit)))->get('sports_matches')->result_array();
                foreach ($rows as &$row) $row['payload'] = json_decode((string) $row['payload'], true);
                return $rows;
            }
            public function latestOdds(int $matchId, ?string $market = null, ?string $selection = null): ?array {
                $this->db->where('match_id', $matchId);
                if ($market !== null) $this->db->where('market', $market);
                if ($selection !== null) $this->db->where('selection', $selection);
                $row = $this->db->order_by('observed_at', 'DESC')->limit(1)->get('sports_odds')->row_array();
                if ($row) $row['payload'] = json_decode((string) $row['payload'], true);
                return $row ?: null;
            }
            public function listOdds(int $matchId, int $limit = 50): array {
                $rows = $this->db->where('match_id', $matchId)->order_by('observed_at', 'DESC')->limit(min(500, max(1, $limit)))->get('sports_odds')->result_array();
                foreach ($rows as &$row) $row['payload'] = json_decode((string) $row['payload'], true);
                return $rows;
            }
            public function latestQuality(int $matchId): ?array { $row = $this->db->where('match_id', $matchId)->order_by('assessed_at', 'DESC')->limit(1)->get('sports_data_quality_assessments')->row_array(); if ($row) { $row['missing_fields'] = json_decode((string) $row['missing_fields'], true); $row['checks_payload'] = json_decode((string) $row['checks_payload'], true); } return $row ?: null; }
            public function saveCalibration(array $c): int { $this->db->insert('sports_calibrations', $c); return (int) $this->db->insert_id(); }
            public function findCalibration(int $id): ?array { $row = $this->db->get_where('sports_calibrations', ['id' => $id], 1)->row_array(); if ($row) $row['bins'] = json_decode((string) ($row['bins'] ?: '[]'), true); return $row ?: null; }
            public function listCalibrations(?int $modelVersionId = null, ?string $status = null, int $limit = 50): array { if ($modelVersionId !== null) $this->db->where('model_version_id', $modelVersionId); if ($status !== null) $this->db->where('status', $status); $rows = $this->db->order_by('created_at', 'DESC')->limit(min(200, max(1, $limit)))->get('sports_calibrations')->result_array(); foreach ($rows as &$row) $row['bins'] = json_decode((string) ($row['bins'] ?: '[]'), true); return $rows; }
            public function activeCalibration(int $modelVersionId): ?array { $row = $this->db->where(['model_version_id' => $modelVersionId, 'status' => 'APPROVED'])->order_by('created_at', 'DESC')->limit(1)->get('sports_calibrations')->row_array(); if ($row) $row['bins'] = json_decode((string) ($row['bins'] ?: '[]'), true); return $row ?: null; }
            public function updateCalibrationStatus(int $id, string $status, ?string $actor = null): void { $patch = ['status' => $status]; if ($actor !== null) { $patch['approved_by'] = $actor; $patch['approved_at'] = gmdate('c'); } $this->db->where('id', $id)->update('sports_calibrations', $patch); }
            public function listModelVersions(): array { return $this->db->order_by('id', 'ASC')->get('sports_model_versions')->result_array(); }
            public function findModelVersion(int $id): ?array { return $this->db->get_where('sports_model_versions', ['id' => $id], 1)->row_array() ?: null; }
            public function listPredictions(array $filter = [], int $limit = 200): array {
                if (!empty($filter['matchId'])) $this->db->where('match_id', (int) $filter['matchId']);
                if (!empty($filter['modelVersionId'])) $this->db->where('model_version_id', (int) $filter['modelVersionId']);
                if (!empty($filter['decision'])) $this->db->where('decision', $filter['decision']);
                if (!empty($filter['market'])) $this->db->where('market', $filter['market']);
                if (!empty($filter['from'])) $this->db->where('created_at >=', $filter['from']);
                if (!empty($filter['to'])) $this->db->where('created_at <=', $filter['to']);
                $rows = $this->db->order_by('created_at', 'DESC')->limit(min(2000, max(1, $limit)))->get('sports_predictions')->result_array();
                foreach ($rows as &$row) { $row['rejection_reasons'] = json_decode((string) ($row['rejection_reasons'] ?: '[]'), true); $row['factors'] = json_decode((string) ($row['factors'] ?: '{}'), true); }
                return $rows;
            }
            public function findPrediction(string $id): ?array { $row = $this->db->get_where('sports_predictions', ['id' => $id], 1)->row_array(); if ($row) { $row['rejection_reasons'] = json_decode((string) ($row['rejection_reasons'] ?: '[]'), true); $row['factors'] = json_decode((string) ($row['factors'] ?: '{}'), true); } return $row ?: null; }
            public function predictionOutcomes(?int $modelVersionId = null): array {
                $this->db->select('p.*, m.competition AS league, r.home_score, r.away_score')
                    ->from('sports_predictions p')
                    ->join('sports_matches m', 'm.id = p.match_id')
                    ->join('sports_results r', "r.match_id = p.match_id AND r.verified = 1 AND r.status = 'FINISHED'", 'inner');
                if ($modelVersionId !== null) $this->db->where('p.model_version_id', $modelVersionId);
                $rows = $this->db->get()->result_array();
                $out = [];
                foreach ($rows as $row) {
                    $total = (int) $row['home_score'] + (int) $row['away_score'];
                    // Binary outcome per predicted market; unknown markets are excluded (never guessed).
                    if ($row['market'] === 'TOTAL_GOALS' && $row['selection'] === 'OVER_1_5') $row['outcome'] = $total > 1 ? 1 : 0;
                    elseif ($row['market'] === 'TOTAL_GOALS' && $row['selection'] === 'UNDER_1_5') $row['outcome'] = $total <= 1 ? 1 : 0;
                    else continue;
                    $out[] = $row;
                }
                return $out;
            }
            public function activeConfiguration(): ?array { $row = $this->db->order_by('version', 'DESC')->limit(1)->get('sports_configurations')->row_array(); if ($row) { $row['allowed_markets'] = json_decode((string) $row['allowed_markets'], true) ?: []; $row['allowed_leagues'] = json_decode((string) $row['allowed_leagues'], true) ?: []; } return $row ?: null; }
            public function listConfigurations(int $limit = 20): array { $rows = $this->db->order_by('version', 'DESC')->limit(min(200, max(1, $limit)))->get('sports_configurations')->result_array(); foreach ($rows as &$row) { $row['allowed_markets'] = json_decode((string) $row['allowed_markets'], true) ?: []; $row['allowed_leagues'] = json_decode((string) $row['allowed_leagues'], true) ?: []; } return $rows; }
            public function saveConfiguration(array $c): int { $this->db->insert('sports_configurations', $c); return (int) $this->db->insert_id(); }
            public function findConfiguration(int $id): ?array { $row = $this->db->get_where('sports_configurations', ['id' => $id], 1)->row_array(); if ($row) { $row['allowed_markets'] = json_decode((string) $row['allowed_markets'], true) ?: []; $row['allowed_leagues'] = json_decode((string) $row['allowed_leagues'], true) ?: []; } return $row ?: null; }
            public function findResultByMatch(int $matchId): ?array { $row = $this->db->where('match_id', $matchId)->order_by('verified', 'DESC')->order_by('id', 'DESC')->limit(1)->get('sports_results')->row_array(); if ($row) $row['payload'] = json_decode((string) $row['payload'], true); return $row ?: null; }
            public function recordTicketOutcome(string $ticketId, float $pnl): void { $this->db->where('id', $ticketId)->update('sports_tickets', ['pnl' => $pnl]); }
            public function oddsBefore(int $matchId, string $timestamp): ?array {
                // Timestamps are stored in ISO-8601 ('Y-m-dTH:i:s+00:00'); compare by
                // epoch, not string, so mixed formats can never misorder.
                $limit = strtotime($timestamp);
                if ($limit === false) return null;
                $rows = $this->db->where('match_id', $matchId)->order_by('observed_at', 'DESC')->limit(500)->get('sports_odds')->result_array();
                foreach ($rows as $row) {
                    $at = strtotime((string) $row['observed_at']);
                    if ($at !== false && $at < $limit) { $row['payload'] = json_decode((string) $row['payload'], true); return $row; }
                }
                return null;
            }
            public function deleteOldJobRuns(string $cutoff): void { $this->db->where('started_at <', $cutoff)->delete('sports_job_runs'); }
            public function deleteOldHealth(string $cutoff): void { $this->db->where('observed_at <', $cutoff)->delete('sports_provider_health'); }
            public function startJobRun(array $run): ?array {
                if ($this->db->get_where('sports_job_runs', ['execution_key' => $run['executionKey']], 1)->row_array()) return null;
                $this->db->insert('sports_job_runs', ['id' => $run['id'], 'job_type' => $run['jobType'], 'status' => 'RUNNING', 'started_at' => gmdate('c'), 'execution_key' => $run['executionKey'], 'provider' => $run['provider'] ?? null]); return $run;
            }
            public function finishJobRun(string $id, array $result): void { $this->db->where('id', $id)->update('sports_job_runs', ['status' => $result['status'], 'ended_at' => gmdate('c'), 'records_processed' => $result['processed'] ?? 0, 'records_created' => $result['created'] ?? 0, 'records_updated' => $result['updated'] ?? 0, 'errors' => json_encode($result['errors'] ?? [])]); }
            public function listJobRuns(?string $jobType = null, int $limit = 50): array { if ($jobType !== null) $this->db->where('job_type', $jobType); $rows = $this->db->order_by('started_at', 'DESC')->limit(min(500, max(1, $limit)))->get('sports_job_runs')->result_array(); foreach ($rows as &$row) $row['errors'] = json_decode((string) ($row['errors'] ?: '[]'), true); return $rows; }
            public function saveBacktest(array $b): void { $this->db->insert('sports_backtests', $b); }
            public function findBacktest(string $id): ?array { $row = $this->db->get_where('sports_backtests', ['id' => $id], 1)->row_array(); if ($row) { $row['params'] = json_decode((string) $row['params'], true); $row['report'] = json_decode((string) $row['report'], true); } return $row ?: null; }
            public function listBacktests(int $limit = 20): array { $rows = $this->db->order_by('created_at', 'DESC')->limit(min(200, max(1, $limit)))->get('sports_backtests')->result_array(); foreach ($rows as &$row) { $row['params'] = json_decode((string) $row['params'], true); $row['report'] = json_decode((string) $row['report'], true); } return $rows; }
            public function saveModelMetrics(array $m): void { $this->db->insert('sports_model_metrics', $m); }
            public function listModelMetrics(?int $modelVersionId = null, ?int $windowDays = null, ?string $sampleType = null, int $limit = 200): array { if ($modelVersionId !== null) $this->db->where('model_version_id', $modelVersionId); if ($windowDays !== null) $this->db->where('window_days', $windowDays); if ($sampleType !== null) $this->db->where('sample_type', $sampleType); return $this->db->order_by('computed_at', 'DESC')->limit(min(1000, max(1, $limit)))->get('sports_model_metrics')->result_array(); }
            public function findDailyTicket(string $date): ?array { $row = $this->db->get_where('sports_daily_tickets', ['date' => $date], 1)->row_array(); if ($row) $row['rejection_summary'] = json_decode((string) ($row['rejection_summary'] ?: '{}'), true); return $row ?: null; }
            public function saveDailyTicket(array $d): void { $row = $this->db->get_where('sports_daily_tickets', ['date' => $d['date']], 1)->row_array(); if ($row) $this->db->where('date', $d['date'])->update('sports_daily_tickets', $d); else $this->db->insert('sports_daily_tickets', $d); }
            public function updateDailyTicket(string $date, array $patch): void { $this->db->where('date', $date)->update('sports_daily_tickets', array_merge($patch, ['updated_at' => gmdate('c')])); }
            public function listDailyTickets(int $limit = 60): array { $rows = $this->db->order_by('date', 'DESC')->limit(min(366, max(1, $limit)))->get('sports_daily_tickets')->result_array(); foreach ($rows as &$row) $row['rejection_summary'] = json_decode((string) ($row['rejection_summary'] ?: '{}'), true); return $rows; }
            public function savePerformanceSnapshot(string $asOf, string $window, array $payload): void {
                $existing = $this->db->get_where('sports_performance_snapshots', ['as_of' => $asOf, 'window' => $window], 1)->row_array();
                $data = ['as_of' => $asOf, 'window' => $window, 'payload' => json_encode($payload)];
                if ($existing) $this->db->where('id', $existing['id'])->update('sports_performance_snapshots', $data); else $this->db->insert('sports_performance_snapshots', $data);
            }
            public function performanceSnapshots(string $window, int $limit = 30): array { $rows = $this->db->where('window', $window)->order_by('as_of', 'DESC')->limit(min(366, max(1, $limit)))->get('sports_performance_snapshots')->result_array(); foreach ($rows as &$row) $row['payload'] = json_decode((string) $row['payload'], true); return $rows; }
            public function settledSelections(array $filter = []): array {
                $this->db->select('s.*, t.total_odds AS ticket_odds, t.settlement_status AS ticket_status, t.stake AS ticket_stake, m.competition, m.kickoff_at, mv.model_name, mv.model_version')
                    ->from('sports_ticket_selections s')
                    ->join('sports_tickets t', 't.id = s.ticket_id', 'inner')
                    ->join('sports_matches m', 'm.id = s.match_id', 'left')
                    ->join('sports_model_versions mv', 'mv.id = t.model_version_id', 'left');
                if (!empty($filter['from'])) $this->db->where('t.created_at >=', $filter['from']);
                if (!empty($filter['to'])) $this->db->where('t.created_at <=', $filter['to']);
                if (!empty($filter['market'])) $this->db->where('s.market', $filter['market']);
                if (!empty($filter['modelVersionId'])) $this->db->where('t.model_version_id', (int) $filter['modelVersionId']);
                $rows = $this->db->get()->result_array();
                foreach ($rows as &$row) if (!in_array($row['status'] ?? '', ['WON', 'LOST', 'VOID', 'CANCELLED'], true)) $row['_settled'] = 0; else $row['_settled'] = 1;
                return $rows;
            }
            public function saveHealth(int $providerId, array $h): void {
                $this->db->insert('sports_provider_health', ['provider_id' => $providerId, 'status' => $h['status'], 'response_ms' => $h['responseMs'] ?? null, 'error_rate' => $h['errorRate'] ?? null, 'rate_limit_remaining' => $h['rateLimitRemaining'] ?? null, 'last_success_at' => $h['lastSuccessAt'] ?? null, 'last_failure_at' => $h['lastFailureAt'] ?? null, 'last_fixture_sync_at' => $h['lastFixtureSyncAt'] ?? null, 'last_odds_sync_at' => $h['lastOddsSyncAt'] ?? null, 'last_result_sync_at' => $h['lastResultSyncAt'] ?? null, 'data_freshness_seconds' => $h['dataFreshnessSeconds'] ?? null, 'records_received' => $h['recordsReceived'] ?? 0, 'invalid_records' => $h['invalidRecords'] ?? 0, 'missing_fields' => json_encode($h['missingFields'] ?? []), 'observed_at' => gmdate('c')]);
            }
            public function saveMatch(int $providerId, array $m): array {
                $row = $this->db->get_where('sports_matches', ['provider_id' => $providerId, 'external_id' => $m['externalId']], 1)->row_array();
                $data = ['sport' => $m['sport'], 'competition' => $m['competition'], 'home_team' => $m['homeTeam'], 'away_team' => $m['awayTeam'], 'kickoff_at' => $m['kickoff'], 'status' => $m['status'], 'source_timestamp' => $m['sourceTimestamp'], 'payload' => json_encode($m), 'updated_at' => gmdate('c')];
                if ($row) { $this->db->where('id', $row['id'])->update('sports_matches', $data); return array_merge($row, $data); }
                $this->db->insert('sports_matches', array_merge(['provider_id' => $providerId, 'external_id' => $m['externalId'], 'created_at' => gmdate('c')], $data)); return array_merge($data, ['id' => (int)$this->db->insert_id(), 'provider_id' => $providerId, 'external_id' => $m['externalId']]);
            }
            public function findMatch(int $providerId, string $externalId): ?array { return $this->db->get_where('sports_matches', ['provider_id' => $providerId, 'external_id' => $externalId], 1)->row_array() ?: null; }
            public function saveOdds(int $matchId, int $providerId, array $odds): void { $this->db->insert('sports_odds', ['match_id' => $matchId, 'provider_id' => $providerId, 'market' => $odds['market'], 'selection' => $odds['selection'], 'decimal_odds' => $odds['decimalOdds'], 'observed_at' => $odds['observedAt'], 'payload' => json_encode($odds)]); }
            public function saveResult(int $matchId, int $providerId, array $r): void { $row=$this->db->get_where('sports_results',['match_id'=>$matchId,'provider_id'=>$providerId],1)->row_array(); $data=['home_score'=>$r['homeScore'],'away_score'=>$r['awayScore'],'status'=>$r['status'],'verified'=>0,'source_timestamp'=>$r['sourceTimestamp'],'verified_at'=>null,'payload'=>json_encode($r['payload'])]; if($row)$this->db->where('id',$row['id'])->update('sports_results',$data); else $this->db->insert('sports_results',array_merge(['match_id'=>$matchId,'provider_id'=>$providerId],$data)); }
            public function findResult(int $matchId,int $providerId): ?array { return $this->db->get_where('sports_results',['match_id'=>$matchId,'provider_id'=>$providerId],1)->row_array() ?: null; }
            public function verifyResult(int $id): void { $this->db->where('id',$id)->update('sports_results',['verified'=>1,'verified_at'=>gmdate('c')]); }
            public function saveQuality(int $matchId, array $a): void { $this->db->insert('sports_data_quality_assessments', ['match_id' => $matchId, 'score' => $a['score'], 'band' => $a['band'], 'freshness_score' => $a['freshnessScore'], 'provider_reliability_score' => $a['providerReliabilityScore'], 'eligible_prediction' => $a['eligibleForPrediction'] ? 1 : 0, 'eligible_ticket' => $a['eligibleForTicket'] ? 1 : 0, 'missing_fields' => json_encode($a['missing']), 'checks_payload' => json_encode($a['checks']), 'assessed_at' => gmdate('c')]); }
            public function startSync(array $run): ?array {
                if ($this->db->get_where('sports_sync_runs', ['execution_key' => $run['executionKey']], 1)->row_array()) return null;
                $this->db->insert('sports_sync_runs', ['id' => $run['id'], 'provider_id' => $run['providerId'] ?? null, 'job_type' => $run['jobType'], 'status' => 'RUNNING', 'started_at' => gmdate('c'), 'execution_key' => $run['executionKey']]); return $run;
            }
            public function finishSync(string $id, array $result): void { $this->db->where('id', $id)->update('sports_sync_runs', ['status' => $result['status'], 'ended_at' => gmdate('c'), 'records_processed' => $result['processed'] ?? 0, 'records_created' => $result['created'] ?? 0, 'records_updated' => $result['updated'] ?? 0, 'errors' => json_encode($result['errors'] ?? [])]); }
            public function ensureModelVersion(array $m): int { $row = $this->db->get_where('sports_model_versions', ['model_name' => $m['modelName'], 'model_version' => $m['modelVersion']], 1)->row_array(); if ($row) return (int)$row['id']; $this->db->insert('sports_model_versions', ['model_name' => $m['modelName'], 'model_version' => $m['modelVersion'], 'feature_version' => $m['featureVersion'], 'calibration_version' => $m['calibrationVersion'] ?? null, 'status' => $m['status'] ?? 'APPROVED', 'created_at' => gmdate('c')]); return (int)$this->db->insert_id(); }
            public function savePrediction(array $p): void { $this->db->insert('sports_predictions', $p); }
            public function saveTicket(array $t): void { $this->db->insert('sports_tickets', $t); }
            public function saveTicketSelection(array $s): void { $this->db->insert('sports_ticket_selections', $s); }
            public function ticketSelections(string $ticketId): array { return $this->db->get_where('sports_ticket_selections', ['ticket_id' => $ticketId])->result_array(); }
            public function updateTicketSelection(int $id, array $patch): void { $this->db->where('id', $id)->update('sports_ticket_selections', $patch); }
            public function findTicket(string $id): ?array { return $this->db->get_where('sports_tickets', ['id' => $id], 1)->row_array() ?: null; }
            public function listTickets(array $filter = [], int $limit = 500): array { if(!empty($filter['from']))$this->db->where('created_at >=',$filter['from']); if(!empty($filter['to']))$this->db->where('created_at <=',$filter['to']); if(!empty($filter['status']))$this->db->where('settlement_status',$filter['status']); if(!empty($filter['modelVersionId']))$this->db->where('model_version_id',(int)$filter['modelVersionId']); return $this->db->order_by('created_at','DESC')->limit(min(500,max(1,$limit)))->get('sports_tickets')->result_array(); }
            public function updateTicket(string $id, array $patch): void { $this->db->where('id', $id)->update('sports_tickets', $patch); }
        };

        $this->lottery = new class($db) implements Aegis\Persistence\LotteryRepository {
            public function __construct(private object $db) {}
            public function ensureLottery(string $code, string $name, string $rulesVersion): array {
                $q = $this->db->get_where('lotteries', ['code' => $code], 1); $row = ($q && is_object($q)) ? $q->row_array() : null;
                if ($row) {
                    if ((string) $row['rules_version'] !== $rulesVersion) {
                        $this->db->where('id', $row['id'])->update('lotteries', ['rules_version' => $rulesVersion, 'updated_at' => gmdate('c')]);
                        $q2 = $this->db->get_where('lotteries', ['id' => $row['id']], 1); $row = ($q2 && is_object($q2)) ? $q2->row_array() : $row;
                    }
                    return $row;
                }
                $now = gmdate('c');
                $this->db->insert('lotteries', ['code' => $code, 'name' => $name, 'enabled' => 1, 'rules_version' => $rulesVersion, 'created_at' => $now, 'updated_at' => $now]);
                $q3 = $this->db->get_where('lotteries', ['code' => $code], 1); return ($q3 && is_object($q3)) ? $q3->row_array() : ['code' => $code, 'name' => $name, 'enabled' => 1, 'rules_version' => $rulesVersion, 'created_at' => $now, 'updated_at' => $now];
            }
            public function listLotteries(): array { $q = $this->db->order_by('id', 'ASC')->get('lotteries'); return ($q && is_object($q)) ? $q->result_array() : []; }
            public function activeRules(string $lotteryCode): ?array { $q = $this->db->where(['lottery_code' => $lotteryCode, 'active' => 1])->order_by('id', 'DESC')->limit(1)->get('lottery_rules'); $row = ($q && is_object($q)) ? $q->row_array() : null; return $row ?: null; }
            public function saveRules(array $r): int { $this->db->insert('lottery_rules', $r); return (int) $this->db->insert_id(); }
            public function ensureProvider(string $code, string $name): array {
                $q = $this->db->get_where('lottery_data_sources', ['provider_code' => $code], 1); $row = ($q && is_object($q)) ? $q->row_array() : null;
                if ($row) return $row;
                $now = gmdate('c');
                $this->db->insert('lottery_data_sources', ['provider_code' => $code, 'display_name' => $name, 'enabled' => 0, 'synthetic' => str_contains($code, 'sandbox') ? 1 : 0, 'created_at' => $now, 'updated_at' => $now]);
                $q2 = $this->db->get_where('lottery_data_sources', ['provider_code' => $code], 1); return ($q2 && is_object($q2)) ? $q2->row_array() : ['provider_code' => $code, 'display_name' => $name, 'enabled' => 0, 'synthetic' => str_contains($code, 'sandbox') ? 1 : 0, 'created_at' => $now, 'updated_at' => $now];
            }
            public function listProviders(bool $enabledOnly = false): array { if ($enabledOnly) $this->db->where('enabled', 1); $q = $this->db->order_by('id', 'ASC')->get('lottery_data_sources'); return ($q && is_object($q)) ? $q->result_array() : []; }
            public function saveHealth(int $providerId, array $health): void { $row = array_merge($health, ['provider_id' => $providerId, 'observed_at' => gmdate('c')]); unset($row['id']); $this->db->insert('lottery_provider_health', $row); }
            public function latestHealth(int $providerId): ?array { $row = $this->db->where('provider_id', $providerId)->order_by('observed_at', 'DESC')->limit(1)->get('lottery_provider_health')->row_array(); return $row ?: null; }
            public function listHealth(int $providerId, int $limit = 20): array { return $this->db->where('provider_id', $providerId)->order_by('observed_at', 'DESC')->limit(min(200, max(1, $limit)))->get('lottery_provider_health')->result_array(); }
            public function findDraw(int $id): ?array { $row = $this->db->get_where('lottery_draws', ['id' => $id], 1)->row_array(); if ($row) $row['payload'] = json_decode((string) $row['payload'], true); return $row ?: null; }
            public function findDrawByExternal(string $lotteryCode, string $externalId): ?array { $row = $this->db->get_where('lottery_draws', ['lottery_code' => $lotteryCode, 'external_id' => $externalId], 1)->row_array(); if ($row) $row['payload'] = json_decode((string) $row['payload'], true); return $row ?: null; }
            public function listDraws(array $filter = [], int $limit = 100, string $order = 'DESC'): array {
                if (!empty($filter['lotteryCode'])) $this->db->where('lottery_code', $filter['lotteryCode']);
                if (!empty($filter['from'])) $this->db->where('draw_date >=', $filter['from']);
                if (!empty($filter['to'])) $this->db->where('draw_date <=', $filter['to']);
                if (!empty($filter['verificationStatus'])) $this->db->where('verification_status', $filter['verificationStatus']);
                $rows = $this->db->order_by('draw_date', $order === 'ASC' ? 'ASC' : 'DESC')->limit(min(100000, max(1, $limit)))->get('lottery_draws')->result_array();
                foreach ($rows as &$row) $row['payload'] = json_decode((string) $row['payload'], true);
                return $rows;
            }
            public function saveDraw(array $d): array {
                $existing = $this->db->get_where('lottery_draws', ['lottery_code' => $d['lottery_code'], 'external_id' => $d['external_id']], 1)->row_array();
                if ($existing) {
                    $patch = ['jackpot' => $d['jackpot'] ?? null, 'rollover' => !empty($d['rollover']) ? 1 : 0, 'source' => $d['source'], 'source_timestamp' => $d['source_timestamp'], 'retrieved_at' => $d['retrieved_at'], 'verification_status' => $d['verification_status'], 'payload' => $d['payload'], 'updated_at' => gmdate('c')];
                    $this->db->where('id', $existing['id'])->update('lottery_draws', $patch);
                    return ['row' => $this->findDraw((int) $existing['id']), 'created' => false];
                }
                $this->db->insert('lottery_draws', $d);
                $id = (int) $this->db->insert_id();
                return ['row' => $this->findDraw($id), 'created' => true];
            }
            public function listDrawNumbers(int $drawId): array { return $this->db->where('draw_id', $drawId)->order_by('kind', 'ASC')->order_by('position', 'ASC')->get('lottery_draw_numbers')->result_array(); }
            public function saveDrawNumbers(int $drawId, array $numbers): void {
                $this->db->where('draw_id', $drawId)->delete('lottery_draw_numbers');
                foreach (['main' => 'MAIN', 'stars' => 'STAR'] as $field => $kind) {
                    foreach (array_values((array) ($numbers[$field] ?? [])) as $i => $n) {
                        $this->db->insert('lottery_draw_numbers', ['draw_id' => $drawId, 'kind' => $kind, 'position' => $i, 'number' => (int) $n]);
                    }
                }
            }
            public function drawsForStats(string $lotteryCode, int $limit = 10000): array {
                $rows = $this->listDraws(['lotteryCode' => $lotteryCode], $limit, 'ASC');
                $out = [];
                foreach ($rows as $r) {
                    $p = is_array($r['payload']) ? $r['payload'] : [];
                    if (!is_array($p['main'] ?? null) || !is_array($p['stars'] ?? null)) continue;
                    $out[] = ['drawDate' => (string) $r['draw_date'], 'main' => array_map('intval', $p['main']), 'stars' => array_map('intval', $p['stars'])];
                }
                return $out;
            }
            public function countDraws(string $lotteryCode): int { return (int) $this->db->where('lottery_code', $lotteryCode)->count_all_results('lottery_draws'); }
            public function startJobRun(array $run): ?array {
                if ($this->db->get_where('lottery_sync_runs', ['execution_key' => $run['executionKey']], 1)->row_array()) return null;
                $this->db->insert('lottery_sync_runs', ['id' => $run['id'], 'provider_id' => $run['providerId'] ?? null, 'job_type' => $run['jobType'], 'status' => 'RUNNING', 'started_at' => gmdate('c'), 'payload' => $run['payload'] ?? null, 'execution_key' => $run['executionKey']]);
                return $run;
            }
            public function findJobRunByKey(string $key): ?array { return $this->db->get_where('lottery_sync_runs', ['execution_key' => $key], 1)->row_array() ?: null; }
            public function finishJobRun(string $id, array $result): void { $this->db->where('id', $id)->update('lottery_sync_runs', ['status' => $result['status'], 'ended_at' => gmdate('c'), 'records_processed' => $result['processed'] ?? 0, 'records_created' => $result['created'] ?? 0, 'records_updated' => $result['updated'] ?? 0, 'errors' => json_encode($result['errors'] ?? [])]); }
            public function listJobRuns(?string $jobType = null, int $limit = 50): array { if ($jobType !== null) $this->db->where('job_type', $jobType); return $this->db->order_by('started_at', 'DESC')->limit(min(500, max(1, $limit)))->get('lottery_sync_runs')->result_array(); }
            public function deleteOldJobRuns(string $cutoff): void { $this->db->where('started_at <', $cutoff)->delete('lottery_sync_runs'); }
            public function deleteOldHealth(string $cutoff): void { $this->db->where('observed_at <', $cutoff)->delete('lottery_provider_health'); }
            public function saveCombination(array $c): array
            {
                $this->db->insert('lottery_combinations', $c);
                return ['row' => $this->findCombination((int) $this->db->insert_id()), 'created' => true];
            }
            public function findCombination(int $id): ?array
            {
                $row = $this->db->get_where('lottery_combinations', ['id' => $id], 1)->row_array();
                if (!$row) return null;
                $row['lines'] = json_decode((string) $row['lines'], true);
                $row['constraints'] = json_decode((string) $row['constraints'], true);
                $row['score_summary'] = json_decode((string) $row['score_summary'], true);
                return $row;
            }
            public function listCombinations(int $limit = 50, int $offset = 0): array
            {
                $rows = $this->db->order_by('id', 'DESC')->offset(max(0, $offset))->limit(min(200, max(1, $limit)))->get('lottery_combinations')->result_array();
                return array_map(fn($r) => $this->findCombination((int) $r['id']), $rows);
            }
            public function saveAiDecision(array $d): array
            {
                $this->db->insert('lottery_ai_decisions', $d);
                return ['row' => $this->findAiDecision((int) $this->db->insert_id()), 'created' => true];
            }
            public function findAiDecision(int $id): ?array
            {
                $row = $this->db->get_where('lottery_ai_decisions', ['id' => $id], 1)->row_array();
                if (!$row) return null;
                $row['decision'] = json_decode((string) $row['decision'], true);
                return $row;
            }
            public function listAiDecisions(?int $combinationId = null, int $limit = 50): array
            {
                if ($combinationId !== null) $this->db->where('combination_id', $combinationId);
                $rows = $this->db->order_by('id', 'DESC')->limit(min(500, max(1, $limit)))->get('lottery_ai_decisions')->result_array();
                return array_map(fn($r) => $this->findAiDecision((int) $r['id']), $rows);
            }
            public function saveTicket(array $t): array
            {
                $this->db->insert('lottery_tickets', $t);
                $row = $this->db->get_where('lottery_tickets', ['id' => $this->db->insert_id()], 1)->row_array();
                if ($row) { $row['configuration'] = json_decode((string) $row['configuration'], true); $row['result'] = $row['result'] !== null ? json_decode((string) $row['result'], true) : null; }
                return ['row' => $row, 'created' => true];
            }
            public function findTicket(int $id, ?int $userId = null): ?array
            {
                if ($userId !== null) $this->db->where('user_id', $userId);
                $row = $this->db->where('id', $id)->limit(1)->get('lottery_tickets')->row_array();
                if (!$row) return null;
                $row['configuration'] = json_decode((string) $row['configuration'], true);
                $row['result'] = $row['result'] !== null ? json_decode((string) $row['result'], true) : null;
                return $row;
            }
            public function listTickets(int $userId, int $limit = 50): array
            {
                $rows = $this->db->where('user_id', $userId)->order_by('id', 'DESC')->limit(min(500, max(1, $limit)))->get('lottery_tickets')->result_array();
                return array_map(fn($r) => $this->findTicket((int) $r['id'], $userId), $rows);
            }
            public function listAllTickets(int $limit = 200): array
            {
                $rows = $this->db->order_by('id', 'DESC')->limit(min(1000, max(1, $limit)))->get('lottery_tickets')->result_array();
                return array_map(fn($r) => $this->findTicket((int) $r['id']), $rows);
            }
            public function updateTicket(int $id, array $patch): void { $this->db->where('id', $id)->update('lottery_tickets', $patch); }
            public function ticketLines(int $ticketId): array
            {
                $rows = $this->db->where('ticket_id', $ticketId)->order_by('position', 'ASC')->get('lottery_ticket_lines')->result_array();
                foreach ($rows as &$r) { $r['mains'] = json_decode((string) $r['mains'], true); $r['stars'] = json_decode((string) $r['stars'], true); }
                return $rows;
            }
            public function saveTicketLines(int $ticketId, array $lines): void
            {
                $this->db->where('ticket_id', $ticketId)->delete('lottery_ticket_lines');
                foreach ($lines as $i => $line) {
                    $this->db->insert('lottery_ticket_lines', ['ticket_id' => $ticketId, 'position' => $i, 'mains' => json_encode($line['mains']), 'stars' => json_encode($line['stars']), 'created_at' => gmdate('c')]);
                }
            }
            public function ensureModelVersion(array $m): array
            {
                $row = $this->db->get_where('lottery_model_versions', ['model_name' => $m['model_name'], 'model_version' => $m['model_version']], 1)->row_array();
                if ($row) {
                    $row['config'] = json_decode((string) $row['config'], true);
                    return $row;
                }
                $this->db->insert('lottery_model_versions', $m);
                $row = $this->db->get_where('lottery_model_versions', ['id' => $this->db->insert_id()], 1)->row_array();
                $row['config'] = json_decode((string) $row['config'], true);
                return $row;
            }
            public function listModelVersions(): array
            {
                $rows = $this->db->order_by('id', 'ASC')->get('lottery_model_versions')->result_array();
                foreach ($rows as &$r) { $r['config'] = json_decode((string) $r['config'], true); }
                return $rows;
            }
            public function saveBacktest(array $b): array
            {
                $this->db->insert('lottery_backtests', $b);
                return ['row' => $this->findBacktest((int) $this->db->insert_id()), 'created' => true];
            }
            public function findBacktest(int $id): ?array
            {
                $row = $this->db->get_where('lottery_backtests', ['id' => $id], 1)->row_array();
                if (!$row) return null;
                $row['report'] = json_decode((string) $row['report'], true);
                return $row;
            }
            public function listBacktests(int $limit = 50): array
            {
                $rows = $this->db->order_by('id', 'DESC')->limit(min(500, max(1, $limit)))->get('lottery_backtests')->result_array();
                return array_map(fn($r) => $this->findBacktest((int) $r['id']), $rows);
            }
        };

        $this->identity = new class($db) implements Aegis\Persistence\IdentityRepository {
            public function __construct(private object $db) {}
            public function findUserByEmail(string $email): ?array { return $this->db->get_where('users', ['email' => $email], 1)->row_array() ?: null; }
            public function findUserByUsername(string $username): ?array { return $this->db->get_where('users', ['username' => strtolower(trim($username))], 1)->row_array() ?: null; }
            public function findUserByUid(string $uid): ?array {
                $uid = preg_replace('/\D/', '', (string) $uid);
                if (strlen($uid) !== 6) return null;
                return $this->db->get_where('users', ['user_uid' => $uid], 1)->row_array() ?: null;
            }
            public function findUserById(int $id): ?array { return $this->db->get_where('users', ['id' => $id], 1)->row_array() ?: null; }
            public function findUserByIdentifier(string $identifier): ?array {
                $identifier = trim($identifier);
                if ($identifier === '') return null;
                if (filter_var($identifier, FILTER_VALIDATE_EMAIL)) {
                    return $this->findUserByEmail(strtolower($identifier));
                }
                if (preg_match('/^\d{6}$/', $identifier)) {
                    return $this->findUserByUid($identifier);
                }
                return $this->findUserByUsername($identifier);
            }
            public function createUser(array $user): array {
                $user['username'] = strtolower(trim((string) ($user['username'] ?? '')));
                if ($user['username'] === '') {
                    $user['username'] = $this->generateUniqueUsername((string) ($user['display_name'] ?? ''));
                }
                if (empty($user['user_uid'])) $user['user_uid'] = $this->generateUniqueUid();
                $user['profile_image'] = $user['profile_image'] ?? null;
                $this->db->insert('users', $user); $user['id'] = (int) $this->db->insert_id(); return $user;
            }
            public function updateUser(int $id, array $patch): void {
                $this->db->where('id', $id)->update('users', array_merge($patch, ['updated_at' => gmdate('c')]));
            }
            public function usernameTaken(string $username, ?int $exceptId = null): bool {
                $this->db->where('username', strtolower(trim($username)));
                if ($exceptId !== null) $this->db->where('id !=', $exceptId);
                return (bool) $this->db->limit(1)->get('users')->row_array();
            }
            public function emailTaken(string $email, ?int $exceptId = null): bool {
                $this->db->where('email', strtolower(trim($email)));
                if ($exceptId !== null) $this->db->where('id !=', $exceptId);
                return (bool) $this->db->limit(1)->get('users')->row_array();
            }
            public function generateUniqueUsername(string $base): string {
                $base = strtolower(preg_replace('/[^A-Za-z0-9_]/', '', str_replace(' ', '_', (string) $base)));
                $base = substr($base, 0, 16);
                if ($base === '' || !preg_match('/^[a-z]/', $base)) $base = 'u' . $base;
                $base = str_pad($base, 3, '_');
                $candidate = substr($base, 0, 18);
                $n = 1;
                while ($this->usernameTaken($candidate)) { $candidate = substr($base, 0, max(2, 18 - strlen((string) $n))) . $n; $n++; }
                return $candidate;
            }
            public function generateUniqueUid(): string {
                do { $uid = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT); }
                while ((bool) $this->db->get_where('users', ['user_uid' => $uid], 1)->row_array());
                return $uid;
            }
            public function ensureRole(string $code, string $name): int { return $this->ensure('roles', $code, $name); }
            public function ensurePermission(string $code, string $name): int { return $this->ensure('permissions', $code, $name); }
            private function ensure(string $table, string $code, string $name): int {
                $row = $this->db->get_where($table, ['code' => $code], 1)->row_array();
                if ($row) return (int) $row['id'];
                $this->db->insert($table, ['code' => $code, 'name' => $name]); return (int) $this->db->insert_id();
            }
            public function grantRolePermission(int $roleId, int $permissionId): void {
                if (!$this->db->get_where('role_permissions', ['role_id' => $roleId, 'permission_id' => $permissionId], 1)->row_array()) $this->db->insert('role_permissions', ['role_id' => $roleId, 'permission_id' => $permissionId]);
            }
            public function assignRole(int $userId, int $roleId): void {
                if (!$this->db->get_where('user_roles', ['user_id' => $userId, 'role_id' => $roleId], 1)->row_array()) $this->db->insert('user_roles', ['user_id' => $userId, 'role_id' => $roleId]);
            }
            public function permissionsForUser(int $userId): array {
                $rows = $this->db->select('p.code')->from('permissions p')->join('role_permissions rp', 'rp.permission_id = p.id')->join('user_roles ur', 'ur.role_id = rp.role_id')->where('ur.user_id', $userId)->get()->result_array();
                return array_values(array_unique(array_map(fn($r) => $r['code'], $rows)));
            }
            public function recordAuthEvent(int $userId, string $type, array $detail = []): void {
                $this->db->insert('auth_events', ['user_id' => $userId, 'type' => $type, 'detail' => json_encode($detail), 'at' => gmdate('c')]);
            }
            /** Browser admin console read/manage helpers (kept in the model so SQL stays out of controllers). */
            public function listUsers(): array {
                $rows = $this->db->select('id,email,display_name,username,user_uid,profile_image,active,created_at,updated_at,last_login_at')->order_by('created_at', 'ASC')->get('users')->result_array();
                foreach ($rows as &$row) $row['permissions'] = $this->permissionsForUser((int) $row['id']);
                return $rows;
            }
            public function setActive(int $userId, bool $active): void {
                $this->db->where('id', $userId)->update('users', ['active' => $active ? 1 : 0, 'updated_at' => gmdate('c')]);
            }
        };

        $this->analysis = new class($db) implements Aegis\Persistence\AnalysisRepository {
            public function __construct(private object $db) {}
            public function save(array $run): void {
                $exists = $this->db->from('analysis_runs')->where('id', $run['id'])->count_all_results() > 0;
                $fields = [
                    'symbol' => $run['symbol'], 'timeframe' => $run['timeframe'], 'bias' => $run['bias'],
                    'confidence' => $run['confidence'], 'regime' => $run['marketRegime'],
                    'recommendation' => $run['recommendation'],
                    'synthetic' => !empty($run['provenance']['synthetic']) ? 1 : 0,
                    'source' => $run['provenance']['source'],
                    'completed_at' => $run['completedAt'], 'payload' => json_encode($run),
                ];
                if ($exists) {
                    $this->db->where('id', $run['id'])->update('analysis_runs', $fields);
                } else {
                    $this->db->insert('analysis_runs', array_merge(['id' => $run['id']], $fields));
                }
            }
            public function history(int $limit = 20): array {
                $rows = $this->db->select('id, symbol, timeframe, bias, confidence, regime, recommendation, synthetic, source, completed_at')
                    ->order_by('completed_at', 'DESC')->limit($limit)->get('analysis_runs')->result_array();
                foreach ($rows as &$r) $r['synthetic'] = (bool)$r['synthetic'];
                return $rows;
            }
            public function find(string $id): ?array {
                $row = $this->db->get_where('analysis_runs', ['id' => $id], 1)->row_array();
                return $row ? json_decode($row['payload'], true) : null;
            }
        };

        $this->state = new class($db) implements Aegis\Persistence\PlatformStateRepository {
            public function __construct(private object $db) {}
            private static function defaults(): array
            {
                static $d = null;
                if ($d === null) {
                    $d = [
                        'tradingMode' => 'ANALYSIS_ONLY',
                        'killSwitch' => ['active' => true, 'activatedAt' => null, 'reason' => 'Default state at boot — orders blocked until explicitly released'],
                        // Dev/offline switch: allow paper fills on clearly-labeled
                        // synthetic prices (production keeps this false).
                        'allowSyntheticPaperData' => (getenv('AEGIS_ALLOW_SYNTHETIC_PAPER') === '1'),
                    ];
                }
                return $d;
            }
            public function load(): array {
                $row = $this->db->get_where('platform_state', ['k' => 'state'], 1)->row_array();
                if (!$row) {
                    $this->db->insert('platform_state', ['k' => 'state', 'v' => json_encode(self::defaults())]);
                    return self::defaults();
                }
                $v = json_decode($row['v'], true);
                return array_merge(self::defaults(), is_array($v) ? $v : []);
            }
            public function save(array $state): void {
                $exists = $this->db->from('platform_state')->where('k', 'state')->count_all_results() > 0;
                if ($exists) $this->db->where('k', 'state')->update('platform_state', ['v' => json_encode($state)]);
                else $this->db->insert('platform_state', ['k' => 'state', 'v' => json_encode($state)]);
            }
        };

        $this->paper = new class($db) implements Aegis\Persistence\PaperRepository {
            public function __construct(private object $db) {}

            public function saveAccount(array $a): array {
                if (!empty($a['id'])) {
                    $this->db->where('id', $a['id'])->update('paper_accounts', $a);
                } else {
                    $this->db->insert('paper_accounts', $a);
                    $a['id'] = (int)$this->db->insert_id();
                }
                return $a;
            }
            public function findAccount(int $id): ?array {
                $r = $this->db->get_where('paper_accounts', ['id' => $id], 1)->row_array();
                if ($r) $r['starting_balance'] = (float)$r['starting_balance'];
                if ($r) $r['balance'] = (float)$r['balance'];
                if ($r) $r['peak_equity'] = (float)$r['peak_equity'];
                return $r ?: null;
            }
            public function listAccounts(): array {
                return $this->db->order_by('id', 'ASC')->get('paper_accounts')->result_array();
            }

            public function saveOrder(array $o): array {
                if (!empty($o['id'])) {
                    $this->db->where('id', $o['id'])->update('paper_orders', $o);
                } else {
                    $this->db->insert('paper_orders', $o);
                    $o['id'] = (int)$this->db->insert_id();
                }
                return $o;
            }
            public function listOrders(int $accountId, ?string $status = null): array {
                if ($status !== null) $this->db->where('status', $status);
                $rows = $this->db->where('account_id', $accountId)->order_by('id', 'DESC')->limit(200)->get('paper_orders')->result_array();
                foreach ($rows as &$r) {
                    $r['units'] = (float)$r['units'];
                    $r['price'] = $r['price'] !== null ? (float)$r['price'] : null;
                    $r['stop_loss'] = (float)$r['stop_loss'];
                    $r['take_profit'] = (float)$r['take_profit'];
                }
                return $rows;
            }
            public function findOpenOrder(int $accountId, string $symbol): ?array {
                $row = $this->db->where('account_id', $accountId)->where('symbol', $symbol)
                    ->where('status', 'PENDING')->order_by('id', 'DESC')->limit(1)->get('paper_orders')->row_array();
                return $row ?: null;
            }

            public function savePosition(array $p): array {
                if (!empty($p['id'])) {
                    $this->db->where('id', $p['id'])->update('paper_positions', $p);
                } else {
                    $this->db->insert('paper_positions', $p);
                    $p['id'] = (int)$this->db->insert_id();
                }
                return $p;
            }
            public function findPosition(int $id): ?array {
                $r = $this->db->get_where('paper_positions', ['id' => $id], 1)->row_array();
                return $r ? self::castPosition($r) : null;
            }
            public function findOpenPosition(int $accountId, string $symbol): ?array {
                $r = $this->db->where('account_id', $accountId)->where('symbol', $symbol)
                    ->where('status', 'OPEN')->order_by('id', 'DESC')->limit(1)->get('paper_positions')->row_array();
                return $r ? self::castPosition($r) : null;
            }
            public function listOpenPositions(int $accountId): array {
                $rows = $this->db->where('account_id', $accountId)->where('status', 'OPEN')->order_by('id', 'ASC')->get('paper_positions')->result_array();
                return array_map(fn($r) => self::castPosition($r), $rows);
            }
            private static function castPosition(array $r): array {
                foreach (['units', 'entry_price', 'stop_loss', 'take_profit', 'entry_fee', 'risk_amount', 'ai_confidence', 'realized_pnl', 'exit_price'] as $k) {
                    $r[$k] = $r[$k] !== null ? (float)$r[$k] : null;
                }
                return $r;
            }

            public function saveTrade(array $t): void {
                $this->db->insert('paper_trades', $t);
            }
            public function listTrades(int $accountId, int $limit = 100): array {
                $rows = $this->db->where('account_id', $accountId)->order_by('id', 'DESC')->limit($limit)->get('paper_trades')->result_array();
                $pnlByPos = [];
                $q = $this->db->select('id, realized_pnl')->where('account_id', $accountId)->get('paper_positions');
                foreach ($q->result_array() as $p) $pnlByPos[$p['id']] = (float)$p['realized_pnl'];
                foreach ($rows as &$r) {
                    $r['price'] = (float)$r['price'];
                    $r['units'] = (float)$r['units'];
                    $r['fee'] = (float)$r['fee'];
                    if ($r['leg'] === 'EXIT') $r['net_pnl'] = $pnlByPos[$r['position_id']] ?? 0.0;
                }
                return $rows;
            }

            public function saveDeployment(array $d): array {
                if (!empty($d['id'])) {
                    $this->db->where('id', $d['id'])->update('paper_deployments', $d);
                } else {
                    $this->db->insert('paper_deployments', $d);
                    $d['id'] = (int)$this->db->insert_id();
                }
                return $d;
            }
            public function findDeployment(int $id): ?array {
                return $this->db->get_where('paper_deployments', ['id' => $id], 1)->row_array() ?: null;
            }
            public function listDeployments(?int $accountId = null, ?bool $active = null): array {
                if ($accountId !== null) $this->db->where('account_id', $accountId);
                if ($active !== null) $this->db->where('active', $active ? 1 : 0);
                return $this->db->order_by('id', 'ASC')->get('paper_deployments')->result_array();
            }
        };

        $this->notifications = new class($db) implements Aegis\Persistence\NotificationRepository {
            public function __construct(private object $db) {}

            public function save(array $n): array {
                if (empty($n['id'])) $n['id'] = bin2hex(random_bytes(16));
                $row = [
                    'id' => $n['id'], 'user_id' => $n['userId'] ?? null, 'type' => (string) $n['type'],
                    'severity' => in_array($n['severity'] ?? 'info', ['info', 'warning', 'critical'], true) ? $n['severity'] : 'info',
                    'title' => mb_substr((string) $n['title'], 0, 200),
                    'detail' => json_encode($n['detail'] ?? []),
                    'dedupe_key' => $n['dedupeKey'] ?? null,
                    'read_at' => null, 'created_at' => $n['createdAt'] ?? gmdate('c'),
                ];
                $this->db->insert('notifications', $row);
                $n['id'] = $row['id'];
                return $n;
            }

            public function list(?int $userId = null, bool $unreadOnly = false, int $limit = 50): array {
                if ($userId === null) {
                    // broadcast only (no authenticated operator)
                    $this->db->where('user_id', null);
                } else {
                    $this->db->group_start()->where('user_id', null)->or_where('user_id', $userId)->group_end();
                }
                if ($unreadOnly) $this->db->where('read_at', null);
                $rows = $this->db->order_by('created_at', 'DESC')->limit(max(1, min(200, $limit)))->get('notifications')->result_array();
                $out = [];
                foreach ($rows as $r) {
                    $r['detail'] = json_decode($r['detail'], true) ?: [];
                    $out[] = $r;
                }
                return $out;
            }

            public function markRead(string $id, ?int $userId = null): bool {
                $this->db->where('id', $id)->where('read_at', null);
                if ($userId === null) $this->db->where('user_id', null);
                else $this->db->group_start()->where('user_id', null)->or_where('user_id', $userId)->group_end();
                $this->db->set('read_at', gmdate('c'))->update('notifications');
                return $this->db->affected_rows() > 0;
            }

            public function markAllRead(?int $userId = null): int {
                $this->db->where('read_at', null);
                if ($userId === null) $this->db->where('user_id', null);
                else $this->db->group_start()->where('user_id', null)->or_where('user_id', $userId)->group_end();
                $this->db->set('read_at', gmdate('c'))->update('notifications');
                return $this->db->affected_rows();
            }

            public function unreadCount(?int $userId = null): int {
                $this->db->where('read_at', null);
                if ($userId === null) $this->db->where('user_id', null);
                else $this->db->group_start()->where('user_id', null)->or_where('user_id', $userId)->group_end();
                return (int) $this->db->count_all_results('notifications');
            }

            public function hasUnreadDedupe(string $dedupeKey): bool {
                return $this->db->from('notifications')
                    ->where('dedupe_key', $dedupeKey)->where('read_at', null)->count_all_results() > 0;
            }
        };

        $this->langlearn = new class($db) implements Aegis\LangLearn\Persistence\LangLearnRepository {
            public function __construct(private object $db) {}

            public function upsertLanguage(array $row): void {
                $exists = $this->db->from('languages')->where('code', $row['code'])->count_all_results() > 0;
                if ($exists) $this->db->where('code', $row['code'])->update('languages', $row);
                else $this->db->insert('languages', $row);
            }
            public function listLanguages(bool $activeOnly = true): array {
                if ($activeOnly) $this->db->where('active', 1);
                return $this->db->order_by('name', 'ASC')->get('languages')->result_array();
            }
            public function findLanguage(string $code): ?array {
                return $this->db->get_where('languages', ['code' => $code], 1)->row_array() ?: null;
            }

            public function saveProfile(array $p): array {
                if (!empty($p['id'])) $this->db->where('id', $p['id'])->update('user_language_profiles', $p);
                else { $this->db->insert('user_language_profiles', $p); $p['id'] = (int) $this->db->insert_id(); }
                return $this->repoFindProfile((int) $p['id']) ?? $p;
            }
            public function findProfile(int $id): ?array { return $this->repoFindProfile($id); }
            private function repoFindProfile(int $id): ?array {
                $r = $this->db->get_where('user_language_profiles', ['id' => $id], 1)->row_array();
                if ($r) $r['id'] = (int) $r['id'];
                return $r ?: null;
            }
            public function findProfileByUserLanguage(int $userId, string $code): ?array {
                $r = $this->db->get_where('user_language_profiles', ['user_id' => $userId, 'language_code' => $code], 1)->row_array();
                if ($r) $r['id'] = (int) $r['id'];
                return $r ?: null;
            }
            public function listProfilesByUser(int $userId): array {
                return $this->db->where('user_id', $userId)->order_by('created_at', 'ASC')->get('user_language_profiles')->result_array();
            }

            public function saveAssessment(array $a): array {
                $row = $a;
                $row['state'] = is_array($a['state'] ?? null) ? json_encode($a['state']) : $a['state'];
                $row['result'] = is_array($a['result'] ?? null) ? json_encode($a['result']) : $a['result'];
                $exists = $this->db->from('language_assessments')->where('id', $row['id'])->count_all_results() > 0;
                if ($exists) { unset($row['started_at']); $this->db->where('id', $row['id'])->update('language_assessments', $row); }
                else $this->db->insert('language_assessments', $row);
                return $this->castAssessment($this->db->get_where('language_assessments', ['id' => $a['id']], 1)->row_array());
            }
            public function findAssessment(string $id): ?array {
                $r = $this->db->get_where('language_assessments', ['id' => $id], 1)->row_array();
                return $r ? $this->castAssessment($r) : null;
            }
            public function latestCompletedAssessment(int $profileId): ?array {
                $r = $this->db->where('profile_id', $profileId)->where('status', 'COMPLETED')
                    ->order_by('completed_at', 'DESC')->limit(1)->get('language_assessments')->row_array();
                return $r ? $this->castAssessment($r) : null;
            }
            private function castAssessment(array $r): array {
                $r['state'] = json_decode((string) $r['state'], true) ?: [];
                $r['result'] = $r['result'] !== null ? (json_decode((string) $r['result'], true) ?: null) : null;
                $r['profile_id'] = (int) $r['profile_id'];
                $r['user_id'] = (int) $r['user_id'];
                return $r;
            }

            public function savePath(array $p): array {
                $exists = $this->db->from('learning_paths')->where('id', $p['id'])->count_all_results() > 0;
                if ($exists) $this->db->where('id', $p['id'])->update('learning_paths', $p);
                else $this->db->insert('learning_paths', $p);
                return $this->db->get_where('learning_paths', ['id' => $p['id']], 1)->row_array() ?: $p;
            }
            public function activePath(int $profileId): ?array {
                return $this->db->where('profile_id', $profileId)->where('status', 'ACTIVE')
                    ->order_by('created_at', 'DESC')->limit(1)->get('learning_paths')->row_array() ?: null;
            }

            public function saveModule(array $m): array {
                $row = $m;
                $exists = $this->db->from('learning_modules')->where('id', $row['id'])->count_all_results() > 0;
                if ($exists) { unset($row['path_id'], $row['profile_id'], $row['sequence']); $this->db->where('id', $row['id'])->update('learning_modules', $row); }
                else $this->db->insert('learning_modules', $row);
                return $this->findModule($m['id']) ?? $m;
            }
            public function findModule(string $id): ?array {
                $r = $this->db->get_where('learning_modules', ['id' => $id], 1)->row_array();
                if ($r) { $r['sequence'] = (int) $r['sequence']; $r['attempts_count'] = (int) $r['attempts_count']; $r['profile_id'] = (int) $r['profile_id']; }
                return $r ?: null;
            }
            public function listModules(string $pathId): array {
                return $this->db->where('path_id', $pathId)->order_by('sequence', 'ASC')->get('learning_modules')->result_array();
            }

            public function saveAttempt(array $a): array {
                $row = $a;
                $row['detail'] = json_encode($a['detail'] ?? []);
                $this->db->insert('lesson_attempts', $row);
                return $row;
            }
            public function saveSession(array $s): void {
                $this->db->insert('study_sessions', $s);
            }
            public function listAttemptsForProfile(int $profileId, int $limit = 100): array {
                $rows = $this->db->where('profile_id', $profileId)->order_by('created_at', 'DESC')
                    ->limit(max(1, min(300, $limit)))->get('lesson_attempts')->result_array();
                foreach ($rows as &$r) {
                    $r['detail'] = json_decode((string) $r['detail'], true) ?: [];
                    if ($r['score_pct'] !== null) $r['score_pct'] = (float) $r['score_pct'];
                }
                return $rows;
            }
            public function sessionDays(int $profileId): array {
                $rows = $this->db->select('day')->distinct()->where('profile_id', $profileId)
                    ->order_by('day', 'DESC')->limit(400)->get('study_sessions')->result_array();
                return array_map(fn($r) => (string) $r['day'], $rows);
            }

            public function saveConversation(array $c): array {
                $row = $c;
                $row['state'] = is_array($c['state'] ?? null) ? json_encode($c['state']) : $c['state'];
                $exists = $this->db->from('conversation_sessions')->where('id', $row['id'])->count_all_results() > 0;
                if ($exists) { unset($row['started_at']); $this->db->where('id', $row['id'])->update('conversation_sessions', $row); }
                else $this->db->insert('conversation_sessions', $row);
                return $this->castConversation($this->db->get_where('conversation_sessions', ['id' => $c['id']], 1)->row_array());
            }
            public function findConversation(string $id): ?array {
                $r = $this->db->get_where('conversation_sessions', ['id' => $id], 1)->row_array();
                return $r ? $this->castConversation($r) : null;
            }
            public function listConversations(int $profileId, int $limit = 20): array {
                return $this->db->where('profile_id', $profileId)->order_by('started_at', 'DESC')
                    ->limit(max(1, min(100, $limit)))->get('conversation_sessions')->result_array();
            }
            private function castConversation(array $r): array {
                $r['state'] = json_decode((string) $r['state'], true) ?: [];
                $r['profile_id'] = (int) $r['profile_id'];
                $r['user_id'] = (int) $r['user_id'];
                $r['turn_count'] = (int) $r['turn_count'];
                return $r;
            }
            public function saveWriting(array $w): array {
                $row = $w;
                $row['feedback'] = json_encode($w['feedback'] ?? []);
                $this->db->insert('writing_attempts', $row);
                $row['feedback'] = $w['feedback'] ?? [];
                return $row;
            }
            public function listWriting(int $profileId, int $limit = 20): array {
                $rows = $this->db->where('profile_id', $profileId)->order_by('created_at', 'DESC')
                    ->limit(max(1, min(100, $limit)))->get('writing_attempts')->result_array();
                foreach ($rows as &$r) $r['feedback'] = json_decode((string) $r['feedback'], true) ?: [];
                return $rows;
            }

            public function upsertVocabulary(array $w): array {
                $exists = $this->db->from('vocabulary')->where(['language_code' => $w['language_code'], 'word' => $w['word']])->count_all_results() > 0;
                if ($exists) {
                    $this->db->where(['language_code' => $w['language_code'], 'word' => $w['word']])->update('vocabulary', $w);
                } else {
                    $this->db->insert('vocabulary', $w);
                }
                $row = $this->db->get_where('vocabulary', ['language_code' => $w['language_code'], 'word' => $w['word']], 1)->row_array();
                if ($row) $row['id'] = (int) $row['id'];
                return $row ?: $w;
            }
            public function listVocabulary(string $languageCode, bool $activeOnly = true): array {
                if ($activeOnly) $this->db->where('active', 1);
                $rows = $this->db->where('language_code', $languageCode)->order_by('id', 'ASC')->get('vocabulary')->result_array();
                foreach ($rows as &$r) $r['id'] = (int) $r['id'];
                return $rows;
            }
            public function findVocabulary(int $id): ?array {
                $r = $this->db->get_where('vocabulary', ['id' => $id], 1)->row_array();
                if ($r) $r['id'] = (int) $r['id'];
                return $r ?: null;
            }
            public function saveUserVocabulary(array $u): array {
                $keys = ['profile_id' => $u['profile_id'], 'vocabulary_id' => $u['vocabulary_id']];
                $exists = $this->db->from('user_vocabulary')->where($keys)->count_all_results() > 0;
                if ($exists) { $this->db->where($keys)->update('user_vocabulary', $u); }
                else { $this->db->insert('user_vocabulary', $u); }
                return $this->db->get_where('user_vocabulary', $keys, 1)->row_array() ?: $u;
            }
            public function findUserVocabulary(int $profileId, int $vocabularyId): ?array {
                return $this->db->get_where('user_vocabulary', ['profile_id' => $profileId, 'vocabulary_id' => $vocabularyId], 1)->row_array() ?: null;
            }
            public function listUserVocabulary(int $profileId, bool $dueOnly = false, int $limit = 100): array {
                if ($dueOnly) $this->db->where('next_review_at <=', gmdate('c'));
                $rows = $this->db->where('profile_id', $profileId)->order_by('next_review_at', 'ASC')->limit(max(1, min(200, $limit)))->get('user_vocabulary')->result_array();
                foreach ($rows as &$r) {
                    $r['id'] = (int) $r['id'];
                    $r['stage'] = (int) $r['stage'];
                    $r['review_count'] = (int) $r['review_count'];
                    $r['lapse_count'] = (int) $r['lapse_count'];
                    $r['familiarity'] = (float) $r['familiarity'];
                }
                return $rows;
            }

            public function saveListeningAttempt(array $a): array {
                $row = $a;
                $row['detail'] = json_encode($a['detail'] ?? []);
                $this->db->insert('listening_attempts', $row);
                $row['detail'] = $a['detail'] ?? [];
                return $row;
            }
            public function listListeningAttempts(int $profileId, int $limit = 20): array {
                $rows = $this->db->where('profile_id', $profileId)->order_by('created_at', 'DESC')
                    ->limit(max(1, min(100, $limit)))->get('listening_attempts')->result_array();
                foreach ($rows as &$r) {
                    $r['detail'] = json_decode((string) $r['detail'], true) ?: [];
                    if ($r['score_pct'] !== null) $r['score_pct'] = (float) $r['score_pct'];
                }
                return $rows;
            }
            public function saveSpeakingAttempt(array $a): array {
                $row = $a;
                $row['detail'] = json_encode($a['detail'] ?? []);
                $this->db->insert('speaking_attempts', $row);
                $row['detail'] = $a['detail'] ?? [];
                return $row;
            }
            public function listSpeakingAttempts(int $profileId, int $limit = 20): array {
                $rows = $this->db->where('profile_id', $profileId)->order_by('created_at', 'DESC')
                    ->limit(max(1, min(100, $limit)))->get('speaking_attempts')->result_array();
                foreach ($rows as &$r) {
                    $r['detail'] = json_decode((string) $r['detail'], true) ?: [];
                    if ($r['word_accuracy_pct'] !== null) $r['word_accuracy_pct'] = (float) $r['word_accuracy_pct'];
                }
                return $rows;
            }

            public function saveDailyPlan(array $p): array {
                $row = $p;
                $row['plan'] = is_array($p['plan'] ?? null) ? json_encode($p['plan']) : $p['plan'];
                $keys = ['profile_id' => $p['profile_id'], 'day' => $p['day']];
                $exists = $this->db->from('daily_learning_plans')->where($keys)->count_all_results() > 0;
                if ($exists) { $this->db->where($keys)->update('daily_learning_plans', $row); $row['id'] = $this->db->select('id')->where($keys)->get('daily_learning_plans')->row_array()['id'] ?? $row['id']; }
                else $this->db->insert('daily_learning_plans', $row);
                return $this->findDailyPlan((int) $p['profile_id'], $p['day']) ?? $row;
            }
            public function findDailyPlan(int $profileId, string $day): ?array {
                $r = $this->db->get_where('daily_learning_plans', ['profile_id' => $profileId, 'day' => $day], 1)->row_array();
                if ($r) {
                    $r['plan'] = json_decode((string) $r['plan'], true) ?: [];
                    $r['profile_id'] = (int) $r['profile_id'];
                    $r['est_minutes'] = (int) $r['est_minutes'];
                }
                return $r ?: null;
            }
            public function saveRecommendation(array $r): array {
                $row = $r;
                $row['evidence'] = json_encode($r['evidence'] ?? []);
                $this->db->insert('ai_learning_recommendations', $row);
                $row['evidence'] = $r['evidence'] ?? [];
                return $row;
            }
            public function clearRecommendations(int $profileId): void {
                $this->db->where('profile_id', $profileId)->delete('ai_learning_recommendations');
            }

            public function upsertProgress(array $row): void {
                $keys = ['profile_id' => $row['profile_id'], 'skill' => $row['skill'], 'source' => $row['source']];
                $exists = $this->db->from('language_progress')->where($keys)->count_all_results() > 0;
                if ($exists) $this->db->where($keys)->update('language_progress', ['level' => $row['level'], 'value_pct' => $row['value_pct'], 'updated_at' => $row['updated_at']]);
                else $this->db->insert('language_progress', $row);
            }
            public function listProgress(int $profileId): array {
                return $this->db->where('profile_id', $profileId)->get('language_progress')->result_array();
            }
        };

        $this->proposals = new class($db) implements Aegis\Persistence\ProposalRepository {
            public function __construct(private object $db) {}

            public function saveProposal(array $p): array {
                // Accepts both the supervisor's camelCase contract and rows
                // returned by findProposal()/listProposals() (snake_case).
                $pick = fn(string $camel, string $snake, $default = null) => $p[$camel] ?? $p[$snake] ?? $default;
                $intent = $pick('intent', 'intent', []);
                $row = [
                    'id' => $p['id'], 'created_at' => $pick('createdAt', 'created_at', gmdate('c')),
                    'actor' => $pick('actor', 'actor', 'user'),
                    'broker' => $pick('broker', 'broker', 'none'),
                    'symbol' => $pick('symbol', 'symbol', ''),
                    'market_class' => $pick('marketClass', 'market_class', ''),
                    'side' => $pick('side', 'side', ''), 'order_type' => $pick('orderType', 'order_type', 'MARKET'),
                    'volume' => (float)$pick('volume', 'volume', 0),
                    'price' => ($px = $pick('price', 'price')) !== null ? (float)$px : null,
                    'stop_loss' => (float)$pick('stopLoss', 'stop_loss', 0),
                    'take_profit' => ($tp = $pick('takeProfit', 'take_profit')) !== null ? (float)$tp : null,
                    'strategy_id' => $pick('strategyId', 'strategy_id'), 'reason' => mb_substr((string)$pick('reason', 'reason', ''), 0, 500),
                    'status' => $p['status'], 'intent' => json_encode($intent),
                    'checks' => json_encode($pick('checks', 'checks', [])),
                    'risk_decision' => ($rd = $pick('riskDecision', 'riskDecision')) !== null ? json_encode($rd) : null,
                    'decision_by' => $pick('decisionBy', 'decision_by'), 'decided_at' => $pick('decidedAt', 'decided_at'),
                    'updated_at' => gmdate('c'),
                ];
                $exists = $this->db->from('trade_proposals')->where('id', $row['id'])->count_all_results() > 0;
                if ($exists) { unset($row['created_at'], $row['actor']); $this->db->where('id', $row['id'])->update('trade_proposals', $row); }
                else $this->db->insert('trade_proposals', $row);
                return $this->findProposal($p['id']) ?? $p;
            }

            public function findProposal(string $id): ?array {
                $r = $this->db->get_where('trade_proposals', ['id' => $id], 1)->row_array();
                return $r ? self::cast($r) : null;
            }

            public function listProposals(?string $status = null, int $limit = 100): array {
                if ($status !== null) $this->db->where('status', $status);
                $rows = $this->db->order_by('created_at', 'DESC')->limit(max(1, min(500, $limit)))->get('trade_proposals')->result_array();
                return array_map(self::cast(...), $rows);
            }

            public function countAutomatedExecutionsToday(): int {
                return (int) $this->db->from('trade_executions')
                    ->where('automated', 1)->where('submitted_at >=', gmdate('Y-m-d'))
                    ->count_all_results();
            }

            public function saveExecution(array $e): array {
                $pick = fn(string $camel, string $snake, $default = null) => $e[$camel] ?? $e[$snake] ?? $default;
                $row = [
                    'id' => $e['id'], 'proposal_id' => $pick('proposalId', 'proposal_id'), 'broker' => $e['broker'],
                    'broker_order_id' => $pick('brokerOrderId', 'broker_order_id'), 'automated' => !empty($e['automated']) ? 1 : 0,
                    'submitted_at' => $pick('submittedAt', 'submitted_at', gmdate('c')), 'status' => $e['status'],
                    'result' => json_encode($e['result'] ?? []),
                ];
                $exists = $this->db->from('trade_executions')->where('id', $row['id'])->count_all_results() > 0;
                if ($exists) $this->db->where('id', $row['id'])->update('trade_executions', $row);
                else $this->db->insert('trade_executions', $row);
                return self::castExecution(array_merge($row, ['result' => $e['result'] ?? []]));
            }

            public function listExecutions(string $proposalId, int $limit = 10): array {
                $rows = $this->db->where('proposal_id', $proposalId)->order_by('submitted_at', 'DESC')
                    ->limit(max(1, min(50, $limit)))->get('trade_executions')->result_array();
                return array_map(self::castExecution(...), $rows);
            }

            public function listRecentExecutions(int $limit = 50): array {
                $rows = $this->db->order_by('submitted_at', 'DESC')->limit(max(1, min(200, $limit)))
                    ->get('trade_executions')->result_array();
                return array_map(self::castExecution(...), $rows);
            }

            private static function cast(array $r): array {
                foreach (['volume', 'price', 'stop_loss', 'take_profit'] as $k) if ($r[$k] !== null) $r[$k] = (float)$r[$k];
                $r['intent'] = json_decode($r['intent'], true) ?: [];
                $r['checks'] = json_decode($r['checks'], true) ?: [];
                $r['riskDecision'] = $r['risk_decision'] !== null ? (json_decode($r['risk_decision'], true) ?: null) : null;
                unset($r['risk_decision']);
                return $r;
            }

            private static function castExecution(array $r): array {
                $r['automated'] = (bool)$r['automated'];
                if (is_string($r['result'])) $r['result'] = json_decode($r['result'], true) ?: [];
                return $r;
            }
        };
    }
}

/** Row encode/decode helpers for backtests (shared by anonymous classes). */
final class BacktestRepo
{
    public static function decode(array $row): array {
        $record = json_decode($row['payload'], true) ?: [];
        $record['id'] = $row['id'];
        $record['created_at'] = $row['created_at'];
        return $record;
    }
    public static function encode(array $r): array {
        return [
            'id' => $r['id'], 'created_at' => $r['created_at'],
            'strategy_id' => $r['request']['strategyId'], 'strategy_version' => $r['request']['strategyVersion'],
            'symbol' => $r['request']['symbol'], 'timeframe' => $r['request']['timeframe'],
            'synthetic' => !empty($r['dataProvenance']['synthetic']) ? 1 : 0,
            'payload' => json_encode($r),
        ];
    }
}
