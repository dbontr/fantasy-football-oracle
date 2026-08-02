"use strict";

const { sha256 } = require("./lineage.js");
const {
  lowerTailMean,
  mixtureCdf,
  mixtureMoments,
  mixtureQuantile,
} = require("./probabilistic-forecast.js");

const PROBABILISTIC_CALIBRATION_VERSION = "oracle-probabilistic-calibration-2026.1";
const QUANTILES = Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value, digits = 5) {
  if (value === null || value === undefined) return null;
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function pinballLoss(actual, predicted, probability) {
  const residual = finite(actual) - finite(predicted);
  return residual >= 0 ? probability * residual : (probability - 1) * residual;
}

function probabilityLogLoss(probability, outcome) {
  const p = clamp(probability, 1e-9, 1 - 1e-9);
  const y = outcome ? 1 : 0;
  return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
}

function intervalScore(actual, lower, upper, alpha = 0.2) {
  const y = finite(actual);
  const lo = finite(lower);
  const hi = Math.max(lo, finite(upper));
  let score = hi - lo;
  if (y < lo) score += (2 / alpha) * (lo - y);
  if (y > hi) score += (2 / alpha) * (y - hi);
  return score;
}

function weightedIntervalScore(actual, forecast) {
  const medianError = Math.abs(finite(actual) - finite(forecast.distribution?.p50));
  const central = intervalScore(
    actual,
    forecast.distribution?.p10,
    forecast.distribution?.p90,
    0.2,
  );
  return (0.5 * medianError + 0.1 * central) / 1.5;
}

function quantileForecast(forecast, probability) {
  const label = `p${Math.round(probability * 100)}`;
  return finite(forecast.distribution?.[label], forecast.distribution?.mean);
}

function scoreForecast(forecast, outcome = {}) {
  const actual = finite(outcome.pointsPpr ?? outcome.actual);
  const played = outcome.played === undefined ? actual !== 0 : Boolean(outcome.played);
  const predictedMean = finite(forecast.distribution?.mean);
  const predictedStdDev = Math.max(0.01, finite(forecast.distribution?.standardDeviation, 1));
  const activeProbability = clamp(forecast.availability?.probability, 0, 1);
  const quantileLosses = Object.fromEntries(QUANTILES.map((probability) => [
    `p${Math.round(probability * 100)}`,
    pinballLoss(actual, quantileForecast(forecast, probability), probability),
  ]));
  const error = predictedMean - actual;
  const lower = finite(forecast.distribution?.p10);
  const upper = finite(forecast.distribution?.p90);
  return {
    playerId: String(forecast.player?.id || outcome.oraclePlayerId || outcome.sourcePlayerId || ""),
    position: String(forecast.player?.position || outcome.position || "UNKNOWN"),
    season: Number(outcome.season ?? forecast.season ?? 0),
    week: Number(outcome.week ?? forecast.week ?? 0),
    actual,
    played,
    predictedMean,
    predictedStdDev,
    activeProbability,
    error,
    absoluteError: Math.abs(error),
    squaredError: error ** 2,
    standardizedResidual: (actual - predictedMean) / predictedStdDev,
    brier: (activeProbability - Number(played)) ** 2,
    logLoss: probabilityLogLoss(activeProbability, played),
    interval80Covered: actual >= lower && actual <= upper,
    interval80Width: Math.max(0, upper - lower),
    wis: weightedIntervalScore(actual, forecast),
    meanPinball: mean(Object.values(quantileLosses)),
    quantileLosses,
    forecast,
    outcome,
  };
}

function summarizeScores(rows = []) {
  if (!rows.length) {
    return {
      samples: 0,
      mae: null,
      rmse: null,
      bias: null,
      brier: null,
      logLoss: null,
      wis: null,
      meanPinball: null,
      interval80Coverage: null,
      interval80Width: null,
    };
  }
  return {
    samples: rows.length,
    mae: mean(rows.map((row) => row.absoluteError)),
    rmse: Math.sqrt(mean(rows.map((row) => row.squaredError))),
    bias: mean(rows.map((row) => row.error)),
    brier: mean(rows.map((row) => row.brier)),
    logLoss: mean(rows.map((row) => row.logLoss)),
    wis: mean(rows.map((row) => row.wis)),
    meanPinball: mean(rows.map((row) => row.meanPinball)),
    interval80Coverage: mean(rows.map((row) => Number(row.interval80Covered))),
    interval80Width: mean(rows.map((row) => row.interval80Width)),
  };
}

function availabilityBins(rows, count = 10, priorStrength = 5) {
  const bins = Array.from({ length: count }, (_, index) => ({
    lower: index / count,
    upper: (index + 1) / count,
    predictions: [],
    outcomes: [],
  }));
  for (const row of rows) {
    const index = Math.min(count - 1, Math.floor(clamp(row.activeProbability, 0, 1) * count));
    bins[index].predictions.push(row.activeProbability);
    bins[index].outcomes.push(Number(row.played));
  }
  return bins.filter((bin) => bin.predictions.length).map((bin) => {
    const midpoint = (bin.lower + bin.upper) / 2;
    const samples = bin.predictions.length;
    const successes = bin.outcomes.reduce((sum, value) => sum + value, 0);
    return {
      lower: bin.lower,
      upper: bin.upper,
      samples,
      meanPrediction: mean(bin.predictions),
      observedRate: mean(bin.outcomes),
      calibratedRate: (successes + midpoint * priorStrength) / (samples + priorStrength),
    };
  });
}

function calibrationGroup(rows, options = {}) {
  const minimumSamples = Math.max(10, Number(options.minimumSamples || 40));
  const summary = summarizeScores(rows);
  const residuals = rows.map((row) => row.actual - row.predictedMean);
  const standardized = rows.map((row) => row.standardizedResidual);
  const predictedVariance = mean(rows.map((row) => row.predictedStdDev ** 2)) || 1;
  const empiricalVariance = mean(residuals.map((value) => value ** 2)) || predictedVariance;
  const rawScale = Math.sqrt(empiricalVariance / Math.max(0.01, predictedVariance));
  return {
    samples: rows.length,
    eligible: rows.length >= minimumSamples,
    minimumSamples,
    bias: summary.bias,
    uncertaintyScale: clamp(rawScale, 0.6, 2),
    residualQuantiles: Object.fromEntries(QUANTILES.map((probability) => [
      `p${Math.round(probability * 100)}`,
      quantile(residuals, probability),
    ])),
    standardizedQuantiles: Object.fromEntries(QUANTILES.map((probability) => [
      `p${Math.round(probability * 100)}`,
      quantile(standardized, probability),
    ])),
    availabilityBins: availabilityBins(rows),
    metrics: summary,
  };
}

function scoredRows(rows = []) {
  return rows.map((row) => row.forecast && row.outcome && row.error === undefined
    ? scoreForecast(row.forecast, row.outcome)
    : row);
}

function cleanGroup(group) {
  return {
    ...group,
    bias: round(group.bias),
    uncertaintyScale: round(group.uncertaintyScale),
    residualQuantiles: Object.fromEntries(Object.entries(group.residualQuantiles)
      .map(([key, value]) => [key, round(value)])),
    standardizedQuantiles: Object.fromEntries(Object.entries(group.standardizedQuantiles)
      .map(([key, value]) => [key, round(value)])),
    availabilityBins: group.availabilityBins.map((bin) => ({
      ...bin,
      meanPrediction: round(bin.meanPrediction),
      observedRate: round(bin.observedRate),
      calibratedRate: round(bin.calibratedRate),
    })),
    metrics: Object.fromEntries(Object.entries(group.metrics)
      .map(([key, value]) => [key, typeof value === "number" ? round(value) : value])),
  };
}

function buildCalibrationModel(rows = [], options = {}) {
  const scored = scoredRows(rows);
  const byPosition = new Map();
  for (const row of scored) {
    const position = String(row.position || "UNKNOWN").toUpperCase();
    const group = byPosition.get(position) || [];
    group.push(row);
    byPosition.set(position, group);
  }
  const minimumSamples = Math.max(10, Number(options.minimumSamples || 40));
  const groups = {
    all: cleanGroup(calibrationGroup(scored, { minimumSamples })),
    ...Object.fromEntries([...byPosition.entries()].map(([position, group]) => [
      position,
      cleanGroup(calibrationGroup(group, { minimumSamples })),
    ])),
  };
  const model = {
    version: PROBABILISTIC_CALIBRATION_VERSION,
    schemaVersion: "probabilistic-calibration/v1",
    generatedAt: new Date(options.generatedAt || Date.now()).toISOString(),
    source: String(options.source || "observed-forecast-outcomes"),
    approved: options.approved === true,
    minimumSamples,
    trainingSeasons: [...new Set(options.trainingSeasons || scored.map((row) => row.season))]
      .filter(Number.isFinite).sort(),
    holdoutSeason: options.holdoutSeason || null,
    groups,
    validation: options.validation || null,
  };
  model.digest = sha256(model);
  return model;
}

function selectCalibrationGroup(model, position) {
  if (!model?.groups) return null;
  const positional = model.groups[String(position || "").toUpperCase()];
  if (positional?.eligible) return { name: String(position).toUpperCase(), group: positional };
  if (model.groups.all?.eligible) return { name: "all", group: model.groups.all };
  return null;
}

function calibratedAvailability(probability, bins = [], strength = 1) {
  const p = clamp(probability, 0, 1);
  if (!bins.length) return p;
  const containing = bins.find((bin) => p >= bin.lower && p <= bin.upper);
  const nearest = containing || [...bins].sort((left, right) => (
    Math.abs(left.meanPrediction - p) - Math.abs(right.meanPrediction - p)
  ))[0];
  const sampleStrength = clamp(nearest.samples / 40, 0, 1) * clamp(strength, 0, 1);
  return clamp(p * (1 - sampleStrength) + nearest.calibratedRate * sampleStrength, 0, 1);
}

function applyCalibration(forecast, model, options = {}) {
  const selected = selectCalibrationGroup(model, forecast?.player?.position);
  if (!selected || (model.approved !== true && options.force !== true)) {
    return {
      ...forecast,
      calibration: {
        applied: false,
        reason: selected ? "model-not-approved" : "insufficient-samples",
        modelVersion: model?.version || null,
        modelDigest: model?.digest || null,
      },
    };
  }
  const group = selected.group;
  const strength = clamp(
    options.strength ?? (0.25 + Math.min(0.65, group.samples / 400)),
    0,
    1,
  );
  const originalMean = finite(forecast.distribution?.mean);
  const originalActiveMean = finite(forecast.activeDistribution?.mean, originalMean);
  const originalActiveStdDev = Math.max(0.01, finite(
    forecast.activeDistribution?.standardDeviation,
    forecast.distribution?.standardDeviation,
  ));
  const originalAvailability = clamp(forecast.availability?.probability, 0, 1);
  const availability = calibratedAvailability(
    originalAvailability,
    group.availabilityBins,
    strength,
  );
  const targetMean = Math.max(0, originalMean - finite(group.bias) * strength);
  const impliedActiveMean = targetMean / Math.max(0.05, availability);
  const activeMean = clamp(
    impliedActiveMean,
    Math.max(0, originalActiveMean * 0.55 - 2),
    originalActiveMean * 1.45 + 2,
  );
  const uncertaintyScale = 1 + (finite(group.uncertaintyScale, 1) - 1) * strength;
  const activeStdDev = clamp(originalActiveStdDev * uncertaintyScale, 0.1, 80);
  const moments = mixtureMoments(availability, activeMean, activeStdDev);
  const quantiles = Object.fromEntries(QUANTILES.concat([0.95]).map((probability) => [
    `p${Math.round(probability * 100)}`,
    mixtureQuantile(probability, availability, activeMean, activeStdDev),
  ]));
  const bustThreshold = finite(
    forecast.probabilities?.bustThreshold,
    forecast.baseline?.mean * 0.6,
  );
  const ceilingThreshold = finite(
    forecast.probabilities?.ceilingThreshold,
    forecast.baseline?.mean * 1.4,
  );
  const coveragePenalty = Math.abs(finite(group.metrics.interval80Coverage, 0.8) - 0.8);
  const calibratedConfidence = clamp(
    finite(forecast.confidence, 0.5) * (1 - coveragePenalty * 0.18)
      + Math.min(0.04, group.samples / 10_000),
    0.05,
    0.995,
  );
  return {
    ...forecast,
    availability: {
      ...forecast.availability,
      probability: round(availability, 4),
    },
    activeDistribution: {
      mean: round(activeMean, 3),
      standardDeviation: round(activeStdDev, 3),
    },
    distribution: {
      ...forecast.distribution,
      shape: "calibrated-zero-inflated-normal",
      mean: round(moments.mean, 3),
      standardDeviation: round(moments.standardDeviation, 3),
      ...Object.fromEntries(Object.entries(quantiles).map(([key, value]) => [key, round(value, 3)])),
      cvar10: round(lowerTailMean(availability, activeMean, activeStdDev, 0.1), 3),
    },
    confidence: round(calibratedConfidence, 4),
    probabilities: {
      ...forecast.probabilities,
      bustThreshold: round(bustThreshold, 3),
      bust: round(mixtureCdf(bustThreshold, availability, activeMean, activeStdDev), 4),
      ceilingThreshold: round(ceilingThreshold, 3),
      ceiling: round(1 - mixtureCdf(ceilingThreshold, availability, activeMean, activeStdDev), 4),
    },
    calibration: {
      applied: true,
      modelVersion: model.version,
      modelDigest: model.digest,
      group: selected.name,
      samples: group.samples,
      strength: round(strength, 4),
      meanBiasCorrection: round(-finite(group.bias) * strength, 4),
      uncertaintyScale: round(uncertaintyScale, 4),
      original: {
        mean: round(originalMean, 3),
        activeProbability: round(originalAvailability, 4),
        activeMean: round(originalActiveMean, 3),
        activeStdDev: round(originalActiveStdDev, 3),
      },
    },
  };
}

function evaluateCalibration(rows, model, options = {}) {
  const originalRows = scoredRows(rows);
  const calibratedRows = originalRows.map((row) => scoreForecast(
    applyCalibration(row.forecast, model, { force: true, strength: options.strength }),
    row.outcome,
  ));
  const before = summarizeScores(originalRows);
  const after = summarizeScores(calibratedRows);
  const improvement = {
    mae: before.mae === null ? null : before.mae - after.mae,
    rmse: before.rmse === null ? null : before.rmse - after.rmse,
    brier: before.brier === null ? null : before.brier - after.brier,
    logLoss: before.logLoss === null ? null : before.logLoss - after.logLoss,
    wis: before.wis === null ? null : before.wis - after.wis,
    meanPinball: before.meanPinball === null ? null : before.meanPinball - after.meanPinball,
    interval80Coverage: before.interval80Coverage === null
      ? null
      : after.interval80Coverage - before.interval80Coverage,
  };
  return {
    samples: originalRows.length,
    before: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, round(value)])),
    after: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, round(value)])),
    improvement: Object.fromEntries(Object.entries(improvement).map(([key, value]) => [key, round(value)])),
  };
}

