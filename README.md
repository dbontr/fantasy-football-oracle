# Fantasy Football Oracle

Fantasy Football Oracle is a native-powered fantasy-football decision system for live drafts and in-season management. A C++20 analysis engine performs the expensive simulations and optimization while Node.js handles APIs, data refresh, security, ESPN/Sleeper integrations, and process orchestration.

The browser remains installable and responsive. It keeps a deterministic JavaScript engine and Web Worker for offline or degraded operation, but a healthy server routes analysis to persistent C++ workers.

## Championship architecture 4.0

Version 4.0 adds an operational control plane around the analytical engine:

- exact connected-league rules, standings, rosters, future schedule, FAAB, median-game rules, playoff teams, and byes;
- paired current-roster and candidate-action simulation with championship probability as the primary objective;
- legal waiver, trade, roster, and draft-state transformations before simulation;
- deterministic recommendation replay keys, model/data/input digests, confidence, warnings, and durable decision IDs;
- source-level lineage, deadlines, bounded retries, content hashes, and explicit required versus optional feed health;
- immutable content-addressed dataset and decision snapshots with bounded retention;
- SHA-256 artifact manifests, deterministic CycloneDX SBOM, strict production integrity mode, and build fingerprinting;
- mandatory untouched-holdout champion/challenger gates, rejection records, instant rollback, and persistent drift monitoring;
- full Git bundles, ignored-data archives, checksums, optional AES-256-GCM encryption, multiple replica targets, retention, and isolated restore drills;
- public healthy/degraded/stale/unsafe states and restricted metrics, event, decision, manifest, and governance endpoints.

The Team Manager includes a Championship Control Center that displays platform integrity, recovery state, data freshness, league completeness, and paired title-equity results for current waiver and trade candidates. No model can guarantee a championship; the objective is to maximize estimated title probability while making assumptions, freshness, and uncertainty visible.

## Native intelligence

### Draft room

- Tracks snake drafts, traded picks, rosters, positional runs, and distance to the next user pick.
- Runs opponent-aware Monte Carlo draft paths in C++.
- Estimates the conditional probability that each player survives to the next pick.
- Calculates VONA: the value of selecting a player now instead of waiting for the best likely alternative.
- Models replacement value, roster need, tier cliffs, ADP pressure, injury risk, and opponent positional demand.
- Learns from the observed draft state rather than treating every opponent as identical.
- Returns the complete recommendation ranking from C++, not only raw simulation probabilities.

### Start/sit and roster management

- Uses exact assignment optimization for QB/RB/WR/TE/FLEX/SUPERFLEX/DST/K eligibility.
- Produces balanced, floor, ceiling, risk-adjusted, and opponent-target-aware lineups.
- Reports slot-level start confidence and the strongest legal bench alternatives.
- Models weekly floors, ceilings, volatility, reliability, injuries, matchups, byes, and depth.
- Grades the complete roster and each position.
- Detects bye collisions, injury exposure, weak positions, and depth shortages.
### Coaching, scheme, and player development

- Models all 32 current 2026 staffs, coordinators, and offensive play callers.
- Separates leadership, adaptability, role clarity, continuity, workload management, scheme usage, and position development.
- Uses evidence-weighted partial pooling so new staffs and small samples remain close to neutral.
- Centers every position against a league-relative coaching baseline, preventing league-wide projection inflation.
- Adjusts player mean conservatively while applying larger effects to reliability, floor, ceiling, volatility, and injury uncertainty.
- Propagates the coached player distributions into every native draft, lineup, waiver, trade, season, and league calculation.
- Shows starter-weighted staff exposure and the largest player-level coaching effects in the Team Manager.
- Exposes model drivers and source confidence rather than presenting coach scores as objective facts.

### Historical opportunity and regression forecasting

