# Deployment

Fantasy Football Oracle is a native C++/Node.js application. Fastify serves the browser client, refreshes source data, and supervises a pool of persistent C++ analysis processes. A JavaScript worker pool remains available for legacy-task fallback.

## Production requirements

- Node.js 20 or newer; Node.js 24 is used by the Docker image.
- A C++20 compiler during build: GCC, Clang, or MSVC.
- The C++ standard runtime in the deployed image.
- At least 1 CPU core and 512 MB RAM; 2–4 cores and 1 GB or more are recommended.
- A writable runtime-data directory.
- Outbound HTTPS access to ESPN and Sleeper public endpoints.

The process listens on the platform-provided `PORT` and `0.0.0.0` by default. Use the minimal `GET /api/ready` response for readiness probes; use `GET /api/health` for detailed native-engine and control-plane telemetry.

## Local production run

```bash
npm ci --ignore-scripts
npm run verify
npm run doctor
npm start
```

`npm run verify` compiles `native/bin/oracle-engine` or `oracle-engine.exe`, validates its capability handshake, checks client and server scripts, runs the test suite, and audits dependencies.

The production package also includes `data/calibration/historical-value.json`, `historical-backtest-summary.json`, `data/opportunity-2026.json`, and `data/health-calibration-2026.json`. They contain compact policy weights, historical value curves, coverage diagnostics, and benchmark summaries. Raw historical downloads, health-report downloads, and season caches are ignored and are not required at runtime. The compact opportunity artifact contains validated coefficients, diagnostics, profiles, and analog summaries; rebuild it deliberately with `npm run build:opportunity -- --history-root <nflverse-raw-directory>`. Rebuild calibration deliberately with `npm run backtest:history`; do not run that multi-season job during application startup.

Set `CXX` when the compiler is not discoverable:

```bash
CXX=g++ npm run build:native
```

The application does not automatically load `.env`; pass settings through the shell, process manager, container, or hosting platform.
## Native engine settings

```text
ORACLE_NATIVE_BINARY=
ORACLE_NATIVE_BUILD_METADATA=
ORACLE_NATIVE_WORKERS=4
ORACLE_NATIVE_DISABLED=false
ORACLE_NATIVE_REQUIRED=true
ORACLE_WORKERS=2
ORACLE_MAX_QUEUE=64
ORACLE_TASK_TIMEOUT_MS=45000
ORACLE_DEFAULT_SIMULATIONS=15000
ORACLE_MAX_SIMULATIONS=50000
ORACLE_RUNTIME_DIR=/persistent/oracle-runtime
ORACLE_TRUST_PROXY=true
```

`ORACLE_NATIVE_WORKERS` controls persistent C++ processes. `ORACLE_WORKERS` controls JavaScript fallback workers. Start with native workers equal to roughly half the available CPU cores, then watch queue depth and latency in `/api/health`.

Production should set `ORACLE_NATIVE_REQUIRED=true`; startup then fails rather than silently deploying without the intended engine. Local development may leave it false.

## Windows scheduled-task service

The Windows service manager runs Oracle as an at-logon scheduled task without storing a Windows account password:

```powershell
npm run service:windows:install
npm run service:windows:status
npm run service:windows:smoke
```

The task runs `npm run doctor -- --strict --json` before every start. The doctor validates the complete native capability contract and verifies the executable SHA-256 against builder-generated metadata before the service can become ready. It refuses to launch when the repository is dirty or behind its upstream, native compute is unavailable, release artifacts are invalid, required production flags are disabled, the runtime directories are not writable, or a trusted proxy lacks `ORACLE_ADMIN_TOKEN`.

Optional machine-local settings belong in ignored `.env.local`:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
ORACLE_NATIVE_REQUIRED=true
ORACLE_STRICT_ARTIFACT_INTEGRITY=true
ORACLE_ADMIN_TOKEN=<random-secret>
```

The parser accepts literal `NAME=value` lines only and does not execute PowerShell. Runtime PID and log files are stored under `data/runtime/service`. Use `npm run service:windows:restart`, `service:windows:stop`, or `service:windows:uninstall` for lifecycle control. Stop writes a shutdown request consumed by the Node lifecycle controller, waits for resource cleanup, and force-terminates only when the bounded graceful window expires.
Use `npm run service:windows:install -- -RuntimeDir D:\oracle-runtime` when state must live outside the checkout or when validating an isolated secondary instance. PID, log, and shutdown-request files follow the selected runtime directory. Run `npm run service:windows:test` for an isolated strict launch/readiness/smoke/graceful-stop verification without installing a scheduled task.

## Docker

The included multi-stage Dockerfile:

1. installs GCC in a builder stage,
2. compiles the Linux C++20 executable,
3. installs production Node dependencies in a separate stage,
4. copies the executable, its SHA-256 build metadata, and the application into the runtime image,
5. installs `libstdc++`, runs as the unprivileged `node` user, enables strict artifact integrity, and checks `/api/ready`.

```bash
docker build -t fantasy-football-oracle .
docker run --rm \
  --name fantasy-football-oracle \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -p 8787:8787 \
  -e ORACLE_NATIVE_WORKERS=4 \
  -e ORACLE_WORKERS=2 \
  -e ORACLE_RUNTIME_DIR=/app/data/runtime \
  -v oracle-runtime:/app/data/runtime \
  fantasy-football-oracle
