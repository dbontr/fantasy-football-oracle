# Security Policy

## Supported version

Security fixes are applied to the current `main` release. Historical branches and recovery packages are immutable records, not independently maintained releases.

## Reporting

Do not publish credentials, private league identifiers, personal data, or a working exploit in a public issue. Report the affected version, component, reproduction conditions, expected impact, and whether exploitation requires authenticated or local access through the repository owner's private contact channel.

## Protected data

The application may process league identifiers, team names, rosters, decision history, runtime snapshots, and third-party account metadata. Runtime data remains under `data/runtime/` and is excluded from Git, Docker, and Azure deployment packages unless deliberately mounted as persistent application storage.

Secrets must be supplied through environment variables or the hosting platform's secret store. Never place authentication values in browser state, recovery manifests, event payloads, screenshots, source files, or committed `.env` files.

## Evidence and what-if boundaries

Durable v5 evidence is operational data. Persistent writes through `POST /api/v5/evidence` and raw searches through `GET /api/v5/evidence` require administrator authorization. Public `POST /api/v5/what-if` requests are request-scoped overlays and cannot mutate the ledger. Resolved player evidence exposes bounded provenance summaries, not absolute paths or connector credentials.

Do not include access tokens, private medical records, account identifiers, or licensed raw-feed payloads in evidence metadata. Store connector credentials outside Oracle and ingest only the normalized observation needed for a forecast.

## Public-source network boundary

Free connectors do not accept user-supplied URLs. Each source has fixed HTTPS origins, fixed path prefixes, narrowly scoped redirect origins, response byte limits, cache freshness rules, and a circuit breaker. Cached payloads are SHA-256 verified before every use. Source synchronization and calibration rebuilds are administrator-only.

The application performs no network synchronization during startup. Public what-if forecasts cannot write evidence and are excluded from the production forecast journal. Raw provider caches are ignored by Git and should not contain credentials. Open-Meteo remains disabled unless the operator explicitly acknowledges the hosted free tier's non-commercial restriction.

## Administrative surfaces

Detailed metrics, artifact manifests, event history, decision records, model promotion, rollback, drift writes, and manual refresh are restricted to direct loopback access unless an administrator credential is configured. Requests carrying proxy-forwarding headers always require `ORACLE_ADMIN_TOKEN`, even when the proxy socket is loopback. Public health output intentionally removes absolute filesystem paths and replica destinations; `/api/ready` provides the smaller production probe.

Use TLS at the reverse proxy, restrict allowed origins and networks, rotate credentials after a recovery event, and require multi-factor authentication on source, deployment, backup, and secret-management accounts. Administrative and error responses are marked `no-store`; internal server failures are logged with a request ID and are not returned verbatim to clients.
