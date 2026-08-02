#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const { buildArtifactManifest } = require("../server/artifact-registry.js");
const {
  RECOVERY_FORMAT_VERSION,
  run,
  checksumEntries,
  writeChecksums,
  verifyChecksumEntries,
  encryptFile,
  createTarGzip,
  copyPackage,
  makeReadOnly,
  timestampId,
} = require("./lib/recovery.js");

function parseArgs(argv) {
  const options = { targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.rootDir = argv[++index];
    else if (value === "--out") options.outputRoot = argv[++index];
    else if (value === "--target") options.targets.push(argv[++index]);
    else if (value === "--allow-dirty") options.allowDirty = true;
    else if (value === "--encrypt") options.encrypt = true;
    else if (value === "--remove-plaintext") options.removePlaintext = true;
    else if (value === "--read-only") options.readOnly = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function git(rootDir, args) {
  return String(run("git", args, { cwd: rootDir }).stdout || "").trim();
}

async function existingPaths(rootDir, rows) {
  const existing = [];
  for (const relative of rows) {
    try {
      await fs.access(path.join(rootDir, relative));
      existing.push(relative.replaceAll("\\", "/"));
    } catch {}
  }
  return existing;
}

async function createPackageDirectory(outputRoot, packageId) {
  await fs.mkdir(outputRoot, { recursive: true });
  const packageDirectory = path.join(outputRoot, packageId);
  await fs.mkdir(packageDirectory, { recursive: false });
  return packageDirectory;
}

async function createBackup(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const outputRoot = path.resolve(options.outputRoot || path.join(rootDir, "..", "oracle-recovery"));
  const status = git(rootDir, ["status", "--porcelain"]);
  if (status && !options.allowDirty) {
    const error = new Error("Repository has uncommitted changes; commit them or pass --allow-dirty");
    error.code = "BACKUP_DIRTY_REPOSITORY";
    throw error;
  }
  const commit = git(rootDir, ["rev-parse", "HEAD"]);
  const branch = git(rootDir, ["branch", "--show-current"]) || "detached";
  const packageId = `oracle-${timestampId()}-${commit.slice(0, 12)}`;
  const packageDirectory = await createPackageDirectory(outputRoot, packageId);

  const bundlePath = path.join(packageDirectory, "repository.bundle");
  run("git", ["bundle", "create", bundlePath, "--all"], { cwd: rootDir });
  run("git", ["bundle", "verify", bundlePath], { cwd: rootDir });
  const refs = git(rootDir, ["show-ref"]);
  await fs.writeFile(path.join(packageDirectory, "git-refs.txt"), `${refs}\n`, "utf8");

  const assetPaths = await existingPaths(rootDir, [
    "data/historical/raw",
    "data/historical/cache",
    "data/health/raw",
    "data/runtime",
    "artifacts",
  ]);
  const assetArchive = path.join(packageDirectory, "assets.tar.gz");
  createTarGzip(rootDir, assetArchive, assetPaths);

  const artifactManifest = await buildArtifactManifest(rootDir, undefined, { commit, generatedAt: null });
  await fs.writeFile(
    path.join(packageDirectory, "artifact-manifest.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
    "utf8",
  );
  const metadata = {
    version: RECOVERY_FORMAT_VERSION,
    packageId,
    createdAt: new Date().toISOString(),
    repository: {
      branch,
      commit,
      dirty: Boolean(status),
      remotes: git(rootDir, ["remote", "-v"]).split(/\r?\n/).filter(Boolean),
      refs: refs.split(/\r?\n/).filter(Boolean).length,
    },
    assets: {
      includedPaths: assetPaths,
      archive: "assets.tar.gz",
    },
    artifactManifestDigest: artifactManifest.semanticDigest,
    encryption: null,
    replicas: [],
  };
  await fs.writeFile(
    path.join(packageDirectory, "recovery-manifest.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(packageDirectory, "RESTORE.txt"),
    [
      "Fantasy Football Oracle recovery package",
      "",
      "1. Verify: node scripts/verify-backup.js --package <this-directory>",
      "2. Restore: node scripts/disaster-recovery-drill.js --package <this-directory> --full",
      "3. The Git bundle contains all refs present when this package was created.",
      "4. assets.tar.gz contains ignored/raw/runtime assets that existed at backup time.",
      "5. Keep at least one verified package under independent credentials and immutable retention.",
      "",
    ].join("\n"),
    "utf8",
  );

  const coreFiles = [
    "repository.bundle",
    "assets.tar.gz",
    "git-refs.txt",
    "artifact-manifest.json",
    "recovery-manifest.json",
    "RESTORE.txt",
  ];
  let checksumRows = await checksumEntries(packageDirectory, coreFiles);
  await writeChecksums(packageDirectory, checksumRows);
  checksumRows = await checksumEntries(packageDirectory, [...coreFiles, "CHECKSUMS.sha256"]);
  const checksumVerification = await verifyChecksumEntries(packageDirectory, checksumRows);
  if (!checksumVerification.valid) throw new Error("New recovery package failed checksum verification");

  const configuredTargets = [
    ...(options.targets || []),
    ...String(process.env.ORACLE_BACKUP_TARGETS || "")
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean),
  ].map((value) => path.resolve(value));
  const encryptRequested = Boolean(options.encrypt || process.env.ORACLE_BACKUP_PASSPHRASE);
  const encryptedFileName = `${packageId}.tar.gz.enc`;
  metadata.encryption = encryptRequested ? {
    algorithm: "aes-256-gcm",
    kdf: "scrypt-N32768-r8-p1",
    file: encryptedFileName,
  } : null;
  metadata.replicaTargets = [...new Set(configuredTargets)];
  await fs.writeFile(
    path.join(packageDirectory, "recovery-manifest.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  checksumRows = await checksumEntries(packageDirectory, coreFiles);
  await writeChecksums(packageDirectory, checksumRows);
  const finalChecksumRows = await checksumEntries(packageDirectory, [...coreFiles, "CHECKSUMS.sha256"]);
  const finalVerification = await verifyChecksumEntries(packageDirectory, finalChecksumRows);
  if (!finalVerification.valid) throw new Error("Final recovery package failed checksum verification");

  let distributablePath = packageDirectory;
  let encryptionResult = null;
  if (encryptRequested) {
    const passphrase = process.env.ORACLE_BACKUP_PASSPHRASE;
    if (!passphrase) throw new Error("ORACLE_BACKUP_PASSPHRASE is required with --encrypt");
    const outerArchive = path.join(outputRoot, `${packageId}.tar.gz`);
    createTarGzip(outputRoot, outerArchive, [packageId]);
    distributablePath = path.join(outputRoot, encryptedFileName);
    encryptionResult = await encryptFile(outerArchive, distributablePath, passphrase);
    await fs.rm(outerArchive, { force: true });
  }

  const replicaResults = [];
  for (const targetRoot of [...new Set(configuredTargets)]) {
    try {
      await fs.mkdir(targetRoot, { recursive: true });
      let targetPath;
      if (encryptRequested) {
        targetPath = path.join(targetRoot, path.basename(distributablePath));
        await fs.copyFile(distributablePath, targetPath, fsSync.constants.COPYFILE_EXCL);
      } else {
        targetPath = await copyPackage(packageDirectory, targetRoot);
      }
      replicaResults.push({ target: targetRoot, path: targetPath, copied: true });
    } catch (error) {
      replicaResults.push({ target: targetRoot, copied: false, error: error.message });
    }
  }

  if (options.readOnly) await makeReadOnly(packageDirectory);
  const completedAt = new Date().toISOString();
  const backupStatus = {
    version: RECOVERY_FORMAT_VERSION,
    packageId,
    createdAt: metadata.createdAt,
    completedAt,
    commit,
    branch,
    packagePath: packageDirectory,
    distributablePath,
    encrypted: encryptRequested,
    encryption: encryptionResult,
    verified: true,
    checksumFiles: finalChecksumRows.length,
    assetPaths,
    replicas: replicaResults,
  };
  const platformStatusDir = path.join(rootDir, "data", "runtime", "platform");
  await fs.mkdir(platformStatusDir, { recursive: true });
  await fs.writeFile(
    path.join(platformStatusDir, "backup-status.json"),
    `${JSON.stringify(backupStatus, null, 2)}\n`,
    "utf8",
  );
  if (options.removePlaintext && encryptRequested) {
    await fs.rm(packageDirectory, { recursive: true, force: true });
    backupStatus.packagePath = null;
  }
  return backupStatus;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      "Usage: node scripts/backup-oracle.js [options]",
      "  --out <directory>        recovery package root",
      "  --target <directory>     independent replica target (repeatable)",
      "  --encrypt                use ORACLE_BACKUP_PASSPHRASE",
      "  --remove-plaintext       retain only encrypted distributable",
      "  --read-only              mark local package files read-only",
      "  --allow-dirty            include committed refs despite a dirty worktree",
    ].join("\n"));
    return;
  }
  console.log(JSON.stringify(await createBackup(options), null, 2));
}

module.exports = { createBackup, createPackageDirectory, parseArgs, existingPaths };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
