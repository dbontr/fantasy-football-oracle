# Fantasy Football Oracle v5 Architecture Overhaul

Status: implementation plan
Baseline: `6f62ca8206330212f0d179c08d7a8a695fda5933`
Branch: `architecture-v5`

## Goal

Turn Oracle from a snapshot-based projection application into a temporal, probabilistic decision platform. The v5 layer must preserve time-stamped evidence, reconcile conflicting sources, model decomposed uncertainty, simulate correlated futures, and choose actions that remain strong across risk preferences and plausible worlds.

## Design principles

1. Keep observations, reconciled beliefs, forecasts, scenarios, and decisions separate.
2. Support true as-of queries so later information cannot leak into earlier decisions.
3. Preserve source reliability, freshness, conflicts, expiry, and provenance.
4. Model availability mixtures and correlated game environments, not only Gaussian point ranges.
5. Prevent double counting with feature families and bounded contribution budgets.
6. Rank actions by expected utility, tail risk, regret, stability, and probability of being best.
7. Keep all stochastic results deterministic under a supplied seed.
8. Preserve the native C++ engine for high-volume combinatorial work.

## Implemented subsystems

### Temporal evidence ledger

- Append-only, hash-chained JSONL storage.
- Strict observation validation and deterministic deduplication.
- Entity, feature, source, effective-time, expiry, confidence, and reliability fields.
- Numeric and categorical conflict reconciliation.
- Freshness decay by feature-specific half-life.
- As-of resolution and temporary what-if overlays.
- Integrity verification and health/status reporting.

### Probabilistic forecast engine

- Weekly player distributions built from the existing modeled baseline.
- Explicit active/inactive mixture distributions.
- Evidence-aware market, role, health, environment, matchup, line, tracking, and news effects.
- Family-level caps to reduce correlated-feature double counting.
- Aleatoric, epistemic, availability, and evidence-conflict uncertainty decomposition.
- Quantiles, downside probability, ceiling probability, confidence, and explanations.

### Correlated scenario engine

- Seeded deterministic scenario generation.
- Game, team, weather, pace, and player latent factors.
- Same-team and opponent correlation without forcing identical outcomes.
- Availability sampling before active-performance sampling.
- Lineup and portfolio outcome distributions with mean, p10/p50/p90, CVaR, target probability, and regret.

### Robust decision engine

- Expected utility plus lower-tail protection.
- Probability each action is best under paired scenarios.
- Expected and maximum regret.
- Risk-aversion sensitivity and recommendation stability.
- Pareto frontier across mean, floor, upside, and regret.
- Value-of-information ranking for unresolved evidence features.

### Product integration

- New v5 APIs for status, evidence, forecasts, what-if analysis, and portfolio evaluation.
- Control-plane metrics, health, decision lineage, and runtime cleanup.
- Research Lab browser surface for player distributions and lineup portfolios.
- Updated model blueprint, schema registry, deployment docs, and verification.

## Acceptance criteria

- Evidence replay produces the same resolved belief and chain head.
- Later observations never appear in earlier as-of queries.
- Expired observations do not affect current forecasts.
- Conflicting evidence increases epistemic uncertainty instead of silently selecting one source.
- Temporary what-if evidence never mutates persisted evidence.
- Forecasts remain finite, non-negative, ordered by quantile, and reproducible.
- Same-game player outcomes exhibit stronger correlation than unrelated players.
- Robust rankings remain deterministic and expose reversals across risk profiles.
- Administrative evidence writes require existing Oracle authorization.
- All new endpoints are schema bounded and rate limited.
- Full source, native, test, artifact, recovery, strict-smoke, and Windows-service verification pass.

## Explicit limits

The architecture can accept route, tracking, betting, weather, medical, and offensive-line evidence, but this implementation does not fabricate or redistribute licensed feeds. Forecast quality remains conditional on the evidence supplied. The v5 layer reports missing families and source conflict rather than converting absence into false precision.
