<?php
namespace Aegis\Providers;

/**
 * Phase 6 contract for attributable, licensed market-sentiment data
 * (financial news + social sentiment). Pair with the honest boundary: the
 * SentimentAgent abstains until a licensed, attributable feed is configured,
 * and price action is never relabelled as sentiment.
 */
interface SentimentFeed
{
    public function id(): string;

    /** @return array{state:string,licensed:bool,message:string} */
    public function health(): array;

    /**
     * Normalized sentiment snapshot for a symbol.
     *
     * @return array{available:bool,symbol:string,source:?string,observedAt:?int,licensed:bool,observations?:list<array{channel?:string,source?:string,observedAt?:int,score?:float,sampleSize?:int,headline?:string}>,reason?:string}
     *          `score` is directional sentiment in [-1, +1] (negative = bearish);
     *          `observedAt` is the Unix-seconds time the observation was recorded.
     */
    public function snapshot(string $symbol): array;
}

/** Safe default: no data is preferable to unlicensed or stale pseudo-data. */
class UnavailableSentimentFeed implements SentimentFeed
{
    public function id(): string { return 'unconfigured'; }
    public function health(): array
    {
        return ['state' => 'UNCONFIGURED', 'licensed' => false, 'message' => 'No licensed sentiment feed configured'];
    }
    public function snapshot(string $symbol): array
    {
        return ['available' => false, 'symbol' => strtoupper($symbol), 'source' => null, 'observedAt' => null,
            'licensed' => false, 'reason' => 'No licensed sentiment feed configured'];
    }
}

/**
 * Provenance + freshness validation for sentiment snapshots. The agent only
 * votes when this validator passes; every failure becomes a reason string in
 * the report, so abstention is always explained.
 */
final class SentimentSnapshotValidator
{
    public const DEFAULT_MAX_AGE_SECONDS = 3600; // sentiment decays fast — one-hour horizon
    public const MIN_VALID_OBSERVATIONS = 2;     // one data point is not a sentiment view
    private const CLOCK_SKEW_SECONDS = 60;       // tolerate slight feed clock drift into the future

    public function __construct(private int $maxAgeSeconds = self::DEFAULT_MAX_AGE_SECONDS) {}

    public function maxAgeSeconds(): int { return $this->maxAgeSeconds; }

    /**
     * Validate a feed snapshot at wall-clock time `$now` (default: time()).
     *
     * @return array{ok:bool,reason:?string,score:?float,observations:array,rejectedCount:?int,provenance:?array}
     */
    public function validate(array $snapshot, ?int $now = null): array
    {
        $now = $now ?? time();
        if (empty($snapshot['available'])) {
            return $this->reject((string) ($snapshot['reason'] ?: 'SNAPSHOT_UNAVAILABLE'));
        }
        if (empty($snapshot['licensed'])) {
            return $this->reject('UNLICENSED — sentiment data without a license cannot be used');
        }
        $source = trim((string) ($snapshot['source'] ?? ''));
        if ($source === '') {
            return $this->reject('NO_SOURCE — snapshot has no attributable source');
        }
        $raw = $snapshot['observations'] ?? [];
        $valid = [];
        $rejected = 0;
        foreach (is_array($raw) ? $raw : [] as $o) {
            if (!is_array($o)) { $rejected++; continue; }
            $oSource = trim((string) ($o['source'] ?? ''));
            $at = $o['observedAt'] ?? null;
            $s = $o['score'] ?? null;
            $n = (int) ($o['sampleSize'] ?? 0);
            if ($oSource === '' || !is_int($at) || $at < $now - $this->maxAgeSeconds
                || $at > $now + self::CLOCK_SKEW_SECONDS || !is_numeric($s)
                || (float) $s < -1.0 || (float) $s > 1.0 || $n < 1) {
                $rejected++;
                continue;
            }
            $valid[] = [
                'channel' => in_array($o['channel'] ?? '', ['news', 'social'], true) ? $o['channel'] : 'news',
                'source' => $oSource,
                'observedAt' => $at,
                'score' => round((float) $s, 4),
                'sampleSize' => $n,
                'headline' => isset($o['headline']) && is_string($o['headline']) ? $o['headline'] : null,
            ];
        }
        if (count($valid) < self::MIN_VALID_OBSERVATIONS) {
            return $this->reject(sprintf(
                'STALE_OR_INCOMPLETE — only %d of %d observation(s) attributable and within %ds (need >= %d)',
                count($valid), count($valid) + $rejected, $this->maxAgeSeconds, self::MIN_VALID_OBSERVATIONS
            ));
        }
        $score = array_sum(array_map(fn($o) => $o['score'], $valid)) / count($valid);
        $newest = max(array_column($valid, 'observedAt'));
        $oldest = min(array_column($valid, 'observedAt'));
        return [
            'ok' => true, 'reason' => null, 'score' => round($score, 4),
            'observations' => $valid, 'rejectedCount' => $rejected,
            'provenance' => ['source' => $source, 'licensed' => true, 'observedAt' => $newest, 'observedAtRange' => [$oldest, $newest]],
        ];
    }

    private function reject(string $reason): array
    {
        return ['ok' => false, 'reason' => $reason, 'score' => null, 'observations' => [], 'rejectedCount' => null, 'provenance' => null];
    }
}
