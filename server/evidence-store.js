"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { sha256 } = require("./lineage.js");
const {
  DAY_MS,
  definitionFor,
  normalizeFeatureValue,
} = require("./feature-catalog.js");

const EVIDENCE_SCHEMA_VERSION = "evidence-observation/v1";
const EVIDENCE_STORE_VERSION = "oracle-evidence-2026.1";
const GENESIS_HASH = "0".repeat(64);

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function isoTimestamp(value, fallback = null) {
  const milliseconds = value === undefined || value === null ? fallback : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`Invalid timestamp: ${value}`);
  return new Date(milliseconds).toISOString();
}
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function observationKey(entityType, entityId, feature) {
  return `${entityType}\u0000${entityId}\u0000${feature}`;
}

function normalizeObservation(input = {}, options = {}) {
  const observedAt = isoTimestamp(input.observedAt, options.now ?? Date.now());
  const effectiveAt = isoTimestamp(input.effectiveAt, Date.parse(observedAt));
  const expiresAt = input.expiresAt === null || input.expiresAt === undefined
    ? null
    : isoTimestamp(input.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveAt)) {
    throw new RangeError("Evidence expiry must be after its effective time");
  }
  const entityType = String(input.entityType || "player").trim().toLowerCase();
  const entityId = String(input.entityId || "").trim();
  const feature = String(input.feature || "").trim().toLowerCase();
  if (!entityType || !entityId || !feature) {
    throw new TypeError("Evidence requires entityType, entityId, and feature");
  }
  const sourceInput = plainObject(input.source) ? input.source : { name: input.source };
  const sourceName = String(sourceInput?.name || "unknown").trim();
  if (!sourceName) throw new TypeError("Evidence requires a source name");
  const value = normalizeFeatureValue(feature, input.value);
  const core = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    entityType,
    entityId,
    feature,
    value,
    unit: String(input.unit || definitionFor(feature)?.unit || "unspecified"),
    source: {
      name: sourceName,
      recordId: String(sourceInput.recordId || input.sourceRecordId || "").trim() || null,
      reliability: clamp(sourceInput.reliability ?? input.reliability ?? 0.5),
    },
    confidence: clamp(input.confidence ?? 0.5),
    uncertainty: Math.max(0, finite(input.uncertainty, 0)),
    observedAt,
    effectiveAt,
    expiresAt,
    metadata: plainObject(input.metadata) ? { ...input.metadata } : {},
  };
  const contentHash = sha256(core);
  return Object.freeze({
    id: String(input.id || `ev_${contentHash.slice(0, 24)}`),
    ...core,
    contentHash,
  });
}

function validateObservation(observation) {
  try {
    const normalized = normalizeObservation(observation, {
      now: Date.parse(observation?.observedAt || 0),
    });
    if (normalized.id !== observation.id || normalized.contentHash !== observation.contentHash) {
      return { valid: false, error: "Evidence identity or content hash is invalid" };
    }
    return { valid: true, observation: normalized };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

function createChainEntry(observation, sequence, previousHash) {
  const core = { sequence, previousHash, observation };
  return Object.freeze({ ...core, hash: sha256(core) });
}

function validateChainEntries(entries = []) {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sequence !== index + 1) {
      return { valid: false, error: `Evidence sequence ${entry.sequence} is invalid`, index };
    }
    if (entry.previousHash !== previousHash) {
      return { valid: false, error: `Evidence previous hash is invalid at ${entry.sequence}`, index };
    }
    const validation = validateObservation(entry.observation);
    if (!validation.valid) return { valid: false, error: validation.error, index };
    const expectedHash = sha256({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      observation: entry.observation,
    });
    if (entry.hash !== expectedHash) {
      return { valid: false, error: `Evidence hash is invalid at ${entry.sequence}`, index };
    }
    previousHash = entry.hash;
  }
  return {
    valid: true,
    entries: entries.length,
    headHash: previousHash,
  };
}

function freshnessWeight(observation, asOfMs, definition) {
  const observedMs = Date.parse(observation.observedAt);
  const ageMs = Math.max(0, asOfMs - observedMs);
  const halfLifeMs = Math.max(1, definition?.halfLifeMs || 7 * DAY_MS);
  return 2 ** (-ageMs / halfLifeMs);
}

