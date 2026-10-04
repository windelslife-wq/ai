<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Api_analysis extends Api_controller
{
    private const MARKET_CLASSES = ['forex', 'crypto', 'stock', 'etf', 'commodity', 'futures', 'options', 'indices', 'bonds'];
    private const WATCHLIST = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    public function run()
    {
        $body = $this->jsonBody();
        $symbol = strtoupper((string)($body['symbol'] ?? ''));
        $marketClass = (string)($body['marketClass'] ?? '');
        $timeframe = (string)($body['timeframe'] ?? '1h');
        if (strlen($symbol) < 2) return $this->jsonError('symbol required (min 2 chars)');
        if (!in_array($marketClass, self::MARKET_CLASSES, true)) return $this->jsonError('invalid marketClass');
        if (!in_array($timeframe, ['1m', '5m', '15m', '1h', '4h', '1d'], true)) return $this->jsonError('invalid timeframe');
        try {
            $run = $this->platform->engine->run($symbol, $marketClass, $timeframe);
        } catch (Throwable $e) {
            return $this->jsonError($e->getMessage(), 502);
        }
        $this->json($run);
    }

    public function history()
    {
        $this->json(['runs' => $this->platform->model->analysis->history(20)]);
    }

    public function show(string $id)
    {
        $run = $this->platform->model->analysis->find($id);
        if (!$run) return $this->jsonError('analysis run not found', 404);
        $this->json($run);
    }

    public function agents()
    {
        $this->json(['agents' => [
            ['id' => 'technical', 'title' => 'Technical Analysis Agent', 'description' => 'SMA/EMA/RSI/MACD/BB/ATR/ADX/VWAP/Stochastic/S-R/pivots/volume profile'],
            ['id' => 'market-structure', 'title' => 'Market Structure Agent', 'description' => 'Swings, BOS/CHoCH with close-confirmation, liquidity, S/D zones, order blocks, FVGs'],
            ['id' => 'forex', 'title' => 'Forex Analysis Agent', 'description' => 'Classification, volatility, sessions, price-momentum currency strength; macro unavailable (no provider)'],
            ['id' => 'crypto', 'title' => 'Cryptocurrency Intelligence Agent', 'description' => 'Price/volume/volatility from candles; on-chain/derivatives/dominance honestly unavailable'],
            ['id' => 'sentiment', 'title' => 'Sentiment Analysis Agent', 'description' => 'Abstains until real news/social providers are configured'],
            ['id' => 'intelligence', 'title' => 'Trading Intelligence Agent', 'description' => 'Consensus: confluence, confidence, conflicts, BUY/SELL/HOLD/NO_TRADE'],
        ]]);
    }

    public function consensus()
    {
        $body = $this->jsonBody();
        $timeframe = (string)($body['timeframe'] ?? '1h');
        if (!in_array($timeframe, ['15m', '1h', '4h', '1d'], true)) $timeframe = '1h';
        $symbols = $body['symbols'] ?? self::WATCHLIST;
        if (!is_array($symbols) || count($symbols) < 1 || count($symbols) > 10) {
            return $this->jsonError('symbols must be an array of 1–10 symbols');
        }
        $requests = [];
        foreach ($symbols as $s) {
            $sym = strtoupper((string)$s);
            $requests[] = [
                'symbol' => $sym,
                'marketClass' => $this->platform->paper->inferMarketClass($sym) === 'commodity' ? 'commodity'
                    : (str_ends_with($sym, 'USDT') ? 'crypto' : 'forex'),
                'timeframe' => $timeframe,
            ];
        }
        $this->json(['generatedAt' => gmdate('c'), 'consensus' => $this->platform->engine->consensus($requests)]);
    }
}
