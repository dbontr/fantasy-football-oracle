"use strict";

const { sha256 } = require("./lineage.js");
const {
  lowerTailMean,
  mixtureCdf,
  mixtureMoments,
  mixtureQuantile,
} = require("./probabilistic-forecast.js");
const {
  scoreForecast,
  summarizeScores,
  validateCalibration,
} = require("./probabilistic-calibration.js");

const FREE_WALK_FORWARD_VERSION = "oracle-free-walk-forward-2026.1";
const POSITION_PRIORS = Object.freeze({
  QB: { mean: 17, standardDeviation: 7 },
  RB: { mean: 10, standardDeviation: 8 },
  WR: { mean: 9, standardDeviation: 8 },
  TE: { mean: 7, standardDeviation: 6 },
  K: { mean: 8, standardDeviation: 4 },
});

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

function weightedMean(rows, accessor, decay = 0.82) {
  if (!rows.length) return null;
  let total = 0;
  let weightTotal = 0;
  rows.slice().reverse().forEach((row, index) => {
    const weight = decay ** index;
    total += finite(accessor(row)) * weight;
    weightTotal += weight;
  });
  return weightTotal > 0 ? total / weightTotal : null;
}

function standardDeviation(values, fallback = 1) {
  if (values.length < 2) return fallback;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function historyKey(row) {
  return String(row.sourcePlayerId || row.oraclePlayerId || row.name || "unknown");
}

function timelineKey(row) {
  return Number(row.season) * 100 + Number(row.week);
}

function activeRows(rows) {
  return rows.filter((row) => row.played === true);
}

function positionPrior(position, history = []) {
  const prior = POSITION_PRIORS[position] || { mean: 8, standardDeviation: 7 };
  const played = activeRows(history).slice(-600);
  if (played.length < 20) return { ...prior, samples: played.length };
  const points = played.map((row) => finite(row.pointsPpr));
  return {
    mean: weightedMean(played.slice(-240), (row) => row.pointsPpr, 0.985),
    standardDeviation: clamp(standardDeviation(points, prior.standardDeviation), 2, 18),
    samples: played.length,
  };
}

function availabilityPrior(history = []) {
  if (!history.length) return { probability: 0.92, samples: 0 };
  const recent = history.slice(-18);
  const successes = recent.reduce((sum, row) => sum + Number(row.played), 0);
  return {
    probability: (successes + 4.5) / (recent.length + 5),
    samples: recent.length,
  };
}

function playerPointPrior(history = [], position = "UNKNOWN") {
  const prior = POSITION_PRIORS[position] || { mean: 8, standardDeviation: 7 };
  const played = activeRows(history).slice(-16);
  if (!played.length) {
    return { mean: prior.mean, standardDeviation: prior.standardDeviation, samples: 0 };
  }
  const points = played.map((row) => finite(row.pointsPpr));
  return {
    mean: weightedMean(played, (row) => row.pointsPpr, 0.84),
    standardDeviation: clamp(standardDeviation(points, prior.standardDeviation), 1.5, 20),
    samples: played.length,
  };
}

function opportunityPrior(history = []) {
  const played = activeRows(history).filter((row) => finite(row.opportunities) > 0).slice(-12);
  if (!played.length) return { opportunities: null, efficiency: null, samples: 0 };
  const opportunities = weightedMean(played, (row) => row.opportunities, 0.84);
  const totalOpportunities = played.reduce((sum, row) => sum + finite(row.opportunities), 0);
  const totalPoints = played.reduce((sum, row) => sum + finite(row.pointsPpr), 0);
  return {
    opportunities,
    efficiency: totalOpportunities > 0 ? totalPoints / totalOpportunities : null,
    samples: played.length,
  };
}

function recentTrend(history = []) {
  const played = activeRows(history).slice(-8);
  if (played.length < 5) return 0;
  const recent = mean(played.slice(-3).map((row) => row.pointsPpr));
  const earlier = mean(played.slice(0, -3).map((row) => row.pointsPpr));
  return clamp((recent - earlier) * 0.18, -3, 3);
}

function activeMeanEstimate(playerHistory, positionHistory, position) {
  const player = playerPointPrior(playerHistory, position);
  const positional = positionPrior(position, positionHistory);
  const opportunity = opportunityPrior(playerHistory);
  const shrinkage = player.samples / (player.samples + 5);
  let estimate = player.mean * shrinkage + positional.mean * (1 - shrinkage);
  if (opportunity.samples >= 3 && opportunity.opportunities > 0 && opportunity.efficiency > 0) {
    const opportunityEstimate = opportunity.opportunities * opportunity.efficiency;
    estimate = estimate * 0.82 + opportunityEstimate * 0.18;
  }
  estimate += recentTrend(playerHistory);
  return {
    mean: clamp(estimate, 0, 60),
    player,
    positional,
    opportunity,
    shrinkage,
  };
}

function activeStdDevEstimate(playerHistory, positionHistory, position, activeMean) {
  const player = playerPointPrior(playerHistory, position);
  const positional = positionPrior(position, positionHistory);
  const shrinkage = player.samples / (player.samples + 8);
  const variance = player.standardDeviation ** 2 * shrinkage
    + positional.standardDeviation ** 2 * (1 - shrinkage);
  return clamp(Math.sqrt(variance), Math.max(1.5, activeMean * 0.12), 24);
}

function historicalForecast(row, playerHistory, positionHistory, options = {}) {
  const position = String(row.position || "UNKNOWN").toUpperCase();
  const availability = availabilityPrior(playerHistory);
  const active = activeMeanEstimate(playerHistory, positionHistory, position);
  const activeStdDev = activeStdDevEstimate(
    playerHistory,
    positionHistory,
    position,
    active.mean,
  );
  const moments = mixtureMoments(availability.probability, active.mean, activeStdDev);
  const quantiles = Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((probability) => [
    `p${Math.round(probability * 100)}`,
    mixtureQuantile(probability, availability.probability, active.mean, activeStdDev),
  ]));
  const confidence = clamp(
    0.32
      + Math.min(0.34, playerHistory.length * 0.025)
      + Math.min(0.16, active.positional.samples / 600)
      + availability.samples * 0.005,
    0.25,
    0.9,
  );
  const asOf = options.asOf || `${row.season}-W${String(row.week).padStart(2, "0")}-PRE`;
  const bustThreshold = moments.mean * 0.6;
  const ceilingThreshold = moments.mean * 1.4;
  return {
    schemaVersion: "probabilistic-forecast/v1",
    version: FREE_WALK_FORWARD_VERSION,
    season: row.season,
    week: row.week,
    asOf,
    generatedAt: options.generatedAt || new Date(0).toISOString(),
    player: {
      id: row.sourcePlayerId,
      name: row.name,
      position,
      team: row.team,
    },
    baseline: {
      mean: moments.mean,
      standardDeviation: moments.standardDeviation,
      availability: availability.probability,
      reliability: confidence,
      bye: false,
    },
    availability: {
      probability: availability.probability,
      confidence,
      drivers: [],
    },
    activeDistribution: {
      mean: active.mean,
      standardDeviation: activeStdDev,
    },
    distribution: {
      shape: "walk-forward-zero-inflated-normal",
      mean: moments.mean,
      standardDeviation: moments.standardDeviation,
      ...quantiles,
      cvar10: lowerTailMean(
        availability.probability,
        active.mean,
        activeStdDev,
        0.1,
      ),
    },
    confidence,
    uncertainty: {
      aleatoric: activeStdDev,
      epistemic: activeStdDev * (1 - confidence),
      availability: Math.sqrt(
        availability.probability * (1 - availability.probability),
      ) * active.mean,
      evidenceConflict: 0,
    },
    evidence: {
      coverage: 0,
      confidence: 0,
      conflict: 0,
      used: [],
      missingFamilies: ["market", "health", "environment", "matchup"],
    },
    contributions: [],
    probabilities: {
      bustThreshold,
      bust: mixtureCdf(
        bustThreshold,
        availability.probability,
        active.mean,
        activeStdDev,
      ),
      ceilingThreshold,
      ceiling: 1 - mixtureCdf(
        ceilingThreshold,
        availability.probability,
        active.mean,
        activeStdDev,
      ),
    },
    modelInputs: {
      playerHistorySamples: playerHistory.length,
      positionHistorySamples: positionHistory.length,
      playerActiveSamples: active.player.samples,
      positionActiveSamples: active.positional.samples,
      opportunitySamples: active.opportunity.samples,
      shrinkage: active.shrinkage,
      cutoff: `${row.season}:${row.week - 1}`,
    },
    warnings: [],
  };
}

