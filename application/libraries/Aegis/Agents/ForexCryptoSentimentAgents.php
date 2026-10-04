<?php
namespace Aegis\Agents;

use Aegis\Agents\AgentHelperTrait;
use Aegis\Indicators;
use Aegis\MathUtils;
use Aegis\Providers\FrankfurterProvider;
use Aegis\Providers\SentimentFeed;
use Aegis\Providers\SentimentSnapshotValidator;
use Aegis\Providers\UnavailableSentimentFeed;

/**
 * Forex Agent — real price-derived work only; macro inputs (rate
 * differentials, CPI/NFP/FOMC calendar) require a macro provider that is
 * NOT configured, and the report says so explicitly.
 */
class ForexAgent
{
    use AgentHelperTrait;

    public const ID = 'forex';
    private const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];
    private const USD_MATRIX = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'];
    private const MINORS = ['EURGBP','EURJPY','GBPJPY','AUDJPY','EURCHF','AUDNZD','EURAUD','CADJPY','CHFJPY'];

    public function applicable(array $ctx): bool
    {
        return in_array($ctx['series']['marketClass'], ['forex', 'commodity'], true);
    }

    public function analyze(array $ctx): array
    {
        $symbol = strtoupper($ctx['series']['symbol']);
        $candles = $ctx['series']['candles'];
        $closes = array_map(fn($c) => $c['close'], $candles);
        $price = end($closes);
        [$base, $quote] = FrankfurterProvider::splitPair($symbol);
        $atr14 = Indicators::last(Indicators::atr($candles, 14));
        $atrPct = $atr14 !== null ? ($atr14 / $price) * 100 : null;
        $ema20 = Indicators::last(Indicators::ema($closes, 20));
        $ema50 = Indicators::last(Indicators::ema($closes, 50));
        $aligned = ($ema20 !== null && $ema50 !== null) ? $ema20 > $ema50 : null;
        $volLabel = $atrPct === null ? 'normal' : ($atrPct > 1.2 ? 'high' : ($atrPct < 0.25 ? 'low' : 'normal'));
        $session = $this->sessionInfo((int)$ctx['now']);
        $strength = $this->currencyStrength($ctx, $base, $quote);

        $score = 0.0;
        $reasons = [];
        if ($aligned !== null) {
            $score += $aligned ? 0.4 : -0.4;
            $reasons[] = sprintf('EMA20 %s EMA50', $aligned ? 'above' : 'below');
        }
        if ($strength['strongest'] === $base) { $score += 0.25; $reasons[] = "{$base} is the strongest leg of the USD matrix"; }
        if ($strength['strongest'] === $quote) { $score -= 0.25; $reasons[] = "{$quote} is the strongest leg of the USD matrix"; }
        if ($strength['weakest'] === $base) { $score -= 0.2; $reasons[] = "{$base} is the weakest leg of the USD matrix"; }
        if ($strength['weakest'] === $quote) { $score += 0.2; $reasons[] = "{$quote} is the weakest leg of the USD matrix"; }
        $baseScore = 0.0; $quoteScore = 0.0;
        foreach ($strength['scores'] as $s) {
            if ($s['currency'] === $base) $baseScore = $s['score'];
            if ($s['currency'] === $quote) $quoteScore = $s['score'];
        }
        $score += MathUtils::clamp(($baseScore - $quoteScore) * 0.5, -0.2, 0.2);

        return [
            'agent' => 'forex',
            'title' => 'Forex Analysis Agent',
            'generatedAt' => $ctx['now'],
            'dataQuality' => TechnicalAgent::dataQuality($ctx['series']),
            'dataLimitations' => [
                'Interest-rate differentials: no macro provider configured',
                'Economic calendar (CPI/NFP/FOMC): no macro provider configured',
                'Central-bank events: no macro provider configured',
            ],
            'warnings' => $strength['synthetic'] ? ['Currency strength computed from SYNTHETIC candles — not representative of real markets'] : [],
            'vote' => $this->makeVote($score, self::WEIGHTS['forex'], implode('; ', $reasons) ?: 'no decisive forex edge'),
            'pair' => [
                'symbol' => $symbol, 'base' => $base, 'quote' => $quote,
                'classification' => $symbol === 'XAUUSD' ? 'other' : (in_array($symbol, self::MAJORS, true) ? 'major' : (in_array($symbol, self::MINORS, true) ? 'minor' : 'exotic')),
            ],
            'volatility' => ['atrPct' => $atrPct !== null ? round($atrPct, 3) : null, 'label' => $volLabel],
            'trendAlignment' => [
                'emaFastAboveSlow' => $aligned,
                'detail' => ($ema20 !== null && $ema50 !== null) ? sprintf('EMA20 %s vs EMA50 %s', number_format($ema20, 5), number_format($ema50, 5)) : 'insufficient data',
            ],
            'session' => $session,
            'macro' => [
                'available' => false,
                'reason' => 'No economic-calendar / macro provider configured. Rate differentials, CPI, NFP and FOMC analysis remain disabled until one is added.',
            ],
            'currencyStrength' => $strength,
        ];
    }

    private function currencyStrength(array $ctx, string $base, string $quote): array
    {
        $contrib = [];
        $bars = 24;
        $collect = function (string $sym, ?array $series) use (&$contrib) {
            if (!$series || count($series['candles']) < 10) { return; }
            $cs = array_slice($series['candles'], -24);
            $ret = (end($cs)['close'] - $cs[0]['close']) / $cs[0]['close'];
            [$b, $q] = FrankfurterProvider::splitPair($sym);
            $contrib[$b][] = $ret;
            $contrib[$q][] = -$ret;
        };
        $refs = $ctx['referenceSeries'] ?? [];
        if (count($refs) > 0) {
            foreach ($refs as $ref) { $collect($ref['symbol'], $ref['series']); }
        } else {
            $collect($ctx['series']['symbol'], $ctx['series']);
        }
        $scores = [];
        foreach ($contrib as $currency => $rets) {
            $scores[] = ['currency' => $currency, 'score' => round(array_sum($rets) / count($rets), 5)];
        }
        usort($scores, fn($a, $b) => $b['score'] <=> $a['score']);
        $synthetic = !empty($ctx['series']['provenance']['synthetic']);
        foreach ($refs as $ref) { if (!empty($ref['series']['provenance']['synthetic'])) $synthetic = true; }
        return [
            'derivedFrom' => 'price-momentum',
            'synthetic' => $synthetic,
            'scores' => array_values($scores),
            'strongest' => $scores[0]['currency'] ?? null,
            'weakest' => $scores ? end($scores)['currency'] : null,
            'note' => 'Computed from USD-matrix price momentum only — this is NOT news or fundamental data.',
        ];
    }

    private function sessionInfo(int $now): array
    {
        $h = (int)gmdate('G', (int)($now / 1000));
        $name = 'Off-hours';
        if ($h >= 0 && $h < 7) $name = 'Asia (Tokyo)';
        elseif ($h >= 7 && $h < 12) $name = 'London';
        elseif ($h >= 12 && $h < 17) $name = 'London/New York overlap';
        elseif ($h >= 17 && $h < 21) $name = 'New York';
        $active = $name !== 'Off-hours';
        return [
            'name' => $name, 'utcHour' => $h, 'active' => $active,
            'note' => $active ? 'Session liquidity is generally available' : 'Thin liquidity — wider spreads and false moves are more likely',
        ];
    }
}

