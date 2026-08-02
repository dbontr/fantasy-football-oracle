#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "data", "calibration", "historical-value.json");
const DEFAULT_OUTPUT = path.join(ROOT, "docs", "ai", "historical-backtest-results.md");

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function signed(value, digits = 2) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function strategyLines(strategies) {
  return [
    "| Strategy | Managed points | All-play | Wins | Playoffs | Titles | Starter gaps | Pick regret |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(strategies || {}).map(([name, row]) => (
      `| ${name} | ${row.seasonPoints.toFixed(1)} | ${pct(row.allPlayWinPct)} | ` +
      `${row.wins.toFixed(2)} | ${pct(row.playoffRate)} | ${pct(row.championshipRate)} | ` +
      `${row.starterGaps.toFixed(2)} | ${row.averagePickRegret.toFixed(1)} |`
    )),
  ];
}

function tuningLines(policy) {
  return [
    "| Market weight | Model/need weight | Objective | Managed points | All-play | Starter gaps |",
    "|---:|---:|---:|---:|---:|---:|",
    ...(policy?.candidates || []).map((row) => (
      `| ${row.marketWeight.toFixed(2)} | ${row.modelWeight.toFixed(2)} | ` +
      `${row.objective.toFixed(1)} | ${row.oracle.seasonPoints.toFixed(1)} | ` +
      `${pct(row.oracle.allPlayWinPct)} | ${row.oracle.starterGaps.toFixed(2)} |`
    )),
  ];
}

function holdoutLines(holdout) {
  const market = holdout.market;
  const oracle = holdout.oracle;
  return [
    "| Metric | Market | Calibrated Oracle | Lift |",
    "|---|---:|---:|---:|",
    `| Managed points | ${market.seasonPoints.toFixed(1)} | ${oracle.seasonPoints.toFixed(1)} | ${signed(oracle.seasonPoints - market.seasonPoints, 1)} |`,
    `| Wins | ${market.wins.toFixed(2)} | ${oracle.wins.toFixed(2)} | ${signed(oracle.wins - market.wins, 2)} |`,
    `| All-play | ${pct(market.allPlayWinPct)} | ${pct(oracle.allPlayWinPct)} | ${signed((oracle.allPlayWinPct - market.allPlayWinPct) * 100, 1)} pp |`,
    `| Playoffs | ${pct(market.playoffRate)} | ${pct(oracle.playoffRate)} | ${signed((oracle.playoffRate - market.playoffRate) * 100, 1)} pp |`,
    `| Titles | ${pct(market.championshipRate)} | ${pct(oracle.championshipRate)} | ${signed((oracle.championshipRate - market.championshipRate) * 100, 1)} pp |`,
    `| Actual VORP | ${market.actualVorp.toFixed(1)} | ${oracle.actualVorp.toFixed(1)} | ${signed(oracle.actualVorp - market.actualVorp, 1)} |`,
    `| Pick regret | ${market.averagePickRegret.toFixed(1)} | ${oracle.averagePickRegret.toFixed(1)} | ${signed(oracle.averagePickRegret - market.averagePickRegret, 1)} |`,
  ];
}

function tradeLines(calibration) {
  const row = calibration?.overall;
  const policy = calibration?.policy;
  if (!row) return ["Trade calibration was not generated."];
  const lines = [
    `The benchmark evaluated ${row.candidates.toLocaleString()} synthetic one-for-one offers.`,
  ];
  if (policy) {
    lines.push(
      `The selected standardized blend uses ${(policy.utilityShare * 100).toFixed(0)}% multi-week roster utility and ${(policy.nativeShare * 100).toFixed(0)}% native trade score.`,
      policy.selectedWithoutHoldout
        ? `It was tuned on ${policy.tunedOnSeasons.join(", ")} and evaluated on the untouched ${policy.holdoutSeason} holdout.`
        : "The available sample was too small for a separate holdout split.",
    );
  }
  lines.push(
    "",
    "| Signal | Correlation with actual user gain |",
    "|---|---:|",
    `| Original trade score | ${row.correlation.toFixed(3)} |`,
    `| Immediate lineup gain | ${row.lineupGainCorrelation.toFixed(3)} |`,
    `| Unified roster utility | ${row.utilityCorrelation.toFixed(3)} |`,
    `| Roster-need reduction | ${row.needReductionCorrelation.toFixed(3)} |`,
    `| Calibrated decision score | ${row.decisionCorrelation.toFixed(3)} |`,
    "",
    `- Recommendation precision: ${pct(row.recommendationPrecision)}.`,
    `- Mean actual gain among recommended offers: ${signed(row.recommendedActualGain, 1)}.`,
    `- Top-versus-bottom score-quintile separation: ${row.separation.toFixed(1)} points.`,
    `- Bilateral positive rate under the test constraint: ${pct(row.mutualPositiveRate)}.`,
  );
  if (policy?.holdout) {
    lines.push(
      `- Holdout original-to-calibrated correlation: ${policy.holdout.correlation.toFixed(3)} to ${policy.holdout.decisionCorrelation.toFixed(3)}.`,
      `- Holdout recommendation precision: ${pct(policy.holdout.recommendationPrecision)}.`,
      `- Holdout recommended mean gain: ${signed(policy.holdout.recommendedActualGain, 1)}.`,
    );
  }
  return lines;
}

