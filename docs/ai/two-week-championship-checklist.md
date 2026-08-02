# Two-Week Championship and Disaster-Proofing Checklist

Status: proposed 14-day execution plan
Target effort: roughly 250-320 focused engineering hours, with parallel agents where practical
Primary objective: maximize championship equity while eliminating every avoidable single point of failure

No software can make losing mathematically impossible or guarantee a fantasy championship. This checklist is designed to make project loss extremely unlikely, force recoverability to be demonstrated, and materially increase the probability of winning through better data, models, timing, and league-specific decisions.

## Rules for completing this checklist

- [ ] Treat every unchecked P0 item as release-blocking.
- [ ] Do not mark an item complete until its acceptance test passes.
- [ ] Save evidence for every test under `artifacts/verification/<date>/` or CI artifacts.
- [ ] Use versioned data, deterministic seeds, and recorded configuration for every benchmark.
- [ ] Never replace an existing champion model without an untouched holdout win.
- [ ] Preserve reported facts, inferred features, model estimates, and final decisions as separate fields.
- [ ] Commit in small reversible increments; do not push broken main-branch states.
- [ ] Record limitations rather than inventing precision where a feed is incomplete.
- [ ] Optimize championship probability, not only projected points or regular-season wins.
- [ ] Run a restoration drill before declaring the project disaster-proof.

## Absolute completion gates

- [ ] P0: Three independent current copies exist: primary Git remote, secondary remote, and encrypted offline/offsite backup.
- [ ] P0: At least one copy is immutable or version-locked against accidental deletion and ransomware.
- [ ] P0: A blank Windows or Linux machine can rebuild and run the complete application from documented commands.
- [ ] P0: Code, compact model artifacts, schemas, configuration templates, and deployment definitions are all recoverable.
- [ ] P0: Raw historical data that is intentionally excluded from Git is backed up separately with checksums and provenance.
- [ ] P0: A full restore from each backup class has been timed and verified, not merely configured.
- [ ] P0: Every production recommendation can report model version, data timestamp, source confidence, and important drivers.
- [ ] P0: Every decision surface uses league rules, current roster needs, playoff structure, and opponent context.
- [ ] P0: Draft, waiver, trade, lineup, and season policies all have walk-forward or untouched-holdout evidence.
- [ ] P0: CI, security audit, native build, browser tests, mobile tests, load tests, and disaster-recovery tests all pass.

## Day 1 - Inventory, threat model, and preservation baseline

### Morning: identify everything that can be lost

- [ ] P0: Inventory every repository, branch, worktree, local-only commit, tag, release, deployment, and runtime directory.
- [ ] P0: Enumerate every essential non-Git asset: historical raw data, generated calibration files, credentials, screenshots, exports, league imports, and decision logs.
- [ ] P0: Produce a machine-readable asset manifest with path, owner, size, checksum, source, rebuild command, and backup policy.
- [ ] P0: Search all machines for alternate or forgotten copies of the project and reconcile divergent histories.
- [ ] P0: Confirm all eight local commits ahead of `origin/main` are represented in the preservation plan.
- [ ] P0: Document loss scenarios: PC failure, disk corruption, accidental delete, bad force-push, GitHub lockout, ransomware, cloud outage, compromised token, and upstream feed disappearance.
- [ ] P0: Assign recovery-point objective and recovery-time objective to code, models, raw data, deployment state, and league state.
- [ ] P1: Classify each asset by confidentiality, replaceability, legal restrictions, and competitive value.

### Afternoon: establish clean source-of-truth boundaries

- [ ] P0: Verify `main` is clean and all essential work is committed before backup automation starts.
- [ ] P0: Tag the current validated baseline with a signed or annotated release tag.
- [ ] P0: Generate `MANIFEST.sha256` for committed model artifacts and deployment-critical files.
- [ ] P0: Define which data must remain out of Git and where its authoritative backup lives.
- [ ] P0: Add a repository recovery document listing remotes, branches, tags, artifacts, and reconstruction order.
- [ ] P1: Add an architecture decision record for data retention and model-artifact versioning.
- [ ] P1: Record current test count, native engine version, model versions, data coverage, and benchmark timings.

### Night: baseline tests and exit gate

