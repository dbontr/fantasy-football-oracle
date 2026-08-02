# Recovery and Continuity

Fantasy Football Oracle 5.0 treats recovery as a tested product capability. A backup is not considered useful until checksums, the Git bundle, ignored assets, and an isolated restoration all pass.

## Recovery objectives

- Source and committed model RPO: every accepted commit.
- Runtime, league-state, and decision-ledger RPO: 24 hours by default.
- Local restore smoke RTO: 15 minutes.
- Full dependency, native-build, and test RTO: 60 minutes on supported hardware.
- No single repository host, workstation disk, user account, or cloud credential should hold the only usable copy.

These are engineering objectives, not guarantees. They become real only after independent destinations and credentials are configured and drills are run on the actual deployment.

## Recovery package contents

Each package contains:

- `repository.bundle`: every local Git ref and object;
- `assets.tar.gz`: ignored historical, health, runtime, and generated assets present at backup time;
- `artifact-manifest.json`: semantic checksums for production-critical inputs;
- `git-refs.txt`: the refs expected in the bundle;
- `recovery-manifest.json`: source commit, branch, inputs, encryption intent, and replica targets;
- `CHECKSUMS.sha256`: byte-level integrity evidence;
- `RESTORE.txt`: minimal offline instructions.

The package never copies `.env` files or secrets. Credentials must be recoverable from an independent password manager or secret store.

## Create and verify a package

```bash
npm run backup -- --out ../oracle-recovery
node scripts/verify-backup.js --package ../oracle-recovery/<package-directory>
node scripts/disaster-recovery-drill.js --package ../oracle-recovery/<package-directory>
```

The default command refuses a dirty worktree because a Git bundle cannot preserve uncommitted files. `--allow-dirty` is for emergency capture only and the manifest records that condition.

For a complete rebuild and test:

```bash
node scripts/disaster-recovery-drill.js \
  --package ../oracle-recovery/<package-directory> \
  --full
```

The drill clones into a separate temporary directory, checks out the recorded commit, extracts ignored assets, validates critical artifact hashes, installs from the lockfile, rebuilds C++, and executes the tests. It never restores over the source repository.

## Event-ledger repair

Only one Oracle process may own a runtime ledger at a time. A second instance fails with `EVENT_STORE_LOCKED`; after a crash, a stale local PID lease is removed automatically on the next startup.

When startup reports `EVENT_CHAIN_CORRUPT`, stop all Oracle processes and preview recovery:

```bash
npm run events:repair -- --dry-run
npm run events:repair
```

Recovery selects the longest cryptographically valid branch connected to genesis. It never overwrites the damaged evidence: the original JSONL file is renamed with a `.corrupt-<timestamp>` suffix and a repair report records every omitted line. Keep both files with the incident record and verified backup.
## Encryption

Set the passphrase only in the process environment or passphrase file managed outside the repository:

```bash
export ORACLE_BACKUP_PASSPHRASE='use-a-long-random-secret'
node scripts/backup-oracle.js --encrypt --remove-plaintext
```

Encryption uses AES-256-GCM with an independently generated salt and nonce and a memory-costed scrypt key derivation. GCM authentication makes a wrong passphrase or changed ciphertext fail restoration rather than producing silent corruption.

## Independent replicas

Configure one or more directories using repeated `--target` arguments or `ORACLE_BACKUP_TARGETS`. On Windows, separate environment targets with semicolons; on Linux and macOS, use colons.

```powershell
$env:ORACLE_BACKUP_TARGETS = 'E:\OracleBackups;Z:\Offsite\Oracle'
$env:ORACLE_BACKUP_PASSPHRASE = '<password-manager-secret>'
node scripts/backup-oracle.js --encrypt --read-only
```

A useful production topology is:

1. the Git repository host;
2. an encrypted local package on a separate physical device;
3. an encrypted offsite package under independent credentials;
4. a periodic offline copy that is disconnected after writing.

Copying to two folders on the same disk is not redundancy. Uploading to another service with the same single sign-on account is not independent credential recovery.

## Retention

```bash
node scripts/prune-backups.js --dry-run
node scripts/prune-backups.js --daily 14 --weekly 8 --monthly 12
```

The default grandfather-father-son policy retains the 14 newest packages, one checkpoint for each of the eight newest ISO weeks, and one checkpoint for each of the 12 newest months. Retention never substitutes for verification.

## GitHub recovery workflow

`.github/workflows/recovery-bundle.yml` creates, verifies, restores, and uploads a package every day and on demand. Workflow artifacts provide an additional recovery channel for committed source and model artifacts. They do not contain workstation-only raw data unless that data is deliberately made available to the runner.

## Disaster scenarios

### Workstation loss

1. Obtain a verified recovery package and the independent passphrase.
2. Run `verify-backup.js` on a clean machine.
3. Run the full recovery drill.
4. Configure secrets from the independent secret store.
5. Start with strict artifact integrity enabled.
6. Compare API platform status and model-registry champions with the last incident record.

### Repository-host account loss

1. Restore from the Git bundle, not from an unverified source archive.
2. Create a repository under independent credentials.
3. Push all branches and tags only after `git fsck` and the recovery drill pass.
4. Rotate deployment credentials and webhook secrets before resuming automation.

### Corrupt model or data deployment

1. Stop automatic refresh and model promotion.
2. Inspect `/api/platform/status` and the artifact manifest.
3. Roll back the affected model through the model registry.
4. Restore the last verified compact artifact and regenerate the manifest.
5. Re-run the historical holdout gate before promotion.

### Ransomware or malicious deletion

Do not mount every backup target continuously. Restore from an offline or immutable package created before the compromise, rotate every credential, and review the event-chain head and Git history before trusting the restored environment.

## Required manual controls

The repository cannot create independent cloud accounts, hardware media, MFA recovery codes, or legal access to third-party data. Record those controls outside this repository and test them at least quarterly. A recovery drill that depends on the same unavailable account as production has failed even when the bytes are intact.
