<?php
namespace Aegis\Optimization;

/**
 * Research-only long-only portfolio optimizer.
 *
 * Estimates annualized arithmetic returns and sample covariance from aligned
 * close-to-close price observations, applies diagonal covariance shrinkage,
 * and produces minimum-variance and maximum-Sharpe allocations under a fully
 * invested, long-only, per-asset weight cap. It never places or sizes orders.
 *
 * The caller is responsible for fetching and labeling data provenance. Each
 * asset input has the shape {symbol, marketClass?, candles, provenance?}; each
 * candle needs a positive integer timestamp and positive close price.
 */
final class PortfolioOptimizer
{
    public const MIN_ASSETS = 2;
    public const MAX_ASSETS = 12;
    public const MIN_RETURN_OBSERVATIONS = 30;
    private const MAX_PRICE_ROWS_PER_ASSET = 2500;
    private const MAX_ITERATIONS = 2000;
    private const EPSILON = 1.0e-12;

    /**
     * @param array<int,array{symbol:string,marketClass?:string,candles:array,provenance?:array}> $assets
     * @param array{objective?:string,maxWeight?:float,riskFreeRate?:float,shrinkage?:float,periodsPerYear?:int,timeframe?:string} $options
     * @return array<string,mixed>
     */
    public static function optimize(array $assets, array $options = []): array
    {
        $assetCount = count($assets);
        if ($assetCount < self::MIN_ASSETS || $assetCount > self::MAX_ASSETS) {
            throw new \InvalidArgumentException(sprintf('portfolio optimization requires %d–%d assets', self::MIN_ASSETS, self::MAX_ASSETS));
        }

        $objective = strtolower(trim((string) ($options['objective'] ?? 'max_sharpe')));
        if (!in_array($objective, ['max_sharpe', 'min_variance'], true)) {
            throw new \InvalidArgumentException('objective must be max_sharpe or min_variance');
        }
        $maxWeight = self::finiteNumber($options['maxWeight'] ?? 0.6, 'maxWeight');
        if ($maxWeight <= 0 || $maxWeight > 1 || $maxWeight + self::EPSILON < 1 / $assetCount) {
            throw new \InvalidArgumentException(sprintf('maxWeight must be between %.6f and 1.0 for %d assets', 1 / $assetCount, $assetCount));
        }
        $riskFreeRate = self::finiteNumber($options['riskFreeRate'] ?? 0.0, 'riskFreeRate');
        if ($riskFreeRate < -0.1 || $riskFreeRate > 1.0) {
            throw new \InvalidArgumentException('riskFreeRate must be an annual decimal between -0.10 and 1.00');
        }
        $shrinkage = self::finiteNumber($options['shrinkage'] ?? 0.15, 'shrinkage');
        if ($shrinkage < 0 || $shrinkage > 1) {
            throw new \InvalidArgumentException('shrinkage must be between 0 and 1');
        }
        $periodsPerYear = filter_var($options['periodsPerYear'] ?? 252, FILTER_VALIDATE_INT);
        if ($periodsPerYear === false || $periodsPerYear < 1 || $periodsPerYear > 100000) {
            throw new \InvalidArgumentException('periodsPerYear must be an integer between 1 and 100000');
        }
        $timeframe = strtolower(trim((string) ($options['timeframe'] ?? '1d')));

        $normalized = self::normalizeAssets($assets);
        $commonTimestamps = self::commonTimestamps($normalized);
        $returnCount = count($commonTimestamps) - 1;
        if ($returnCount < self::MIN_RETURN_OBSERVATIONS) {
            throw new \InvalidArgumentException(sprintf(
                'portfolio optimization needs at least %d aligned return observations; found %d',
                self::MIN_RETURN_OBSERVATIONS,
                max(0, $returnCount)
            ));
        }

        $returns = self::alignedReturns($normalized, $commonTimestamps);
        [$means, $sampleCovariance] = self::estimate($returns, $assetCount);
        $annualizedMeans = array_map(fn($mean) => $mean * $periodsPerYear, $means);
        $annualizedCovariance = self::annualizedShrunkCovariance($sampleCovariance, $periodsPerYear, $shrinkage);

        $minimumVarianceWeights = self::minimumVarianceWeights($annualizedCovariance, $maxWeight);
        $maximumSharpeWeights = self::maximumSharpeWeights(
            $annualizedMeans,
            $annualizedCovariance,
            $riskFreeRate,
            $maxWeight,
            $minimumVarianceWeights
        );
        $equalWeights = array_fill(0, $assetCount, 1 / $assetCount);

        $minimumVariance = self::portfolioMetrics($minimumVarianceWeights, $annualizedMeans, $annualizedCovariance, $riskFreeRate);
        $maximumSharpe = self::portfolioMetrics($maximumSharpeWeights, $annualizedMeans, $annualizedCovariance, $riskFreeRate);
        $equalWeight = self::portfolioMetrics($equalWeights, $annualizedMeans, $annualizedCovariance, $riskFreeRate);
        $selectedWeights = $objective === 'min_variance' ? $minimumVarianceWeights : $maximumSharpeWeights;
        $selectedMetrics = $objective === 'min_variance' ? $minimumVariance : $maximumSharpe;

        $symbols = array_map(fn($asset) => $asset['symbol'], $normalized);
        $correlations = self::correlationMatrix($symbols, $sampleCovariance);
        $warnings = [];
        $availableCounts = array_map(fn($asset) => count($asset['prices']), $normalized);
        if (count(array_unique($availableCounts)) > 1 || min($availableCounts) > count($commonTimestamps)) {
            $warnings[] = 'Only timestamps shared by every asset were used; unmatched observations were excluded.';
        }
        foreach ($normalized as $asset) {
            if ($asset['duplicateCount'] > 0) {
                $warnings[] = sprintf('%s: %d duplicate candle timestamp(s) were discarded.', $asset['symbol'], $asset['duplicateCount']);
            }
        }
        if ($shrinkage > 0) {
            $warnings[] = sprintf('Covariance estimates use %.0f%% diagonal shrinkage plus a small numerical ridge.', $shrinkage * 100);
        }
        $classes = array_values(array_unique(array_filter(array_map(fn($asset) => $asset['marketClass'], $normalized))));
        if (count($classes) > 1) {
            $warnings[] = 'The universe mixes market classes; annualization and currency comparability depend on the supplied data configuration.';
        }
        if (($maximumSharpe['expectedReturnAnnualized'] ?? 0) <= $riskFreeRate) {
            $warnings[] = 'No positive historical excess return was estimated for the maximum-Sharpe allocation; this is not a positive-return forecast.';
        }

        $assetReports = [];
        foreach ($normalized as $index => $asset) {
            $assetVariance = max(0.0, $annualizedCovariance[$index][$index]);
            $assetReports[] = [
                'symbol' => $asset['symbol'],
                'marketClass' => $asset['marketClass'],
                'expectedReturnAnnualized' => self::rounded($annualizedMeans[$index]),
                'volatilityAnnualized' => self::rounded(sqrt($assetVariance)),
                'selectedWeight' => $selectedWeights[$index],
                'minimumVarianceWeight' => $minimumVarianceWeights[$index],
                'maximumSharpeWeight' => $maximumSharpeWeights[$index],
                'equalWeight' => $equalWeights[$index],
                'provenance' => $asset['provenance'],
            ];
        }

        return [
            'status' => 'RESEARCH_ONLY',
            'model' => 'historical-mean-variance-diagonal-shrinkage-v1',
            'objective' => $objective,
            'computedAt' => gmdate('c'),
            'window' => [
                'timeframe' => $timeframe,
                'alignedPriceObservations' => count($commonTimestamps),
                'returnObservations' => $returnCount,
                'firstTimestamp' => (int) $commonTimestamps[0],
                'lastTimestamp' => (int) $commonTimestamps[count($commonTimestamps) - 1],
                'periodsPerYear' => $periodsPerYear,
            ],
            'constraints' => [
                'longOnly' => true,
                'fullyInvested' => true,
                'maximumWeightPerAsset' => $maxWeight,
                'grossLeverage' => 1.0,
            ],
            'estimation' => [
                'expectedReturn' => 'arithmetic sample mean, annualized by periodsPerYear',
                'covariance' => 'sample covariance with diagonal shrinkage, then annualized',
                'shrinkage' => $shrinkage,
                'riskFreeRateAnnualized' => $riskFreeRate,
            ],
            'assets' => $assetReports,
            'correlations' => $correlations,
            'allocations' => [
                'selected' => self::allocationReport($symbols, $selectedWeights, $selectedMetrics),
                'minimumVariance' => self::allocationReport($symbols, $minimumVarianceWeights, $minimumVariance),
                'maximumSharpe' => self::allocationReport($symbols, $maximumSharpeWeights, $maximumSharpe),
                'equalWeightBenchmark' => self::allocationReport($symbols, $equalWeights, $equalWeight),
            ],
            'warnings' => array_values(array_unique($warnings)),
            'methodNote' => 'Long-only, fully invested historical mean-variance analysis with a per-asset weight cap. Minimum variance uses projected gradient; maximum Sharpe uses deterministic multi-start projected ascent and is approximate, not a proof of global optimality. Results are sensitive to the selected sample and are not forecasts.',
            'disclaimer' => 'Research output only; not investment advice, not a promise of returns, and never an order or instruction to allocate capital. Fees, slippage, taxes, liquidity, currency conversion and future market changes are not modeled.',
        ];
    }

