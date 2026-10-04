<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Phase 5 — Execution Center: the 15-step Trade Execution Supervisor console.
 * Proposals, human approval, automated-mode limits and routed executions.
 */
class Execution extends App_Controller
{
    public function index()
    {
        $data = $this->base('Execution Center');
        $data['proposals'] = $this->platform->execution->proposals(null, 40);
        $data['executions'] = $this->platform->execution->executions(20);
        $data['limits'] = \Aegis\ExecutionSupervisor::automationLimits($this->platform->state());
        $data['gateSemi'] = $this->platform->automationModeGate('SEMI_AUTONOMOUS');
        $data['gateFully'] = $this->platform->automationModeGate('FULLY_AUTOMATED');
        $data['strategies'] = array_filter($this->platform->model->strategies->all(), fn($s) => $s['lifecycle'] === 'APPROVED');
        $data['automatedToday'] = $this->platform->model->proposals->countAutomatedExecutionsToday();
        $data['routable'] = $this->platform->brokers->tradingConnector() !== null;
        $mt5 = $this->platform->brokers->get('mt5-bridge');
        $data['simBridge'] = $mt5 instanceof \Aegis\Brokers\Mt5BridgeConnector
            && (($mt5->status()['simulated'] ?? false) === true);
        // Live quote-aware form defaults (SL −0.4% / TP +1.2% keeps R/R ≥ 3
        // across the demo price wave) — only when a connector is reachable.
        $data['quoteDefaults'] = null;
        if ($data['routable']) {
            try {
                $mid = (($connector = $this->platform->brokers->tradingConnector()) ? $connector->quote('EURUSD') : null);
                if ($mid !== null) {
                    $ref = ($mid['bid'] + $mid['ask']) / 2;
                    $data['quoteDefaults'] = ['mid' => $ref, 'sl' => $ref * 0.996, 'tp' => $ref * 1.012];
                }
            } catch (Throwable $e) { /* defaults stay null */ }
        }
        $this->load->view('layout/header', $data);
        $this->load->view('execution/index', $data);
        $this->load->view('layout/footer');
    }

    /** Run the pipeline (steps 1–11) and persist the proposal. */
    public function propose()
    {
        $post = $this->input->post();
        $intent = [
            'symbol' => strtoupper((string) ($post['symbol'] ?? '')),
            'marketClass' => (string) ($post['marketClass'] ?? 'forex'),
            'side' => strtoupper((string) ($post['side'] ?? '')),
            'type' => strtoupper((string) ($post['type'] ?? 'MARKET')),
            'volume' => (float) ($post['volume'] ?? 0),
            'stopLoss' => (float) ($post['stopLoss'] ?? 0),
            'takeProfit' => (float) ($post['takeProfit'] ?? 0) ?: null,
            'price' => (float) ($post['price'] ?? 0) ?: null,
            'strategyId' => trim((string) ($post['strategyId'] ?? '')) ?: null,
            'reason' => trim((string) ($post['reason'] ?? '')) ?: null,
        ];
        try {
            $result = $this->platform->execution->propose($intent, 'user');
            $last = end($result['checks']);
            $summary = $result['status'] === 'REJECTED'
                ? "REJECTED at step {$last['step']} ({$last['check']}): {$result['reason']}"
                : "{$result['status']}: {$result['reason']} (proposal {$result['id']})";
            $this->flash('notice', $summary);
        } catch (Throwable $e) {
            $this->flash('error', 'Proposal failed: ' . $e->getMessage());
        }
        redirect('/execution');
    }

    public function decide(string $id)
    {
        $approve = $this->input->post('approve') === '1';
        try {
            $this->platform->execution->decide($id, $approve, 'user', 'Execution Center');
            $this->flash('notice', "Proposal {$id} " . ($approve ? 'APPROVED — route it to place the order' : 'REJECTED') . '.');
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/execution');
    }

    /** Steps 12–15: route an APPROVED proposal through the verified connector. */
    public function route(string $id)
    {
        try {
            $result = $this->platform->execution->route($id, 'user');
            $this->flash($result['brokerOrderCreated'] ? 'notice' : 'error',
                $result['brokerOrderCreated']
                    ? "EXECUTED — broker order created (proposal {$id})."
                    : "{$result['status']}: {$result['reason']} — no order was created.");
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/execution');
    }

    /** SEMI_AUTONOMOUS / FULLY_AUTOMATED one-shot entry. */
    public function execute()
    {
        $post = $this->input->post();
        $intent = [
            'symbol' => strtoupper((string) ($post['symbol'] ?? '')),
            'marketClass' => (string) ($post['marketClass'] ?? 'forex'),
            'side' => strtoupper((string) ($post['side'] ?? '')),
            'type' => 'MARKET',
            'volume' => (float) ($post['volume'] ?? 0),
            'stopLoss' => (float) ($post['stopLoss'] ?? 0),
            'takeProfit' => (float) ($post['takeProfit'] ?? 0) ?: null,
            'strategyId' => trim((string) ($post['strategyId'] ?? '')) ?: null,
        ];
        try {
            $result = $this->platform->execution->executeAutomated($intent);
            if (($result['status'] ?? '') === 'EXECUTED') {
                $this->flash('notice', "EXECUTED automatically inside the limits envelope (proposal {$result['proposalId']}).");
            } else {
                $last = end($result['checks']);
                $this->flash('error', "{$result['status']}" . ($last ? " at {$last['check']}" : '') . ": {$result['reason']}");
            }
        } catch (Throwable $e) {
            $this->flash('error', 'Execution failed: ' . $e->getMessage());
        }
        redirect('/execution');
    }

    public function limits()
    {
        try {
            $symbols = array_values(array_filter(array_map('trim', explode(',', (string) $this->input->post('approvedSymbols')))));
            $patch = [
                'maxTradeNotionalUsd' => (float) $this->input->post('maxTradeNotionalUsd'),
                'maxDailyTrades' => (int) $this->input->post('maxDailyTrades'),
                'maxRiskPerTradePct' => ((float) $this->input->post('maxRiskPerTradePct')) / 100,
                'approvedSymbols' => $symbols,
            ];
            $this->platform->updateAutomationLimits(array_filter($patch, fn($v) => $v !== [] && $v !== 0.0 && $v !== null));
            $this->flash('notice', 'Automation limits updated.');
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/execution');
    }

    private function base(string $title): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => 'execution',
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth()],
            'notice' => $this->flashGet('notice'), 'error' => $this->flashGet('error'),
        ];
    }

    private function flash(string $key, string $msg): void
    {
        $this->session->set_flashdata($key, $msg);
    }

    private function flashGet(string $key): ?string
    {
        $msg = $this->session->flashdata($key);
        return is_string($msg) && $msg !== '' ? $msg : null;
    }
}
