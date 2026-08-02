const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createValueCurves,
  modelHistoricalSeason,
  runHistoricalBacktest,
  runTradeCalibration,
  runWaiverCalibration,
  simulateDraft,
} = require("../server/historical-backtest.js");

const SETTINGS = {
  teams: 4,
  rounds: 8,
  draftPosition: 1,
  scoring: "ppr",
  riskTolerance: 0.5,
  slots: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 0, K: 0, BN: 3 },
};

function syntheticSeason(season, outcomeShift = 0) {
  const positions = ["QB", "RB", "WR", "TE"];
  const players = Array.from({ length: 48 }, (_, index) => {
    const position = positions[index % positions.length];
    const positionIndex = Math.floor(index / positions.length);
    const weekly = Math.max(1, 24 - positionIndex * 1.25 + outcomeShift + (index % 3));
    const actualWeeklyPpr = Array.from({ length: 18 }, (_, weekIndex) => (
      weekIndex === (positionIndex + index) % 10 ? 0 : weekly + (weekIndex % 4) * 0.35
    ));
    const actualSeasonPpr = actualWeeklyPpr.reduce((sum, value) => sum + value, 0);
    return {
      id: `${season}:${index}`,
      name: `${position} Player ${index}`,
      position,
      team: `T${(index % 8) + 1}`,
      byeWeek: ((positionIndex + index) % 10) + 1,
      marketRank: index + 1,
      pprRank: index + 1,
      standardRank: index + 1,
      adp: index + 1,
      rankSd: 4 + (index % 5),
      previousPoints: Math.max(0, actualSeasonPpr - 12),
      reliability: 0.72,
      actualWeeklyPpr,
      actualWeeklyHalf: actualWeeklyPpr.map((value) => value * 0.9),
      actualWeeklyStandard: actualWeeklyPpr.map((value) => value * 0.8),
      actualSeasonPpr,
      actualSeasonHalf: actualSeasonPpr * 0.9,
      actualSeasonStandard: actualSeasonPpr * 0.8,
    };
  });
  return {
    meta: { season, rankDate: `${season}-08-25` },
    coverage: { identifierMap: 1, playersWithPoints: 1 },
    players,
  };
}

test("historical projection uses only earlier seasons", () => {
  const training = syntheticSeason(2021);
  const target = syntheticSeason(2022, 1.5);
  const modeled = modelHistoricalSeason([training], target, "ppr");
  assert.equal(modeled.length, target.players.length);
  assert.deepEqual(modeled[0].historicalModel.trainingSeasons, [2021]);
  assert.ok(modeled.every((player) => player.projectedPoints > 0));
  assert.ok(modeled.every((player) => player.weeklyProjections[player.byeWeek - 1] === 0));
});

test("historical mock drafts are deterministic under a paired seed", () => {
  const players = modelHistoricalSeason(
    [syntheticSeason(2021)],
    syntheticSeason(2022, 1),
    "ppr",
  );
  const left = simulateDraft({
    players,
    settings: SETTINGS,
    draftPosition: 2,
    strategy: "oracle",
    seed: 2026,
    policy: { marketWeight: 0.72 },
  });
  const right = simulateDraft({
    players,
    settings: SETTINGS,
    draftPosition: 2,
    strategy: "oracle",
    seed: 2026,
    policy: { marketWeight: 0.72 },
  });
  assert.deepEqual(left.state.picks, right.state.picks);
  assert.equal(left.state.picks.length, SETTINGS.teams * SETTINGS.rounds);
  assert.ok(left.decisions.some((row) => row.need > 0));
});

test("walk-forward backtest produces paired strategy results and value curves", () => {
  const datasets = [syntheticSeason(2021), syntheticSeason(2022, 1)];
  const result = runHistoricalBacktest({
    datasets,
    settings: SETTINGS,
    slots: [1],
    simulationsPerSlot: 1,
    strategies: ["market", "oracle"],
    policy: { marketWeight: 0.72 },
  });
  assert.equal(result.draftReplays, 2);
  assert.equal(result.pairedScenarios, 1);
  assert.equal(result.lifts.oracle.paired.pairs, 1);
  assert.ok(result.valueCurves.ppr.RB.length > 0);
  const curves = createValueCurves(datasets);
  assert.ok(curves.ppr.WR.every((row) => row.hitRate >= 0 && row.hitRate <= 1));
});

test("trade and waiver calibration expose decision quality metrics", () => {
  const datasets = [
    syntheticSeason(2021),
    syntheticSeason(2022, 1),
    syntheticSeason(2023, 2),
  ];
  const trade = runTradeCalibration({
    datasets,
    settings: SETTINGS,
    samplesPerSeason: 1,
  });
  assert.ok(trade.overall.candidates > 0);
  assert.ok(Number.isFinite(trade.overall.utilityCorrelation));
  assert.ok(Number.isFinite(trade.overall.decisionCorrelation));
  assert.equal(trade.policy.selectedWithoutHoldout, true);
  assert.equal(trade.policy.holdoutSeason, 2023);
  assert.ok(trade.policy.utilityShare >= 0 && trade.policy.utilityShare <= 1);
  assert.ok(Number.isFinite(trade.policy.normalization.utilityStdDev));
  assert.ok(trade.overall.recommendationPrecision >= 0);
  assert.ok(trade.overall.recommendationPrecision <= 1);

  const waivers = runWaiverCalibration({
    datasets,
    settings: SETTINGS,
    samplesPerSeason: 2,
    week: 5,
  });
  assert.equal(waivers.overall.scenarios, 4);
  assert.ok(Number.isFinite(waivers.overall.oracleActualGain));
  assert.equal(waivers.policy.selectedWithoutHoldout, true);
  assert.equal(waivers.policy.holdoutSeason, 2023);
  assert.equal(
    waivers.policy.utilityRerank,
    waivers.policy.challengerSelected && waivers.policy.holdoutPassed,
  );
  assert.ok(waivers.overall.oracleHitRate >= 0 && waivers.overall.oracleHitRate <= 1);
});