function effectiveWeight(observation, asOfMs, definition) {
  return observation.confidence
    * observation.source.reliability
    * freshnessWeight(observation, asOfMs, definition);
}

function provenanceRow(observation, weight) {
  return {
    id: observation.id,
    source: observation.source.name,
    sourceRecordId: observation.source.recordId,
    observedAt: observation.observedAt,
    effectiveAt: observation.effectiveAt,
    expiresAt: observation.expiresAt,
    confidence: observation.confidence,
    reliability: observation.source.reliability,
    weight: Math.round(weight * 1_000_000) / 1_000_000,
    value: observation.value,
  };
}

function numericResolution(observations, asOfMs, definition) {
  const rows = observations.map((observation) => ({
    observation,
    value: typeof observation.value === "boolean" ? Number(observation.value) : Number(observation.value),
    weight: effectiveWeight(observation, asOfMs, definition),
  })).filter((row) => Number.isFinite(row.value) && row.weight > 0);
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const squaredWeight = rows.reduce((sum, row) => sum + row.weight ** 2, 0);
  const mean = rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
  const variance = rows.reduce((sum, row) => {
    const disagreement = (row.value - mean) ** 2;
    const measurement = row.observation.uncertainty ** 2;
    return sum + row.weight * (disagreement + measurement);
  }, 0) / totalWeight;
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const scale = Math.max(0.0001, definition?.scale || Math.abs(mean) || 1);
  const conflict = clamp(standardDeviation / scale);
  const confidence = clamp((1 - Math.exp(-totalWeight)) * (1 - conflict * 0.55), 0, 0.995);
  const newest = Math.max(...rows.map((row) => Date.parse(row.observation.observedAt)));
  const result = {
    value: definition?.type === "boolean" ? mean >= 0.5 : mean,
    probability: definition?.type === "boolean" ? mean : undefined,
    standardDeviation,
    minimum: Math.min(...rows.map((row) => row.value)),
    maximum: Math.max(...rows.map((row) => row.value)),
    confidence,
    conflict,
    totalWeight,
    effectiveSampleSize: squaredWeight > 0 ? (totalWeight ** 2) / squaredWeight : 0,
    freshestAt: new Date(newest).toISOString(),
    stale: asOfMs - newest > (definition?.halfLifeMs || 7 * DAY_MS) * 2,
    provenance: rows
      .sort((left, right) => right.weight - left.weight)
      .map((row) => provenanceRow(row.observation, row.weight)),
  };
  return result;
}