- [ ] Run `npm ci --ignore-scripts`, `npm run verify`, native benchmark, and browser smoke tests from the clean baseline.
- [ ] Export the complete Git bundle, including all refs, and verify it with `git bundle verify`.
- [ ] Copy the bundle and asset manifest to a second physical machine.
- [ ] Confirm no essential untracked file exists outside the manifest.
- [ ] Day 1 gate: another machine can inspect the bundle and list every branch, tag, and commit without accessing Jupiter.

## Day 2 - 3-2-1 backups, immutable recovery, and restore automation

### Morning: create independent copies

- [ ] P0: Add a second Git remote under a separate provider or account and mirror all branches, tags, notes, and release refs.
- [ ] P0: Create an encrypted offline backup containing the Git bundle, raw-data archive, calibration artifacts, configuration templates, and recovery instructions.
- [ ] P0: Store one encrypted copy offsite or in independently authenticated object storage.
- [ ] P0: Enable object versioning, retention, and deletion protection for the offsite backup.
- [ ] P0: Ensure backup credentials are not stored on the same machine or account as the primary repository.
- [ ] P0: Back up the GitHub repository settings, branch rules, environments, actions configuration, and release metadata.
- [ ] P1: Mirror release artifacts and model manifests separately from the source repository.

### Afternoon: automate and verify

- [ ] P0: Add a scheduled backup script that creates a fresh Git bundle and data archive, encrypts them, computes checksums, and uploads them.
- [ ] P0: Make backup jobs fail loudly on partial copies, zero-byte files, checksum mismatch, or expired credentials.
- [ ] P0: Add retention tiers: daily, weekly, monthly, and pre-release snapshots.
- [ ] P0: Add an automatic restore-test job that clones or unpacks into a temporary directory and runs integrity checks.
- [ ] P0: Generate a backup status report with last success, age, bytes, refs, checksums, and restore-test result.
- [ ] P1: Alert through at least two independent channels when the recovery-point objective is violated.
- [ ] P1: Add a manual one-command emergency snapshot before risky migrations or model rebuilds.

### Night: destructive restore drill

- [ ] P0: Restore the repository from the primary remote onto a blank directory and run the application.
- [ ] P0: Restore from the secondary remote with the primary remote unavailable.
- [ ] P0: Restore from the encrypted offline bundle with both remotes treated as unavailable.
- [ ] P0: Restore raw historical data and verify every checksum in the asset manifest.
- [ ] P0: Rebuild compact opportunity, health, and historical calibration artifacts from restored raw inputs.
- [ ] P0: Measure total recovery time and record every undocumented dependency encountered.
- [ ] Day 2 gate: deletion of Jupiter and loss of the primary Git account would not destroy the code, models, data, or runbooks.

## Day 3 - Reproducible data and model lineage

### Morning: provenance and schemas

- [ ] P0: Define explicit schemas for player, team, schedule, injury, news, participation, market, league, roster, and transaction records.
- [ ] P0: Validate every ingested payload before it enters the projection ensemble.
- [ ] P0: Add source name, fetched time, source event time, player identifier, confidence, and license/usage note to every record.
- [ ] P0: Create a canonical crosswalk for ESPN, Sleeper, GSIS, team, and normalized player identifiers.
- [ ] P0: Detect duplicate, recycled, renamed, traded, retired, and ambiguous player records.
- [ ] P0: Persist raw payload hashes so a modeled result can be traced to the exact source snapshot.
- [ ] P1: Version schemas and implement forward/backward compatibility tests.

### Afternoon: deterministic rebuilds

- [ ] P0: Pin runtime, compiler, package, and build-tool versions.
- [ ] P0: Ensure every model builder records code commit, configuration, feature list, train seasons, holdout seasons, and random seeds.
- [ ] P0: Make generated artifacts deterministic apart from an explicitly excluded timestamp field.
- [ ] P0: Add artifact checksums and reject mismatched model/code combinations at startup.
- [ ] P0: Add data-quality reports for missingness, stale records, impossible values, duplicate IDs, and sudden coverage changes.
- [ ] P1: Build a local snapshot catalog that can reproduce any historical recommendation.
- [ ] P1: Add dataset-diff reports showing additions, removals, status changes, and major projection movement.

### Night: reproducibility gates

- [ ] Rebuild every compact artifact twice from identical inputs and prove byte or semantic parity.
- [ ] Reproduce one draft, trade, waiver, lineup, and season recommendation from archived inputs and seed.
- [ ] Simulate a corrupted artifact and verify startup fails safely with an actionable error.
- [ ] Simulate a missing optional feed and verify the system degrades without fabricating data.
- [ ] Day 3 gate: any important recommendation can be reproduced from a commit, input snapshot, configuration, and seed.