- Trains separate QB, RB, WR, and TE ridge models on nflverse weekly usage and production from 2020–2025.
- Uses attempts, carries, targets, target share, air-yards share, WOPR, efficiency, role stability, usage trend, age, and experience.
- Selects regularization with season-held-out training folds before evaluating once on the untouched 2025 holdout.
- Improved holdout RMSE from 3.49 to 3.00 PPR points per game across 304 player transitions, a 13.8% reduction.
- Improved holdout correlation from 0.739 to 0.767; every modeled position improved both RMSE and correlation.
- Refits through 2025 only after holdout evidence is recorded, then creates 608 compact 2026 profiles mapped to ESPN IDs.
- Centers and bounds production adjustments by position, with current ownership and start rate damping stale-role carryover.
- Adds historical analog cohorts, p10–p90 subsequent-season ranges, upside/downside rates, and comparable player-seasons.
- Exposes starter-weighted opportunity share, volume stability, regression signals, and holdout skill in the Team Manager.

The production player mean remains conservative: the historical model is one evidence-weighted component rather than a replacement for current projections. See [`docs/ai/opportunity-model-results.md`](docs/ai/opportunity-model-results.md).

### Health, news, and recovery intelligence

- Refreshes ESPN Fantasy designations, Sleeper body-part/practice fields, and player-tagged ESPN news.
- Calibrates weekly availability from 10,243 historical injury-report weeks and recovery from 1,035 observed return episodes.
- Separates reported facts from modeled earliest/likely/latest return windows, weekly availability, performance ramp, long-term return-to-prior-level probability, recurrence risk, and uncertainty.
- Treats preseason PUP/NFI differently from reserve designations and keeps ambiguous cases close to neutral.
- Uses conservative player-focused news attribution and freshness decay so multi-athlete camp articles cannot move every tagged player.
- Propagates health-adjusted distributions into draft, start/sit, waiver, trade, roster, season, and league calculations.
- Displays active availability, recovery exposure, return strength, confidence, reported details, modeled return timing, and recent news in the Team Manager.

The compact health calibration is committed while raw injury downloads remain ignored. See [`docs/ai/health-news-intelligence-results.md`](docs/ai/health-news-intelligence-results.md).

### Contextual decision intelligence

- Builds league-centered team offense, passing, rushing, and defense ecosystem indices.
- Estimates position share, depth-chart competition, team skill share, depth gap, and role certainty.
- Produces an 18-week matchup outlook and fantasy-playoff schedule score using low-confidence opponent offense/DST proxies.
- Measures disagreement among ADP, prior production, source projections, and the current ensemble.
- Reports breakout probability, bust probability, upside/downside asymmetry, fragility, and uncertainty decomposition.
- Labels players as stable anchors, asymmetric-upside assets, fragile ceilings, or role-sensitive risks.
- Calculates native expected lineup regret: the expected points lost when an uncertain bench alternative outscores the chosen starter.
- Exposes player, team, and model-level intelligence through dedicated API endpoints and the Team Manager.

### Historical calibration and roster utility

- Replays archived August consensus rankings against actual weekly outcomes from 2021–2025 without using future-season information.
- Runs walk-forward mock drafts across every draft slot and compares market consensus, pure value, the legacy policy, and the calibrated Oracle policy.
- Selects draft-policy weights on 2022–2024, then evaluates once on an untouched 2025 holdout.
- Uses a shared multi-week roster-utility model for lineup strength, playoff weeks, depth, reliability, injury exposure, bye collisions, positional scarcity, and roster need.
- Adds historical rank-bucket hit and bust rates to draft, trade, waiver, and roster explanations.
- Calibrates trade confidence separately and preserves the historically stronger waiver ordering when a challenger does not improve outcomes.
- Ships compact calibration curves and policy evidence; raw historical source caches remain local and ignored.

The committed PPR benchmark contains 1,536 mock-draft replays and 384 paired season/slot/seed scenarios. The selected 72% market / 28% model-and-need policy improved the untouched 2025 holdout by 92.4 managed points, 1.13 wins, 8.4 percentage points of all-play strength, and 19.8 percentage points of playoff rate versus the market baseline. A separate 1,728-offer trade replay selected a 90% standardized roster-utility / 10% native-score blend and improved holdout correlation from 0.534 to 0.595. The waiver challenger won its training years but failed the untouched holdout, so production retains the existing need-aware order. These are historical averages from approximated fantasy environments, not guarantees. See [`docs/ai/historical-backtest-results.md`](docs/ai/historical-backtest-results.md).

