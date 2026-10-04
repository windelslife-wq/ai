<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

class Strategy_lab extends App_Controller
{
    public function index()
    {
        $data = [
            'title' => 'Strategy Lab', 'active' => 'strategy',
            'status' => $this->statusView(),
            'strategies' => [], 'results' => [], 'detail' => null,
            'notice' => $this->session_flash('notice'),
            'error' => $this->session_flash('error'),
        ];
        foreach ($this->platform->model->strategies->all() as $rec) {
            $impl = $this->platform->strategies->implementation($rec['strategy_id'], $rec['version']);
            $rec['supportsShorts'] = $impl?->supportsShorts() ?? false;
            $rec['nextStage'] = \Aegis\Strategies\StrategyRegistry::nextStage($rec['lifecycle']);
            $data['strategies'][] = $rec;
        }
        $selId = (string)($this->input->get('strategy') ?: ($data['strategies'][0]['strategy_id'] ?? ''));
        foreach ($data['strategies'] as $s) {
            if ($s['strategy_id'] === $selId) $data['detail'] = $s;
        }
        if ($data['detail']) {
            $data['results'] = $this->platform->model->backtests->list($selId, 15);
        }
        $this->render($data);
    }

    public function run_backtest()
    {
        $strategyId = (string)$this->input->post('strategyId');
        try {
            $record = null;
            foreach ($this->platform->model->strategies->all() as $r) {
                if ($r['strategy_id'] === $strategyId) $record = $r;
            }
            if (!$record) throw new RuntimeException('strategy not found');
            $symbol = strtoupper((string)$this->input->post('symbol'));
            $marketClass = str_ends_with($symbol, 'USDT') ? 'crypto' : 'forex';
            if ($symbol === 'XAUUSD') $marketClass = 'commodity';
            $result = $this->platform->runBacktest([
                'strategyId' => $strategyId,
                'strategyVersion' => $record['version'],
                'symbol' => $symbol,
                'marketClass' => $marketClass,
                'timeframe' => (string)$this->input->post('timeframe'),
                'limit' => (int)$this->input->post('limit'),
                'allowShorts' => $this->input->post('allowShorts') === '1',
            ]);
            $m = $result['metrics'];
            $this->flash('notice', sprintf('Backtest complete: %d trades · return %s%% · maxDD %s%% · %s',
                $m['trades'], number_format($m['totalReturnPct'], 2), number_format($m['maxDrawdownPct'], 1),
                $result['dataProvenance']['synthetic'] ? 'SYNTHETIC data (simulation)' : 'real data'));
        } catch (Throwable $e) {
            $this->flash('error', 'Backtest failed: ' . $e->getMessage());
        }
        redirect('/strategy?strategy=' . urlencode($strategyId));
    }

    /** Phase 6: parameter optimization with walk-forward verification. */
    public function optimize()
    {
        $strategyId = (string) $this->input->post('strategyId');
        try {
            $symbol = strtoupper((string) $this->input->post('symbol'));
            $marketClass = str_ends_with($symbol, 'USDT') ? 'crypto' : 'forex';
            if ($symbol === 'XAUUSD') $marketClass = 'commodity';
            $report = $this->platform->optimizeStrategy([
                'strategyId' => $strategyId,
                'symbol' => $symbol,
                'marketClass' => $marketClass,
                'timeframe' => (string) $this->input->post('timeframe'),
                'limit' => (int) $this->input->post('limit'),
                'register' => $this->input->post('register') === '1',
            ]);
            $rec = $report['recommendation'];
            $bits = [
                sprintf('%d combinations · split %d/%d bars', $report['searchSpace']['combinationsEvaluated'], $report['split']['inSampleBars'], $report['split']['outOfSampleBars']),
                $rec['adopt'] ? 'ADOPT ' . json_encode($rec['params']) : 'keep current params',
            ];
            if (!empty($report['registeredVariant'])) {
                $bits[] = 'registered variant @' . $report['registeredVariant']['version'] . ' (DRAFT, source ai — human sign-off required)';
            }
            foreach ($report['overfitWarnings'] as $w) $bits[] = '⚠ ' . $w;
            $bits[] = $report['dataProvenance']['synthetic'] ? 'SYNTHETIC data (simulation)' : 'real data';
            $this->flash('notice', 'Optimization complete — ' . implode(' · ', $bits));
        } catch (Throwable $e) {
            $this->flash('error', 'Optimization failed: ' . $e->getMessage());
        }
        redirect('/strategy?strategy=' . urlencode($strategyId));
    }

    public function advance()
    {
        $strategyId = (string)$this->input->post('strategyId');
        $to = (string)$this->input->post('to');
        $version = (string)$this->input->post('version');
        $result = $this->platform->strategies->transition($strategyId, $version, $to, 'advanced from Strategy Lab');
        if ($result['ok']) {
            $this->flash('notice', "Strategy advanced to {$to}");
        } else {
            $this->flash('error', 'Transition rejected: ' . implode(' · ', $result['reasons']));
        }
        redirect('/strategy?strategy=' . urlencode($strategyId));
    }

    private function flash(string $key, string $msg): void
    {
        $_SESSION['flash'][$key] = $msg; // CI3 without session lib: use query-less flash via cookie
        setcookie("flash_{$key}", rawurlencode($msg), time() + 30, '/');
    }

    private function session_flash(string $key): ?string
    {
        $v = $_COOKIE["flash_{$key}"] ?? null;
        if ($v !== null) setcookie("flash_{$key}", '', time() - 3600, '/');
        return $v !== null ? rawurldecode($v) : null;
    }

    private function statusView(): array
    {
        $state = $this->platform->state();
        return ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
            'providers' => $this->platform->providers->getAllHealth()];
    }

    private function render(array $data): void
    {
        $this->load->view('layout/header', $data);
        $this->load->view('strategy/index', $data);
        $this->load->view('layout/footer');
    }
}
