# Oracle 5.2 Perpetual-Free Intelligence

## Objective

Oracle 5.2 makes the complete public-intelligence path usable indefinitely without a trial, credit card, paid quota, mandatory account, API key, or OAuth grant. It preserves offline startup, explicit provenance, bounded influence, and provider failure isolation.

## Source policy

`server/free-source-policy.js` validates each source before `FreeSourceCache` can issue a request. The policy rejects:

- nonzero price, trial-backed access, payment-method requirements, expiry, or paid fallback;
- mandatory accounts, API keys, or OAuth;
- hosted free tiers with use restrictions incompatible with the perpetual-free contract;
- startup network requirements or failures that are not isolated.

The committed catalog contains Sleeper, nflverse, and NOAA National Weather Service. The compliance report is public at `GET /api/v5/free-sources`.

## Public evidence

Sleeper contributes identity, injury, practice, depth-chart, trend, and optional league context. nflverse contributes identities, weekly outcomes, injuries, depth charts, weekly rosters, snap counts, and team statistics. NWS contributes kickoff wind, temperature, precipitation probability, and indoor status for supported U.S. venues.

All derived nflverse features exclude the forecast week. Missing releases and failed provider calls are recorded and isolated instead of fabricating values.

## Holdout-approved context policy

The production sequence is:

1. generate the baseline probabilistic forecast;
2. apply the approved position-aware probabilistic calibration;
3. extract available public context evidence;
4. apply a digest-validated position model to the post-calibration residual;
5. cap the expected-point correction at +/-1.5 and recompute mixture quantiles and probabilities.

The policy uses seven genuinely incremental features: air-yards share, WOPR, receiving EPA per target, rushing EPA per carry, passing EPA per dropback, opportunity trend, and points-per-opportunity trend. Target share is intentionally excluded because Oracle already uses it in the baseline model.

Hyperparameters were selected on 2024 using only 2021–2023 fitting data. The final policy was fitted through 2024 and evaluated once on 6,563 untouched 2025 player-weeks. The builder now fits residuals after base calibration and evaluates calibration-before-context, exactly matching runtime order.

| Metric | Calibrated baseline | Context policy | Improvement |
|---|---:|---:|---:|
| WIS | 2.59695 | 2.56918 | 0.02777 |
| RMSE | 5.97913 | 5.93962 | 0.03951 |
| MAE | 4.25642 | 4.18279 | 0.07363 |
| Mean pinball | 1.43823 | 1.42335 | 0.01488 |
| 80% coverage | 87.49% | 87.08% | -0.41 pp |

Every approval gate passed. Brier and log-loss were unchanged because the context policy adjusts scoring distributions, not availability probability. Coverage remains conservative rather than perfectly calibrated.

## Integrity and operations

The context artifact includes a SHA-256 semantic digest, exact feature order, training and holdout seasons, selection settings, validation checks, and position coefficients. Readiness fails when the artifact is missing, altered, unapproved, or not marked as matching production order. The artifact and summary are included in the release manifest.

The three compliant providers are enabled for manual administrator sync by default. `ORACLE_FREE_SYNC_ENABLED` remains false by default, so startup and steady-state operation make no source request unless the administrator explicitly refreshes or enables the scheduler.

## Limits

- NWS coverage is U.S.-centric; unsupported international games receive no weather adjustment.
- nflverse releases may be absent or delayed during the current season; those feeds fail independently.
- The context policy is a compact ridge correction, not a causal model or a substitute for route-level tracking.
- Production-online learning is not statistically useful until the journal accumulates multiple completed seasons.
- Correlation loadings remain transparent priors rather than a learned copula.
