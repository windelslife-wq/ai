/**
 * Broker Center API — connector health, authorized account/quote reads, and the
 * isolated in-process simulator. The simulator is never included in `routable`:
 * the latter answers whether a real configured connector may route an order.
 *
 * Every route requires `trading.view`; account balances and broker quotes are not
 * public health data. There are no connector-enable or live-order routes here.
 * The only order path added in this module is the separately gated execution
 * simulator, which is process-local and cannot contact a terminal or provider.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { plannedConnectors } from "./registry.js";

const QUOTE_QUERY = Object.freeze({
  symbol: Object.freeze({ type: "string", required: true, minLength: 2, maxLength: 32, pattern: /^[A-Za-z0-9._-]+$/ }),
});

function unavailable(message, code) {
  return AppError.unavailable(message, { code, retryAfter: 30 });
}

function readFailure(error, label) {
  if (error instanceof AppError) return error;
  return new AppError(502, "BROKER_READ_FAILED", `${label} could not be read from the configured connector`);
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.store
 * @param {object|null} [options.brokers] the broker manager
 */
export function brokerRoutes(app, { config, store, brokers = null }) {
  const authenticate = createAuthenticator({ store, config });
  const canViewTrading = requirePermission("trading.view", config);
  canViewTrading.permission = "trading.view";
  const guarded = { preHandler: [authenticate, canViewTrading] };

  app.get("/brokers", guarded, async () => {
    if (!brokers) throw unavailable("The broker registry is not configured on this host", "BROKER_REGISTRY_UNAVAILABLE");
    const [status, routable] = await Promise.all([brokers.allStatus(), brokers.routable()]);
    const simulation = typeof brokers.simulationStatus === "function"
      ? brokers.simulationStatus()
      : { enabled: false, ordersEnabled: false, memoryOnly: true, accountType: "demo", liveTradingEnabled: false, state: "DISABLED" };
    return {
      brokers: status,
      planned: plannedConnectors(),
      routable,
      simulation,
      notice: routable
        ? "A configured real connector reports effective order submission; the execution supervisor remains the only broker route."
        : "No real connector is READY with effective order submission. The optional in-process simulator is isolated and never counts as real broker routing.",
    };
  });

  app.get("/brokers/mt5/account", guarded, async () => {
    if (!brokers) throw unavailable("The broker registry is not configured on this host", "BROKER_REGISTRY_UNAVAILABLE");
    const connector = brokers.get("mt5-bridge");
    if (!connector?.isConfigured?.()) throw unavailable("The MT5 bridge is not enabled and configured", "BROKER_NOT_CONFIGURED");
    try {
      return { account: await connector.account(), simulationOnly: false };
    } catch (error) {
      throw readFailure(error, "MT5 account");
    }
  });

  app.get("/brokers/mt5/quote", { ...guarded, querySchema: QUOTE_QUERY }, async (request) => {
    if (!brokers) throw unavailable("The broker registry is not configured on this host", "BROKER_REGISTRY_UNAVAILABLE");
    const connector = brokers.get("mt5-bridge");
    if (!connector?.isConfigured?.()) throw unavailable("The MT5 bridge is not enabled and configured", "BROKER_NOT_CONFIGURED");
    try {
      return { quote: await connector.quote(request.query.symbol), simulationOnly: false };
    } catch (error) {
      throw readFailure(error, "MT5 quote");
    }
  });

  app.get("/brokers/simulation/account", guarded, async () => {
    if (!brokers || typeof brokers.simulationConnector !== "function") {
      throw unavailable("The in-process broker simulator is disabled", "SIMULATOR_DISABLED");
    }
    const connector = brokers.simulationConnector();
    if (!connector) throw unavailable("The in-process broker simulator is disabled", "SIMULATOR_DISABLED");
    try {
      return { account: await connector.account(), simulationOnly: true, memoryOnly: true };
    } catch (error) {
      throw readFailure(error, "Simulated account");
    }
  });

  app.get("/brokers/simulation/quote", { ...guarded, querySchema: QUOTE_QUERY }, async (request) => {
    if (!brokers || typeof brokers.simulationConnector !== "function") {
      throw unavailable("The in-process broker simulator is disabled", "SIMULATOR_DISABLED");
    }
    const connector = brokers.simulationConnector();
    if (!connector) throw unavailable("The in-process broker simulator is disabled", "SIMULATOR_DISABLED");
    try {
      return { quote: await connector.quote(request.query.symbol), simulationOnly: true, memoryOnly: true };
    } catch (error) {
      throw readFailure(error, "Simulated quote");
    }
  });
}
