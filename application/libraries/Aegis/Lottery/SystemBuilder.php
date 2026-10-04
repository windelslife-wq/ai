<?php
namespace Aegis\Lottery;

/**
 * WINDELS Lottery Intelligence — Phase 16 (spec §18/§19): system builder.
 *
 * A main-number pool of N numbers (selecting 5) and a star pool of S
 * numbers (selecting 2) define the FULL system: every valid combination
 * of the pool.
 *
 *   line count = C(N, 5) x C(S, 2)   — computed combinatorially,
 *   NEVER hardcoded (spec §19).
 *
 * Processing rules (spec §18):
 *  - lines are enumerated LAZILY (PHP generator) — constant memory, so a
 *    200k-line system is never materialised on a page or in memory at once
 *  - paginated windows (page/offset/limit) for interactive use
 *  - systems above SYNC_LINE_LIMIT are not dumped synchronously: they are
 *    queued for the background `systems` cron job (idempotent execution key)
 *
 * Honesty:
 *  - estimated cost is NULL unless official line pricing is available —
 *    no cost is ever fabricated
 *  - a full system covers 100% of the chosen pool (every number, every
 *    main pair, every star pair) — that is coverage of the POOL, not a
 *    statement about winning
 */
final class SystemBuilder
{
    /** Systems with more lines than this are not built synchronously. */
    public const SYNC_LINE_LIMIT = 10000;
    /** Hard safety cap for one background build. */
    public const MAX_BACKGROUND_LINES = 200000;
    /** Maximum lines per page. */
    public const MAX_PAGE = 500;

    public function __construct(private readonly LotteryRules $rules) {}

    /**
     * Validate + normalize a pool (unique in-range ints, sorted).
     * @return list<int>
     */
    public function normalizePool($values, int $min, int $max, string $label): array
    {
        $out = [];
        foreach ((array) $values as $v) {
            if (!is_int($v) || $v < $min || $v > $max) {
                throw new \InvalidArgumentException($label . ' out of range ' . $min . '-' . $max . ': ' . (is_scalar($v) ? (string) $v : 'invalid'));
            }
            if (in_array($v, $out, true)) throw new \InvalidArgumentException('duplicate ' . $label . ': ' . $v);
            $out[] = $v;
        }
        sort($out);
        return $out;
    }

    /**
     * System plan WITHOUT enumerating lines: counts, formula, coverage,
     * honest cost handling and the background flag.
     * @return array<string,mixed>
     */
    public function plan(array $mainPool, array $starPool): array
    {
        $r = $this->rules;
        $mains = $this->normalizePool($mainPool, $r->mainMin(), $r->mainMax(), 'pool main number');
        $stars = $this->normalizePool($starPool, $r->starMin(), $r->starMax(), 'pool lucky star');
        $n = count($mains);
        $s = count($stars);
        if ($n < $r->mainCount()) {
            throw new \InvalidArgumentException('a system needs at least ' . $r->mainCount() . ' main numbers in the pool (got ' . $n . ')');
        }
        if ($s < $r->starCount()) {
            throw new \InvalidArgumentException('a system needs at least ' . $r->starCount() . ' lucky stars in the pool (got ' . $s . ')');
        }
        $mainCombos = self::comb($n, $r->mainCount());
        $starCombos = self::comb($s, $r->starCount());
        $totalLines = $mainCombos * $starCombos;
        return [
            'lottery' => $r->code(),
            'mainPool' => $mains,
            'starPool' => $stars,
            'mainCombos' => $mainCombos,
            'starCombos' => $starCombos,
            'totalLines' => $totalLines,
            'formula' => 'C(' . $n . ',' . $r->mainCount() . ') x C(' . $s . ',' . $r->starCount() . ') = ' . $mainCombos . ' x ' . $starCombos,
            'estimatedCost' => null,
            'costNote' => 'Official line pricing is not available in this environment — no cost is fabricated.',
            'coverage' => [
                'mainNumbersPct' => 100.0,
                'mainPairsPct' => 100.0,
                'starPairsPct' => 100.0,
                'note' => 'A full system contains every ' . $r->mainCount() . '-subset of the main pool and every ' . $r->starCount() . '-subset of the star pool: 100% coverage of the chosen pool (numbers, main pairs and star pairs). Coverage of the pool is not a statement about winning.',
            ],
            'requiresBackground' => $totalLines > self::SYNC_LINE_LIMIT,
            'disclaimer' => LotteryStatisticsEngine::DISCLAIMER,
        ];
    }

    /**
     * Lazy enumeration of every line (constant memory, spec §18).
     * Order: lexicographic main combinations, star combinations nested.
     * @return \Generator<array{mains:list<int>,stars:list<int>}>
     */
    public function lines(array $mains, array $stars): \Generator
    {
        $r = $this->rules;
        foreach ($this->combinationsOf(array_values($mains), $r->mainCount()) as $mainCombo) {
            foreach ($this->combinationsOf(array_values($stars), $r->starCount()) as $starCombo) {
                yield ['mains' => $mainCombo, 'stars' => $starCombo];
            }
        }
    }

    /** Paginated window over the lazy enumeration. @return list<array{mains:list<int>,stars:list<int>}> */
    public function page(array $mains, array $stars, int $offset, int $limit): array
    {
        $offset = max(0, $offset);
        $limit = min(self::MAX_PAGE, max(1, $limit));
        $out = [];
        $i = 0;
        foreach ($this->lines($mains, $stars) as $line) {
            if ($i >= $offset + $limit) break;
            if ($i >= $offset) $out[] = $line;
            $i++;
        }
        return $out;
    }

    /** Materialised lines — only for bounded builds (inline + background). */
    public function allLines(array $mains, array $stars): array
    {
        $out = [];
        foreach ($this->lines($mains, $stars) as $line) $out[] = $line;
        return $out;
    }

    /** Lexicographic k-subset index iterator. @return \Generator<list<int>> */
    public function combinationsOf(array $values, int $k): \Generator
    {
        $n = count($values);
        if ($k <= 0 || $k > $n) return;
        $idx = range(0, $k - 1);
        while (true) {
            $combo = [];
            foreach ($idx as $i) $combo[] = $values[$i];
            yield $combo;
            $i = $k - 1;
            while ($i >= 0 && $idx[$i] === $n - $k + $i) $i--;
            if ($i < 0) return;
            $idx[$i]++;
            for ($j = $i + 1; $j < $k; $j++) $idx[$j] = $idx[$j - 1] + 1;
        }
    }

    /** Binomial coefficient C(n, k) — computed, never hardcoded. */
    public static function comb(int $n, int $k): int
    {
        if ($k < 0 || $k > $n) return 0;
        $k = min($k, $n - $k);
        $c = 1;
        for ($i = 1; $i <= $k; $i++) {
            $c = (int) (($c * ($n - $k + $i)) / $i);
        }
        return $c;
    }
}
