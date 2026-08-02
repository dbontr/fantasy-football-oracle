"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyCalibration,
  buildCalibrationModel,
  scoreForecast,
  summarizeScores,
  validateCalibration,
  weightedIntervalScore,
} = require("../server/probabilistic-calibration.js");
const {
  lowerTailMean,
  mixtureMoments,
  mixtureQuantile,
} = require("../server/probabilistic-forecast.js");

function fixtureForecast(index, season = 2024) {
  const position = index % 2 ? "WR" : "RB";
  const latent = 12 + (index % 7) * 0.5;
  const availability = 0.95;
  const predictedMean = latent + 2.4;
  const activeMean = predictedMean / availability;
  const activeStdDev = 2.5;
  const moments = mixtureMoments(availability, activeMean, activeStdDev);
  const distribution = {
    shape: "zero-inflated-normal",
    mean: moments.mean,
    standardDeviation: moments.standardDeviation,
    p10: mixtureQuantile(0.1, availability, activeMean, activeStdDev),
    p25: mixtureQuantile(0.25, availability, activeMean, activeStdDev),
    p50: mixtureQuantile(0.5, availability, activeMean, activeStdDev),
    p75: mixtureQuantile(0.75, availability, activeMean, activeStdDev),
    p90: mixtureQuantile(0.9, availability, activeMean, activeStdDev),
    p95: mixtureQuantile(0.95, availability, activeMean, activeStdDev),
    cvar10: lowerTailMean(availability, activeMean, activeStdDev, 0.1),
  };
  return {
    schemaVersion: "probabilistic-forecast/v1",
    version: "fixture",
    season,
    week: index % 17 + 1,
    player: { id: `p${index % 40}`, position, name: `Player ${index}`, team: "DET" },
    baseline: { mean: latent, reliability: 0.75 },
    availability: { probability: availability, confidence: 0.8 },
    activeDistribution: { mean: activeMean, standardDeviation: activeStdDev },
    distribution,
    probabilities: { bustThreshold: latent * 0.6, ceilingThreshold: latent * 1.4 },
    confidence: 0.75,
  };
}

function fixtureRow(index, season = 2024) {
  const forecast = fixtureForecast(index, season);
  const noise = [-3, -2, -1, 0, 1, 2, 3][index % 7];
  const latent = forecast.baseline.mean;
  return {
    forecast,
    outcome: {
      season,
      week: forecast.week,
      oraclePlayerId: forecast.player.id,
      position: forecast.player.position,
      pointsPpr: Math.max(0, latent + noise),
      played: true,
    },
  };
}

test("probabilistic score exposes proper and interval metrics", () => {
  const row = fixtureRow(3);
  const score = scoreForecast(row.forecast, row.outcome);
  assert.ok(score.absoluteError > 0);
  assert.ok(score.squaredError > 0);
  assert.ok(score.brier >= 0 && score.brier <= 1);
  assert.ok(score.logLoss > 0);
  assert.ok(score.wis >= 0);
  assert.ok(score.meanPinball >= 0);
  assert.equal(typeof score.interval80Covered, "boolean");
  assert.equal(
    weightedIntervalScore(row.outcome.pointsPpr, row.forecast),
    score.wis,
  );
});

test("calibration model learns position-specific bias and uncertainty", () => {
  const rows = Array.from({ length: 200 }, (_, index) => fixtureRow(index));
  const model = buildCalibrationModel(rows, { minimumSamples: 40 });
  assert.equal(model.groups.RB.eligible, true);
  assert.equal(model.groups.WR.eligible, true);
  assert.ok(model.groups.RB.bias > 1.5);
  assert.ok(model.groups.RB.samples >= 90);
  assert.equal(model.digest.length, 64);

  const original = rows[0].forecast;
  const calibrated = applyCalibration(original, { ...model, approved: true });
  assert.equal(calibrated.calibration.applied, true);
  assert.ok(calibrated.distribution.mean < original.distribution.mean);
  assert.ok(calibrated.distribution.p10 <= calibrated.distribution.p50);
  assert.ok(calibrated.distribution.p50 <= calibrated.distribution.p90);
});

test("chronological holdout approves only improving calibration", () => {
  const training = Array.from({ length: 240 }, (_, index) => fixtureRow(index, 2024));
  const holdout = Array.from({ length: 140 }, (_, index) => fixtureRow(index + 500, 2025));
  const model = validateCalibration(training, holdout, {
    minimumSamples: 40,
    minimumHoldoutSamples: 100,
    trainingSeasons: [2024],
    holdoutSeason: 2025,
    coverageMinimum: 0.68,
    coverageMaximum: 0.92,
  });
  assert.equal(model.validation.leakageSafe, true);
  assert.equal(model.validation.holdoutSeason, 2025);
  assert.equal(model.validation.checks.holdoutSamples, true);
  assert.equal(model.validation.checks.wis, true);
  assert.equal(model.approved, true, JSON.stringify(model.validation, null, 2));
  assert.ok(model.validation.evaluation.after.wis < model.validation.evaluation.before.wis);
  assert.ok(model.validation.evaluation.after.rmse < model.validation.evaluation.before.rmse);
});

test("calibration remains inactive without approval or enough samples", () => {
  const rows = Array.from({ length: 8 }, (_, index) => fixtureRow(index));
  const model = buildCalibrationModel(rows, { minimumSamples: 40 });
  const result = applyCalibration(rows[0].forecast, model);
  assert.equal(result.calibration.applied, false);
  assert.equal(result.calibration.reason, "insufficient-samples");

  const eligible = buildCalibrationModel(
    Array.from({ length: 100 }, (_, index) => fixtureRow(index)),
    { minimumSamples: 40 },
  );
  const unapproved = applyCalibration(rows[0].forecast, eligible);
  assert.equal(unapproved.calibration.applied, false);
  assert.equal(unapproved.calibration.reason, "model-not-approved");
});

test("score summaries are finite and directionally interpretable", () => {
  const scores = Array.from({ length: 30 }, (_, index) => {
    const row = fixtureRow(index);
    return scoreForecast(row.forecast, row.outcome);
  });
  const summary = summarizeScores(scores);
  assert.equal(summary.samples, 30);
  assert.ok(summary.mae > 0);
  assert.ok(summary.rmse >= summary.mae);
  assert.ok(summary.bias > 0);
  assert.ok(summary.interval80Coverage >= 0 && summary.interval80Coverage <= 1);
});
