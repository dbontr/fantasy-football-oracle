"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const { buildServer } = require("../server/index.js");
const { applyProjectionModel } = require("../server/projection-model.js");

const dataset = applyProjectionModel(sourceDataset);
const players = dataset.players
  .filter((player) => ["QB", "RB", "WR"].includes(player.position))
  .slice(0, 8);

function services() {
  const dataStore = {
    async initialize() {},
    getDataset() { return dataset; },
    getPlayer(id) { return dataset.players.find((player) => String(player.id) === String(id)) || null; },
    getStatus() {
      return {
        ready: true,
        source: "test",
        players: dataset.players.length,
        generatedAt: dataset.meta?.generatedAt,
        modelVersion: dataset.meta?.modelVersion,
        etag: "v5-api-test",
      };
    },
    onDataset() { return () => {}; },
    async refresh() { return { refreshed: true, status: this.getStatus() }; },
    stop() {},
  };
  const pool = {
    start() {},
    async setDataset() {},
    stats() { return { workers: 2, readyWorkers: 2, liveWorkers: 2, queued: 0 }; },
    async close() {},
    async run() { return { data: {}, computeMs: 0, engine: "test" }; },
  };
  return { dataStore, pool };
}

function observation(player, value) {
  return {
    entityType: "player",
    entityId: String(player.id),
    feature: "market.player_points",
    value,
    source: { name: "api-test", reliability: 0.95 },
    confidence: 0.95,
    observedAt: "2026-08-02T16:00:00.000Z",
  };
}

async function createServer() {
  const injected = services();
  return buildServer({
    logger: false,
    dataStore: injected.dataStore,
    pool: injected.pool,
    config: {
      adminToken: "test-secret",
      refreshIntervalMs: 24 * 60 * 60 * 1000,
      minimumRefreshMs: 60_000,
    },
  });
}

test("v5 status and catalog are public without leaking paths", async (context) => {
  const server = await createServer();
  context.after(() => server.close());

  const status = await server.inject({ method: "GET", url: "/api/v5/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(status.json().initialized, true);
  assert.equal(status.json().evidence.valid, true);
  assert.equal(JSON.stringify(status.json()).includes("oracle-platform-"), false);
  assert.equal(JSON.stringify(status.json()).includes("\\"), false);

  const catalog = await server.inject({ method: "GET", url: "/api/v5/catalog" });
  assert.equal(catalog.statusCode, 200);
  assert.ok(catalog.json().features > 10);
  assert.ok(catalog.json().families.market.includes("market.player_points"));
});

test("v5 forecasts and what-if evidence remain non-persistent", async (context) => {
  const server = await createServer();
  context.after(() => server.close());
  const player = players[0];

  const baselineResponse = await server.inject({
    method: "POST",
    url: "/api/v5/forecast",
    payload: { playerIds: [player.id], week: 1 },
  });
  assert.equal(baselineResponse.statusCode, 200, baselineResponse.body);
  assert.equal(baselineResponse.headers["cache-control"], "no-store");
  const baseline = baselineResponse.json();
  assert.equal(baseline.forecasts.length, 1);

  const whatIfResponse = await server.inject({
    method: "POST",
    url: "/api/v5/what-if",
    payload: {
      playerIds: [player.id],
      week: 1,
      additionalObservations: [observation(
        player,
        baseline.forecasts[0].baseline.mean + 10,
      )],
    },
  });
  assert.equal(whatIfResponse.statusCode, 200, whatIfResponse.body);
  assert.ok(whatIfResponse.json().forecasts[0].distribution.mean
    > baseline.forecasts[0].distribution.mean);

  const status = await server.inject({ method: "GET", url: "/api/v5/status" });
  assert.equal(status.json().evidence.observations, 0);

  const direct = await server.inject({
    method: "GET",
    url: `/api/v5/players/${player.id}/forecast?week=1`,
  });
  assert.equal(direct.statusCode, 200, direct.body);
  assert.equal(direct.json().forecast.player.id, String(player.id));
  assert.equal(Object.hasOwn(direct.json(), "forecasts"), false);
});

test("persistent evidence ingestion and raw search require administration", async (context) => {
  const server = await createServer();
  context.after(() => server.close());
  const player = players[1];
  const payload = { observations: [observation(player, 24)] };

  const denied = await server.inject({
    method: "POST", url: "/api/v5/evidence", payload,
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().code, "ADMIN_TOKEN_REQUIRED");

  const accepted = await server.inject({
    method: "POST",
    url: "/api/v5/evidence",
    headers: { authorization: "Bearer test-secret" },
    payload,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.json().accepted, 1);

  const rawDenied = await server.inject({
    method: "GET", url: `/api/v5/evidence?entityId=${player.id}`,
  });
  assert.equal(rawDenied.statusCode, 401);

  const raw = await server.inject({
    method: "GET",
    url: `/api/v5/evidence?entityId=${player.id}`,
    headers: { authorization: "Bearer test-secret" },
  });
  assert.equal(raw.statusCode, 200, raw.body);
  assert.equal(raw.json().observations.length, 1);

  const resolved = await server.inject({
    method: "GET", url: `/api/v5/players/${player.id}/evidence`,
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.ok(Math.abs(resolved.json().resolved["market.player_points"].value - 24) < 1e-9);
  assert.equal(Object.hasOwn(resolved.json(), "observations"), false);
});

test("portfolio evaluation records robust recommendation lineage", async (context) => {
  const server = await createServer();
  context.after(() => server.close());

  const response = await server.inject({
    method: "POST",
    url: "/api/v5/portfolio/evaluate",
    payload: {
      portfolios: [
        { id: "alpha", playerIds: players.slice(0, 3).map((player) => player.id) },
        { id: "beta", playerIds: players.slice(3, 6).map((player) => player.id) },
      ],
      week: 1,
      scenarios: 600,
      seed: 2026,
      riskAversion: 0.45,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.simulation.scenarios, 600);
  assert.equal(body.decision.actions.length, 2);
  assert.ok(["alpha", "beta"].includes(body.decision.preferredActionId));
  assert.equal(body.recommendation.decisionType, "robust-portfolio-evaluation");
  assert.equal(body.recommendation.objective, "robust-fantasy-points");
  assert.equal(typeof body.recommendation.decisionId, "string");
  assert.equal(JSON.stringify(body).includes("filePath"), false);
  assert.equal(Object.hasOwn(body, "samples"), false);
});

test("v5 request schemas reject oversized or incomplete work", async (context) => {
  const server = await createServer();
  context.after(() => server.close());

  const missingEvidence = await server.inject({
    method: "POST",
    url: "/api/v5/what-if",
    payload: { playerIds: [players[0].id] },
  });
  assert.equal(missingEvidence.statusCode, 400);

  const oversized = await server.inject({
    method: "POST",
    url: "/api/v5/portfolio/evaluate",
    payload: {
      portfolios: [{ id: "alpha", playerIds: [players[0].id] }],
      scenarios: 50001,
    },
  });
  assert.equal(oversized.statusCode, 400);
});
