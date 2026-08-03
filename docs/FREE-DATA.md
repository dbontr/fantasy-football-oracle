# Perpetually Free Public Data and Learning

Oracle 5.2 can improve forecasts using anonymous, keyless public sources and local computation. Startup remains offline. Sleeper, nflverse, and NOAA/NWS are available for bounded administrator-triggered refresh by default; scheduled synchronization remains disabled unless explicitly enabled.

## Enforced source contract

Every configured source is validated before the cache can issue a network request. A provider is rejected when it requires an account, API key, OAuth, payment method, trial, expiring free access, restricted hosted tier, paid quota upgrade, or mandatory paid fallback. Each source must also support offline startup, stale or missing-data fallback, and isolated failure.

`GET /api/v5/free-sources` exposes the public compliance report, attribution, usage basis, cache limits, and runtime state without exposing local paths or credentials.

## Sources

### Sleeper

Sleeper provides a public read-only NFL API. Oracle uses player identity, league state, injury designation, practice participation, depth-chart order, and 24-hour add/drop trends. A league ID is optional and remains local runtime configuration.

### nflverse

nflverse publishes identities and football datasets under CC-BY-4.0 unless an individual release states otherwise. Oracle uses weekly outcomes, injuries, depth charts, weekly rosters, snap counts, and team statistics. Derived observations use completed prior weeks only and retain dataset, season, week, derivation, and source-record provenance.

### NOAA National Weather Service

The NWS API is anonymous and keyless. Oracle resolves supported U.S. stadium coordinates to NWS grid forecasts, selects the hourly period nearest kickoff, skips indoor or roofed venues, and isolates an unavailable forecast to that game. Unsupported and international venues receive no weather correction rather than a trial or paid fallback.

## Network safety

- Public requests never accept an arbitrary URL.
- Initial origins, redirects, and path prefixes are allowlisted.
- HTTPS is required outside localhost tests.
- Conditional requests use ETag and Last-Modified.
- Cached bytes are rehashed before use.
- Streamed responses have hard size limits.
- Provider failures use bounded stale data and circuit breakers.
- Startup performs no source synchronization.

## Calibration and context policy

The base probabilistic calibration uses nflverse 2021–2025 weekly outcomes. Seasons 2021–2024 fit the model; 2025 is an untouched holdout. Promotion requires weighted-interval-score improvement without unacceptable RMSE, Brier, or coverage regression.

The v5.2 context policy is separate and digest validated. Its hyperparameters are selected on 2024 after training only through 2023. It is then refit through 2024 and evaluated once on 6,563 player-weeks from 2025. The production order is reproduced exactly: base calibration first, then a bounded correction fitted to the remaining residual. Target share is excluded from this policy because it already contributes through Oracle's baseline forecast.

The approved seven-feature policy uses air-yards share, WOPR, receiving EPA per target, rushing EPA per carry, passing EPA per dropback, opportunity trend, and points-per-opportunity trend. Corrections are capped at +/-1.5 expected points and remain inactive when evidence is unavailable or the position is unsupported.

On the untouched 2025 holdout, the policy improved WIS by 0.02777, RMSE by 0.03951, MAE by 0.07363, and mean pinball loss by 0.01488. The nominal 80% interval covered 87.08% after the correction, so the forecast remains conservative rather than perfectly calibrated.

The production forecast journal records one snapshot per player, week, version, and six-hour bucket. Settlements score every eligible snapshot, while training selects only the latest pre-outcome forecast for each player-week. Temporary what-if forecasts are never journaled.

## Rebuild

```bash
npm run build:calibration:free
npm run build:context:free
```

Raw public downloads remain under ignored cache directories. Only compact calibration, context-policy, scorecard, and attribution artifacts are committed. Rebuilds require network access; normal startup and forecasting do not.
