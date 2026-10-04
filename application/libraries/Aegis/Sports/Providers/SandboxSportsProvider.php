<?php
namespace Aegis\Sports\Providers;

/**
 * SANDBOX-mode simulation provider.
 *
 * Honesty contract (spec §3 / §38):
 *  - Every record it emits is explicitly marked `simulated: true`.
 *  - It is only ONLINE when WINDELS_SPORTS_MODE=SANDBOX AND
 *    WINDELS_SPORTS_SANDBOX=1 (explicit opt-in). In PAPER/PRODUCTION mode it
 *    reports OFFLINE so sandbox data can never leak into real statistics.
 *  - Generation is fully deterministic (seeded PRNG): the same date range
 *    always produces the same fixtures, odds, and results — reproducible but
 *    never presented as real-world data.
 *  - Injuries/lineups are intentionally NEVER produced: the sandbox simulates
 *    form, goals and markets only, so missing critical data is handled the
 *    same way it is for real providers.
 */
class SandboxSportsProvider implements SportsDataProvider
{
    private const LEAGUES = [
        'Premier Simulation League' => ['Alpha United', 'Bolt City', 'Comet Rangers', 'Delta Athletic', 'Ember Rovers', 'Falcon SC', 'Granite Town', 'Harbor Wanderers'],
        'Continental Simulation Cup' => ['Apex FC', 'Bronze Valley', 'Cinder Sports', 'Drake United', 'Eagle Grove', 'Foxes Athletic', 'Glacier Town', 'Horizon FC'],
    ];

    private int $enabled = 0;

    public function __construct(private string $seed = 'windels-sandbox-v1')
    {
        $this->enabled = (getenv('WINDELS_SPORTS_MODE') ?: 'SANDBOX') === 'SANDBOX' && getenv('WINDELS_SPORTS_SANDBOX') === '1' ? 1 : 0;
    }

    public function id(): string { return 'sandbox-sim'; }

    public function health(): array
    {
        if (!$this->enabled) {
            return ['status' => 'OFFLINE', 'reliability' => 0.0, 'detail' => 'SANDBOX_NOT_ENABLED — set WINDELS_SPORTS_MODE=SANDBOX and WINDELS_SPORTS_SANDBOX=1'];
        }
        return ['status' => 'ONLINE', 'reliability' => 0.9, 'responseMs' => 2, 'lastSuccessAt' => gmdate('c'), 'lastFailureAt' => null, 'errorRate' => 0.0];
    }

    public function fixtures(array $query): array
    {
        if (!$this->enabled) throw new ProviderException('sandbox provider is not enabled in this mode', ProviderException::OFFLINE);
        $from = (string) ($query['from'] ?? gmdate('Y-m-d'));
        $to = (string) ($query['to'] ?? $from);
        $out = [];
        $today = gmdate('Y-m-d');
        $day = $from;
        $guard = 0;
        while ($day <= $to && $guard++ < 62) {
            foreach (self::LEAGUES as $league => $teams) {
                $count = 3; // three fixtures per league per day (deterministic)
                for ($i = 0; $i < $count; $i++) {
                    $ext = $this->externalId($league, $day, $i);
                    [$home, $away] = $this->pairing($league, $day, $i);
                    $status = $day < $today ? 'FINISHED' : ($day === $today ? 'SCHEDULED' : 'SCHEDULED');
                    $out[] = $this->fixturePayload($ext, $league, $home, $away, $day, $i, $status, $teams);
                }
            }
            $day = gmdate('Y-m-d', strtotime($day . ' +1 day'));
        }
        return $out;
    }

    public function odds(string $fixtureExternalId): array
    {
        if (!$this->enabled) throw new ProviderException('sandbox provider is not enabled in this mode', ProviderException::OFFLINE);
        $ctx = $this->parseExternalId($fixtureExternalId);
        if ($ctx === null) return [];
        [$home, $away] = $this->pairing($ctx['league'], $ctx['day'], $ctx['slot']);
        $form = $this->form($ctx['league'], $home, $away);
        // True probability of Over 1.5 from a Poisson total-goals model on the
        // simulated form stats — simulation math, clearly labeled as such.
        $lambda = ($form['homeGoalsPerMatch'] + $form['awayGoalsPerMatch']) / 2 + 0.35;
        $pUnder1 = exp(-$lambda) * (1 + $lambda);
        $pTrue = min(0.985, max(0.02, 1 - $pUnder1));
        $margin = 0.04;
        $noise = ($this->randValue($fixtureExternalId . ':noise', 0, 1) - 0.5) * 0.04;
        $pMarket = min(0.97, max(0.05, $pTrue * (1 - $margin) + $noise));
        $decimal = round(1 / $pMarket, 2);
        $kickoffTs = $this->kickoffTs($ctx['day'], $ctx['slot']);
        $observed = gmdate('c', min(time(), $kickoffTs - 7200));
        return [[
            'market' => 'TOTAL_GOALS', 'selection' => 'OVER_1_5', 'decimalOdds' => $decimal,
            'observedAt' => $observed, 'provider' => $this->id(), 'simulated' => true,
        ]];
    }

