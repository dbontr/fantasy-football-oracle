# Oracle 5.2 Perpetual-Free Intelligence Plan

## Objective

Make every production intelligence path usable indefinitely without a trial, credit card, paid quota, or mandatory account. Preserve offline startup and failure isolation.

## Phase 1: enforce the source contract

Files: `server/free-source-catalog.js`, `server/free-source-policy.js`, config, API, tests.

- Classify each source by access, license, authentication, payment, quota, and fallback.
- Reject sources that are trial-backed, payment-gated, account-mandatory, or commercially restricted.
- Expose a public compliance report without paths or credentials.
- Acceptance: startup and synchronization refuse any noncompliant source before network access.

## Phase 2: government weather

Files: `server/nws-connector.js`, venue and game identity modules, forecast features, tests.

- Use `api.weather.gov` only, with a configured User-Agent and cache-aware requests.
- Resolve stadium coordinates to NWS grid endpoints and select the closest kickoff forecast period.
- Skip indoor games and safely degrade when forecasts are unavailable.
- Acceptance: weather evidence is free for any purpose, keyless, bounded, attributable, and optional.

## Phase 3: free football feature store

Files: nflverse connector modules, rolling feature store, feature catalog, tests.

- Add injury/practice, depth-chart, weekly-roster, snap-share, and team-stat ingestion from nflverse releases.
- Compute only leakage-safe rolling features from completed prior weeks.
- Track source license and attribution per observation.
- Keep unsupported or absent datasets nonfatal.
- Acceptance: current-week outcomes never affect their own forecast and every derived feature has provenance.

## Phase 4: gated forecast integration

Files: probabilistic forecast, calibration/backtest, Research Lab, API, docs.

- Add bounded feature-family effects and uncertainty widening.
- Compare the feature challenger on chronological holdouts.
- Keep failed feature groups disabled in production.
- Acceptance: full tests, strict service smoke, recovery drill, clean release, and live Jupiter verification.
