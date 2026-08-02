"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { ArtifactRegistry } = require("./artifact-registry.js");
const { EventStore } = require("./event-store.js");
const { SnapshotCatalog } = require("./snapshot-catalog.js");
const { DecisionLedger } = require("./decision-ledger.js");
const {
  MetricsRegistry,
  ComponentHealthRegistry,
  evaluateSLOs,
} = require("./observability.js");
const { createRecommendationEnvelope, sha256 } = require("./lineage.js");
const { ChampionshipOptimizer } = require("./championship-optimizer.js");
const { registrySummary } = require("./schema-registry.js");
const { ModelRegistry } = require("./model-registry.js");
const { DriftMonitor } = require("./drift-monitor.js");

const PLATFORM_VERSION = "oracle-platform-2026.1";
const REQUEST_STARTED = Symbol("oracleRequestStarted");
const DECISION_ROUTES = Object.freeze({
  "/api/draft/simulate": "draft-simulation",
  "/api/draft/recommendations": "draft-recommendation",
  "/api/roster/analyze": "roster-analysis",
  "/api/waivers/recommend": "waiver-recommendation",
  "/api/trades/analyze": "trade-analysis",
  "/api/trades/generate": "trade-generation",
  "/api/lineup/optimize": "lineup-optimization",
  "/api/lineup/start-sit": "start-sit",
  "/api/league/simulate": "league-simulation",
  "/api/season/simulate": "season-simulation",
});

function normalizeComputeStats(stats = {}) {
  const native = stats.native && typeof stats.native === "object" ? stats.native : stats;
  const fallback = stats.fallback && typeof stats.fallback === "object" ? stats.fallback : {};
  const workers = native.workers ?? stats.workers ?? null;
  return {
    mode: stats.mode || null,
    engine: native.engine ?? stats.engine ?? null,
    engineVersion: native.engineVersion ?? stats.engineVersion ?? null,
    nativeAvailable: native.available ?? stats.nativeAvailable ?? null,
    workers,
    readyWorkers: native.readyWorkers ?? stats.readyWorkers ?? workers,
    busy: native.busy ?? stats.busy ?? null,
    queued: native.queued ?? stats.queued ?? null,
    completed: native.completed ?? stats.completed ?? null,
    failed: native.failed ?? stats.failed ?? null,
    nativeFailures: stats.nativeFailures ?? 0,
    fallbackRuns: stats.fallbackRuns ?? 0,
    fallbackWorkers: fallback.workers ?? null,
  };
}

class PlatformControlPlane {
  constructor(options = {}) {
    this.config = options.config || {};
    this.rootDir = path.resolve(options.rootDir || this.config.rootDir || process.cwd());
    this.runtimeDir = path.resolve(options.runtimeDir || this.config.runtimeDir || path.join(this.rootDir, "data", "runtime"));
    this.clock = options.clock || Date.now;
    this.log = options.logger || console;
    this.metrics = options.metrics || new MetricsRegistry({ clock: this.clock });
    this.health = options.health || new ComponentHealthRegistry({ clock: this.clock });
    this.artifacts = new ArtifactRegistry({
      rootDir: this.rootDir,
      manifestPath: this.config.artifactManifestPath,
      strict: this.config.strictArtifactIntegrity,
    });
    this.eventStore = new EventStore({
      filePath: path.join(this.runtimeDir, "platform-events.jsonl"),
      clock: () => new Date(Number(this.clock())),
    });
    this.snapshots = new SnapshotCatalog({
      directory: path.join(this.runtimeDir, "snapshots"),
      clock: () => new Date(Number(this.clock())),
    });
    this.ledger = new DecisionLedger({
      eventStore: this.eventStore,
      snapshotCatalog: this.snapshots,
      clock: () => new Date(Number(this.clock())),
    });
    this.models = new ModelRegistry({
      seedPath: path.join(this.rootDir, "data", "model-registry.json"),
      runtimePath: path.join(this.runtimeDir, "model-registry.json"),
      eventStore: this.eventStore,
      clock: () => new Date(Number(this.clock())),
    });
    this.drift = new DriftMonitor({
      filePath: path.join(this.runtimeDir, "drift-observations.json"),
      eventStore: this.eventStore,
      clock: () => new Date(Number(this.clock())),
      baselines: this.config.driftBaselines || {},
      thresholds: this.config.driftThresholds || {},
    });
    this.dataStore = null;
    this.pool = null;
    this.optimizer = null;
    this.initialized = false;
    this.startedAt = Number(this.clock());
    this.backupStatusPath = path.join(this.runtimeDir, "backup-status.json");
    this.unsubscribeDataset = null;
  }

