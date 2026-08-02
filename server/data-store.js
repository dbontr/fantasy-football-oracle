"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { buildDataset } = require("../scripts/build-player-data.js");
const { applyProjectionModel } = require("./projection-model.js");

function validateDataset(dataset) {
  if (!dataset || typeof dataset !== "object") {
    throw new Error("Player dataset is not an object");
  }
  if (!Array.isArray(dataset.players) || dataset.players.length < 100) {
    throw new Error("Player dataset does not contain a valid player pool");
  }
  if (!dataset.schedule || typeof dataset.schedule !== "object") {
    throw new Error("Player dataset does not contain an NFL schedule");
  }
  const validPlayers = dataset.players.filter((player) => (
    player && player.id && player.name && player.position
  ));
  if (validPlayers.length !== dataset.players.length) {
    throw new Error("Player dataset contains invalid player rows");
  }
  return dataset;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function datasetEtag(dataset) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({
      source: dataset?.meta?.generatedAt || null,
      model: dataset?.meta?.modelDigest || null,
      count: dataset?.players?.length || 0,
    }))
    .digest("base64url");
  return `"${digest}"`;
}

class DataStore {
  constructor(config, logger = console) {
    this.config = config;
    this.log = logger;
    this.dataset = null;
    this.etag = null;
    this.source = "uninitialized";
    this.loadedAt = null;
    this.lastRefreshAttempt = 0;
    this.lastRefreshAt = null;
    this.lastError = null;
    this.refreshPromise = null;
    this.timer = null;
    this.listeners = new Set();
  }

  async initialize() {
    await fs.mkdir(this.config.runtimeDir, { recursive: true });
    const candidates = [
      { path: this.config.runtimeDataPath, source: "runtime-cache" },
      { path: this.config.bundledDataPath, source: "bundled-snapshot" },
    ];
    let loaded = false;
    for (const candidate of candidates) {
      try {
        const raw = validateDataset(await readJson(candidate.path));
        this.setDataset(raw, candidate.source);
        loaded = true;
        break;
      } catch (error) {
        this.log.warn?.({ error, path: candidate.path }, "Dataset candidate unavailable");
      }
    }
    if (!loaded) throw new Error("No valid fantasy player dataset could be loaded");

    const sourceDate = Date.parse(this.dataset.meta?.generatedAt || 0);
    const stale = !Number.isFinite(sourceDate) || Date.now() - sourceDate > this.config.refreshIntervalMs;
    this.timer = setInterval(() => {
      this.refresh().catch((error) => {
        this.log.warn?.({ error }, "Scheduled player refresh failed");
      });
    }, this.config.refreshIntervalMs);
    this.timer.unref?.();
    if (stale || this.source === "bundled-snapshot") {
      setImmediate(() => this.refresh().catch(() => {}));
    }
    return this.dataset;
  }

  setDataset(rawDataset, source) {
    const modeled = applyProjectionModel(validateDataset(rawDataset));
    this.dataset = modeled;
    this.etag = datasetEtag(modeled);
    this.source = source;
    this.loadedAt = new Date().toISOString();
    this.playerMap = new Map(modeled.players.map((player) => [String(player.id), player]));
    for (const listener of this.listeners) {
      Promise.resolve(listener(modeled, this.getStatus())).catch((error) => {
        this.log.warn?.({ error }, "Dataset listener failed");
      });
    }
  }

  onDataset(listener) {
    if (typeof listener !== "function") throw new TypeError("Dataset listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(options = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const force = options.force === true;
    const elapsed = Date.now() - this.lastRefreshAttempt;
    if (!force && elapsed < this.config.minimumRefreshMs) {
      return {
        refreshed: false,
        reason: "cooldown",
        retryAfterMs: this.config.minimumRefreshMs - elapsed,
        status: this.getStatus(),
      };
    }
    this.lastRefreshAttempt = Date.now();
    this.refreshPromise = this.performRefresh()
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  async performRefresh() {
    try {
      const raw = validateDataset(await buildDataset({
        season: this.config.season,
        limit: 700,
      }));
      await writeJsonAtomic(this.config.runtimeDataPath, raw);
      this.setDataset(raw, "live-refresh");
      this.lastRefreshAt = new Date().toISOString();
      this.lastError = null;
      return { refreshed: true, status: this.getStatus() };
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.log.error?.({ error }, "Player data refresh failed");
      throw error;
    }
  }

  getDataset() {
    if (!this.dataset) throw new Error("Player dataset is not initialized");
    return this.dataset;
  }

  getPlayer(id) {
    return this.playerMap?.get(String(id)) || null;
  }

  getStatus() {
    return {
      ready: Boolean(this.dataset),
      source: this.source,
      season: this.dataset?.meta?.season || this.config.season,
      players: this.dataset?.players?.length || 0,
      generatedAt: this.dataset?.meta?.generatedAt || null,
      sourceDigest: this.dataset?.meta?.sourceDigest || null,
      provenanceVersion: this.dataset?.meta?.provenance?.version || null,
      requiredFeedsHealthy: this.dataset?.meta?.provenance?.requiredHealthy ?? null,
      allFeedsHealthy: this.dataset?.meta?.provenance?.allHealthy ?? null,
      liveFeeds: this.dataset?.meta?.provenance?.liveFeeds ?? null,
      failedFeeds: this.dataset?.meta?.provenance?.failedFeeds ?? null,
      modelGeneratedAt: this.dataset?.meta?.modelGeneratedAt || null,
      modelVersion: this.dataset?.meta?.modelVersion || null,
      coachingVersion: this.dataset?.meta?.coachingVersion || null,
      coachingCoverage: this.dataset?.coaching?.coverage || 0,
      contextVersion: this.dataset?.meta?.contextVersion || null,
      opportunityVersion: this.dataset?.meta?.opportunityVersion || null,
      opportunityCoverage: this.dataset?.opportunity?.modeledPlayers || 0,
      healthVersion: this.dataset?.meta?.healthVersion || null,
      healthAffectedPlayers: this.dataset?.health?.affectedPlayers || 0,
      healthInjuredPlayers: this.dataset?.health?.injuredPlayers || 0,
      healthNewsPlayers: this.dataset?.health?.newsPlayers || 0,
      healthMajorRecoveries: this.dataset?.health?.majorRecoveries || 0,
      intelligenceCoverage: this.dataset?.intelligence?.coverage || 0,
      intelligenceTeamCoverage: this.dataset?.intelligence?.teamCoverage || 0,
      loadedAt: this.loadedAt,
      lastRefreshAt: this.lastRefreshAt,
      lastRefreshAttempt: this.lastRefreshAttempt
        ? new Date(this.lastRefreshAttempt).toISOString()
        : null,
      refreshing: Boolean(this.refreshPromise),
      lastError: this.lastError,
      etag: this.etag,
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

module.exports = {
  DataStore,
  datasetEtag,
  validateDataset,
  writeJsonAtomic,
};
