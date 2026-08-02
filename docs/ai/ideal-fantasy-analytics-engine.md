# Ideal Fantasy Football Analytics Engine

Version: `oracle-blueprint-2026.5`

The best fantasy-football engine is not a ranking table. It is a continuously calibrated decision system that estimates player opportunity, efficiency, uncertainty, market behavior, league-specific utility, and the consequences of every available action.

Its output should answer:

- What is the probability distribution of each player's fantasy points?
- Why does that distribution differ from the market?
- How much does the coaching staff change role, development, and uncertainty?
- What action maximizes championship equity under this league's rules?
- What would have to change for the recommendation to reverse?

## Operating principles

1. Separate observed facts, inferred features, model priors, and final decisions.
2. Model distributions and correlations instead of only point estimates.
3. Shrink small samples toward league and position baselines.
4. Prevent double counting when source projections already encode a factor.
5. Optimize league utility, not raw player points.
6. Report uncertainty, calibration, provenance, and missing data.
7. Make every recommendation explainable and counterfactual.
8. Preserve deterministic fallbacks and version every model input.
## Analytical layers

| Layer | Ideal inputs | Primary outputs | Current state |
|---|---|---|---|
| Opportunity | snaps, routes, targets, carries, red-zone work, air yards | expected touches, expected fantasy points, role trajectory | Implemented for weekly box-score usage; routes/red-zone remain missing |
| Tracking | route geometry, separation, speed, coverage, defender leverage | skill isolation, matchup fit, route efficiency | Planned |
| Coaching | staff, play caller, scheme, leadership, continuity, development | usage prior, role confidence, development curve, volatility | Implemented |
| Offensive line | pressure responsibility, block win rates, line injuries | pocket stability, rushing efficiency, sack risk | Planned |
| Health | injury history, practice participation, workload, recovery | availability probability, snap ramp, recurrence risk | Implemented with public-feed limits |
| Environment | wind, rain, temperature, venue, surface, travel, rest | play-volume and efficiency adjustment | Partial |
| Betting market | spread, total, team total, props, line movement | game script, scoring environment, market residual | Planned |
| Matchup | coverage shells, pressure, fronts, position splits | player-opponent interaction effects | Partial |
| News and depth chart | transactions, practice reports, beat reports | role-change event detection | Partial |
| Market value | ADP, auction value, ownership, start rate | acquisition cost, scarcity, behavioral edge | Implemented |
| League utility | scoring, slots, roster sizes, opponents, FAAB | VORP, VONA, trade value, championship equity | Implemented |
| Simulation | player and game correlations, schedule, playoffs | outcome distributions, CVaR, playoff and title odds | Implemented |
| Calibration | historical predictions and outcomes | bias correction, reliability curves, drift detection | Partial |
| Explainability | feature contributions and alternatives | reasons, sensitivity, counterfactual decisions | Partial |

The runtime endpoint `GET /api/model/blueprint` exposes this registry and its weighted readiness score. Missing data remains visible rather than being silently replaced by fabricated precision.
## Coaching and organizational intelligence

The coaching layer models the environment around the player rather than assigning a universal coach grade. A staff can be excellent for one position and neutral or harmful for another.

Inputs:

- head coach, offensive coordinator, defensive coordinator, and play caller
- offensive and defensive scheme archetypes
- pace, pass rate, motion, play action, aggressiveness, target concentration, committee usage, and red-zone tendencies
- leadership, adaptability, role clarity, continuity, and workload management
- position-specific development priors
- evidence seasons and source confidence

Outputs:

- bounded player mean adjustment
- reliability and role-confidence adjustment
- floor, ceiling, and volatility adjustment
- workload-related injury-risk adjustment
- staff-change uncertainty
- top explanatory coaching drivers

Current mean changes are deliberately bounded and centered against a position-specific league baseline because upstream projections already incorporate some team context. Coaching has more influence on reliability, volatility, and upside than on the central projection.

