<?php
namespace Aegis;

use Aegis\Agents\CryptoAgent;
use Aegis\Agents\ForexAgent;
use Aegis\Agents\FundamentalsAgent;
use Aegis\Agents\MarketStructureAgent;
use Aegis\Agents\SentimentAgent;
use Aegis\Agents\TechnicalAgent;
use Aegis\Agents\TradingIntelligenceAgent;
use Aegis\Persistence\AnalysisRepository;
use Aegis\Persistence\AuditRepository;
use Aegis\Providers\SentimentFeed;
use Aegis\Providers\UnavailableSentimentFeed;

/**
 * TRADING INTELLIGENCE ENGINE — data -> agents -> consensus -> regime ->
 * scenarios -> setup -> RISK ENGINE. Analysis produces proposals only;
 * nothing here can place an order (Rule 1).
 */
class TradingIntelligenceEngine
{
    public const CANDLE_LIMIT = 300;

    private TechnicalAgent $technical;
    private MarketStructureAgent $structure;
    private ForexAgent $forex;
    private CryptoAgent $crypto;
    private SentimentAgent $sentiment;
    private FundamentalsAgent $fundamentals;
    private TradingIntelligenceAgent $intelligence;

    public function __construct(
        private readonly ProviderManager $providers,
        private readonly RiskEngine $risk,
        private readonly AnalysisRepository $runs,
        private readonly AuditRepository $audit,
        private readonly array $state, // {tradingMode, killSwitch}
        ?SentimentFeed $sentimentFeed = null, // Phase 6: licensed sentiment feed (default: honest abstention)
    ) {
        $this->technical = new TechnicalAgent();
        $this->structure = new MarketStructureAgent();
        $this->forex = new ForexAgent();
        $this->crypto = new CryptoAgent();
        $this->sentiment = new SentimentAgent($sentimentFeed ?? new UnavailableSentimentFeed());
        $this->fundamentals = new FundamentalsAgent();
        $this->intelligence = new TradingIntelligenceAgent();
    }

