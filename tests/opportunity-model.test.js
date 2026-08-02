"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const opportunityData = require("../data/opportunity-2026.json");
const {
  OPPORTUNITY_MODEL_VERSION,
  applyOpportunityIntelligence,
  opportunitySummary,
  profileForPlayer,
} = require("../server/opportunity-model.js");
const { applyProjectionModel } = require("../server/projection-model.js");

test("opportunity data is leakage-safe and improves the untouched holdout", () => {
  assert.equal(OPPORTUNITY_MODEL_VERSION, "oracle-opportunity-2026.1");
  assert.ok(opportunityData.meta.coverage >= 500);
  assert.equal(opportunityData.meta.holdoutSeason, 2025);
  assert.ok(opportunityData.meta.leakageControls.length >= 4);
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const diagnostics = opportunityData.diagnostics.byPosition[position];
    assert.ok(diagnostics.holdoutSamples >= 25);
    assert.ok(diagnostics.model.rmse < diagnostics.priorSeasonBaseline.rmse);
    assert.ok(diagnostics.model.correlation > diagnostics.priorSeasonBaseline.correlation);
  }
});

test("opportunity adjustments remain centered, bounded, and two-sided", () => {
  const modeled = applyOpportunityIntelligence(bundled.players);
  const adjusted = modeled.players.filter((player) => player.opportunityContext);
  assert.ok(adjusted.length >= 400);
  assert.ok(Math.abs(modeled.summary.meanFactor - 1) < 0.001);
  assert.ok(adjusted.some((player) => player.opportunityContext.meanFactor > 1.005));
  assert.ok(adjusted.some((player) => player.opportunityContext.meanFactor < 0.995));
  assert.ok(adjusted.every((player) => player.opportunityContext.meanFactor >= 0.96));
  assert.ok(adjusted.every((player) => player.opportunityContext.meanFactor <= 1.04));
  assert.ok(adjusted.every((player) => player.opportunityContext.drivers.length > 0));
});

test("profiles expose usage, regression, and age-curve evidence", () => {
  const profile = profileForPlayer({ id: "4362628", name: "Ja'Marr Chase" });
  assert.equal(profile.position, "WR");
  assert.ok(profile.weightedOpportunityPerGame > 0);
  assert.ok(profile.teamOpportunityShare > 0);
  assert.ok(profile.volumeStability >= 0 && profile.volumeStability <= 1);
  assert.equal(profile.analogs.sampleSize, 16);
  assert.ok(profile.analogs.p90 > profile.analogs.p10);
  assert.ok(profile.analogs.comparables.length >= 3);
  assert.ok(opportunityData.productionModels.WR.featureNames.includes("age"));
  const summary = opportunitySummary();
  assert.equal(summary.holdoutSeason, 2025);
  assert.ok(summary.diagnostics.overall.rmseImprovement > 0.1);
});

test("projection ensemble carries opportunity evidence into decision intelligence", () => {
  const dataset = applyProjectionModel(bundled);
  assert.equal(dataset.meta.opportunityVersion, OPPORTUNITY_MODEL_VERSION);
  assert.equal(dataset.opportunity.version, OPPORTUNITY_MODEL_VERSION);
  const player = dataset.players.find((row) => row.opportunityContext);
  assert.ok(player);
  assert.ok(player.projectionModel.components.includes("historical-opportunity"));
  assert.ok(player.projectionModel.components.includes("usage-regression"));
  assert.ok(player.decisionIntelligence.opportunity.historical);
  assert.ok(player.opportunityContext.analogs.comparables.length >= 3);
  assert.ok(Number.isFinite(player.decisionIntelligence.risk.uncertainty.opportunity));
});
