# Free Probabilistic Calibration Results

Generated: 2026-08-02T22:13:53.196Z
Source: nflverse weekly player statistics (CC-BY-4.0)
Training seasons: 2021, 2022, 2023, 2024
Untouched holdout season: 2025
Walk-forward forecasts: 31,682
Outcome coverage: 98.83%
Calibration approved: yes

## Holdout scorecard

| Metric | Before | After | Improvement |
|---|---:|---:|---:|
| mae | 4.46083 | 4.2564 | 0.20443 |
| rmse | 6.023 | 5.97912 | 0.04387 |
| brier | 0.07458 | 0.06693 | 0.00764 |
| logLoss | 0.24981 | 0.22795 | 0.02186 |
| wis | 2.66849 | 2.59695 | 0.07154 |
| meanPinball | 1.46966 | 1.43822 | 0.03144 |
| interval80Coverage | 0.88877 | 0.8749 | -0.01387 |

## Promotion checks

- PASS: holdoutSamples
- PASS: wis
- PASS: rmse
- PASS: brier
- PASS: coverage

## Leakage controls

- Each player-week forecast is generated before any outcome from that week is appended.
- The final season is excluded from calibration fitting and used only as a holdout.
- Only prior player and position outcomes are included in model inputs.
- Historical free-source outcomes are separated from the 2026 live identity requirement.

## Limitations

- The walk-forward bootstrap uses nflverse fantasy outcomes and opportunity counts, not historical betting markets or injury reports.
- Players absent from weekly source rows may be underrepresented in availability calibration.
- The bootstrap is an initialization prior; production forecast-journal outcomes should supersede it as samples accumulate.