```

The CI workflow builds and runs the image with a read-only root filesystem, dropped capabilities, `no-new-privileges`, and strict production smoke validation before promotion.

For a reverse proxy, terminate TLS at the proxy, set `ORACLE_TRUST_PROXY=true`, forward the original host/protocol/client-IP headers, and keep the browser shell and `/api` on the same origin. Configure `ORACLE_ADMIN_TOKEN`: every forwarded administrative request requires the bearer token, even when the proxy connects over loopback.

## Azure App Service source deployment

The repository includes `.github/workflows/azure-app-service.yml`. The workflow:

- installs GCC on the Linux runner,
- installs locked Node dependencies without lifecycle scripts,
- builds and tests the native executable,
- runs the security audit,
- marks the executable as runnable,
- removes native source, headers, and compiler-only files,
- prunes development dependencies,
- deploys the verified package.

Configure App Service:

```bash
az webapp config set \
  --resource-group <resource-group> \
  --name <app-name> \
  --startup-file "npm start"

az webapp config appsettings set \
  --resource-group <resource-group> \
  --name <app-name> \
  --settings \
    ORACLE_RUNTIME_DIR=/home/oracle-runtime \
    ORACLE_NATIVE_REQUIRED=true \
    ORACLE_STRICT_ARTIFACT_INTEGRITY=true \
    ORACLE_ADMIN_TOKEN=<secret> \
    ORACLE_NATIVE_WORKERS=2 \
    ORACLE_WORKERS=1 \
    ORACLE_DEFAULT_SIMULATIONS=15000 \
    ORACLE_MAX_SIMULATIONS=50000 \
    ORACLE_TRUST_PROXY=true
