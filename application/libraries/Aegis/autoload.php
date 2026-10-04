<?php
/**
 * AEGIS domain loader.
 *
 * Some domain files group related classes, and interfaces must be loaded
 * before their implementors, so a per-class autoloader is not enough. We
 * require every domain file once in an explicit dependency-safe order:
 * interfaces/traits first, then everything else. No domain file has
 * top-level side effects.
 */
$aegisDir = __DIR__;
$priority = [
    $aegisDir . '/Providers/MarketDataProvider.php',   // provider interface
    $aegisDir . '/Sports/Providers/SportsDataProvider.php', // sports provider interface + manager
    $aegisDir . '/Persistence/Repositories.php',      // repository interfaces
    $aegisDir . '/Brokers/BrokerConnector.php',       // broker interface + manager
    $aegisDir . '/Brokers/TradingConnector.php',      // order-capable broker interface
    $aegisDir . '/Agents/AgentHelperTrait.php',       // trait
    $aegisDir . '/Strategies/BuiltinStrategies.php',  // TradingStrategy interface + builtins
];
foreach ($priority as $file) {
    if (is_file($file)) {
        require_once $file;
    }
}
foreach ([$aegisDir . '/*.php', $aegisDir . '/*/*.php', $aegisDir . '/*/*/*.php'] as $pattern) {
    $files = glob($pattern);
    sort($files);
    foreach ($files as $file) {
        $base = basename($file);
        if ($base === 'autoload.php' || in_array($file, $priority, true)) {
            continue;
        }
        require_once $file;
    }
}
