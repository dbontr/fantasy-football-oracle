"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  rankInformationNeeds,
  rankPairedActions,
} = require("../server/robust-decision.js");
const {
  evaluatePortfolios,
  simulateForecasts,
} = require("../server/scenario-engine.js");

function forecast(id, team, position, mean = 15, standardDeviation = 5, overrides = {}) {
  return {
    version: "test",
    week: 1,
    player: { id, name: `Player ${id}`, team, position },
    baseline: { mean, standardDeviation, availability: 1, reliability: 0.8, bye: false },
    availability: { probability: 1, confidence: 0.9 },
    activeDistribution: { mean, standardDeviation },
    distribution: { mean, p10: mean - standardDeviation, p90: mean + standardDeviation },
    confidence: 0.8,
    uncertainty: { epistemic: 1.5, evidenceConflict: 0.5, availability: 0 },
    evidence: {
      missingFamilies: ["tracking", "market"],
      used: [],
    },
    ...overrides,
  };
}

const forecasts = [
  forecast("qb", "LAR", "QB", 18, 5),
  forecast("wr", "LAR", "WR", 16, 6),
  forecast("rb", "KC", "RB", 15, 5),
];
const schedule = {
  LAR: { weeks: [{ opponent: "SF", home: true, indoor: false }] },
  SF: { weeks: [{ opponent: "LAR", home: false, indoor: false }] },
  KC: { weeks: [{ opponent: "LV", home: true, indoor: false }] },
  LV: { weeks: [{ opponent: "KC", home: false, indoor: true }] },
};

test("paired action ranking changes with risk preference", () => {
  const aggressive = rankPairedActions([
    { id: "stable", samples: [11, 11, 11, 11, 11, 11] },
    { id: "volatile", samples: [0, 0, 12, 18, 20, 24] },
  ], { riskAversion: 0 });
  const conservative = rankPairedActions([
    { id: "stable", samples: [11, 11, 11, 11, 11, 11] },
    { id: "volatile", samples: [0, 0, 12, 18, 20, 24] },
  ], { riskAversion: 1 });
  assert.equal(aggressive.preferredActionId, "volatile");
  assert.equal(conservative.preferredActionId, "stable");
  assert.equal(aggressive.actions.some((row) => Object.hasOwn(row, "samples")), false);
  const probabilityTotal = aggressive.actions.reduce(
    (sum, row) => sum + row.probabilityBest,
    0,
  );
  assert.ok(Math.abs(probabilityTotal - 1) < 1e-6);
  assert.ok(aggressive.actions.every((row) => row.regret.expected >= 0));
});

test("scenario generation is deterministic and input-order independent", () => {
  const first = simulateForecasts(forecasts, {
    scenarios: 1000,
    seed: "deterministic",
    schedule,
    week: 1,
  });
  const second = simulateForecasts([...forecasts].reverse(), {
    scenarios: 1000,
    seed: "deterministic",
    schedule,
    week: 1,
  });
  assert.deepEqual(first.playerSamples.qb, second.playerSamples.qb);
  assert.deepEqual(first.playerSamples.wr, second.playerSamples.wr);
  assert.deepEqual(first.playerSamples.rb, second.playerSamples.rb);
  const different = simulateForecasts(forecasts, {
    scenarios: 1000,
    seed: "different",
    schedule,
    week: 1,
  });
  assert.notDeepEqual(first.playerSamples.qb, different.playerSamples.qb);
});

test("same-team outcomes correlate more than unrelated outcomes", () => {
  const simulation = simulateForecasts(forecasts, {
    scenarios: 8000,
    seed: 4102,
    schedule,
    week: 1,
    correlationPairs: [["qb", "wr"], ["qb", "rb"]],
  });
  const sameTeam = simulation.correlations.find(
    (row) => row.leftId === "qb" && row.rightId === "wr",
  );
  const unrelated = simulation.correlations.find(
    (row) => row.leftId === "qb" && row.rightId === "rb",
  );
  assert.equal(sameTeam.relationship, "same-team");
  assert.equal(unrelated.relationship, "unrelated");
  assert.ok(sameTeam.correlation > 0.12, `same-team correlation ${sameTeam.correlation}`);
  assert.ok(Math.abs(unrelated.correlation) < 0.06, `unrelated correlation ${unrelated.correlation}`);
  assert.ok(sameTeam.correlation > unrelated.correlation + 0.1);
});
test("portfolio evaluation returns robust paired decisions", () => {
  const result = evaluatePortfolios(forecasts, [
    { id: "stack", label: "QB-WR stack", playerIds: ["qb", "wr"] },
    { id: "balanced", label: "QB-RB", playerIds: ["qb", "rb"] },
  ], {
    scenarios: 3000,
    seed: 2026,
    schedule,
    week: 1,
    riskAversion: 0.45,
    target: 32,
  });
  assert.equal(result.simulation.scenarios, 3000);
  assert.equal(result.decision.actions.length, 2);
  assert.ok(["stack", "balanced"].includes(result.decision.preferredActionId));
  assert.ok(result.decision.stability >= 0 && result.decision.stability <= 1);
  assert.ok(result.decision.actions.every((row) => row.summary.samples === 3000));
  assert.ok(result.decision.actions.every((row) => row.metadata.concentration > 0));
  assert.equal(Object.hasOwn(result, "samples"), false);
});

test("information value prioritizes missing and conflicted evidence", () => {
  const rows = rankInformationNeeds([
    {
      ...forecasts[0],
      uncertainty: { epistemic: 4, evidenceConflict: 3, availability: 0 },
      evidence: {
        missingFamilies: ["health", "tracking"],
        used: [{ feature: "market.player_points", family: "market", conflict: 0.8 }],
      },
    },
  ]);
  assert.ok(rows.length >= 3);
  assert.equal(rows[0].rank, 1);
  assert.ok(rows.some((row) => row.key === "family:health"));
  assert.ok(rows.some((row) => row.key === "feature:market.player_points"));
});
