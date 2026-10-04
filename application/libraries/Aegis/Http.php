<?php
namespace Aegis;

/**
 * HTTP client built on PHP streams (no curl dependency) with timeout,
 * bounded retries, exponential backoff and 429 cooldown. Used by real
 * providers; fully unit-testable via an injectable transport.
 */
class Http
{
    /** @var callable(string): ?string returns response body or null on failure */
    public $transport;

    public function __construct(?callable $transport = null)
    {
        // Default transport: file_get_contents with a stream context.
        $this->transport = $transport ?? function (string $url): ?string {
            $ctx = stream_context_create([
                'http' => [
                    'method' => 'GET',
                    'timeout' => 6.0,
                    'header' => "User-Agent: AEGIS/0.3\r\nAccept: application/json\r\n",
                    'ignore_errors' => true,
                ],
                'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
            ]);
            $body = @file_get_contents($url, false, $ctx);
            return $body === false ? null : $body;
        };
    }

    /**
     * Binance (and similar) error envelopes look like {"code":-1121,"msg":"..."}.
     * Treating those as candle rows produced two invalid bars and a silent
     * NO_TRADE / "Agent technical failed" dashboard on production.
     */
    public static function isProviderErrorPayload($json): bool
    {
        if (!is_array($json) || array_is_list($json)) return false;
        if (!array_key_exists('code', $json) || !isset($json['msg'])) return false;
        if (!is_numeric($json['code'])) return false;
        return (int) $json['code'] !== 200;
    }

    public function getJson(string $url, int $retries = 2, int $timeoutMs = 6000, int $rateLimitCooldownMs = 30000)
    {
        $transport = $this->transport;
        $lastError = 'transport failed';
        for ($attempt = 0; $attempt <= $retries; $attempt++) {
            $body = $transport($url);
            if ($body !== null) {
                $json = json_decode($body, true);
                if (is_array($json)) {
                    if (self::isProviderErrorPayload($json)) {
                        $lastError = 'provider error: ' . (string) $json['msg'];
                    } else {
                        return $json;
                    }
                } else {
                    $lastError = 'invalid JSON response';
                }
            } else {
                $lastError = 'request failed (network/timeout)';
            }
            if ($attempt < $retries) {
                usleep(min(1000000, (2 ** $attempt) * 300) * 1000);
            }
        }
        throw new \RuntimeException($lastError);
    }
}