    public function run(string $symbol, string $marketClass, string $timeframe): array
    {
        $startedAt = gmdate('c');
        $symbol = strtoupper($symbol);

        $series = $this->providers->getCandleSeries($symbol, $marketClass, $timeframe, self::CANDLE_LIMIT);

        $referenceSeries = [];
        if (in_array($marketClass, ['forex', 'commodity'], true)) {
            foreach (['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'] as $refSymbol) {
                try {
                    $ref = $this->providers->getCandleSeries($refSymbol, 'forex', $timeframe, 60);
                    $referenceSeries[] = ['symbol' => $refSymbol, 'series' => $ref];
                } catch (\Throwable $e) { /* best effort */ }
            }
        }

        $ctx = ['series' => $series, 'now' => (int)(microtime(true) * 1000), 'referenceSeries' => $referenceSeries];
        $reports = [];
        foreach ([$this->technical, $this->structure, $this->forex, $this->crypto, $this->sentiment, $this->fundamentals] as $agent) {
            if (!$agent->applicable($ctx)) continue;
            try {
                $reports[] = $agent->analyze($ctx);
            } catch (\Throwable $e) {
                $this->audit->emit('TRADE_REJECTED', 'Agent ' . $agent::ID . ' failed', ['error' => $e->getMessage()]);
            }
        }

        $regime = Analysis::detectRegime($series);
        $freshness = !empty($series['provenance']['stale']) ? 0.2
            : (!empty($series['provenance']['synthetic']) ? 0.5 : 1.0);
        $withData = array_values(array_filter($reports, fn($r) => $r['dataQuality'] > 0));
        $dataQuality = count($withData) ? array_sum(array_map(fn($r) => $r['dataQuality'], $withData)) / count($withData) : 0.5;
        $consensus = $this->intelligence->combine($reports, [
            'dataQuality' => $dataQuality,
            'regimeClarity' => $regime['confidence'] * Analysis::regimeDirectionality($regime['regime']),
            'freshnessFactor' => $freshness,
        ]);

        $technicalReport = null; $structureReport = null;
        foreach ($reports as $r) {
            if ($r['agent'] === 'technical') $technicalReport = $r;
            if ($r['agent'] === 'market-structure') $structureReport = $r;
        }
        $price = count($series['candles']) ? end($series['candles'])['close'] : 0.0;
        $scenarios = $technicalReport
            ? Analysis::buildScenarios($series, $technicalReport, $consensus['bias'], $price)
            : ['bullish' => ['summary' => 'insufficient data', 'triggers' => [], 'targets' => [], 'invalidation' => '', 'probabilityHint' => 'alternate'],
               'bearish' => ['summary' => 'insufficient data', 'triggers' => [], 'targets' => [], 'invalidation' => '', 'probabilityHint' => 'alternate'],
               'neutral' => ['summary' => 'insufficient data', 'triggers' => [], 'targets' => [], 'invalidation' => '', 'probabilityHint' => 'base']];

        $setup = null;
        if ($technicalReport && $structureReport && in_array($consensus['bias'], ['BULLISH', 'BEARISH'], true)) {
            $setup = Analysis::generateSetup($series, $technicalReport, $structureReport, $consensus['bias'], $consensus['confidence']);
        }

        $riskDecision = null;
        if ($setup !== null) {
            $riskDecision = $this->risk->evaluate($setup, [
                'killSwitchActive' => $this->state['killSwitch']['active'],
                'dataQuality' => $dataQuality,
                'syntheticData' => $series['provenance']['synthetic'],
                'staleData' => $series['provenance']['stale'],
                'equity' => $this->state['paperEquity'] ?? 10000,
                'openRiskBySymbol' => $this->state['openRiskBySymbol'] ?? [],
                'openPositions' => $this->state['openPositions'] ?? 0,
            ]);
        }

        // Phase 6: adversarial review. The debate verdict can only REDUCE a
        // bias or drop the setup — it can never manufacture conviction.
        $debate = \Aegis\Agents\AgentDebate::run($reports, $consensus, $regime, $setup, $series['provenance'], $this->risk->getLimits());
        if ($debate['verdict']['bias'] === 'NO_TRADE') {
            $consensus['bias'] = 'NO_TRADE';
            $consensus['recommendation'] = 'NO_TRADE';
            $consensus['confidence'] = $debate['verdict']['confidence'];
            $setup = null;
            $riskDecision = null;
        } elseif ($debate['verdict']['bias'] === 'NEUTRAL' && in_array($consensus['bias'], ['BULLISH', 'BEARISH'], true)) {
            $consensus['bias'] = 'NEUTRAL';
            $consensus['recommendation'] = 'HOLD';
            $consensus['confidence'] = $debate['verdict']['confidence'];
            $setup = null;
            $riskDecision = null;
        } else {
            $consensus['confidence'] = $debate['verdict']['confidence'];
        }

        $run = [
            'id' => Backtest\Backtester::uuid(),
            'request' => ['symbol' => $symbol, 'marketClass' => $marketClass, 'timeframe' => $timeframe],
            'startedAt' => $startedAt, 'completedAt' => gmdate('c'),
            'symbol' => $symbol, 'timeframe' => $timeframe,
            'marketRegime' => $regime['regime'], 'regimeAssessment' => $regime,
            'bias' => $consensus['bias'], 'confidence' => $consensus['confidence'],
            'confluence' => $consensus['confluenceScore'], 'recommendation' => $consensus['recommendation'],
            'reasoning' => $consensus['reasoning'],
            'conflicts' => $consensus['consensus']['conflicts'], 'consensus' => $consensus['consensus'],
            'debate' => $debate,
            'signals' => $technicalReport['signals'] ?? [],
            'scenarios' => $scenarios, 'tradeSetup' => $setup, 'riskDecision' => $riskDecision,
            'agents' => $reports, 'provenance' => $series['provenance'], 'validation' => $series['validation'],
            'quote' => null,
        ];
        try {
            $q = $this->providers->getQuote($symbol);
            $run['quote'] = $q['quote'];
        } catch (\Throwable $e) { /* quote optional */ }

        $this->runs->save($run);
        $this->audit->emit('TRADE_ANALYZED', "{$symbol} {$timeframe}: {$run['bias']} @ " . number_format($run['confidence'], 2) . ' confidence', [
            'runId' => $run['id'], 'regime' => $run['marketRegime'], 'source' => $run['provenance']['source'], 'synthetic' => $run['provenance']['synthetic'],
        ]);
        if ($setup !== null) {
            $this->audit->emit('SIGNAL_GENERATED', "{$symbol} {$setup['action']} setup proposed (R:R {$setup['riskReward']})", [
                'runId' => $run['id'], 'entry' => $setup['entry'], 'stopLoss' => $setup['stopLoss'],
            ]);
            if ($riskDecision !== null) {
                $this->audit->emit($riskDecision['approved'] ? 'RISK_APPROVED' : 'RISK_REJECTED', "{$symbol} setup " . ($riskDecision['approved'] ? 'approved' : 'rejected') . ' by Risk Engine', [
                    'runId' => $run['id'], 'reasons' => $riskDecision['reasons'],
                ]);
            }
        } else {
            $this->audit->emit('NO_SIGNAL', "{$symbol} {$timeframe}: no tradeable setup", ['runId' => $run['id'], 'bias' => $run['bias']]);
        }

        return $run;
    }

    public function consensus(array $requests): array
    {
        $out = [];
        foreach ($requests as $req) {
            try {
                $run = $this->run($req['symbol'], $req['marketClass'], $req['timeframe']);
                $out[] = [
                    'symbol' => $run['symbol'], 'marketClass' => $req['marketClass'], 'timeframe' => $run['timeframe'],
                    'bias' => $run['bias'], 'recommendation' => $run['recommendation'],
                    'confidence' => $run['confidence'], 'confluence' => $run['confluence'],
                    'regime' => $run['marketRegime'], 'synthetic' => $run['provenance']['synthetic'],
                    'source' => $run['provenance']['source'],
                ];
            } catch (\Throwable $e) {
                $out[] = [
                    'symbol' => strtoupper($req['symbol']), 'marketClass' => $req['marketClass'], 'timeframe' => $req['timeframe'],
                    'bias' => 'NO_TRADE', 'recommendation' => 'NO_TRADE', 'confidence' => 0, 'confluence' => 0,
                    'regime' => 'UNKNOWN', 'synthetic' => false, 'source' => 'error: ' . $e->getMessage(),
                ];
            }
        }
        return $out;
    }
}
