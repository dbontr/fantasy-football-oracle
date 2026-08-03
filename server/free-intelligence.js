"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { atomicWrite } = require("./event-store.js");
const { ForecastJournal } = require("./forecast-journal.js");
const {
  DEFAULT_CONTEXT_POLICY_PATH,
  FreeContextPolicyLoader,
  applyContextPolicy,
} = require("./free-context-policy.js");
const { FreeCalibrationLoader, validateCalibrationDocument } = require("./free-calibration-loader.js");
const { FREE_SOURCES, publicSourceCatalog } = require("./free-source-catalog.js");
const { FreeSourceCache } = require("./free-source-cache.js");
const { NflverseConnector } = require("./nflverse-connector.js");
const { NwsConnector } = require("./nws-connector.js");
const { PlayerIdentityResolver } = require("./player-identity.js");
const { applyCalibration, validateCalibration } = require("./probabilistic-calibration.js");
const { SleeperConnector } = require("./sleeper-connector.js");

const FREE_INTELLIGENCE_VERSION = "oracle-free-intelligence-2026.2";
const DEFAULT_SEED_CALIBRATION = path.resolve(
  __dirname,
  "..",
  "data",
  "calibration",
  "free-probabilistic.json",
);

function sourceList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((row) => row.trim()).filter(Boolean))];
  return [...new Set(String(value || "").split(",").map((row) => row.trim()).filter(Boolean))];
}

