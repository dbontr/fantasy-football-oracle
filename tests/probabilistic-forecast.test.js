"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const { EvidenceStore } = require("../server/evidence-store.js");
const { applyProjectionModel } = require("../server/projection-model.js");
const {
  forecastPlayer,
  mixtureCdf,
  mixtureQuantile,
} = require("../server/probabilistic-forecast.js");

const NOW = "2026-08-02T17:00:00.000Z";
const modeled = applyProjectionModel(sourceDataset);
const player = modeled.players.find((row) => row.position === "WR" && row.weeklyProjections[0] > 0);

async function createStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-forecast-"));
  const store = new EvidenceStore({
    filePath: path.join(directory, "evidence.jsonl"),
    clock: () => Date.parse(NOW),
  });
  await store.initialize();
  return { directory, store };
}
async function cleanup(context) {
  await context.store.stop();
  await fs.rm(context.directory, { recursive: true, force: true });
}

function evidence(feature, value, overrides = {}) {
  return {
    entityType: "player",
    entityId: String(player.id),
    feature,
    value,
    source: { name: "test-source", reliability: 0.95 },
    confidence: 0.95,
    observedAt: "2026-08-02T16:00:00.000Z",
    ...overrides,
  };
}

test("mixture distribution functions preserve probability ordering", () => {
  const p10 = mixtureQuantile(0.1, 0.9, 15, 5);
  const p50 = mixtureQuantile(0.5, 0.9, 15, 5);
  const p90 = mixtureQuantile(0.9, 0.9, 15, 5);
  assert.ok(p10 <= p50 && p50 <= p90);
  assert.ok(mixtureCdf(p10, 0.9, 15, 5) >= 0.09);
  assert.ok(mixtureCdf(p90, 0.9, 15, 5) >= 0.89);
});

test("baseline probabilistic forecast is finite, ordered, and non-negative", async () => {
  const context = await createStore();
  try {
    const forecast = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    const distribution = forecast.distribution;
    assert.ok(distribution.mean > 0);
    assert.ok(distribution.standardDeviation > 0);
    assert.ok(distribution.p10 <= distribution.p25);
    assert.ok(distribution.p25 <= distribution.p50);
    assert.ok(distribution.p50 <= distribution.p75);
    assert.ok(distribution.p75 <= distribution.p90);
    assert.ok(distribution.p90 <= distribution.p95);
    assert.ok(distribution.cvar10 <= distribution.p10);
    assert.ok(forecast.confidence > 0 && forecast.confidence <= 1);
    assert.equal(forecast.player.id, String(player.id));
  } finally {
    await cleanup(context);
  }
});

test("strong market and role evidence raises the active forecast", async () => {
  const context = await createStore();
  try {
    const baseline = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    await context.store.ingestMany([
      evidence("market.player_points", baseline.baseline.mean + 8),
      evidence("role.target_share", 0.36),
      evidence("role.route_share", 0.92),
    ]);
    const upgraded = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    assert.ok(upgraded.activeDistribution.mean > baseline.activeDistribution.mean + 2);
    assert.ok(upgraded.distribution.mean > baseline.distribution.mean);
    assert.ok(upgraded.contributions.some((row) => row.feature === "market.player_points"));
    assert.ok(upgraded.evidence.coverage > baseline.evidence.coverage);
  } finally {
    await cleanup(context);
  }
});

test("availability evidence creates a zero-heavy downside distribution", async () => {
  const context = await createStore();
  try {
    const baseline = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    await context.store.ingestMany([
      evidence("health.active_probability", 0.2),
      evidence("availability.designation", "out", {
        source: { name: "official", reliability: 1 },
        confidence: 1,
      }),
    ]);
    const unavailable = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    assert.ok(unavailable.availability.probability < 0.25);
    assert.equal(unavailable.distribution.p50, 0);
    assert.ok(unavailable.distribution.mean < baseline.distribution.mean * 0.4);
    assert.ok(unavailable.uncertainty.availability > 0);
  } finally {
    await cleanup(context);
  }
});

test("conflicting sources widen epistemic uncertainty", async () => {
  const consistent = await createStore();
  const conflicting = await createStore();
  try {
    await consistent.store.ingestMany([
      evidence("market.player_points", 20, { source: { name: "a", reliability: 1 } }),
      evidence("market.player_points", 20, { source: { name: "b", reliability: 1 } }),
    ]);
    await conflicting.store.ingestMany([
      evidence("market.player_points", 10, { source: { name: "a", reliability: 1 } }),
      evidence("market.player_points", 30, { source: { name: "b", reliability: 1 } }),
    ]);
    const stable = forecastPlayer(player, consistent.store, { week: 1, asOf: NOW });
    const disputed = forecastPlayer(player, conflicting.store, { week: 1, asOf: NOW });
    assert.ok(disputed.evidence.conflict > stable.evidence.conflict);
    assert.ok(disputed.uncertainty.epistemic > stable.uncertainty.epistemic);
    assert.ok(disputed.activeDistribution.standardDeviation > stable.activeDistribution.standardDeviation);
  } finally {
    await cleanup(consistent);
    await cleanup(conflicting);
  }
});
test("future evidence cannot leak into an earlier forecast", async () => {
  const context = await createStore();
  try {
    await context.store.append(evidence("market.player_points", 50, {
      observedAt: "2026-08-03T16:00:00.000Z",
    }));
    const historical = forecastPlayer(player, context.store, { week: 1, asOf: NOW });
    const future = forecastPlayer(player, context.store, {
      week: 1,
      asOf: "2026-08-03T17:00:00.000Z",
    });
    assert.equal(historical.evidence.used.some(
      (row) => row.feature === "market.player_points",
    ), false);
    assert.ok(future.activeDistribution.mean > historical.activeDistribution.mean);
  } finally {
    await cleanup(context);
  }
});
