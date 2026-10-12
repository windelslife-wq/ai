/**
 * The connector roster and its construction — a port of the ten `register()`
 * calls in `Aegis\Platform::__construct` (lines 68–78) and the `PLANNED`
 * capability matrix in `application/controllers/Brokers.php` (row 13).
 *
 * All ten connectors are registered unconditionally, in legacy's order, and all
 * ten are **disabled by default**. Registering a connector is not enabling one:
 * an unconfigured connector reports `DISABLED`, is never returned by
 * `tradingConnector()`, and cannot be read from or written to. Legacy did exactly
 * this so the Broker Center could show the honest state of every integration
 * rather than only the ones somebody had switched on.
 *
 * Environment variable names are legacy's verbatim, including the `AEGIS_`
 * prefix — `config.js` already keeps that prefix for the licensed market-data
 * providers, so a deployment's existing broker settings carry across unchanged
 * and the `DISABLED` message names the exact variable to set.
 *
 * The `verification` block on each entry is legacy's own wording, preserved
 * verbatim. It is the distinction the migration plan requires between something
 * real, something scaffolded and something planned: nine of these ten adapters
 * have never spoken to their provider, and the text says so in the API response
 * rather than leaving a reader to infer it from an absent feature.
 */

import { createBrokerManager } from "./manager.js";
import { createTradingConnector } from "./connector.js";
import { createBridgeTransport } from "./transport.js";

export const BROKER_CONNECTOR_ROSTER = Object.freeze([
  {
    id: "mt5-bridge",
    displayName: "MT5 bridge",
    envPrefix: "AEGIS_MT5_BRIDGE",
    // Legacy's Mt5BridgeConnector declared no `marketClasses` at all — unlike the
    // generic connector, whose subclasses each list theirs. Node keeps the list
    // empty rather than inventing one: which classes a real MT5 account offers is
    // a property of that broker's symbol list, discovered from the bridge, not a
    // claim this platform should assert up front (divergence BC-9).
    marketClasses: [],
    verification: Object.freeze({
      status: "TESTED",
      detail: "Full contract surface against the documented bridge JSON contract, unit-tested with an injected simulated transport; order submission needs the local trading flag AND bridge-side tradingEnabled AND a demo account unless live trading is explicitly allowed — NOT yet verified against a real MetaTrader terminal",
    }),
  },
  {
    id: "mt4-bridge",
    displayName: "MetaTrader 4",
    envPrefix: "AEGIS_MT4_BRIDGE",
    marketClasses: ["forex"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; verify against a real MT4 bridge after MT5 verification",
    }),
  },
  {
    id: "binance",
    displayName: "Binance exchange",
    envPrefix: "AEGIS_BINANCE_CONNECTOR",
    marketClasses: ["crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; provider-specific exchange mapping and demo/sandbox verification required",
    }),
  },
  {
    id: "bybit",
    displayName: "Bybit exchange",
    envPrefix: "AEGIS_BYBIT_CONNECTOR",
    marketClasses: ["crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required",
    }),
  },
  {
    id: "okx",
    displayName: "OKX exchange",
    envPrefix: "AEGIS_OKX_CONNECTOR",
    marketClasses: ["crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required",
    }),
  },
  {
    id: "coinbase",
    displayName: "Coinbase exchange",
    envPrefix: "AEGIS_COINBASE_CONNECTOR",
    marketClasses: ["crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required",
    }),
  },
  {
    id: "kraken",
    displayName: "Kraken exchange",
    envPrefix: "AEGIS_KRAKEN_CONNECTOR",
    marketClasses: ["crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; provider-specific exchange mapping and sandbox verification required",
    }),
  },
  {
    id: "ib",
    displayName: "Interactive Brokers",
    envPrefix: "AEGIS_IB_CONNECTOR",
    marketClasses: ["stock", "etf", "futures", "options"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; verify the gateway contract and demo account first",
    }),
  },
  {
    id: "alpaca",
    displayName: "Alpaca",
    envPrefix: "AEGIS_ALPACA_CONNECTOR",
    marketClasses: ["stock", "etf", "crypto"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; verify paper-account mapping and provider permissions first",
    }),
  },
  {
    id: "oanda",
    displayName: "OANDA",
    envPrefix: "AEGIS_OANDA_CONNECTOR",
    marketClasses: ["forex"],
    verification: Object.freeze({
      status: "PLANNED",
      detail: "Contract adapter scaffolded; verify the practice-account mapping first",
    }),
  },
]);

/** The nine adapters that have never spoken to their provider, in legacy's order. */
export function plannedConnectors() {
  return BROKER_CONNECTOR_ROSTER
    .filter((entry) => entry.verification.status === "PLANNED")
    .map((entry) => Object.freeze({
      id: entry.id,
      name: entry.displayName,
      status: entry.verification.status,
      detail: entry.verification.detail,
    }));
}

/**
 * Build the manager with all ten connectors registered from configuration.
 *
 * @param {object} options
 * @param {object} options.brokers the `config.brokers` block
 * @param {() => number} [options.now]
 * @param {(entry: object, settings: object) => Function} [options.transportFactory]
 *   injectable so tests can hand every connector the same fake bridge
 */
export function createBrokerRegistry({ brokers, now, transportFactory } = {}) {
  const settings = brokers ?? {};
  const perConnector = settings.connectors ?? {};
  const manager = createBrokerManager();

  for (const entry of BROKER_CONNECTOR_ROSTER) {
    const configured = perConnector[entry.id] ?? {};
    const baseUrl = configured.url ?? null;
    const transport = typeof transportFactory === "function"
      ? transportFactory(entry, configured)
      : (baseUrl ? createBridgeTransport({ baseUrl, timeoutMs: settings.requestTimeoutMs }) : null);

    manager.register(createTradingConnector({
      id: entry.id,
      displayName: entry.displayName,
      envPrefix: entry.envPrefix,
      marketClasses: entry.marketClasses,
      url: baseUrl ?? "",
      token: configured.token ?? "",
      enabled: configured.enabled === true,
      tradingEnabled: configured.tradingEnabled === true,
      liveAllowed: configured.liveAllowed === true,
      transport,
      now,
      healthTtlMs: settings.healthTtlMs,
      requestTimeoutMs: settings.requestTimeoutMs,
    }));
  }

  return manager;
}