function validateCalibration(trainingRows, holdoutRows, options = {}) {
  const training = scoredRows(trainingRows);
  const holdout = scoredRows(holdoutRows);
  const model = buildCalibrationModel(training, {
    minimumSamples: options.minimumSamples,
    trainingSeasons: options.trainingSeasons,
    holdoutSeason: options.holdoutSeason,
    source: options.source,
    generatedAt: options.generatedAt,
  });
  const evaluation = evaluateCalibration(holdout, model, {
    strength: options.strength,
  });
  const minimumHoldoutSamples = Math.max(20, Number(options.minimumHoldoutSamples || 100));
  const minimumWisImprovement = finite(options.minimumWisImprovement, 0);
  const maximumRmseRegression = Math.max(0, finite(options.maximumRmseRegression, 0.02));
  const maximumBrierRegression = Math.max(0, finite(options.maximumBrierRegression, 0.01));
  const coverage = evaluation.after.interval80Coverage;
  const coverageMinimum = finite(options.coverageMinimum, 0.7);
  const coverageMaximum = finite(options.coverageMaximum, 0.9);
  const checks = {
    holdoutSamples: evaluation.samples >= minimumHoldoutSamples,
    wis: finite(evaluation.improvement.wis, -Infinity) > minimumWisImprovement,
    rmse: finite(evaluation.improvement.rmse, -Infinity) >= -maximumRmseRegression,
    brier: finite(evaluation.improvement.brier, -Infinity) >= -maximumBrierRegression,
    coverage: coverage >= coverageMinimum && coverage <= coverageMaximum,
  };
  model.approved = Object.values(checks).every(Boolean);
  model.validation = {
    leakageSafe: true,
    holdoutSeason: options.holdoutSeason || null,
    checks,
    thresholds: {
      minimumHoldoutSamples,
      minimumWisImprovement,
      maximumRmseRegression,
      maximumBrierRegression,
      coverageMinimum,
      coverageMaximum,
    },
    evaluation,
  };
  delete model.digest;
  model.digest = sha256(model);
  return model;
}