    /** @return array<int,array{symbol:string,marketClass:string,prices:array<int,float>,provenance:array,duplicateCount:int}> */
    private static function normalizeAssets(array $assets): array
    {
        $out = [];
        $seenSymbols = [];
        foreach ($assets as $asset) {
            if (!is_array($asset)) throw new \InvalidArgumentException('each asset must be an object');
            $symbol = strtoupper(trim((string) ($asset['symbol'] ?? '')));
            if ($symbol === '' || !preg_match('/^[A-Z0-9._:-]{1,64}$/', $symbol)) {
                throw new \InvalidArgumentException('each asset needs a valid symbol');
            }
            if (isset($seenSymbols[$symbol])) throw new \InvalidArgumentException("duplicate asset symbol: {$symbol}");
            $seenSymbols[$symbol] = true;
            $candles = $asset['candles'] ?? null;
            if (!is_array($candles) || count($candles) > self::MAX_PRICE_ROWS_PER_ASSET) {
                throw new \InvalidArgumentException("{$symbol} candles must be an array with at most " . self::MAX_PRICE_ROWS_PER_ASSET . ' rows');
            }
            $prices = [];
            $duplicates = 0;
            foreach ($candles as $candle) {
                if (!is_array($candle) || !isset($candle['timestamp'], $candle['close'])) continue;
                if (!is_numeric($candle['timestamp']) || !is_numeric($candle['close'])) continue;
                $timestamp = (int) $candle['timestamp'];
                $close = (float) $candle['close'];
                if ($timestamp <= 0 || !is_finite($close) || $close <= 0) continue;
                if (array_key_exists($timestamp, $prices)) {
                    $duplicates++;
                    continue;
                }
                $prices[$timestamp] = $close;
            }
            if (count($prices) < self::MIN_RETURN_OBSERVATIONS + 1) {
                throw new \InvalidArgumentException(sprintf('%s needs at least %d valid close prices', $symbol, self::MIN_RETURN_OBSERVATIONS + 1));
            }
            ksort($prices, SORT_NUMERIC);
            $out[] = [
                'symbol' => $symbol,
                'marketClass' => strtolower(trim((string) ($asset['marketClass'] ?? 'unknown'))),
                'prices' => $prices,
                'provenance' => is_array($asset['provenance'] ?? null) ? $asset['provenance'] : [],
                'duplicateCount' => $duplicates,
            ];
        }
        return $out;
    }