function compactError(error) {
  return {
    code: error?.code || error?.name || "FREE_SOURCE_ERROR",
    message: String(error?.message || error),
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

class FreeIntelligence {
  constructor(options = {}) {
    if (typeof options.datasetProvider !== "function") {
      throw new TypeError("FreeIntelligence requires datasetProvider");
    }
    if (!options.advancedIntelligence) {
      throw new TypeError("FreeIntelligence requires advancedIntelligence");
    }
    this.datasetProvider = options.datasetProvider;
    this.advanced = options.advancedIntelligence;
    this.runtimeDir = path.resolve(
      options.runtimeDir || path.join(process.cwd(), "data", "runtime", "free-intelligence"),
    );
    this.seedCalibrationPath = path.resolve(
      options.seedCalibrationPath || DEFAULT_SEED_CALIBRATION,
    );
    this.runtimeCalibrationPath = path.resolve(
      options.runtimeCalibrationPath || path.join(this.runtimeDir, "calibration.json"),
    );
    this.contextPolicyPath = path.resolve(
      options.contextPolicyPath || DEFAULT_CONTEXT_POLICY_PATH,
    );
    this.clock = options.clock || Date.now;
    this.log = options.logger || console;
    this.eventStore = options.eventStore || null;
    this.enabledSources = new Set(sourceList(options.enabledSources));
    this.syncEnabled = options.syncEnabled === true;
    this.syncIntervalMs = Math.max(60 * 60 * 1000, Number(
      options.syncIntervalMs || 6 * 60 * 60 * 1000,
    ));
    this.sleeperLeagueId = options.sleeperLeagueId || null;
    this.nwsUserAgent = String(options.nwsUserAgent || "").trim() || undefined;
    this.cache = options.cache || new FreeSourceCache({
      rootDir: path.join(this.runtimeDir, "cache"),
      sources: FREE_SOURCES,
      timeoutMs: options.timeoutMs || 60_000,
    });
    this.journal = options.journal || new ForecastJournal({
      filePath: path.join(this.runtimeDir, "forecast-journal.jsonl"),
      clock: this.clock,
      maxRecords: options.maxJournalRecords || 200_000,
    });
    this.calibration = new FreeCalibrationLoader({ filePath: this.runtimeCalibrationPath });
    this.contextPolicy = new FreeContextPolicyLoader({ filePath: this.contextPolicyPath });
    this.identity = null;
    this.sleeper = null;
    this.nflverse = null;
    this.nws = null;
    this.initialized = false;
    this.timer = null;
    this.syncPromise = null;
    this.lastSync = null;
  }

  dataset() {
    const dataset = this.datasetProvider();
    if (!dataset || !Array.isArray(dataset.players)) {
      throw Object.assign(new Error("Free intelligence requires a loaded dataset"), {
        code: "PLAYER_DATA_UNAVAILABLE",
      });
    }
    return dataset;
  }

  ensureInitialized() {
    if (!this.initialized) {
      throw Object.assign(new Error("Free intelligence is not initialized"), {
        code: "FREE_INTELLIGENCE_NOT_READY",
      });
    }
  }

  async installSeedCalibration() {
    if (await fileExists(this.runtimeCalibrationPath)) return;
    if (!await fileExists(this.seedCalibrationPath)) return;
    const value = JSON.parse(await fs.readFile(this.seedCalibrationPath, "utf8"));
    const validation = validateCalibrationDocument(value);
    if (!validation.valid) {
      throw Object.assign(new Error(validation.error), { code: "FREE_CALIBRATION_INVALID" });
    }
    await fs.mkdir(path.dirname(this.runtimeCalibrationPath), { recursive: true });
    await atomicWrite(this.runtimeCalibrationPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  refreshIdentity() {
    this.identity = new PlayerIdentityResolver(this.dataset().players);
    this.sleeper = new SleeperConnector({
      cache: this.cache,
      identityResolver: this.identity,
      clock: this.clock,
    });
    this.nflverse = new NflverseConnector({
      cache: this.cache,
      identityResolver: this.identity,
      datasetProvider: this.datasetProvider,
      clock: this.clock,
    });
    this.nws = new NwsConnector({
      cache: this.cache,
      datasetProvider: this.datasetProvider,
      clock: this.clock,
      userAgent: this.nwsUserAgent,
    });
    return this.identity.status();
  }

  async initialize() {
    if (this.initialized) return this.status();
    await fs.mkdir(this.runtimeDir, { recursive: true });
    await this.installSeedCalibration();
    this.calibration.load({ optional: true, force: true });
    this.contextPolicy.load({ optional: true, force: true });
    await this.journal.initialize();
    this.refreshIdentity();
    this.initialized = true;
    if (this.syncEnabled && this.enabledSources.size) this.startScheduler();
    return this.status();
  }

  calibrationModel() {
    return this.calibration.load({ optional: true });
  }

  calibrateForecast(forecast) {
    const model = this.calibrationModel();
    const calibrated = model ? applyCalibration(forecast, model) : forecast;
    const policy = this.contextPolicy.load({ optional: true });
    return policy ? applyContextPolicy(calibrated, policy) : calibrated;
  }

  async recordForecasts(forecasts, options = {}) {
    this.ensureInitialized();
    const season = Number(options.season || this.dataset().meta?.season || new Date(this.clock()).getUTCFullYear());
    return this.journal.recordForecasts(forecasts, {
      season,
      week: options.week,
      asOf: options.asOf,
      evidenceHead: options.evidenceHead,
      forecastDigest: options.forecastDigest,
      requestId: options.requestId,
      createdAt: this.clock(),
    });
  }

  enabled(provider) {
    return this.enabledSources.has(String(provider));
  }

  allowedProviders(requested = null) {
    const providers = requested ? sourceList(requested) : [...this.enabledSources];
    const supported = new Set(["sleeper", "nflverse", "nws"]);
    const invalid = providers.filter((provider) => !supported.has(provider));
    if (invalid.length) {
      throw Object.assign(new Error(`Unsupported free sources: ${invalid.join(", ")}`), {
        code: "FREE_SOURCE_UNSUPPORTED",
      });
    }
    const disabled = providers.filter((provider) => !this.enabled(provider));
    if (disabled.length) {
      throw Object.assign(new Error(`Free sources are not enabled: ${disabled.join(", ")}`), {
        code: "FREE_SOURCE_DISABLED",
      });
    }
    return providers;
  }

  async ingestObservations(rows = []) {
    const observations = Array.isArray(rows) ? rows : [];
    if (!observations.length) return { accepted: 0, duplicates: 0, batches: 0 };
    const batchSize = Math.max(1, Number(this.advanced.maxEvidenceBatch || 500));
    const summary = { accepted: 0, duplicates: 0, batches: 0 };
    for (let index = 0; index < observations.length; index += batchSize) {
      const result = await this.advanced.ingestEvidence(observations.slice(index, index + batchSize));
      summary.accepted += Number(result.accepted || 0);
      summary.duplicates += Number(result.duplicates || 0);
      summary.batches += 1;
    }
    return summary;
  }

  compactProviderResult(provider, result) {
    if (provider === "sleeper") {
      return {
        ok: true,
        stale: result.stale,
        syncedAt: result.syncedAt,
        state: result.state,
        players: result.players,
        trends: {
          adds: result.trends.adds.length,
          drops: result.trends.drops.length,
        },
        observations: result.observations.length,
        league: result.league ? {
          id: result.league.league?.league_id || null,
          name: result.league.league?.name || null,
          rosters: result.league.rosters?.length || 0,
          users: result.league.users?.length || 0,
          matchups: result.league.matchups?.length || 0,
          stale: result.league.stale,
        } : null,
        attribution: result.attribution,
      };
    }
    if (provider === "nws") {
      return {
        ok: true,
        stale: result.stale,
        syncedAt: result.syncedAt,
        week: result.week,
        games: result.games,
        observations: result.observations.length,
        networkRequests: result.networkRequests,
        attribution: result.attribution,
      };
    }
    return {
      ok: true,
      stale: result.stale,
      syncedAt: result.syncedAt,
      season: result.season,
      currentWeek: result.currentWeek,
      players: result.players,
      outcomeSummary: result.outcomeSummary,
      features: result.features,
      observations: result.observations.length,
      attribution: result.attribution,
    };
  }

  async syncProvider(provider, options = {}) {
    if (provider === "sleeper") {
      const result = await this.sleeper.sync({
        force: options.force,
        leagueId: options.leagueId || this.sleeperLeagueId,
        week: options.currentWeek,
      });
      const ingestion = await this.ingestObservations(result.observations);
      return {
        raw: result,
        public: {
          ...this.compactProviderResult(provider, result),
          evidence: {
            accepted: ingestion.accepted,
            duplicates: ingestion.duplicates,
          },
        },
      };
    }
    if (provider === "nws") {
      const result = await this.nws.sync({
        week: options.currentWeek || options.week,
        maximumGames: options.maximumGames,
        force: options.force,
      });
      const ingestion = await this.ingestObservations(result.observations);
      return {
        raw: result,
        public: {
          ...this.compactProviderResult(provider, result),
          evidence: { accepted: ingestion.accepted, duplicates: ingestion.duplicates },
        },
      };
    }
    if (provider === "nflverse") {
      const season = Number(options.season || this.dataset().meta?.season);
      const currentWeek = Math.max(1, Number(options.currentWeek || 1));
      const result = await this.nflverse.sync({
        season,
        currentWeek,
        lookback: options.lookback,
        featureDatasets: options.featureDatasets,
        force: options.force,
      });
      const ingestion = await this.ingestObservations(result.observations);
      const settlements = await this.journal.settleOutcomes(result.outcomes, {
        currentWeek,
        observedAt: this.clock(),
      });
      return {
        raw: result,
        public: {
          ...this.compactProviderResult(provider, result),
          evidence: {
            accepted: ingestion.accepted,
            duplicates: ingestion.duplicates,
          },
          settlements: settlements.length,
        },
      };
    }
    throw Object.assign(new Error(`Unsupported free source ${provider}`), {
      code: "FREE_SOURCE_UNSUPPORTED",
    });
  }

  async sync(options = {}) {
    this.ensureInitialized();
    if (this.syncPromise) return this.syncPromise;
    const providers = this.allowedProviders(options.providers);
    if (!providers.length) {
      throw Object.assign(new Error("No free sources are enabled"), {
        code: "FREE_SOURCE_DISABLED",
      });
    }
    const startedAt = Number(this.clock());
    this.syncPromise = (async () => {
      const results = {};
      let successes = 0;
      for (const provider of providers) {
        try {
          const result = await this.syncProvider(provider, options);
          results[provider] = result.public;
          successes += 1;
        } catch (error) {
          results[provider] = { ok: false, error: compactError(error) };
          this.log.warn?.({ provider, error }, "Free source synchronization failed");
        }
      }
      const completedAt = Number(this.clock());
      this.lastSync = {
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        providers: results,
        successes,
        failures: providers.length - successes,
      };
      await this.eventStore?.append?.("free-intelligence.synced", this.lastSync, {
        source: "free-intelligence",
      });
      return {
        version: FREE_INTELLIGENCE_VERSION,
        ...this.lastSync,
      };
    })();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  startScheduler() {
    if (this.timer || !this.syncEnabled || !this.enabledSources.size) return;
    this.timer = setInterval(() => {
      this.sync().catch((error) => {
        this.log.warn?.({ error }, "Scheduled free intelligence sync failed");
      });
    }, this.syncIntervalMs);
    this.timer.unref?.();
  }

  stopScheduler() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  journalReport(options = {}) {
    this.ensureInitialized();
    return this.journal.report(options);
  }

  async rebuildCalibration(options = {}) {
    this.ensureInitialized();
    const rows = this.journal.trainingRows();
    const seasons = [...new Set(rows.map((row) => Number(row.outcome.season)))].sort();
    if (seasons.length < 2) {
      throw Object.assign(new Error("Journal calibration requires at least two completed seasons"), {
        code: "FREE_CALIBRATION_INSUFFICIENT_SEASONS",
      });
    }
    const holdoutSeason = Number(options.holdoutSeason || seasons.at(-1));
    const training = rows.filter((row) => Number(row.outcome.season) < holdoutSeason);
    const holdout = rows.filter((row) => Number(row.outcome.season) === holdoutSeason);
    const candidate = validateCalibration(training, holdout, {
      minimumSamples: options.minimumSamples || 80,
      minimumHoldoutSamples: options.minimumHoldoutSamples || 300,
      minimumWisImprovement: options.minimumWisImprovement ?? 0,
      maximumRmseRegression: options.maximumRmseRegression ?? 0.05,
      maximumBrierRegression: options.maximumBrierRegression ?? 0.01,
      coverageMinimum: options.coverageMinimum ?? 0.68,
      coverageMaximum: options.coverageMaximum ?? 0.92,
      trainingSeasons: seasons.filter((season) => season < holdoutSeason),
      holdoutSeason,
      source: "oracle-production-forecast-journal",
      generatedAt: this.clock(),
    });
    if (candidate.approved) {
      await atomicWrite(this.runtimeCalibrationPath, `${JSON.stringify(candidate, null, 2)}\n`);
      this.calibration.load({ force: true });
      await this.eventStore?.append?.("free-intelligence.calibration-promoted", {
        version: candidate.version,
        digest: candidate.digest,
        trainingSeasons: candidate.trainingSeasons,
        holdoutSeason: candidate.holdoutSeason,
        validation: candidate.validation,
      }, { source: "free-intelligence" });
    } else {
      await this.eventStore?.append?.("free-intelligence.calibration-rejected", {
        version: candidate.version,
        digest: candidate.digest,
        validation: candidate.validation,
      }, { source: "free-intelligence" });
    }
    return candidate;
  }

  status() {
    const calibration = this.calibration.status();
    const journal = this.journal.status();
    return {
      version: FREE_INTELLIGENCE_VERSION,
      initialized: this.initialized,
      networkAtStartup: false,
      sync: {
        enabled: this.syncEnabled,
        running: Boolean(this.syncPromise),
        intervalMs: this.syncIntervalMs,
        enabledSources: [...this.enabledSources],
        last: this.lastSync,
      },
      sources: {
        catalog: publicSourceCatalog(),
        runtime: this.cache.status(),
      },
      identity: this.identity?.status() || null,
      calibration,
      contextPolicy: this.contextPolicy.status(),
      journal: {
        version: journal.version,
        initialized: journal.initialized,
        valid: journal.valid,
        records: journal.records,
        forecasts: journal.forecasts,
        settlements: journal.settlements,
        unresolved: journal.unresolved,
        trainingTargets: journal.trainingTargets,
        sequence: journal.sequence,
        headHash: journal.headHash,
      },
    };
  }

  async verify() {
    this.ensureInitialized();
    return {
      journal: await this.journal.verifyFile(),
      calibration: this.calibration.status(),
      contextPolicy: this.contextPolicy.status(),
    };
  }

  async stop() {
    this.stopScheduler();
    if (this.syncPromise) {
      try {
        await this.syncPromise;
      } catch {
        // Sync errors are already captured per provider.
      }
    }
    await this.journal.stop();
    this.initialized = false;
  }
}

module.exports = {
  DEFAULT_SEED_CALIBRATION,
  FREE_INTELLIGENCE_VERSION,
  FreeIntelligence,
  compactError,
  fileExists,
  sourceList,
};
