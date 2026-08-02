# Historical Backtest and Unified Roster Utility Plan

## Goal

Turn Oracle from a current-season optimizer into a measured decision system that learns from prior seasons and applies one roster-utility model to drafts, trades, and waivers.

## Confirmed starting point

- Draft recommendations already use starter need, replacement value, roster construction, tier cliffs, VONA, opponent demand, injury risk, and market pressure.
- Trade analysis already re-optimizes lineups and measures asset, starter, depth, fairness, and injury effects.
- Waiver analysis already searches add/drop pairs and measures lineup, depth, rest-of-season, reliability, scarcity, and FAAB urgency.
- No genuine multi-season historical draft replay currently exists.
- Current trade and acquisition weights are engineered priors rather than coefficients calibrated from historical decision outcomes.

## Desired behavior

1. Build leakage-safe historical preseason snapshots from archived ESPN ranks/ADP and nflverse player outcomes.
2. Replay complete snake drafts across seasons, slots, and randomized opponent behavior.
3. Compare Oracle with market/ADP baselines using paired seeds.
4. Score drafted rosters with actual weekly outcomes, all-play results, playoffs, title rate, and pick regret.
5. Produce empirical position/rank value curves and uncertainty priors for the live model.
6. Use one multi-week roster utility model for drafts, trades, free agents, and roster analysis.
7. Expose every utility component and preserve the native C++ engine as the search/optimization layer.
