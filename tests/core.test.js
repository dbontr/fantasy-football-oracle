const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../app-core.js");

function player(id, position, weekly, extra = {}) {
  return {
    id,
    name: id,
    position,
    team: "KC",
    weeklyProjection: weekly,
    projectedPoints: weekly * 17,
    pprRank: extra.rank || 100,
    adp: extra.adp || 100,
    injuryRisk: extra.injuryRisk || 0,
    ...extra,
  };
}

const settings = core.cloneSettings({
  teams: 4,
  rounds: 5,
  draftPosition: 2,
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 0, K: 0, BN: 4 },
});

test("snake draft order reverses every round", () => {
  const order = core.generateSnakeOrder(3, 4).map((row) => row.teamId);
  assert.deepEqual(order, [1, 2, 3, 3, 2, 1, 1, 2, 3, 3, 2, 1]);
});
test("draft picks populate and undo the correct roster", () => {
  let state = core.createDraftState(settings);
  state = core.applyDraftPick(state, "alpha", settings);
  state = core.applyDraftPick(state, "beta", settings);
  assert.equal(state.picks[0].teamId, 1);
  assert.equal(state.picks[1].teamId, 2);
  assert.deepEqual(state.rosters["2"], ["beta"]);
  state = core.undoDraftPick(state);
  assert.equal(state.picks.length, 1);
  assert.deepEqual(state.rosters["2"], []);
});

test("lineup optimizer uses flex without displacing a stronger starter", () => {
  const roster = [
    player("qb", "QB", 20),
    player("rb1", "RB", 18),
    player("rb2", "RB", 17),
    player("rb3", "RB", 16),
    player("wr1", "WR", 19),
    player("wr2", "WR", 15),
    player("wr3", "WR", 9),
    player("te", "TE", 12),
  ];
  const result = core.optimizeLineup(roster, settings);
  const starterIds = result.starters.filter((row) => row.player).map((row) => row.player.id);
  assert.equal(result.filled, 7);
  assert.ok(starterIds.includes("rb3"));
  assert.ok(!starterIds.includes("wr3"));
  assert.equal(result.total, 117);
});
test("draft recommendations prioritize a missing high-value starter", () => {
  const pool = [
    player("elite-rb", "RB", 18, { rank: 5, adp: 5 }),
    player("bench-qb", "QB", 17, { rank: 60, adp: 60 }),
    player("wr", "WR", 15, { rank: 40, adp: 40 }),
    player("replacement-rb", "RB", 10, { rank: 120, adp: 120 }),
    player("replacement-wr", "WR", 10, { rank: 121, adp: 121 }),
    player("replacement-qb", "QB", 13, { rank: 100, adp: 100 }),
    player("replacement-te", "TE", 8, { rank: 140, adp: 140 }),
  ];
  const state = core.createDraftState(settings);
  state.rosters["2"] = ["bench-qb"];
  const recommendations = core.recommendPlayers(pool, state, settings, 2, 3);
  assert.equal(recommendations[0].id, "elite-rb");
  assert.ok(recommendations[0].reasons.some((reason) => reason.includes("starter need")));
});

test("trade analyzer rewards a real lineup upgrade", () => {
  const roster = [
    player("qb", "QB", 20), player("rb1", "RB", 18), player("rb2", "RB", 12),
    player("wr1", "WR", 17), player("wr2", "WR", 16), player("te", "TE", 10),
    player("bench", "RB", 7),
  ];
  const upgrade = player("upgrade", "RB", 19, { rank: 8, adp: 8 });
  const result = core.analyzeTrade({
    roster,
    give: [player("rb2", "RB", 12)],
    receive: [upgrade],
    players: [...roster, upgrade],
    settings,
  });
  assert.ok(result.lineupGain >= 7);
  assert.ok(result.score > 0);
  assert.match(result.verdict, /upgrade|accept|helpful/i);
});
test("waiver analysis identifies the best add and drop pair", () => {
  const roster = [
    player("qb", "QB", 20), player("rb1", "RB", 18), player("rb2", "RB", 14),
    player("wr1", "WR", 17), player("wr2", "WR", 15), player("te", "TE", 10),
    player("weak", "WR", 4),
  ];
  const freeAgents = [
    player("upgrade", "WR", 13, { rank: 55, adp: 55 }),
    player("minor", "TE", 8, { rank: 130, adp: 130 }),
  ];
  const suggestions = core.waiverRecommendations(roster, freeAgents, settings, 5);
  assert.equal(suggestions[0].add.id, "upgrade");
  assert.equal(suggestions[0].drop.id, "weak");
  assert.ok(suggestions[0].score > 0);
});

test("week projections respect schedule-specific values and bye weeks", () => {
  const weekly = player("weekly", "RB", 12, {
    weeklyProjections: [18, 16, 0, 15],
    byeWeek: 3,
  });
  assert.equal(core.playerWeekProjection(weekly, 1), 18);
  assert.equal(core.playerWeekProjection(weekly, 3), 0);
  assert.equal(core.playerWeekProjection(weekly, 9), 12);
});

