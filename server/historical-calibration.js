"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATH = path.resolve(
  __dirname,
  "..",
  "data",
  "calibration",
  "historical-value.json",
);

let cachedPath = null;
let cachedMtime = 0;
let cachedValue = null;

function loadHistoricalCalibration(filePath = DEFAULT_PATH) {
  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    if (cachedValue && cachedPath === resolved && cachedMtime === stat.mtimeMs) {
      return cachedValue;
    }
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    cachedPath = resolved;
    cachedMtime = stat.mtimeMs;
    cachedValue = value;
    return value;
  } catch {
    return null;
  }
}

function historicalStatus(calibration = loadHistoricalCalibration()) {
  if (!calibration) {
    return {
      ready: false,
      version: null,
      seasons: [],
      simulations: 0,
      message: "Historical calibration has not been generated.",
    };
  }
  return {
    ready: true,
    version: calibration.version || null,
    generatedAt: calibration.generatedAt || null,
    seasons: calibration.seasons || [],
    trainingSeasons: calibration.trainingSeasons || [],
    simulations: calibration.backtest?.simulations || 0,
    draftReplays: calibration.backtest?.draftReplays || 0,
    strategies: calibration.backtest?.strategies || {},
    lifts: calibration.backtest?.lifts || {},
    holdout: calibration.backtest?.holdout || null,
    draftPolicy: calibration.draftPolicy || null,
    tradeCalibration: calibration.tradeCalibration?.overall || null,
    waiverCalibration: calibration.waiverCalibration?.overall || null,
    tradePolicy: calibration.decisionPolicies?.trade || calibration.tradeCalibration?.policy || null,
    waiverPolicy: calibration.decisionPolicies?.waiver || calibration.waiverCalibration?.policy || null,
    dataCoverage: calibration.dataCoverage || {},
    leakageControls: calibration.leakageControls || [],
    limitations: calibration.limitations || [],
  };
}

function historicalHealth(calibration = loadHistoricalCalibration()) {
  const status = historicalStatus(calibration);
  if (!status.ready) return status;
  return {
    ready: true,
    version: status.version,
    generatedAt: status.generatedAt,
    seasons: status.seasons,
    draftReplays: status.draftReplays,
    draftPolicy: status.draftPolicy ? {
      version: status.draftPolicy.version,
      marketWeight: status.draftPolicy.marketWeight,
      modelWeight: status.draftPolicy.modelWeight,
      holdoutSeason: status.draftPolicy.holdoutSeason,
    } : null,
    tradePolicy: status.tradePolicy ? {
      version: status.tradePolicy.version,
      confidence: status.tradePolicy.confidence,
      utilityShare: status.tradePolicy.utilityShare,
      nativeShare: status.tradePolicy.nativeShare,
      holdoutSeason: status.tradePolicy.holdoutSeason,
    } : null,
    waiverPolicy: status.waiverPolicy ? {
      version: status.waiverPolicy.version,
      utilityRerank: status.waiverPolicy.utilityRerank,
      holdoutPassed: status.waiverPolicy.holdoutPassed,
      holdoutSeason: status.waiverPolicy.holdoutSeason,
    } : null,
  };
}

module.exports = {
  DEFAULT_PATH,
  historicalHealth,
  historicalStatus,
  loadHistoricalCalibration,
};
