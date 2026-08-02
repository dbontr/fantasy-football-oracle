const assert = require("node:assert/strict");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const { MODEL_VERSION, applyProjectionModel } = require("../server/projection-model.js");

test("server projection model creates a bounded 18-week ensemble", () => {
  const sourcePlayer = bundled.players[0];
  const modeled = applyProjectionModel({
    meta: { ...bundled.meta },
    schedule: bundled.schedule,
    players: [sourcePlayer],
  });
  const player = modeled.players[0];
  assert.equal(modeled.meta.modelVersion, MODEL_VERSION);
  assert.equal(modeled.meta.serverModeled, true);
  assert.match(modeled.meta.modelDigest, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(player.weeklyProjections.length, 18);
  assert.equal(player.sourceWeeklyProjections.length, 18);
  assert.equal(player.weeklyProjections[player.byeWeek - 1], 0);
  assert.ok(player.floorProjection >= 0);
  assert.ok(player.ceilingProjection >= player.weeklyProjection);
  assert.ok(player.reliability >= 0.2 && player.reliability <= 0.98);
  assert.equal(player.projectionModel.version, MODEL_VERSION);
  assert.ok(player.projectionModel.components.includes("prior-production"));
  assert.ok(player.projectionModel.components.includes("team-ecosystem"));
  assert.ok(modeled.meta.contextVersion);
  assert.ok(modeled.intelligence);
  assert.ok(player.decisionIntelligence);
  assert.equal(player.decisionIntelligence.matchup.weekly.length, 18);
});
