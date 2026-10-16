/**
 * Broker Center API — connector health and the honest capability matrix (row 13).
 *
 * Legacy exposed `Api_system::brokers()` returning `{brokers: allStatus()}` and
 * nothing else; the `PLANNED` matrix and the `routable` flag lived only in the
 * console view (`application/controllers/Brokers.php`). Since the Broker Center
 * screen is not ported yet (**F-29**), both move into this response — otherwise the
 * distinction between "scaffolded, never verified" and "working" would exist only
 * in a PHP view that nothing renders (divergence BC-10).
 *
 * **This module has one route and it is a read.** There is no order endpoint, no
 * connector-enable endpoint and no simulated-bridge toggle: legacy's
 * `Brokers::sim_toggle()` wrote a marker file that its dev front controller
 * translated into environment variables, and this platform has no equivalent
 * in-process mock bridge. Porting the toggle without the bridge it toggles would
 * advertise a capability that does not exist. Order routing stays where legacy put
 * it — exclusively in the execution supervisor — and stays unavailable until a
 * real adapter is deployed and verified.
 *
 * **F-32 is fixed here rather than inherited.** Legacy's `brokers()`,
 * `mt5_account()` and `mt5_quote()` made no `requirePermission` call at all, so any
 * signed-in user could read connector health, and `mt5_account` returned the broker
 * login, currency, balance and equity. This route requires `trading.view`.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { plannedConnectors } from "./registry.js";

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

  /**
   * Connector health for every registered adapter, plus the planned matrix and the
   * one boolean that matters: could an order be routed right now?
   *
   * `allStatus()` probes each connector, so this endpoint's latency is the slowest
   * enabled bridge. Disabled connectors short-circuit before any I/O, which is why
   * a default deployment answers instantly: all ten report `DISABLED` without a
   * single network call.
   *
   * No secret can appear in this response. `status()` never returns a URL, a token
   * or a query string, and the connector's own error messages are written so a
   * transport failure cannot carry a provider stack trace back to the caller.
   */
  app.get("/brokers", {
    preHandler: [authenticate, canViewTrading],
  }, async () => {
    if (!brokers) {
      throw new AppError(503, "BROKER_REGISTRY_UNAVAILABLE", "The broker registry is not configured on this host");
    }
    const [status, routable] = await Promise.all([brokers.allStatus(), brokers.routable()]);
    return {
      brokers: status,
      planned: plannedConnectors(),
      routable,
      // Stated on every response rather than left to inference: `routable: false`
      // is the expected answer on any host that has not deployed and verified a
      // real adapter, and the reason is not a bug in this platform.
      notice: routable
        ? "A connector reports effective order submission. Order routing still lives exclusively in the execution supervisor."
        : "No connector is READY with effective order submission, so no order can be routed from this host.",
    };
  });
}
