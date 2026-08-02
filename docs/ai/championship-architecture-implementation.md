# Championship Architecture Implementation

Status: active implementation
Branch: `ai/championship-architecture`
Target release: `4.0.0`

## Objective

Build the executable architecture behind the two-week championship checklist. The result must preserve the existing native analysis engine while adding disaster recovery, provenance, live-event resilience, championship-equity orchestration, governance, and operational controls.

No software can guarantee a fantasy championship or absolute immunity from loss. The architecture instead removes avoidable single points of failure, makes recovery testable, and optimizes decisions against league-specific title probability.

## Phase 1 - Verifiable data and artifact foundation

Files and interfaces:

- `server/schema-registry.js`
- `server/lineage.js`
- `server/artifact-registry.js`
- `scripts/generate-asset-manifest.js`
- `scripts/validate-artifacts.js`

Acceptance criteria:

- normalized records carry source, source time, fetch time, confidence, schema version, and content hash;
- deployment-critical artifacts are checksum-addressed;
- startup reports mismatches and can fail closed when strict integrity is enabled;
- identical inputs produce identical semantic manifests.

## Phase 2 - Durable event, snapshot, and decision history

Files and interfaces:

- `server/event-store.js`
- `server/snapshot-catalog.js`
- `server/decision-ledger.js`

Acceptance criteria:

- events are append-only and hash-chained;
- snapshots are written atomically and indexed by deterministic digest;
- every recommendation can be replayed from model, dataset, league-state, and seed identifiers;
- corrupted chains and snapshots are detected before use.

## Phase 3 - Resilience and observability control plane

Files and interfaces:

- `server/resilience.js`
- `server/observability.js`
- `server/platform-control-plane.js`

Acceptance criteria:

- external calls use deadlines, bounded retries, jitter, and circuit breakers;
- last-known-good data is explicit and age-labeled;
- metrics cover feeds, models, native workers, queues, decisions, and latency;
- readiness distinguishes healthy, degraded, stale, and unsafe states.

## Phase 4 - Championship-equity decision engine

Files and interfaces:

- `server/league-state.js`
- `server/championship-optimizer.js`
- `POST /api/championship/evaluate`
- `GET /api/championship/status`

Acceptance criteria:

- exact league rules, standings, schedule, rosters, playoff format, and team identity are validated;
- baseline and candidate actions are simulated with paired seeds;
- actions are ranked by title probability, then playoff probability, downside risk, and expected points;
- results include counterfactual reversal conditions, sensitivity, confidence, and provenance;
- invalid or incomplete league state cannot be represented as high confidence.

## Phase 5 - Operations and recovery automation

Files and interfaces:

- `scripts/backup-oracle.js`
- `scripts/verify-backup.js`
- `scripts/disaster-recovery-drill.js`
- `scripts/generate-sbom.js`
- `.github/workflows/ci.yml`
- `.github/workflows/recovery-bundle.yml`

Acceptance criteria:

- one command creates a Git bundle, asset archive, manifest, checksums, and recovery metadata;
- verification detects missing refs, changed bytes, zero-byte artifacts, or corrupt archives;
- a restore drill can rebuild into a temporary directory without touching the source tree;
- CI exercises syntax, native build, tests, artifact integrity, and recovery packaging.

## Phase 6 - API, UI, and governance integration

Files and interfaces:

- `server/api.js`
- `server/index.js`
- `server/data-store.js`
- `index.html`, `app.js`, `styles.css`
- `docs/RECOVERY.md`, `docs/OPERATIONS.md`

Acceptance criteria:

- health responses expose lineage, integrity, freshness, SLO, and recovery status;
- compute responses include a non-breaking recommendation envelope and decision identifier;
- the browser presents championship readiness, current title-equity context, stale-data warnings, and recovery state;
- decision records remain queryable without exposing secrets or unrestricted local files;
- champion-challenger deployment metadata is visible and reversible.

## Compatibility and rollback

- Existing API `data` payloads remain unchanged; architecture metadata is additive.
- Existing native task protocol remains version 1.1.0 unless a required capability cannot be expressed externally.
- Strict artifact enforcement is opt-in until the committed manifest is generated and validated.
- Runtime state is stored under `data/runtime/` and remains ignored by Git.
- Every new service accepts an injected clock and filesystem location for deterministic tests.
- The branch can be discarded without changing `main`; integration occurs only after fresh verification.

## Verification strategy

Each phase adds focused Node tests. Final verification includes clean dependency install, syntax checks, native compilation, full tests, artifact validation, backup creation and verification, disaster-recovery smoke, live API checks, desktop/mobile browser checks, diff audit, secret scan, and Git status review.
