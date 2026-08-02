"use strict";

const { createLineage, sha256 } = require("./lineage.js");

const SCHEMA_REGISTRY_VERSION = "oracle-schemas-2026.1";
const SCHEMA_VERSIONS = Object.freeze({
  sourceRecord: "source-record/v1",
  playerEvent: "player-event/v1",
  leagueState: "league-state/v1",
  recommendation: "recommendation/v1",
  outcome: "decision-outcome/v1",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  if (value === null || value === undefined || value === "") return true;
  return !Number.isNaN(new Date(value).getTime());
}

function errorAt(path, message) {
  return `${path}: ${message}`;
}

function requireString(errors, value, path, options = {}) {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    errors.push(errorAt(path, "must be a non-empty string"));
  }
}

function requireNumber(errors, value, path, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push(errorAt(path, "must be a finite number"));
    return;
  }
  if (options.minimum !== undefined && number < options.minimum) {
    errors.push(errorAt(path, `must be >= ${options.minimum}`));
  }
  if (options.maximum !== undefined && number > options.maximum) {
    errors.push(errorAt(path, `must be <= ${options.maximum}`));
  }
}

function validateSourceRecord(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["record: must be an object"] };
  requireString(errors, value.id, "id");
  requireString(errors, value.entityType, "entityType");
  requireString(errors, value.source?.name, "source.name");
  requireString(errors, value.source?.recordId, "source.recordId");
  if (!isTimestamp(value.source?.eventAt)) errors.push(errorAt("source.eventAt", "invalid timestamp"));
  if (!isTimestamp(value.source?.fetchedAt)) errors.push(errorAt("source.fetchedAt", "invalid timestamp"));
  requireNumber(errors, value.source?.confidence, "source.confidence", { minimum: 0, maximum: 1 });
  if (!isPlainObject(value.payload)) errors.push(errorAt("payload", "must be an object"));
  requireString(errors, value.schemaVersion, "schemaVersion");
  requireString(errors, value.contentHash, "contentHash");
  return { valid: errors.length === 0, errors };
}

function validatePlayerEvent(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["event: must be an object"] };
  requireString(errors, value.eventType, "eventType");
  requireString(errors, value.playerId, "playerId");
  requireString(errors, value.source, "source");
  if (!isTimestamp(value.occurredAt)) errors.push(errorAt("occurredAt", "invalid timestamp"));
  if (!isTimestamp(value.observedAt)) errors.push(errorAt("observedAt", "invalid timestamp"));
  requireNumber(errors, value.confidence, "confidence", { minimum: 0, maximum: 1 });
  if (!isPlainObject(value.facts)) errors.push(errorAt("facts", "must be an object"));
  if (value.inferences !== undefined && !isPlainObject(value.inferences)) {
    errors.push(errorAt("inferences", "must be an object when present"));
  }
  return { valid: errors.length === 0, errors };
}

function validateLeagueState(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["leagueState: must be an object"] };
  requireString(errors, value.leagueId, "leagueId");
  requireNumber(errors, value.season, "season", { minimum: 2018, maximum: 2035 });
  requireNumber(errors, value.week, "week", { minimum: 1, maximum: 18 });
  requireString(errors, value.userTeamId, "userTeamId");
  if (!isPlainObject(value.settings)) errors.push(errorAt("settings", "must be an object"));
  if (!Array.isArray(value.teams) || value.teams.length < 2) {
    errors.push(errorAt("teams", "must contain at least two teams"));
  } else {
    const teamIds = new Set();
    value.teams.forEach((team, index) => {
      const prefix = `teams[${index}]`;
      requireString(errors, team?.teamId, `${prefix}.teamId`);
      if (teamIds.has(String(team?.teamId))) errors.push(errorAt(`${prefix}.teamId`, "duplicate"));
      teamIds.add(String(team?.teamId));
      if (!Array.isArray(team?.rosterIds)) errors.push(errorAt(`${prefix}.rosterIds`, "must be an array"));
      requireNumber(errors, team?.wins ?? 0, `${prefix}.wins`, { minimum: 0 });
      requireNumber(errors, team?.losses ?? 0, `${prefix}.losses`, { minimum: 0 });
    });
    if (!teamIds.has(String(value.userTeamId))) errors.push(errorAt("userTeamId", "does not match a team"));
  }
  if (value.schedule !== undefined && !Array.isArray(value.schedule)) {
    errors.push(errorAt("schedule", "must be an array"));
  }
  return { valid: errors.length === 0, errors };
}

