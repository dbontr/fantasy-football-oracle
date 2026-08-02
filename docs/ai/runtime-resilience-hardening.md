# Runtime Resilience Hardening

## Scope

This release hardens the boundary between the Node.js control plane, JavaScript workers, persistent native workers, and the Windows scheduled-task manager.

## Native supply-chain integrity

The native cache key now includes every compilation input under `native/src` and `native/third_party`, including headers and `.inc` fragments, plus build helpers, flags, and the compiler version. A cache hit also requires the executable SHA-256 to match schema-2 `build-metadata.json` and a valid capability handshake.

Production strict mode passes the metadata path to the native pool. A mismatched binary is rejected before execution. The deployment doctor reports the input and binary digests independently from the release artifact manifest.

## Process supervision

JavaScript and native workers use bounded exponential restart backoff. Health telemetry separates configured, live, restarting, ready, and busy workers. Readiness requires at least one live native worker when native compute is mandatory, while a fully busy but live pool remains ready.

Task deadlines now begin when work is queued rather than when a worker becomes available. Requests therefore fail with a bounded timeout even if every worker is restarting. Unexpected worker exits, including a zero exit code without an intentional pool close, trigger supervised replacement.

## Lifecycle cleanup

Server cleanup attempts every component even when one component fails. Startup and listen failures preserve the initiating error while still closing the control plane, dataset subscription, data store, compute pools, and ephemeral runtime state. Any failed or timed-out shutdown forces process termination after logging the correlated failure.

The Windows manager writes a runtime-scoped shutdown request. The server removes that request and enters the same idempotent shutdown controller used for `SIGINT` and `SIGTERM`. The manager waits for graceful exit before using scheduled-task or process termination as a fallback.

## Verification evidence

Automated tests cover cache invalidation, binary tamper detection, versioned portable compiler discovery, capability rejection, restart backoff, queue-inclusive timeouts, live-worker readiness, generic close failures, shutdown-request handling, and listen-failure cleanup.

The Windows CI lane runs `scripts/windows/test-oracle-service.ps1` after normal verification. It starts the strict service with an isolated runtime directory, checks readiness, runs production smoke, stops through the shutdown-request channel, and verifies that PID and request files are removed.