function eligibleOutcome(row, options = {}) {
  if (!row || !Number.isInteger(Number(row.season)) || !Number.isInteger(Number(row.week))) {
    return false;
  }
  if (!row.sourcePlayerId || !row.position) return false;
  if (options.positions && !options.positions.includes(String(row.position).toUpperCase())) return false;
  return true;
}

function runWalkForward(outcomes = [], options = {}) {
  const rows = outcomes
    .filter((row) => eligibleOutcome(row, options))
    .map((row) => ({ ...row, season: Number(row.season), week: Number(row.week) }))
    .sort((left, right) => (
      timelineKey(left) - timelineKey(right)
      || historyKey(left).localeCompare(historyKey(right))
    ));
  const playerHistory = new Map();
  const positionHistory = new Map();
  const scoreRows = [];
  const forecasts = [];
  const warmup = Math.max(0, Number(options.minimumPlayerHistory || 2));
  let index = 0;
  while (index < rows.length) {
    const timeline = timelineKey(rows[index]);
    const batch = [];
    while (index < rows.length && timelineKey(rows[index]) === timeline) {
      batch.push(rows[index]);
      index += 1;
    }
    for (const row of batch) {
      const playerRows = playerHistory.get(historyKey(row)) || [];
      const positionRows = positionHistory.get(String(row.position).toUpperCase()) || [];
      if (playerRows.length < warmup && positionRows.length < 30) continue;
      const forecast = historicalForecast(row, playerRows, positionRows, {
        generatedAt: options.generatedAt,
      });
      forecasts.push(forecast);
      scoreRows.push(scoreForecast(forecast, row));
    }
    for (const row of batch) {
      const playerKey = historyKey(row);
      const positionKey = String(row.position).toUpperCase();
      const playerRows = playerHistory.get(playerKey) || [];
      playerRows.push(row);
      playerHistory.set(playerKey, playerRows);
      const positionRows = positionHistory.get(positionKey) || [];
      positionRows.push(row);
      positionHistory.set(positionKey, positionRows);
    }
  }
  return {
    version: FREE_WALK_FORWARD_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    outcomes: rows.length,
    forecasts: forecasts.length,
    forecastRows: forecasts,
    scoreRows,
    summary: summarizeScores(scoreRows),
    coverage: rows.length ? forecasts.length / rows.length : 0,
    seasons: [...new Set(rows.map((row) => row.season))].sort(),
  };
}