  async initialize(services = {}) {
    this.dataStore = services.dataStore;
    this.pool = services.pool;
    await fs.mkdir(this.runtimeDir, { recursive: true });
    await this.snapshots.initialize();
    await this.eventStore.initialize();
    await this.ledger.initialize();
    await this.models.initialize();
    await this.drift.initialize();
    const artifactStatus = await this.artifacts.initialize();
    this.health.set("artifact-integrity", artifactStatus.valid ? "healthy" : "degraded", {
      message: artifactStatus.valid ? "Committed artifacts match the manifest" : "Artifact manifest is missing or mismatched",
      details: artifactStatus,
    });
    this.optimizer = new ChampionshipOptimizer({
      pool: this.pool,
      datasetProvider: () => this.dataStore.getDataset(),
      metrics: this.metrics,
      maxActions: this.config.maxChampionshipActions || 24,
      timeoutMs: this.config.championshipTimeoutMs || 180_000,
    });
    const persistDatasetSnapshot = async (dataset, status = {}) => {
      const snapshot = await this.snapshots.write("player-dataset", dataset, {
        details: {
          generatedAt: dataset?.meta?.generatedAt || null,
          modelVersion: dataset?.meta?.modelVersion || null,
          sourceDigest: dataset?.meta?.sourceDigest || null,
          source: status.source || null,
          etag: status.etag || null,
        },
      });
      await this.snapshots.prune({ kind: "player-dataset", keep: 16 });
      await this.eventStore.append("data.snapshot-created", {
        digest: snapshot.digest,
        generatedAt: dataset?.meta?.generatedAt || null,
        sourceDigest: dataset?.meta?.sourceDigest || null,
        players: dataset?.players?.length || 0,
      }, { source: "platform-control-plane" });
    };
    await persistDatasetSnapshot(this.dataStore.getDataset(), this.dataStore.getStatus());
    this.unsubscribeDataset = this.dataStore.onDataset?.((dataset, status) => (
      persistDatasetSnapshot(dataset, status).catch((error) => {
        this.log.warn?.({ error }, "Dataset snapshot persistence failed");
      })
    ));
    this.initialized = true;
    await this.eventStore.append("platform.started", {
      platformVersion: PLATFORM_VERSION,
      artifactStatus,
      dataStatus: this.dataStore?.getStatus?.() || null,
      computeStatus: this.pool?.stats?.() || null,
    }, { source: "platform-control-plane" });
    this.refreshComponents();
    return this.status();
  }

  ensureInitialized() {
    if (!this.initialized) {
      const error = new Error("Platform control plane is not initialized");
      error.code = "PLATFORM_NOT_READY";
      throw error;
    }
  }

