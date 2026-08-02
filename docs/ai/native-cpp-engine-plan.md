# Native C++ Analysis Engine

## Objective

Move the compute-heavy fantasy-football decision system from JavaScript into a C++20 native engine while retaining Node.js only for HTTP, data ingestion, league integrations, validation, and orchestration.

The native engine must improve throughput without weakening model behavior, determinism, fault isolation, or browser fallback.

## Native boundary

A pool of persistent native worker processes receives newline-delimited JSON requests over stdin and returns newline-delimited JSON responses over stdout. Each worker loads the modeled player dataset once and keeps reusable indexes in memory.

Node remains responsible for:

- Fastify routes, security, rate limits, and request validation
- ESPN and Sleeper data refresh and normalization
- native process lifecycle, queueing, timeout, and restart
- browser fallback compatibility

C++ becomes responsible for the expensive analysis kernels.
## Phase 1 — native runtime foundation

- Add a portable CMake build and Docker builder stage.
- Add a self-contained JSON protocol and versioned native capability handshake.
- Add a bounded Node native-process pool with health, crash restart, queue limits, and per-task timeouts.
- Fall back to the existing JavaScript worker pool when the binary is unavailable.

## Phase 2 — C++ decision kernels

Port and test:

- exact lineup assignment for weekly and rest-of-season metrics
- Monte Carlo draft-window simulation
- conditional return probability, tier pressure, and VONA
- bilateral trade analysis and package generation
- week-aware waiver add/drop search
- roster health, positional grades, and uncertainty ranges

## Phase 3 — stronger analysis

Add native-only capabilities beyond the JavaScript baseline:

- correlated season simulation for starters and bench replacements
- playoff qualification and championship probability estimates
- expected wins and all-play strength
- downside/CVaR and ceiling-aware lineup modes
- FAAB recommendation based on replacement value and future scarcity
- opponent-specific draft tendency adaptation from observed picks
## Compatibility

- Existing API request and response shapes remain valid.
- Native responses include engine name, version, compute time, and model digest.
- The JavaScript implementation remains available for browser/offline use and native parity tests.
- A native worker crash affects only one request and is automatically replaced.

## Acceptance criteria

- Clean native build on Windows and in the production Docker image.
- Deterministic seeded simulation and optimization results.
- Native and JavaScript parity within documented numeric tolerances.
- Native route integration tests cover startup, fallback, timeout, malformed requests, and restart.
- Native draft and trade workloads outperform the JavaScript worker implementation on representative league sizes.
- All existing browser and server tests continue to pass.

## Verification strategy

1. Unit-test native algorithms directly through the protocol.
2. Compare native output against fixed JavaScript fixtures.
3. Benchmark cold start, warm request latency, throughput, and memory.
4. Exercise the full browser-to-Node-to-C++ path in Edge.
5. Run syntax checks, native build, Node tests, security audit, and Git diff review.