## Day 4 - Production reliability, observability, and graceful degradation

### Morning: service-level objectives

- [ ] P0: Define availability, freshness, latency, queue, native-worker, and data-coverage service-level objectives.
- [ ] P0: Expose structured health for every feed, model artifact, worker pool, cache, scheduler, and external integration.
- [ ] P0: Add metrics for refresh success, source age, player coverage, injury/news coverage, model version, queue depth, task latency, and failure rate.
- [ ] P0: Record recommendation latency separately for draft, lineup, waiver, trade, roster, season, and league simulation.
- [ ] P0: Add stale-data banners and confidence reductions rather than silently using old inputs.
- [ ] P1: Add percentile latency and memory/CPU telemetry for native and JavaScript paths.
- [ ] P1: Track recommendation changes caused by each refresh.

### Afternoon: resilience engineering

- [ ] P0: Add retries with jitter and strict timeouts for every external feed.
- [ ] P0: Add circuit breakers so a failing provider cannot stall all analysis.
- [ ] P0: Keep last-known-good snapshots for each feed and model artifact.
- [ ] P0: Verify JavaScript fallback produces bounded, labeled results when native workers fail.
- [ ] P0: Isolate malformed players or articles instead of rejecting the entire refresh.
- [ ] P0: Prevent overlapping refreshes and model rebuilds from corrupting runtime state.
- [ ] P1: Add rate-limit awareness and backoff for ESPN, Sleeper, news, weather, and market sources.
- [ ] P1: Add a read-only emergency mode for game-day operation during upstream outages.

### Night: chaos testing

- [ ] Kill native workers during draft, waiver, and trade requests and verify automatic recovery.
- [ ] Block each external provider independently and verify truthful degraded-mode behavior.
- [ ] Corrupt the runtime cache and verify fallback to the bundled snapshot.
- [ ] Fill queues to their limit and verify bounded rejection instead of memory growth.
- [ ] Restart the server during an active refresh and verify atomic state recovery.
- [ ] Day 4 gate: no single provider, worker, cache, or refresh failure can make the application unusable or silently wrong.

## Day 5 - Security, supply chain, and account-loss protection

### Morning: credentials and repository controls

- [ ] P0: Remove every secret from source, history, logs, screenshots, CI artifacts, and local documentation.
- [ ] P0: Rotate any credential that may have appeared in a shell history, chat, screenshot, or temporary file.
- [ ] P0: Store production secrets in a password manager or cloud secret store with recovery codes held separately.
- [ ] P0: Enable strong MFA and independent recovery methods on GitHub, backup storage, deployment provider, and email accounts.
- [ ] P0: Require protected branches, reviewed pull requests, passing CI, and blocked force-pushes for the protected remote.
- [ ] P0: Restrict deployment credentials to the minimum scope and separate read, backup, and deploy identities.
- [ ] P1: Add CODEOWNERS for security, model artifacts, deployment, and native engine paths.

### Afternoon: dependency and build integrity

- [ ] P0: Add dependency vulnerability, secret, license, and malicious-package scanning to CI.
- [ ] P0: Generate an SBOM for Node dependencies, native dependencies, vendored code, and deployment image.
- [ ] P0: Pin actions and build images to trusted versions or immutable digests.
- [ ] P0: Sign or checksum release artifacts and verify them before startup or deployment.
- [ ] P0: Make production builds originate from a clean checkout, not an untracked developer directory.
- [ ] P0: Validate all API inputs, cap payload sizes, rate-limit expensive routes, and protect administrative refresh routes.
- [ ] P1: Add static analysis and compiler hardening flags for the C++ engine.
- [ ] P1: Add dependency-update automation that cannot merge without the full verification suite.

### Night: compromise and lockout drills

- [ ] Simulate loss of the primary GitHub account and prove secondary remote plus backup credentials remain accessible.
- [ ] Simulate a leaked deployment token and document revocation and replacement time.
- [ ] Scan the complete Git history and staged content for high-entropy secrets and provider key patterns.
- [ ] Verify no raw private league export is exposed through static serving or deployment packaging.
- [ ] Verify backups are encrypted at rest and cannot be deleted by the normal application identity.
- [ ] Day 5 gate: compromise or lockout of one account cannot destroy backups, source, or deployment recovery capability.

## Day 6 - Redundant live data and event intelligence

### Morning: feed coverage

