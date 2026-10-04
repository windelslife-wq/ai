<?php
namespace Aegis\Brokers;

/**
 * SIMULATED MT5 bridge configuration — OFFLINE DEMO BRIDGE ONLY.
 *
 * When an operator enables "Simulated MT5 bridge" in Broker Center, the dev
 * runtime writes a marker file (application/data/mt5-demo.json). This class
 * turns that marker into the AEGIS_MT5_* environment for the request, so the
 * ordinary Mt5BridgeConnector — with all of its gates intact (trading flag,
 * bridge-verified tradingEnabled, demo account) — can run the FULL execution
 * pipeline against the in-process mock bridge:
 *
 *   propose → 15-step pipeline → approve → route → simulated fill → audit.
 *
 * Honesty rules:
 *   - The marker is only honored inside the dev bridge (index.php calls
 *     applyEnv from its X-Aegis-Orig-Uri block); production deployments never
 *     read it.
 *   - The bridge URL must be loopback (127.0.0.1) — never an external host.
 *   - The connector's status surfaces the bridge-reported `simulated` flag,
 *     and the consoles show a SIMULATION banner while it is active.
 */
final class DemoBridgeConfig
{
    /** Apply marker env when enabled. Returns a description, or null when inactive. */
    public static function applyEnv(string $markerPath, string $loopbackBase = 'http://127.0.0.1'): ?array
    {
        if (!is_file($markerPath)) return null;
        $marker = json_decode((string) @file_get_contents($markerPath), true);
        if (!is_array($marker) || ($marker['enabled'] ?? false) !== true) return null;
        $token = (string) ($marker['token'] ?? '');
        $port = (int) ($marker['port'] ?? 8790);
        if (strlen($token) < 16 || $port < 1024 || $port > 65535) return null;

        // Never override an explicitly configured real bridge.
        if (getenv('AEGIS_MT5_BRIDGE_URL') !== false) return null;

        putenv('AEGIS_MT5_BRIDGE_URL=' . $loopbackBase . ':' . $port);
        putenv('AEGIS_MT5_BRIDGE_TOKEN=' . $token);
        putenv('AEGIS_MT5_BRIDGE_ENABLED=1');
        putenv('AEGIS_MT5_TRADING_ENABLED=' . ((($marker['trading'] ?? true) === true) ? '1' : '0'));
        putenv('AEGIS_MT5_LIVE_ALLOWED=0'); // a simulated bridge can never be a live account
        return self::describe($markerPath);
    }

    /** @return array{enabled: bool, simulated: true, port?: int}|null */
    public static function describe(string $markerPath): ?array
    {
        if (!is_file($markerPath)) return null;
        $marker = json_decode((string) @file_get_contents($markerPath), true);
        if (!is_array($marker) || ($marker['enabled'] ?? false) !== true) return null;
        return ['enabled' => true, 'simulated' => true, 'port' => (int) ($marker['port'] ?? 8790), 'trading' => ($marker['trading'] ?? true) === true];
    }

    /** Create/update the marker (demo toggle ON). Returns the written marker. */
    public static function enable(string $markerPath, int $port = 8790): array
    {
        $marker = [
            'enabled' => true,
            'trading' => true,
            'port' => $port,
            'token' => bin2hex(random_bytes(24)),
            'rotatedAt' => gmdate('c'),
            'note' => 'SIMULATED MT5 bridge — offline demo only, in-process mock, never a real broker',
        ];
        @mkdir(dirname($markerPath), 0775, true);
        file_put_contents($markerPath, json_encode($marker, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        return $marker;
    }

    /** Disable (demo toggle OFF). */
    public static function disable(string $markerPath): void
    {
        if (is_file($markerPath)) {
            $marker = json_decode((string) @file_get_contents($markerPath), true);
            if (is_array($marker)) {
                $marker['enabled'] = false;
                file_put_contents($markerPath, json_encode($marker, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            }
        }
    }
}
