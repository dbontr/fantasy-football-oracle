# Native C++ Engine Results

## Implemented architecture

Fantasy Football Oracle now uses a persistent C++20 worker pool as the primary compute layer. Node.js owns HTTP, validation, integrations, caching, security, queueing, timeouts, worker supervision, and fallback routing.

The native process protocol is newline-delimited JSON over stdin/stdout. Workers are probed before use, remain alive across requests, report capability/version metadata, and are replaced after crashes or protocol failures.

Implemented native tasks:

- draft simulation
- complete draft recommendations
- exact lineup optimization
- roster analysis
- start/sit risk profiles and confidence
- waiver and FAAB analysis
- trade analysis
- 1-for-1 through 2-for-2 trade generation
- correlated season simulation
- league playoff and championship simulation

JavaScript workers remain the fallback for legacy tasks. Native-only models fail explicitly when native compute is unavailable.

## Correctness

- Exact draft mode reproduces the JavaScript seeded simulation exactly.
- Fast lookup-noise mode has mean return-probability drift below 0.01 and maximum drift below 0.04 over 10,000 paths.
- Native lineup totals and starter assignments match the JavaScript exact optimizer.
- Trade score, value, fairness, and lineup deltas match within narrow numeric tolerance.
- Season quantiles and CVaR are ordered and bounded.
- League championship probabilities sum to approximately one.

## Warm-worker benchmark

Jupiter, Windows x64, bundled 700-player 2026 dataset:

| Workload | Native C++ wall | JavaScript wall | Speedup |
|---|---:|---:|---:|
| 15,000 draft paths | 217.19 ms | 244.72 ms | 1.13x |
| Complete draft recommendations | 236.51 ms | 1,594.52 ms | 6.74x |
| Deep trade generation | 55.18 ms | 1,593.29 ms | 28.88x |
| Waiver search | 23.38 ms | 30.01 ms | 1.28x |
| 25,000 correlated season paths | 915.75 ms | native-only | — |

The draft recommendation improvement comes from precomputed asset values, pre-sorted positional peers, compact hot-loop structures, and a lookup-table Gumbel sampler. The exact-noise implementation remains available for parity tests.

## Browser verification

The full Edge workflow verified:

- server ensemble data load
- native C++ health and status display
- 15,000-path draft recommendations
- native start confidence in the optimized lineup
- FAAB floor/target/ceiling rendering
- native season p10–p90 and downside CVaR
- opponent-specific trade generation
- PWA registration
- 390-pixel mobile layout without horizontal overflow
- no page errors or console errors

The historical-intelligence browser run rendered 24 calibrated trade proposals with 292 ms of server compute and about 2.37 seconds click-to-DOM, while the 15,000-path draft endpoint averaged 956 ms end-to-end. Edge showed calibrated policy ranks, roster utility, holdout-winning waiver policy, and trade confidence on desktop and 390px mobile. The PWA registered, there was no horizontal overflow, and no console or page errors occurred.

## Remaining risks

- The Docker image was not locally built because Docker is unavailable on Jupiter.
- Projection accuracy is still limited by source quality and model features, not native execution speed.
- Licensed projections, betting markets, offensive-line data, route participation, and real-time weather are not yet independent ensemble inputs.
- Multi-season historical backtesting should be expanded before treating model-confidence values as calibrated probabilities.
