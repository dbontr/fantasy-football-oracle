# Historical Opportunity Model Results

Generated for Fantasy Football Oracle 3.4.0.

## Purpose

The opportunity layer estimates how much of a player's current projection is supported by repeatable volume rather than fragile scoring efficiency. It complements current ESPN projections, coaching context, depth-chart inference, and market signals; it does not replace them.

## Data

- Weekly regular-season nflverse player statistics from 2020 through 2025.
- nflverse player identifiers map GSIS records to ESPN player IDs.
- Modeled positions: QB, RB, WR, and TE.
- Production profiles: 608.
- Current bundled-player matches: 482.
- Historical transitions with at least six games in both seasons: 1,202.
- Untouched 2025 holdout transitions: 304.

Raw source files remain local and ignored. The repository ships only the compact `data/opportunity-2026.json` artifact.

## Features

Position-specific inputs include prior PPR points per game, attempts, carries, targets, target share, air-yards share, WOPR, completion over expectation, yards per attempt/carry/target, catch rate, weekly usage stability, late-season usage trend, age, and experience.

## Leakage controls

1. Each training row uses one season's usage to predict the following season.
2. Ridge penalties are selected with season-held-out folds using outcomes through 2024.
3. The 2025 outcome season is excluded from hyperparameter selection.
4. The selected model is evaluated once on the untouched 2025 holdout.
5. Production coefficients are refit through 2025 only after holdout diagnostics are recorded.
6. The 2026 profiles use 2025 regular-season usage and no 2026 outcomes.

## Untouched 2025 holdout

| Position | Samples | Model RMSE | Prior-season RMSE | RMSE reduction | Model correlation | Prior correlation |
|---|---:|---:|---:|---:|---:|---:|
| QB | 31 | 3.739 | 4.407 | 15.2% | 0.386 | 0.346 |
| RB | 71 | 3.237 | 3.642 | 11.1% | 0.846 | 0.824 |
| WR | 126 | 2.958 | 3.593 | 17.7% | 0.812 | 0.779 |
| TE | 76 | 2.555 | 2.817 | 9.3% | 0.775 | 0.752 |
| **Weighted overall** | **304** | **3.002** | **3.494** | **13.8%** | **0.767** | **0.739** |

Every position improved both RMSE and correlation against carrying prior-season scoring forward.

## Production integration

The runtime model performs four safeguards:

- Shrinks the historical forecast toward the current source projection.
- Reduces weight when current ownership and start rate indicate a role change.
- Centers the adjustment within position so the layer does not inflate the league.
- Bounds mean effects while allowing volume stability to influence reliability and volatility.

The resulting context includes the ridge forecast, evidence weight, current-role continuity, weighted opportunity per game, opportunity shares, WOPR, usage trend, volume stability, age, experience, holdout skill, and feature-level drivers.

## Historical analogs

Each 2026 profile also includes 16 nearest historical player-seasons using standardized position features. The artifact stores:

- analog-weighted subsequent-season PPG
- p10, median, and p90 subsequent outcomes
- upside and downside cohort rates
- four closest named comparables with source and following-season PPG

Analogs are explanatory and range-setting evidence. They do not replace the holdout-validated ridge mean because nearest-neighbor performance is less consistent by position.

## User-facing outputs

The Team Manager reports starter-weighted historical opportunity share, volume stability, regression direction, holdout RMSE lift, player archetypes, and comparable past seasons. The same evidence propagates into draft, lineup, waiver, trade, season, and league calculations through the modeled player distributions.

## Limitations

- Box-score opportunity does not provide route participation, targets per route, separation, coverage geometry, or red-zone expected fantasy points.
- A player can change teams or roles faster than current ownership and start rates reveal; continuity damping reduces but cannot eliminate that risk.
- Quarterback holdout correlation is lower than the skill-position correlations because the sample is smaller and role changes are more discontinuous.
- Historical analogs describe cohorts and are not claims that two players have identical talent, health, scheme, or career paths.
- The model is trained for redraft PPR outcomes, not dynasty valuation or contract forecasting.

## Source references

- nflverse data releases and identifiers: `https://github.com/nflverse`
- nflverse data access documentation: `https://nflreadpy.nflverse.com/`
- nflfastR field and model documentation: `https://www.nflfastr.com/`
