#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  DEFAULT_ARTIFACTS,
  buildArtifactManifest,
  writeArtifactManifest,
} = require("../server/artifact-registry.js");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.rootDir = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--checksum-out") options.checksumOut = argv[++index];
    else if (value === "--timestamp") options.timestamp = true;
    else if (value === "--file") (options.files ||= []).push(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function gitCommit(rootDir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function writeChecksumFile(filePath, manifest) {
  const lines = manifest.files.map((row) => `${row.sha256}  ${row.path}`);
  lines.push(`${manifest.semanticDigest}  data/artifact-manifest.semantic`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function generate(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const outPath = path.resolve(rootDir, options.out || "data/artifact-manifest.json");
  const checksumPath = path.resolve(rootDir, options.checksumOut || "MANIFEST.sha256");
  const manifest = await buildArtifactManifest(
    rootDir,
    options.files?.length ? options.files : DEFAULT_ARTIFACTS,
    {
      commit: options.commit === undefined ? gitCommit(rootDir) : options.commit,
      generatedAt: options.timestamp ? new Date().toISOString() : null,
    },
  );
  await writeArtifactManifest(outPath, manifest);
  await writeChecksumFile(checksumPath, manifest);
  return { rootDir, outPath, checksumPath, manifest };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/generate-asset-manifest.js [--root DIR] [--out FILE] [--file FILE] [--timestamp]");
    return;
  }
  const result = await generate(options);
  console.log(JSON.stringify({
    output: result.outPath,
    checksumOutput: result.checksumPath,
    files: result.manifest.files.length,
    semanticDigest: result.manifest.semanticDigest,
    commit: result.manifest.commit,
  }, null, 2));
}

module.exports = { generate, writeChecksumFile, gitCommit };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
