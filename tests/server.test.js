const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const { buildServer, start } = require("../server/index.js");

function fakeServices() {
  const players = bundled.players.slice(0, 160).map((player, index) => index === 0 ? {
    ...player,
    opportunityContext: { version: "test-opportunity", meanFactor: 1.01, volumeStability: .8 },
    healthContext: {
      version: "test-health",
      status: "questionable",
      severity: "minor",
      currentAvailability: .72,
      returnToPriorLevelProbability: .88,
      recurrenceRisk: .14,
      returnWindow: { earliestWeek: 1, likelyWeek: 1, latestWeek: 2 },
      reportedFacts: { injuryStatus: "Questionable", injuryBodyPart: "Hamstring" },
      news: { articles: [] },
    },
    news: [],
    decisionIntelligence: {
      version: "test-intelligence",
      archetype: "stable anchor",
      opportunity: { index: 82 },
      health: { version: "test-health", status: "questionable" },
      ecosystem: { index: .4 },
      matchup: { weekly: Array.from({ length: 18 }, (_, week) => ({ week: week + 1, grade: 55 })) },
      consensus: { conviction: .84 },
      risk: {
        fragility: .2,
        breakoutProbability: .3,
        bustProbability: .18,
        uncertainty: { baseline: 1 },
      },
    },
  } : player);
  const dataset = {
    ...bundled,
    meta: {
      ...bundled.meta,
      modelVersion: "test-model",
      contextVersion: "test-intelligence",
      healthVersion: "test-health",
      modelGeneratedAt: "2026-07-31T00:00:00.000Z",
      serverModeled: true,
    },
    players,
    health: {
      version: "test-health",
      calibrationVersion: "test-health-calibration",
      coverage: players.length,
      affectedPlayers: 1,
      injuredPlayers: 1,
      newsPlayers: 0,
      majorRecoveries: 0,
    },
    intelligence: {
      version: "test-intelligence",
      coverage: players.length,
      teamCoverage: 1,
      diagnostics: { meanFactor: 1 },
      methodology: ["test"],
      limitations: [],
      teamProfiles: { DET: { team: "DET", offenseIndex: .4 } },
    },
  };
  const status = {
    ready: true,
    source: "test",
    season: 2026,
    players: dataset.players.length,
    modelVersion: "test-model",
    contextVersion: "test-intelligence",
    healthVersion: "test-health",
    healthAffectedPlayers: 1,
    healthInjuredPlayers: 1,
    healthNewsPlayers: 0,
    intelligenceCoverage: players.length,
    etag: '"test-etag"',
  };
  const calls = [];
  const servicesTargetId = players[45]?.id || players.at(-1).id;
  const dataStore = {
    initialize: async () => dataset,
    getDataset: () => dataset,
    getPlayer: (id) => dataset.players.find((player) => String(player.id) === String(id)) || null,
    getStatus: () => status,
    refresh: async () => ({ refreshed: true, status }),
    stop: () => {},
  };
  const pool = {
    start() { return this; },
    stats: () => ({
      workers: 2,
      busy: 0,
      queued: 0,
      completed: calls.length,
      failed: 0,
    }),
    async run(type, payload) {
      calls.push({ type, payload });
      if (type === "draft-simulate") {
        return {
          data: {
            simulations: payload.simulations,
            currentPick: 1,
            targetPick: 2,
            availabilityById: {},
          },
          computeMs: 1.25,
        };
      }
      if (type === "draft-recommend") {
        return {
          data: {
            recommendations: payload.players.slice(0, 8).map((player, index) => ({
              ...player,
              score: 100 - index,
              decision: "Priority target",
              reasons: [],
              returnChance: .4,
              vona: 6,
              urgency: 60,
              nextTeamPick: 6,
            })),
            simulation: { simulations: payload.simulation.simulations },
          },
          computeMs: 2.5,
        };
      }
      if (type === "league-simulate") {
        const user = payload.teams.find((team) => String(team.teamId) === "1");
        const upgraded = user?.roster?.some((player) => String(player.id) === String(servicesTargetId));
        const title = upgraded ? 0.28 : 0.14;
        return {
          engine: "oracle-native",
          engineVersion: "test-native",
          data: {
            simulations: payload.simulations,
            model: "test-league-model",
            teams: payload.teams.map((team) => ({
              teamId: team.teamId,
              championshipProbability: String(team.teamId) === "1" ? title : (1 - title) / 3,
              playoffProbability: String(team.teamId) === "1" ? (upgraded ? 0.75 : 0.58) : 0.5,
              expectedWins: String(team.teamId) === "1" ? (upgraded ? 8 : 7) : 6,
              expectedPoints: String(team.teamId) === "1" ? (upgraded ? 1550 : 1450) : 1400,
              allPlayWinPct: String(team.teamId) === "1" ? (upgraded ? 0.62 : 0.54) : 0.48,
            })),
          },
          computeMs: 5,
        };
      }
      return { data: [], computeMs: 2.5 };
    },
    close: async () => {},
  };
  return { dataStore, pool, calls, dataset };
}

