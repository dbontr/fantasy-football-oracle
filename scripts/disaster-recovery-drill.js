#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { validateArtifactManifest } = require("../server/artifact-registry.js");
const { materializePackage, verifyBackup } = require("./verify-backup.js");
const { run, extractTarGzip } = require("./lib/recovery.js");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--package") options.packagePath = argv[++index];
    else if (value === "--passphrase-file") options.passphraseFile = argv[++index];
    else if (value === "--destination") options.destination = argv[++index];
    else if (value === "--full") options.full = true;
    else if (value === "--skip-install") options.skipInstall = true;
    else if (value === "--keep") options.keep = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function runNpm(args, options = {}) {
  if (process.platform === "win32") {
    return run(process.env.ComSpec || "cmd.exe", [
      "/d", "/s", "/c", "npm.cmd", ...args,
    ], options);
  }
  return run("npm", args, options);
}

function cloneBundleCanonical(bundlePath, restoredRepo, commit = null) {
  run("git", [
    "-c", "core.autocrlf=false",
    "clone", "--no-checkout",
    path.resolve(bundlePath),
    restoredRepo,
  ], { cwd: path.dirname(restoredRepo) });
  run("git", ["config", "core.autocrlf", "false"], { cwd: restoredRepo });
  run("git", ["checkout", "--detach", commit || "HEAD"], { cwd: restoredRepo });
}

async function prepareDrillPaths(destination = null) {
  const drillRoot = destination
    ? path.resolve(destination)
    : await fs.mkdtemp(path.join(os.tmpdir(), "oracle-recovery-drill-"));
  if (destination) await fs.mkdir(drillRoot, { recursive: true });
  const restoredRepo = path.join(drillRoot, "fantasy-football-oracle");
  try {
    await fs.access(restoredRepo);
    const error = new Error(`Recovery destination already contains ${restoredRepo}`);
    error.code = "RECOVERY_DESTINATION_NOT_EMPTY";
    throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { drillRoot, restoredRepo };
}

async function recoveryDrill(options = {}) {
  if (!options.packagePath) throw new Error("--package is required");
  const startedAt = Date.now();
  const materialized = await materializePackage(options.packagePath, {
    ...options,
    keepTemp: true,
  });
  const { drillRoot, restoredRepo } = await prepareDrillPaths(options.destination);

  let success = false;
  try {
    const packageVerification = await verifyBackup({
      packagePath: materialized.packageDirectory,
      keepTemp: true,
    });
    const metadata = JSON.parse(await fs.readFile(
      path.join(materialized.packageDirectory, "recovery-manifest.json"),
      "utf8",
    ));
    cloneBundleCanonical(
      path.join(materialized.packageDirectory, "repository.bundle"),
      restoredRepo,
      metadata.repository?.commit || null,
    );
    extractTarGzip(
      path.join(materialized.packageDirectory, "assets.tar.gz"),
      restoredRepo,
    );

    const artifactManifest = JSON.parse(await fs.readFile(
      path.join(materialized.packageDirectory, "artifact-manifest.json"),
      "utf8",
    ));
    const artifactValidation = await validateArtifactManifest(restoredRepo, artifactManifest);
    if (!artifactValidation.valid) {
      throw new Error(`Restored artifact validation failed: ${artifactValidation.errors.join("; ")}`);
    }

    if (!options.skipInstall) {
      runNpm(["ci", "--ignore-scripts"], {
        cwd: restoredRepo,
        stdio: "inherit",
      });
    }
    run(process.execPath, ["--check", "server/index.js"], { cwd: restoredRepo });
    run(process.execPath, ["--check", "server/api.js"], { cwd: restoredRepo });
    if (!options.skipInstall) {
      if (options.full) {
        runNpm(["run", "verify"], { cwd: restoredRepo, stdio: "inherit" });
      } else {
        run(process.execPath, ["--test", "tests/platform-foundation.test.js"], {
          cwd: restoredRepo,
          stdio: "inherit",
        });
      }
    }
    const restoredHead = String(run("git", ["rev-parse", "HEAD"], {
      cwd: restoredRepo,
    }).stdout || "").trim();
    if (metadata.repository?.commit && restoredHead !== metadata.repository.commit) {
      throw new Error(`Restored commit ${restoredHead} does not match ${metadata.repository.commit}`);
    }
    success = true;
    return {
      valid: true,
      drillType: options.full ? "full-build-and-test" : "restore-smoke",
      packageVerification,
      restoredCommit: restoredHead,
      artifactFiles: artifactValidation.files.length,
      restoredPath: options.keep ? restoredRepo : null,
      elapsedMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    if (!options.keep) await fs.rm(drillRoot, { recursive: true, force: true });
    if (materialized.temporaryRoot) {
      await fs.rm(materialized.temporaryRoot, { recursive: true, force: true });
    }
    if (!success && options.keep) {
      console.error(`Failed recovery workspace retained at ${drillRoot}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      "Usage: node scripts/disaster-recovery-drill.js --package <path> [options]",
      "  --full              rebuild native engine and run the complete suite",
      "  --skip-install      validate only files, Git, archive, and syntax",
      "  --destination DIR   use a specific empty drill directory",
      "  --keep              retain the restored workspace",
    ].join("\n"));
    return;
  }
  console.log(JSON.stringify(await recoveryDrill(options), null, 2));
}

module.exports = { recoveryDrill, cloneBundleCanonical, prepareDrillPaths, runNpm, parseArgs };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