### Waivers and FAAB

- Searches legal add/drop combinations for the selected week.
- Measures starting-lineup gain, bench-depth gain, rest-of-season value, and reliability.
- Incorporates Sleeper transaction trends.
- Produces FAAB floor, target, and ceiling bids based on budget, urgency, scarcity, weeks remaining, and risk tolerance.

### Trade lab

- Evaluates manual multi-player deals for both teams.
- Generates opponent-specific 1-for-1, 2-for-1, 1-for-2, and 2-for-2 packages.
- Re-optimizes both lineups after every candidate trade.
- Scores weekly starter impact, rest-of-season value, depth, consolidation, positional fit, fairness, and injury exposure.
- Prunes the package space by market-value neighborhoods before exact bilateral evaluation.

### Season and league simulation

- Runs correlated weekly and season Monte Carlo simulations.
- Reports p10, p25, median, p75, p90, standard deviation, coefficient of variation, and downside CVaR.
- Simulates imported leagues to estimate expected wins, total points, all-play strength, seed probabilities, playoff odds, and championship odds.
- Uses an imported schedule when available and a deterministic round-robin schedule otherwise.

## Architecture

```text
Browser/PWA
  |-- rendering, local state, ESPN/Sleeper import
  |-- offline JavaScript decision engine
  `-- Web Worker draft fallback
             |
             v
Fastify / Node.js
  |-- validation, rate limiting, security, caching
  |-- live health/news ingestion, historical opportunity, coaching, contextual intelligence, and projection ensemble
  |-- historical calibration, policy evidence, and unified roster utility
  |-- model readiness registry, native supervision, and bounded queues
  `-- JavaScript worker fallback
             |
             v
Persistent C++20 worker pool
  |-- draft Monte Carlo and complete recommendations
  |-- exact lineup assignment, start/sit confidence, and expected regret
  |-- waivers and FAAB
  |-- trade analysis and package generation
  `-- season and league simulations
```

The native executable uses newline-delimited JSON over stdin/stdout. Each process stays alive, so startup and model-loading costs are not paid for every request. A crashed worker is isolated, rejected, replaced, and removed from service without terminating the API.

Legacy calculations can fall back to the JavaScript worker pool when the native executable is unavailable. Native-only season, start/sit, and league simulations fail explicitly rather than silently substituting a weaker model.

## Performance

Representative warm-worker benchmarks on Jupiter, Windows x64, using the bundled 700-player 2026 dataset:

| Workload | Native C++ | JavaScript worker | Speedup |
|---|---:|---:|---:|
| 15,000 draft paths | 217 ms | 245 ms | 1.13x |
| Full 15,000-path draft recommendations | 237 ms | 1,595 ms | 6.74x |
| Deep 1-for-1 through 2-for-2 trade search | 55 ms | 1,593 ms | 28.88x |
| Week-aware waiver search | 23 ms | 30 ms | 1.28x |
| 25,000 correlated 17-week season simulations | 916 ms | Native-only | — |

The trade benchmark retains the full 900-candidate exact-evaluation budget. The speedup comes from shared immutable player metadata and delayed JSON serialization for only the final returned proposals, not from reducing search depth or removing 2-for-2 packages.

Run the benchmark on the current machine:

```bash
npm run benchmark:native
```

The exact draft mode reproduces the JavaScript Mulberry32/Gumbel simulation. Production uses a faster lookup-noise mode whose tested mean return-probability drift is below 0.01 and maximum drift below 0.04 over 10,000 paths.

## Projection model

The server creates an 18-week ensemble from ESPN weekly projections, season baselines, prior production, leakage-safe historical usage forecasts, role stability, ownership/start rates, live injury and practice evidence, player-focused news, recovery ramps, schedule context, coaching intelligence, team ecosystem strength, depth-chart competition, and projection disagreement. Each player includes:

- weekly means and 18 weekly values
- floor, ceiling, and standard deviation
- reliability and volatility
- schedule, home/away, kickoff, indoor, and bye context
- coaching staff, play caller, scheme, development context, continuity, and explanatory drivers
- weighted opportunity, target/carry/air-yard share, WOPR, historical analogs, opportunity index, role certainty, team ecosystem, weekly matchup scores, and consensus disagreement
- reported injury and practice facts, focused news, weekly availability, return window, early ramp, long-term return-to-prior-level probability, recurrence risk, and health uncertainty
- breakout, bust, asymmetry, fragility, and uncertainty-source attribution
- model components, generation time, and digest

The coaching mean effect is bounded to reduce double counting, while role reliability and uncertainty receive greater weight. The C++ simulator turns those inputs into distributions and decision probabilities. The model is a decision aid, not a guarantee.

## Quick start

Requirements:

- Node.js 20 or newer
- A C++20 GCC or Clang compiler for `npm run build:native`; the included CMake project also supports MSVC.

On Windows, the build script searches `CXX`, common MSYS2/Chocolatey locations, and `~/Tools/w64devkit`. On Linux, set `CXX=g++` or install the distribution compiler.

```bash
npm ci --ignore-scripts
npm run verify
npm start
```

`npm run verify` builds the native executable before testing. Verified builds are cached by source, flags, and compiler version, so repeated checks do not replace a native binary that a running server is using. Set `ORACLE_FORCE_NATIVE_REBUILD=true` to force a rebuild. On Windows, a forced build stages the replacement safely while active workers finish on the renamed previous executable; restart the server to move every worker to the new build. Open `http://localhost:8787` after the server starts.