function waiverLines(calibration) {
  const row = calibration?.overall;
  const policy = calibration?.policy;
  if (!row) return ["Waiver calibration was not generated."];
  const selectedName = policy?.utilityRerank
    ? "Unified-utility rerank"
    : "Existing need-aware Oracle";
  const lines = [
    `The benchmark replayed ${row.scenarios} Week ${calibration.evaluationWeek} add/drop decisions.`,
  ];
  if (policy) {
    lines.push(
      policy.selectedWithoutHoldout
        ? `The policy was selected on ${policy.tunedOnSeasons.join(", ")} without using the ${policy.holdoutSeason} holdout.`
        : "The available sample was too small for a separate holdout split.",
    );
  }
  lines.push(
    "",
    "| Policy | Actual remaining-season gain |",
    "|---|---:|",
    `| Existing need-aware Oracle | ${signed(row.baseOracleActualGain, 1)} |`,
    `| Unified-utility rerank | ${signed(row.oracleActualGain, 1)} |`,
    `| Naive highest-projection rule | ${signed(row.naiveActualGain, 1)} |`,
    "",
    `Selected production order: ${selectedName}.`,
    policy?.interpretation || "",
    `The existing need-aware order beat the naive rule by ${signed(row.baseGainLift, 1)} points on average.`,
  );
  if (policy?.holdout) {
    const selected = policy.utilityRerank
      ? policy.holdout.oracleActualGain
      : policy.holdout.baseOracleActualGain;
    lines.push(
      `On the untouched ${policy.holdoutSeason} holdout, the selected order gained ${signed(selected, 1)} points versus ${signed(policy.holdout.naiveActualGain, 1)} for the naive rule.`,
    );
  }
  return lines;
}

function renderReport(calibration) {
  const backtest = calibration.backtest;
  const lift = backtest.lifts.oracle.paired;
  const snapshots = Object.entries(calibration.dataCoverage.preseasonSnapshots)
    .map(([season, date]) => `${season}: ${date}`).join("; ");
  const limitations = [
    ...(calibration.limitations || []),
    ...(calibration.tradeCalibration?.limitations || []),
    ...(calibration.waiverCalibration?.limitations || []),
  ];
  const lines = [
    "# Historical Fantasy Decision Backtests", "",
    `Generated: ${calibration.generatedAt}`, "",
    "## Data and leakage controls", "",
    `- Preseason ranking seasons: ${calibration.trainingSeasons.join(", ")}`,
    `- Walk-forward test seasons: ${calibration.seasons.join(", ")}`,
    `- Archived snapshots: ${snapshots}`,
    `- Player-season records: ${calibration.dataCoverage.playerSeasons.toLocaleString()}`,
    `- Identifier coverage: ${pct(calibration.dataCoverage.identifierCoverage)}`,
    `- Actual-points coverage: ${pct(calibration.dataCoverage.pointsCoverage)}`, "",
    ...calibration.leakageControls.map((row) => `- ${row}`), "",
    "## Draft replay design", "",
    "- Format: 12-team PPR, 14 rounds, all 12 draft slots",
    `- Mock-draft replays: ${backtest.draftReplays.toLocaleString()}`,
    `- Paired scenarios: ${backtest.simulations.toLocaleString()}`,
    "- Strategies: market, pure value, legacy Oracle, calibrated Oracle", "",
    ...strategyLines(backtest.strategies), "",
    "## Calibrated policy", "",
    `The selected policy uses ${(calibration.draftPolicy.marketWeight * 100).toFixed(0)}% market rank and ${(calibration.draftPolicy.modelWeight * 100).toFixed(0)}% Oracle model/need rank.`,
    `It was selected on ${calibration.draftPolicy.tunedOnSeasons.join(", ")} without using the ${calibration.draftPolicy.holdoutSeason} holdout.`, "",
    ...tuningLines(calibration.draftPolicy), "",
  ];
  lines.push(
    "## Paired Oracle lift over market", "",
    `- Managed points: ${signed(lift.seasonPoints, 1)}`,
    `- Wins: ${signed(lift.wins, 2)}`,
    `- All-play strength: ${signed(lift.allPlayWinPct * 100, 1)} percentage points`,
    `- Playoff rate: ${signed(lift.playoffRate * 100, 1)} percentage points`,
    `- Championship rate: ${signed(lift.championshipRate * 100, 1)} percentage points`,
    `- Actual VORP: ${signed(lift.actualVorp, 1)}`,
    `- Pick-regret reduction: ${signed(lift.pickRegretReduction, 1)}`, "",
    "These are average paired results, not guarantees. Scenario-level ranges remain wide.", "",
    `## Untouched ${backtest.holdout.season} holdout`, "",
    ...holdoutLines(backtest.holdout), "",
    "## Trade score calibration", "",
    ...tradeLines(calibration.tradeCalibration), "",
    "## Waiver and free-agent calibration", "",
    ...waiverLines(calibration.waiverCalibration), "",
    "## Limitations", "",
    ...limitations.map((row) => `- ${row}`), "",
  );
  return lines.join("\n");
}

function main(inputPath = DEFAULT_INPUT, outputPath = DEFAULT_OUTPUT) {
  const calibration = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = renderReport(calibration);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, report);
  return { inputPath, outputPath, bytes: Buffer.byteLength(report) };
}

module.exports = { main, renderReport };

if (require.main === module) {
  console.log(JSON.stringify(main(process.argv[2], process.argv[3]), null, 2));
}