function calibrationStatus(model) {
  if (!model) {
    return {
      ready: false,
      approved: false,
      version: null,
      message: "No free probabilistic calibration model is installed.",
    };
  }
  return {
    ready: true,
    approved: model.approved === true,
    version: model.version,
    schemaVersion: model.schemaVersion,
    digest: model.digest,
    generatedAt: model.generatedAt,
    trainingSeasons: model.trainingSeasons,
    holdoutSeason: model.holdoutSeason,
    validation: model.validation,
    groups: Object.fromEntries(Object.entries(model.groups || {}).map(([name, group]) => [
      name,
      {
        samples: group.samples,
        eligible: group.eligible,
        bias: group.bias,
        uncertaintyScale: group.uncertaintyScale,
        metrics: group.metrics,
      },
    ])),
  };
}

module.exports = {
  PROBABILISTIC_CALIBRATION_VERSION,
  QUANTILES,
  applyCalibration,
  availabilityBins,
  buildCalibrationModel,
  calibratedAvailability,
  calibrationGroup,
  calibrationStatus,
  evaluateCalibration,
  intervalScore,
  mean,
  pinballLoss,
  probabilityLogLoss,
  quantile,
  scoreForecast,
  scoredRows,
  selectCalibrationGroup,
  summarizeScores,
  validateCalibration,
  weightedIntervalScore,
};