- [ ] P0: Add at least two independent sources for player status, roster status, and injury designation where legally and technically possible.
- [ ] P0: Ingest official transactions, injured-reserve/PUP/NFI moves, activations, suspensions, releases, signings, and trades.
- [ ] P0: Ingest official practice participation with report date, game week, body part, and progression across the week.
- [ ] P0: Add depth-chart snapshots and detect movement in order, role, and roster status.
- [ ] P0: Add player participation features: snaps, routes, pass blocks, carries, targets, red-zone work, and two-minute usage.
- [ ] P0: Add schedule, kickoff, venue, surface, travel, rest, and bye information with source timestamps.
- [ ] P1: Add consensus market signals such as ADP, roster percentage, start percentage, adds/drops, and auction movement.
- [ ] P1: Add weather and betting inputs behind source adapters so the engine remains functional without them.

### Afternoon: event normalization

- [ ] P0: Convert raw updates into typed events: availability, recovery, role gain, role loss, transaction, suspension, depth movement, and game-environment change.
- [ ] P0: Deduplicate syndicated or repeated articles and preserve the earliest and latest confirmation times.
- [ ] P0: Require player-focused attribution before news changes a projection.
- [ ] P0: Add event severity, freshness decay, source reliability, corroboration count, and contradiction handling.
- [ ] P0: Resolve conflicting status reports conservatively and show the conflict to the user.
- [ ] P0: Distinguish absence from injury, suspension, contract dispute, personal matter, and coach decision.
- [ ] P1: Add team-level events for offensive-line injuries, quarterback changes, coordinator changes, and pace tendencies.

### Night: feed replay and latency tests

- [ ] Replay a full historical game week of status, practice, transaction, and news events in chronological order.
- [ ] Verify no future report influences an earlier recommendation.
- [ ] Measure event-to-model latency and event-to-user latency.
- [ ] Verify repeated articles do not multiply the same effect.
- [ ] Verify contradictory reports widen uncertainty rather than selecting the most optimistic source.
- [ ] Day 6 gate: every live decision is based on timestamped, attributable events with a truthful fallback when data is missing.

## Day 7 - Projection distributions, correlations, and calibration

### Morning: richer player models

- [ ] P0: Model floor, median, ceiling, availability, snap share, route share, target share, rush share, touchdown opportunity, and efficiency separately.
- [ ] P0: Add position-specific hierarchical models that shrink small samples toward player, team, position, and league priors.
- [ ] P0: Represent rookies, team changes, coaching changes, quarterback changes, and role transitions explicitly.
- [ ] P0: Add expected-fantasy-point opportunity so touchdowns and explosive plays are separated from repeatable role.
- [ ] P0: Model early-down, passing-down, two-minute, goal-line, and red-zone roles independently.
- [ ] P0: Add offensive-line and quarterback-environment uncertainty to relevant positions.
- [ ] P1: Build ensemble adapters for multiple independent projection sources without double counting shared inputs.

### Afternoon: dependence and uncertainty

- [ ] P0: Estimate same-team QB-receiver, backfield, receiver-room, kicker-offense, and defense-game-script correlations.
- [ ] P0: Estimate opponent-game correlations created by pace, shootouts, weather, and scoring environment.
- [ ] P0: Model injury replacement and teammate redistribution rather than only reducing the injured player's projection.
- [ ] P0: Widen distributions when news, practice, role, source, or model evidence conflicts.
- [ ] P0: Calibrate availability, floor, median, ceiling, and tail probabilities separately.
- [ ] P0: Add prediction intervals and proper scoring rules, not only RMSE and correlation.
- [ ] P1: Add quantile or distributional champion-challenger models by position.

### Night: holdout gates

- [ ] Run season-held-out and week-held-out tests with strict time cutoffs.
- [ ] Compare against market consensus, prior-season carry-forward, source projection, and current Oracle champion.
- [ ] Reject any model that improves mean error but materially worsens tails, calibration, availability, or championship utility.
- [ ] Plot calibration curves for start probability, top-12/top-24 finishes, busts, breakouts, and return-to-level estimates.
- [ ] Verify all league-wide mean adjustments remain centered unless an external league-total signal justifies movement.
- [ ] Day 7 gate: projections are calibrated distributions with explicit correlations and demonstrated out-of-sample value.

## Day 8 - Advanced health, return-to-play, and contingency modeling

### Morning: historical health depth

