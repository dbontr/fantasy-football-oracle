#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { forEachCsvRow } = require("./lib/csv.js");

const ROOT = path.resolve(__dirname, "..");
const MODEL_VERSION = "oracle-opportunity-2026.1";
const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE"]);
const HOLDOUT_SEASON = 2025;
const RIDGE_GRID = Object.freeze([0.1, 0.5, 1, 2, 5, 10, 20, 40, 100]);
const FEATURE_NAMES = Object.freeze({
  QB: ["priorPpg", "attemptsPerGame", "carriesPerGame", "yardsPerAttempt", "cpoe", "usageCv", "usageTrend", "age", "experience"],
  RB: ["priorPpg", "carriesPerGame", "targetsPerGame", "targetShare", "yardsPerCarry", "yardsPerTarget", "usageCv", "usageTrend", "age", "experience"],
  WR: ["priorPpg", "targetsPerGame", "targetShare", "airYardsShare", "wopr", "catchRate", "yardsPerTarget", "usageCv", "usageTrend", "age", "experience"],
  TE: ["priorPpg", "targetsPerGame", "targetShare", "airYardsShare", "wopr", "catchRate", "yardsPerTarget", "usageCv", "usageTrend", "age", "experience"],
});

function parseArgs(argv) {
  const args = { season: 2026 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--season" && argv[index + 1]) {
      args.season = Number(argv[++index]);
    } else if (value === "--history-root" && argv[index + 1]) {
      args.historyRoot = argv[++index];
    } else if (value === "--out" && argv[index + 1]) {
      args.out = argv[++index];
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function printHelp() {
  console.log([
    "Build leakage-safe opportunity and usage profiles from nflverse weekly data.",
    "",
    "Usage:",
    "  node scripts/build-opportunity-profiles.js --season 2026 --history-root <raw-data-dir>",
    "",
    "The history root must contain nflverse_players.csv and stats_player_week_2020.csv through 2025.",
  ].join("\n"));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function correlation(left, right) {
  if (left.length < 2 || left.length !== right.length) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - leftMean;
    const y = right[index] - rightMean;
    numerator += x * y;
    leftVariance += x * x;
    rightVariance += y * y;
  }
  return numerator / Math.max(1e-9, Math.sqrt(leftVariance * rightVariance));
}

function errorMetrics(predicted, actual) {
  if (!predicted.length) return { samples: 0, rmse: 0, mae: 0, correlation: 0 };
  const errors = predicted.map((value, index) => value - actual[index]);
  return {
    samples: predicted.length,
    rmse: round(Math.sqrt(mean(errors.map((value) => value ** 2))), 4),
    mae: round(mean(errors.map(Math.abs)), 4),
    correlation: round(correlation(predicted, actual), 4),
  };
}

function canonicalTeam(team) {
  const value = String(team || "FA").toUpperCase();
  if (value === "LA") return "LAR";
  if (value === "OAK") return "LV";
  if (value === "SD") return "LAC";
  return value;
}

function ageAt(metadata, season) {
  const birthYear = Number(String(metadata?.birth_date || "").slice(0, 4));
  return birthYear ? season - birthYear : 27;
}

async function loadPlayerMetadata(filePath) {
  const players = new Map();
  await forEachCsvRow(filePath, (row) => {
    if (row.gsis_id) players.set(row.gsis_id, row);
  });
  return players;
}

function emptyPlayer(row) {
  return {
    id: row.player_id,
    name: row.player_display_name || row.player_name,
    position: row.position,
    team: canonicalTeam(row.team),
    games: 0,
    points: 0,
    attempts: 0,
    passingYards: 0,
    carries: 0,
    rushingYards: 0,
    receptions: 0,
    targets: 0,
    receivingYards: 0,
    receivingAirYards: 0,
    passingEpa: 0,
    rushingEpa: 0,
    receivingEpa: 0,
    cpoe: [],
    targetShares: [],
    airYardsShares: [],
    wopr: [],
    weekly: [],
  };
}

function weightedOpportunity(position, row) {
  if (position === "QB") {
    return finite(row.attempts) * 0.25 + finite(row.carries) * 1.1;
  }
  return finite(row.carries) + finite(row.targets) * 2.7;
}

async function loadSeason(filePath, season, metadata) {
  const players = new Map();
  const teamTotals = new Map();
  await forEachCsvRow(filePath, (row) => {
    if (row.season_type !== "REG" || !POSITIONS.includes(row.position)) return;
    const team = canonicalTeam(row.team);
    const teamRow = teamTotals.get(team) || { attempts: 0, carries: 0, targets: 0, airYards: 0 };
    teamRow.attempts += finite(row.attempts);
    teamRow.carries += finite(row.carries);
    teamRow.targets += finite(row.targets);
    teamRow.airYards += finite(row.receiving_air_yards);
    teamTotals.set(team, teamRow);

    const player = players.get(row.player_id) || emptyPlayer(row);
    player.games += 1;
    player.points += finite(row.fantasy_points_ppr);
    player.attempts += finite(row.attempts);
    player.passingYards += finite(row.passing_yards);
    player.carries += finite(row.carries);
    player.rushingYards += finite(row.rushing_yards);
    player.receptions += finite(row.receptions);
    player.targets += finite(row.targets);
    player.receivingYards += finite(row.receiving_yards);
    player.receivingAirYards += finite(row.receiving_air_yards);
    player.passingEpa += finite(row.passing_epa);
    player.rushingEpa += finite(row.rushing_epa);
    player.receivingEpa += finite(row.receiving_epa);
    if (row.passing_cpoe !== "") player.cpoe.push(finite(row.passing_cpoe));
    if (row.target_share !== "") player.targetShares.push(finite(row.target_share));
    if (row.air_yards_share !== "") player.airYardsShares.push(finite(row.air_yards_share));
    if (row.wopr !== "") player.wopr.push(finite(row.wopr));
    player.weekly.push({
      week: finite(row.week),
      points: finite(row.fantasy_points_ppr),
      usage: weightedOpportunity(row.position, row),
    });
    players.set(player.id, player);
  });

  for (const player of players.values()) {
    const info = metadata.get(player.id) || {};
    const team = teamTotals.get(player.team) || {};
    player.weekly.sort((left, right) => left.week - right.week);
    const usage = player.weekly.map((row) => row.usage);
    const points = player.weekly.map((row) => row.points);
    const usagePerGame = mean(usage);
    const recentUsage = mean(usage.slice(-4));
    player.espnId = info.espn_id || null;
    player.age = ageAt(info, season);
    player.experience = Math.max(0, season - finite(info.rookie_season, season));
    player.draftRound = finite(info.draft_round, 8);
    player.latestTeam = canonicalTeam(info.latest_team || player.team);
    player.ppg = player.points / Math.max(1, player.games);
    player.usagePerGame = usagePerGame;
    player.usageCv = usagePerGame ? standardDeviation(usage) / usagePerGame : 1;
    player.usageTrend = usagePerGame
      ? clamp(recentUsage / usagePerGame - 1, -1, 1)
      : 0;
    player.volatility = player.ppg ? standardDeviation(points) / player.ppg : 1;
    player.attemptShare = player.attempts / Math.max(1, finite(team.attempts));
    player.carryShare = player.carries / Math.max(1, finite(team.carries));
    player.targetShare = player.targets / Math.max(1, finite(team.targets));
    player.airYardsShare = player.receivingAirYards / Math.max(1, finite(team.airYards));
    player.reportedTargetShare = mean(player.targetShares);
    player.reportedAirYardsShare = mean(player.airYardsShares);
    player.wopr = mean(player.wopr);
    player.yardsPerAttempt = player.passingYards / Math.max(1, player.attempts);
    player.yardsPerCarry = player.rushingYards / Math.max(1, player.carries);
    player.catchRate = player.receptions / Math.max(1, player.targets);
    player.yardsPerTarget = player.receivingYards / Math.max(1, player.targets);
    player.cpoe = mean(player.cpoe);
    player.efficiency = player.ppg / Math.max(0.1, player.usagePerGame);
    player.teamOpportunityShare = player.position === "QB"
      ? player.attemptShare * 0.78 + player.carryShare * 0.22
      : player.position === "RB"
        ? player.carryShare * 0.65 + player.targetShare * 0.35
        : player.targetShare * 0.6 + player.airYardsShare * 0.4;
  }
  return players;
}

function featureVector(player) {
  if (player.position === "QB") {
    return [player.ppg, player.attempts / player.games, player.carries / player.games,
      player.yardsPerAttempt, player.cpoe, player.usageCv, player.usageTrend,
      player.age, player.experience];
  }
  if (player.position === "RB") {
    return [player.ppg, player.carries / player.games, player.targets / player.games,
      player.targetShare, player.yardsPerCarry, player.yardsPerTarget,
      player.usageCv, player.usageTrend, player.age, player.experience];
  }
  return [player.ppg, player.targets / player.games, player.targetShare,
    player.airYardsShare, player.wopr, player.catchRate, player.yardsPerTarget,
    player.usageCv, player.usageTrend, player.age, player.experience];
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let selected = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(rows[row][pivot]) > Math.abs(rows[selected][pivot])) selected = row;
    }
    [rows[pivot], rows[selected]] = [rows[selected], rows[pivot]];
    const divisor = Math.abs(rows[pivot][pivot]) < 1e-9 ? 1e-9 : rows[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) rows[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = rows[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        rows[row][column] -= factor * rows[pivot][column];
      }
    }
  }
  return rows.map((row) => row[size]);
}

