#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.rootDir = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--timestamp") options.timestamp = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function packageNameFromPath(packagePath, row) {
  if (row?.name) return row.name;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index >= 0 ? packagePath.slice(index + marker.length) : packagePath || "root";
}

function purl(name, version) {
  const encoded = String(name).split("/").map(encodeURIComponent).join("/");
  return `pkg:npm/${encoded}@${encodeURIComponent(String(version || "0.0.0"))}`;
}

function componentFromLock(packagePath, row) {
  const name = packageNameFromPath(packagePath, row);
  const version = String(row.version || "0.0.0");
  const component = {
    type: "library",
    "bom-ref": purl(name, version),
    name,
    version,
    purl: purl(name, version),
    scope: row.dev ? "optional" : "required",
    properties: [
      { name: "oracle:devDependency", value: String(Boolean(row.dev)) },
      { name: "oracle:optional", value: String(Boolean(row.optional)) },
    ],
  };
  if (row.integrity) component.hashes = [{ alg: "SHA-512", content: String(row.integrity) }];
  if (row.resolved) component.externalReferences = [{ type: "distribution", url: String(row.resolved) }];
  if (row.license) component.licenses = [{ license: { name: String(row.license) } }];
  return component;
}

async function generateSbom(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const lockText = await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockText);
  const rows = Object.entries(lock.packages || {})
    .filter(([packagePath]) => packagePath)
    .map(([packagePath, row]) => componentFromLock(packagePath, row))
    .sort((left, right) => left.purl.localeCompare(right.purl));
  const rootRef = purl(packageJson.name, packageJson.version);
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: options.timestamp ? new Date().toISOString() : undefined,
      tools: [{
        vendor: "Bontr",
        name: "Fantasy Football Oracle SBOM Generator",
        version: packageJson.version,
      }],
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: packageJson.name,
        version: packageJson.version,
        purl: rootRef,
        hashes: [{ alg: "SHA-256", content: hash(lockText) }],
      },
      properties: [
        { name: "oracle:lockfileVersion", value: String(lock.lockfileVersion || "unknown") },
        { name: "oracle:generatedDeterministically", value: String(!options.timestamp) },
      ],
    },
    components: rows,
    dependencies: [{ ref: rootRef, dependsOn: rows.map((row) => row["bom-ref"]) }],
  };
  if (!options.timestamp) delete document.metadata.timestamp;
  document.serialNumber = `urn:uuid:${[
    hash(JSON.stringify({ rootRef, rows })).slice(0, 8),
    hash(rootRef).slice(0, 4),
    `4${hash(lockText).slice(0, 3)}`,
    `8${hash(packageJson.name).slice(0, 3)}`,
    hash(JSON.stringify(rows)).slice(0, 12),
  ].join("-")}`;
  const outPath = path.resolve(rootDir, options.out || "artifacts/sbom.cdx.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { outPath, components: rows.length, rootRef, lockDigest: hash(lockText) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/generate-sbom.js [--root DIR] [--out FILE] [--timestamp]");
    return;
  }
  console.log(JSON.stringify(await generateSbom(options), null, 2));
}

module.exports = { generateSbom, componentFromLock, purl };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