- [ ] P0: Build player-level injury histories by body part, side, severity, recurrence, surgery, missed games, and prior return outcome.
- [ ] P0: Separate report recurrence from confirmed reinjury and expose both labels clearly.
- [ ] P0: Add injury-family, position, age, experience, workload, and surgery interactions with partial pooling.
- [ ] P0: Model preseason, in-season, reserve, return-designated, and post-activation states separately.
- [ ] P0: Estimate return-week availability, active-game snap share, first-game efficiency, four-game ramp, and long-term restoration independently.
- [ ] P0: Add practice progression sequences rather than using only the latest participation field.
- [ ] P1: Add prior workload spikes, short rest, surface, and repeated soft-tissue history as uncertainty features.

### Afternoon: teammate and roster consequences

- [ ] P0: Redistribute vacated targets, carries, routes, red-zone work, and snaps to plausible teammates with uncertainty.
- [ ] P0: Model the returning player's effect on every teammate, not only his own projection.
- [ ] P0: Create handcuff and contingency value based on conditional role, schedule, roster construction, and replacement availability.
- [ ] P0: Calculate expected roster value under healthy, limited, inactive, and setback branches.
- [ ] P0: Make draft and trade prices reflect roster capacity to absorb delayed return.
- [ ] P0: Make waiver recommendations consider short-term replacement and long-term stash value separately.
- [ ] P1: Add explicit late-swap contingency trees for questionable players in later games.

### Night: health validation

- [ ] Backtest availability probabilities by designation and practice progression on untouched weeks.
- [ ] Backtest first-game and four-game return distributions by injury family and position.
- [ ] Check calibration for major injuries separately from minor weekly designations.
- [ ] Verify long-term estimates never masquerade as medical clearance or guaranteed recovery.
- [ ] Simulate loss of a first-round player and confirm the engine proposes the best contingency path across waivers, trade, and lineup.
- [ ] Day 8 gate: injury intelligence measures availability, ramp, recurrence, teammate redistribution, and roster resilience without false certainty.

## Day 9 - League-specific championship-equity engine

### Morning: exact league state

- [ ] P0: Import scoring, roster slots, flex rules, superflex, premium positions, bonuses, deductions, roster limits, IR, taxi, keeper, and auction rules exactly.
- [ ] P0: Import every roster, matchup, record, points-for, tiebreaker, waiver order, FAAB balance, transaction limit, trade deadline, and playoff rule.
- [ ] P0: Reconstruct the exact remaining schedule and playoff bracket logic.
- [ ] P0: Model replacement level from players actually available in the league, not generic public ownership.
- [ ] P0: Track each opponent's positional depth, injury exposure, bye conflicts, tendencies, and likely needs.
- [ ] P0: Detect league-specific scarcity, hoarding, streaming behavior, and trade-market distortions.
- [ ] P1: Add keeper cost, future pick, dynasty age curve, or contract support behind optional rulesets.

### Afternoon: utility and strategy state

- [ ] P0: Optimize expected championship probability as the primary objective.
- [ ] P0: Also report expected wins, playoff probability, bye probability, seed distribution, all-play strength, downside risk, and future optionality.
- [ ] P0: Change risk tolerance dynamically based on standings, remaining schedule, opponent strength, and playoff security.
- [ ] P0: Prefer floor when protecting a strong favorite and ceiling/leverage when an underdog needs variance.
- [ ] P0: Price bench depth by expected future start probability, injury contingency, bye coverage, and denial value.
- [ ] P0: Price roster spots as scarce assets and penalize low-utility cloggers.
- [ ] P0: Model correlation and leverage against the weekly opponent and likely playoff opponents.
- [ ] P1: Add scenario planning for must-win weeks, clinched berths, playoff byes, and eliminated opponents selling assets.

### Night: league-state verification

- [ ] Compare imported league state against the platform screen and resolve every discrepancy.
- [ ] Verify scoring with known historical box scores and platform totals.
- [ ] Verify playoff seeds and tiebreakers against synthetic edge cases.
- [ ] Verify every recommended add, drop, trade, or lineup is legal under the imported rules.
- [ ] Run the same roster under multiple league formats and confirm recommendations change appropriately.
- [ ] Day 9 gate: the engine optimizes this league and this team, not a generic 12-team PPR abstraction.

## Day 10 - Draft-room domination

### Morning: opponent and board modeling

