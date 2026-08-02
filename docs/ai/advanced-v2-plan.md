# Fantasy Football Oracle Advanced V2

## Revised objective

Build a full-stack fantasy decision system rather than restricting the application to GitHub Pages.
The browser remains the interactive client and offline fallback. A Node service becomes the primary
calculation and data layer for deeper simulations, richer projection models, persistent caches, and
league-wide analysis.

The system should answer four high-value questions:

1. Who should I draft now, and what is the probability each target survives to my next pick?
2. What is my strongest lineup this week, including uncertainty, opponent, bye, and injury context?
3. Which waiver moves create the largest weekly and rest-of-season improvement?
4. Which trades improve my team while remaining rational for the opposing roster?

## Architecture

- `index.html`, `app.js`, and `styles.css`: responsive browser client.
- `app-core.js`: deterministic shared calculation library used by browser and server workers.
- `server/`: Node API, data refresh jobs, cache management, and worker-thread compute pool.
- `data/runtime/`: generated server-side snapshots and model metadata; excluded from Git.
- Browser Web Worker: offline and server-unavailable fallback.
- Server worker threads: primary Monte Carlo, roster, waiver, and trade computations.

## Phase 1 — advanced client foundation

- Bundle 18-week projections, NFL schedule, bye weeks, floor/ceiling, volatility, and reliability.
- Add conditional availability, VONA, positional run pressure, and seeded draft simulation.
- Add week-specific lineup optimization, roster grading, and two-sided trade evaluation.
- Add installable/offline application behavior.

Acceptance: deterministic engine tests pass and all advanced fields remain optional for old exports.

## Phase 2 — server compute and data platform

- Serve the application from a production Node service.
- Add health, player-data, refresh, draft simulation, roster analysis, waiver, and trade APIs.
- Run expensive requests in a bounded worker-thread pool.
- Cache refreshed source data and derived model snapshots on disk.
- Validate request sizes and cap compute budgets to prevent resource exhaustion.

Acceptance: the frontend uses server compute when available and automatically falls back to browser
workers when the service is offline.

## Phase 3 — stronger projection ensemble

- Blend ESPN weekly projections, prior production, role stability, ADP market signal, ownership,
  injury state, schedule context, and uncertainty into calibrated weekly distributions.
- Add projection provenance and timestamps.
- Track model confidence separately from player volatility.
- Support later addition of authenticated or licensed projection sources without changing the client.

## Phase 4 — league intelligence

- Persist every imported roster and league setting.
- Generate pruned 1-for-1, 2-for-1, 1-for-2, and selected 2-for-2 proposals.
- Evaluate both teams' lineup impact, positional need, consolidation, depth, and fairness.
- Add server-side free-agent and waiver opportunity search against the actual league player pool.

Acceptance: connected leagues produce opponent-specific proposals and week-aware waiver moves.

## Phase 5 — deployment and operations

- Provide Docker and Azure App Service deployment paths.
- Add environment configuration, structured logs, graceful shutdown, and health checks.
- Add integration tests for all API routes and worker failures.
- Document data-source limitations, privacy behavior, and recovery procedures.

## Compatibility and rollback

- Existing local-storage state is migrated by `hydrateState`; no destructive reset is required.
- The browser worker remains available when server computation fails.
- Server data refresh never overwrites the bundled snapshot unless a complete replacement validates.
- Each architectural phase is committed independently for straightforward rollback.
