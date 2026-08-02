"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const {
  AdvancedIntelligence,
} = require("../server/advanced-intelligence.js");
const { applyProjectionModel } = require("../server/projection-model.js");

const NOW = Date.parse("2026-08-02T17:00:00.000Z");
const dataset = applyProjectionModel(sourceDataset);
const selected = dataset.players
  .filter((player) => ["QB", "RB", "WR"].includes(player.position))
  .slice(0, 8);

async function createService(runtimeDir = null) {
  const directory = runtimeDir || await fs.mkdtemp(path.join(os.tmpdir(), "oracle-v5-"));
  const service = new AdvancedIntelligence({
    datasetProvider: () => dataset,
    runtimeDir: directory,
    clock: () => NOW,
    maxForecastPlayers: 8,
    maxEvidenceBatch: 20,
    logger: { warn() {}, error() {} },
  });
  await service.initialize();
  return { directory, service };
}

function marketObservation(player, value) {
  return {
    entityType: "player",
    entityId: String(player.id),
    feature: "market.player_points",
    value,
    source: { name: "test-market", reliability: 0.95 },
    confidence: 0.95,
    observedAt: "2026-08-02T16:00:00.000Z",
  };
}

test("advanced intelligence initializes without exposing runtime paths", async () => {
  const context = await createService();
  try {
    const status = context.service.status();
    assert.equal(status.initialized, true);
    assert.equal(status.evidence.valid, true);
    assert.equal(status.evidence.observations, 0);
    assert.ok(status.catalog.features > 10);
    assert.equal(JSON.stringify(status).includes(context.directory), false);
  } finally {
    await context.service.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("persistent evidence changes forecasts and survives restart", async () => {
  const context = await createService();
  const player = selected[0];
  try {
    const before = context.service.forecast({
      playerIds: [player.id],
      week: 1,
      asOf: NOW,
    });
    const ingestion = await context.service.ingestEvidence([
      marketObservation(player, before.forecasts[0].baseline.mean + 7),
    ]);
    assert.equal(ingestion.accepted, 1);
    const after = context.service.forecast({
      playerIds: [player.id],
      week: 1,
      asOf: NOW,
    });
    assert.ok(after.forecasts[0].activeDistribution.mean
      > before.forecasts[0].activeDistribution.mean);
    assert.notEqual(after.digest, before.digest);
    await context.service.stop();

    const replay = await createService(context.directory);
    try {
      assert.equal(replay.service.status().evidence.observations, 1);
      const replayed = replay.service.forecast({ playerIds: [player.id], week: 1, asOf: NOW });
      assert.equal(replayed.forecasts[0].activeDistribution.mean,
        after.forecasts[0].activeDistribution.mean);
    } finally {
      await replay.service.stop();
    }
  } finally {
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("what-if evidence changes output without persistence", async () => {
  const context = await createService();
  const player = selected[1];
  try {
    const baseline = context.service.forecast({
      playerIds: [player.id], week: 1, asOf: NOW,
    });
    const whatIf = context.service.forecast({
      playerIds: [player.id], week: 1, asOf: NOW,
      additionalObservations: [marketObservation(
        player,
        baseline.forecasts[0].baseline.mean + 10,
      )],
    });
    assert.ok(whatIf.forecasts[0].distribution.mean
      > baseline.forecasts[0].distribution.mean);
    assert.equal(context.service.status().evidence.observations, 0);
  } finally {
    await context.service.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("portfolio evaluation returns forecasts and robust rankings", async () => {
  const context = await createService();
  try {
    const result = context.service.evaluate({
      portfolios: [
        { id: "alpha", playerIds: selected.slice(0, 3).map((player) => player.id) },
        { id: "beta", playerIds: selected.slice(3, 6).map((player) => player.id) },
      ],
      week: 1,
      asOf: NOW,
      scenarios: 1000,
      seed: 2026,
      riskAversion: 0.4,
    });
    assert.equal(result.simulation.scenarios, 1000);
    assert.equal(result.decision.actions.length, 2);
    assert.equal(result.forecasts.length, 6);
    assert.ok(["alpha", "beta"].includes(result.decision.preferredActionId));
    assert.equal(typeof result.forecastDigest, "string");
    assert.equal(Object.hasOwn(result, "samples"), false);
  } finally {
    await context.service.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("advanced intelligence enforces player and evidence limits", async () => {
  const context = await createService();
  try {
    assert.throws(
      () => context.service.forecast({ playerIds: ["not-real"], week: 1 }),
      { code: "PLAYER_UNKNOWN" },
    );
    assert.throws(
      () => context.service.forecast({
        playerIds: selected[0].id ? [selected[0].id] : [],
        additionalObservations: Array.from({ length: 21 }, () => (
          marketObservation(selected[0], 20)
        )),
      }),
      { code: "EVIDENCE_BATCH_LIMIT" },
    );
    await assert.rejects(
      () => context.service.ingestEvidence([]),
      { code: "EVIDENCE_BATCH_REQUIRED" },
    );
  } finally {
    await context.service.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});