  refreshComponents() {
    if (!this.dataStore || !this.pool) return;
    const data = this.dataStore.getStatus();
    const compute = normalizeComputeStats(this.pool.stats());
    const generatedAt = data.generatedAt ? Date.parse(data.generatedAt) : null;
    const sourceAge = generatedAt ? Number(this.clock()) - generatedAt : null;
    const stale = sourceAge === null || sourceAge > (this.config.refreshIntervalMs || 6 * 60 * 60 * 1000) * 2;
    const provenance = this.dataStore.getDataset()?.meta?.provenance || null;
    this.health.set("source-feeds", provenance
      ? (provenance.requiredHealthy ? (provenance.allHealthy ? "healthy" : "degraded") : "unsafe")
      : "degraded", {
      message: provenance ? null : "Bundled snapshot predates feed-lineage telemetry",
      details: provenance ? {
        version: provenance.version,
        requiredHealthy: provenance.requiredHealthy,
        allHealthy: provenance.allHealthy,
        liveFeeds: provenance.liveFeeds,
        failedFeeds: provenance.failedFeeds,
        feeds: (provenance.feeds || []).map((row) => ({
          name: row.name, required: row.required, ok: row.ok,
          attempts: row.attempts, elapsedMs: row.elapsedMs,
          fetchedAt: row.fetchedAt, payloadHash: row.payloadHash,
          lineageHash: row.lineageHash, error: row.error,
        })),
      } : {},
    });
    this.health.set("player-data", data.ready ? (stale ? "stale" : "healthy") : "unsafe", {
      observedAt: data.generatedAt,
      maxAgeMs: (this.config.refreshIntervalMs || 6 * 60 * 60 * 1000) * 2,
      message: data.lastError || null,
      details: {
        source: data.source,
        players: data.players,
        etag: data.etag,
        refreshing: data.refreshing,
      },
    });
    const nativeHealthy = compute.nativeAvailable !== false && compute.readyWorkers !== 0;
    this.health.set("native-compute", nativeHealthy ? "healthy" : "degraded", {
      message: nativeHealthy ? null : "Native compute is unavailable; JavaScript fallback may be used",
      details: {
        engine: compute.engine || null,
        engineVersion: compute.engineVersion || null,
        nativeAvailable: compute.nativeAvailable ?? null,
        workers: compute.workers ?? null,
        readyWorkers: compute.readyWorkers ?? null,
        busy: compute.busy ?? null,
        queued: compute.queued ?? null,
        completed: compute.completed ?? null,
        failed: compute.failed ?? null,
      },
    });
    const eventStatus = this.eventStore.status();
    this.health.set("event-chain", this.eventStore.verify().valid ? "healthy" : "unsafe", {
      details: {
        version: eventStatus.version,
        events: eventStatus.events,
        headHash: eventStatus.headHash,
        valid: eventStatus.valid,
        errors: eventStatus.errors,
      },
    });
    this.health.set("decision-ledger", this.ledger.status().valid ? "healthy" : "unsafe", {
      details: this.ledger.status(),
    });
    this.health.set("model-governance", "healthy", {
      details: this.models.status(),
    });
    const driftStatus = this.drift.status();
    this.health.set("model-drift", driftStatus.state, {
      observedAt: driftStatus.newestObservedAt,
      message: driftStatus.alerts.join("; ") || null,
      details: driftStatus,
    });
    this.metrics.gauge("oracle_players_loaded", data.players || 0);
    this.metrics.gauge("oracle_compute_queue_depth", compute.queued || 0);
    this.metrics.gauge("oracle_native_workers_ready", compute.readyWorkers || 0);
  }

  attachFastify(fastify) {
    fastify.addHook("onRequest", async (request) => {
      request[REQUEST_STARTED] = Number(this.clock());
      this.metrics.increment("oracle_http_requests_total", 1, {
        method: request.method,
        route: request.routeOptions?.url || request.url.split("?")[0],
      });
    });
    fastify.addHook("onResponse", async (request, reply) => {
      const route = request.routeOptions?.url || request.url.split("?")[0];
      const elapsed = Math.max(0, Number(this.clock()) - Number(request[REQUEST_STARTED] || this.clock()));
      this.metrics.observe("oracle_http_request_duration_ms", elapsed, {
        method: request.method,
        route,
        status: reply.statusCode,
      });
      this.metrics.increment("oracle_http_responses_total", 1, {
        route,
        status: reply.statusCode,
      });
    });
    fastify.addHook("onError", async (request, _reply, error) => {
      this.metrics.increment("oracle_http_errors_total", 1, {
        route: request.routeOptions?.url || request.url.split("?")[0],
        code: error.code || "REQUEST_FAILED",
      });
    });
    fastify.addHook("onSend", async (request, reply, payload) => {
      const route = request.routeOptions?.url || request.url.split("?")[0];
      const decisionType = DECISION_ROUTES[route];
      if (!decisionType || request.method !== "POST" || reply.statusCode >= 400 || !this.initialized) return payload;
      let parsed = payload;
      try {
        if (Buffer.isBuffer(payload)) parsed = JSON.parse(payload.toString("utf8"));
        else if (typeof payload === "string") parsed = JSON.parse(payload);
      } catch {
        return payload;
      }
      if (!parsed || typeof parsed !== "object" || parsed.recommendation) return payload;
      const result = parsed.data ?? parsed;
      const envelope = await this.recordDecision(decisionType, request.body || {}, result, {
        requestId: request.id,
        route,
        seed: request.body?.seed,
        engine: parsed.engine,
        engineVersion: parsed.engineVersion,
        confidence: result?.confidence ?? result?.decisionIntelligence?.consensus?.conviction,
        warnings: result?.warnings || [],
        objective: decisionType.includes("league") ? "maximize-championship-probability" : "league-adjusted-expected-value",
      });
      return JSON.stringify({ ...parsed, recommendation: envelope });
    });
  }

