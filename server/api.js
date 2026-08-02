"use strict";

const crypto = require("node:crypto");

const core = require("../app-core.js");
const packageJson = require("../package.json");
const { coachingSummary, profileForTeam } = require("./coaching-model.js");
const { modelBlueprint } = require("./engine-blueprint.js");
const { opportunitySummary } = require("./opportunity-model.js");
const { healthSummary } = require("./health-model.js");
const { historicalHealth, historicalStatus, loadHistoricalCalibration } = require("./historical-calibration.js");
const {
  decorateDraftRecommendations,
  decorateRosterAnalysis,
  decorateTradeAnalysis,
  decorateTradeProposals,
  decorateWaivers,
} = require("./roster-utility.js");

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeOverrides(rows, maximum = 120) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, maximum)
    .filter((player) => player && player.id && player.name && player.position)
    .map(core.normalizePlayer);
}

function mergeUniverse(dataset, overrides) {
  const byId = new Map(dataset.players.map((player) => [String(player.id), player]));
  normalizeOverrides(overrides).forEach((player) => byId.set(player.id, player));
  return { players: [...byId.values()], byId };
}

function resolvePlayers(ids, embedded, byId, maximum = 64) {
  if (Array.isArray(embedded) && embedded.length) {
    return normalizeOverrides(embedded, maximum);
  }
  return (Array.isArray(ids) ? ids : [])
    .slice(0, maximum)
    .map((id) => byId.get(String(id)))
    .filter(Boolean);
}

function taskResponse(result) {
  const native = result.engine === "oracle-native";
  return {
    data: result.data,
    computeMs: result.computeMs,
    computeMode: native ? "native-cpp" : "javascript-worker-fallback",
    engine: result.engine || "oracle-javascript-fallback",
    engineVersion: result.engineVersion || null,
  };
}

function commonBodySchema(properties = {}, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      settings: { type: "object", additionalProperties: true },
      playerOverrides: {
        type: "array",
        maxItems: 120,
        items: { type: "object", additionalProperties: true },
      },
      ...properties,
    },
  };
}

const ADMIN_REQUEST = Symbol("oracleAdminRequest");

function constantTimeEqual(left, right) {
  const digest = (value) => crypto.createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function authorizeAdmin(request, config) {
  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match ? match[1].trim() : "";
  if (config.adminToken) {
    if (!constantTimeEqual(supplied, config.adminToken)) {
      const error = new Error("A valid Oracle admin token is required");
      error.statusCode = 401;
      error.code = "ADMIN_TOKEN_REQUIRED";
      throw error;
    }
    request[ADMIN_REQUEST] = true;
    return;
  }
  const forwarded = [
    "forwarded", "x-forwarded-for", "x-forwarded-host",
    "x-forwarded-proto", "x-real-ip",
  ].some((name) => request.headers[name] !== undefined);
  if (forwarded) {
    const error = new Error("An Oracle admin token is required for proxied administrative requests");
    error.statusCode = 401;
    error.code = "ADMIN_TOKEN_REQUIRED";
    throw error;
  }
  const address = String(request.raw?.socket?.remoteAddress || request.socket?.remoteAddress || "");
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    request[ADMIN_REQUEST] = true;
    return;
  }
  const error = new Error("Administrative requests are restricted to the local host");
  error.statusCode = 403;
  error.code = "REFRESH_FORBIDDEN";
  throw error;
}

const authorizeRefresh = authorizeAdmin;