test("conditional availability falls as the target pick gets later", () => {
  const early = player("early", "WR", 18, { adp: 8, rank: 8 });
  const later = player("later", "WR", 16, { adp: 40, rank: 40 });
  const earlyChance = core.conditionalAvailability(early, 5, 20, settings);
  const laterChance = core.conditionalAvailability(later, 5, 20, settings);
  assert.ok(earlyChance >= 0 && earlyChance <= 1);
  assert.ok(laterChance >= 0 && laterChance <= 1);
  assert.ok(laterChance > earlyChance);
  assert.ok(core.conditionalAvailability(later, 5, 30, settings) < laterChance);
});

test("seeded draft-window simulation is deterministic", () => {
  const pool = Array.from({ length: 36 }, (_, index) => {
    const position = ["RB", "WR", "QB", "TE"][index % 4];
    return player(`p${index + 1}`, position, 22 - index * 0.25, {
      adp: index + 1,
      rank: index + 1,
    });
  });
  const state = core.createDraftState(settings);
  const first = core.simulatePickWindow({
    players: pool,
    state,
    settings,
    targetTeamId: 2,
    simulations: 120,
    seed: 2026,
  });
  const second = core.simulatePickWindow({
    players: pool,
    state,
    settings,
    targetTeamId: 2,
    simulations: 120,
    seed: 2026,
  });
  assert.deepEqual(first.availabilityById, second.availabilityById);
  assert.equal(first.simulations, 120);
  assert.ok(first.targetPick > first.currentPick);
  Object.values(first.availabilityById).forEach((value) => {
    assert.ok(value >= 0 && value <= 1);
  });
});

test("advanced draft recommendations surface return chance and VONA", () => {
  const pool = [
    player("scarce-rb", "RB", 20, { adp: 6, rank: 6 }),
    player("deep-wr", "WR", 19, { adp: 30, rank: 30 }),
    player("rb2", "RB", 13, { adp: 45, rank: 45 }),
    player("wr2", "WR", 18, { adp: 34, rank: 34 }),
    player("qb1", "QB", 18, { adp: 35, rank: 35 }),
    player("te1", "TE", 12, { adp: 50, rank: 50 }),
  ];
  const state = core.createDraftState(settings);
  state.rosters["2"] = [];
  const recommendations = core.advancedDraftRecommendations(
    pool,
    state,
    settings,
    2,
    5,
  );
  assert.equal(recommendations[0].id, "scarce-rb");
  assert.ok(Number.isFinite(recommendations[0].vona));
  assert.ok(recommendations[0].returnChance >= 0 && recommendations[0].returnChance <= 1);
  assert.match(recommendations[0].decision, /draft|priority|value/i);
});

test("weekly roster analysis detects bye conflicts and produces a range", () => {
  const roster = [
    player("qb", "QB", 20, { weeklyProjections: [20, 0], byeWeek: 2, floorProjection: 14, ceilingProjection: 29 }),
    player("rb1", "RB", 18, { weeklyProjections: [18, 0], byeWeek: 2, floorProjection: 10, ceilingProjection: 28 }),
    player("rb2", "RB", 15, { weeklyProjections: [15, 15], floorProjection: 8, ceilingProjection: 24 }),
    player("wr1", "WR", 17, { weeklyProjections: [17, 17], floorProjection: 9, ceilingProjection: 27 }),
    player("wr2", "WR", 14, { weeklyProjections: [14, 14], floorProjection: 7, ceilingProjection: 23 }),
    player("te", "TE", 10, { weeklyProjections: [10, 10], floorProjection: 5, ceilingProjection: 17 }),
    player("bench", "RB", 9, { weeklyProjections: [9, 9] }),
  ];
  const analysis = core.analyzeRoster({ roster, players: roster, settings, week: 2 });
  assert.equal(analysis.week, 2);
  assert.ok(analysis.byePlayers.length >= 2);
  assert.ok(analysis.ceiling >= analysis.floor);
  assert.ok(analysis.strengthScore >= 0 && analysis.strengthScore <= 100);
});

test("trade generator returns proposals evaluated for both teams", () => {
  const userRoster = [
    player("uqb", "QB", 20), player("urb1", "RB", 18), player("urb2", "RB", 11),
    player("uwr1", "WR", 18), player("uwr2", "WR", 15), player("ute", "TE", 9),
    player("urb3", "RB", 10), player("uwr3", "WR", 8),
  ];
  const opponentRoster = [
    player("oqb", "QB", 19), player("orb1", "RB", 17), player("orb2", "RB", 15),
    player("owr1", "WR", 20), player("owr2", "WR", 11), player("ote", "TE", 12),
    player("owr3", "WR", 10), player("orb3", "RB", 8),
  ];
  const proposals = core.generateTradeProposals({
    userRoster,
    opponentRoster,
    players: [...userRoster, ...opponentRoster],
    settings,
    limit: 8,
  });
  assert.ok(Array.isArray(proposals));
  proposals.forEach((proposal) => {
    assert.ok(proposal.userAnalysis);
    assert.ok(proposal.opponentAnalysis);
    assert.ok(proposal.fairness >= 0 && proposal.fairness <= 100);
  });
});
