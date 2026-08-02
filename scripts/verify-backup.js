#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  RECOVERY_FORMAT_VERSION,
  run,
  sha256File,
  decryptFile,
  extractTarGzip,
  listTarGzip,
} = require("./lib/recovery.js");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--package") options.packagePath = argv[++index];
    else if (value === "--passphrase-file") options.passphraseFile = argv[++index];
    else if (value === "--keep-temp") options.keepTemp = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function readPassphrase(options) {
  if (options.passphraseFile) return String(await fs.readFile(options.passphraseFile, "utf8")).trim();
  return process.env.ORACLE_BACKUP_PASSPHRASE || "";
}

function safeArchiveEntries(entries) {
  return entries.every((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return !path.posix.isAbsolute(normalized) &&
      !normalized.split("/").includes("..") &&
      !/^[a-zA-Z]:/.test(normalized);
  });
}

async function locatePackage(root) {
  const direct = path.join(root, "recovery-manifest.json");
  try {
    await fs.access(direct);
    return root;
  } catch {}
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory());
  for (const candidate of candidates) {
    const full = path.join(root, candidate.name);
    try {
      await fs.access(path.join(full, "recovery-manifest.json"));
      return full;
    } catch {}
  }
  throw new Error("Recovery manifest was not found in the package");
}

async function materializePackage(packagePath, options = {}) {
  const absolute = path.resolve(packagePath);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) return { packageDirectory: absolute, temporaryRoot: null };
  if (!absolute.endsWith(".enc")) throw new Error("Backup package must be a directory or .enc file");
  const passphrase = await readPassphrase(options);
  if (!passphrase) throw new Error("ORACLE_BACKUP_PASSPHRASE or --passphrase-file is required");
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-verify-"));
  const archivePath = path.join(temporaryRoot, "package.tar.gz");
  await decryptFile(absolute, archivePath, passphrase);
  const entries = listTarGzip(archivePath);
  if (!entries.length || !safeArchiveEntries(entries)) {
    throw new Error("Encrypted package archive contains unsafe or no entries");
  }
  extractTarGzip(archivePath, temporaryRoot);
  return {
    packageDirectory: await locatePackage(temporaryRoot),
    temporaryRoot,
  };
}

function parseChecksumFile(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    return { sha256: match[1].toLowerCase(), path: match[2] };
  });
}

async function verifyChecksums(packageDirectory) {
  const rows = parseChecksumFile(await fs.readFile(
    path.join(packageDirectory, "CHECKSUMS.sha256"),
    "utf8",
  ));
  const results = [];
  for (const expected of rows) {
    const normalized = expected.path.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      results.push({ ...expected, valid: false, error: "unsafe checksum path" });
      continue;
    }
    try {
      const absolute = path.resolve(packageDirectory, normalized);
      const stat = await fs.stat(absolute);
      const actual = await sha256File(absolute);
      results.push({
        ...expected,
        actual,
        bytes: stat.size,
        valid: stat.isFile() && stat.size > 0 && actual === expected.sha256,
      });
    } catch (error) {
      results.push({ ...expected, valid: false, error: error.message });
    }
  }
  return { valid: rows.length > 0 && results.every((row) => row.valid), results };
}

async function verifyGitBundle(bundlePath) {
  const verificationRepository = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bundle-verify-"));
  try {
    run("git", ["init", "--bare", verificationRepository]);
    run("git", ["-C", verificationRepository, "bundle", "verify", path.resolve(bundlePath)]);
    return true;
  } finally {
    await fs.rm(verificationRepository, { recursive: true, force: true });
  }
}

async function verifyBackup(options = {}) {
  if (!options.packagePath) throw new Error("--package is required");
  const materialized = await materializePackage(options.packagePath, options);
  try {
    const packageDirectory = materialized.packageDirectory;
    const metadata = JSON.parse(await fs.readFile(
      path.join(packageDirectory, "recovery-manifest.json"),
      "utf8",
    ));
    if (metadata.version !== RECOVERY_FORMAT_VERSION) {
      throw new Error(`Unsupported recovery format: ${metadata.version}`);
    }
    const checksums = await verifyChecksums(packageDirectory);
    if (!checksums.valid) {
      const failures = checksums.results.filter((row) => !row.valid).map((row) => row.path);
      throw new Error(`Checksum verification failed: ${failures.join(", ")}`);
    }
    const bundlePath = path.join(packageDirectory, "repository.bundle");
    await verifyGitBundle(bundlePath);
    const assetArchive = path.join(packageDirectory, "assets.tar.gz");
    const assetEntries = listTarGzip(assetArchive);
    if (!safeArchiveEntries(assetEntries)) throw new Error("Asset archive contains unsafe paths");
    const artifactManifest = JSON.parse(await fs.readFile(
      path.join(packageDirectory, "artifact-manifest.json"),
      "utf8",
    ));
    if (!artifactManifest.semanticDigest || !Array.isArray(artifactManifest.files)) {
      throw new Error("Artifact manifest is incomplete");
    }
    return {
      valid: true,
      verifiedAt: new Date().toISOString(),
      packagePath: path.resolve(options.packagePath),
      materializedPath: packageDirectory,
      packageId: metadata.packageId,
      commit: metadata.repository?.commit || null,
      branch: metadata.repository?.branch || null,
      encrypted: path.resolve(options.packagePath).endsWith(".enc"),
      checksumFiles: checksums.results.length,
      assetEntries: assetEntries.length,
      artifactFiles: artifactManifest.files.length,
      temporaryRoot: options.keepTemp ? materialized.temporaryRoot : null,
    };
  } finally {
    if (materialized.temporaryRoot && !options.keepTemp) {
      await fs.rm(materialized.temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-backup.js --package <directory-or-.enc> [--passphrase-file FILE]");
    return;
  }
  console.log(JSON.stringify(await verifyBackup(options), null, 2));
}

module.exports = {
  verifyBackup,
  verifyGitBundle,
  materializePackage,
  parseChecksumFile,
  verifyChecksums,
  safeArchiveEntries,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
