# Portfolio Optimizer — Phase 6

The portfolio optimizer is an authenticated, research-only feature available at
`/portfolio` and `POST /api/portfolio/optimize`. It estimates long-only
allocations from historical closes. It does **not** read a user's existing
positions, make trades, create order sizes, or promise future returns.

## Request

```json
{
  "assets": [
    { "symbol": "BTCUSDT", "marketClass": "crypto" },
    { "symbol": "ETHUSDT", "marketClass": "crypto" }
  ],
  "timeframe": "1d",
  "limit": 365,
  "objective": "max_sharpe",
  "maxWeight": 0.6,
  "riskFreeRate": 0.0,
  "shrinkage": 0.15,
  "allowSyntheticData": false
}
```

The endpoint requires the signed-in user's `trading.view` permission and a
valid session CSRF token in `X-CSRF-Token`. It accepts 2–12 distinct symbols;
`marketClass` must be one of `forex`, `crypto`, `commodity`, `stock`, `etf`,
`futures`, `options`, `indices`, or `bonds`. Timeframes are `15m`, `1h`, `4h`,
and `1d`; `limit` is 31–2000 bars. The optimizer requires at least 30 aligned
returns across the entire asset universe.

`objective` is `max_sharpe` (default) or `min_variance`. `maxWeight` is a
fraction between `1 / assetCount` and 1. `riskFreeRate` is an annual decimal
(for example, `0.035` means 3.5%). `shrinkage` is between 0 and 1 and defaults
to 0.15. `periodsPerYear` can override annualization. Without an override,
the service infers a conventional calendar for a single market class; requests
mixing market classes/calendars must supply `periodsPerYear` explicitly.

## Estimation and output

- Only close prices at timestamps present in **every** requested series are
  used. Invalid closes are ignored and duplicate timestamps are discarded.
- Returns are simple close-to-close returns. Expected returns use the
  annualized arithmetic sample mean. Covariance uses the sample covariance,
  diagonal shrinkage, and a small numerical ridge before annualization.
- The minimum-variance allocation uses projected gradient on a convex
  long-only, fully invested, capped-weight problem.
- The maximum-Sharpe allocation uses deterministic multi-start projected
  ascent. It is an approximation, not a guarantee of a global optimum.
- The report includes selected weights, minimum-variance and maximum-Sharpe
  alternatives, an equal-weight benchmark, estimated per-asset return and
  volatility, pairwise correlations, source provenance, aligned-window
  details, warnings, and limitations.

Weights are nonnegative, sum to one, and cannot exceed `maxWeight`; shorting
and leverage are not permitted. All-synthetic history is rejected unless the
request explicitly sets `allowSyntheticData: true`. An optimization cannot
combine synthetic and live series. Permitted synthetic output is labeled as
simulation in both the result and audit log.

Fees, slippage, taxes, liquidity, corporate actions, portfolio rebalancing,
FX conversion, market-calendar irregularities and future returns are not
modeled. The result is historical research—not investment advice or an order.
