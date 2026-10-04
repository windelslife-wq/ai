<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';

class Welcome extends App_Controller
{
    public function index()
    {
        $state = $this->platform->state();
        $data = [
            'title' => 'AI Workforce',
            'active' => 'dashboard',
            'status' => $this->statusView(),
            'symbols' => $this->symbols(),
            'timeframes' => ['15m', '1h', '4h', '1d'],
            'symbol' => strtoupper((string)($this->input->post_get('symbol') ?: 'BTCUSDT')),
            'timeframe' => (string)($this->input->post_get('timeframe') ?: '1h'),
            'run' => null,
            'watch' => [],
            'error' => null,
            'events' => $this->platform->model->audit->recent(12),
            'notice' => $this->session->flashdata('notice'),
            'modeError' => $this->session->flashdata('modeError'),
            'history' => $this->platform->model->analysis->history(8),
        ];

        if ($this->input->post_get('symbol') !== null) {
            $marketClass = $this->platform->paper->inferMarketClass($data['symbol']) === 'commodity'
                ? 'commodity'
                : (str_ends_with($data['symbol'], 'USDT') ? 'crypto' : 'forex');
            try {
                $data['run'] = $this->platform->engine->run($data['symbol'], $marketClass, $data['timeframe']);
                // chart candles from the same provenance for visual honesty
                $data['candles'] = $this->platform->providers->getCandleSeries($data['symbol'], $marketClass, $data['timeframe'], 200)['candles'];
            } catch (Throwable $e) {
                $data['error'] = $e->getMessage();
            }
        }
        try {
            $data['watch'] = $this->platform->engine->consensus(array_map(fn($s) => [
                'symbol' => $s,
                'marketClass' => str_ends_with($s, 'USDT') ? 'crypto' : 'forex',
                'timeframe' => $data['timeframe'],
            ], ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT']));
        } catch (Throwable $e) { /* watchlist optional */ }

        $this->load->view('layout/header', $data);
        $this->load->view('welcome/index', $data);
        $this->load->view('layout/footer');
    }

    public function kill_switch()
    {
        $active = $this->input->post('active') === '1';
        $this->platform->setKillSwitch($active, $active ? 'engaged from dashboard' : 'released from dashboard');
        redirect('/analysis');
    }

    public function mode()
    {
        $mode = (string)$this->input->post('mode');
        $result = $this->platform->setTradingMode($mode);
        $this->session->set_flashdata($result['ok'] ? 'notice' : 'modeError', $result['message']);
        redirect('/analysis');
    }

    private function statusView(): array
    {
        $state = $this->platform->state();
        return [
            'tradingMode' => $state['tradingMode'],
            'killSwitch' => $state['killSwitch'],
            'providers' => $this->platform->providers->getAllHealth(),
        ];
    }

    private function symbols(): array
    {
        return [
            'Crypto' => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
            'Forex & Metals' => ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD'],
        ];
    }
}