function fitRidge(samples, position, lambda) {
  if (!samples.length) throw new Error(`No ${position} samples available for ridge fit`);
  const raw = samples.map((sample) => featureVector(sample.previous));
  const dimension = raw[0].length;
  const means = Array.from({ length: dimension }, (_, column) => (
    mean(raw.map((row) => row[column]))
  ));
  const deviations = Array.from({ length: dimension }, (_, column) => (
    Math.max(0.001, standardDeviation(raw.map((row) => row[column])))
  ));
  const inputs = raw.map((row) => [
    1,
    ...row.map((value, column) => (value - means[column]) / deviations[column]),
  ]);
  const target = samples.map((sample) => sample.next.ppg);
  const matrix = Array.from({ length: dimension + 1 }, () => Array(dimension + 1).fill(0));
  const vector = Array(dimension + 1).fill(0);
  for (let row = 0; row < inputs.length; row += 1) {
    for (let left = 0; left <= dimension; left += 1) {
      vector[left] += inputs[row][left] * target[row];
      for (let right = 0; right <= dimension; right += 1) {
        matrix[left][right] += inputs[row][left] * inputs[row][right];
      }
    }
  }
  for (let column = 1; column <= dimension; column += 1) matrix[column][column] += lambda;
  const coefficients = solveLinearSystem(matrix, vector);
  return {
    position,
    lambda,
    featureNames: FEATURE_NAMES[position],
    means,
    deviations,
    coefficients,
  };
}

