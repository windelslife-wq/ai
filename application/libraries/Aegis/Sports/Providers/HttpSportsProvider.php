<?php
namespace Aegis\Sports\Providers;

/**
 * Generic REST sports-data provider (Provider A/B/C pattern — any vendor with
 * the documented REST contract plugs in via environment configuration; no
 * vendor code or credentials are ever committed or shipped to the frontend).
 *
 * Expected upstream contract (all responses JSON, UTC ISO-8601 timestamps):
 *   GET {base}/fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD
 *       → [{"externalId","homeTeam","awayTeam","competition","kickoff","status",
 *           "sport"?,"sourceTimestamp"?,"context"?}]
 *   GET {base}/fixtures/{externalId}/odds
 *       → [{"market","selection","decimalOdds","observedAt"}]
 *   GET {base}/fixtures/{externalId}/results
 *       → [{"externalId","status","homeScore"?,"awayScore"?,"sourceTimestamp"}]
 *
 * Every payload is untrusted input and is validated by the normalizers before
 * persistence. Credentials come from the environment only.
 */
class HttpSportsProvider implements SportsDataProvider
{
    /** @var callable(string $url, array $headers): array{status:int, body:string} */
    private $transport;
    private int $lastResponseMs = 0;
    private ?string $lastStatus = null;
    private ?string $lastFailure = null;
    private ?string $lastSuccess = null;
    private int $requests = 0;
    private int $failures = 0;

    public function __construct(
        private string $id,
        private string $baseUrl,
        private string $token,
        private int $timeoutSeconds = 10,
        ?callable $transport = null
    ) {
        $this->transport = $transport ?? function (string $url, array $headers): array {
            $context = stream_context_create(['http' => [
                'method' => 'GET', 'timeout' => $this->timeoutSeconds,
                'header' => implode("\r\n", $headers),
                'ignore_errors' => true,
            ]]);
            $body = @file_get_contents($url, false, $context);
            $status = 0;
            if (isset($http_response_header[0]) && preg_match('#HTTP/\S+\s+(\d+)#', $http_response_header[0], $m)) $status = (int) $m[1];
            return ['status' => $status, 'body' => (string) $body];
        };
    }

    public function id(): string { return $this->id; }

    public function health(): array
    {
        $this->lastFailure = null;
        try {
            $t0 = microtime(true);
            $resp = $this->call($this->baseUrl . '/health');
            $this->lastResponseMs = (int) round((microtime(true) - $t0) * 1000);
            $decoded = json_decode($resp['body'] ?? '', true);
            if (isset($decoded['status'])) $this->lastStatus = (string) $decoded['status'];
            $this->lastSuccess = gmdate('c');
            return [
                'status' => 'ONLINE', 'responseMs' => $this->lastResponseMs,
                'reliability' => $this->reliability(), 'lastSuccessAt' => $this->lastSuccess,
                'lastFailureAt' => null, 'errorRate' => $this->errorRate(),
            ];
        } catch (ProviderException $e) {
            $this->lastFailure = gmdate('c');
            return [
                'status' => $e->status, 'responseMs' => $this->lastResponseMs,
                'reliability' => $this->reliability(), 'lastSuccessAt' => $this->lastSuccess,
                'lastFailureAt' => $this->lastFailure, 'errorRate' => $this->errorRate(),
                'detail' => $e->getMessage(),
            ];
        }
    }

    public function fixtures(array $query): array
    {
        $from = (string) ($query['from'] ?? gmdate('Y-m-d'));
        $to = (string) ($query['to'] ?? gmdate('Y-m-d'));
        $resp = $this->call($this->baseUrl . '/fixtures?from=' . rawurlencode($from) . '&to=' . rawurlencode($to));
        return $this->decodeList($resp);
    }

    public function odds(string $fixtureExternalId): array
    {
        $resp = $this->call($this->baseUrl . '/fixtures/' . rawurlencode($fixtureExternalId) . '/odds');
        return $this->decodeList($resp);
    }

    public function results(string $fixtureExternalId): array
    {
        $resp = $this->call($this->baseUrl . '/fixtures/' . rawurlencode($fixtureExternalId) . '/results');
        return $this->decodeList($resp);
    }

    private function call(string $url): array
    {
        $this->requests++;
        $t0 = microtime(true);
        try {
            $resp = ($this->transport)($url, ['Authorization: Bearer ' . $this->token, 'Accept: application/json']);
        } catch (\Throwable $e) {
            $this->failures++;
            throw new ProviderException('provider transport failure: ' . $e->getMessage(), ProviderException::OFFLINE, $e);
        }
        $this->lastResponseMs = (int) round((microtime(true) - $t0) * 1000);
        $status = (int) ($resp['status'] ?? 0);
        if ($status === 0) { $this->failures++; throw new ProviderException('no HTTP response (timeout/unreachable)', ProviderException::OFFLINE); }
        if ($status === 401 || $status === 403) { $this->failures++; throw new ProviderException('authentication rejected (HTTP ' . $status . ')', ProviderException::AUTHENTICATION_ERROR); }
        if ($status === 429) { $this->failures++; throw new ProviderException('rate limited (HTTP 429)', ProviderException::RATE_LIMITED); }
        if ($status >= 500) { $this->failures++; throw new ProviderException('provider server error (HTTP ' . $status . ')', ProviderException::DATA_ERROR); }
        if ($status >= 400) { $this->failures++; throw new ProviderException('provider client error (HTTP ' . $status . ')', ProviderException::DATA_ERROR); }
        $this->lastSuccess = gmdate('c');
        return $resp;
    }

    /** @return array<int,array<string,mixed>> */
    private function decodeList(array $resp): array
    {
        $decoded = json_decode((string) ($resp['body'] ?? ''), true);
        if (!is_array($decoded)) throw new ProviderException('provider returned a non-JSON payload', ProviderException::DATA_ERROR);
        if (array_is_list($decoded)) return array_map(fn($r) => is_array($r) ? $r : ['_malformed' => $r], $decoded);
        if (isset($decoded['data']) && array_is_list($decoded['data'])) return array_map(fn($r) => is_array($r) ? $r : ['_malformed' => $r], $decoded['data']);
        throw new ProviderException('provider response has no list body', ProviderException::DATA_ERROR);
    }

    private function errorRate(): float
    {
        return $this->requests > 0 ? round($this->failures / $this->requests, 4) : 0.0;
    }

    private function reliability(): float
    {
        return round(1 - $this->errorRate(), 4);
    }
}