function validateRecommendation(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["recommendation: must be an object"] };
  requireString(errors, value.decisionId, "decisionId");
  requireString(errors, value.replayKey, "replayKey");
  requireString(errors, value.decisionType, "decisionType");
  requireString(errors, value.objective, "objective");
  if (!isTimestamp(value.createdAt)) errors.push(errorAt("createdAt", "invalid timestamp"));
  requireNumber(errors, value.confidence, "confidence", { minimum: 0, maximum: 1 });
  ["inputDigest", "modelDigest", "dataDigest"].forEach((field) => {
    requireString(errors, value[field], field);
  });
  return { valid: errors.length === 0, errors };
}

function validateOutcome(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["outcome: must be an object"] };
  requireString(errors, value.decisionId, "decisionId");
  requireString(errors, value.outcomeType, "outcomeType");
  if (!isTimestamp(value.recordedAt)) errors.push(errorAt("recordedAt", "invalid timestamp"));
  if (!isPlainObject(value.metrics)) errors.push(errorAt("metrics", "must be an object"));
  return { valid: errors.length === 0, errors };
}

const VALIDATORS = Object.freeze({
  sourceRecord: validateSourceRecord,
  playerEvent: validatePlayerEvent,
  leagueState: validateLeagueState,
  recommendation: validateRecommendation,
  outcome: validateOutcome,
});

function validateRecord(schemaName, value) {
  const validator = VALIDATORS[schemaName];
  if (!validator) return { valid: false, errors: [`unknown schema: ${schemaName}`] };
  return validator(value);
}

function assertValid(schemaName, value) {
  const result = validateRecord(schemaName, value);
  if (result.valid) return value;
  const error = new Error(`Schema validation failed for ${schemaName}: ${result.errors.join("; ")}`);
  error.code = "SCHEMA_INVALID";
  error.details = result.errors;
  throw error;
}

function normalizeSourceRecord(options = {}) {
  const fetchedAt = new Date(options.fetchedAt || Date.now()).toISOString();
  const eventAt = options.eventAt ? new Date(options.eventAt).toISOString() : null;
  const payload = isPlainObject(options.payload) ? options.payload : { value: options.payload ?? null };
  const source = {
    name: String(options.source || "unknown"),
    recordId: String(options.sourceRecordId || options.id || sha256(payload).slice(0, 24)),
    eventAt,
    fetchedAt,
    confidence: Math.min(1, Math.max(0, Number(options.confidence ?? 0.5))),
    usage: String(options.usage || "unspecified"),
  };
  const record = {
    id: String(options.id || `${source.name}:${source.recordId}`),
    entityType: String(options.entityType || "unknown"),
    schemaVersion: SCHEMA_VERSIONS.sourceRecord,
    source,
    payload,
    contentHash: sha256({ source, payload }),
  };
  record.lineage = createLineage({
    kind: record.entityType,
    schemaVersion: record.schemaVersion,
    source: source.name,
    sourceEventAt: source.eventAt,
    fetchedAt: source.fetchedAt,
    confidence: source.confidence,
    payload,
    metadata: { sourceRecordId: source.recordId, usage: source.usage },
  });
  return assertValid("sourceRecord", record);
}

function registrySummary() {
  return {
    version: SCHEMA_REGISTRY_VERSION,
    schemas: { ...SCHEMA_VERSIONS },
    strictUnknownFields: false,
    provenanceRequired: true,
  };
}

module.exports = {
  SCHEMA_REGISTRY_VERSION,
  SCHEMA_VERSIONS,
  validateRecord,
  assertValid,
  normalizeSourceRecord,
  registrySummary,
  isPlainObject,
};
