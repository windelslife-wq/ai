/**
 * Sports Intelligence API — slice 1 of row 14: provider status and the honesty matrix.
 *
 * **One route, and it is a read.** Legacy's `Api_sports` exposes twenty-odd
 * endpoints across matches, odds, predictions, tickets, results, models,
 * calibrations, backtests, jobs, configuration and monitoring. Every one of them
 * reads from or writes to the eleven tables this slice does not create, so none of
 * them is ported. Shipping a `GET /api/v1/sports/matches` that answered from a live
 * provider call instead of stored history would return a different thing under the
 * same name — and the name is what an operator and the SPA both rely on.
 *
 * **Authorization is not a divergence here, and that is worth recording.**
 * `Api_sports` is the best-gated controller in the legacy application: every read
 * requires `sports.view`, every write requires `sports.manage`, and approval and
 * settlement have their own `sports.approve` and `sports.settle`. This route
 * requires `sports.view` because legacy did, not because a finding forced it. The
 * contrast with `Api_system` (**F-32**) is the point: the same codebase gated one
 * module's reads correctly and left another's open, so "legacy did it this way" is
 * evidence about a controller, never about the application.
 *
 * Since no ported module has a console screen (**F-29**), the list of what is *not*
 * ported travels in the response — the same decision as BC-10 in the broker port. A
 * module that reported only what it has would look complete.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";

/**
 * The status route's query contract.
 *
 * Declaring it is not optional decoration: `validateRequest` rebuilds
 * `request.query` from the schema, so **an undeclared parameter is dropped rather
 * than passed through**. Without this, `?probe=1` never reached the handler and the
 * route silently always took the cheap reading — a flag that looks settable and is
 * not read, which is the shape F-30 and D-21 both describe.
 *
 * A boolean, matching `PROVIDERS_QUERY.refresh` in the market-data module. The
 * validator's query-string coercion already accepts `1`/`true`/`yes` and
 * `0`/`false`/`no` **case-insensitively** and rejects anything else, so there is no
 * spelling to enumerate here and nothing for the handler to parse.
 *
 * The first version of this schema was a string with a hand-written value list. It
 * worked, and it was wrong: it duplicated a coercion rule the platform already has,
 * and it disagreed with that rule — `?probe=YES` was refused here and accepted by
 * every other boolean query flag on the platform. Two sources of truth for one
 * convention is how a codebase ends up with flags that behave differently depending
 * on which module you are calling.
 */
const STATUS_QUERY = Object.freeze({
  probe: Object.freeze({ type: "boolean", default: false }),
});

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.store
 * @param {object|null} [options.sports] the sports service
 */
export function sportsRoutes(app, { config, store, sports = null }) {
  const authenticate = createAuthenticator({ store, config });
  const canViewSports = requirePermission("sports.view", config);
  canViewSports.permission = "sports.view";

  /**
   * Provider configuration, derived health, and the list of sports capabilities
   * that are not ported.
   *
   * **Probe-free unless `probe=1` is passed** (divergence SP-10). Legacy's
   * `status()` called every provider's `health()` on every request, which for the
   * HTTP provider is an outbound call to a third-party vendor from a dashboard
   * load. The default here derives status from stored observations instead; since
   * this slice stores none, that derivation is `UNKNOWN` — the monitor's defined
   * answer when it has witnessed nothing, not a placeholder.
   *
   * A probed response is stamped `persisted: false`, because a reading with no
   * history behind it must not be mistaken for one.
   *
   * No secret can appear in this response: providers are described by id and kind,
   * the base URL is reported as a boolean rather than as a value, and the token is
   * never read outside the `Authorization` header.
   */
  app.get("/sports/status", {
    preHandler: [authenticate, canViewSports],
    querySchema: STATUS_QUERY,
  }, async (request) => {
    if (!sports) {
      throw new AppError(503, "SPORTS_SERVICE_UNAVAILABLE", "The sports service is not configured on this host");
    }
    // Already coerced and already defaulted by `STATUS_QUERY`, so this is a strict
    // comparison and not a parse. A probe is outbound I/O, which is why the default
    // is `false`: the cheap reading has to be the one a caller gets by accident.
    const probe = request?.query?.probe === true;
    const report = await sports.status({ probe });
    return {
      ...report,
      // Stated rather than left to inference, because `providersConfigured: false`
      // and `derivedStatus: "UNKNOWN"` are the *expected* answers on a default host
      // and neither is a fault.
      notice: report.providersConfigured
        ? "Providers are configured from the environment. Nothing is persisted in this slice: ingestion, prediction, ticketing, settlement, calibration and backtesting are not ported."
        : "No sports provider is configured, so no fixture, odds, prediction or ticket can be produced. Nothing is fabricated to fill the gap.",
    };
  });
}