    public function results(string $fixtureExternalId): array
    {
        if (!$this->enabled) throw new ProviderException('sandbox provider is not enabled in this mode', ProviderException::OFFLINE);
        $ctx = $this->parseExternalId($fixtureExternalId);
        if ($ctx === null) return [];
        if ($ctx['day'] >= gmdate('Y-m-d')) return []; // not finished — nothing fabricated
        [$home, $away] = $this->pairing($ctx['league'], $ctx['day'], $ctx['slot']);
        $form = $this->form($ctx['league'], $home, $away);
        $lHome = $form['homeGoalsPerMatch'] * 0.95 + 0.15;
        $lAway = $form['awayGoalsPerMatch'] * 0.95;
        $hGoals = $this->poisson($lHome, $fixtureExternalId . ':h');
        $aGoals = $this->poisson($lAway, $fixtureExternalId . ':a');
        return [[
            'externalId' => $fixtureExternalId, 'status' => 'FINISHED',
            'homeScore' => $hGoals, 'awayScore' => $aGoals,
            'sourceTimestamp' => gmdate('c', strtotime($ctx['day'] . 'T23:59:00Z')),
            'provider' => $this->id(), 'simulated' => true,
        ]];
    }

    // ---- deterministic internals ------------------------------------------

    private function externalId(string $league, string $day, int $slot): string
    {
        return sprintf('sim-%s-%s-%d', substr(hash('crc32', $league), 0, 6), $day, $slot);
    }

    private function parseExternalId(string $id): ?array
    {
        if (!preg_match('/^sim-([0-9a-f]{6})-(\d{4}-\d{2}-\d{2})-(\d+)$/', $id, $m)) return null;
        $league = null;
        foreach (array_keys(self::LEAGUES) as $name) {
            if (substr(hash('crc32', $name), 0, 6) === $m[1]) { $league = $name; break; }
        }
        if ($league === null) return null;
        return ['league' => $league, 'day' => $m[2], 'slot' => (int) $m[3]];
    }

    /** @return array{0:string,1:string} */
    private function pairing(string $league, string $day, int $slot): array
    {
        $teams = self::LEAGUES[$league];
        $n = count($teams);
        $offset = ($this->randInt('off:' . $league . ':' . $day, 0, $n - 1) + $slot) % $n;
        $home = $teams[$offset];
        $awayIdx = ($offset + 1 + intdiv($slot, max(1, $n - 1))) % $n;
        if ($awayIdx === $offset) $awayIdx = ($awayIdx + 1) % $n;
        return [$home, $teams[$awayIdx]];
    }

    private function kickoffTs(string $day, int $slot): int
    {
        $hours = [14, 16, 19][$slot % 3];
        return strtotime($day . 'T' . sprintf('%02d:00:00', $hours) . 'Z');
    }

    private function fixturePayload(string $ext, string $league, string $home, string $away, string $day, int $slot, string $status, array $teams): array
    {
        $form = $this->form($league, $home, $away);
        return [
            'externalId' => $ext, 'homeTeam' => $home, 'awayTeam' => $away,
            'competition' => $league, 'kickoff' => gmdate('c', $this->kickoffTs($day, $slot)),
            'status' => $status, 'sport' => 'football',
            'sourceTimestamp' => gmdate('c'), 'provider' => $this->id(),
            'simulated' => true,
            'context' => [
                'recentForm' => [
                    'homeGoalsPerMatch' => $form['homeGoalsPerMatch'],
                    'awayGoalsPerMatch' => $form['awayGoalsPerMatch'],
                    'homeConcededPerMatch' => $form['homeConcededPerMatch'],
                    'awayConcededPerMatch' => $form['awayConcededPerMatch'],
                    'source' => $this->id() . ':simulated-form',
                    'timestamp' => gmdate('c'),
                ],
                'marketLiquidity' => 20000 + $this->randInt('liq:' . $ext, 0, 80000),
                'restDays' => 2 + ($this->randInt('rest:' . $ext, 0, 2)),
            ],
        ];
    }

    /** Simulated recent form, derived from a fixed per-team strength. */
    private function form(string $league, string $home, string $away): array
    {
        $sHome = $this->strength($home);
        $sAway = $this->strength($away);
        $j = fn(string $k) => ($this->randValue($league . ':' . $k, 0, 1) - 0.5) * 0.3;
        return [
            'homeGoalsPerMatch' => round(0.6 + 0.75 * $sHome + $j('hg' . $home), 3),
            'awayGoalsPerMatch' => round(0.6 + 0.75 * $sAway + $j('ag' . $away), 3),
            'homeConcededPerMatch' => round(max(0.3, 1.7 - 0.55 * $sHome + $j('hc' . $home)), 3),
            'awayConcededPerMatch' => round(max(0.3, 1.7 - 0.55 * $sAway + $j('ac' . $away)), 3),
        ];
    }

    private function strength(string $team): float
    {
        // Fixed in [0.75, 1.35] per team name — stable across runs.
        return 0.75 + (crc32('strength:' . $team) & 0xFFFF) / 0xFFFF * 0.6;
    }

    private function randInt(string $key, int $min, int $max): int
    {
        return $min + (int) ($this->randValue($key, 0, 1) * ($max - $min + 1)) % ($max - $min + 1);
    }

    private function randValue(string $key, float $min, float $max): float
    {
        $h = hash('sha256', $this->seed . '|' . $key);
        $v = hexdec(substr($h, 0, 12)) / hexdec('ffffffffffff');
        return $min + $v * ($max - $min);
    }

    /** Deterministic Poisson sample (Knuth) from a seeded stream. */
    private function poisson(float $lambda, string $key): int
    {
        if ($lambda <= 0) return 0;
        $L = exp(-$lambda);
        $k = 0; $p = 1.0;
        do {
            $k++;
            $p *= $this->randValue($key . ':' . $k, 0, 1);
        } while ($p > $L && $k < 12);
        return $k - 1;
    }
}
