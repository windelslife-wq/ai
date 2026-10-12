/**
 * Request contracts for the research-only portfolio optimizer.
 *
 * The vocabulary mirrors `Aegis\Platform::optimizePortfolio()`
 * (`application/libraries/Aegis/Platform.php:187`): the same nine market classes,
 * the same four timeframes, the same 31–2000 history bound and the same
 * `allowSyntheticData` opt-in, so an existing client keeps working after cutover.
 *
 * Two divergences from the legacy facade, both recorded in
 * `docs/migration/PHASE11_PORTFOLIO_OPTIMIZER.md`:
 *  - **PO-3** an out-of-vocabulary `timeframe` or `marketClass` is rejected (400)
 *    rather than reaching the provider chain and failing there with a 503. Legacy
 *    validated the timeframe up front but let an unsupported market class fall
 *    through to `getCandleSeries`, so the caller got an outage message for what was
 *    a typo.
 *  - **PO-4** `assets` is bounded by the schema (`minItems`/`maxItems`) as well as
 *    by the service. Legacy checked the count twice — once in the facade, once in
 *    the optimizer — with the same numbers; declaring it once here means a
 *    fourteen-asset body is refused before any of it is parsed.
 *
 * Note what is **not** here: no `amount`, no `accountId`, no `orderId`, no
 * `execute` flag. The body cannot express an instruction to trade, which is the
 * structural guarantee behind `status: "RESEARCH_ONLY"`.
 */

import { MAX_ASSETS, MIN_ASSETS, OBJECTIVES } from "./optimizer.js";
import {
  MAX_CANDLE_LIMIT,
  MIN_CANDLE_LIMIT,
  PORTFOLIO_MARKET_CLASSES,
  PORTFOLIO_TIMEFRAMES,
} from "./service.js";

export { MAX_ASSETS, MIN_ASSETS, OBJECTIVES, PORTFOLIO_MARKET_CLASSES, PORTFOLIO_TIMEFRAMES };

/**
 * One asset in the requested universe.
 *
 * `additionalProperties: false` matters more here than on most bodies: this is the
 * endpoint a caller would most plausibly try to extend with a position size or a
 * notional amount, and an undeclared key is rejected with UNKNOWN_PROPERTY instead
 * of being silently ignored while the caller believes it took effect.
 */
export const PORTFOLIO_ASSET_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["symbol", "marketClass"],
  properties: Object.freeze({
    // 2–24 is this platform's symbol ceiling (see the analysis contracts); the
    // optimizer's own 1–64 pattern is a floor under it, not a replacement for it.
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24 }),
    marketClass: Object.freeze({ type: "string", values: [...PORTFOLIO_MARKET_CLASSES] }),
  }),
});

export const OPTIMIZE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["assets"],
  properties: Object.freeze({
    assets: Object.freeze({
      type: "array",
      minItems: MIN_ASSETS,
      maxItems: MAX_ASSETS,
      items: PORTFOLIO_ASSET_BODY,
    }),
    timeframe: Object.freeze({ type: "string", values: [...PORTFOLIO_TIMEFRAMES], default: "1d" }),
    limit: Object.freeze({ type: "integer", min: MIN_CANDLE_LIMIT, max: MAX_CANDLE_LIMIT, default: 500 }),
    objective: Object.freeze({ type: "string", values: [...OBJECTIVES], default: "max_sharpe" }),
    /**
     * Per-asset weight cap. The floor is `1/n` — below it the box constraint and
     * "fully invested" cannot both hold — but that floor depends on the asset count,
     * which the schema does not know, so the optimizer enforces it and answers with
     * a message that names the count. Declaring `min: 0` here would let a request
     * through that the solver must then refuse, so the bound that *is* static
     * (strictly positive, at most 1) is declared and the rest is left to the solver.
     */
    maxWeight: Object.freeze({ type: "number", min: 0, max: 1, nullable: true }),
    /** Annual decimal, not a percentage: 0.04 is 4%. Legacy bounds −0.10…1.00. */
    riskFreeRate: Object.freeze({ type: "number", min: -0.1, max: 1, nullable: true }),
    /** Diagonal covariance shrinkage, 0 = pure sample covariance, 1 = diagonal only. */
    shrinkage: Object.freeze({ type: "number", min: 0, max: 1, nullable: true }),
    /**
     * Annualization factor. Deliberately **required** to be explicit when the
     * universe mixes market classes: crypto trades 365 days, forex and listed
     * equities roughly 252, and a universe spanning them has no single correct
     * number. Legacy threw in that case rather than averaging, and so does this.
     */
    periodsPerYear: Object.freeze({ type: "integer", min: 1, max: 100_000, nullable: true }),
    /**
     * Explicit opt-in to a simulation. When every series the provider chain could
     * serve is synthetic, the run is refused unless this is `true`, and the report
     * then carries a warning beginning with `SIMULATION:`. A **mix** of synthetic
     * and live series is refused regardless of this flag.
     */
    allowSyntheticData: Object.freeze({ type: "boolean", default: false }),
  }),
});

export const messages = Object.freeze({
  RESEARCH_ONLY:
    "Portfolio optimization output is research only. It is not investment advice and it is not an order.",
});