function readinessSnapshot({ config, dataStore, pool, controlPlane }) {
  const data = dataStore.getStatus();
  const compute = pool.stats?.() || {};
  const native = compute.native && typeof compute.native === "object"
    ? compute.native
    : compute;
  const artifacts = controlPlane.artifacts?.status?.() || {};
  const eventChain = controlPlane.eventStore?.status?.() || {};
  const failures = [];
  const nativeAvailable = native.available ?? null;
  const nativeWorkers = native.workers ?? native.readyWorkers ?? 0;
  const readyWorkers = native.readyWorkers ?? nativeWorkers;
  const artifactValid = artifacts.valid ?? null;
  const eventChainValid = eventChain.valid ?? null;

  if (data.ready !== true) failures.push("player-data-unavailable");
  if (config.nativeRequired && (nativeAvailable !== true || nativeWorkers < 1)) {
    failures.push("native-compute-unavailable");
  }
  if (config.strictArtifactIntegrity && artifactValid !== true) {
    failures.push("artifact-integrity-invalid");
  }
  if (eventChainValid !== true) failures.push("event-chain-invalid");

  return {
    ready: failures.length === 0,
    status: failures.length === 0 ? "ready" : "not-ready",
    dataReady: data.ready === true,
    players: data.players || 0,
    dataSource: data.source || null,
    nativeRequired: Boolean(config.nativeRequired),
    nativeAvailable,
    readyWorkers,
    strictArtifacts: Boolean(config.strictArtifactIntegrity),
    artifactValid,
    eventChainValid,
    failures,
  };
}

function computeRouteConfig(max = 30) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
    },
  };
}