Small or new samples are Bayesian-shrunk toward league average. Continuity is allowed more direct influence because staff turnover is observable, while leadership and development estimates are more uncertain.
## Contextual intelligence and decision regret

Version 3.2 added a bounded inference layer for areas where the original public snapshot lacked direct usage and tracking data. Version 3.4 replaces part of that proxy with validated historical carries, targets, target share, air-yards share, WOPR, usage stability, and age curves; route and tracking fields remain unavailable. It intentionally labels these fields as proxies.

Current outputs include:

- league-centered offense, passing, rushing, defense, and skill-concentration indices
- position share, role rank, depth gap, role certainty, and team skill share
- weekly and playoff matchup grades derived from opponent offense and DST projection proxies
- ADP, previous-production, and source-model disagreement
- breakout and bust probabilities, upside/downside asymmetry, and player archetypes
- fragility and normalized uncertainty attribution across baseline, role, health, coaching, matchup, and consensus
- native expected regret for every start/sit alternative, including the probability the alternative wins and an 80% decision swing

Expected regret is not the projection difference. It is the expected positive score difference in scenarios where the bench alternative outscores the selected starter. This highlights close, high-variance choices that a deterministic optimizer would otherwise hide.

Team and player intelligence are exposed through GET /api/intelligence/status, GET /api/intelligence/teams, and GET /api/intelligence/players/:id.

## Modeling architecture

A production-grade model should combine specialized components rather than one opaque regressor:

1. **Opportunity model** predicts snaps, routes, targets, carries, and high-value touches.
2. **Efficiency model** estimates yards, touchdowns, catches, and scoring conversion conditional on opportunity.
3. **Availability model** predicts active status and expected snap participation.
4. **Coaching model** modifies role stability, scheme fit, development, workload, and uncertainty.
5. **Matchup model** estimates player-by-opponent interactions instead of relying on broad position rankings.
6. **Market residual model** learns when betting and fantasy markets contain information not present in football features.
7. **Correlation model** links teammates, opponents, game script, weather, and scoring environment.
8. **League utility model** converts football outcomes into replacement value and action value for the exact league.

Recommended statistical structure:

- hierarchical team, coach, player, and position effects
- partial pooling for rookies, new staffs, and small samples
- time-decayed features with explicit season and week boundaries
- mixture or quantile models for floor, median, ceiling, and tail risk
- calibrated classification for availability, role loss, and breakout probabilities
- champion-challenger evaluation before replacing a production model

The C++ layer should remain responsible for combinatorial optimization and Monte Carlo. Feature construction, training, calibration, and provenance can remain in a separate reproducible data pipeline.
## Decision products

The ideal engine should produce more than projections:

- draft recommendations with return probability, VONA, tier-loss risk, and opponent demand
- start/sit choices with confidence, expected regret, alternative win probability, correlation, and the minimum assumption needed to reverse the decision
- waiver recommendations with role-change probability, lineup gain, FAAB range, and opportunity cost
- trades evaluated for both teams, replacement value, schedule fit, downside, and title-equity change
- season and league simulations with p10-p90, CVaR, playoff odds, championship odds, and all-play strength
- portfolio recommendations for best ball, DFS, survivor, and multi-league exposure
- alerts when news, practice participation, betting markets, or staff decisions materially change a recommendation

Every output should expose:

- data timestamp and source provenance
- model version and calibration window
- central estimate and uncertainty interval
- feature-family contributions
- missing or stale inputs
- alternative actions and counterfactual thresholds

## Evaluation

Point-prediction error alone is insufficient. Evaluation should include:

- MAE and RMSE by position, week, role, and projection range
- pinball loss for quantiles
- Brier score and reliability diagrams for probabilities
- interval coverage for p10-p90 ranges
- calibration of playoff, title, injury, and availability probabilities
- decision regret against replacement actions
- championship-equity lift in historical league replays
- drift by season, coaching change, rookie status, and data source
## Implemented in version 3.1.0

