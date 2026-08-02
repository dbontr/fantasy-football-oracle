# Probabilistic Intelligence 5.0

Oracle 5.0 separates five objects that projection systems often collapse: observations, reconciled evidence, player forecasts, correlated scenarios, and decisions.

## Evidence

Every durable observation has an entity, feature, value, source, reliability, confidence, observed time, effective time, optional expiry, and content hash. The JSONL ledger is append-only and hash chained. As-of queries exclude observations that were not yet known, preventing later news from leaking into historical decisions.

Numeric observations are weighted by source reliability, observation confidence, and feature-specific freshness. Disagreement becomes a conflict score and increases epistemic uncertainty. Categorical observations produce a weighted distribution and normalized entropy rather than an arbitrary winning source.

## Forecasts

Player forecasts are zero-inflated distributions. Availability determines the probability mass at zero; active performance has its own mean and variance. The response exposes quantiles, CVaR, bust and ceiling probabilities, evidence coverage, source conflict, bounded family contributions, and separate aleatoric, epistemic, availability, and recurrence components.

Feature families are capped before they affect the mean. This reduces double counting when several observations describe the same role or market signal.

## Scenarios and decisions

The scenario engine draws game, team, position, availability, and player factors from deterministic keyed random streams. Candidate lineups are evaluated in the same worlds, which makes probability-of-best and regret comparisons paired instead of noisy independent estimates.

Robust ranking combines expected performance, lower-tail CVaR, paired regret, and probability of being best. The response also reports risk-policy sensitivity, Pareto-optimal actions, reversal thresholds, and the next evidence family most likely to change the decision.

## Access model

Public forecast and what-if routes cannot persist evidence. Durable ingestion and raw evidence search require administrator authorization. Resolved player evidence is public because it contains bounded reconciled values and provenance summaries, not credentials or raw connector payloads.

## Limits

Oracle ships the evidence contracts and model effects, not licensed data. Connected market, tracking, offensive-line, route, and weather feeds remain deployment responsibilities. Correlation loadings are transparent engineering priors, not learned causal relationships or a calibrated play-level copula.
