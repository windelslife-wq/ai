<?php
namespace Aegis\Lottery;

/**
 * Adapter for an authorized/official lottery result feed.
 *
 * The upstream must expose this provider-neutral contract:
 *
 *   GET {url}/draws?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
 *     -> {"data":{"draws":[
 *          {"externalId":"...","drawDate":"YYYY-MM-DD",
 *           "main":[1,2,3,4,5],"stars":[1,2],
 *           "sourceTimestamp":"..."}
 *        ]}}
 *   GET {healthUrl} -> {"ok":true,"version":"..."}
 *
 * An upstream adapter can map a vendor's payload into this contract before
 * it reaches AEGIS. This class does not mark a draw VERIFIED on its own:
 * LotteryIntelligence still validates every count, range, date, source and
 * timestamp, and refuses to overwrite a conflicting verified result.
 *
 * Safety defaults are intentional: the provider is offline until an
 * explicit ENABLED flag, HTTPS-safe URL and non-empty license/source
 * metadata are configured. A sandbox provider is never treated as official.
 */
final class OfficialLotteryProvider implements LotteryProvider
{
    private string $url;
    private string $healthUrl;
    private string $token;
    private string $license;
    private string $source;
    private bool $enabled;
    /** @var callable(string, ?string): mixed */
    private $request;

    /**
     * @param callable(string, ?string): mixed|null $request
     */
    public function __construct(
        ?string $url = null,
        ?bool $enabled = null,
        ?string $token = null,
        ?string $license = null,
        ?string $source = null,
        ?callable $request = null,
    ) {
        $this->url = trim($url ?? (getenv('WINDELS_LOTTERY_OFFICIAL_URL') ?: ''));
        $this->healthUrl = trim(getenv('WINDELS_LOTTERY_OFFICIAL_HEALTH_URL') ?: '');
        $this->token = trim($token ?? (getenv('WINDELS_LOTTERY_OFFICIAL_TOKEN') ?: ''));
        $this->license = trim($license ?? (getenv('WINDELS_LOTTERY_OFFICIAL_LICENSE') ?: ''));
        $this->source = trim($source ?? (getenv('WINDELS_LOTTERY_OFFICIAL_SOURCE') ?: 'authorized-official-feed'));
        $this->enabled = $enabled ?? (getenv('WINDELS_LOTTERY_OFFICIAL_ENABLED') === '1');
        $this->request = $request ?? [$this, 'defaultRequest'];
    }

    public function id(): string { return 'official-euromillions'; }
    public function name(): string { return 'Authorized EuroMillions feed'; }

    public function configured(): bool
    {
        return $this->enabled && $this->validUrl() && $this->license !== '' && $this->source !== '';
    }

    public function health(): array
    {
        if (!$this->enabled) {
            return ['state' => 'DISABLED', 'licensed' => false, 'synthetic' => false,
                'message' => 'Official feed is disabled — set WINDELS_LOTTERY_OFFICIAL_ENABLED=1 only after authorization'];
        }
        if (!$this->validUrl() || $this->license === '' || $this->source === '') {
            return ['state' => 'UNCONFIGURED', 'licensed' => false, 'synthetic' => false,
                'message' => 'Official feed requires a safe URL, license metadata and a source identifier'];
        }
        try {
            $url = $this->healthUrl !== '' ? $this->healthUrl : $this->endpoint('/health');
            $payload = ($this->request)($url, $this->token !== '' ? $this->token : null);
            if (!is_array($payload) || ($payload['ok'] ?? true) === false) throw new \RuntimeException('health endpoint reported failure');
            return [
                'state' => 'ONLINE', 'licensed' => true, 'synthetic' => false,
                'message' => 'Authorized official feed reachable; all imported draws remain subject to validation',
                'source' => $this->source,
                'licenseConfigured' => true,
                'version' => isset($payload['version']) && is_scalar($payload['version']) ? (string) $payload['version'] : null,
            ];
        } catch (\Throwable $e) {
            return ['state' => 'OFFLINE', 'licensed' => true, 'synthetic' => false,
                'message' => 'Authorized feed is configured but unavailable: ' . substr($e->getMessage(), 0, 180),
                'source' => $this->source, 'licenseConfigured' => true];
        }
    }