function predict(model, player) {
  const values = featureVector(player);
  let result = model.coefficients[0];
  for (let index = 0; index < values.length; index += 1) {
    const standardized = (values[index] - model.means[index]) / model.deviations[index];
    result += model.coefficients[index + 1] * standardized;
  }
  return Math.max(0, result);
}

function transitionSamples(seasons, position) {
  const samples = [];
  const years = Object.keys(seasons).map(Number).sort((left, right) => left - right);
  for (const outcomeSeason of years.slice(1)) {
    const previous = seasons[outcomeSeason - 1];
    const next = seasons[outcomeSeason];
    if (!previous || !next) continue;
    for (const player of previous.values()) {
      const outcome = next.get(player.id);
      if (player.position !== position || player.games < 6 || !outcome || outcome.games < 6) continue;
      samples.push({ previous: player, next: outcome, outcomeSeason });
    }
  }
  return samples;
}

function selectLambda(samples, position) {
  const training = samples.filter((sample) => sample.outcomeSeason < HOLDOUT_SEASON);
  const validationYears = [...new Set(training.map((sample) => sample.outcomeSeason))];
  let best = null;
  for (const lambda of RIDGE_GRID) {
    const predicted = [];
    const actual = [];
    for (const validationYear of validationYears) {
      const fitRows = training.filter((sample) => sample.outcomeSeason !== validationYear);
      const validationRows = training.filter((sample) => sample.outcomeSeason === validationYear);
      if (fitRows.length < 20 || !validationRows.length) continue;
      const model = fitRidge(fitRows, position, lambda);
      predicted.push(...validationRows.map((sample) => predict(model, sample.previous)));
      actual.push(...validationRows.map((sample) => sample.next.ppg));
    }
    const metrics = errorMetrics(predicted, actual);
    if (!best || metrics.rmse < best.metrics.rmse) best = { lambda, metrics };
  }
  return best;
}

