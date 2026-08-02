# Championship Operations

Fantasy Football Oracle 4.0 runs the native analysis engine behind a provenance, recovery, governance, and observability control plane.

## Public operational states

`GET /api/platform/status` returns one of five states:

- `healthy`: critical artifacts, current data, native compute, event chain, model registry, and recovery posture are usable;
- `degraded`: a fallback or old-but-usable input is active;
- `stale`: data exceeded its configured age budget;
- `unsafe`: integrity, required-feed, event-chain, or league-state validation failed;
- `unknown`: insufficient evidence exists.

A degraded or stale state must remain visible. The application must not present a last-known-good snapshot as live information.

## Restricted operational endpoints

Detailed metrics, manifests, events, decisions, and governance changes are restricted to an authorized administrator or local loopback access.

- `GET /api/platform/metrics`
- `GET /api/platform/metrics.prom`
- `GET /api/platform/manifest`
- `GET /api/platform/events`
- `GET /api/platform/decisions`
- `GET /api/platform/decisions/:id`
- `POST /api/platform/decisions/:id/outcomes`
- `GET /api/models/registry`
- model registration, promotion, rollback, and drift-observation writes

Do not expose restricted routes through an unprotected public reverse proxy.

## Data refresh

Every live source request uses a deadline, bounded retry count, exponential backoff, and attempt telemetry. Required ESPN player and schedule sources fail the refresh when unavailable. Sleeper and ESPN News are optional; their absence creates a degraded snapshot rather than fabricated values.

Each successful feed records source name, fetch time, attempts, elapsed time, payload hash, and lineage hash in `meta.provenance`. The control plane creates a content-addressed full dataset snapshot after startup and every successful refresh, retaining the newest 16 snapshots.

## Recommendation lineage

Every successful analytical POST response includes a `recommendation` object containing:

- decision ID and deterministic replay key;
- input, model, and data digests;
- model and engine versions;
- dataset freshness;
- paired random seed when applicable;
- confidence and warnings;
- optimization objective.

The decision ledger stores the envelope, a result digest, a compact result summary, and an immutable result snapshot. Later outcomes can be attached to the decision and used by the drift monitor.

## Championship evaluation

`POST /api/championship/evaluate` requires exact league state: rules, current week, standings, every roster, user team, and schedule. It evaluates the current roster and each legal candidate action with the same Monte Carlo seed.

Ranking order is:

1. championship probability;
2. championship-weighted utility after acquisition cost;
3. playoff probability;
4. all-play strength.

The response includes title and playoff deltas, expected wins and points, uncertainty, counterfactual reversal conditions, league-state completeness, and all assumptions. Missing or duplicate ownership is rejected before simulation.

## Model governance

A challenger cannot become production without:

- a named primary metric and direction;
- incumbent and challenger values;
- a minimum improvement threshold;
- a minimum sample size;
- an untouched holdout identifier;
- an explicit leakage-safe declaration.

Failed challengers are recorded as rejected. Successful promotions preserve the prior champion as a rollback target. Rollback is an explicit registry operation and does not require retraining.

The drift monitor accepts numeric and probability outcomes. It reports MAE, RMSE, bias, Brier score, calibration error, calibration bins, and p95 absolute error. Until the minimum sample count is reached, state remains `unknown` rather than manufacturing confidence.

## Artifact integrity

`data/artifact-manifest.json` contains the byte length and SHA-256 digest of the lockfile, package metadata, compact model/calibration inputs, model registry, and SBOM. Production should set `ORACLE_STRICT_ARTIFACT_INTEGRITY=true`. Under strict mode, a missing or changed artifact prevents startup.

Regenerate only after deliberate model or package changes:

```bash
npm run manifest:generate
npm run artifacts:validate
```

A changed manifest without the corresponding reviewed source/model change is a release blocker.

## Deployment doctor

Run the deployment doctor before starting or promoting an instance:

```bash
npm run doctor
NODE_ENV=production ORACLE_NATIVE_REQUIRED=true ORACLE_STRICT_ARTIFACT_INTEGRITY=true npm run doctor -- --strict
```

The report checks Node compatibility, production policy, Git cleanliness and upstream drift, artifact bytes, the complete native capability contract, native executable SHA-256 metadata, and writable runtime directories. A strict failure is a deployment blocker. Warnings remain visible in development mode rather than being silently converted into passes.

On Windows, the scheduled-task manager executes the strict doctor automatically before each start. `npm run service:windows:status` reports task state, validated process identity, readiness, port, repository root, and log locations. `npm run service:windows:smoke` then verifies strict readiness and the browser shell. Stop requests are graceful first and forced only after the bounded shutdown window; `npm run service:windows:test` exercises the complete isolated run/smoke/stop lifecycle.

## Incident priorities

### Required feed unavailable

Keep the last verified dataset visible as stale, stop automatic recommendations that depend on changed conditions, and retry within the provider's rate limits. Do not replace a missing injury or schedule value with a neutral value and label it live.

### Native engine unavailable

The JavaScript fallback may serve supported legacy tasks, but platform state is degraded. Championship evaluation should not be treated as production-ready until native league simulation returns.

### Artifact mismatch

Treat as unsafe. Compare the deployed commit with the manifest commit, inspect changed bytes, and either restore matching artifacts or regenerate the manifest through a reviewed release.

### Event-chain corruption

Stop every Oracle instance before touching the ledger. Preview deterministic recovery with:

```bash
npm run events:repair -- --dry-run
```

The repair command validates every event hash, reconstructs the longest chain connected to genesis, quarantines the original file, and writes a JSON report naming every discarded line. Run it without `--dry-run` only after reviewing that report. If no valid non-empty chain exists, restore the newest verified runtime package instead of forcing an empty ledger.

### Model drift

Disable automatic promotion. Compare recent outcome definitions with the original holdout, check data-distribution changes, and either recalibrate, roll back, or explicitly accept a new operating regime through a reviewed gate.

## Game-day operating cadence

- Refresh and verify data before the first actionable window.
- Confirm required feeds, live native workers, native binary integrity, artifact integrity, and backup state.
- Recalculate after material injury, inactive, weather, depth-chart, or transaction events.
- Use paired candidate actions instead of comparing independently simulated outputs.
- Record the selected action and later outcome.
- Preserve a late-swap contingency for every questionable starter.
- Stop using recommendations when league state or source freshness falls below the displayed confidence threshold.
