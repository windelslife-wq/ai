<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Api_marketdata extends Api_controller
{
    private const MARKET_CLASSES = ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'options', 'indices', 'bonds'];

    public function candles()
    {
        $symbol = strtoupper((string)$this->input->get('symbol'));
        $timeframe = (string)($this->input->get('timeframe') ?: '1h');
        $limit = (int)($this->input->get('limit') ?: 200);
        $marketClass = (string)($this->input->get('marketClass') ?: $this->inferClass($symbol));
        if (strlen($symbol) < 2) return $this->jsonError('symbol required');
        if (!in_array($timeframe, ['1m', '5m', '15m', '1h', '4h', '1d'], true)) return $this->jsonError('invalid timeframe');
        if (!in_array($marketClass, self::MARKET_CLASSES, true)) return $this->jsonError('invalid marketClass');
        $limit = max(30, min(5000, $limit));
        try {
            $series = $this->platform->providers->getCandleSeries($symbol, $marketClass, $timeframe, $limit);
        } catch (Throwable $e) {
            return $this->jsonError($e->getMessage(), 502);
        }
        $this->json($series);
    }

    public function quote()
    {
        $symbol = strtoupper((string)$this->input->get('symbol'));
        if (strlen($symbol) < 2) return $this->jsonError('symbol required');
        try {
            $this->json($this->platform->providers->getQuote($symbol));
        } catch (Throwable $e) {
            return $this->jsonError($e->getMessage(), 502);
        }
    }

    public function providers()
    {
        $registry = array_map(fn($p) => [
            'name' => $p->name(), 'synthetic' => $p->synthetic(), 'priority' => $p->priority(),
            'capabilities' => $p->capabilities(),
        ], $this->platform->providers->listProviders());
        $this->json([
            'providers' => $this->platform->providers->getAllHealth(true),
            'registry' => $registry,
        ]);
    }

    private function inferClass(string $symbol): string
    {
        return str_ends_with($symbol, 'USDT') ? 'crypto' : 'forex';
    }
}
