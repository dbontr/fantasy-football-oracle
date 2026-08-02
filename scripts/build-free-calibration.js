#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const currentDataset = require("../data/players-2026.json");
const { FREE_SOURCES } = require("../server/free-source-catalog.js");
const { FreeSourceCache } = require("../server/free-source-cache.js");
const { backtestFreeCalibration } = require("../server/free-walk-forward.js");
const { NflverseConnector } = require("../server/nflverse-connector.js");
const { PlayerIdentityResolver } = require("../server/player-identity.js");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CACHE = path.join(ROOT, "data", "free-sources", "cache");
const DEFAULT_OUTPUT = path.join(ROOT, "data", "calibration", "free-probabilistic.json");
const DEFAULT_SUMMARY = path.join(ROOT, "data", "calibration", "free-probabilistic-summary.json");
const DEFAULT_REPORT = path.join(ROOT, "docs", "ai", "free-calibration-results.md");

function parseArgs(argv) {
  const options = {
    seasons: [2021, 2022, 2023, 2024, 2025],
    cacheDir: DEFAULT_CACHE,
    output: DEFAULT_OUTPUT,
    summary: DEFAULT_SUMMARY,
    report: DEFAULT_REPORT,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--seasons") options.seasons = argv[++index].split(",").map(Number);
    else if (value === "--cache-dir") options.cacheDir = path.resolve(argv[++index]);
    else if (value === "--output") options.output = path.resolve(argv[++index]);
    else if (value === "--summary") options.summary = path.resolve(argv[++index]);
    else if (value === "--report") options.report = path.resolve(argv[++index]);
    else if (value === "--force") options.force = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument ${value}`);
  }
  return options;
}

function printHelp() {
  console.log([
    "Build a zero-cost nflverse probabilistic calibration with a chronological holdout.",
    "",
    "Usage:",
    "  node scripts/build-free-calibration.js --seasons 2021,2022,2023,2024,2025",
    "",
    "Only nflverse CC-BY-4.0 weekly player outcomes are downloaded.",
    "The final season is never used to fit the calibration model.",
  ].join("\n"));
}

function roundedMetrics(metrics = {}) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
    key,
    typeof value === "number" ? Math.round(value * 10000) / 10000 : value,
  ]));
}

function renderReport(result) {
  const validation = result.calibration.validation;
  const before = validation.evaluation.before;
  const after = validation.evaluation.after;
  const improvement = validation.evaluation.improvement;
  const rows = [
    "# Free Probabilistic Calibration Results",
    "",
    `Generated: ${result.generatedAt}`,
    `Source: nflverse weekly player statistics (CC-BY-4.0)`,
    `Training seasons: ${result.trainingSeasons.join(", ")}`,
    `Untouched holdout season: ${result.holdoutSeason}`,
    `Walk-forward forecasts: ${result.forecasts.toLocaleString()}`,
    `Outcome coverage: ${(result.coverage * 100).toFixed(2)}%`,
    `Calibration approved: ${result.calibration.approved ? "yes" : "no"}`,
    "",
    "## Holdout scorecard",
    "",
    "| Metric | Before | After | Improvement |",
    "|---|---:|---:|---:|",
  ];
  for (const key of ["mae", "rmse", "brier", "logLoss", "wis", "meanPinball", "interval80Coverage"]) {
    rows.push(`| ${key} | ${before[key] ?? "—"} | ${after[key] ?? "—"} | ${improvement[key] ?? "—"} |`);
  }
  rows.push(
    "",
    "## Promotion checks",
    "",
    ...Object.entries(validation.checks).map(([key, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${key}`),
    "",
    "## Leakage controls",
    "",
    ...result.leakageControls.map((value) => `- ${value}`),
    "",
    "## Limitations",
    "",
    ...result.limitations.map((value) => `- ${value}`),
    "",
  );
  return rows.join("\n");
}

async function build(options) {
  const seasons = [...new Set(options.seasons.map(Number))]
    .filter((season) => Number.isInteger(season) && season >= 1999)
    .sort();
  if (seasons.length < 2) throw new RangeError("At least two seasons are required");
  const nflverseDefinition = FREE_SOURCES.find((source) => source.id === "nflverse");
  const cache = new FreeSourceCache({
    rootDir: options.cacheDir,
    sources: [nflverseDefinition],
    timeoutMs: 60_000,
  });
  const identity = new PlayerIdentityResolver(currentDataset.players);
  const connector = new NflverseConnector({ cache, identityResolver: identity });
  const players = await connector.syncPlayers({ force: options.force });
  console.log(`Loaded ${players.rows.length.toLocaleString()} nflverse player identities.`);
  const outcomes = [];
  const sourceMetadata = {};
  for (const season of seasons) {
    console.log(`Loading nflverse weekly outcomes for ${season}...`);
    const result = await connector.syncSeason(season, { force: options.force });
    outcomes.push(...result.outcomes);
    sourceMetadata[season] = {
      rows: result.outcomes.length,
      digest: result.metadata.digest,
      fetchedAt: result.metadata.fetchedAt,
      stale: result.stale,
    };
    console.log(`Season ${season}: ${result.outcomes.length.toLocaleString()} player-week rows.`);
  }
  const generatedAt = new Date().toISOString();
  const result = backtestFreeCalibration(outcomes, {
    generatedAt,
    minimumPlayerHistory: 2,
    minimumSamples: 80,
    minimumHoldoutSamples: 500,
    minimumWisImprovement: 0,
    maximumRmseRegression: 0.08,
    maximumBrierRegression: 0.015,
    coverageMinimum: 0.65,
    coverageMaximum: 0.94,
  });
  result.source = {
    provider: "nflverse",
    license: "CC-BY-4.0",
    repository: "https://github.com/nflverse/nflverse-data",
    metadata: sourceMetadata,
    playerIdentityDigest: identity.status().digest,
  };
  delete result.digest;
  result.digest = require("../server/lineage.js").sha256({
    version: result.version,
    seasons: result.seasons,
    holdoutSeason: result.holdoutSeason,
    calibrationDigest: result.calibration.digest,
    source: result.source,
  });
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await build(options);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.mkdirSync(path.dirname(options.summary), { recursive: true });
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(result.calibration, null, 2)}\n`);
  fs.writeFileSync(options.summary, `${JSON.stringify({
    version: result.version,
    generatedAt: result.generatedAt,
    digest: result.digest,
    seasons: result.seasons,
    trainingSeasons: result.trainingSeasons,
    holdoutSeason: result.holdoutSeason,
    outcomes: result.outcomes,
    forecasts: result.forecasts,
    coverage: result.coverage,
    overall: roundedMetrics(result.overall),
    training: roundedMetrics(result.training),
    holdout: roundedMetrics(result.holdout),
    calibration: {
      version: result.calibration.version,
      digest: result.calibration.digest,
      approved: result.calibration.approved,
      validation: result.calibration.validation,
    },
    source: result.source,
    leakageControls: result.leakageControls,
    limitations: result.limitations,
  }, null, 2)}\n`);
  fs.writeFileSync(options.report, `${renderReport(result)}\n`);
  console.log(JSON.stringify({
    calibration: options.output,
    summary: options.summary,
    report: options.report,
    approved: result.calibration.approved,
    holdoutSeason: result.holdoutSeason,
    forecasts: result.forecasts,
    holdoutEvaluation: result.calibration.validation.evaluation,
  }, null, 2));
}

module.exports = {
  DEFAULT_CACHE,
  DEFAULT_OUTPUT,
  DEFAULT_REPORT,
  DEFAULT_SUMMARY,
  build,
  parseArgs,
  renderReport,
  roundedMetrics,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