/**
 * Crypto Agent — price action, volume, liquidity and volatility from real
 * candles; on-chain, derivatives and dominance honestly "unavailable".
 */
class CryptoAgent
{
    use AgentHelperTrait;

    public const ID = 'crypto';

    public function applicable(array $ctx): bool
    {
        return $ctx['series']['marketClass'] === 'crypto';
    }

    public function analyze(array $ctx): array
    {
        $candles = $ctx['series']['candles'] ?? [];
        if (!is_array($candles) || $candles === []) {
            throw new \RuntimeException('insufficient candles for crypto analysis');
        }
        $closes = array_map(fn($c) => $c['close'], $candles);
        $n = count($closes);
        $price = end($closes);

        $bars24 = min(24, $n - 1);
        $bars7d = min(168, $n - 1);
        $chg24 = $bars24 > 0 ? (($price - $closes[$n - 1 - $bars24]) / $closes[$n - 1 - $bars24]) * 100 : null;
        $chg7 = $bars7d > 0 ? (($price - $closes[$n - 1 - $bars7d]) / $closes[$n - 1 - $bars7d]) * 100 : null;

        $volumes = array_map(fn($c) => $c['volume'], $candles);
        $volAvg = Indicators::last(Indicators::sma($volumes, 30));
        $hasVolume = count(array_filter($volumes, fn($v) => $v > 0)) > 0;
        $latestVsAvg = ($hasVolume && $volAvg !== null && $volAvg > 0) ? end($volumes) / $volAvg : null;

        $atr14 = Indicators::last(Indicators::atr($candles, 14));
        $atrPct = $atr14 !== null ? ($atr14 / $price) * 100 : null;
        $volLabel = $atrPct === null ? 'normal' : ($atrPct > 3.5 ? 'high' : ($atrPct < 0.8 ? 'low' : 'normal'));

        $ema20 = Indicators::last(Indicators::ema($closes, 20));
        $ema50 = Indicators::last(Indicators::ema($closes, 50));
        $trendLabel = ($ema20 !== null && $ema50 !== null) ? ($ema20 > $ema50 ? 'short-term uptrend' : 'short-term downtrend') : 'undetermined';

        $score = 0.0;
        $reasons = [];
        if ($chg24 !== null) { $score += MathUtils::clamp($chg24 / 6, -0.35, 0.35); $reasons[] = sprintf('24h move %s%%', number_format($chg24, 2)); }
        if ($chg7 !== null) { $score += MathUtils::clamp($chg7 / 15, -0.25, 0.25); $reasons[] = sprintf('7d move %s%%', number_format($chg7, 2)); }
        if ($ema20 !== null && $ema50 !== null) { $score += $ema20 > $ema50 ? 0.25 : -0.25; $reasons[] = $trendLabel; }
        if ($latestVsAvg !== null && $latestVsAvg > 1.5) {
            if ($chg24 !== null && $chg24 > 0) { $score += 0.15; $reasons[] = 'volume expansion confirms buying'; }
            if ($chg24 !== null && $chg24 < 0) { $score -= 0.15; $reasons[] = 'volume expansion confirms selling'; }
        }

        return [
            'agent' => 'crypto',
            'title' => 'Cryptocurrency Intelligence Agent',
            'generatedAt' => $ctx['now'],
            'dataQuality' => TechnicalAgent::dataQuality($ctx['series']),
            'dataLimitations' => array_merge([
                'On-chain data: no provider configured',
                'Funding rates & open interest: no derivatives provider configured',
                'Market dominance: no aggregator configured',
                'Exchange flows / whale activity: no provider configured',
            ], $hasVolume ? [] : ['Provider supplies no volume data — volume analysis unavailable']),
            'warnings' => !empty($ctx['series']['provenance']['synthetic'])
                ? ['Candles are SYNTHETIC — analysis is a simulation, not market reality'] : [],
            'vote' => $this->makeVote($score, self::WEIGHTS['crypto'], implode('; ', $reasons) ?: 'no decisive crypto edge'),
            'priceAction' => [
                'changePct24h' => $chg24 !== null ? round($chg24, 2) : null,
                'changePct7d' => $chg7 !== null ? round($chg7, 2) : null,
                'trendLabel' => $trendLabel,
            ],
            'volume' => [
                'latestVsAverage' => $latestVsAvg !== null ? round($latestVsAvg, 2) : null,
                'trendLabel' => !$hasVolume ? 'unavailable (no volume data)'
                    : ($latestVsAvg === null ? 'undetermined'
                    : ($latestVsAvg > 1.5 ? 'expansion' : ($latestVsAvg < 0.6 ? 'contraction' : 'average'))),
            ],
            'volatility' => ['atrPct' => $atrPct !== null ? round($atrPct, 2) : null, 'label' => $volLabel],
            'onChain' => ['dataAvailable' => false, 'warning' => 'On-chain provider not configured'],
            'derivatives' => ['dataAvailable' => false, 'warning' => 'Derivatives provider not configured — funding rates and open interest analysis disabled'],
            'marketDominance' => ['dataAvailable' => false, 'warning' => 'Market-cap aggregator not configured — dominance analysis disabled'],
        ];
    }
}