function modelDiagnostics(samples, position, lambda) {
  const training = samples.filter((sample) => sample.outcomeSeason < HOLDOUT_SEASON);
  const holdout = samples.filter((sample) => sample.outcomeSeason === HOLDOUT_SEASON);
  const validationModel = fitRidge(training, position, lambda);
  const modelPredicted = holdout.map((sample) => predict(validationModel, sample.previous));
  const baselinePredicted = holdout.map((sample) => sample.previous.ppg);
  const actual = holdout.map((sample) => sample.next.ppg);
  const model = errorMetrics(modelPredicted, actual);
  const baseline = errorMetrics(baselinePredicted, actual);
  return {
    trainingSamples: training.length,
    holdoutSeason: HOLDOUT_SEASON,
    holdoutSamples: holdout.length,
    model,
    priorSeasonBaseline: baseline,
    rmseImprovement: round(1 - model.rmse / Math.max(0.001, baseline.rmse), 4),
    correlationLift: round(model.correlation - baseline.correlation, 4),
  };
}

function serializeModel(model) {
  return {
    position: model.position,
    lambda: model.lambda,
    featureNames: model.featureNames,
    means: model.means.map((value) => round(value, 6)),
    deviations: model.deviations.map((value) => round(value, 6)),
    coefficients: model.coefficients.map((value) => round(value, 6)),
  };
}

