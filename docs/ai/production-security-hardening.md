# Production Security Hardening

## Objective

Reduce production attack surface and make deployment health checks reflect actual service readiness without changing fantasy-analysis behavior.

## Implemented boundaries

- Administrative access uses a case-insensitive bearer scheme and constant-time digest comparison.
- Direct loopback remains available for local administration when no token is configured.
- Requests carrying standard proxy-forwarding headers always require `ORACLE_ADMIN_TOKEN`.
- Successful administrative responses and all error responses use `Cache-Control: no-store`.
- Internal 5xx details remain in structured logs; clients receive a request ID and generic message.

## Readiness contract

`GET /api/ready` returns HTTP 200 only when:

- player data is initialized,
- required native workers are available,
- strict artifact verification is valid when enabled,
- the append-only event chain is valid.

The endpoint is intentionally smaller than `/api/health` and is suitable for container and load-balancer probes.
## Container contract

The production image:

- requires native C++ startup and strict artifact integrity,
- runs as the unprivileged Node user,
- removes tests, documentation, native source, and compiler-only files,
- exposes `/api/ready` as the Docker health check.

CI runs the image with a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, a bounded temporary filesystem, and a dedicated runtime volume.

## Verification

Acceptance requires:

- focused authorization, readiness, error, and smoke tests,
- the complete Node/native suite,
- artifact validation and dependency audit,
- strict local service smoke validation,
- Linux, Windows, and hardened-container GitHub Actions,
- a verified recovery package and isolated full restore drill.

No data-model, projection, league-equity, or recommendation semantics are intentionally changed.
