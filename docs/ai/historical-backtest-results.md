# Historical Fantasy Decision Backtests

Generated: 2026-08-01T16:37:33.891Z

## Data and leakage controls

- Preseason ranking seasons: 2021, 2022, 2023, 2024, 2025
- Walk-forward test seasons: 2022, 2023, 2024, 2025
- Archived snapshots: 2021: 2021-08-27; 2022: 2022-08-26; 2023: 2023-08-25; 2024: 2024-08-30; 2025: 2025-08-08
- Player-season records: 1,800
- Identifier coverage: 98.1%
- Actual-points coverage: 90.8%

- Rankings are the latest archived August redraft consensus snapshot for each season.
- Each test season is projected only from seasons that occurred earlier.
- Current coaching profiles, current injuries, and future-season outcomes are excluded.
- Weekly lineup choices use only preseason projections and results from completed prior weeks.
- Oracle and baseline strategies use paired season, slot, and random-seed scenarios.

## Draft replay design

- Format: 12-team PPR, 14 rounds, all 12 draft slots
- Mock-draft replays: 1,536
- Paired scenarios: 384
- Strategies: market, pure value, legacy Oracle, calibrated Oracle

| Strategy | Managed points | All-play | Wins | Playoffs | Titles | Starter gaps | Pick regret |
|---|---:|---:|---:|---:|---:|---:|---:|
| market | 1506.8 | 50.1% | 7.02 | 52.3% | 8.1% | 0.11 | 107.9 |
| value | 1154.8 | 29.5% | 4.21 | 8.6% | 0.0% | 1.71 | 103.7 |
| legacy | 1334.6 | 41.3% | 5.89 | 31.8% | 1.3% | 0.78 | 99.0 |
| oracle | 1557.3 | 54.8% | 7.67 | 60.7% | 8.1% | 0.16 | 95.4 |

## Calibrated policy

The selected policy uses 72% market rank and 28% Oracle model/need rank.
It was selected on 2022, 2023, 2024 without using the 2025 holdout.

| Market weight | Model/need weight | Objective | Managed points | All-play | Starter gaps |
|---:|---:|---:|---:|---:|---:|
| 0.72 | 0.28 | 1805.4 | 1570.4 | 54.5% | 0.15 |
| 0.48 | 0.52 | 1792.4 | 1552.9 | 54.1% | 0.10 |
| 0.56 | 0.44 | 1791.1 | 1554.1 | 54.1% | 0.10 |
| 0.64 | 0.36 | 1782.3 | 1553.8 | 53.4% | 0.14 |
| 0.80 | 0.20 | 1781.0 | 1552.1 | 53.0% | 0.21 |
| 0.88 | 0.12 | 1767.8 | 1540.2 | 52.4% | 0.18 |

## Paired Oracle lift over market

- Managed points: +50.6
- Wins: +0.65
- All-play strength: +4.7 percentage points
- Playoff rate: +8.3 percentage points
- Championship rate: +0.0 percentage points
- Actual VORP: +62.6
- Pick-regret reduction: +12.5

These are average paired results, not guarantees. Scenario-level ranges remain wide.

## Untouched 2025 holdout

| Metric | Market | Calibrated Oracle | Lift |
|---|---:|---:|---:|
| Managed points | 1494.2 | 1586.6 | +92.4 |
| Wins | 6.79 | 7.92 | +1.13 |
| All-play | 48.7% | 57.1% | +8.4 pp |
| Playoffs | 49.0% | 68.8% | +19.8 pp |
| Titles | 6.3% | 10.4% | +4.2 pp |
| Actual VORP | 407.1 | 506.2 | +99.2 |
| Pick regret | 107.8 | 94.8 | -12.9 |

## Trade score calibration

The benchmark evaluated 1,728 synthetic one-for-one offers.
The selected standardized blend uses 90% multi-week roster utility and 10% native trade score.
It was tuned on 2022, 2023, 2024 and evaluated on the untouched 2025 holdout.

| Signal | Correlation with actual user gain |
|---|---:|
| Original trade score | 0.448 |
| Immediate lineup gain | 0.521 |
| Unified roster utility | 0.531 |
| Roster-need reduction | 0.414 |
| Calibrated decision score | 0.529 |

- Recommendation precision: 70.6%.
- Mean actual gain among recommended offers: +45.1.
- Top-versus-bottom score-quintile separation: 159.4 points.
- Bilateral positive rate under the test constraint: 19.9%.
- Holdout original-to-calibrated correlation: 0.534 to 0.595.
- Holdout recommendation precision: 76.5%.
- Holdout recommended mean gain: +51.8.

## Waiver and free-agent calibration

The benchmark replayed 48 Week 5 add/drop decisions.
The policy was selected on 2022, 2023, 2024 without using the 2025 holdout.

| Policy | Actual remaining-season gain |
|---|---:|
| Existing need-aware Oracle | +13.0 |
| Unified-utility rerank | +13.6 |
| Naive highest-projection rule | +0.7 |

Selected production order: Existing need-aware Oracle.
Unified-utility reranking won on training seasons but failed the untouched holdout; retain the need-aware champion.
The existing need-aware order beat the naive rule by +12.4 points on average.
On the untouched 2025 holdout, the selected order gained +7.1 points versus -5.3 for the naive rule.

## Limitations

- The committed benchmark covers skill positions and excludes kicker and team-defense slots.
- Mock-draft opponents approximate market behavior rather than reproducing every historical room.
- Historical value curves describe cohorts and do not guarantee an individual outcome.
- Transactions after the draft are excluded from the draft-only benchmark.
- Synthetic one-for-one preseason offers test score direction, not manager acceptance.
- Historical post-draft transactions and keeper costs are not reconstructed.
- Free-agent availability is approximated from players left undrafted in each historical mock.
- The replay evaluates one add/drop decision after Week 4 and does not reconstruct real waiver priority.
