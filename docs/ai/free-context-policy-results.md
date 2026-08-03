# Perpetual-Free Context Policy Results

Generated: 2026-08-03T14:04:37.653Z
Source: nflverse weekly player statistics (CC-BY-4.0)
Training seasons: 2021, 2022, 2023, 2024
Untouched holdout season: 2025
Holdout samples: 6,563
Policy approved: yes
Production order matched: yes
Correction target: post-calibration residual
Features: airYardsShare, wopr, receivingEpaPerTarget, rushingEpaPerCarry, passingEpaPerDropback, opportunityTrend, pointsPerOpportunityTrend
Maximum correction: +/-1.5 expected points

| Metric | Before | After | Improvement |
|---|---:|---:|---:|
| mae | 4.25642 | 4.18279 | 0.07363 |
| rmse | 5.97913 | 5.93962 | 0.03951 |
| wis | 2.59695 | 2.56918 | 0.02777 |
| meanPinball | 1.43823 | 1.42335 | 0.01488 |
| interval80Coverage | 0.8749 | 0.87079 | -0.00411 |

- PASS: validationWisImproved
- PASS: holdoutWisImproved
- PASS: holdoutRmseDidNotRegress
- PASS: holdoutMaeDidNotRegress
- PASS: holdoutCoverageIsCalibrated
- PASS: correctionIsBounded
