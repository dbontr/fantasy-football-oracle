# Health, News, and Recovery Intelligence

Version: `oracle-health-2026.1`

## Purpose

This layer answers four different questions that a single injury flag cannot:

1. What has actually been reported?
2. What is the probability the player is available in each week?
3. How quickly should fantasy performance ramp after return?
4. What is the probability of eventually regaining the prior performance level?

Reported facts and modeled estimates are stored separately. The output is a fantasy decision aid, not a medical prognosis.

## Live inputs

The refresh pipeline combines:

- ESPN Fantasy designation and news timestamp
- Sleeper injury body part, status, notes, practice participation, and depth-chart order
- ESPN player-tagged headlines, descriptions, publication time, and article links
- the existing schedule, projections, opportunity profile, age, and position

ESPN and Sleeper enrichment is fault tolerant. A failed optional feed does not prevent the core player refresh from completing.
## Historical calibration

The builder joins nflverse official injury/practice reports to weekly PPR outcomes from 2020–2025.

Committed calibration coverage:

- 10,243 player-week injury reports
- 10,243 availability observations
- 1,035 observed return episodes
- QB, RB, WR, and TE position groups

Availability examples:

| Evidence | Samples | Played that week |
|---|---:|---:|
| Out | 1,906 | 0.1% |
| Doubtful | 312 | 0.6% |
| Questionable | 2,587 | 58.3% |
| Did not practice | 2,831 | 17.5% |
| Limited practice | 2,602 | 62.3% |
| Full practice | 4,744 | 81.8% |

Small position/status/practice groups shrink toward broader status and practice priors.
## Recovery calibration

A return episode requires:

- a consecutive injury-related missed-game block
- at least two preinjury games for a player-specific baseline
- a return within eight weeks
- up to four post-return games for the early ramp

Across 1,035 episodes:

- first game back averaged 82.5% of the preinjury fantasy baseline
- the first four games averaged 95.5%
- 45.5% reached at least 90% of baseline during the first four games
- 25.9% produced another same-family injury report within four weeks

The last figure is treated as a repeat-report/setback signal and is shrunk before becoming recurrence risk. It is not assumed to be a confirmed reinjury.

Long-term ACL, Achilles, and patellar estimates use separate conservative literature priors. They do not overwrite the observed early-return calibration.

## Weekly model

Every player receives 18 weekly values for:

- availability probability
- performance-retention factor
- combined expected-health factor
- damped projection factor

The model also returns an earliest, likely, and latest return week with explicit timetable confidence.
## News safeguards

News changes a projection only when:

- the article is tagged to the player, and
- it has a single athlete or the player is named in the headline, and
- explicit health, return, practice, setback, or role language is present.

Multi-athlete camp roundups remain visible but cannot move a player merely because the article contains words such as “breakout” or “first-team.” Signals decay with article age.

## Preseason and reserve designations

Preseason PUP/NFI is modeled as a probabilistic Week 1 return because it is not automatically the same as reserve PUP/NFI after final roster decisions. In-season reserve and injured-reserve designations use longer minimum return windows.

## Decision propagation

Health-adjusted weekly distributions automatically affect:

- draft ranking and return probability
- start/sit confidence and expected regret
- roster strength and positional need
- waiver and FAAB recommendations
- trade utility and fairness
- season, playoff, and championship simulations

Central projection adjustments are bounded. Availability, floor, reliability, volatility, and uncertainty receive larger effects.

## Limitations

- Public feeds often omit the exact diagnosis, surgery date, rehabilitation testing, and team medical clearance.
- News classification is conservative and rule based, not a trained clinical language model.
- Historical return samples exclude many players who never returned within eight weeks.
- Fantasy performance is affected by role, age, teammates, and coaching in addition to health.
- Return-to-level probabilities describe fantasy output, not physical recovery or long-term health.
