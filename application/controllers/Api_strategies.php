<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Api_strategies extends Api_controller
{
    public function index()
    {
        $records = $this->platform->model->strategies->all();
        $grouped = [];
        foreach ($records as $rec) {
            $grouped[$rec['strategy_id']][] = $rec;
        }
        $out = [];
        foreach ($grouped as $id => $versions) {
            $latest = $versions[count($versions) - 1];
            $impl = $this->platform->strategies->implementation($id, $latest['version']);
            $out[] = [
                'strategyId' => $id,
                'latest' => $latest + ['supportsShorts' => $impl?->supportsShorts() ?? false],
                'versions' => array_map(fn($v) => ['version' => $v['version'], 'lifecycle' => $v['lifecycle'], 'updatedAt' => $v['updated_at']], $versions),
            ];
        }
        $this->json(['strategies' => $out]);
    }

    public function show(string $id)
    {
        $version = $this->input->get('version');
        $rec = $this->platform->model->strategies->find($id, $version ?: '');
        if (!$rec && !$version) {
            // fall back to latest version
            foreach ($this->platform->model->strategies->all() as $r) {
                if ($r['strategy_id'] === $id) $rec = $r;
            }
        }
        if (!$rec) return $this->jsonError("strategy {$id} not found", 404);
        $impl = $this->platform->strategies->implementation($rec['strategy_id'], $rec['version']);
        $this->json($rec + [
            'supportsShorts' => $impl?->supportsShorts() ?? false,
            'nextStage' => \Aegis\Strategies\StrategyRegistry::nextStage($rec['lifecycle']),
        ]);
    }

    public function status(string $id)
    {
        $body = $this->jsonBody();
        $to = (string)($body['to'] ?? '');
        $version = (string)($body['version'] ?? '');
        if (!in_array($to, ['DRAFT', 'BACKTESTED', 'VALIDATED', 'RISK_REVIEWED', 'PAPER_TRADING', 'APPROVED', 'RETIRED'], true)) {
            return $this->jsonError('body must be {to: stage, reason?, version?}');
        }
        if ($version === '') {
            foreach ($this->platform->model->strategies->all() as $r) {
                if ($r['strategy_id'] === $id) $version = $r['version'];
            }
        }
        $result = $this->platform->strategies->transition($id, $version, $to, $body['reason'] ?? null);
        if (!$result['ok']) {
            return $this->json(['error' => 'transition rejected', 'reasons' => $result['reasons'], 'warnings' => $result['warnings']], 409);
        }
        $this->json(['ok' => true, 'strategy' => $result['strategy'], 'warnings' => $result['warnings']]);
    }

    /** Phase 6: parameter optimization with walk-forward verification. */
    public function optimize(string $strategyId = '')
    {
        $body = $this->jsonBody();
        if ($strategyId !== '') $body['strategyId'] = $strategyId;
        if (empty($body['strategyId'])) return $this->jsonError('missing required field: strategyId');
        try {
            $this->json(['optimization' => $this->platform->optimizeStrategy($body)]);
        } catch (\InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $this->jsonError($e->getMessage(), 409);
        }
    }

    public function run_backtest()
    {
        $body = $this->jsonBody();
        foreach (['strategyId', 'symbol', 'marketClass', 'timeframe'] as $f) {
            if (empty($body[$f])) return $this->jsonError("missing required field: {$f}");
        }
        if (!in_array($body['timeframe'], ['15m', '1h', '4h', '1d'], true)) return $this->jsonError('invalid timeframe');
        if (!in_array($body['marketClass'], ['forex', 'crypto', 'commodity'], true)) return $this->jsonError('invalid marketClass');
        $record = $this->platform->model->strategies->find($body['strategyId'], (string)($body['strategyVersion'] ?? ''));
        if (!$record) {
            foreach ($this->platform->model->strategies->all() as $r) {
                if ($r['strategy_id'] === $body['strategyId']) $record = $r;
            }
        }
        if (!$record) return $this->jsonError('strategy not found', 404);
        $body['strategyVersion'] = $record['version'];
        try {
            $result = $this->platform->runBacktest($body);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($e->getMessage(), 400);
        } catch (Throwable $e) {
            return $this->jsonError($e->getMessage(), 422);
        }
        $this->json($result);
    }

    public function backtest_results()
    {
        $strategyId = $this->input->get('strategyId');
        $records = $this->platform->model->backtests->list($strategyId ?: null, 30);
        $this->json(['results' => array_map(fn($r) => [
            'id' => $r['id'], 'createdAt' => $r['created_at'],
            'strategyId' => $r['request']['strategyId'], 'strategyVersion' => $r['request']['strategyVersion'],
            'symbol' => $r['request']['symbol'], 'timeframe' => $r['request']['timeframe'],
            'synthetic' => $r['dataProvenance']['synthetic'], 'candles' => $r['dataProvenance']['candles'],
            'metrics' => $r['metrics'], 'warnings' => $r['warnings'],
        ], $records)]);
    }

    public function backtest_detail(string $id)
    {
        $r = $this->platform->model->backtests->find($id);
        if (!$r) return $this->jsonError('backtest result not found', 404);
        $this->json($r);
    }
}
