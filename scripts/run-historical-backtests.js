#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildHistoricalData } = require("./build-historical-data.js");
const {
  runHistoricalBacktest,
  runTradeCalibration,
  runWaiverCalibration,
} = require("../server/historical-backtest.js");
const { renderReport: renderHistoricalReport } = require("./render-historical-report.js");

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "historical", "cache");
const CALIBRATION_PATH = path.join(ROOT, "data", "calibration", "historical-value.json");
const SUMMARY_PATH = path.join(ROOT, "data", "calibration", "historical-backtest-summary.json");
const REPORT_PATH = path.join(ROOT, "docs", "ai", "historical-backtest-results.md");

function parseArgs(argv) {
  const options = {
    seasons: [2021, 2022, 2023, 2024, 2025],
    simulationsPerSlot: 8,
    tuneSimulations: 3,
    scoring: "ppr",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--seasons") options.seasons = argv[++index].split(",").map(Number);
    else if (value === "--simulations") options.simulationsPerSlot = Number(argv[++index]);
    else if (value === "--tune-simulations") options.tuneSimulations = Number(argv[++index]);
    else if (value === "--scoring") options.scoring = argv[++index];
    else if (value === "--rebuild") options.rebuild = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function loadDatasets(seasons) {
  return seasons.map((season) => JSON.parse(fs.readFileSync(
    path.join(CACHE_DIR, `season-${season}.json`),
    "utf8",
  )));
}

function policyObjective(result) {
  const oracle = result.strategies.oracle;
  return oracle.seasonPoints + oracle.actualVorp * 0.22 + oracle.allPlayWinPct * 260 +
    oracle.playoffRate * 45 + oracle.championshipRate * 65 - oracle.averagePickRegret * 0.18 -
    oracle.starterGaps * 80;
}

function tunePolicy(datasets, options) {
  const holdoutSeason = datasets.at(-1).meta.season;
  const training = datasets.slice(0, -1);
  const candidates = [0.48, 0.56, 0.64, 0.72, 0.8, 0.88];
  const rows = candidates.map((marketWeight) => {
    const result = runHistoricalBacktest({
      datasets: training,
      scoring: options.scoring,
      simulationsPerSlot: options.tuneSimulations,
      strategies: ["market", "oracle"],
      policy: { marketWeight },
      seed: 41003,
    });
    return {
      marketWeight,
      modelWeight: 1 - marketWeight,
      objective: policyObjective(result),
      oracle: result.strategies.oracle,
      lift: result.lifts.oracle,
    };
  }).sort((left, right) => right.objective - left.objective);
  return {
    selected: rows[0],
    candidates: rows,
    tunedOnSeasons: training.slice(1).map((dataset) => dataset.meta.season),
    holdoutSeason,
  };
}

function createCalibration(result, tuning, tradeCalibration, waiverCalibration) {
  const holdout = result.bySeason[String(tuning.holdoutSeason)];
  return {
    version: "oracle-historical-calibration-2026.1",
    generatedAt: result.generatedAt,
    seasons: result.seasons,
    trainingSeasons: result.trainingSeasons,
    scoring: result.scoring,
    draftPolicy: {
      version: "oracle-draft-policy-2026.1",
      marketWeight: tuning.selected.marketWeight,
      modelWeight: tuning.selected.modelWeight,
      selectedWithoutHoldout: true,
      tunedOnSeasons: tuning.tunedOnSeasons,
      holdoutSeason: tuning.holdoutSeason,
      candidates: tuning.candidates,
    },
    backtest: {
      simulations: result.pairedScenarios,
      draftReplays: result.draftReplays,
      simulationsPerSlot: result.simulationsPerSlot,
      strategies: result.strategies,
      lifts: result.lifts,
      bySeason: result.bySeason,
      bySlot: result.bySlot,
      holdout: {
        season: tuning.holdoutSeason,
        market: holdout.market,
        oracle: holdout.oracle,
      },
    },
    modelDiagnostics: result.modelDiagnostics,
    valueCurves: result.valueCurves,
    dataCoverage: result.dataCoverage,
    leakageControls: result.leakageControls,
    tradeCalibration,
    waiverCalibration,
    decisionPolicies: {
      trade: {
        version: tradeCalibration.policy.version,
        confidence: tradeCalibration.policy.confidence,
        utilityShare: tradeCalibration.policy.utilityShare,
        nativeShare: tradeCalibration.policy.nativeShare,
        normalization: tradeCalibration.policy.normalization,
        minimumFairness: tradeCalibration.policy.minimumFairness,
        scoreQuantile: tradeCalibration.policy.scoreQuantile,
        scoreThreshold: tradeCalibration.policy.scoreThreshold,
        thresholdPrecision: tradeCalibration.policy.thresholdPrecision,
        selectedWithoutHoldout: tradeCalibration.policy.selectedWithoutHoldout,
        tunedOnSeasons: tradeCalibration.policy.tunedOnSeasons,
        holdoutSeason: tradeCalibration.policy.holdoutSeason,
        interpretation: tradeCalibration.policy.interpretation,
      },
      waiver: {
        version: waiverCalibration.policy.version,
        utilityRerank: waiverCalibration.policy.utilityRerank,
        challengerSelected: waiverCalibration.policy.challengerSelected,
        holdoutPassed: waiverCalibration.policy.holdoutPassed,
        selectedWithoutHoldout: waiverCalibration.policy.selectedWithoutHoldout,
        tunedOnSeasons: waiverCalibration.policy.tunedOnSeasons,
        holdoutSeason: waiverCalibration.policy.holdoutSeason,
        baseActualGain: waiverCalibration.policy.baseActualGain,
        utilityActualGain: waiverCalibration.policy.utilityActualGain,
        naiveActualGain: waiverCalibration.policy.naiveActualGain,
        interpretation: waiverCalibration.policy.interpretation,
      },
    },
    limitations: result.limitations,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const missing = options.seasons.some((season) => !fs.existsSync(
    path.join(CACHE_DIR, `season-${season}.json`),
  ));
  if (missing || options.rebuild) {
    await buildHistoricalData({ seasons: options.seasons, force: options.rebuild });
  }
  const datasets = loadDatasets(options.seasons);
  console.log("Tuning draft policy without the final holdout season...");
  const tuning = tunePolicy(datasets, options);
  console.log(`Selected market weight ${tuning.selected.marketWeight.toFixed(2)}; holdout ${tuning.holdoutSeason}.`);
  const result = runHistoricalBacktest({
    datasets,
    scoring: options.scoring,
    simulationsPerSlot: options.simulationsPerSlot,
    policy: { marketWeight: tuning.selected.marketWeight },
    onProgress: ({ season, completedRows, totalRows }) => {
      console.log(`Season ${season}: ${completedRows}/${totalRows} replay rows`);
    },
  });
  console.log("Running historical trade calibration...");
  const tradeCalibration = runTradeCalibration({
    datasets,
    scoring: options.scoring,
    samplesPerSeason: 12,
  });
  console.log("Running historical waiver calibration...");
  const waiverCalibration = runWaiverCalibration({
    datasets,
    scoring: options.scoring,
    samplesPerSeason: 12,
    week: 5,
  });
  const calibration = createCalibration(
    result,
    tuning,
    tradeCalibration,
    waiverCalibration,
  );
  fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(calibration, null, 2)}\n`);
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify({
    version: result.version,
    generatedAt: result.generatedAt,
    seasons: result.seasons,
    draftReplays: result.draftReplays,
    pairedScenarios: result.pairedScenarios,
    strategies: result.strategies,
    lifts: result.lifts,
    bySeason: result.bySeason,
    selectedPolicy: calibration.draftPolicy,
    dataCoverage: result.dataCoverage,
    tradeCalibration,
    waiverCalibration,
  }, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, renderHistoricalReport(calibration));
  console.log(JSON.stringify({
    calibration: CALIBRATION_PATH,
    report: REPORT_PATH,
    draftReplays: result.draftReplays,
    pairedScenarios: result.pairedScenarios,
    selectedPolicy: calibration.draftPolicy,
    oracle: result.strategies.oracle,
    oracleLift: result.lifts.oracle,
  }, null, 2));
}

module.exports = {
  createCalibration,
  loadDatasets,
  parseArgs,
  policyObjective,
  tunePolicy,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