function featureDrivers(model, player) {
  const values = featureVector(player);
  return values.map((value, index) => ({
    feature: model.featureNames[index],
    contribution: model.coefficients[index + 1] *
      ((value - model.means[index]) / model.deviations[index]),
  })).sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    .slice(0, 4)
    .map((row) => ({
      feature: row.feature,
      direction: row.contribution >= 0 ? "positive" : "negative",
      contribution: round(row.contribution, 3),
    }));
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * clamp(probability, 0, 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function historicalAnalogs(player, samples, model) {
  const target = featureVector(player);
  const rows = samples
    .filter((sample) => sample.previous.id !== player.id)
    .map((sample) => {
      const candidate = featureVector(sample.previous);
      const squared = target.reduce((sum, value, index) => {
        const delta = (value - candidate[index]) / Math.max(0.001, model.deviations[index]);
        return sum + delta ** 2;
      }, 0);
      const distance = Math.sqrt(squared / Math.max(1, target.length));
      return { sample, distance, similarity: 1 / (1 + distance) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 16);
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, row) => sum + row.similarity ** 2, 0);
  const forecastPpg = rows.reduce((sum, row) => (
    sum + row.sample.next.ppg * row.similarity ** 2
  ), 0) / Math.max(0.001, totalWeight);
  const outcomes = rows.map((row) => row.sample.next.ppg);
  const hitThreshold = player.ppg * 1.15;
  const bustThreshold = player.ppg * 0.8;
  return {
    sampleSize: rows.length,
    forecastPpg: round(forecastPpg, 3),
    p10: round(quantile(outcomes, 0.1), 3),
    median: round(quantile(outcomes, 0.5), 3),
    p90: round(quantile(outcomes, 0.9), 3),
    hitRate: round(rows.filter((row) => row.sample.next.ppg >= hitThreshold).length / rows.length, 4),
    bustRate: round(rows.filter((row) => row.sample.next.ppg <= bustThreshold).length / rows.length, 4),
    comparables: rows.slice(0, 4).map((row) => ({
      name: row.sample.previous.name,
      sourceSeason: row.sample.outcomeSeason - 1,
      age: row.sample.previous.age,
      sourcePpg: round(row.sample.previous.ppg, 2),
      nextPpg: round(row.sample.next.ppg, 2),
      similarity: round(row.similarity, 4),
    })),
  };
}

function opportunityArchetype(player, predictedPpg) {
  const edge = predictedPpg / Math.max(1, player.ppg) - 1;
  const stableVolume = clamp(1 - player.usageCv / 1.15, 0, 1);
  if (edge >= 0.14 && player.teamOpportunityShare >= 0.18) return "breakout volume";
  if (edge <= -0.14 && player.efficiency >= 0.55) return "efficiency regression risk";
  if (player.usageTrend >= 0.22) return "ascending role";
  if (player.teamOpportunityShare >= 0.3 && stableVolume >= 0.62) return "volume anchor";
  if (player.efficiency >= 0.65) return "efficient finisher";
  if (stableVolume <= 0.28) return "volatile role";
  return "balanced opportunity";
}

function profileForPlayer(player, model, diagnostics, season, analogs) {
  const predictedPpg = predict(model, player);
  const availability = clamp(player.games / 17, 0, 1);
  const volumeStability = clamp(1 - player.usageCv / 1.2, 0, 1);
  const holdoutSkill = clamp(diagnostics.rmseImprovement / 0.2, 0.15, 1);
  const reliability = clamp(
    availability * 0.4 + volumeStability * 0.32 + holdoutSkill * 0.28,
    0.15,
    0.98,
  );
  return {
    espnId: String(player.espnId),
    gsisId: player.id,
    name: player.name,
    position: player.position,
    team: player.latestTeam || player.team,
    sourceSeason: season - 1,
    age: player.age + 1,
    experience: player.experience + 1,
    games: player.games,
    priorPpg: round(player.ppg, 3),
    predictedPpg: round(predictedPpg, 3),
    projectedSeasonPoints: round(predictedPpg * 17, 2),
    modelEdge: round(predictedPpg / Math.max(1, player.ppg) - 1, 4),
    weightedOpportunityPerGame: round(player.usagePerGame, 3),
    teamOpportunityShare: round(player.teamOpportunityShare, 4),
    carryShare: round(player.carryShare, 4),
    targetShare: round(player.targetShare, 4),
    airYardsShare: round(player.airYardsShare, 4),
    wopr: round(player.wopr, 4),
    usageTrend: round(player.usageTrend, 4),
    usageCv: round(player.usageCv, 4),
    volumeStability: round(volumeStability, 4),
    weeklyVolatility: round(player.volatility, 4),
    efficiency: round(player.efficiency, 4),
    availability: round(availability, 4),
    reliability: round(reliability, 4),
    archetype: opportunityArchetype(player, predictedPpg),
    drivers: featureDrivers(model, player),
    analogs,
  };
}

function overallDiagnostics(byPosition) {
  const modelWeight = Object.values(byPosition).reduce((sum, row) => sum + row.holdoutSamples, 0);
  if (!modelWeight) return { holdoutSamples: 0 };
  const weighted = (selector) => Object.values(byPosition).reduce((sum, row) => (
    sum + selector(row) * row.holdoutSamples
  ), 0) / modelWeight;
  return {
    holdoutSeason: HOLDOUT_SEASON,
    holdoutSamples: modelWeight,
    modelRmse: round(weighted((row) => row.model.rmse), 4),
    baselineRmse: round(weighted((row) => row.priorSeasonBaseline.rmse), 4),
    rmseImprovement: round(weighted((row) => row.rmseImprovement), 4),
    modelCorrelation: round(weighted((row) => row.model.correlation), 4),
    baselineCorrelation: round(weighted((row) => row.priorSeasonBaseline.correlation), 4),
    correlationLift: round(weighted((row) => row.correlationLift), 4),
  };
}

function resolveHistoryRoot(args) {
  const candidate = path.resolve(
    args.historyRoot || process.env.ORACLE_HISTORY_ROOT || path.join(ROOT, "data", "historical", "raw"),
  );
  const nested = path.join(candidate, "raw");
  return fs.existsSync(path.join(candidate, "nflverse_players.csv")) ? candidate : nested;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const historyRoot = resolveHistoryRoot(args);
  const metadataPath = path.join(historyRoot, "nflverse_players.csv");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing nflverse player mapping at ${metadataPath}`);
  }
  const metadata = await loadPlayerMetadata(metadataPath);
  const seasons = {};
  for (let season = 2020; season < args.season; season += 1) {
    const filePath = path.join(historyRoot, `stats_player_week_${season}.csv`);
    if (!fs.existsSync(filePath)) throw new Error(`Missing weekly history: ${filePath}`);
    seasons[season] = await loadSeason(filePath, season, metadata);
  }

  const models = {};
  const diagnostics = {};
  const productionModels = {};
  const samplesByPosition = {};
  for (const position of POSITIONS) {
    const samples = transitionSamples(seasons, position);
    samplesByPosition[position] = samples;
    const selected = selectLambda(samples, position);
    diagnostics[position] = {
      selectedLambda: selected.lambda,
      crossValidation: selected.metrics,
      ...modelDiagnostics(samples, position, selected.lambda),
    };
    const validationRows = samples.filter((sample) => sample.outcomeSeason < HOLDOUT_SEASON);
    models[position] = serializeModel(fitRidge(validationRows, position, selected.lambda));
    productionModels[position] = fitRidge(samples, position, selected.lambda);
  }

  const sourceSeason = args.season - 1;
  const profiles = {};
  for (const player of seasons[sourceSeason].values()) {
    if (!player.espnId || player.games < 1 || !productionModels[player.position]) continue;
    profiles[String(player.espnId)] = profileForPlayer(
      player,
      productionModels[player.position],
      diagnostics[player.position],
      args.season,
      historicalAnalogs(player, samplesByPosition[player.position], productionModels[player.position]),
    );
  }

  const output = {
    meta: {
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      season: args.season,
      sourceSeason,
      trainingOutcomeSeasons: [2021, 2022, 2023, 2024],
      holdoutSeason: HOLDOUT_SEASON,
      productionFitOutcomeSeasons: [2021, 2022, 2023, 2024, 2025],
      coverage: Object.keys(profiles).length,
      source: "nflverse weekly player statistics and nflverse player identifiers",
      leakageControls: [
        "Ridge penalties are selected without the 2025 holdout.",
        "Holdout predictions use only statistics from 2024 and earlier fitted transitions.",
        "Production coefficients are refit through 2025 only after holdout evaluation is recorded.",
        "2026 profiles use 2025 regular-season usage and no 2026 outcomes.",
      ],
    },
    diagnostics: {
      overall: overallDiagnostics(diagnostics),
      byPosition: diagnostics,
    },
    validationModels: models,
    productionModels: Object.fromEntries(Object.entries(productionModels).map(
      ([position, model]) => [position, serializeModel(model)],
    )),
    profiles,
  };
  const outputPath = path.resolve(args.out || path.join(ROOT, "data", `opportunity-${args.season}.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output)}\n`);
  console.log(JSON.stringify({
    outputPath,
    version: MODEL_VERSION,
    coverage: output.meta.coverage,
    holdout: output.diagnostics.overall,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
