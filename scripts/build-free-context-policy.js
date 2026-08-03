"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { forEachCsvRow } = require("./lib/csv.js");
const { normalizeWeeklyOutcome, weeklyStatsUrl } = require("../server/nflverse-connector.js");
const {
  historicalForecast,
  historyKey,
  timelineKey,
} = require("../server/free-walk-forward.js");
const {
  lowerTailMean,
  mixtureCdf,
  mixtureMoments,
  mixtureQuantile,
} = require("../server/probabilistic-forecast.js");
const {
  applyCalibration,
  buildCalibrationModel,
  scoreForecast,
  summarizeScores,
} = require("../server/probabilistic-calibration.js");
const {
  CONTEXT_FEATURES,
  FREE_CONTEXT_POLICY_SCHEMA,
  FREE_CONTEXT_POLICY_VERSION,
  RUNTIME_FEATURES,
  policyCore,
} = require("../server/free-context-policy.js");
const { sha256 } = require("../server/lineage.js");

const FEATURES = [...CONTEXT_FEATURES];

function finite(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : Number.NaN;
}

function ratio(sum, denominator) {
  return denominator > 0 ? sum / denominator : Number.NaN;
}

function featureVector(history = []) {
  const recent = history.filter((row) => row.played).slice(-8);
  const short = recent.slice(-3);
  const long = recent.slice(0, -3);
  const receivingEpa = recent.filter((row) => Number.isFinite(row.receivingEpa));
  const rushingEpa = recent.filter((row) => Number.isFinite(row.rushingEpa));
  const passingEpa = recent.filter((row) => Number.isFinite(row.passingEpa));
  const recentOpp = mean(short.map((row) => row.opportunities));
  const longOpp = mean(long.map((row) => row.opportunities));
  const recentPpo = mean(short.map((row) => row.pointsPerOpportunity));
  const longPpo = mean(long.map((row) => row.pointsPerOpportunity));
  return {
    airYardsShare: mean(recent.map((row) => row.airYardsShare)),
    wopr: mean(recent.map((row) => row.wopr)),
    receivingEpaPerTarget: ratio(
      receivingEpa.reduce((sum, row) => sum + row.receivingEpa, 0),
      receivingEpa.reduce((sum, row) => sum + row.targets, 0),
    ),
    rushingEpaPerCarry: ratio(
      rushingEpa.reduce((sum, row) => sum + row.rushingEpa, 0),
      rushingEpa.reduce((sum, row) => sum + row.carries, 0),
    ),
    passingEpaPerDropback: ratio(
      passingEpa.reduce((sum, row) => sum + row.passingEpa, 0),
      passingEpa.reduce((sum, row) => sum + row.passAttempts + row.sacksSuffered, 0),
    ),
    opportunityTrend: Number.isFinite(recentOpp) && Number.isFinite(longOpp) && longOpp > 0
      ? clamp(recentOpp / longOpp - 1, -1, 10) : Number.NaN,
    pointsPerOpportunityTrend: Number.isFinite(recentPpo) && Number.isFinite(longPpo) && longPpo > 0
      ? clamp(recentPpo / longPpo - 1, -1, 10) : Number.NaN,
  };
}

function solve(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-10) continue;
    for (let item = column; item <= n; item += 1) augmented[column][item] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item <= n; item += 1) {
        augmented[row][item] -= factor * augmented[column][item];
      }
    }
  }
  return augmented.map((row) => finite(row[n], 0));
}

