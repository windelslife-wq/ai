<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Phase 3 — Paper Trading console (traditional MVC pages).
 */
class Paper extends App_Controller
{
    public function index()
    {
        $data = $this->base('Paper Trading');
        $data['accounts'] = [];
        foreach ($this->platform->model->paper->listAccounts() as $a) {
            try { $data['accounts'][] = $this->platform->paper->accountSummary((int)$a['id']); }
            catch (Throwable $e) { /* skip broken */ }
        }
        $this->load->view('layout/header', $data);
        $this->load->view('paper/index', $data);
        $this->load->view('layout/footer');
    }

    public function account(int $id)
    {
        $data = $this->base('Paper Account #' . $id);
        try {
            $data['summary'] = $this->platform->paper->accountSummary($id);
        } catch (Throwable $e) {
            show_404();
            return;
        }
        $data['accountId'] = $id;
        $data['orders'] = $this->platform->model->paper->listOrders($id);
        $data['deployments'] = $this->platform->model->paper->listDeployments($id);
        $data['closed'] = $this->db->where('account_id', $id)->where('status', 'CLOSED')
            ->order_by('id', 'DESC')->limit(25)->get('paper_positions')->result_array();
        $data['strategies'] = $this->platform->model->strategies->all();
        $this->load->view('layout/header', $data);
        $this->load->view('paper/account', $data);
        $this->load->view('layout/footer');
    }

    public function create()
    {
        $name = trim((string)$this->input->post('name'));
        $balance = (float)$this->input->post('startingBalance');
        try {
            $account = $this->platform->paper->createAccount($name !== '' ? $name : 'Paper account', $balance);
            $this->flash('notice', "Paper account #{$account['id']} created.");
            redirect('/paper/' . $account['id']);
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
            redirect('/paper');
        }
    }

    public function order(int $id)
    {
        $body = [
            'symbol' => strtoupper((string)$this->input->post('symbol')),
            'side' => strtoupper((string)$this->input->post('side')),
            'type' => strtoupper((string)$this->input->post('type')),
            'price' => $this->input->post('price') !== '' ? (float)$this->input->post('price') : null,
            'stopLoss' => (float)$this->input->post('stopLoss'),
            'takeProfit' => $this->input->post('takeProfit') !== '' ? (float)$this->input->post('takeProfit') : null,
            'riskPct' => $this->input->post('riskPct') !== '' ? (float)$this->input->post('riskPct') : null,
            'reason' => (string)$this->input->post('reason'),
            'confidence' => $this->input->post('confidence') !== '' ? (float)$this->input->post('confidence') : null,
        ];
        try {
            $result = $this->platform->paper->submitOrder($id, $body);
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
            redirect('/paper/' . $id);
            return;
        }
        $o = $result['order'];
        if ($o['status'] === 'REJECTED') {
            $reasons = $o['rejectReasons'] ?? [$o['reject_reason'] ?? 'rejected'];
            $this->flash('error', 'Order REJECTED: ' . implode(' · ', (array)$reasons));
        } elseif (!empty($result['filled'])) {
            $this->flash('notice', sprintf('Order FILLED: %s %s %s @ %s', $o['side'], $o['units'], $o['symbol'], number_format((float)$o['fill_price'], 5)));
        } else {
            $this->flash('notice', 'Limit order PENDING — run a tick to fill it.');
        }
        redirect('/paper/' . $id);
    }

    public function close(int $accountId, int $positionId)
    {
        try {
            $res = $this->platform->paper->closePosition($accountId, $positionId, 'MANUAL');
            $this->flash('notice', sprintf('Position closed @ %s · P&L %s', number_format((float)$res['position']['exit_price'], 5), number_format($res['netPnl'], 2)));
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/paper/' . $accountId);
    }

    public function tick(int $id)
    {
        try {
            $result = $this->platform->paper->tick($id);
            $a = $result['actions'];
            $msg = sprintf('Tick: %d order(s) filled · %d position(s) closed · %d strategy signal(s)',
                count($a['filledOrders']), count($a['closedPositions']), count($a['strategySignals']));
            foreach ($a['strategySignals'] as $sig) {
                if (isset($sig['submitted'])) $msg .= sprintf(' [%s %s submitted]', $sig['symbol'], $sig['action']);
                if (!empty($sig['rejectReasons'])) $msg .= sprintf(' [%s %s rejected: %s]', $sig['symbol'], $sig['action'], implode('; ', (array)$sig['rejectReasons']));
            }
            $this->flash('notice', $msg);
        } catch (Throwable $e) {
            $this->flash('error', 'Tick failed: ' . $e->getMessage());
        }
        redirect('/paper/' . $id);
    }

    public function deploy(int $id)
    {
        $strategyId = (string)$this->input->post('strategyId');
        try {
            $this->platform->paper->deployStrategy(
                $id, $strategyId, (string)$this->input->post('version'),
                strtoupper((string)$this->input->post('symbol')),
                (string)$this->input->post('timeframe'),
                (string)$this->input->post('marketClass')
            );
            $this->flash('notice', "Strategy {$strategyId} deployed — signals execute on each tick (risk-checked).");
        } catch (Throwable $e) {
            $this->flash('error', $e->getMessage());
        }
        redirect('/paper/' . $id);
    }

    public function toggle(int $accountId, int $deploymentId)
    {
        $active = $this->input->post('active') === '1';
        try { $this->platform->paper->pauseDeployment($deploymentId, $active); } catch (Throwable $e) { /* noop */ }
        redirect('/paper/' . $accountId);
    }

    private function base(string $title): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => 'paper',
            'status' => ['tradingMode' => $state['tradingMode'], 'killSwitch' => $state['killSwitch'],
                'providers' => $this->platform->providers->getAllHealth()],
            'notice' => $this->flashGet('notice'), 'error' => $this->flashGet('error'),
        ];
    }

    private function flash(string $key, string $msg): void
    {
        setcookie("flash_{$key}", rawurlencode($msg), time() + 30, '/');
    }

    private function flashGet(string $key): ?string
    {
        $v = $_COOKIE["flash_{$key}"] ?? null;
        if ($v !== null) setcookie("flash_{$key}", '', time() - 3600, '/');
        return $v !== null ? rawurldecode($v) : null;
    }
}