  freshnessSummary() {
    const status = this.dataStore?.getStatus?.() || {};
    const generatedAt = status.generatedAt || null;
    const ageMs = generatedAt ? Math.max(0, Number(this.clock()) - Date.parse(generatedAt)) : null;
    const threshold = (this.config.refreshIntervalMs || 6 * 60 * 60 * 1000) * 2;
    return {
      generatedAt,
      ageMs,
      stale: ageMs === null || ageMs > threshold,
      thresholdMs: threshold,
      source: status.source || null,
    };
  }

  createEnvelope(decisionType, input, result, options = {}) {
    const dataStatus = this.dataStore?.getStatus?.() || {};
    const dataset = this.dataStore?.getDataset?.() || {};
    const warnings = [...(options.warnings || [])];
    const freshness = this.freshnessSummary();
    if (freshness.stale) warnings.push("Player data is stale or its age is unknown.");
    if (!this.artifacts.status().valid) warnings.push("Artifact integrity is not fully verified.");
    return createRecommendationEnvelope({
      decisionType,
      input,
      model: {
        applicationVersion: options.applicationVersion || null,
        projectionModel: dataset.meta?.modelVersion || null,
        contextModel: dataset.meta?.contextVersion || null,
        opportunityModel: dataset.meta?.opportunityVersion || null,
        healthModel: dataset.meta?.healthVersion || null,
        engine: options.engine || null,
        engineVersion: options.engineVersion || null,
      },
      data: {
        etag: dataStatus.etag || null,
        generatedAt: dataStatus.generatedAt || null,
        artifactDigest: this.artifacts.status().semanticDigest,
        playerCount: dataStatus.players || 0,
      },
      seed: options.seed,
      freshness,
      confidence: options.confidence ?? (freshness.stale ? 0.45 : 0.78),
      warnings,
      objective: options.objective || "expected-value",
      createdAt: options.createdAt,
    });
  }

  async recordDecision(decisionType, input, result, options = {}) {
    this.ensureInitialized();
    const envelope = this.createEnvelope(decisionType, input, result, options);
    await this.ledger.recordDecision(envelope, result, {
      requestId: options.requestId,
      route: options.route,
      actor: options.actor,
      persistResult: options.persistResult,
    });
    this.metrics.increment("oracle_decisions_total", 1, {
      type: decisionType,
      engine: options.engine || "unknown",
    });
    return envelope;
  }

