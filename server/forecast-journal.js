"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { sha256 } = require("./lineage.js");
const { scoreForecast, summarizeScores } = require("./probabilistic-calibration.js");

const FORECAST_JOURNAL_VERSION = "oracle-forecast-journal-2026.1";
const FORECAST_RECORD_SCHEMA = "forecast-journal-record/v1";
const GENESIS_HASH = "0".repeat(64);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`Invalid timestamp ${value}`);
  return date.toISOString();
}

function hourBucket(value, bucketMs = 6 * 60 * 60 * 1000) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("Forecast bucket requires a valid time");
  return new Date(Math.floor(milliseconds / bucketMs) * bucketMs).toISOString();
}

function compactForecast(forecast, options = {}) {
  const season = Number(options.season ?? forecast.season);
  const week = Number(options.week ?? forecast.week);
  const asOf = iso(options.asOf || forecast.asOf || forecast.generatedAt || Date.now());
  const playerId = String(forecast.player?.id || "");
  if (!Number.isInteger(season) || !Number.isInteger(week) || !playerId) {
    throw new TypeError("Forecast journal requires season, week, and player id");
  }
  return {
    schemaVersion: forecast.schemaVersion || "probabilistic-forecast/v1",
    version: forecast.version || "unknown",
    season,
    week,
    asOf,
    player: {
      id: playerId,
      name: String(forecast.player?.name || playerId),
      position: String(forecast.player?.position || "UNKNOWN"),
      team: String(forecast.player?.team || "FA"),
    },
    baseline: {
      mean: finite(forecast.baseline?.mean),
      reliability: finite(forecast.baseline?.reliability),
    },
    availability: {
      probability: finite(forecast.availability?.probability),
      confidence: finite(forecast.availability?.confidence),
    },
    activeDistribution: {
      mean: finite(forecast.activeDistribution?.mean),
      standardDeviation: finite(forecast.activeDistribution?.standardDeviation),
    },
    distribution: {
      shape: String(forecast.distribution?.shape || "unknown"),
      mean: finite(forecast.distribution?.mean),
      standardDeviation: finite(forecast.distribution?.standardDeviation),
      p10: finite(forecast.distribution?.p10),
      p25: finite(forecast.distribution?.p25),
      p50: finite(forecast.distribution?.p50),
      p75: finite(forecast.distribution?.p75),
      p90: finite(forecast.distribution?.p90),
      p95: finite(forecast.distribution?.p95),
      cvar10: finite(forecast.distribution?.cvar10),
    },
    probabilities: {
      bustThreshold: finite(forecast.probabilities?.bustThreshold),
      ceilingThreshold: finite(forecast.probabilities?.ceilingThreshold),
    },
    confidence: finite(forecast.confidence),
    calibration: forecast.calibration ? {
      applied: forecast.calibration.applied === true,
      modelVersion: forecast.calibration.modelVersion || null,
      modelDigest: forecast.calibration.modelDigest || null,
      group: forecast.calibration.group || null,
    } : null,
  };
}

function forecastTarget(snapshot) {
  return `${snapshot.season}:${snapshot.week}:${snapshot.player.id}`;
}

function forecastDedupeKey(snapshot, options = {}) {
  const bucket = hourBucket(snapshot.asOf, options.bucketMs);
  return `${forecastTarget(snapshot)}:${snapshot.version}:${bucket}`;
}

function compactScore(score) {
  const excluded = new Set(["forecast", "outcome"]);
  return Object.fromEntries(Object.entries(score).filter(([key]) => !excluded.has(key)));
}

function forecastRecord(forecast, options = {}) {
  const snapshot = compactForecast(forecast, options);
  const core = {
    schemaVersion: FORECAST_RECORD_SCHEMA,
    type: "forecast",
    target: forecastTarget(snapshot),
    dedupeKey: forecastDedupeKey(snapshot, options),
    createdAt: iso(options.createdAt || Date.now()),
    forecast: snapshot,
    context: {
      evidenceHead: options.evidenceHead || null,
      forecastDigest: options.forecastDigest || null,
      requestId: options.requestId || null,
    },
  };
  return {
    id: `forecast_${sha256(core).slice(0, 24)}`,
    ...core,
  };
}

function compactOutcome(outcome = {}) {
  return {
    season: Number(outcome.season),
    week: Number(outcome.week),
    oraclePlayerId: outcome.oraclePlayerId ? String(outcome.oraclePlayerId) : null,
    sourcePlayerId: outcome.sourcePlayerId ? String(outcome.sourcePlayerId) : null,
    name: String(outcome.name || ""),
    position: String(outcome.position || "UNKNOWN"),
    team: String(outcome.team || "FA"),
    played: Boolean(outcome.played),
    pointsPpr: finite(outcome.pointsPpr),
    pointsHalf: finite(outcome.pointsHalf),
    pointsStandard: finite(outcome.pointsStandard),
    opportunities: finite(outcome.opportunities),
  };
}

