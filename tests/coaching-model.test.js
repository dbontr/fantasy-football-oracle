const assert = require("node:assert/strict");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const {
  COACH_MODEL_VERSION,
  applyCoachingToPlayer,
  coachingContext,
  coachingData,
  evidenceWeight,
  profileForTeam,
} = require("../server/coaching-model.js");
const { applyProjectionModel } = require("../server/projection-model.js");

test("2026 coaching data covers every NFL team", () => {
  assert.equal(coachingData.meta.version, COACH_MODEL_VERSION);
  assert.equal(Object.keys(coachingData.teams).length, 32);
  assert.equal(profileForTeam("KC").headCoach, "Andy Reid");
  assert.equal(profileForTeam("CHI").offensivePlayCaller, "Ben Johnson");
  assert.equal(profileForTeam("FA").team, "FA");
});

test("coaching priors shrink toward neutral based on evidence", () => {
  assert.ok(evidenceWeight(profileForTeam("KC")) > evidenceWeight(profileForTeam("ARI")));
  const established = coachingContext({ team: "KC", position: "QB" });
  const newStaff = coachingContext({ team: "ARI", position: "QB" });
  assert.ok(established.sourceConfidence > newStaff.sourceConfidence);
  assert.ok(established.meanFactor >= 0.95 && established.meanFactor <= 1.06);
  assert.ok(newStaff.volatilityFactor >= 0.87 && newStaff.volatilityFactor <= 1.16);
});
test("coaching context changes mean, reliability, and uncertainty", () => {
  const source = bundled.players.find((player) => player.position === "WR");
  const base = {
    ...source,
    weeklyProjection: 12,
    weeklyProjections: Array(18).fill(12),
    projectedPoints: 204,
    projectionStdDev: 5,
    reliability: .7,
    injuryRisk: .2,
    projectionModel: { components: ["source"] },
  };
  const kc = applyCoachingToPlayer({ ...base, team: "KC" });
  const freeAgent = applyCoachingToPlayer({ ...base, team: "FA" });
  assert.notEqual(kc.weeklyProjection, freeAgent.weeklyProjection);
  assert.notEqual(kc.reliability, freeAgent.reliability);
  assert.ok(kc.coachingContext.drivers.length >= 2);
  assert.ok(kc.projectionModel.components.includes("coaching-staff"));
  assert.ok(kc.injuryRisk >= 0 && kc.injuryRisk <= .95);
});

test("projection ensemble exposes staff metadata and coaching components", () => {
  const source = bundled.players.slice(0, 12);
  const modeled = applyProjectionModel({
    meta: { ...bundled.meta },
    schedule: bundled.schedule,
    players: source,
  });
  assert.equal(modeled.meta.coachingVersion, COACH_MODEL_VERSION);
  assert.equal(modeled.coaching.coverage, 32);
  for (const player of modeled.players) {
    assert.equal(player.coachingContext.version, COACH_MODEL_VERSION);
    assert.ok(player.projectionModel.components.includes("scheme"));
    assert.ok(player.weeklyProjections.length === 18);
    assert.ok(player.floorProjection <= player.weeklyProjection);
    assert.ok(player.ceilingProjection >= player.weeklyProjection);
  }
});

test("league-relative coaching effects remain centered", () => {
  const modeled = applyProjectionModel(bundled);
  const factors = modeled.players.map((player) => player.coachingContext.meanFactor);
  const average = factors.reduce((sum, value) => sum + value, 0) / factors.length;
  assert.ok(Math.abs(average - 1) < .002);
  assert.ok(factors.some((value) => value < 1));
  assert.ok(factors.some((value) => value > 1));
  assert.ok(Math.min(...factors) >= .95);
  assert.ok(Math.max(...factors) <= 1.06);
});