- [ ] P0: Learn opponent drafting tendencies from league history when available: reaches, stacks, favorite teams, position timing, and risk preference.
- [ ] P0: Blend public ADP with platform ADP, room behavior, current picks, positional runs, and roster needs.
- [ ] P0: Simulate every opponent pick with team-specific demand rather than identical market agents.
- [ ] P0: Model player survival probability to every future user pick and distinguish market fallers from model fallers.
- [ ] P0: Calculate VONA, tier-cliff cost, replacement decay, roster utility, playoff utility, and correlated stack value.
- [ ] P0: Include injury contingencies, handcuff cost, bye concentration, weekly ceiling, and roster fragility.
- [ ] P1: Support snake, third-round reversal, auction, keeper, traded picks, and unusual roster formats.

### Afternoon: policy search

- [ ] P0: Search complete draft strategies, not only the next pick, across many paired simulations.
- [ ] P0: Compare robust, balanced, fragile-ceiling, zero-RB, hero-RB, elite-QB, late-QB, and tight-end-premium paths where relevant.
- [ ] P0: Optimize the value of the next several selections conditional on likely room behavior.
- [ ] P0: Add contingency recommendations for the top five plausible picks before the user's turn.
- [ ] P0: Detect when a positional run is real, likely to continue, or already exhausted.
- [ ] P0: Price roster construction against actual waiver replacement and trade liquidity.
- [ ] P1: Add an interactive what-if mode for choosing one player and seeing future path consequences.

### Night: historical and adversarial draft tests

- [ ] Expand historical mock drafts to more seasons, platforms, league formats, and realistic opponent policies.
- [ ] Hold out the newest season and league configurations during policy selection.
- [ ] Test every draft slot, randomized rooms, extreme runs, injury news, and missing data.
- [ ] Compare championship equity, playoff rate, managed points, regret, and robustness rather than only final roster projection.
- [ ] Reject strategies that win on average by creating unacceptable catastrophic tails.
- [ ] Day 10 gate: draft recommendations maximize full-roster championship value and include a tested contingency for every likely board state.

## Day 11 - Waivers, trades, start/sit, and weekly exploitation

### Morning: waiver and FAAB policy

- [ ] P0: Forecast every candidate's rest-of-season, next-four-week, playoff, contingency, and denial value.
- [ ] P0: Model drop cost, roster-space opportunity cost, replacement availability, bye coverage, and future start probability.
- [ ] P0: Estimate opponent demand and bid distributions from league history, budget, roster need, and recent behavior.
- [ ] P0: Optimize FAAB as a season-long portfolio rather than an isolated weekly bid.
- [ ] P0: Separate immediate starter, injury replacement, upside stash, handcuff, streaming, and blocker recommendations.
- [ ] P0: Model waiver priority, conditional claims, free-agent timing, and platform transaction rules exactly.
- [ ] P1: Add recommended claim chains that remain valid if earlier claims fail.

### Afternoon: trade market and acceptance

- [ ] P0: Generate deals that improve championship equity after both teams re-optimize their lineups and benches.
- [ ] P0: Model the other manager's roster need, risk tolerance, standings, attachment bias, trade history, and likely acceptance range.
- [ ] P0: Search multi-player, pick, keeper, and consolidation packages without hiding opponent benefit.
- [ ] P0: Estimate acceptance probability separately from value and fairness.
- [ ] P0: Identify sell-high, buy-low, injury-discount, schedule, depth, and playoff-leverage opportunities.
- [ ] P0: Reject trades that improve mean projection but increase unacceptable downside or leave no injury resilience.
- [ ] P1: Generate negotiation ladders: opening offer, fair midpoint, walk-away point, and fallback target.

### Night: lineup and late-swap policy

- [ ] P0: Optimize lineups using full distributions, opponent context, correlations, weather, availability, and late-game flexibility.
- [ ] P0: Preserve flex and superflex optionality by kickoff order.
- [ ] P0: Build contingency trees for questionable players, inactive announcements, and unexpected snap limits.
- [ ] P0: Calculate expected regret for every legal bench alternative and identify decisions requiring manual monitoring.
- [ ] P0: Change floor/ceiling preference based on live matchup score and remaining players.
- [ ] P1: Add automated reminders before injury-report deadlines, waiver lock, trade deadline, early games, and late-swap windows.
- [ ] Day 11 gate: the engine can produce an executable weekly plan with claims, bids, trade targets, lineup, and contingency branches.

## Day 12 - Backtesting, policy evaluation, and champion-challenger governance

### Morning: historical replay expansion