    /** @return array<int,int> */
    private static function commonTimestamps(array $assets): array
    {
        $common = array_keys($assets[0]['prices']);
        foreach (array_slice($assets, 1) as $asset) {
            $common = array_values(array_intersect($common, array_keys($asset['prices'])));
            if ($common === []) break;
        }
        sort($common, SORT_NUMERIC);
        return array_map('intval', $common);
    }

    /** @return array<int,array<int,float>> rows=time observations, columns=assets */
    private static function alignedReturns(array $assets, array $timestamps): array
    {
        $returns = [];
        for ($t = 1, $n = count($timestamps); $t < $n; $t++) {
            $row = [];
            foreach ($assets as $asset) {
                $previous = $asset['prices'][$timestamps[$t - 1]];
                $current = $asset['prices'][$timestamps[$t]];
                $value = $current / $previous - 1.0;
                if (!is_finite($value)) throw new \InvalidArgumentException('price history produced a non-finite return');
                $row[] = $value;
            }
            $returns[] = $row;
        }
        return $returns;
    }

    /** @return array{0:array<int,float>,1:array<int,array<int,float>>} */
    private static function estimate(array $returns, int $assetCount): array
    {
        $n = count($returns);
        $means = array_fill(0, $assetCount, 0.0);
        foreach ($returns as $row) {
            foreach ($row as $i => $value) $means[$i] += $value;
        }
        foreach ($means as $i => $value) {
            $means[$i] = $value / $n;
            if (!is_finite($means[$i])) throw new \InvalidArgumentException('return history is too large to estimate safely');
        }

        $covariance = array_fill(0, $assetCount, array_fill(0, $assetCount, 0.0));
        for ($i = 0; $i < $assetCount; $i++) {
            for ($j = $i; $j < $assetCount; $j++) {
                $sum = 0.0;
                foreach ($returns as $row) $sum += ($row[$i] - $means[$i]) * ($row[$j] - $means[$j]);
                $value = $sum / max(1, $n - 1);
                if (!is_finite($value)) throw new \InvalidArgumentException('return history produced an invalid covariance estimate');
                $covariance[$i][$j] = $value;
                $covariance[$j][$i] = $value;
            }
        }
        return [$means, $covariance];
    }

