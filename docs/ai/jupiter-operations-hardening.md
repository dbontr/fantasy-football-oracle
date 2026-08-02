# Jupiter Operations Hardening

## Objective

Make Jupiter the sole active development and local-service host for Fantasy Football Oracle while preserving deterministic recovery and GitHub verification.

## Scope

1. Add an idempotent, timeout-bounded server shutdown controller.
2. Add a deployment doctor that verifies runtime, Git drift, production policy, native capabilities, artifact integrity, and writable state directories.
3. Add a Windows scheduled-task manager with strict defaults, safe `.env.local` parsing, readiness gating, logs, PID validation, smoke testing, and restart support.
4. Extend CI and documentation for the doctor and Windows service workflow.
5. Install and smoke-test the service on Jupiter only after the source and recovery checks pass.

## Acceptance criteria

- Jupiter and `origin/main` match exactly with a clean worktree.
- Unit and integration tests pass on Jupiter.
- Strict doctor reports no failures before service startup.
- The scheduled task starts Oracle with native compute and strict artifact integrity.
- `/api/ready`, `/api/health`, and browser-shell smoke checks pass.
- Recovery restores and verifies the final commit.
- Saturn contains no development checkout.
