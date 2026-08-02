const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decorateDraftRecommendations,
  decorateTradeAnalysis,
  decorateWaivers,
  evaluateRosterChange,
  rosterUtility,
} = require("../server/roster-utility.js");

const SETTINGS = {
  teams: 4,
  rounds: 8,
  draftPosition: 1,
  scoring: "ppr",
  riskTolerance: 0.5,
  slots: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 0, K: 0, BN: 3 },
};

function player(id, position, points, options = {}) {
  const weekly = points / 17;
  return {
    id: String(id),
    name: `${position} ${id}`,
    position,
    team: options.team || "AAA",
    projectedPoints: points,
    weeklyProjection: weekly,
    weeklyProjections: Array.from({ length: 18 }, (_, index) => (
      options.byeWeek === index + 1 ? 0 : weekly
    )),
    floorProjection: weekly * 0.65,
    ceilingProjection: weekly * 1.45,
    projectionStdDev: weekly * 0.35,
    reliability: options.reliability || 0.78,
    injuryRisk: options.injuryRisk || 0.08,
    byeWeek: options.byeWeek || 9,
    pprRank: options.rank || Number(id),
    standardRank: options.rank || Number(id),
    adp: options.rank || Number(id),
  };
}

const UNIVERSE = [
  player(1, "QB", 360, { rank: 10, byeWeek: 7 }),
  player(2, "QB", 280, { rank: 50, byeWeek: 11 }),
  player(3, "RB", 300, { rank: 4, byeWeek: 8 }),
  player(4, "RB", 220, { rank: 25, byeWeek: 10 }),
  player(5, "RB", 150, { rank: 80, byeWeek: 12 }),
  player(6, "WR", 290, { rank: 6, byeWeek: 6 }),
  player(7, "WR", 225, { rank: 28, byeWeek: 9 }),
  player(8, "WR", 145, { rank: 90, byeWeek: 13 }),
  player(9, "TE", 230, { rank: 20, byeWeek: 5 }),
  player(10, "TE", 135, { rank: 100, byeWeek: 14 }),
];

const CALIBRATION = {
  draftPolicy: { version: "test-draft", marketWeight: 0.72, modelWeight: 0.28 },
  decisionPolicies: {
    trade: { version: "test-trade", confidence: 0.53, utilityShare: 0.8, nativeShare: 0.2, normalization: { nativeMean: 5, nativeStdDev: 2, utilityMean: 0, utilityStdDev: 4 }, thresholdPrecision: 0.57, selectedWithoutHoldout: true, holdoutSeason: 2025 },
    waiver: { version: "test-waiver", utilityRerank: false, selectedWithoutHoldout: true, holdoutSeason: 2025 },
  },
  valueCurves: {
    ppr: Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => [position, [{
      rankStart: 1, rankEnd: 120, meanPoints: 200, medianPoints: 190,
      standardDeviation: 60, hitRate: 0.35, bustRate: 0.25, samples: 50,
    }]])),
  },
};

test("roster utility identifies and reduces the most important team need", () => {
  const roster = UNIVERSE.filter((row) => ["3", "4", "6", "7", "9", "10"].includes(row.id));
  const before = rosterUtility({ roster, players: UNIVERSE, settings: SETTINGS, startWeek: 1 });
  const change = evaluateRosterChange({
    beforeRoster: roster,
    afterRoster: [...roster, UNIVERSE[0]],
    players: UNIVERSE,
    settings: SETTINGS,
    startWeek: 1,
  });
  const qbBefore = before.needs.find((row) => row.position === "QB");
  const qbAfter = change.after.needs.find((row) => row.position === "QB");
  assert.ok(qbBefore.need > 50);
  assert.ok(qbAfter.need < qbBefore.need);
  assert.ok(change.delta.needReduction > 0);
  assert.ok(change.delta.averagePoints > 0);
});

test("draft decoration blends market evidence with roster need and utility", () => {
  const roster = [UNIVERSE[2], UNIVERSE[5], UNIVERSE[8]];
  const state = { picks: [], rosters: { "1": roster.map((row) => row.id) } };
  const rows = [
    { ...UNIVERSE[0], score: 80, reasons: [] },
    { ...UNIVERSE[3], score: 86, reasons: [] },
  ];
  const decorated = decorateDraftRecommendations(rows, {
    players: UNIVERSE,
    state,
    teamId: 1,
    settings: SETTINGS,
    calibration: CALIBRATION,
  });
  assert.equal(decorated.length, 2);
  assert.ok(decorated.every((row) => Number.isFinite(row.policyRank)));
  assert.equal(decorated[0].policyRank, 7.48);
  assert.equal(decorated[0].utilityRole, "advisory-explanation");
  assert.ok(decorated[0].policy.marketWeight === 0.72);
  assert.ok(decorated.some((row) => row.reasons.some((reason) => reason.includes("roster-need"))));
});

test("trade decoration reports multi-week need and historical confidence", () => {
  const roster = [UNIVERSE[2], UNIVERSE[3], UNIVERSE[5], UNIVERSE[6], UNIVERSE[8]];
  const decorated = decorateTradeAnalysis({
    score: 5,
    lineupGain: 1.2,
    assetGain: 4,
    fairness: 70,
  }, {
    roster,
    give: [UNIVERSE[3]],
    receive: [UNIVERSE[0]],
    players: UNIVERSE,
    settings: SETTINGS,
    week: 1,
    calibration: CALIBRATION,
  });
  assert.ok(Number.isFinite(decorated.decisionScore));
  assert.ok(decorated.rosterUtility.delta.needReduction > 0);
  assert.equal(decorated.historicalCalibration.version, "test-trade");
  assert.equal(decorated.historicalCalibration.confidence, 0.53);
  assert.equal(decorated.historicalCalibration.utilityShare, 0.8);
  assert.equal(decorated.historicalCalibration.selectedWithoutHoldout, true);
  assert.equal(decorated.historicalCalibration.holdoutSeason, 2025);
});

test("waiver decoration preserves the historically stronger base order", () => {
  const roster = [UNIVERSE[2], UNIVERSE[4], UNIVERSE[5], UNIVERSE[7], UNIVERSE[8]];
  const rows = [
    { add: UNIVERSE[0], drop: UNIVERSE[4], score: 9, reason: "base first" },
    { add: UNIVERSE[1], drop: UNIVERSE[7], score: 8, reason: "base second" },
  ];
  const decorated = decorateWaivers(rows, {
    roster,
    players: UNIVERSE,
    settings: SETTINGS,
    week: 5,
    calibration: CALIBRATION,
  });
  assert.equal(decorated[0].add.id, rows[0].add.id);
  assert.equal(decorated[1].add.id, rows[1].add.id);
  assert.equal(decorated[0].historicalCalibration.utilityRerank, false);
  assert.equal(decorated[0].historicalCalibration.selectedWithoutHoldout, true);
  assert.ok(Number.isFinite(decorated[0].decisionScore));
  assert.ok(decorated[0].rosterUtility.delta.needReduction > 0);
});
