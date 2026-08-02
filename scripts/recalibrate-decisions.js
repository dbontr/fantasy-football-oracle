#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  runTradeCalibration,
  runWaiverCalibration,
} = require("../server/historical-backtest.js");
const { renderReport } = require("./render-historical-report.js");

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "historical", "cache");
const CALIBRATION_PATH = path.join(ROOT, "data", "calibration", "historical-value.json");
const SUMMARY_PATH = path.join(ROOT, "data", "calibration", "historical-backtest-summary.json");
const REPORT_PATH = path.join(ROOT, "docs", "ai", "historical-backtest-results.md");

function loadDatasets(seasons) {
  return seasons.map((season) => JSON.parse(fs.readFileSync(
    path.join(CACHE_DIR, `season-${season}.json`),
    "utf8",
  )));
}

function decisionPolicies(tradeCalibration, waiverCalibration) {
  return {
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
  };
}

function main() {
  const calibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8"));
  const datasets = loadDatasets(calibration.trainingSeasons);
  const tradeCalibration = runTradeCalibration({
    datasets,
    scoring: calibration.scoring,
    samplesPerSeason: 12,
  });
  const waiverCalibration = runWaiverCalibration({
    datasets,
    scoring: calibration.scoring,
    samplesPerSeason: 12,
    week: 5,
  });
  calibration.tradeCalibration = tradeCalibration;
  calibration.waiverCalibration = waiverCalibration;
  calibration.decisionPolicies = decisionPolicies(tradeCalibration, waiverCalibration);
  calibration.generatedAt = new Date().toISOString();

  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));
  summary.generatedAt = calibration.generatedAt;
  summary.tradeCalibration = tradeCalibration;
  summary.waiverCalibration = waiverCalibration;
  summary.decisionPolicies = calibration.decisionPolicies;

  fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(calibration, null, 2)}\n`);
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(REPORT_PATH, renderReport(calibration));

  return {
    generatedAt: calibration.generatedAt,
    tradePolicy: tradeCalibration.policy,
    trade: tradeCalibration.overall,
    waiverPolicy: waiverCalibration.policy,
    waiver: waiverCalibration.overall,
  };
}

module.exports = { decisionPolicies, loadDatasets, main };

if (require.main === module) {
  console.log(JSON.stringify(main(), null, 2));
}
