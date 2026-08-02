"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildServer } = require("../server/index.js");
const { HybridComputePool } = require("../server/hybrid-compute-pool.js");
const { NativeEnginePool } = require("../server/native-engine-pool.js");
const { WorkerPool } = require("../server/worker-pool.js");

const root = path.resolve(__dirname, "..");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "data", "players-2026.json"), "utf8"));
const binary = path.join(root, "native", "bin", process.platform === "win32"
  ? "oracle-engine.exe"
  : "oracle-engine");
const workerFile = path.join(root, "server", "compute-worker.js");
const settings = {
  teams: 4,
  rounds: 16,
  draftPosition: 1,
  scoring: "ppr",
  riskTolerance: 0.5,
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 1, K: 1, BN: 7 },
};

function fakeDataStore() {
  return {
    async initialize() {},
    stop() {},
    getDataset() { return dataset; },
    getStatus() {
      return {
        ready: true,
        source: "test",
        season: dataset.meta.season,
        players: dataset.players.length,
        modelVersion: "test-model",
        etag: '"native-test"',
      };
    },
    async refresh() { return this.getStatus(); },
  };
}

function roster(offset = 0) {
  const rows = [];
  for (const [position, count] of [["QB", 2], ["RB", 4], ["WR", 4], ["TE", 2], ["DST", 1], ["K", 1]]) {
    rows.push(...dataset.players
      .filter((player) => player.position === position)
      .sort((left, right) => left.pprRank - right.pprRank)
      .slice(offset, offset + count));
  }
  return rows;
}

function createPool() {
  return new HybridComputePool({
    native: new NativeEnginePool({
      binary,
      size: 1,
      maxQueue: 8,
      taskTimeoutMs: 60_000,
      logger: { warn() {} },
    }),
    fallback: new WorkerPool({
      workerFile,
      size: 1,
      maxQueue: 8,
      taskTimeoutMs: 60_000,
      logger: { warn() {} },
    }),
    required: true,
    logger: { warn() {} },
  });
}

test("server routes use the native C++ engine", async (context) => {
  const server = await buildServer({
    logger: false,
    dataStore: fakeDataStore(),
    pool: createPool(),
    config: {
      nativeRequired: true,
      workerCount: 1,
      nativeWorkerCount: 1,
      defaultSimulations: 2_000,
      maxSimulations: 20_000,
    },
  });
  await server.ready();
  context.after(async () => server.close());

  const health = await server.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().compute.mode, "native-cpp-primary");
  assert.equal(health.json().compute.native.engine, "oracle-native");

  const draft = await server.inject({
    method: "POST",
    url: "/api/draft/simulate",
    payload: {
      state: { picks: [], rosters: {} },
      settings,
      targetTeamId: 1,
      simulations: 1_000,
      seed: 2026,
    },
  });
  assert.equal(draft.statusCode, 200);
  assert.equal(draft.json().computeMode, "native-cpp");
  assert.equal(draft.json().engine, "oracle-native");
});

test("native API exposes start-sit, FAAB, season, and league simulation", async (context) => {
  const server = await buildServer({
    logger: false,
    dataStore: fakeDataStore(),
    pool: createPool(),
    config: {
      nativeRequired: true,
      workerCount: 1,
      nativeWorkerCount: 1,
      defaultSimulations: 1_000,
      maxSimulations: 20_000,
    },
  });
  await server.ready();
  context.after(async () => server.close());

  const myRoster = roster();
  const myIds = myRoster.map((player) => player.id);
  const startSit = await server.inject({
    method: "POST",
    url: "/api/lineup/start-sit",
    payload: { rosterIds: myIds, settings, week: 6, opponentTarget: 130 },
  });
  assert.equal(startSit.statusCode, 200);
  assert.equal(startSit.json().computeMode, "native-cpp");
  assert.equal(startSit.json().data.profiles.balanced.slots, 9);
  assert.equal(startSit.json().data.model, "native-start-sit-v2-regret");
  assert.ok(startSit.json().data.regret.totalExpectedRegret >= 0);
  assert.ok(startSit.json().data.regret.averageExpectedRegret >= 0);
  assert.ok(startSit.json().data.decisions.every((row) => Number(row.expectedRegret) >= 0));

  const unavailable = new Set(myIds);
  const freeAgentIds = dataset.players
    .filter((player) => !unavailable.has(player.id) && ["RB", "WR", "TE"].includes(player.position))
    .slice(0, 80)
    .map((player) => player.id);
  const waivers = await server.inject({
    method: "POST",
    url: "/api/waivers/recommend",
    payload: {
      rosterIds: myIds,
      freeAgentIds,
      settings,
      week: 6,
      budgetRemaining: 100,
      weeksRemaining: 12,
      aggressiveness: 0.6,
    },
  });
  assert.equal(waivers.statusCode, 200);
  assert.ok(waivers.json().data[0].faab.target >= 1);

  const season = await server.inject({
    method: "POST",
    url: "/api/season/simulate",
    payload: {
      rosterIds: myIds,
      settings,
      startWeek: 1,
      endWeek: 17,
      simulations: 1_000,
      seed: 2026,
    },
  });
  assert.equal(season.statusCode, 200);
  assert.ok(season.json().data.p10 < season.json().data.p90);

  const teams = Array.from({ length: 4 }, (_, index) => ({
    teamId: String(index + 1),
    name: `Team ${index + 1}`,
    roster: roster(index * 4),
  }));
  const league = await server.inject({
    method: "POST",
    url: "/api/league/simulate",
    payload: {
      teams,
      settings,
      startWeek: 1,
      regularSeasonEnd: 14,
      championshipWeek: 17,
      playoffTeams: 4,
      simulations: 500,
      seed: 2026,
    },
  });
  assert.equal(league.statusCode, 200);
  assert.equal(league.json().computeMode, "native-cpp");
  assert.equal(league.json().data.teams.length, 4);
});
