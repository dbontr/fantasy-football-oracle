"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const LINEAGE_VERSION = "oracle-lineage-2026.1";

function canonicalize(value) {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(
    typeof value === "string" ? value : stableStringify(value),
    "utf8",
  );
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function normalizeTimestamp(value, fallback = null) {
  const parsed = value instanceof Date ? value : new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function normalizeConfidence(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function contentDigest(payload) {
  return sha256({ version: LINEAGE_VERSION, payload });
}

function createLineage(options = {}) {
  const fetchedAt = normalizeTimestamp(options.fetchedAt, new Date().toISOString());
  const sourceEventAt = normalizeTimestamp(options.sourceEventAt, null);
  const payloadHash = contentDigest(options.payload ?? null);
  const parents = [...new Set((options.parentHashes || []).filter(Boolean).map(String))].sort();
  const base = {
    version: LINEAGE_VERSION,
    kind: String(options.kind || "record"),
    schemaVersion: String(options.schemaVersion || "unversioned"),
    source: String(options.source || "unknown"),
    sourceEventAt,
    fetchedAt,
    confidence: normalizeConfidence(options.confidence),
    payloadHash,
    parentHashes: parents,
    metadata: canonicalize(options.metadata || {}),
  };
  return {
    ...base,
    lineageHash: sha256(base),
  };
}

function verifyLineage(lineage, payload) {
  if (!lineage || typeof lineage !== "object") {
    return { valid: false, errors: ["lineage is missing"] };
  }
  const errors = [];
  const { lineageHash, ...base } = lineage;
  if (lineage.version !== LINEAGE_VERSION) errors.push("unsupported lineage version");
  if (sha256(base) !== lineageHash) errors.push("lineage hash mismatch");
  if (arguments.length > 1 && contentDigest(payload) !== lineage.payloadHash) {
    errors.push("payload hash mismatch");
  }
  return { valid: errors.length === 0, errors };
}

function createRecommendationEnvelope(options = {}) {
  const createdAt = normalizeTimestamp(options.createdAt, new Date().toISOString());
  const decisionType = String(options.decisionType || "analysis");
  const inputDigest = sha256(options.input || {});
  const modelDigest = sha256(options.model || {});
  const dataDigest = sha256(options.data || {});
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : null;
  const replayKey = sha256({
    version: LINEAGE_VERSION,
    decisionType,
    inputDigest,
    modelDigest,
    dataDigest,
    seed,
  });
  const decisionId = String(options.decisionId || sha256({ replayKey, createdAt }).slice(0, 32));
  return {
    version: LINEAGE_VERSION,
    decisionId,
    replayKey,
    decisionType,
    createdAt,
    inputDigest,
    modelDigest,
    dataDigest,
    seed,
    confidence: normalizeConfidence(options.confidence, 0.5),
    freshness: canonicalize(options.freshness || {}),
    warnings: [...new Set((options.warnings || []).map(String))],
    objective: String(options.objective || "expected-value"),
    model: canonicalize(options.model || {}),
  };
}

function verifyRecommendationEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return false;
  const replayKey = sha256({
    version: envelope.version,
    decisionType: envelope.decisionType,
    inputDigest: envelope.inputDigest,
    modelDigest: envelope.modelDigest,
    dataDigest: envelope.dataDigest,
    seed: envelope.seed ?? null,
  });
  return envelope.version === LINEAGE_VERSION && replayKey === envelope.replayKey;
}

module.exports = {
  LINEAGE_VERSION,
  canonicalize,
  stableStringify,
  sha256,
  fileSha256,
  contentDigest,
  createLineage,
  verifyLineage,
  createRecommendationEnvelope,
  verifyRecommendationEnvelope,
  normalizeConfidence,
  normalizeTimestamp,
};
