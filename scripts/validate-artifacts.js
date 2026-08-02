#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  loadArtifactManifest,
  validateArtifactManifest,
} = require("../server/artifact-registry.js");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.rootDir = argv[++index];
    else if (value === "--manifest") options.manifestPath = argv[++index];
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function validate(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const manifestPath = path.resolve(
    rootDir,
    options.manifestPath || "data/artifact-manifest.json",
  );
  const manifest = await loadArtifactManifest(manifestPath);
  const result = await validateArtifactManifest(rootDir, manifest);
  if (!result.valid) {
    const error = new Error(`Artifact validation failed: ${result.errors.join("; ")}`);
    error.code = "ARTIFACT_VALIDATION_FAILED";
    error.result = result;
    throw error;
  }
  return {
    valid: true,
    manifestPath,
    semanticDigest: manifest.semanticDigest,
    commit: manifest.commit,
    files: result.files.length,
    checkedAt: result.checkedAt,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/validate-artifacts.js [--root DIR] [--manifest FILE]");
    return;
  }
  console.log(JSON.stringify(await validate(options), null, 2));
}

module.exports = { validate, parseArgs };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