```

Use a paid Linux plan for sustained native calculations. Scale CPU before increasing the native-worker count.

Before manually dispatching the workflow:

1. Create repository variable `AZURE_WEBAPP_NAME`.
2. Create a protected `production` environment.
3. Add `AZURE_WEBAPP_PUBLISH_PROFILE` as an environment secret.
4. Configure the App Service settings and startup command.
5. Run **Deploy Azure App Service** from GitHub Actions.
## Azure custom container

Build the Docker image in CI, push it to Azure Container Registry, and deploy an App Service Web App for Containers. Configure the container port as `8787` or provide the platform-selected `PORT`.

Mount persistent storage at `/home/oracle-runtime` and set:

```text
PORT=8787
ORACLE_RUNTIME_DIR=/home/oracle-runtime
ORACLE_NATIVE_REQUIRED=true
ORACLE_STRICT_ARTIFACT_INTEGRITY=true
ORACLE_ADMIN_TOKEN=<secret>
ORACLE_NATIVE_WORKERS=2
ORACLE_WORKERS=1
ORACLE_DEFAULT_SIMULATIONS=15000
ORACLE_MAX_SIMULATIONS=50000
ORACLE_TRUST_PROXY=true
```

## Health and operations

`GET /api/ready` returns a small no-store readiness document. It returns HTTP 503 when player data is unavailable, required native workers are unavailable, strict artifact integrity fails, or the event chain is invalid. It intentionally excludes detailed model, event, and backup state.
A fully busy native pool remains ready: `readyWorkers` reports currently idle capacity and may be zero under load, while readiness requires a valid native engine and at least one live worker. `liveWorkers` and `restartingWorkers` distinguish usable capacity from configured capacity. Queue depth and saturation remain visible in `/api/health`.

`GET /api/health` reports:

- application and architecture version,
- native engine name, version, language, worker count, queue depth, completed tasks, failures, and restarts,
- JavaScript fallback worker statistics,
- model version and data freshness,
- simulation budgets and uptime,
- historical-calibration readiness and replay evidence,
- opportunity-model coverage, holdout diagnostics, and version.

`GET /api/health-intelligence/status` reports health-feed coverage, calibration version, affected-player counts, and recovery diagnostics.

`GET /api/backtests/status` reports the committed calibration version, replay counts, selected policy, trade and waiver diagnostics, coverage, and known limitations. `GET /api/opportunity/status` reports the opportunity model, leakage controls, position diagnostics, and untouched-holdout performance.

`GET /api/data/status` reports refresh age and the most recent refresh failure. Logs are structured JSON when the Fastify logger is enabled.

A native worker crash rejects only its active task, schedules a replacement with bounded exponential backoff, and leaves the API running. Queue time counts toward the same task deadline, so requests cannot wait forever while every worker is restarting. Process shutdown is idempotent and bounded; a stalled close fails closed after 20 seconds rather than leaving an indefinitely half-stopped service. Repeated native failures appear in health telemetry. When `ORACLE_NATIVE_REQUIRED=true`, startup fails if the binary cannot be probed.

Scale vertically before scaling worker counts. Too many native processes increase CPU contention and memory pressure. Multiple web instances can serve independent browser users, although each instance maintains its own runtime data cache.

## Recovery and rollback

The bundled `data/players-2026.json` remains the validated data fallback. Removing the runtime cache causes the next start to load the bundle and schedule a fresh refresh.

Historical calibration and opportunity models are versioned with the application. Roll back `data/calibration/` and `data/opportunity-2026.json` and `data/health-calibration-2026.json` together with the server code so projections, recommendation weights, and evidence remain aligned.

A rollback does not require a database migration. Restore the prior application version and its matching native executable, retain or delete the runtime cache, and restart. Browser exports remain compatible because native analysis fields are optional.

Browser draft, roster, trade, and connection state live in browser storage. Export state before changing origin or clearing site data.

## Administrative refresh

Scheduled refreshes require no credential. `POST /api/data/refresh` is protected:

- with `ORACLE_ADMIN_TOKEN`, callers send `Authorization: Bearer <token>`;
- without a token, administrative calls are accepted only from a direct loopback socket;
- any request containing standard proxy-forwarding headers requires the token, even when the proxy socket is loopback.

Successful administrative responses and all error responses are marked `Cache-Control: no-store`. Internal 5xx details remain in structured logs; callers receive a generic message and a request ID for correlation. Store the token in the hosting secret store, never in the repository.

## Version 4.0 control plane

Production should configure a persistent writable `ORACLE_PLATFORM_RUNTIME_DIR`. This directory stores the append-only event chain, immutable snapshot catalog, decision ledger, runtime model registry, drift observations, and the latest verified backup status. It must not be served as static content.

Set `ORACLE_STRICT_ARTIFACT_INTEGRITY=true` after the release manifest is generated and shipped. Strict mode prevents startup when a committed model, calibration file, lockfile, package definition, model registry, or SBOM differs from `data/artifact-manifest.json`.

Recommended production variables:

```text
ORACLE_PLATFORM_RUNTIME_DIR=/home/oracle/platform
ORACLE_STRICT_ARTIFACT_INTEGRITY=true
ORACLE_BACKUP_RPO_MS=86400000
ORACLE_MAX_CHAMPIONSHIP_ACTIONS=24
ORACLE_CHAMPIONSHIP_TIMEOUT_MS=180000
ORACLE_HTTP_P95_SLO_MS=3000
ORACLE_CHAMPIONSHIP_P95_SLO_MS=180000
ORACLE_MIN_PLAYER_COVERAGE=600
```

The public `GET /api/platform/status` response is path-redacted. Metrics, Prometheus output, manifests, event history, decision history, and model-control operations use the same loopback-or-bearer authorization as manual refresh. Protect them with TLS and network policy when routed outside the host.

Before packaging a release:

```bash
npm ci --ignore-scripts
npm run manifest:generate
npm run verify:offline
```

The generated files `data/artifact-manifest.json`, `MANIFEST.sha256`, and `artifacts/sbom.cdx.json` are release inputs and must be reviewed with the code and compact model artifacts. Regenerate them only after intentional byte changes.

## Recovery deployment

The application deployment is not itself a backup. Run the recovery command from a trusted repository checkout and copy the verified output to independent destinations:

```bash
node scripts/backup-oracle.js --encrypt --read-only --target /mnt/offline/oracle
node scripts/verify-backup.js --package /path/to/package
node scripts/disaster-recovery-drill.js --package /path/to/package --full
```

Use an independently stored `ORACLE_BACKUP_PASSPHRASE`. Do not place it in App Service settings that share the same administrator and recovery path as the application. The scheduled GitHub recovery workflow protects committed source and compact artifacts, but workstation-only raw data requires a separately configured replica target.

See `docs/RECOVERY.md`, `docs/OPERATIONS.md`, and `SECURITY.md` before enabling production traffic.