    /** @return array<int,array<int,float>> */
    private static function annualizedShrunkCovariance(array $sample, int $periodsPerYear, float $shrinkage): array
    {
        $n = count($sample);
        $largestVariance = 0.0;
        for ($i = 0; $i < $n; $i++) $largestVariance = max($largestVariance, $sample[$i][$i]);
        $ridge = max(self::EPSILON, $largestVariance * 1.0e-10);
        $out = array_fill(0, $n, array_fill(0, $n, 0.0));
        for ($i = 0; $i < $n; $i++) {
            for ($j = 0; $j < $n; $j++) {
                $value = $i === $j
                    ? $sample[$i][$i] + $ridge
                    : (1.0 - $shrinkage) * $sample[$i][$j];
                $out[$i][$j] = $value * $periodsPerYear;
            }
        }
        return $out;
    }

    /** Projected-gradient solution to the convex long-only minimum-variance QP. */
    private static function minimumVarianceWeights(array $covariance, float $maxWeight): array
    {
        $n = count($covariance);
        $weights = array_fill(0, $n, 1 / $n);
        $maxRowSum = 0.0;
        foreach ($covariance as $row) $maxRowSum = max($maxRowSum, array_sum(array_map('abs', $row)));
        $lipschitz = 2.0 * $maxRowSum;
        if ($lipschitz <= self::EPSILON) return $weights;
        $step = 1.0 / $lipschitz;

        for ($iteration = 0; $iteration < self::MAX_ITERATIONS; $iteration++) {
            $gradient = self::covarianceTimesWeights($covariance, $weights);
            $candidate = [];
            foreach ($gradient as $i => $value) $candidate[] = $weights[$i] - 2.0 * $step * $value;
            $next = self::projectCappedSimplex($candidate, $maxWeight);
            if (self::maxDistance($weights, $next) < 1.0e-10) {
                $weights = $next;
                break;
            }
            $weights = $next;
        }
        return $weights;
    }

