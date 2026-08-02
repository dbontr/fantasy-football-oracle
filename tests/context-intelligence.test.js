const assert = require("node:assert/strict");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const {
  CONTEXT_MODEL_VERSION,
  applyContextIntelligence,
} = require("../server/context-intelligence.js");
const { applyProjectionModel } = require("../server/projection-model.js");

test("context intelligence covers players and all NFL teams", () => {
  const modeled = applyProjectionModel(bundled);
  assert.equal(modeled.intelligence.version, CONTEXT_MODEL_VERSION);
  assert.equal(modeled.intelligence.teamCoverage, 32);
  assert.equal(modeled.intelligence.coverage, modeled.players.length);
  assert.equal(Object.keys(modeled.intelligence.teamProfiles).length, 32);
  assert.ok(modeled.meta.contextVersion);
});

test("context effects remain league centered and bounded", () => {
  const modeled = applyProjectionModel(bundled);
  const factors = modeled.players
    .filter((player) => player.weeklyProjection > 0.05)
    .map((player) => player.decisionIntelligence.meanFactor);
  const average = factors.reduce((sum, value) => sum + value, 0) / factors.length;
  assert.ok(average > 0.985 && average < 1.015);
  assert.ok(Math.min(...factors) >= 0.95);
  assert.ok(Math.max(...factors) <= 1.05);
  assert.ok(factors.some((value) => value < 0.995));
  assert.ok(factors.some((value) => value > 1.005));
});

test("player intelligence exposes opportunity, matchup, consensus, and risk", () => {
  const modeled = applyProjectionModel(bundled);
  const player = modeled.players.find((row) => row.position === "RB" && row.weeklyProjection > 10);
  const intelligence = player.decisionIntelligence;
  assert.ok(intelligence);
  assert.equal(intelligence.version, CONTEXT_MODEL_VERSION);
  assert.equal(intelligence.matchup.weekly.length, 18);
  assert.ok(intelligence.opportunity.index >= 0 && intelligence.opportunity.index <= 100);
  assert.ok(intelligence.opportunity.roleCertainty >= 0 && intelligence.opportunity.roleCertainty <= 1);
  assert.ok(intelligence.consensus.conviction >= 0 && intelligence.consensus.conviction <= 1);
  assert.ok(intelligence.risk.fragility >= 0 && intelligence.risk.fragility <= 1);
  assert.ok(intelligence.risk.breakoutProbability >= 0 && intelligence.risk.breakoutProbability <= 1);
  assert.ok(intelligence.risk.bustProbability >= 0 && intelligence.risk.bustProbability <= 1);
  const uncertaintyTotal = Object.values(intelligence.risk.uncertainty)
    .reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(uncertaintyTotal - 1) < 0.01);
  assert.ok(intelligence.drivers.length >= 3);
});

test("depth-chart competition differentiates teammates", () => {
  const modeled = applyProjectionModel(bundled);
  const teamRows = modeled.players
    .filter((player) => player.team === "DET" && player.position === "RB" && player.weeklyProjection > 0)
    .sort((left, right) => right.weeklyProjection - left.weeklyProjection);
  assert.ok(teamRows.length >= 2);
  assert.ok(teamRows[0].decisionIntelligence.opportunity.positionShare >
    teamRows[1].decisionIntelligence.opportunity.positionShare);
  assert.ok(teamRows[0].decisionIntelligence.opportunity.index >=
    teamRows[1].decisionIntelligence.opportunity.index);
});

test("context model can run independently on coached players", () => {
  const subset = bundled.players.slice(0, 250).map((player) => ({ ...player }));
  const result = applyContextIntelligence(subset, bundled.schedule);
  assert.equal(result.players.length, subset.length);
  assert.ok(result.intelligence.teamCoverage >= 20);
});