/**
 * Sentiment Agent — Phase 6 boundary: consumes a licensed, attributable
 * SentimentFeed and validates every snapshot for provenance and freshness.
 * Without a configured feed — or when the data is stale, unlicensed or too
 * thin to be a sentiment view — it ABSTAINS and cannot affect consensus.
 * Price/volume proxies are explicitly NOT presented as sentiment (they
 * belong to the Technical Agent).
 */
class SentimentAgent
{
    use AgentHelperTrait;

    public const ID = 'sentiment';

    public function __construct(
        private SentimentFeed $feed = new UnavailableSentimentFeed(),
        private SentimentSnapshotValidator $validator = new SentimentSnapshotValidator(),
    ) {}

    public function applicable(array $ctx): bool { return true; }

    public function analyze(array $ctx): array
    {
        $snapshot = $this->feed->snapshot($ctx['series']['symbol']);
        $check = $this->validator->validate($snapshot, time());
        $provenance = [
            'source' => $check['provenance']['source'] ?? ($snapshot['source'] ?? null),
            'licensed' => (bool) ($snapshot['licensed'] ?? false),
            'feed' => $this->feed->id(),
        ];
        if (!$check['ok']) {
            return [
                'agent' => self::ID, 'title' => 'Sentiment Analysis Agent',
                'generatedAt' => $ctx['now'], 'dataQuality' => 0.0,
                'dataLimitations' => [$check['reason']],
                'warnings' => ['Sentiment unavailable (' . $check['reason'] . ') — consensus is computed without any sentiment input'],
                'vote' => [
                    'directionalScore' => 0.0, 'signal' => 'NEUTRAL',
                    'weight' => self::WEIGHTS['sentiment'], 'votes' => false,
                    'reason' => $check['reason'] . ' — abstaining',
                ],
                'news' => ['available' => false, 'reason' => $check['reason']],
                'social' => ['available' => false, 'reason' => $check['reason']],
                'note' => 'Price/volume proxies are handled by the Technical Agent and are deliberately NOT presented as sentiment.',
                'provenance' => $provenance,
            ];
        }
        $obs = $check['observations'];
        $news = array_values(array_filter($obs, fn($o) => $o['channel'] === 'news'));
        $social = array_values(array_filter($obs, fn($o) => $o['channel'] === 'social'));
        $score = (float) $check['score'];
        $reasons = sprintf('%d attributable observation(s) within %ds (news %d, social %d), mean score %+.2f',
            count($obs), $this->validator->maxAgeSeconds(), count($news), count($social), $score);
        if (!empty($check['rejectedCount'])) {
            $reasons .= sprintf(' (%d observation(s) excluded as stale or unattributable)', (int) $check['rejectedCount']);
        }
        return [
            'agent' => self::ID, 'title' => 'Sentiment Analysis Agent',
            'generatedAt' => $ctx['now'],
            // documented bounded quality: floor 0.4 + 0.1 per valid observation
            // + 0.05 per covered channel, capped at 1.0
            'dataQuality' => round(min(1.0, 0.4 + 0.1 * count($obs) + 0.05 * count($news) + 0.05 * count($social)), 3),
            'dataLimitations' => ['Sentiment is a bounded, low-weight input (weight 0.5) — it can never override the risk engine or a NO_TRADE gate'],
            'warnings' => [],
            'vote' => $this->makeVote($score, self::WEIGHTS['sentiment'], $reasons),
            'news' => ['available' => count($news) > 0, 'observations' => array_slice($news, 0, 10)],
            'social' => ['available' => count($social) > 0, 'observations' => array_slice($social, 0, 10)],
            'note' => 'Licensed ' . $this->feed->id() . ' feed; every observation carries its own source and timestamp.',
            'provenance' => array_merge($provenance, ['observedAt' => $check['provenance']['observedAt'], 'observedAtRange' => $check['provenance']['observedAtRange']]),
        ];
    }
}
