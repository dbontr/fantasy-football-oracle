"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { fileSha256, sha256 } = require("./lineage.js");

const ARTIFACT_MANIFEST_VERSION = "oracle-artifacts-2026.3-v5.2";
const DEFAULT_ARTIFACTS = Object.freeze([
  "package.json",
  "package-lock.json",
  "data/players-2026.json",
  "data/coaches-2026.json",
  "data/opportunity-2026.json",
  "data/health-calibration-2026.json",
  "data/model-registry.json",
  "artifacts/sbom.cdx.json",
  "data/calibration/historical-value.json",
  "data/calibration/historical-backtest-summary.json",
  "data/calibration/free-probabilistic.json",
  "data/calibration/free-probabilistic-summary.json",
  "data/calibration/free-context-policy.json",
  "data/calibration/free-context-policy-summary.json",
]);

function normalizeRelative(filePath) {
  return String(filePath).replaceAll("\\", "/").replace(/^\.\//, "");
}

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, normalizeRelative(relativePath));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error(`Artifact path escapes repository root: ${relativePath}`);
    error.code = "ARTIFACT_PATH_INVALID";
    throw error;
  }
  return resolved;
}

async function describeArtifact(rootDir, relativePath) {
  const normalized = normalizeRelative(relativePath);
  const absolute = resolveInside(rootDir, normalized);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) {
    const error = new Error(`Artifact is not a file: ${normalized}`);
    error.code = "ARTIFACT_NOT_FILE";
    throw error;
  }
  return {
    path: normalized,
    bytes: stat.size,
    sha256: fileSha256(absolute),
  };
}

async function buildArtifactManifest(rootDir, entries = DEFAULT_ARTIFACTS, options = {}) {
  const files = [];
  for (const entry of [...new Set(entries.map(normalizeRelative))].sort()) {
    files.push(await describeArtifact(rootDir, entry));
  }
  const semantic = {
    version: ARTIFACT_MANIFEST_VERSION,
    commit: options.commit || null,
    files,
  };
  return {
    ...semantic,
    generatedAt: options.generatedAt || null,
    semanticDigest: sha256(semantic),
  };
}

async function writeArtifactManifest(filePath, manifest) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function validateArtifactManifest(rootDir, manifest) {
  const errors = [];
  const files = [];
  if (!manifest || manifest.version !== ARTIFACT_MANIFEST_VERSION) {
    errors.push("unsupported or missing artifact manifest version");
  }
  for (const expected of manifest?.files || []) {
    try {
      const actual = await describeArtifact(rootDir, expected.path);
      const status = actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
        ? "valid"
        : "mismatch";
      files.push({ expected, actual, status });
      if (status !== "valid") errors.push(`${expected.path}: checksum or size mismatch`);
    } catch (error) {
      files.push({ expected, actual: null, status: "missing" });
      errors.push(`${expected.path}: ${error.message}`);
    }
  }
  const semantic = {
    version: manifest?.version,
    commit: manifest?.commit || null,
    files: manifest?.files || [],
  };
  if (manifest?.semanticDigest && sha256(semantic) !== manifest.semanticDigest) {
    errors.push("manifest semantic digest mismatch");
  }
  return {
    valid: errors.length === 0,
    errors,
    files,
    checkedAt: new Date().toISOString(),
  };
}

async function loadArtifactManifest(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

class ArtifactRegistry {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || process.cwd());
    this.manifestPath = path.resolve(
      options.manifestPath || path.join(this.rootDir, "data", "artifact-manifest.json"),
    );
    this.strict = options.strict === true;
    this.manifest = null;
    this.validation = null;
    this.error = null;
  }

  async initialize() {
    try {
      this.manifest = await loadArtifactManifest(this.manifestPath);
      this.validation = await validateArtifactManifest(this.rootDir, this.manifest);
      this.error = null;
      if (this.strict && !this.validation.valid) {
        const error = new Error(`Artifact integrity failed: ${this.validation.errors.join("; ")}`);
        error.code = "ARTIFACT_INTEGRITY_FAILED";
        throw error;
      }
    } catch (error) {
      this.error = error.message;
      this.validation = this.validation || {
        valid: false,
        errors: [error.message],
        files: [],
        checkedAt: new Date().toISOString(),
      };
      if (this.strict) throw error;
    }
    return this.status();
  }

  status() {
    return {
      version: ARTIFACT_MANIFEST_VERSION,
      manifestPath: normalizeRelative(path.relative(this.rootDir, this.manifestPath)),
      strict: this.strict,
      loaded: Boolean(this.manifest),
      valid: Boolean(this.validation?.valid),
      semanticDigest: this.manifest?.semanticDigest || null,
      commit: this.manifest?.commit || null,
      files: this.manifest?.files?.length || 0,
      checkedAt: this.validation?.checkedAt || null,
      errors: this.validation?.errors || (this.error ? [this.error] : []),
    };
  }
}

module.exports = {
  ARTIFACT_MANIFEST_VERSION,
  DEFAULT_ARTIFACTS,
  ArtifactRegistry,
  buildArtifactManifest,
  writeArtifactManifest,
  validateArtifactManifest,
  loadArtifactManifest,
  describeArtifact,
  resolveInside,
};
