"use strict";

const path = require("node:path");

const { EvidenceStore } = require("./evidence-store.js");
const { featureCatalogSummary } = require("./feature-catalog.js");
const {
  forecastPlayer,
} = require("./probabilistic-forecast.js");
const {
  evaluatePortfolios,
} = require("./scenario-engine.js");
const { rankInformationNeeds } = require("./robust-decision.js");
const { sha256 } = require("./lineage.js");

const ADVANCED_INTELLIGENCE_VERSION = "oracle-intelligence-v5-2026.1";

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

class AdvancedIntelligence {
  constructor(options = {}) {
    if (typeof options.datasetProvider !== "function") {
      throw new TypeError("AdvancedIntelligence requires datasetProvider");
    }
    this.datasetProvider = options.datasetProvider;
    this.runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "data", "runtime", "v5"));
    this.clock = options.clock || Date.now;
    this.log = options.logger || console;
    this.maxForecastPlayers = Math.max(1, Number(options.maxForecastPlayers || 64));
    this.maxEvidenceBatch = Math.max(1, Number(options.maxEvidenceBatch || 500));
    this.maxScenarios = Math.min(50000, Math.max(100, Number(options.maxScenarios || 50000)));
    this.evidence = options.evidenceStore || new EvidenceStore({
      filePath: path.join(this.runtimeDir, "evidence.jsonl"),
      clock: this.clock,
      maxObservations: options.maxObservations || 250_000,
    });
    this.initialized = false;
  }

  ensureInitialized() {
    if (!this.initialized) {
      const error = new Error("Advanced intelligence is not initialized");
      error.code = "ADVANCED_INTELLIGENCE_NOT_READY";
      throw error;
    }
  }

  dataset() {
    const dataset = this.datasetProvider();
    if (!dataset || !Array.isArray(dataset.players)) {
      const error = new Error("Advanced intelligence requires a loaded player dataset");
      error.code = "PLAYER_DATA_UNAVAILABLE";
      throw error;
    }
    return dataset;
  }

  async initialize() {
    if (this.initialized) return this.status();
    await this.evidence.initialize();
    this.initialized = true;
    return this.status();
  }

  playerById(id) {
    const player = this.dataset().players.find((row) => String(row.id) === String(id));
    if (!player) {
      const error = new Error(`Unknown player ${id}`);
      error.code = "PLAYER_UNKNOWN";
      error.statusCode = 404;
      throw error;
    }
    return player;
  }

  playersById(ids) {
    const uniqueIds = [...new Set((ids || []).map(String))];
    if (!uniqueIds.length) {
      const error = new Error("At least one player id is required");
      error.code = "PLAYER_IDS_REQUIRED";
      throw error;
    }
    if (uniqueIds.length > this.maxForecastPlayers) {
      const error = new RangeError(
        `At most ${this.maxForecastPlayers} players can be forecast together`,
      );
      error.code = "FORECAST_PLAYER_LIMIT";
      throw error;
    }
    return uniqueIds.map((id) => this.playerById(id));
  }

  status() {
    const evidence = this.evidence.status();
    return {
      version: ADVANCED_INTELLIGENCE_VERSION,
      initialized: this.initialized,
      evidence: {
        version: evidence.version,
        schemaVersion: evidence.schemaVersion,
        valid: evidence.valid,
        observations: evidence.observations,
        sequence: evidence.sequence,
        headHash: evidence.headHash,
        sources: evidence.sources,
        features: evidence.features,
      },
      catalog: featureCatalogSummary(),
      limits: {
        forecastPlayers: this.maxForecastPlayers,
        evidenceBatch: this.maxEvidenceBatch,
        scenarios: this.maxScenarios,
      },
    };
  }

  async ingestEvidence(rows) {
    this.ensureInitialized();
    if (!Array.isArray(rows) || !rows.length) {
      const error = new TypeError("Evidence ingestion requires a non-empty array");
      error.code = "EVIDENCE_BATCH_REQUIRED";
      throw error;
    }
    if (rows.length > this.maxEvidenceBatch) {
      const error = new RangeError(
        `Evidence batches are limited to ${this.maxEvidenceBatch} observations`,
      );
      error.code = "EVIDENCE_BATCH_LIMIT";
      throw error;
    }
    const results = await this.evidence.ingestMany(rows);
    return {
      version: ADVANCED_INTELLIGENCE_VERSION,
      accepted: results.filter((row) => row.inserted).length,
      duplicates: results.filter((row) => row.duplicate).length,
      results,
      evidence: this.status().evidence,
    };
  }

  queryEvidence(options = {}) {
    this.ensureInitialized();
    return {
      version: ADVANCED_INTELLIGENCE_VERSION,
      observations: this.evidence.query({
        entityType: options.entityType,
        entityId: options.entityId,
        feature: options.feature,
        source: options.source,
        limit: clampInteger(options.limit, 100, 1, 1000),
      }),
    };
  }

  playerEvidence(id, options = {}) {
    this.ensureInitialized();
    const player = this.playerById(id);
    const resolved = this.evidence.resolveEntity("player", String(player.id), {
      asOf: options.asOf,
      additionalObservations: options.additionalObservations,
    });
    return {
      version: ADVANCED_INTELLIGENCE_VERSION,
      asOf: new Date(options.asOf || this.clock()).toISOString(),
      player: {
        id: String(player.id),
        name: player.name,
        team: player.team,
        position: player.position,
      },
      resolved,
      observations: options.includeObservations
        ? this.evidence.query({
          entityType: "player",
          entityId: String(player.id),
          limit: clampInteger(options.limit, 100, 1, 1000),
        })
        : undefined,
    };
  }

  validateTemporaryEvidence(rows) {
    const observations = Array.isArray(rows) ? rows : [];
    if (observations.length > this.maxEvidenceBatch) {
      const error = new RangeError(
        `Temporary evidence is limited to ${this.maxEvidenceBatch} observations`,
      );
      error.code = "EVIDENCE_BATCH_LIMIT";
      throw error;
    }
    return observations;
  }

  forecast(options = {}) {
    this.ensureInitialized();
    const players = this.playersById(options.playerIds);
    const additionalObservations = this.validateTemporaryEvidence(
      options.additionalObservations,
    );
    const week = clampInteger(options.week, 1, 1, 18);
    const asOf = new Date(options.asOf || this.clock()).toISOString();
    const forecasts = players.map((player) => forecastPlayer(player, this.evidence, {
      week,
      asOf,
      additionalObservations,
      gameId: options.gameIds?.[String(player.id)] || null,
      bustThreshold: options.bustThresholds?.[String(player.id)],
      ceilingThreshold: options.ceilingThresholds?.[String(player.id)],
    }));
    const informationNeeds = rankInformationNeeds(forecasts, {
      limit: clampInteger(options.informationLimit, 12, 1, 50),
    });
    const digest = sha256({
      version: ADVANCED_INTELLIGENCE_VERSION,
      asOf,
      week,
      evidenceHead: this.evidence.status().headHash,
      forecasts: forecasts.map((row) => ({
        playerId: row.player.id,
        mean: row.distribution.mean,
        p10: row.distribution.p10,
        p90: row.distribution.p90,
        confidence: row.confidence,
      })),
    });
    return {
      version: ADVANCED_INTELLIGENCE_VERSION,
      generatedAt: new Date(this.clock()).toISOString(),
      asOf,
      week,
      digest,
      evidenceHead: this.evidence.status().headHash,
      forecasts,
      informationNeeds,
    };
  }

  evaluate(options = {}) {
    this.ensureInitialized();
    if (!Array.isArray(options.portfolios) || !options.portfolios.length) {
      const error = new TypeError("Portfolio evaluation requires portfolios");
      error.code = "PORTFOLIOS_REQUIRED";
      throw error;
    }
    const requestedScenarios = Number(options.scenarios || 5000);
    if (!Number.isFinite(requestedScenarios) || requestedScenarios < 100
      || requestedScenarios > this.maxScenarios) {
      const error = new RangeError(`Scenarios must be between 100 and ${this.maxScenarios}`);
      error.code = "SCENARIO_LIMIT";
      throw error;
    }
    const playerIds = [...new Set(options.portfolios.flatMap(
      (portfolio) => Array.isArray(portfolio.playerIds) ? portfolio.playerIds.map(String) : [],
    ))];
    const forecastResult = this.forecast({
      playerIds,
      week: options.week,
      asOf: options.asOf,
      additionalObservations: options.additionalObservations,
      gameIds: options.gameIds,
      informationLimit: options.informationLimit,
    });
    const result = evaluatePortfolios(
      forecastResult.forecasts,
      options.portfolios,
      {
        scenarios: requestedScenarios,
        seed: options.seed,
        week: forecastResult.week,
        schedule: this.dataset().schedule,
        riskAversion: options.riskAversion,
        regretPenalty: options.regretPenalty,
        bestProbabilityBonus: options.bestProbabilityBonus,
        target: options.target,
        riskLevels: options.riskLevels,
        correlationPairs: options.correlationPairs,
        informationLimit: options.informationLimit,
        includeSamples: options.includeSamples === true,
      },
    );
    return {
      ...result,
      intelligenceVersion: ADVANCED_INTELLIGENCE_VERSION,
      forecastDigest: forecastResult.digest,
      evidenceHead: forecastResult.evidenceHead,
      asOf: forecastResult.asOf,
      forecasts: forecastResult.forecasts,
    };
  }

  async verify() {
    this.ensureInitialized();
    return this.evidence.verifyFile();
  }

  async stop() {
    if (!this.initialized) return;
    await this.evidence.stop();
    this.initialized = false;
  }
}

module.exports = {
  ADVANCED_INTELLIGENCE_VERSION,
  AdvancedIntelligence,
  clampInteger,
};
