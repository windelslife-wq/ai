<?php
defined('BASEPATH') or exit('No direct script access allowed');

use Aegis\Journal\Analytics;

class Api_journal extends Api_controller
{
    public function index()
    {
        $filter = [
            'source' => $this->input->get('source'),
            'strategy' => $this->input->get('strategy'),
            'symbol' => $this->input->get('symbol') ? strtoupper($this->input->get('symbol')) : null,
        ];
        $this->json(['entries' => $this->platform->model->journal->list($filter, 200)]);
    }

    public function manual()
    {
        $body = $this->jsonBody();
        foreach (['symbol', 'direction', 'entryTime', 'entryPrice', 'positionSize', 'reasonForTrade'] as $f) {
            if (empty($body[$f])) return $this->jsonError("missing required field: {$f}");
        }
        if (!in_array($body['direction'], ['LONG', 'SHORT'], true)) return $this->jsonError('direction must be LONG or SHORT');
        $entryTime = (string)$body['entryTime'];
        $exitTime = $body['exitTime'] ?? null;
        if (strtotime($entryTime) === false) return $this->jsonError('invalid entryTime (ISO 8601 expected)');
        if ($exitTime !== null && strtotime($exitTime) < strtotime($entryTime)) {
            return $this->jsonError('exitTime cannot precede entryTime');
        }
        $entryPrice = (float)$body['entryPrice'];
        $exitPrice = isset($body['exitPrice']) ? (float)$body['exitPrice'] : null;
        $size = (float)$body['positionSize'];
        if ($entryPrice <= 0 || $size <= 0) return $this->jsonError('prices and size must be positive');

        $pnl = $exitPrice !== null
            ? ($body['direction'] === 'LONG' ? $exitPrice - $entryPrice : $entryPrice - $exitPrice) * $size - (float)($body['fees'] ?? 0)
            : null;
        $stop = isset($body['stopLoss']) ? (float)$body['stopLoss'] : null;
        $rMultiple = ($pnl !== null && $stop !== null && abs($entryPrice - $stop) > 0)
            ? $pnl / (abs($entryPrice - $stop) * $size) : null;

        $entry = [
            'id' => \Aegis\Backtest\Backtester::uuid(),
            'source' => 'manual',
            'symbol' => strtoupper((string)$body['symbol']),
            'market' => (string)($body['market'] ?? 'forex'),
            'strategy' => $body['strategy'] ?? null,
            'strategy_version' => $body['strategyVersion'] ?? null,
            'direction' => $body['direction'],
            'entry_time' => $entryTime,
            'entry_price' => $entryPrice,
            'exit_time' => $exitTime,
            'exit_price' => $exitPrice,
            'position_size' => $size,
            'stop_loss' => $stop,
            'take_profit' => isset($body['takeProfit']) ? (float)$body['takeProfit'] : null,
            'fees' => (float)($body['fees'] ?? 0),
            'slippage' => (float)($body['slippage'] ?? 0),
            'pnl' => $pnl !== null ? round($pnl, 6) : null,
            'pnl_pct' => $pnl !== null ? round($pnl / ($size * $entryPrice) * 100, 6) : null,
            'r_multiple' => $rMultiple !== null ? round($rMultiple, 4) : null,
            'reason' => mb_substr((string)$body['reasonForTrade'], 0, 500),
            'ai_confidence' => isset($body['aiConfidence']) ? (float)$body['aiConfidence'] : null,
            'confidence_source' => isset($body['aiConfidence']) ? ($body['confidenceSource'] ?? 'manual') : null,
            'agent_consensus' => $body['agentConsensus'] ?? null,
            'risk_score' => $body['riskScore'] ?? null,
            'execution_time' => $entryTime,
        ];
        $this->platform->model->journal->save($entry);
        $this->platform->model->audit->emit('JOURNAL_ENTRY_RECORDED', 'Manual journal entry recorded for ' . $entry['symbol'], ['symbol' => $entry['symbol']], 'user');
        $this->json($entry, 201);
    }

    public function summary()
    {
        $groupBy = (string)($this->input->get('groupBy') ?: 'strategy');
        if (!in_array($groupBy, ['strategy', 'market', 'symbol', 'source', 'confidence'], true)) {
            return $this->jsonError('groupBy must be one of strategy, market, symbol, source, confidence');
        }
        $entries = $this->platform->model->journal->list([], 500);
        $this->json(Analytics::analyze($entries, $groupBy));
    }

    public function calibration()
    {
        $entries = $this->platform->model->journal->list([], 2000);
        $this->json(Analytics::calibration($entries));
    }
}
