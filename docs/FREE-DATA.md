# Free Public Data and Learning

Oracle 5.1 can improve forecasts with zero-cost public sources and local computation. Every connector is optional and disabled by default.

## Sources

### Sleeper

Sleeper provides a public read-only NFL API. Oracle uses player identity, league state, injury designation, practice participation, depth-chart order, and 24-hour add/drop trends. Trend-derived evidence includes Sleeper attribution. A league ID is optional and remains runtime configuration.

### nflverse

nflverse publishes player identities and weekly player statistics under CC-BY-4.0. Oracle uses prior completed weeks for rolling opportunity evidence and uses multi-season outcomes for leakage-safe walk-forward calibration. The final season is excluded from fitting and used only as a holdout.

### Open-Meteo

Open-Meteo's hosted free API is opt-in because its free hosted tier is non-commercial. Oracle requires `ORACLE_OPEN_METEO_NONCOMMERCIAL_ACK=true`, skips roofed venues, limits requests to games inside the forecast horizon, and includes the required attribution.

## Network safety

- No public request accepts an arbitrary URL.
- Initial origins, redirect origins, and path prefixes are allowlisted.
- HTTPS is required outside localhost tests.
- Conditional requests use ETag and Last-Modified.
- Cached bytes are rehashed before use.
- Streamed responses have hard size limits.
- Provider failures use bounded stale data and a circuit breaker.
- Startup performs no source synchronization.

## Calibration

The committed bootstrap model was generated from nflverse 2021-2025 weekly outcomes. Seasons 2021-2024 fit the calibration; 2025 is an untouched holdout. Promotion requires weighted interval score improvement without unacceptable RMSE, Brier, or coverage regression.

The production forecast journal records one snapshot per player, week, version, and six-hour bucket. Settlements score every eligible snapshot, while training selects only the latest pre-outcome forecast for each player-week. Temporary what-if forecasts are never journaled.

## Rebuild

```bash
npm run build:calibration:free
```

Raw public downloads remain under the ignored `data/free-sources/cache/` directory. Only the compact calibration, scorecard, and attribution documentation are committed.