    /** Deterministic multi-start projected ascent for the long-only Sharpe ratio. */
    private static function maximumSharpeWeights(array $means, array $covariance, float $riskFreeRate, float $maxWeight, array $minimumVariance): array
    {
        $n = count($means);
        $starts = [array_fill(0, $n, 1 / $n), $minimumVariance];
        for ($asset = 0; $asset < $n; $asset++) {
            $start = array_fill(0, $n, 0.0);
            $start[$asset] = $maxWeight;
            $share = (1.0 - $maxWeight) / max(1, $n - 1);
            foreach ($start as $i => $_) if ($i !== $asset) $start[$i] = $share;
            $starts[] = self::projectCappedSimplex($start, $maxWeight);
        }

        $best = $starts[0];
        $bestScore = self::sharpeScore($best, $means, $covariance, $riskFreeRate);
        foreach ($starts as $start) {
            $weights = $start;
            $score = self::sharpeScore($weights, $means, $covariance, $riskFreeRate);
            $step = 0.12;
            for ($iteration = 0; $iteration < self::MAX_ITERATIONS; $iteration++) {
                $gradient = self::sharpeGradient($weights, $means, $covariance, $riskFreeRate);
                $scale = max(array_map('abs', $gradient));
                if (!is_finite($scale) || $scale < 1.0e-10) break;
                foreach ($gradient as $i => $value) $gradient[$i] = $value / $scale;

                $accepted = false;
                $trialStep = $step;
                for ($lineSearch = 0; $lineSearch < 24; $lineSearch++) {
                    $candidate = [];
                    foreach ($weights as $i => $weight) $candidate[] = $weight + $trialStep * $gradient[$i];
                    $candidate = self::projectCappedSimplex($candidate, $maxWeight);
                    $candidateScore = self::sharpeScore($candidate, $means, $covariance, $riskFreeRate);
                    if ($candidateScore > $score + 1.0e-12) {
                        $accepted = true;
                        break;
                    }
                    $trialStep *= 0.5;
                }
                if (!$accepted) break;
                $distance = self::maxDistance($weights, $candidate);
                $weights = $candidate;
                $score = $candidateScore;
                $step = min(0.25, $trialStep * 1.15);
                if ($distance < 1.0e-9) break;
            }
            if ($score > $bestScore) {
                $best = $weights;
                $bestScore = $score;
            }
        }
        return $best;
    }

    /** @return array<int,float> */
    private static function sharpeGradient(array $weights, array $means, array $covariance, float $riskFreeRate): array
    {
        $covarianceWeights = self::covarianceTimesWeights($covariance, $weights);
        $variance = max(0.0, self::dot($weights, $covarianceWeights));
        $volatility = sqrt($variance);
        if ($volatility <= self::EPSILON) return array_fill(0, count($weights), 0.0);
        $excessReturn = self::dot($weights, $means) - $riskFreeRate;
        $volatilityCubed = $volatility * $volatility * $volatility;
        $gradient = [];
        foreach ($means as $i => $mean) {
            $gradient[] = $mean / $volatility - $excessReturn * $covarianceWeights[$i] / $volatilityCubed;
        }
        return $gradient;
    }

    private static function sharpeScore(array $weights, array $means, array $covariance, float $riskFreeRate): float
    {
        $metrics = self::portfolioMetrics($weights, $means, $covariance, $riskFreeRate);
        if ($metrics['volatilityAnnualized'] <= self::EPSILON) {
            $excess = $metrics['expectedReturnAnnualized'] - $riskFreeRate;
            return $excess > 0 ? 1.0e6 : ($excess < 0 ? -1.0e6 : 0.0);
        }
        return (float) $metrics['sharpeRatio'];
    }