Useful commands:

```bash
npm run build:native
npm run build:data
npm run build:opportunity -- --history-root <nflverse-raw-directory>
npm run build:health -- --stats-root <nflverse-weekly-stats-directory>
npm run build:history
npm run backtest:history
npm run calibrate:decisions
npm run report:history
npm run build:sbom
npm run manifest:generate
npm run artifacts:validate
npm run backup -- --out ../oracle-recovery
npm run backup:prune -- --dry-run
node scripts/verify-backup.js --package <package>
node scripts/disaster-recovery-drill.js --package <package> --full
npm run check
npm test
npm run benchmark:native
npm start
npm run dev
```

Useful endpoints:

- `GET /api/health`
- `GET /api/data/status`
- `GET /api/data/players`
- `GET /api/opportunity/status`
- `GET /api/opportunity/players/:id`
- `GET /api/health-intelligence/status`
- `GET /api/health-intelligence/players/:id`
- `GET /api/coaching/teams`
- `GET /api/coaching/teams/:team`
- `GET /api/model/blueprint`
- `GET /api/backtests/status`
- `GET /api/intelligence/status`
- `GET /api/intelligence/teams`
- `GET /api/intelligence/teams/:team`
- `GET /api/intelligence/players/:id`
- `POST /api/draft/simulate`
- `POST /api/draft/recommendations`
- `POST /api/lineup/optimize`
- `POST /api/lineup/start-sit`
- `POST /api/roster/analyze`
- `POST /api/waivers/recommend`
- `POST /api/trades/analyze`
- `POST /api/trades/generate`
- `POST /api/season/simulate`
- `POST /api/league/simulate`
- `GET /api/platform/status`
- `GET /api/models/status`
- `GET /api/models/drift`
- `GET /api/championship/status`
- `POST /api/championship/evaluate`

Health telemetry identifies whether requests are using native C++, reports feed lineage, integrity, snapshots, model governance, drift, recovery age, queue health, and SLO state. Detailed metrics, manifests, event history, decision history, and model-control writes require local or authenticated administrative access.

## Data and league connections

The bundled snapshot provides an immediate validated fallback. The server can refresh the current ESPN player and schedule feed, validate it, build the projection ensemble, and atomically replace the runtime cache.

Runtime files are stored under `data/runtime` by default. Set `ORACLE_RUNTIME_DIR` to a persistent writable path on managed hosting.

