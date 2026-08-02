# Security Policy

## Supported version

Security fixes are applied to the current `main` release. Historical branches and recovery packages are immutable records, not independently maintained releases.

## Reporting

Do not publish credentials, private league identifiers, personal data, or a working exploit in a public issue. Report the affected version, component, reproduction conditions, expected impact, and whether exploitation requires authenticated or local access through the repository owner's private contact channel.

## Protected data

The application may process league identifiers, team names, rosters, decision history, runtime snapshots, and third-party account metadata. Runtime data remains under `data/runtime/` and is excluded from Git, Docker, and Azure deployment packages unless deliberately mounted as persistent application storage.

Secrets must be supplied through environment variables or the hosting platform's secret store. Never place authentication values in browser state, recovery manifests, event payloads, screenshots, source files, or committed `.env` files.

## Administrative surfaces

Detailed metrics, artifact manifests, event history, decision records, model promotion, rollback, drift writes, and manual refresh are restricted to direct loopback access unless an administrator credential is configured. Requests carrying proxy-forwarding headers always require `ORACLE_ADMIN_TOKEN`, even when the proxy socket is loopback. Public health output intentionally removes absolute filesystem paths and replica destinations; `/api/ready` provides the smaller production probe.

Use TLS at the reverse proxy, restrict allowed origins and networks, rotate credentials after a recovery event, and require multi-factor authentication on source, deployment, backup, and secret-management accounts. Administrative and error responses are marked `no-store`; internal server failures are logged with a request ID and are not returned verbatim to clients.