    public function draws(?string $from = null, ?string $to = null, int $limit = 100): array
    {
        if (!$this->configured()) return [];
        $limit = min(1000, max(1, $limit));
        $query = ['limit' => $limit];
        if ($from !== null && $from !== '') $query['from'] = $from;
        if ($to !== null && $to !== '') $query['to'] = $to;
        $payload = ($this->request)($this->endpoint('/draws', $query), $this->token !== '' ? $this->token : null);
        $rows = $this->rows($payload);
        return array_map(fn($row) => $this->normalizeDraw($row), $rows);
    }

    public function jackpotInfo(): ?array
    {
        if (!$this->configured()) return null;
        $jackpotUrl = trim(getenv('WINDELS_LOTTERY_OFFICIAL_JACKPOT_URL') ?: '');
        if ($jackpotUrl === '') return null;
        $payload = ($this->request)($jackpotUrl, $this->token !== '' ? $this->token : null);
        if (!is_array($payload)) return null;
        $data = is_array($payload['data'] ?? null) ? $payload['data'] : $payload;
        return [
            'source' => $this->source,
            'value' => isset($data['value']) && is_scalar($data['value']) ? (string) $data['value'] : null,
            'currency' => isset($data['currency']) && is_scalar($data['currency']) ? (string) $data['currency'] : null,
            'observedAt' => isset($data['observedAt']) && is_scalar($data['observedAt']) ? (string) $data['observedAt'] : null,
            'note' => 'Official feed value; not used to infer future draw outcomes',
        ];
    }

    /** @return list<array<string,mixed>> */
    private function rows($payload): array
    {
        if (!is_array($payload)) throw new \RuntimeException('official lottery feed returned invalid JSON');
        $rows = $payload['draws'] ?? ($payload['data']['draws'] ?? ($payload['data'] ?? $payload));
        if (!is_array($rows) || !$this->isList($rows)) throw new \RuntimeException('official lottery feed returned no draw list');
        return array_values(array_filter($rows, 'is_array'));
    }

    /** Keep missing fields missing so the central validator can reject and audit them. */
    private function normalizeDraw(array $row): array
    {
        $main = $row['main'] ?? ($row['numbers'] ?? ($row['winningNumbers'] ?? null));
        $stars = $row['stars'] ?? ($row['luckyStars'] ?? ($row['bonus'] ?? null));
        if (is_array($main) && isset($main['main'])) $main = $main['main'];
        if (is_array($stars) && isset($stars['stars'])) $stars = $stars['stars'];
        $sourceTimestamp = $row['sourceTimestamp'] ?? ($row['source_timestamp'] ?? ($row['updatedAt'] ?? null));
        return [
            'externalId' => (string) ($row['externalId'] ?? ($row['external_id'] ?? ($row['drawId'] ?? ($row['id'] ?? '')))),
            'drawDate' => (string) ($row['drawDate'] ?? ($row['draw_date'] ?? ($row['date'] ?? ''))),
            'main' => is_array($main) ? array_values($main) : $main,
            'stars' => is_array($stars) ? array_values($stars) : $stars,
            'jackpot' => isset($row['jackpot']) && is_scalar($row['jackpot']) ? (string) $row['jackpot'] : null,
            'rollover' => !empty($row['rollover']),
            'winners' => isset($row['winners']) && is_scalar($row['winners']) ? (string) $row['winners'] : null,
            'source' => $this->source,
            'sourceTimestamp' => is_scalar($sourceTimestamp) ? (string) $sourceTimestamp : '',
        ];
    }

    private function endpoint(string $path, array $query = []): string
    {
        $url = rtrim($this->url, '/') . '/' . ltrim($path, '/');
        return $query === [] ? $url : $url . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
    }

    private function validUrl(): bool
    {
        $parts = parse_url($this->url);
        return is_array($parts) && strtolower((string) ($parts['scheme'] ?? '')) === 'https'
            && !empty($parts['host']) && empty($parts['user']) && empty($parts['pass']);
    }

    private function isList(array $value): bool
    {
        $i = 0;
        foreach (array_keys($value) as $key) if ($key !== $i++) return false;
        return true;
    }

    /** @return array<string,mixed>|null */
    private function defaultRequest(string $url, ?string $token): ?array
    {
        $headers = "Accept: application/json\r\nUser-Agent: WINDELS-Lottery-Provider/1.0\r\n";
        if ($token !== null && $token !== '') $headers .= 'Authorization: Bearer ' . $token . "\r\n";
        $context = stream_context_create([
            'http' => ['method' => 'GET', 'timeout' => 8, 'ignore_errors' => true, 'header' => $headers],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $raw = @file_get_contents($url, false, $context);
        $decoded = $raw === false ? null : json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }
}