League integrations are read-only:

- Sleeper public API imports settings, users, every roster, current standings, future matchup schedule, draft history, and live draft picks.
- ESPN public leagues import standings, matchup schedule, settings, rosters, and draft history directly.
- ESPN private leagues use `tools/espn-oracle.user.js`, which reads through the user's existing ESPN session and posts a snapshot to the configured Oracle tab.
- Oracle JSON export preserves draft, roster, league, and workspace state.

The ESPN bridge does not send `SWID`, `espn_s2`, or other ESPN cookies to Oracle.

## Native configuration

Important environment variables:

```text
ORACLE_NATIVE_BINARY=
ORACLE_NATIVE_WORKERS=4
ORACLE_NATIVE_DISABLED=false
ORACLE_NATIVE_REQUIRED=false
ORACLE_FORCE_NATIVE_REBUILD=false
ORACLE_DEFAULT_SIMULATIONS=15000
ORACLE_MAX_SIMULATIONS=50000
ORACLE_MAX_QUEUE=64
ORACLE_TASK_TIMEOUT_MS=45000
```

Production containers set `ORACLE_NATIVE_REQUIRED=true`. Local development can leave it false to retain JavaScript fallback when a compiler or binary is unavailable.

Manual data refresh is restricted to loopback requests unless `ORACLE_ADMIN_TOKEN` is configured. Scheduled refreshes continue automatically.

## Privacy and security

- League state and workspaces remain in browser storage unless exported.
- Compute requests contain only the state required for the calculation.
- API bodies, queues, simulation budgets, and task runtimes are bounded.
- Expensive routes are rate limited.
- Native worker crashes are isolated and workers are restarted.
- Static serving uses an allowlist and does not expose server source or environment files.
- Security headers, same-origin APIs, compression, ETags, and atomic cache replacement are enabled.
- Exported Oracle JSON can contain private league information and should be protected.

## Deployment

The Dockerfile builds the C++ engine in a dedicated Alpine builder stage, installs only the runtime C++ library in the final image, and requires native startup. The Azure workflow installs GCC, verifies the native and Node layers, packages the Linux executable, removes compiler-only sources, and deploys the production artifact.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Docker, Azure App Service, persistent storage, environment configuration, health checks, logs, rollback, and recovery.

Docker was not available on the Windows development machine, so the container definition is covered by source review and the native Linux build path in CI rather than a local Docker build.

## Verification

```bash
npm run verify
```

Verification currently covers:

- native C++ compilation and capability handshake
- exact seeded draft parity with JavaScript
- fast draft-mode probability tolerance
- exact lineup parity
- trade-model parity
- FAAB bounds and waiver decisions
- start/sit risk profiles, confidence, correlation, and expected regret
- season distribution ordering and CVaR
- league playoff and championship probability coherence
- native API routing and JavaScript fallback routing
- worker crash isolation, queues, timeouts, health, ETags, and static-source protection
- coaching-model shrinkage, projection effects, staff coverage, and coaching API routes
- leakage-safe historical opportunity regression, analog cohorts, holdout diagnostics, and bounded projection integration
- historical injury availability, practice progression, recovery ramps, major-injury priors, conservative news attribution, and health API routes
- contextual opportunity, ecosystem, matchup, consensus, and uncertainty modeling
- expected-regret and counterfactual decision validation
- leakage-safe walk-forward draft replay, holdout evaluation, historical trade calibration, and waiver challenger tests
- unified multi-week roster-utility and positional-need decision tests
- ideal-engine blueprint coverage and readiness reporting
- client/server syntax and dependency audit
- Linux and Windows CI verification, including native build caching and recovery restore

The current suite contains 101 passing tests, including health and recovery intelligence, coaching intelligence, contextual factor centering, uncertainty decomposition, native expected regret, model-readiness reporting, dataset preload, and crash-reload recovery.

## Repository layout