    /** @return array<string,mixed> */
    private static function portfolioMetrics(array $weights, array $means, array $covariance, float $riskFreeRate): array
    {
        $expectedReturn = self::dot($weights, $means);
        $covarianceWeights = self::covarianceTimesWeights($covariance, $weights);
        $variance = self::dot($weights, $covarianceWeights);
        $volatility = sqrt(max(0.0, $variance));
        return [
            'expectedReturnAnnualized' => self::rounded($expectedReturn),
            'volatilityAnnualized' => self::rounded($volatility),
            'sharpeRatio' => $volatility <= self::EPSILON ? null : self::rounded(($expectedReturn - $riskFreeRate) / $volatility),
            'concentrationIndex' => self::rounded(self::dot($weights, $weights)),
        ];
    }

    /** @return array<string,mixed> */
    private static function allocationReport(array $symbols, array $weights, array $metrics): array
    {
        $mapped = [];
        foreach ($symbols as $i => $symbol) $mapped[$symbol] = $weights[$i];
        return ['weights' => $mapped] + $metrics;
    }

    /** @return array<string,array<string,float|null>> */
    private static function correlationMatrix(array $symbols, array $covariance): array
    {
        $out = [];
        foreach ($symbols as $i => $left) {
            foreach ($symbols as $j => $right) {
                $denominator = sqrt(max(0.0, $covariance[$i][$i] * $covariance[$j][$j]));
                $value = $denominator <= self::EPSILON ? null : $covariance[$i][$j] / $denominator;
                $out[$left][$right] = $value === null ? null : self::rounded(max(-1.0, min(1.0, $value)));
            }
        }
        return $out;
    }

    /** @return array<int,float> */
    private static function covarianceTimesWeights(array $covariance, array $weights): array
    {
        $out = [];
        foreach ($covariance as $i => $row) {
            $sum = 0.0;
            foreach ($row as $j => $value) $sum += $value * $weights[$j];
            $out[$i] = $sum;
        }
        return $out;
    }

    /** Euclidean projection onto {w: sum(w)=1, 0<=w_i<=cap}, via water filling. */
    private static function projectCappedSimplex(array $values, float $cap): array
    {
        $low = min($values) - $cap - 1.0;
        $high = max($values) + 1.0;
        for ($iteration = 0; $iteration < 90; $iteration++) {
            $shift = ($low + $high) / 2.0;
            $sum = 0.0;
            foreach ($values as $value) $sum += max(0.0, min($cap, $value - $shift));
            if ($sum > 1.0) $low = $shift;
            else $high = $shift;
        }
        $shift = ($low + $high) / 2.0;
        $weights = [];
        foreach ($values as $value) $weights[] = max(0.0, min($cap, $value - $shift));

        // Remove tiny bisection residue without violating the box constraints.
        $residual = 1.0 - array_sum($weights);
        if (abs($residual) > 0) {
            foreach ($weights as $i => $weight) {
                $room = $residual > 0 ? $cap - $weight : $weight;
                if ($room <= 0) continue;
                $adjustment = $residual > 0 ? min($residual, $room) : -min(-$residual, $room);
                $weights[$i] += $adjustment;
                $residual -= $adjustment;
                if (abs($residual) < 1.0e-14) break;
            }
        }
        return $weights;
    }

    private static function dot(array $left, array $right): float
    {
        $sum = 0.0;
        foreach ($left as $i => $value) $sum += $value * $right[$i];
        return $sum;
    }

    private static function maxDistance(array $left, array $right): float
    {
        $distance = 0.0;
        foreach ($left as $i => $value) $distance = max($distance, abs($value - $right[$i]));
        return $distance;
    }

    private static function finiteNumber($value, string $name): float
    {
        if (!is_numeric($value) || !is_finite((float) $value)) {
            throw new \InvalidArgumentException("{$name} must be a finite number");
        }
        return (float) $value;
    }

    private static function rounded(float $value): float
    {
        return round($value, 10);
    }
}
