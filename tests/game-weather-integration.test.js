"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const { AdvancedIntelligence } = require("../server/advanced-intelligence.js");
const { scheduledGame } = require("../server/game-identity.js");
const { applyProjectionModel } = require("../server/projection-model.js");

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const dataset = applyProjectionModel(sourceDataset);

test("advanced forecasts resolve game evidence from the schedule automatically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-game-evidence-"));
  const service = new AdvancedIntelligence({
    datasetProvider: () => dataset,
    runtimeDir: directory,
    clock: () => NOW,
    logger: { warn() {}, error() {} },
  });
  await service.initialize();
  try {
    const player = dataset.players.find((row) => (
      row.position === "WR" && row.weeklyProjections[0] > 0
        && scheduledGame(dataset, row.team, 1)?.id
    ));
    const game = scheduledGame(dataset, player.team, 1);
    const baseline = service.forecast({ playerIds: [player.id], week: 1, asOf: NOW });
    await service.ingestEvidence([{
      entityType: "game",
      entityId: game.id,
      feature: "environment.wind_mph",
      value: 32,
      source: { name: "weather-fixture", reliability: 0.95 },
      confidence: 0.95,
      observedAt: new Date(NOW).toISOString(),
    }]);
    const windy = service.forecast({ playerIds: [player.id], week: 1, asOf: NOW });
    assert.ok(windy.forecasts[0].activeDistribution.mean
      < baseline.forecasts[0].activeDistribution.mean);
    const wind = windy.forecasts[0].evidence.used.find(
      (row) => row.feature === "environment.wind_mph",
    );
    assert.equal(wind.entityType, "game");
    assert.equal(wind.entityId, game.id);
    assert.ok(windy.forecasts[0].contributions.some(
      (row) => row.feature === "environment.wind_mph" && row.impact < 0,
    ));
  } finally {
    await service.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