async function registerApiRoutes(fastify, services) {
  const { config, dataStore, pool, controlPlane } = services;

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (request[ADMIN_REQUEST]) reply.header("cache-control", "no-store");
    return payload;
  });

  fastify.get("/api/health", async () => ({
    status: "ok",
    application: packageJson.name,
    version: packageJson.version,
    architecture: "native-cpp-hybrid-control-plane",
    uptimeSeconds: Math.round(process.uptime()),
    compute: {
      nativeCppPrimary: true,
      javascriptWorkerFallback: true,
      defaultSimulations: config.defaultSimulations,
      maxSimulations: config.maxSimulations,
      ...pool.stats(),
    },
    data: dataStore.getStatus(),
    historical: historicalHealth(loadHistoricalCalibration()),
    opportunity: opportunitySummary(),
    healthIntelligence: dataStore.getDataset().health || healthSummary(),
    platform: await controlPlane.status(),
  }));

  fastify.get("/api/ready", async (_request, reply) => {
    const readiness = readinessSnapshot(services);
    return reply
      .code(readiness.ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send(readiness);
  });

  fastify.get("/api/data/status", async () => dataStore.getStatus());

  fastify.get("/api/platform/status", async () => controlPlane.status());

  fastify.get("/api/platform/metrics", async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.metricsSnapshot();
  });

  fastify.get("/api/platform/metrics.prom", async (request, reply) => {
    authorizeRefresh(request, config);
    return reply.type("text/plain; version=0.0.4").send(controlPlane.metricsPrometheus());
  });

  fastify.get("/api/platform/manifest", async (request) => {
    authorizeRefresh(request, config);
    return { loaded: Boolean(controlPlane.manifest()), manifest: controlPlane.manifest() };
  });

  fastify.get("/api/platform/events", async (request) => {
    authorizeRefresh(request, config);
    return {
      events: controlPlane.events({
      type: request.query?.type || null,
      afterSequence: clampInteger(request.query?.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInteger(request.query?.limit, 100, 1, 500),
      }),
    };
  });

  fastify.get("/api/platform/decisions", async (request) => {
    authorizeRefresh(request, config);
    return {
      decisions: controlPlane.decisions({
      type: request.query?.type || null,
      afterSequence: clampInteger(request.query?.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInteger(request.query?.limit, 100, 1, 500),
      }),
    };
  });

  fastify.get("/api/platform/decisions/:id", async (request, reply) => {
    authorizeRefresh(request, config);
    const decision = controlPlane.ledger.findDecision(request.params.id);
    if (!decision) return reply.code(404).send({ error: "Not Found", message: "Unknown decision" });
    return { decision, outcomes: controlPlane.ledger.outcomesFor(request.params.id) };
  });

  fastify.post("/api/platform/decisions/:id/outcomes", {
    config: computeRouteConfig(12),
    schema: { body: { type: "object", additionalProperties: false, required: ["metrics"], properties: {
      outcomeType: { type: "string", maxLength: 80 },
      metrics: { type: "object", additionalProperties: true },
      notes: { type: "string", maxLength: 2000 },
      source: { type: "string", maxLength: 80 },
      observations: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: true } },
    } } },
  }, async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.recordOutcome(request.params.id, request.body);
  });


  fastify.get("/api/models/status", async () => controlPlane.modelStatus());

  fastify.get("/api/models/registry", async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.modelRegistry();
  });

  fastify.post("/api/models/:domain/challengers", {
    config: computeRouteConfig(12),
    schema: { body: { type: "object", additionalProperties: true, required: ["version"], properties: { version: { type: "string", minLength: 1, maxLength: 160 } } } },
  }, async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.registerModel(request.params.domain, request.body);
  });

  fastify.post("/api/models/:domain/promote/:version", {
    config: computeRouteConfig(12),
    schema: { body: { type: "object", additionalProperties: false, required: ["primaryMetric", "championValue", "challengerValue", "sampleSize", "leakageSafe"], properties: {
      primaryMetric: { type: "string", maxLength: 120 }, direction: { type: "string", enum: ["higher", "lower"] },
      championValue: { type: "number" }, challengerValue: { type: "number" }, minimumImprovement: { type: "number", minimum: 0 },
      sampleSize: { type: "integer", minimum: 1 }, minimumSampleSize: { type: "integer", minimum: 1 },
      leakageSafe: { type: "boolean" }, holdoutId: { type: "string", maxLength: 160 }, holdoutSeason: { type: "integer" },
    } } },
  }, async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.promoteModel(request.params.domain, request.params.version, request.body);
  });

  fastify.post("/api/models/:domain/rollback", {
    config: computeRouteConfig(12),
    schema: { body: { type: "object", additionalProperties: false, properties: { version: { type: "string", maxLength: 160 } } } },
  }, async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.rollbackModel(request.params.domain, request.body?.version);
  });

  fastify.get("/api/models/drift", async (request) => controlPlane.driftReport({
    domain: request.query?.domain, modelVersion: request.query?.modelVersion,
    metric: request.query?.metric, limit: clampInteger(request.query?.limit, 1000, 1, 20000),
  }));

  fastify.post("/api/models/drift/observations", {
    config: computeRouteConfig(20),
    schema: { body: { type: "object", additionalProperties: true, required: ["prediction", "outcome"] } },
  }, async (request) => {
    authorizeRefresh(request, config);
    return controlPlane.recordDriftObservation(request.body);
  });

  fastify.get("/api/championship/status", async () => controlPlane.optimizer.status());

  fastify.post("/api/championship/evaluate", {
    config: computeRouteConfig(4),
    schema: { body: { type: "object", additionalProperties: false, required: ["leagueState"], properties: { leagueState: { type: "object", additionalProperties: true }, actions: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } }, simulations: { type: "integer", minimum: 500, maximum: 250000 }, seed: { type: "integer" } } } },
  }, async (request) => controlPlane.evaluateChampionship({ ...request.body, requestId: request.id }));

  fastify.get("/api/model/blueprint", async () => modelBlueprint(dataStore.getDataset()));

  fastify.get("/api/backtests/status", async () => historicalStatus(loadHistoricalCalibration()));

  fastify.get("/api/opportunity/status", async () => (
    dataStore.getDataset().opportunity || opportunitySummary()
  ));

  fastify.get("/api/opportunity/players/:id", async (request, reply) => {
    const player = dataStore.getPlayer(request.params.id);
    if (!player) return reply.code(404).send({ error: "Not Found", message: "Unknown player" });
    return { id: player.id, name: player.name, team: player.team, position: player.position, opportunityContext: player.opportunityContext || null };
  });

  fastify.get("/api/health-intelligence/status", async () => (
    dataStore.getDataset().health || healthSummary()
  ));

  fastify.get("/api/health-intelligence/players/:id", async (request, reply) => {
    const player = dataStore.getPlayer(request.params.id);
    if (!player) return reply.code(404).send({ error: "Not Found", message: "Unknown player" });
    return {
      id: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      injuryStatus: player.injuryStatus,
      injuryRisk: player.injuryRisk,
      healthContext: player.healthContext || null,
      news: player.news || [],
    };
  });

  fastify.get("/api/coaching/teams", async () => coachingSummary());

  fastify.get("/api/coaching/teams/:team", async (request, reply) => {
    const team = String(request.params.team || "").toUpperCase();
    const profile = profileForTeam(team);
    if (profile.team === "FA" && team !== "FA") {
      return reply.code(404).send({
        error: "Not Found",
        message: `No coaching profile exists for ${team}`,
      });
    }
    return profile;
  });

  fastify.get("/api/intelligence/status", async () => {
    const dataset = dataStore.getDataset();
    return {
      version: dataset.intelligence?.version || null,
      modelVersion: dataset.meta?.modelVersion || null,
      coverage: dataset.intelligence?.coverage || 0,
      teamCoverage: dataset.intelligence?.teamCoverage || 0,
      diagnostics: dataset.intelligence?.diagnostics || null,
      methodology: dataset.intelligence?.methodology || [],
      limitations: dataset.intelligence?.limitations || [],
    };
  });

  fastify.get("/api/intelligence/teams", async () => (
    dataStore.getDataset().intelligence || { teamProfiles: {} }
  ));

  fastify.get("/api/intelligence/teams/:team", async (request, reply) => {
    const team = String(request.params.team || "").toUpperCase();
    const profile = dataStore.getDataset().intelligence?.teamProfiles?.[team];
    if (!profile) return reply.code(404).send({ error: "Not Found", message: `No intelligence profile exists for ${team}` });
    return profile;
  });

  fastify.get("/api/intelligence/players/:id", async (request, reply) => {
    const player = dataStore.getPlayer(request.params.id);
    if (!player) return reply.code(404).send({ error: "Not Found", message: "Unknown player" });
    return {
      id: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      weeklyProjection: player.weeklyProjection,
      floorProjection: player.floorProjection,
      ceilingProjection: player.ceilingProjection,
      reliability: player.reliability,
      coachingContext: player.coachingContext || null,
      opportunityContext: player.opportunityContext || null,
      healthContext: player.healthContext || null,
      news: player.news || [],
      decisionIntelligence: player.decisionIntelligence || null,
      projectionModel: player.projectionModel || null,
    };
  });

  fastify.get("/api/data/players", async (request, reply) => {
    const status = dataStore.getStatus();
    if (request.headers["if-none-match"] === status.etag) {
      return reply.code(304).send();
    }
    reply.header("etag", status.etag);
    reply.header("cache-control", "private, max-age=60, stale-while-revalidate=300");
    return dataStore.getDataset();
  });

  fastify.post("/api/data/refresh", {
    config: computeRouteConfig(4),
  }, async (request) => {
    authorizeRefresh(request, config);
    return dataStore.refresh();
  });

  fastify.post("/api/draft/simulate", {
    config: computeRouteConfig(24),
    schema: {
      body: commonBodySchema({
        state: { type: "object", additionalProperties: true },
        targetTeamId: { type: "integer", minimum: 1, maximum: 20 },
        simulations: { type: "integer", minimum: 100 },
        seed: { type: "integer" },
        trackLimit: { type: "integer", minimum: 40, maximum: 400 },
      }, ["state", "settings", "targetTeamId"]),
    },
  }, async (request) => {
    const body = request.body;
    const dataset = dataStore.getDataset();
    const universe = mergeUniverse(dataset, body.playerOverrides);
    const simulations = clampInteger(
      body.simulations,
      config.defaultSimulations,
      100,
      config.maxSimulations,
    );
    const result = await pool.run("draft-simulate", {
      players: universe.players,
      state: body.state,
      settings: core.cloneSettings(body.settings),
      targetTeamId: body.targetTeamId,
      simulations,
      seed: body.seed,
      trackLimit: body.trackLimit || 220,
    }, { useDataset: !body.playerOverrides?.length });
    return taskResponse(result);
  });

  fastify.post("/api/draft/recommendations", {
    config: computeRouteConfig(20),
    schema: {
      body: commonBodySchema({
        state: { type: "object", additionalProperties: true },
        targetTeamId: { type: "integer", minimum: 1, maximum: 20 },
        simulations: { type: "integer", minimum: 100 },
        seed: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: 260 },
      }, ["state", "settings", "targetTeamId"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const simulations = clampInteger(
      body.simulations,
      config.defaultSimulations,
      100,
      config.maxSimulations,
    );
    const result = await pool.run("draft-recommend", {
      players: universe.players,
      state: body.state,
      settings: core.cloneSettings(body.settings),
      targetTeamId: body.targetTeamId,
      limit: clampInteger(body.limit, 80, 1, 260),
      simulation: {
        players: universe.players,
        state: body.state,
        settings: core.cloneSettings(body.settings),
        targetTeamId: body.targetTeamId,
        simulations,
        seed: body.seed,
        trackLimit: 260,
      },
    }, { useDataset: !body.playerOverrides?.length });
    const rawRecommendations = Array.isArray(result.data)
      ? result.data
      : result.data?.recommendations || [];
    const recommendations = decorateDraftRecommendations(rawRecommendations, {
      players: universe.players,
      state: body.state,
      teamId: body.targetTeamId,
      settings: core.cloneSettings(body.settings),
      startWeek: 1,
      calibration: loadHistoricalCalibration(),
    });
    result.data = Array.isArray(result.data)
      ? recommendations
      : { ...result.data, recommendations };
    return taskResponse(result);
  });

  fastify.post("/api/roster/analyze", {
    config: computeRouteConfig(40),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
      }, ["settings", "week"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    if (!roster.length) {
      const error = new Error("Roster does not contain any recognized players");
      error.statusCode = 400;
      throw error;
    }
    const result = await pool.run("roster-analyze", {
      roster,
      players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week,
    }, { useDataset: !body.playerOverrides?.length });
    result.data = decorateRosterAnalysis(result.data, {
      roster, players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week,
      calibration: loadHistoricalCalibration(),
    });
    return taskResponse(result);
  });

  fastify.post("/api/waivers/recommend", {
    config: computeRouteConfig(30),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        unavailableIds: { type: "array", maxItems: 1000, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        freeAgentIds: { type: "array", maxItems: 500, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        freeAgents: { type: "array", maxItems: 500, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
        budgetRemaining: { type: "number", minimum: 0, maximum: 10000 },
        weeksRemaining: { type: "integer", minimum: 1, maximum: 18 },
        aggressiveness: { type: "number", minimum: 0, maximum: 1 },
      }, ["settings", "week"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    if (!roster.length) {
      const error = new Error("Roster does not contain any recognized players");
      error.statusCode = 400;
      throw error;
    }
    const unavailable = new Set((body.unavailableIds || []).map(String));
    roster.forEach((player) => unavailable.add(player.id));
    let freeAgents = resolvePlayers(
      body.freeAgentIds,
      body.freeAgents,
      universe.byId,
      500,
    );
    if (!freeAgents.length) {
      freeAgents = universe.players
        .filter((player) => !unavailable.has(player.id))
        .sort((a, b) => (
          core.playerWeekProjection(b, body.week) - core.playerWeekProjection(a, body.week)
        ))
        .slice(0, 320);
    }
    const result = await pool.run("waivers", {
      roster,
      freeAgents,
      settings: core.cloneSettings(body.settings),
      week: body.week,
      limit: clampInteger(body.limit, 15, 1, 40),
      budgetRemaining: Number(body.budgetRemaining || 0),
      weeksRemaining: clampInteger(body.weeksRemaining, 17, 1, 18),
      aggressiveness: body.aggressiveness,
    });
    result.data = decorateWaivers(result.data, {
      roster, players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week,
      calibration: loadHistoricalCalibration(),
    });
    return taskResponse(result);
  });

  fastify.post("/api/trades/analyze", {
    config: computeRouteConfig(40),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        giveIds: { type: "array", maxItems: 5, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        give: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: true } },
        receiveIds: { type: "array", maxItems: 5, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        receive: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
      }, ["settings"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    const give = resolvePlayers(body.giveIds, body.give, universe.byId, 5);
    const receive = resolvePlayers(body.receiveIds, body.receive, universe.byId, 5);
    if (!roster.length || !give.length || !receive.length) {
      const error = new Error("Trade analysis requires a roster and both trade sides");
      error.statusCode = 400;
      throw error;
    }
    const result = await pool.run("trade-analyze", {
      roster,
      give,
      receive,
      players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week || null,
    }, { useDataset: !body.playerOverrides?.length });
    result.data = decorateTradeAnalysis(result.data, {
      roster, give, receive, players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week || 1,
      calibration: loadHistoricalCalibration(),
    });
    return taskResponse(result);
  });

  fastify.post("/api/lineup/optimize", {
    config: computeRouteConfig(50),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
      }, ["settings"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    if (!roster.length) throw Object.assign(new Error("Lineup optimization requires a recognized roster"), { statusCode: 400 });
    return taskResponse(await pool.run("lineup-optimize", {
      roster,
      settings: core.cloneSettings(body.settings),
      week: body.week || null,
    }));
  });

  fastify.post("/api/lineup/start-sit", {
    config: computeRouteConfig(40),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
        opponentTarget: { type: "number", minimum: 0, maximum: 500 },
      }, ["settings", "week"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    if (!roster.length) throw Object.assign(new Error("Start/sit analysis requires a recognized roster"), { statusCode: 400 });
    return taskResponse(await pool.run("start-sit", {
      roster,
      settings: core.cloneSettings(body.settings),
      week: body.week,
      opponentTarget: body.opponentTarget || null,
    }));
  });

  fastify.post("/api/league/simulate", {
    config: computeRouteConfig(8),
    schema: {
      body: commonBodySchema({
        teams: { type: "array", minItems: 2, maxItems: 20, items: { type: "object", additionalProperties: true } },
        schedule: { type: "array", maxItems: 400, items: { type: "object", additionalProperties: true } },
        startWeek: { type: "integer", minimum: 1, maximum: 18 },
        regularSeasonEnd: { type: "integer", minimum: 1, maximum: 17 },
        championshipWeek: { type: "integer", minimum: 2, maximum: 18 },
        playoffTeams: { type: "integer", minimum: 2, maximum: 20 },
        simulations: { type: "integer", minimum: 100, maximum: 250000 },
        seed: { type: "integer" },
      }, ["settings", "teams"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const teams = body.teams.map((team, index) => ({
      teamId: String(team.teamId ?? index + 1),
      name: String(team.name || `Team ${index + 1}`),
      roster: resolvePlayers(team.rosterIds, team.roster, universe.byId),
    })).filter((team) => team.roster.length);
    if (teams.length < 2) throw Object.assign(new Error("League simulation requires at least two complete rosters"), { statusCode: 400 });
    return taskResponse(await pool.run("league-simulate", {
      teams,
      schedule: body.schedule || [],
      settings: core.cloneSettings(body.settings),
      startWeek: clampInteger(body.startWeek, 1, 1, 18),
      regularSeasonEnd: clampInteger(body.regularSeasonEnd, 14, 1, 17),
      championshipWeek: clampInteger(body.championshipWeek, 17, 2, 18),
      playoffTeams: clampInteger(body.playoffTeams, Math.min(6, teams.length), 2, teams.length),
      simulations: clampInteger(body.simulations, 20000, 100, 250000),
      seed: body.seed,
    }, { timeoutMs: Math.max(config.taskTimeoutMs, 180000) }));
  });

  fastify.post("/api/season/simulate", {
    config: computeRouteConfig(12),
    schema: {
      body: commonBodySchema({
        rosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        roster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        startWeek: { type: "integer", minimum: 1, maximum: 18 },
        endWeek: { type: "integer", minimum: 1, maximum: 18 },
        simulations: { type: "integer", minimum: 100, maximum: 500000 },
        seed: { type: "integer" },
        teamCorrelation: { type: "number", minimum: 0, maximum: 0.6 },
        gameCorrelation: { type: "number", minimum: 0, maximum: 0.4 },
      }, ["settings"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const roster = resolvePlayers(body.rosterIds, body.roster, universe.byId);
    if (!roster.length) {
      const error = new Error("Season simulation requires a recognized roster");
      error.statusCode = 400;
      throw error;
    }
    const result = await pool.run("season-simulate", {
      roster,
      settings: core.cloneSettings(body.settings),
      startWeek: clampInteger(body.startWeek, 1, 1, 18),
      endWeek: clampInteger(body.endWeek, 17, 1, 18),
      simulations: clampInteger(body.simulations, 25000, 100, 500000),
      seed: body.seed,
      teamCorrelation: body.teamCorrelation,
      gameCorrelation: body.gameCorrelation,
    }, { timeoutMs: Math.max(config.taskTimeoutMs, 120000) });
    return taskResponse(result);
  });

  fastify.post("/api/trades/generate", {
    config: computeRouteConfig(12),
    schema: {
      body: commonBodySchema({
        userRosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        userRoster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        opponentRosterIds: { type: "array", maxItems: 64, items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        opponentRoster: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: true } },
        week: { type: "integer", minimum: 1, maximum: 18 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
        assetLimit: { type: "integer", minimum: 6, maximum: 16 },
        includeTwoForTwo: { type: "boolean" },
      }, ["settings"]),
    },
  }, async (request) => {
    const body = request.body;
    const universe = mergeUniverse(dataStore.getDataset(), body.playerOverrides);
    const userRoster = resolvePlayers(
      body.userRosterIds,
      body.userRoster,
      universe.byId,
    );
    const opponentRoster = resolvePlayers(
      body.opponentRosterIds,
      body.opponentRoster,
      universe.byId,
    );
    if (!userRoster.length || !opponentRoster.length) {
      const error = new Error("Trade generation requires both complete rosters");
      error.statusCode = 400;
      throw error;
    }
    const result = await pool.run("trades-generate", {
      userRoster,
      opponentRoster,
      players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week || null,
      limit: clampInteger(body.limit, 20, 1, 40),
      assetLimit: clampInteger(body.assetLimit, 12, 6, 16),
      includeTwoForTwo: body.includeTwoForTwo !== false,
    }, {
      timeoutMs: Math.max(config.taskTimeoutMs, 75_000),
      useDataset: !body.playerOverrides?.length,
    });
    result.data = decorateTradeProposals(result.data, {
      userRoster, opponentRoster, players: universe.players,
      settings: core.cloneSettings(body.settings),
      week: body.week || 1,
      calibration: loadHistoricalCalibration(),
    });
    return taskResponse(result);
  });
}

module.exports = {
  authorizeAdmin,
  constantTimeEqual,
  readinessSnapshot,
  registerApiRoutes,
  mergeUniverse,
  resolvePlayers,
};
