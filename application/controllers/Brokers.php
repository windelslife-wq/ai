<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

/**
 * Phase 4/5 — Broker Center: connector health, capability status and
 * read-only MT5 account/quote views. No page here can place an order —
 * routing lives exclusively in the Execution Supervisor.
 */
class Brokers extends App_Controller
{
    /** Honest capability matrix for connectors whose provider integration is not verified. */
    private const PLANNED = [
        ['id' => 'mt4-bridge', 'name' => 'MetaTrader 4', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; verify against a real MT4 bridge after MT5 verification'],
        ['id' => 'binance', 'name' => 'Binance', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; provider-specific exchange mapping and demo/sandbox verification required'],
        ['id' => 'bybit', 'name' => 'Bybit', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required'],
        ['id' => 'okx', 'name' => 'OKX', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required'],
        ['id' => 'coinbase', 'name' => 'Coinbase', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required'],
        ['id' => 'kraken', 'name' => 'Kraken', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required'],
        ['id' => 'ib', 'name' => 'InteractiveBrokers', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; verify the gateway contract and demo account first'],
        ['id' => 'alpaca', 'name' => 'Alpaca', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; verify paper-account mapping and provider permissions first'],
        ['id' => 'oanda', 'name' => 'OANDA', 'status' => 'PLANNED', 'detail' => 'Contract adapter scaffolded; verify the practice-account mapping first'],
    ];

    /** Toggle the SIMULATED MT5 bridge (offline demo only; writes the marker
     *  file the dev runtime + front controller translate into env). */
    public function sim_toggle()
    {
        $markerPath = APPPATH . 'data/mt5-demo.json';
        $enable = $this->input->post('enable') === '1';
        if ($enable) {
            \Aegis\Brokers\DemoBridgeConfig::enable($markerPath, (int) (getenv('AEGIS_SIM_BRIDGE_PORT') ?: 8790));
            $this->platform->model->audit->emit('BROKER_SIMULATION_ENABLED', 'SIMULATED MT5 bridge enabled (offline demo) — in-process mock, never a real broker', [], 'user');
            $this->flash('notice', 'SIMULATED MT5 bridge enabled — it speaks the documented bridge contract with in-memory state. Everything it fills is SIMULATION. A real deployment still requires python-services/mt5-bridge on a MetaTrader host.');
        } else {
            \Aegis\Brokers\DemoBridgeConfig::disable($markerPath);
            $this->platform->model->audit->emit('BROKER_SIMULATION_DISABLED', 'SIMULATED MT5 bridge disabled', [], 'user');
            $this->flash('notice', 'SIMULATED MT5 bridge disabled — routing is blocked again.');
        }
        redirect('/brokers');
    }

    public function index()
    {
        $data = $this->base('Broker Center');
        $data['connectors'] = $this->platform->brokers->allStatus();
        $data['planned'] = self::PLANNED;
        $data['routable'] = $this->platform->brokers->tradingConnector() !== null;
        $data['sim'] = \Aegis\Brokers\DemoBridgeConfig::describe(APPPATH . 'data/mt5-demo.json');
        $data['account'] = null;
        $data['quote'] = null;
        $data['quoteSymbol'] = strtoupper((string) $this->input->get('symbol'));
        $connector = $this->platform->brokers->get('mt5-bridge');
        if ($connector instanceof \Aegis\Brokers\Mt5BridgeConnector) {
            try { $data['account'] = $connector->account(); } catch (Throwable $e) { /* stays null */ }
            if ($data['quoteSymbol'] !== '') {
                try { $data['quote'] = $connector->quote($data['quoteSymbol']); } catch (Throwable $e) { /* stays null */ }
            }
        }
        $this->load->view('layout/header', $data);
        $this->load->view('brokers/index', $data);
        $this->load->view('layout/footer');
    }

    private function base(string $title): array
    {
        $state = $this->platform->state();
        return [
            'title' => $title, 'active' => 'brokers',
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