- 32 current 2026 coaching staffs and offensive play callers
- position-specific coaching and development priors
- evidence-weighted shrinkage toward neutral
- scheme usage, leadership, adaptability, role clarity, continuity, and workload effects
- coaching-adjusted mean, floor, ceiling, reliability, volatility, and injury risk
- coaching context propagated into the native C++ draft, lineup, waiver, trade, and simulation engines
- starter-weighted coaching exposure in the Team Manager
- player-level coaching explanations
- staff and coaching API endpoints
- explicit ideal-engine readiness registry and model-gap endpoint

## Implemented in version 3.2.0

- contextual team offense, passing, rushing, defense, and concentration indices
- depth-chart opportunity, role certainty, position share, and competition proxies
- 18-week matchup and fantasy-playoff schedule outlooks
- market and model-consensus disagreement
- breakout, bust, asymmetry, fragility, and uncertainty decomposition
- native team-aware start/sit correlations
- expected-regret scoring and highest-cost counterfactual decisions
- draft, lineup, roster, and waiver intelligence explanations in the browser
- intelligence status, team, and player API endpoints
- league-centered factor diagnostics preventing systematic projection inflation

## Implemented in version 3.4.0

- position-specific QB, RB, WR, and TE opportunity regressions trained on 2020-2025 weekly nflverse data
- season-held-out regularization selection and untouched 2025 evaluation
- 304-player holdout with 13.8% lower RMSE and higher correlation than prior-season scoring
- 608 mapped 2026 profiles with carries, targets, shares, WOPR, usage trend, stability, age, and experience
- position-centered, role-continuity-damped projection integration
- historical player-season analog cohorts and subsequent-outcome p10-p90 ranges
- opportunity uncertainty, feature drivers, regression archetypes, and browser/API evidence
- opportunity layer promoted to implemented in the runtime readiness registry

## Implemented in version 3.5.0

- live ESPN Fantasy and Sleeper injury, body-part, practice, depth-chart, and status enrichment
- player-tagged ESPN news with freshness decay and conservative single-player attribution
- 10,243 historical injury-report availability observations from 2020-2025
- 1,035 return episodes for first-game and first-four-game performance ramps
- earliest, likely, and latest return windows with timetable confidence
- early-return and long-term return-to-prior-level probabilities kept as separate estimates
- recurrence/setback risk, age adjustment, weekly availability, performance retention, and uncertainty
- preseason PUP/NFI separated from reserve designations
- reported facts separated from model priors and estimates in APIs and the Team Manager
- health-adjusted distributions propagated into every native draft, lineup, waiver, trade, and season decision
- health layer promoted to implemented and weighted readiness increased to 62/100

## Highest-value next additions

1. Add route participation, targets per route, red-zone role, and play-level expected-fantasy-points time series.
2. Extend historical opportunity training to rookies, team changes, and explicit role-transition classes.
3. Backtest coach-player-position effects across staff changes with partial pooling.
4. Add live NWS weather and stadium-surface features.
5. Ingest consensus betting totals and player props with timestamped line movement.
6. Add offensive-line and opponent coverage/pass-rush features.
7. Add surgery dates, rehabilitation testing, official clearance, and complete longitudinal injury histories.
8. Add weekly champion-challenger evaluation and drift alarms.
9. Extend the implemented counterfactual explanations into an interactive what-if editor.
10. Optimize directly for championship equity in historical league replays.

## Reference data ecosystems

- NFL Next Gen Stats for tracking-derived route, coverage, speed, completion, rushing, and win-probability features
- nflverse and nflfastR for reproducible play-by-play, expected points, schedules, rosters, and participation data
- National Weather Service API for official live forecast data
- NFL team staff directories and the NFL coaching tracker for current staff attribution
- licensed projection, injury, offensive-line, and betting feeds when production rights and budgets permit