  async readBackupStatus() {
    try {
      const status = JSON.parse(await fs.readFile(this.backupStatusPath, "utf8"));
      const completedAt = status.completedAt || status.createdAt || null;
      const ageMs = completedAt ? Math.max(0, Number(this.clock()) - Date.parse(completedAt)) : null;
      return {
        configured: true,
        ...status,
        ageMs,
        stale: ageMs === null || ageMs > (this.config.backupRpoMs || 24 * 60 * 60 * 1000),
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          configured: false,
          verified: false,
          stale: true,
          message: "No successful local recovery package has been recorded yet.",
        };
      }
      return {
        configured: true,
        verified: false,
        stale: true,
        message: error.message,
      };
    }
  }

  async status() {
    this.refreshComponents();
    const metrics = this.metrics.snapshot();
    const backup = await this.readBackupStatus();
    this.health.set("backup-recovery", backup.verified && !backup.stale ? "healthy" : "degraded", {
      observedAt: backup.completedAt || backup.createdAt,
      maxAgeMs: this.config.backupRpoMs || 24 * 60 * 60 * 1000,
      message: backup.message || null,
      details: {
        configured: backup.configured,
        verified: backup.verified,
        stale: backup.stale,
        packageId: backup.packageId || null,
        completedAt: backup.completedAt || null,
        encrypted: backup.encrypted ?? null,
        replicasVerified: Array.isArray(backup.replicas)
          ? backup.replicas.filter((row) => row.copied).length
          : 0,
      },
    });
    const componentHealth = this.health.snapshot();
    const eventStore = this.eventStore.status();
    const snapshots = this.snapshots.status();
    const publicBackup = {
      configured: backup.configured,
      verified: backup.verified,
      stale: backup.stale,
      packageId: backup.packageId || null,
      completedAt: backup.completedAt || null,
      ageMs: backup.ageMs ?? null,
      encrypted: backup.encrypted ?? null,
      replicasVerified: Array.isArray(backup.replicas)
        ? backup.replicas.filter((row) => row.copied).length
        : 0,
      message: backup.message || null,
    };
    return {
      version: PLATFORM_VERSION,
      initialized: this.initialized,
      startedAt: new Date(this.startedAt).toISOString(),
      state: componentHealth.state,
      buildFingerprint: this.buildFingerprint(),
      schemas: registrySummary(),
      artifacts: this.artifacts.status(),
      eventStore: { ...eventStore, filePath: undefined },
      snapshots: { ...snapshots, directory: undefined },
      decisions: this.ledger.status(),
      models: this.models.status(),
      drift: this.drift.status(),
      championship: this.optimizer?.status() || null,
      backup: publicBackup,
      health: componentHealth,
      slos: evaluateSLOs(metrics, this.config.sloTargets || {}),
    };
  }

  metricsSnapshot() {
    return this.metrics.snapshot();
  }

  metricsPrometheus() {
    return this.metrics.toPrometheus();
  }

  manifest() {
    return this.artifacts.manifest || null;
  }

  events(options = {}) {
    return this.eventStore.list(options);
  }

  decisions(options = {}) {
    return this.ledger.list(options);
  }

  modelStatus() {
    return this.models.status();
  }

  modelRegistry() {
    return this.models.fullRegistry();
  }

  async registerModel(domain, model) {
    this.ensureInitialized();
    const registered = this.models.registerChallenger(domain, model);
    await this.models.persist();
    await this.eventStore.append("model.registered", { domain, model: registered }, { source: "model-registry" });
    return { domain, model: registered, status: this.models.status() };
  }

  async promoteModel(domain, version, gate) {
    this.ensureInitialized();
    const result = await this.models.evaluateAndPromote(domain, version, gate);
    this.metrics.increment("oracle_model_gate_total", 1, {
      domain,
      outcome: result.evaluation.passed ? "promoted" : "rejected",
    });
    return result;
  }

  async rollbackModel(domain, version) {
    this.ensureInitialized();
    const result = await this.models.rollback(domain, version);
    this.metrics.increment("oracle_model_rollback_total", 1, { domain });
    return result;
  }

  driftReport(options = {}) {
    return this.drift.report(options);
  }

  async recordDriftObservation(observation) {
    this.ensureInitialized();
    const row = await this.drift.record(observation);
    const report = this.drift.report({
      domain: row.domain,
      modelVersion: row.modelVersion,
      metric: row.metric,
    });
    this.metrics.increment("oracle_model_outcomes_total", 1, {
      domain: row.domain,
      metric: row.metric,
    });
    return { observation: row, report };
  }

  async recordOutcome(decisionId, outcome = {}) {
    this.ensureInitialized();
    const event = await this.ledger.recordOutcome(decisionId, outcome);
    const drift = [];
    for (const observation of Array.isArray(outcome.observations) ? outcome.observations : []) {
      drift.push(await this.recordDriftObservation({
        ...observation,
        metadata: { ...(observation.metadata || {}), decisionId: String(decisionId) },
      }));
    }
    return { event, drift };
  }

  async evaluateChampionship(options = {}) {
    this.ensureInitialized();
    try {
      const result = await this.optimizer.evaluate(options);
      const envelope = await this.recordDecision(
        "championship-evaluation",
        {
          leagueStateDigest: result.leagueStateDigest,
          actions: options.actions || [],
          simulations: result.simulations,
        },
        result,
        {
          seed: result.pairedSeed,
          engine: result.actions[0]?.simulation?.engine,
          engineVersion: result.actions[0]?.simulation?.engineVersion,
          confidence: result.actions[0]?.confidence,
          objective: result.objective,
          route: "/api/championship/evaluate",
          requestId: options.requestId,
        },
      );
      return { ...result, recommendation: envelope };
    } catch (error) {
      this.metrics.increment("championship_evaluate_total", 1, { outcome: "failure" });
      throw error;
    }
  }

  async stop() {
    this.unsubscribeDataset?.();
    this.unsubscribeDataset = null;
    this.initialized = false;
    await this.eventStore.close();
  }

  buildFingerprint() {
    return sha256({
      platform: PLATFORM_VERSION,
      artifacts: this.artifacts.status().semanticDigest,
      schemas: registrySummary(),
      championship: this.optimizer?.status(),
      models: this.models.status(),
      drift: this.drift.status(),
    });
  }
}

module.exports = {
  PLATFORM_VERSION,
  normalizeComputeStats,
  PlatformControlPlane,
};