- [ ] P0: Archive timestamped preseason, weekly, injury, practice, transaction, market, roster, and outcome snapshots where available.
- [ ] P0: Enforce event-time cutoffs so no future information enters a historical decision.
- [ ] P0: Replay complete seasons with weekly waiver, trade, lineup, and roster decisions rather than isolated examples.
- [ ] P0: Evaluate multiple league formats, draft slots, playoff structures, and manager behaviors.
- [ ] P0: Include transaction availability and opponent actions so backtests do not assume every player remains obtainable.
- [ ] P0: Use paired seeds and identical scenarios when comparing policies.
- [ ] P1: Add bootstrap confidence intervals and practical-significance thresholds to reported improvements.

### Afternoon: decision-quality scorecard

- [ ] P0: Score draft policies by championship rate, playoff rate, bye rate, regret, tail loss, and robustness.
- [ ] P0: Score waiver policies by actual replacement gain, future starts, FAAB efficiency, and missed-opportunity cost.
- [ ] P0: Score trade policies by post-trade roster utility, realized points, championship delta, fairness, and acceptance probability.
- [ ] P0: Score lineup policies by expected regret, calibration, win probability, and opponent-adjusted decision quality.
- [ ] P0: Score health models by Brier score, log loss, return-week error, snap-ramp error, and return-to-level calibration.
- [ ] P0: Score probability outputs with proper scoring rules and reliability diagrams.
- [ ] P1: Segment every metric by position, season phase, injury state, role state, and confidence bucket.

### Night: model governance

- [ ] P0: Create a champion-challenger registry with owner, version, training window, holdout, metrics, and deployment state.
- [ ] P0: Block automatic promotion unless the challenger passes predefined mean, tail, calibration, and latency gates.
- [ ] P0: Add rollback metadata and retain the prior champion artifact.
- [ ] P0: Add drift alarms for data coverage, feature distributions, calibration, and decision outcomes.
- [ ] P0: Publish a concise model card for every production subsystem.
- [ ] Day 12 gate: every production policy has reproducible evidence, an untouched comparison, and an immediate rollback path.

## Day 13 - Decision UX, automation, and game-day operations

### Morning: actionable explanations

- [ ] P0: Every recommendation must state the action, expected championship-equity change, confidence, timing, and alternative.
- [ ] P0: Show reported facts separately from inferred features and modeled conclusions.
- [ ] P0: Show the top positive and negative drivers without overwhelming the user with every feature.
- [ ] P0: Explain what new information would reverse the recommendation.
- [ ] P0: Show roster need, replacement level, downside, upside, and opportunity cost on draft, waiver, and trade screens.
- [ ] P0: Label stale, degraded, low-confidence, or proxy-driven results prominently.
- [ ] P1: Add comparison views for two players, two trades, and two complete strategy paths.

### Afternoon: operational automation

- [ ] P0: Create a daily team brief covering injuries, news, practice, waivers, trades, standings, and upcoming decisions.
- [ ] P0: Create high-priority alerts only for recommendation-changing events.
- [ ] P0: Add deadline-aware alerts for waivers, bids, trade windows, early games, inactive lists, and late swaps.
- [ ] P0: Cache precomputed contingency recommendations so game-day actions do not depend on a last-second full simulation.
- [ ] P0: Add a one-click refresh-and-reanalyze workflow with source ages and change summary.
- [ ] P0: Add export/import for full league state, model state, preferences, and decision history.
- [ ] P1: Add a read-only mobile emergency view optimized for last-minute lineup actions.

### Night: usability and accessibility tests

- [ ] Test desktop, tablet, and 390px mobile without overflow or hidden critical controls.
- [ ] Test keyboard navigation, readable labels, focus behavior, and screen-reader landmarks.
- [ ] Test slow networks, offline PWA mode, stale cache, server restart, and fallback engine.
- [ ] Test a live-style sequence from injury alert to projection change to lineup contingency.
- [ ] Require user confirmation for destructive imports, roster replacement, and irreversible platform actions.
- [ ] Day 13 gate: every important decision is understandable, timely, executable, and available during a degraded game-day scenario.

## Day 14 - Red-team championship rehearsal and final release gate

### Morning: catastrophic-loss red team