function settlementRecord(forecastRow, outcome, options = {}) {
  const compact = compactOutcome(outcome);
  const observedAt = iso(options.observedAt || Date.now());
  const score = scoreForecast(forecastRow.forecast, compact);
  const core = {
    schemaVersion: FORECAST_RECORD_SCHEMA,
    type: "settlement",
    forecastId: forecastRow.id,
    target: forecastRow.target,
    observedAt,
    outcome: compact,
    score: compactScore(score),
  };
  return {
    id: `settlement_${sha256(core).slice(0, 24)}`,
    ...core,
  };
}

function chainEntry(record, sequence, previousHash) {
  const core = { sequence, previousHash, record };
  return { ...core, hash: sha256(core) };
}

function validateRecord(record) {
  if (!record || record.schemaVersion !== FORECAST_RECORD_SCHEMA) {
    return { valid: false, error: "Forecast journal record schema is invalid" };
  }
  if (!['forecast', 'settlement'].includes(record.type)) {
    return { valid: false, error: "Forecast journal record type is invalid" };
  }
  const { id, ...core } = record;
  const prefix = record.type === "forecast" ? "forecast" : "settlement";
  const expected = `${prefix}_${sha256(core).slice(0, 24)}`;
  if (id !== expected) return { valid: false, error: `Forecast journal id ${id} is invalid` };
  return { valid: true };
}

function validateChain(entries = []) {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sequence !== index + 1) {
      return { valid: false, index, error: `Invalid sequence ${entry.sequence}` };
    }
    if (entry.previousHash !== previousHash) {
      return { valid: false, index, error: `Invalid previous hash at ${entry.sequence}` };
    }
    const record = validateRecord(entry.record);
    if (!record.valid) return { valid: false, index, error: record.error };
    const expected = sha256({
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      record: entry.record,
    });
    if (entry.hash !== expected) {
      return { valid: false, index, error: `Invalid entry hash at ${entry.sequence}` };
    }
    previousHash = entry.hash;
  }
  return { valid: true, entries: entries.length, headHash: previousHash };
}

async function appendLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