- `native/src/` — C++20 analysis engine
- `native/third_party/nlohmann/` — vendored JSON header and license
- `native/build.js` — portable compiler detection and native build
- `native/CMakeLists.txt` — standard CMake build
- `server/native-engine-pool.js` — persistent native-process pool
- `server/hybrid-compute-pool.js` — native-first routing and JS fallback
- `server/api.js` — validated analysis and data API
- `server/coaching-model.js` — evidence-shrunk staff, scheme, leadership, and development model
- `server/opportunity-model.js` — historical usage, regression, analog, and age-curve integration
- `server/health-model.js` — live injury, practice, news, return-window, recovery-ramp, and recurrence intelligence
- `server/context-intelligence.js` — team ecosystem, role, matchup, consensus, fragility, and asymmetric outcome model
- `server/engine-blueprint.js` — ideal-engine capability and data-gap registry
- `server/historical-backtest.js` — leakage-safe replay, walk-forward policy selection, and subsystem calibration
- `server/historical-calibration.js` — compact production calibration loader and status reporting
- `server/roster-utility.js` — shared multi-week lineup, need, depth, risk, and historical-value scoring
- `data/coaches-2026.json` — current 2026 staff profiles and model priors
- `data/health-calibration-2026.json` — compact historical availability and recovery priors
- `data/opportunity-2026.json` — compact validated usage models, 2026 profiles, and historical analogs
- `server/index.js` — Fastify application entrypoint
- `app.js` — browser state, rendering, PWA behavior, and integrations
- `app-core.js` — deterministic offline/fallback engine
- `simulation-worker.js` — browser draft fallback
- `scripts/benchmark-native.js` — native-versus-JavaScript benchmark
- `scripts/build-historical-data.js` — archived preseason ranking and nflverse outcome builder
- `scripts/build-opportunity-profiles.js` — leakage-safe position-model trainer and profile builder
- `scripts/build-health-calibration.js` — nflverse availability and recovery calibration builder
- `scripts/run-historical-backtests.js` — full walk-forward replay and policy-calibration runner
- `data/calibration/` — committed compact value curves, policy weights, and benchmark summaries
- `tests/native-engine.test.js` — native parity and model tests
- `tests/native-server.test.js` — native API integration tests
- `docs/ai/native-cpp-engine-plan.md` — implementation plan and acceptance criteria
- `docs/ai/ideal-fantasy-analytics-engine.md` — target architecture, model layers, evaluation, and roadmap
- `docs/ai/context-intelligence-results.md` — contextual model design, diagnostics, regret analysis, and browser validation
- `docs/ai/opportunity-model-results.md` — feature set, leakage controls, holdout results, analogs, and integration
- `docs/ai/health-news-intelligence-results.md` — data sources, calibration, return modeling, news safeguards, and limitations

## Remaining model limits

- Projection quality remains dependent on available source data. C++ increases search depth and speed, not the truthfulness of upstream projections.
- Coaching scores are conservative model priors, not objective personnel ratings; multi-season coach-player calibration remains a priority.
- Historical usage models cover QB/RB/WR/TE and use weekly box-score opportunity rather than route participation, targets per route, red-zone opportunity, or tracking geometry. Role changes are damped by current market signals but cannot be inferred perfectly.
- Team ecosystem, depth-chart share, and matchup grades are inference proxies until snap, route, tracking, betting, offensive-line, and weather feeds are connected.
- Health intelligence uses public designation, body-part, practice, and article metadata; exact diagnosis, surgery date, rehabilitation testing, and team medical clearance are often unavailable. Return estimates describe fantasy performance rather than medical recovery.
- The current ensemble does not independently ingest licensed projections, betting markets, offensive-line grades, route participation, tracking data, or real-time weather.
- League simulations assume the supplied rosters, schedule, and current player distributions; future transactions are not modeled automatically.
- Full waiver accuracy requires complete league rosters. Historical waiver validation approximates availability from undrafted players and does not reconstruct real priority or FAAB competition.
- Trade calibration currently uses synthetic preseason one-for-one offers; manager acceptance, keeper costs, and real transaction histories are not yet modeled.
- Recommendations express expected value and uncertainty, not guaranteed outcomes.