- [ ] P0: Pretend Jupiter is permanently destroyed and restore everything on another machine.
- [ ] P0: Pretend GitHub is unavailable and restore from the secondary remote.
- [ ] P0: Pretend both Git providers are unavailable and restore from encrypted immutable backup.
- [ ] P0: Pretend the latest backup is corrupted and restore from the preceding retention tier.
- [ ] P0: Pretend the deployment provider is lost and recreate the application from infrastructure and deployment documentation.
- [ ] P0: Pretend an essential upstream feed disappears and demonstrate the fallback, confidence reduction, and replacement path.
- [ ] P0: Confirm recovery credentials and instructions are accessible without the failed device or primary account.

### Afternoon: championship rehearsal

- [ ] P0: Run a complete draft from every slot with randomized opponent strategies and live-style news interruptions.
- [ ] P0: Run a full synthetic season including injuries, waiver competition, trades, byes, weather, and playoff qualification.
- [ ] P0: Run an underdog scenario, favorite scenario, must-win scenario, and playoff-bye scenario.
- [ ] P0: Verify the engine changes risk, correlation, and acquisition strategy appropriately in each state.
- [ ] P0: Rehearse a Sunday inactive surprise and execute the cached late-swap contingency.
- [ ] P0: Rehearse losing the top player and verify the combined waiver/trade/lineup response.
- [ ] P0: Rehearse a misleading news article and verify it remains visible but does not alter projections without attribution.

### Night: release decision

- [ ] P0: Run clean install, syntax checks, native build, full tests, dependency audit, secret scan, SBOM, browser suite, mobile suite, load tests, and backup restore test.
- [ ] P0: Confirm all P0 items are complete or formally accepted as residual risk.
- [ ] P0: Confirm model artifacts match the release commit and checksums.
- [ ] P0: Confirm raw data remains excluded from public deployment while backed up independently.
- [ ] P0: Create a signed release, release notes, rollback instructions, model cards, and recovery snapshot.
- [ ] P0: Record final readiness score, unresolved limitations, and the exact next scheduled review date.
- [ ] Day 14 gate: the release survives a destructive recovery drill and produces a complete championship-oriented plan under adversarial league scenarios.

## Final championship-readiness scorecard

Mark the sprint complete only when every row has current evidence.

| Area | Required evidence | Pass threshold |
|---|---|---|
| Disaster recovery | Three copy classes and destructive restore logs | All restores pass within the documented RTO |
| Source integrity | Signed/tagged commit, manifests, checksums, clean build | No unexplained or essential untracked assets |
| Data freshness | Feed health, event timestamps, stale-data behavior | No silent stale or missing critical source |
| Projection quality | Walk-forward metrics and untouched holdout | Champion is not worse on calibrated tails or utility |
| Health intelligence | Availability, ramp, recurrence, and return calibration | Proper scores beat designation-only baseline |
| Draft policy | Paired historical and adversarial simulations | Higher holdout championship equity with bounded tail risk |
| Waiver policy | Availability-aware historical replay | Positive holdout gain and disciplined FAAB usage |
| Trade policy | Bilateral utility and acceptance evaluation | Positive expected team utility without hidden opponent harm |
| Lineup policy | Expected-regret and win-probability replay | Lower regret than projection-only baseline |
| League specificity | Rules and state reconciliation | Exact platform totals, legality, and playoff logic |
| Reliability | Chaos, load, fallback, and restart evidence | No single component causes silent failure |
| Security | Secret scan, SBOM, protected identities, immutable backup | No known high-severity issue or shared failure domain |
| UX | Desktop/mobile/PWA/game-day rehearsal | Critical action remains accessible under degraded conditions |
| Governance | Model registry, rollback, drift, model cards | Every production model has owner and prior champion |

## Priority order when schedule pressure appears

- [ ] Never cut backups, restoration drills, source manifests, or account-loss protection.
- [ ] Never cut exact league rules, roster state, legal-action validation, or recommendation timestamps.
- [ ] Never cut leakage controls, untouched holdouts, calibration, or rollback capability.
- [ ] Never cut game-day injury, inactive, waiver, and late-swap contingency handling.
- [ ] Cut decorative UI before model correctness, reliability, or decision timing.
- [ ] Cut marginal data sources before adding an unvalidated source that can silently distort decisions.
- [ ] Keep the existing champion whenever a challenger lacks convincing holdout evidence.

## Sprint completion statement

The project is not considered complete because it has many features. It is complete when its source and data can be restored after catastrophic loss, its outputs are reproducible and attributable, its policies outperform simpler baselines out of sample, and it can deliver legal, timely, league-specific actions that increase expected championship equity while reporting uncertainty honestly.