function categoricalResolution(observations, asOfMs, definition) {
  const weights = new Map();
  const rows = observations.map((observation) => {
    const weight = effectiveWeight(observation, asOfMs, definition);
    const value = String(observation.value);
    weights.set(value, (weights.get(value) || 0) + weight);
    return { observation, weight, value };
  }).filter((row) => row.weight > 0);
  if (!rows.length) return null;
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const distribution = Object.fromEntries([...weights.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value, weight]) => [value, weight / totalWeight]));
  const [value, winningWeight] = [...weights.entries()]
    .sort((left, right) => right[1] - left[1])[0];
  const probabilities = Object.values(distribution);
  const entropy = probabilities.length <= 1 ? 0 : -probabilities.reduce(
    (sum, probability) => sum + probability * Math.log(probability),
    0,
  ) / Math.log(probabilities.length);
  const confidence = clamp((1 - Math.exp(-totalWeight)) * (1 - entropy * 0.65), 0, 0.995);
  const newest = Math.max(...rows.map((row) => Date.parse(row.observation.observedAt)));
  return {
    value,
    probability: winningWeight / totalWeight,
    distribution,
    confidence,
    conflict: entropy,
    totalWeight,
    effectiveSampleSize: probabilities.length,
    freshestAt: new Date(newest).toISOString(),
    stale: asOfMs - newest > (definition?.halfLifeMs || 7 * DAY_MS) * 2,
    provenance: rows
      .sort((left, right) => right.weight - left.weight)
      .map((row) => provenanceRow(row.observation, row.weight)),
  };
}
class EvidenceStore {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError("EvidenceStore requires filePath");
    this.filePath = path.resolve(options.filePath);
    this.clock = options.clock || Date.now;
    this.maxObservations = Math.max(100, Number(options.maxObservations || 250_000));
    this.entries = [];
    this.observations = new Map();
    this.contentHashes = new Map();
    this.index = new Map();
    this.sequence = 0;
    this.headHash = GENESIS_HASH;
    this.initialized = false;
    this.writeTail = Promise.resolve();
    this.lastVerification = { valid: true, entries: 0, headHash: GENESIS_HASH };
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let body = "";
    try {
      body = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const entries = body.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw Object.assign(new Error(`Invalid evidence JSON at line ${index + 1}`), {
          code: "EVIDENCE_CHAIN_INVALID",
          cause: error,
        });
      }
    });
    const verification = validateChainEntries(entries);
    if (!verification.valid) {
      throw Object.assign(new Error(verification.error), {
        code: "EVIDENCE_CHAIN_INVALID",
        details: verification,
      });
    }
    for (const entry of entries) this.applyEntry(entry);
    this.lastVerification = verification;
    this.initialized = true;
    return this.status();
  }

  applyEntry(entry) {
    const observation = entry.observation;
    if (this.observations.has(observation.id)) {
      throw Object.assign(new Error(`Duplicate evidence id ${observation.id}`), {
        code: "EVIDENCE_DUPLICATE_ID",
      });
    }
    this.entries.push(entry);
    this.observations.set(observation.id, observation);
    this.contentHashes.set(observation.contentHash, observation.id);
    const key = observationKey(
      observation.entityType,
      observation.entityId,
      observation.feature,
    );
    const rows = this.index.get(key) || [];
    rows.push(observation);
    this.index.set(key, rows);
    this.sequence = entry.sequence;
    this.headHash = entry.hash;
  }
  enqueue(inputs) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    const operation = this.writeTail.then(async () => {
      if (!this.initialized) throw new Error("EvidenceStore is not initialized");
      const results = [];
      for (const input of list) {
        const observation = normalizeObservation(input, { now: this.clock() });
        const duplicateId = this.contentHashes.get(observation.contentHash);
        if (duplicateId) {
          results.push({ inserted: false, id: duplicateId, duplicate: true });
          continue;
        }
        if (this.entries.length >= this.maxObservations) {
          throw Object.assign(new Error("Evidence store observation limit reached"), {
            code: "EVIDENCE_LIMIT_REACHED",
          });
        }
        const entry = createChainEntry(observation, this.sequence + 1, this.headHash);
        await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
        this.applyEntry(entry);
        results.push({
          inserted: true,
          id: observation.id,
          sequence: entry.sequence,
          hash: entry.hash,
        });
      }
      this.lastVerification = {
        valid: true,
        entries: this.entries.length,
        headHash: this.headHash,
      };
      return results;
    });
    this.writeTail = operation.catch(() => {});
    return operation;
  }

  async append(input) {
    const [result] = await this.enqueue([input]);
    return result;
  }

  async ingestMany(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError("Evidence batch must be an array");
    return this.enqueue(inputs);
  }

  observationsFor(entityType, entityId, feature, options = {}) {
    const asOfMs = Number.isFinite(Number(options.asOf))
      ? Number(options.asOf)
      : Date.parse(options.asOf || new Date(this.clock()).toISOString());
    const key = observationKey(
      String(entityType || "player").toLowerCase(),
      String(entityId),
      String(feature || "").toLowerCase(),
    );
    const persisted = this.index.get(key) || [];
    const normalizedEntityType = String(entityType || "player").toLowerCase();
    const normalizedEntityId = String(entityId);
    const normalizedFeature = String(feature || "").toLowerCase();
    const additional = (Array.isArray(options.additionalObservations)
      ? options.additionalObservations
      : [])
      .filter((row) => (
        String(row.entityType || normalizedEntityType).toLowerCase() === normalizedEntityType
        && String(row.entityId || normalizedEntityId) === normalizedEntityId
        && String(row.feature || normalizedFeature).toLowerCase() === normalizedFeature
      ))
      .map((row) => normalizeObservation({
        ...row,
        entityType: normalizedEntityType,
        entityId: normalizedEntityId,
        feature: normalizedFeature,
      }, { now: asOfMs }));
    return [...persisted, ...additional]
      .filter((observation) => {
        const observedMs = Date.parse(observation.observedAt);
        const effectiveMs = Date.parse(observation.effectiveAt);
        const expiryMs = observation.expiresAt ? Date.parse(observation.expiresAt) : null;
        if (observedMs > asOfMs || effectiveMs > asOfMs) return false;
        if (!options.includeExpired && expiryMs !== null && expiryMs <= asOfMs) return false;
        return true;
      })
      .sort((left, right) => (
        Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt)
        || Date.parse(right.observedAt) - Date.parse(left.observedAt)
        || right.id.localeCompare(left.id)
      ));
  }

  resolve(entityType, entityId, feature, options = {}) {
    const asOf = options.asOf || new Date(this.clock()).toISOString();
    const asOfMs = Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) throw new TypeError("Evidence resolution requires a valid asOf time");
    const observations = this.observationsFor(entityType, entityId, feature, {
      ...options,
      asOf: asOfMs,
    });
    const definition = definitionFor(feature);
    if (!observations.length) {
      return {
        available: false,
        entityType,
        entityId: String(entityId),
        feature,
        asOf: new Date(asOfMs).toISOString(),
        observations: 0,
      };
    }
    const inferredType = definition?.type || (
      typeof observations[0].value === "number" ? "number"
        : typeof observations[0].value === "boolean" ? "boolean"
          : "categorical"
    );
    const resolved = inferredType === "categorical"
      ? categoricalResolution(observations, asOfMs, definition)
      : numericResolution(observations, asOfMs, { ...definition, type: inferredType });
    return {
      available: true,
      entityType: String(entityType || "player").toLowerCase(),
      entityId: String(entityId),
      feature: String(feature).toLowerCase(),
      family: definition?.family || "custom",
      type: inferredType,
      unit: definition?.unit || observations[0].unit || "unspecified",
      asOf: new Date(asOfMs).toISOString(),
      observations: observations.length,
      ...resolved,
    };
  }

  resolveEntity(entityType, entityId, options = {}) {
    const prefix = `${String(entityType || "player").toLowerCase()}\u0000${String(entityId)}\u0000`;
    const features = new Set();
    for (const key of this.index.keys()) {
      if (key.startsWith(prefix)) features.add(key.slice(prefix.length));
    }
    for (const row of options.additionalObservations || []) {
      if (String(row.entityType || entityType).toLowerCase() === String(entityType).toLowerCase()
        && String(row.entityId || entityId) === String(entityId)) {
        features.add(String(row.feature || "").toLowerCase());
      }
    }
    return Object.fromEntries([...features]
      .filter(Boolean)
      .sort()
      .map((feature) => [feature, this.resolve(entityType, entityId, feature, options)]));
  }

  query(options = {}) {
    const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
    const rows = [...this.observations.values()].filter((observation) => {
      if (options.entityType && observation.entityType !== String(options.entityType).toLowerCase()) return false;
      if (options.entityId && observation.entityId !== String(options.entityId)) return false;
      if (options.feature && observation.feature !== String(options.feature).toLowerCase()) return false;
      if (options.source && observation.source.name !== String(options.source)) return false;
      return true;
    });
    return rows
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
      .slice(0, limit);
  }

  async verifyFile() {
    await this.writeTail;
    let body = "";
    try {
      body = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const entries = body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    this.lastVerification = validateChainEntries(entries);
    return this.lastVerification;
  }
  status() {
    const sourceCounts = {};
    const featureCounts = {};
    for (const observation of this.observations.values()) {
      sourceCounts[observation.source.name] = (sourceCounts[observation.source.name] || 0) + 1;
      featureCounts[observation.feature] = (featureCounts[observation.feature] || 0) + 1;
    }
    return {
      version: EVIDENCE_STORE_VERSION,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      initialized: this.initialized,
      valid: this.lastVerification.valid,
      observations: this.observations.size,
      sequence: this.sequence,
      headHash: this.headHash,
      sources: sourceCounts,
      features: featureCounts,
      filePath: this.filePath,
    };
  }

  async stop() {
    await this.writeTail;
  }
}

module.exports = {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
  GENESIS_HASH,
  EvidenceStore,
  createChainEntry,
  effectiveWeight,
  normalizeObservation,
  observationKey,
  validateChainEntries,
  validateObservation,
};