const settings = {
  teams: 4,
  rounds: 5,
  draftPosition: 2,
  scoring: "ppr",
  riskTolerance: 0.5,
  slots: {
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    FLEX: 1,
    SUPERFLEX: 0,
    DST: 0,
    K: 0,
    BN: 4,
  },
};

const draftState = {
  picks: [],
  rosters: { "1": [], "2": [], "3": [], "4": [] },
};

test("full-stack server exposes health, data, static shell, and compute routes", async (context) => {
  const services = fakeServices();
  const server = await buildServer({
    logger: false,
    dataStore: services.dataStore,
    pool: services.pool,
  });
  context.after(() => server.close());

  await context.test("health reports server compute and model state", async () => {
    const response = await server.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload.architecture, "native-cpp-hybrid-control-plane");
    assert.equal(payload.compute.workers, 2);
    assert.equal(payload.data.modelVersion, "test-model");
    assert.equal(payload.historical.draftReplays, 1536);
    assert.equal(payload.historical.strategies, undefined);
    assert.equal(payload.historical.ready, true);
    assert.equal(payload.historical.draftPolicy.marketWeight, 0.72);
    assert.equal(payload.healthIntelligence.version, "test-health");
    assert.equal(payload.healthIntelligence.affectedPlayers, 1);
    assert.equal(payload.platform.version, "oracle-platform-2026.1");
    assert.equal(payload.platform.eventStore.filePath, undefined);
    assert.equal(payload.platform.snapshots.directory, undefined);
    assert.equal(payload.platform.models.domains.projection.champion, "oracle-ensemble-2026.5-health");
  });

  await context.test("player data supports ETag revalidation", async () => {
    const response = await server.inject({ method: "GET", url: "/api/data/players" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers.etag, '"test-etag"');
    assert.equal(response.json().players.length, services.dataset.players.length);
    const cached = await server.inject({
      method: "GET",
      url: "/api/data/players",
      headers: { "if-none-match": '"test-etag"' },
    });
    assert.equal(cached.statusCode, 304);
  });

  await context.test("draft simulation is delegated to the compute pool", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/draft/simulate",
      payload: {
        state: draftState,
        settings,
        targetTeamId: 2,
        simulations: 1200,
        seed: 2026,
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.computeMode, "javascript-worker-fallback");
    assert.equal(payload.engine, "oracle-javascript-fallback");
    assert.equal(payload.data.simulations, 1200);
    assert.equal(services.calls.at(-1).type, "draft-simulate");
    assert.equal(services.calls.at(-1).payload.players.length, services.dataset.players.length);
  });

  await context.test("draft recommendations preserve the native response envelope", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/draft/recommendations",
      payload: {
        state: draftState,
        settings,
        targetTeamId: 2,
        simulations: 1200,
        seed: 2026,
        limit: 8,
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.data.simulation.simulations, 1200);
    assert.equal(payload.data.recommendations.length, 8);
    assert.ok(Number.isFinite(payload.data.recommendations[0].policyRank));
    assert.equal(payload.data.recommendations[0].utilityRole, "advisory-explanation");
    assert.equal(payload.recommendation.decisionType, "draft-recommendation");
    assert.equal(payload.recommendation.seed, 2026);
    assert.match(payload.recommendation.replayKey, /^[a-f0-9]{64}$/);
  });

  await context.test("platform persists recommendation lineage without exposing filesystem paths", async () => {
    const status = await server.inject({ method: "GET", url: "/api/platform/status" });
    assert.equal(status.statusCode, 200);
    const platform = status.json();
    assert.equal(platform.version, "oracle-platform-2026.1");
    assert.equal(platform.eventStore.filePath, undefined);
    assert.equal(platform.snapshots.directory, undefined);
    assert.match(platform.buildFingerprint, /^[a-f0-9]{64}$/);
    const decisions = await server.inject({ method: "GET", url: "/api/platform/decisions" });
    assert.equal(decisions.statusCode, 200);
    assert.ok(decisions.json().decisions.some((row) => row.record?.envelope?.decisionType === "draft-recommendation"));
  });

  await context.test("championship endpoint compares paired candidate actions", async () => {
    const players = services.dataset.players;
    const leagueState = {
      leagueId: "integration-league",
      season: 2026,
      week: 6,
      userTeamId: "1",
      settings: {
        teams: 4, scoring: "ppr", slots: settings.slots,
        regularSeasonEnd: 14, championshipWeek: 17,
        playoffTeams: 2, playoffByes: 0, faabBudget: 100,
      },
      teams: Array.from({ length: 4 }, (_, index) => ({
        teamId: String(index + 1),
        rosterIds: players.slice(index * 10, index * 10 + 10).map((player) => player.id),
        wins: index, losses: 3 - index, pointsFor: 700 + index * 10,
      })),
      schedule: [
        { week: 6, homeTeamId: "1", awayTeamId: "2" },
        { week: 6, homeTeamId: "3", awayTeamId: "4" },
      ],
      source: { provider: "test", fetchedAt: "2026-08-01T00:00:00.000Z" },
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/championship/evaluate",
      payload: {
        leagueState,
        simulations: 2_000,
        seed: 991,
        actions: [{
          id: "upgrade",
          type: "add-drop",
          teamId: "1",
          addPlayerId: players[45].id,
          dropPlayerId: players[0].id,
          faabBid: 5,
        }],
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.preferredActionId, "upgrade");
    assert.equal(payload.pairedSeed, 991);
    assert.equal(payload.actions.length, 2);
    assert.equal(payload.recommendation.objective, "maximize-championship-probability");
    const leagueCalls = services.calls.filter((call) => call.type === "league-simulate");
    assert.deepEqual(leagueCalls.slice(-2).map((call) => call.payload.seed), [991, 991]);
  });

  await context.test("model governance and drift endpoints enforce evaluation evidence", async () => {
    const registration = await server.inject({
      method: "POST", url: "/api/models/projection/challengers",
      payload: { version: "test-challenger", artifact: "test" },
    });
    assert.equal(registration.statusCode, 200);
    const promotion = await server.inject({
      method: "POST", url: "/api/models/projection/promote/test-challenger",
      payload: {
        primaryMetric: "rmse", direction: "lower",
        championValue: 3, challengerValue: 2.7, minimumImprovement: 0.05,
        sampleSize: 304, minimumSampleSize: 100,
        leakageSafe: true, holdoutSeason: 2025,
      },
    });
    assert.equal(promotion.statusCode, 200);
    assert.equal(promotion.json().evaluation.passed, true);
    const observation = await server.inject({
      method: "POST", url: "/api/models/drift/observations",
      payload: {
        domain: "projection", modelVersion: "test-challenger",
        metric: "win-probability", metricType: "probability",
        prediction: 0.7, outcome: 1,
      },
    });
    assert.equal(observation.statusCode, 200);
    assert.equal(observation.json().observation.modelVersion, "test-challenger");
    const rollback = await server.inject({
      method: "POST", url: "/api/models/projection/rollback", payload: {},
    });
    assert.equal(rollback.statusCode, 200);
    assert.equal(rollback.json().to, "oracle-ensemble-2026.5-health");
  });

  await context.test("model blueprint reports implemented and missing layers", async () => {
    const response = await server.inject({ method: "GET", url: "/api/model/blueprint" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.layers.length, 14);
    assert.ok(payload.readinessScore > 0 && payload.readinessScore < 100);
    assert.equal(payload.layers.find((layer) => layer.id === "coaching").status, "implemented");
  });

  await context.test("historical calibration endpoint exposes replay evidence", async () => {
    const response = await server.inject({ method: "GET", url: "/api/backtests/status" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.ready, true);
    assert.equal(payload.draftReplays, 1536);
    assert.equal(payload.draftPolicy.holdoutSeason, 2025);
    assert.ok(payload.tradeCalibration.utilityCorrelation > 0);
    assert.equal(payload.tradePolicy.holdoutSeason, 2025);
    assert.ok(payload.tradePolicy.utilityShare >= 0 && payload.tradePolicy.utilityShare <= 1);
    assert.equal(payload.waiverPolicy.utilityRerank, false);
    assert.equal(payload.waiverPolicy.holdoutPassed, false);
    assert.ok(payload.waiverCalibration.baseOracleActualGain > payload.waiverCalibration.naiveActualGain);
  });

  await context.test("opportunity endpoints expose holdout evidence and player context", async () => {
    const status = await server.inject({ method: "GET", url: "/api/opportunity/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().holdoutSeason, 2025);
    assert.ok(status.json().diagnostics.overall.rmseImprovement > 0);
    const player = await server.inject({ method: "GET", url: `/api/opportunity/players/${services.dataset.players[0].id}` });
    assert.equal(player.statusCode, 200);
    assert.equal(player.json().opportunityContext.version, "test-opportunity");
  });

  await context.test("health intelligence endpoints separate reports from modeled recovery", async () => {
    const status = await server.inject({ method: "GET", url: "/api/health-intelligence/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().version, "test-health");
    assert.equal(status.json().injuredPlayers, 1);
    const playerId = services.dataset.players[0].id;
    const player = await server.inject({ method: "GET", url: `/api/health-intelligence/players/${playerId}` });
    assert.equal(player.statusCode, 200);
    assert.equal(player.json().healthContext.version, "test-health");
    assert.equal(player.json().healthContext.reportedFacts.injuryBodyPart, "Hamstring");
    assert.ok(player.json().healthContext.returnToPriorLevelProbability > 0);
    const missing = await server.inject({ method: "GET", url: "/api/health-intelligence/players/not-real" });
    assert.equal(missing.statusCode, 404);
  });

  await context.test("coaching endpoints expose current staff profiles", async () => {
    const all = await server.inject({ method: "GET", url: "/api/coaching/teams" });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().coverage, 32);
    const team = await server.inject({ method: "GET", url: "/api/coaching/teams/KC" });
    assert.equal(team.statusCode, 200);
    assert.equal(team.json().headCoach, "Andy Reid");
    const missing = await server.inject({ method: "GET", url: "/api/coaching/teams/XYZ" });
    assert.equal(missing.statusCode, 404);
  });

  await context.test("intelligence endpoints expose team and player signals", async () => {
    const statusResponse = await server.inject({ method: "GET", url: "/api/intelligence/status" });
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.json().version, "test-intelligence");
    assert.equal(statusResponse.json().coverage, services.dataset.players.length);

    const teams = await server.inject({ method: "GET", url: "/api/intelligence/teams" });
    assert.equal(teams.statusCode, 200);
    assert.equal(teams.json().teamCoverage, 1);

    const team = await server.inject({ method: "GET", url: "/api/intelligence/teams/DET" });
    assert.equal(team.statusCode, 200);
    assert.equal(team.json().team, "DET");
    const missingTeam = await server.inject({ method: "GET", url: "/api/intelligence/teams/XYZ" });
    assert.equal(missingTeam.statusCode, 404);

    const playerId = services.dataset.players[0].id;
    const player = await server.inject({ method: "GET", url: `/api/intelligence/players/${playerId}` });
    assert.equal(player.statusCode, 200);
    assert.equal(player.json().decisionIntelligence.version, "test-intelligence");
    assert.equal(player.json().healthContext.version, "test-health");
    const missingPlayer = await server.inject({ method: "GET", url: "/api/intelligence/players/not-real" });
    assert.equal(missingPlayer.statusCode, 404);
  });

  await context.test("static allowlist does not expose server source files", async () => {
    const shell = await server.inject({ method: "GET", url: "/" });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /Fantasy Football Oracle/);
    assert.match(shell.body, /Championship control center/);
    assert.match(shell.body, /run-championship-button/);
    const privateFile = await server.inject({ method: "GET", url: "/server/index.js" });
    assert.equal(privateFile.statusCode, 404);
  });
});

test("startup failure closes compute and platform resources", async () => {
  const calls = { poolStarted: 0, poolClosed: 0, dataStopped: 0, unsubscribed: 0, platformStopped: 0 };
  const dataStore = {
    async initialize() {},
    getStatus() { return { etag: "test-etag" }; },
    getDataset() { return { players: [] }; },
    onDataset() { return () => { calls.unsubscribed += 1; }; },
    stop() { calls.dataStopped += 1; },
  };
  const pool = {
    start() { calls.poolStarted += 1; },
    async setDataset() {},
    async close() { calls.poolClosed += 1; },
    stats() { return {}; },
  };
  const controlPlane = {
    attachFastify() {},
    async initialize() {
      const error = new Error("startup failed");
      error.code = "TEST_STARTUP_FAILURE";
      throw error;
    },
    async stop() { calls.platformStopped += 1; },
  };
  await assert.rejects(
    () => buildServer({ logger: false, dataStore, pool, controlPlane }),
    { code: "TEST_STARTUP_FAILURE" },
  );
  assert.deepEqual(calls, {
    poolStarted: 1,
    poolClosed: 1,
    dataStopped: 1,
    unsubscribed: 1,
    platformStopped: 1,
  });
});
test("manual server refresh requires the configured admin token", async (context) => {
  const services = fakeServices();
  const server = await buildServer({
    logger: false,
    dataStore: services.dataStore,
    pool: services.pool,
    config: { adminToken: "test-secret" },
  });
  context.after(() => server.close());

  const missing = await server.inject({
    method: "POST",
    url: "/api/data/refresh",
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "ADMIN_TOKEN_REQUIRED");

  const authorized = await server.inject({
    method: "POST",
    url: "/api/data/refresh",
    headers: { authorization: "bEaReR test-secret" },
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.headers["cache-control"], "no-store");
  assert.equal(authorized.json().refreshed, true);
});

test("readiness route exposes a minimal no-store production probe", async (context) => {
  const services = fakeServices();
  const server = await buildServer({
    logger: false,
    dataStore: services.dataStore,
    pool: services.pool,
  });
  context.after(() => server.close());

  const response = await server.inject({ method: "GET", url: "/api/ready" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const payload = response.json();
  assert.equal(payload.ready, true);
  assert.equal(payload.status, "ready");
  assert.equal(payload.dataReady, true);
  assert.equal(payload.players, services.dataset.players.length);
  assert.equal(payload.dataSource, "test");
  assert.equal(payload.nativeRequired, false);
  assert.equal(payload.nativeAvailable, null);
  assert.equal(payload.liveWorkers, 2);
  assert.equal(payload.readyWorkers, 2);
  assert.equal(payload.strictArtifacts, false);
  assert.equal(typeof payload.artifactValid, "boolean");
  assert.equal(payload.eventChainValid, true);
  assert.deepEqual(payload.failures, []);
});

test("server errors are correlated without leaking internal details", async (context) => {
  const services = fakeServices();
  const server = await buildServer({
    logger: false,
    dataStore: services.dataStore,
    pool: services.pool,
  });
  server.get("/api/test/internal-error", async () => {
    const error = new Error("C:\\private\\model-registry.json failed");
    error.code = "TEST_INTERNAL_FAILURE";
    throw error;
  });
  context.after(() => server.close());

  const response = await server.inject({ method: "GET", url: "/api/test/internal-error" });
  const payload = response.json();
  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(payload.error, "Server Error");
  assert.equal(payload.code, "TEST_INTERNAL_FAILURE");
  assert.equal(payload.message, "The Oracle server could not complete the request.");
  assert.equal(typeof payload.requestId, "string");
  assert.equal(JSON.stringify(payload).includes("private"), false);
});

test("trusted proxy headers cannot spoof loopback admin access", async (context) => {
  const services = fakeServices();
  const server = await buildServer({
    logger: false,
    dataStore: services.dataStore,
    pool: services.pool,
    config: { adminToken: "", trustProxy: true },
  });
  context.after(() => server.close());

  const response = await server.inject({
    method: "POST",
    url: "/api/data/refresh",
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  const payload = response.json();
  assert.equal(response.statusCode, 401);
  assert.equal(payload.error, "Unauthorized");
  assert.equal(payload.code, "ADMIN_TOKEN_REQUIRED");
});
test("listen failures close initialized server resources", async () => {
  const processRef = new EventEmitter();
  const closeHooks = [];
  let closes = 0;
  const listenFailure = Object.assign(new Error("address unavailable"), { code: "EADDRINUSE" });
  const server = {
    log: { info() {}, warn() {}, error() {} },
    addHook(name, hook) {
      if (name === "onClose") closeHooks.push(hook);
    },
    async listen() { throw listenFailure; },
    async close() {
      closes += 1;
      for (const hook of closeHooks) await hook();
    },
  };
  await assert.rejects(() => start({
    builder: async () => server,
    config: { host: "127.0.0.1", port: 8787, shutdownRequestPath: "" },
    processRef,
  }), { code: "EADDRINUSE" });
  assert.equal(closes, 1);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});