function backtestFreeCalibration(outcomes = [], options = {}) {
  const seasons = [...new Set(outcomes.map((row) => Number(row.season)))]
    .filter(Number.isFinite)
    .sort();
  if (seasons.length < 2) {
    throw new RangeError("Free calibration backtest requires at least two seasons");
  }
  const holdoutSeason = Number(options.holdoutSeason || seasons.at(-1));
  const generatedAt = options.generatedAt || new Date().toISOString();
  const walkForward = runWalkForward(outcomes, {
    minimumPlayerHistory: options.minimumPlayerHistory,
    positions: options.positions,
    generatedAt,
  });
  const trainingRows = walkForward.scoreRows.filter((row) => row.season < holdoutSeason);
  const holdoutRows = walkForward.scoreRows.filter((row) => row.season === holdoutSeason);
  if (!trainingRows.length || !holdoutRows.length) {
    throw new RangeError("Free calibration backtest has insufficient chronological rows");
  }
  const calibration = validateCalibration(trainingRows, holdoutRows, {
    minimumSamples: options.minimumSamples || 80,
    minimumHoldoutSamples: options.minimumHoldoutSamples || 200,
    minimumWisImprovement: options.minimumWisImprovement ?? 0,
    maximumRmseRegression: options.maximumRmseRegression ?? 0.05,
    maximumBrierRegression: options.maximumBrierRegression ?? 0.015,
    coverageMinimum: options.coverageMinimum ?? 0.67,
    coverageMaximum: options.coverageMaximum ?? 0.93,
    strength: options.strength,
    trainingSeasons: seasons.filter((season) => season < holdoutSeason),
    holdoutSeason,
    source: "nflverse-weekly-stats-walk-forward",
    generatedAt,
  });
  const result = {
    version: FREE_WALK_FORWARD_VERSION,
    generatedAt,
    seasons,
    trainingSeasons: seasons.filter((season) => season < holdoutSeason),
    holdoutSeason,
    outcomes: walkForward.outcomes,
    forecasts: walkForward.forecasts,
    coverage: walkForward.coverage,
    overall: walkForward.summary,
    training: summarizeScores(trainingRows),
    holdout: summarizeScores(holdoutRows),
    calibration,
    leakageControls: [
      "Each player-week forecast is generated before any outcome from that week is appended.",
      "The final season is excluded from calibration fitting and used only as a holdout.",
      "Only prior player and position outcomes are included in model inputs.",
      "Historical free-source outcomes are separated from the 2026 live identity requirement.",
    ],
    limitations: [
      "The walk-forward bootstrap uses nflverse fantasy outcomes and opportunity counts, not historical betting markets or injury reports.",
      "Players absent from weekly source rows may be underrepresented in availability calibration.",
      "The bootstrap is an initialization prior; production forecast-journal outcomes should supersede it as samples accumulate.",
    ],
  };
  result.digest = sha256({
    version: result.version,
    seasons: result.seasons,
    holdoutSeason: result.holdoutSeason,
    outcomes: result.outcomes,
    forecasts: result.forecasts,
    calibrationDigest: calibration.digest,
  });
  return result;
}

module.exports = {
  FREE_WALK_FORWARD_VERSION,
  POSITION_PRIORS,
  activeMeanEstimate,
  activeRows,
  activeStdDevEstimate,
  availabilityPrior,
  backtestFreeCalibration,
  eligibleOutcome,
  historicalForecast,
  historyKey,
  opportunityPrior,
  playerPointPrior,
  positionPrior,
  recentTrend,
  runWalkForward,
  standardDeviation,
  timelineKey,
  weightedMean,
};
