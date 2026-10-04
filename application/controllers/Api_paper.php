<?php
defined('BASEPATH') or exit('No direct script access allowed');

/**
 * Phase 3 — Paper Trading API: accounts, orders, positions, ticks,
 * strategy deployments. All orders pass kill switch + mode + Risk Engine.
 */
class Api_paper extends Api_controller
{
    public function accounts()
    {
        $accounts = [];
        foreach ($this->platform->model->paper->listAccounts() as $a) {
            $accounts[] = $this->platform->paper->accountSummary((int)$a['id']);
        }
        $this->json(['accounts' => $accounts, 'tradingMode' => $this->platform->state()['tradingMode']]);
    }

    public function create_account()
    {
        $body = $this->checkedBody(['name', 'startingBalance']);
        if ($body === null) return;
        try {
            $account = $this->platform->paper->createAccount(
                (string)$body['name'],
                (float)$body['startingBalance'],
                (string)($body['currency'] ?? 'USD')
            );
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($e->getMessage());
        }
        $this->json($this->platform->paper->accountSummary((int)$account['id']), 201);
    }

    public function account(int $id)
    {
        try {
            $this->json($this->platform->paper->accountSummary($id));
        } catch (InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 404);
        }
    }

    public function orders(int $id)
    {
        $this->json(['orders' => $this->platform->model->paper->listOrders($id)]);
    }

    public function submit_order(int $id)
    {
        $body = $this->checkedBody(['symbol', 'side']);
        if ($body === null) return;
        $body['type'] = strtoupper((string)($body['type'] ?? 'MARKET'));
        $body['side'] = strtoupper((string)$body['side']);
        try {
            $result = $this->platform->paper->submitOrder($id, $body);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($e->getMessage(), 400);
        }
        $status = $result['order']['status'] === 'REJECTED' ? 409 : ($result['filled'] ? 201 : 202);
        $this->json($result, $status);
    }

    public function positions(int $id)
    {
        $summary = $this->platform->paper->accountSummary($id);
        $this->json(['positions' => $summary['positions'], 'closed' => $this->closedPositions($id)]);
    }

    private function closedPositions(int $id): array
    {
        $rows = $this->db->where('account_id', $id)->where('status', 'CLOSED')
            ->order_by('id', 'DESC')->limit(50)->get('paper_positions')->result_array();
        return $rows;
    }

    public function close_position(int $accountId, int $positionId)
    {
        try {
            $result = $this->platform->paper->closePosition($accountId, $positionId, 'MANUAL');
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($e->getMessage(), 404);
        }
        $this->json($result);
    }

    public function tick(int $id)
    {
        $result = $this->platform->paper->tick($id);
        $this->json($result);
    }

    public function deployments(int $id)
    {
        $this->json(['deployments' => $this->platform->model->paper->listDeployments($id)]);
    }

    public function deploy(int $id)
    {
        $body = $this->checkedBody(['strategyId', 'symbol', 'timeframe', 'marketClass']);
        if ($body === null) return;
        // Resolve the latest version when not specified (same as backtesting).
        $version = (string)($body['strategyVersion'] ?? '');
        if ($version === '') {
            foreach ($this->platform->model->strategies->all() as $r) {
                if ($r['strategy_id'] === $body['strategyId']) $version = $r['version'];
            }
        }
        try {
            $dep = $this->platform->paper->deployStrategy(
                $id,
                (string)$body['strategyId'],
                $version,
                (string)$body['symbol'],
                (string)$body['timeframe'],
                (string)$body['marketClass']
            );
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($e->getMessage(), 404);
        } catch (RuntimeException $e) {
            return $this->jsonError($e->getMessage(), 409);
        }
        $this->json($dep, 201);
    }

    public function toggle_deployment(int $accountId, int $deploymentId)
    {
        $body = $this->jsonBody();
        if (!isset($body['active']) || !is_bool($body['active'])) return $this->jsonError('body must be {active: boolean}');
        try {
            $this->json($this->platform->paper->pauseDeployment($deploymentId, $body['active']));
        } catch (InvalidArgumentException $e) {
            $this->jsonError($e->getMessage(), 404);
        }
    }

    private function checkedBody(array $fields): ?array
    {
        $body = $this->jsonBody();
        $missing = [];
        foreach ($fields as $f) {
            if (!isset($body[$f]) || $body[$f] === '') $missing[] = $f;
        }
        if ($missing) {
            $this->jsonError('missing required fields: ' . implode(', ', $missing));
            return null;
        }
        return $body;
    }
}
