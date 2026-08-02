# Free Intelligence 5.1

Status: implementation plan
Baseline: `d919570f288ea65bf279370ad8e0a8692a940c98`
Branch: `free-intelligence-v5.1`

## Goal

Improve Oracle using only public, zero-cost data and local computation. No paid API, licensed projection feed, subscription, or new cloud service may be required for the default implementation.

## Constraints

- External sources are optional and never required for startup or readiness.
- Every network source is allowlisted, attributable, cached, size bounded, rate limited, and stale-if-error.
- Public requests cannot trigger arbitrary downloads or durable writes.
- Provider terms and licences are surfaced in status and documentation.
- Historical evaluation is chronological and prevents future leakage.
- Calibration is applied only when minimum sample and quality gates pass.

## Phase 1: resilient free-source runtime

- Disk-backed conditional HTTP cache with ETag and Last-Modified support.
- Atomic metadata and payload writes with SHA-256 verification.
- Host allowlist, redirect validation, timeout, response-size cap, and minimum fetch interval.
- Stale-cache fallback and provider circuit breaker.
- Source status with freshness, digest, attribution, licence, and last error.

## Phase 2: public connectors

- Sleeper: NFL state, active players, trending adds/drops, and optional league context.
- nflverse: player identity map, weekly player outcomes, and schedules.
- Open-Meteo: opt-in non-commercial game weather with attribution and explicit call budget.
- ESPN/Sleeper/nflverse identity reconciliation through external IDs plus guarded name matching.

## Phase 3: probabilistic evaluation and calibration

- Forecast journal with deterministic deduplication and outcome settlement.
- Proper scores: log loss, Brier, MAE, RMSE, pinball loss, interval coverage, width, and weighted interval score.
- Rolling, position-aware conformal calibration with finite-sample quantiles.
- Availability reliability calibration with shrinkage toward the identity map.
- Walk-forward nflverse backtest using only observations available before each week.
- Quality gates for sample size, coverage, score improvement, freshness, and holdout season.

## Phase 4: product integration

- Optional scheduled synchronization with bounded cadence.
- Administrative sync, journal, settlement, and backtest routes.
- Public source attribution and calibration scorecard routes.
- Control-plane metrics, event history, health, model-registry challenger evaluation, and recovery coverage.
- Research Lab source freshness and calibration scorecard.