class ForecastJournal {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError("ForecastJournal requires filePath");
    this.filePath = path.resolve(options.filePath);
    this.clock = options.clock || Date.now;
    this.maxRecords = Math.max(100, Number(options.maxRecords || 200_000));
    this.bucketMs = Math.max(60_000, Number(options.bucketMs || 6 * 60 * 60 * 1000));
    this.entries = [];
    this.forecasts = new Map();
    this.settlements = new Map();
    this.dedupeKeys = new Map();
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
        throw Object.assign(new Error(`Invalid forecast journal JSON at line ${index + 1}`), {
          code: "FORECAST_JOURNAL_INVALID",
          cause: error,
        });
      }
    });
    const verification = validateChain(entries);
    if (!verification.valid) {
      throw Object.assign(new Error(verification.error), {
        code: "FORECAST_JOURNAL_INVALID",
        details: verification,
      });
    }
    for (const entry of entries) this.applyEntry(entry);
    this.lastVerification = verification;
    this.initialized = true;
    return this.status();
  }

  applyEntry(entry) {
    if (this.entries.some((existing) => existing.record.id === entry.record.id)) {
      throw Object.assign(new Error(`Duplicate forecast journal id ${entry.record.id}`), {
        code: "FORECAST_JOURNAL_INVALID",
      });
    }
    this.entries.push(entry);
    if (entry.record.type === "forecast") {
      this.forecasts.set(entry.record.id, entry.record);
      this.dedupeKeys.set(entry.record.dedupeKey, entry.record.id);
    } else {
      this.settlements.set(entry.record.forecastId, entry.record);
    }
    this.sequence = entry.sequence;
    this.headHash = entry.hash;
  }

  enqueue(operation) {
    const pending = this.writeTail.then(operation);
    this.writeTail = pending.catch(() => {});
    return pending;
  }

  async appendRecord(record) {
    if (this.entries.length >= this.maxRecords) {
      throw Object.assign(new Error("Forecast journal record limit reached"), {
        code: "FORECAST_JOURNAL_LIMIT",
      });
    }
    const entry = chainEntry(record, this.sequence + 1, this.headHash);
    await appendLine(this.filePath, entry);
    this.applyEntry(entry);
    this.lastVerification = {
      valid: true,
      entries: this.entries.length,
      headHash: this.headHash,
    };
    return entry;
  }

  async recordForecasts(forecasts, options = {}) {
    if (!Array.isArray(forecasts)) throw new TypeError("Forecast journal requires an array");
    return this.enqueue(async () => {
      if (!this.initialized) throw new Error("Forecast journal is not initialized");
      const results = [];
      for (const forecast of forecasts) {
        const record = forecastRecord(forecast, {
          ...options,
          bucketMs: this.bucketMs,
          createdAt: options.createdAt || this.clock(),
        });
        const existing = this.dedupeKeys.get(record.dedupeKey);
        if (existing) {
          results.push({ inserted: false, duplicate: true, forecastId: existing });
          continue;
        }
        const entry = await this.appendRecord(record);
        results.push({
          inserted: true,
          duplicate: false,
          forecastId: record.id,
          sequence: entry.sequence,
          hash: entry.hash,
        });
      }
      return results;
    });
  }

  async settleOutcomes(outcomes, options = {}) {
    if (!Array.isArray(outcomes)) throw new TypeError("Forecast settlement requires outcomes");
    return this.enqueue(async () => {
      if (!this.initialized) throw new Error("Forecast journal is not initialized");
      const observedAt = iso(options.observedAt || this.clock());
      const currentWeek = Number(options.currentWeek || Number.POSITIVE_INFINITY);
      const byTarget = new Map();
      for (const outcome of outcomes) {
        if (!outcome.oraclePlayerId) continue;
        if (!options.force && Number(outcome.week) >= currentWeek) continue;
        byTarget.set(
          `${Number(outcome.season)}:${Number(outcome.week)}:${String(outcome.oraclePlayerId)}`,
          outcome,
        );
      }
      const results = [];
      for (const forecast of this.forecasts.values()) {
        if (this.settlements.has(forecast.id)) continue;
        const outcome = byTarget.get(forecast.target);
        if (!outcome) continue;
        if (Date.parse(observedAt) <= Date.parse(forecast.forecast.asOf)) continue;
        const record = settlementRecord(forecast, outcome, { observedAt });
        const entry = await this.appendRecord(record);
        results.push({
          inserted: true,
          forecastId: forecast.id,
          settlementId: record.id,
          target: forecast.target,
          sequence: entry.sequence,
          score: record.score,
        });
      }
      return results;
    });
  }

  trainingRows(options = {}) {
    const seasons = options.seasons ? new Set(options.seasons.map(Number)) : null;
    const positions = options.positions
      ? new Set(options.positions.map((value) => String(value).toUpperCase()))
      : null;
    const before = options.before ? Date.parse(options.before) : Number.POSITIVE_INFINITY;
    const latest = new Map();
    for (const settlement of this.settlements.values()) {
      const forecast = this.forecasts.get(settlement.forecastId);
      if (!forecast) continue;
      if (seasons && !seasons.has(forecast.forecast.season)) continue;
      if (positions && !positions.has(forecast.forecast.player.position.toUpperCase())) continue;
      if (Date.parse(forecast.forecast.asOf) >= before) continue;
      const existing = latest.get(forecast.target);
      if (!existing || Date.parse(forecast.forecast.asOf) > Date.parse(existing.forecast.asOf)) {
        latest.set(forecast.target, {
          forecast: forecast.forecast,
          outcome: settlement.outcome,
          score: settlement.score,
          forecastId: forecast.id,
          settlementId: settlement.id,
        });
      }
    }
    return [...latest.values()].sort((left, right) => (
      left.forecast.season - right.forecast.season
      || left.forecast.week - right.forecast.week
      || left.forecast.player.id.localeCompare(right.forecast.player.id)
    ));
  }

  report(options = {}) {
    const rows = this.trainingRows(options);
    const scored = rows.map((row) => scoreForecast(row.forecast, row.outcome));
    const byPosition = {};
    for (const row of scored) {
      const position = row.position;
      byPosition[position] = byPosition[position] || [];
      byPosition[position].push(row);
    }
    return {
      version: FORECAST_JOURNAL_VERSION,
      filters: {
        seasons: options.seasons || null,
        positions: options.positions || null,
        before: options.before || null,
      },
      summary: summarizeScores(scored),
      byPosition: Object.fromEntries(Object.entries(byPosition).map(([position, group]) => [
        position,
        summarizeScores(group),
      ])),
      targets: rows.length,
    };
  }

  unresolved() {
    return [...this.forecasts.values()].filter((forecast) => !this.settlements.has(forecast.id));
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
    this.lastVerification = validateChain(entries);
    return this.lastVerification;
  }

  status() {
    const settled = this.settlements.size;
    return {
      version: FORECAST_JOURNAL_VERSION,
      schemaVersion: FORECAST_RECORD_SCHEMA,
      initialized: this.initialized,
      valid: this.lastVerification.valid,
      records: this.entries.length,
      forecasts: this.forecasts.size,
      settlements: settled,
      unresolved: this.forecasts.size - settled,
      trainingTargets: this.initialized ? this.trainingRows().length : 0,
      sequence: this.sequence,
      headHash: this.headHash,
      maxRecords: this.maxRecords,
      bucketMs: this.bucketMs,
    };
  }

  async stop() {
    await this.writeTail;
  }
}

module.exports = {
  FORECAST_JOURNAL_VERSION,
  FORECAST_RECORD_SCHEMA,
  GENESIS_HASH,
  ForecastJournal,
  chainEntry,
  compactForecast,
  compactOutcome,
  compactScore,
  forecastDedupeKey,
  forecastRecord,
  forecastTarget,
  hourBucket,
  settlementRecord,
  validateChain,
  validateRecord,
};