function fit(rows, alpha) {
  const means = Object.fromEntries(FEATURES.map((feature) => [
    feature, mean(rows.map((row) => row.features[feature])),
  ]));
  const scales = Object.fromEntries(FEATURES.map((feature) => {
    const values = rows.map((row) => row.features[feature]).filter(Number.isFinite);
    const average = means[feature];
    const variance = values.length
      ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length : 0;
    return [feature, Math.max(0.05, Math.sqrt(variance))];
  }));
  const columns = FEATURES.length;
  const xtx = Array.from({ length: columns }, () => Array(columns).fill(0));
  const xty = Array(columns).fill(0);
  for (const row of rows) {
    const x = FEATURES.map((feature) => {
      const value = row.features[feature];
      return Number.isFinite(value) ? (value - means[feature]) / scales[feature] : 0;
    });
    for (let i = 0; i < columns; i += 1) {
      xty[i] += x[i] * row.residual;
      for (let j = 0; j < columns; j += 1) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let index = 0; index < columns; index += 1) xtx[index][index] += alpha;
  return { means, scales, coefficients: solve(xtx, xty), samples: rows.length, alpha };
}

function predict(model, features) {
  if (!model) return 0;
  const x = FEATURES.map((feature) => {
    const value = features[feature];
    return Number.isFinite(value) ? (value - model.means[feature]) / model.scales[feature] : 0;
  });
  return x.reduce((sum, value, index) => sum + value * model.coefficients[index], 0);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function adjustForecast(forecast, correction) {
  const probability = forecast.availability.probability;
  const activeMean = Math.max(0, forecast.activeDistribution.mean
    + correction / Math.max(0.35, probability));
  const activeStdDev = forecast.activeDistribution.standardDeviation;
  const moments = mixtureMoments(probability, activeMean, activeStdDev);
  const quantiles = Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((p) => [
    `p${Math.round(p * 100)}`,
    mixtureQuantile(p, probability, activeMean, activeStdDev),
  ]));
  const bustThreshold = forecast.probabilities.bustThreshold;
  const ceilingThreshold = forecast.probabilities.ceilingThreshold;
  return {
    ...forecast,
    activeDistribution: { ...forecast.activeDistribution, mean: activeMean },
    distribution: {
      ...forecast.distribution,
      mean: moments.mean,
      standardDeviation: moments.standardDeviation,
      ...quantiles,
      cvar10: lowerTailMean(probability, activeMean, activeStdDev, 0.1),
    },
    probabilities: {
      ...forecast.probabilities,
      bust: mixtureCdf(bustThreshold, probability, activeMean, activeStdDev),
      ceiling: 1 - mixtureCdf(ceilingThreshold, probability, activeMean, activeStdDev),
    },
  };
}

async function downloadSeason(season, directory) {
  const file = path.join(directory, `stats_player_week_${season}.csv`);
  try {
    await fs.access(file);
  } catch {
    const response = await fetch(weeklyStatsUrl(season), {
      headers: { "user-agent": "FantasyFootballOracle-context-research/5.2" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`nflverse ${season} returned HTTP ${response.status}`);
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  const rows = [];
  await forEachCsvRow(file, (row) => {
    const normalized = normalizeWeeklyOutcome(row, season);
    if (normalized) rows.push(normalized);
  });
  return rows;
}

function buildExamples(outcomes) {
  const rows = outcomes.slice().sort((left, right) => (
    timelineKey(left) - timelineKey(right)
    || historyKey(left).localeCompare(historyKey(right))
  ));
  const playerHistory = new Map();
  const positionHistory = new Map();
  const examples = [];
  let index = 0;
  while (index < rows.length) {
    const timeline = timelineKey(rows[index]);
    const batch = [];
    while (index < rows.length && timelineKey(rows[index]) === timeline) batch.push(rows[index++]);
    for (const row of batch) {
      const playerRows = playerHistory.get(historyKey(row)) || [];
      const positionRows = positionHistory.get(row.position) || [];
      if (playerRows.length < 2 && positionRows.length < 30) continue;
      const forecast = historicalForecast(row, playerRows, positionRows, { generatedAt: new Date(0).toISOString() });
      examples.push({
        season: row.season,
        week: row.week,
        position: row.position,
        outcome: row,
        forecast,
        features: featureVector(playerRows.filter((history) => history.season === row.season)),
        residual: row.pointsPpr - forecast.distribution.mean,
      });
    }

    for (const row of batch) {
      const playerKey = historyKey(row);
      const positionKey = row.position;
      const playerRows = playerHistory.get(playerKey) || [];
      playerRows.push(row);
      playerHistory.set(playerKey, playerRows);
      const positionRows = positionHistory.get(positionKey) || [];
      positionRows.push(row);
      positionHistory.set(positionKey, positionRows);
    }
  }
  return examples;
}

function fitGrouped(rows, alpha) {
  const groups = {};
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const group = rows.filter((row) => row.position === position);
    if (group.length >= 250) groups[position] = fit(group, alpha);
  }
  return groups;
}

function policyForecast(row, models, options = {}) {
  const model = models?.[row.position] || null;
  const cap = Number(options.cap || 3);
  const strength = Number(options.strength || 1);
  const correction = model
    ? clamp(predict(model, row.features) * strength, -cap, cap) : 0;
  return { forecast: adjustForecast(row.forecast, correction), correction };
}

function buildBaselineCalibration(rows) {
  return buildCalibrationModel(rows.map((row) => ({
    forecast: row.forecast,
    outcome: row.outcome,
  })), {
    approved: true,
    minimumSamples: 80,
    generatedAt: new Date(0).toISOString(),
    source: "nested-context-baseline",
    trainingSeasons: [...new Set(rows.map((row) => row.season))],
  });
}

function calibratedResidualRows(rows, calibration) {
  return rows.map((row) => {
    const calibrated = applyCalibration(row.forecast, calibration);
    return {
      ...row,
      residual: row.outcome.pointsPpr - calibrated.distribution.mean,
    };
  });
}

function evaluatePolicy(evaluation, calibration, models, options = {}) {
  const scores = [];
  const corrections = [];
  for (const row of evaluation) {
    const calibrated = applyCalibration(row.forecast, calibration);
    const adjusted = policyForecast({ ...row, forecast: calibrated }, models, options);
    corrections.push(adjusted.correction);
    scores.push(scoreForecast(adjusted.forecast, row.outcome));
  }
  return {
    summary: summarizeScores(scores),
    correctionMean: mean(corrections),
    correctionAbsMean: mean(corrections.map(Math.abs)),
  };
}

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "data", "calibration", "free-context-policy.json");
const DEFAULT_SUMMARY = path.join(ROOT, "data", "calibration", "free-context-policy-summary.json");
const DEFAULT_REPORT = path.join(ROOT, "docs", "ai", "free-context-policy-results.md");

function parseArgs(argv) {
  const options = {
    seasons: [2021, 2022, 2023, 2024, 2025],
    cacheDir: path.join(ROOT, "data", "free-sources", "context-policy"),
    output: DEFAULT_OUTPUT,
    summary: DEFAULT_SUMMARY,
    report: DEFAULT_REPORT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--seasons") options.seasons = argv[++index].split(",").map(Number);
    else if (value === "--cache-dir") options.cacheDir = path.resolve(argv[++index]);
    else if (value === "--output") options.output = path.resolve(argv[++index]);
    else if (value === "--summary") options.summary = path.resolve(argv[++index]);
    else if (value === "--report") options.report = path.resolve(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument ${value}`);
  }
  return options;
}

function printHelp() {
  console.log("Build the perpetual-free nflverse context policy with nested chronological validation.");
}

function roundedMetrics(metrics = {}) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
    key, typeof value === "number" ? Math.round(value * 100000) / 100000 : value,
  ]));
}

function renderReport(document) {
  const before = document.validation.holdout.before;
  const after = document.validation.holdout.after;
  const improvement = document.validation.improvement;
  return [
    "# Perpetual-Free Context Policy Results",
    "",
    `Generated: ${document.generatedAt}`,
    `Source: nflverse weekly player statistics (CC-BY-4.0)`,
    `Training seasons: ${document.trainingSeasons.join(", ")}`,
    `Untouched holdout season: ${document.holdoutSeason}`,
    `Holdout samples: ${after.samples.toLocaleString()}`,
    `Policy approved: ${document.approved ? "yes" : "no"}`,
    `Production order matched: ${document.validation.productionOrderMatched ? "yes" : "no"}`,
    `Correction target: ${document.validation.correctionTarget}`,
    `Features: ${document.features.join(", ")}`,
    `Maximum correction: +/-${document.selection.cap} expected points`,
    "",
    "| Metric | Before | After | Improvement |",
    "|---|---:|---:|---:|",
    ...["mae", "rmse", "wis", "meanPinball", "interval80Coverage"].map((key) =>
      `| ${key} | ${before[key]} | ${after[key]} | ${improvement[key] ?? "—"} |`),
    "",
    ...Object.entries(document.validation.checks).map(([key, passed]) =>
      `- ${passed ? "PASS" : "FAIL"}: ${key}`),
    "",
  ].join("\n");
}

async function build(options = {}) {
  const seasons = [...new Set((options.seasons || []).map(Number))]
    .filter((season) => Number.isInteger(season) && season >= 1999).sort();
  if (seasons.length < 3) throw new RangeError("Context policy requires at least three seasons");
  const holdoutSeason = seasons.at(-1);
  const validationSeason = seasons.at(-2);
  const directory = options.cacheDir || path.join(ROOT, "data", "free-sources", "context-policy");
  await fs.mkdir(directory, { recursive: true });
  const outcomes = [];
  for (const season of seasons) {
    const rows = await downloadSeason(season, directory);
    console.error(`season ${season}: ${rows.length} outcomes`);
    outcomes.push(...rows);
  }
  const examples = buildExamples(outcomes);
  const innerTrain = examples.filter((row) => row.season < validationSeason);
  const validation = examples.filter((row) => row.season === validationSeason);
  const fullTrain = examples.filter((row) => row.season < holdoutSeason);
  const holdout = examples.filter((row) => row.season === holdoutSeason);
  if (!innerTrain.length || !validation.length || !fullTrain.length || !holdout.length) {
    throw new RangeError("Context policy has insufficient chronological rows");
  }
  const innerCalibration = buildBaselineCalibration(innerTrain);
  const innerResidualRows = calibratedResidualRows(innerTrain, innerCalibration);
  const validationBaseline = evaluatePolicy(validation, innerCalibration, null).summary;
  const candidates = [];
  for (const alpha of [10, 25, 50, 100, 250, 500, 1000]) {
    const candidateModels = fitGrouped(innerResidualRows, alpha);
    for (const cap of [1, 1.5, 2, 3, 4]) {
      for (const strength of [0.25, 0.5, 0.75, 1]) {
        const result = evaluatePolicy(
          validation, innerCalibration, candidateModels, { cap, strength },
        );
        candidates.push({ alpha, cap, strength, ...result });
      }
    }
  }
  candidates.sort((left, right) => left.summary.wis - right.summary.wis
    || left.summary.rmse - right.summary.rmse);
  const selected = candidates[0];
  const fullCalibration = buildBaselineCalibration(fullTrain);
  const fullResidualRows = calibratedResidualRows(fullTrain, fullCalibration);
  const models = fitGrouped(fullResidualRows, selected.alpha);
  const holdoutBaseline = evaluatePolicy(holdout, fullCalibration, null).summary;
  const holdoutCandidate = evaluatePolicy(holdout, fullCalibration, models, selected);
  const improvement = {
    wis: holdoutBaseline.wis - holdoutCandidate.summary.wis,
    rmse: holdoutBaseline.rmse - holdoutCandidate.summary.rmse,
    mae: holdoutBaseline.mae - holdoutCandidate.summary.mae,
    brier: holdoutBaseline.brier - holdoutCandidate.summary.brier,
    logLoss: holdoutBaseline.logLoss - holdoutCandidate.summary.logLoss,
    meanPinball: holdoutBaseline.meanPinball - holdoutCandidate.summary.meanPinball,
    interval80Coverage: holdoutCandidate.summary.interval80Coverage
      - holdoutBaseline.interval80Coverage,
  };
  const checks = {
    validationWisImproved: selected.summary.wis < validationBaseline.wis,
    holdoutWisImproved: improvement.wis > 0,
    holdoutRmseDidNotRegress: improvement.rmse >= 0,
    holdoutMaeDidNotRegress: improvement.mae >= 0,
    holdoutCoverageIsCalibrated: holdoutCandidate.summary.interval80Coverage >= 0.65
      && holdoutCandidate.summary.interval80Coverage <= 0.94,
    correctionIsBounded: selected.cap <= 1.5
      && holdoutCandidate.correctionAbsMean <= 1,
  };
  const generatedAt = new Date().toISOString();
  const document = {
    version: FREE_CONTEXT_POLICY_VERSION,
    schemaVersion: FREE_CONTEXT_POLICY_SCHEMA,
    generatedAt,
    source: { provider: "nflverse", license: "CC-BY-4.0",
      repository: "https://github.com/nflverse/nflverse-data" },
    approved: Object.values(checks).every(Boolean),
    features: [...FEATURES],
    runtimeFeatures: { ...RUNTIME_FEATURES },
    trainingSeasons: seasons.filter((season) => season < holdoutSeason),
    validationSeason,
    holdoutSeason,
    selection: { alpha: selected.alpha, cap: selected.cap, strength: selected.strength },
    validation: {
      nestedChronological: true,
      productionOrderMatched: true,
      correctionTarget: "post-calibration residual",
      examples: examples.length,
      innerTrainingSamples: innerTrain.length,
      validationSamples: validation.length,
      fullTrainingSamples: fullTrain.length,
      holdoutSamples: holdout.length,
      validation: { before: roundedMetrics(validationBaseline),
        after: roundedMetrics(selected.summary) },
      holdout: { before: roundedMetrics(holdoutBaseline),
        after: roundedMetrics(holdoutCandidate.summary) },
      improvement: roundedMetrics(improvement),
      checks,
      correction: { mean: holdoutCandidate.correctionMean,
        absoluteMean: holdoutCandidate.correctionAbsMean },
    },
    models,
  };
  document.digest = sha256(policyCore(document));
  return document;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const document = await build(options);
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.mkdir(path.dirname(options.summary), { recursive: true });
  await fs.mkdir(path.dirname(options.report), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(document, null, 2)}\n`);
  await fs.writeFile(options.summary, `${JSON.stringify({
    version: document.version, schemaVersion: document.schemaVersion,
    generatedAt: document.generatedAt, digest: document.digest,
    approved: document.approved, trainingSeasons: document.trainingSeasons,
    validationSeason: document.validationSeason, holdoutSeason: document.holdoutSeason,
    selection: document.selection, validation: document.validation,
    modelSamples: Object.fromEntries(Object.entries(document.models)
      .map(([position, model]) => [position, model.samples])),
  }, null, 2)}\n`);
  await fs.writeFile(options.report, `${renderReport(document)}\n`);
  console.log(JSON.stringify({ output: options.output, summary: options.summary,
    report: options.report, approved: document.approved, digest: document.digest,
    holdoutSeason: document.holdoutSeason, improvement: document.validation.improvement }, null, 2));
}

module.exports = { build, parseArgs, renderReport, roundedMetrics };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
