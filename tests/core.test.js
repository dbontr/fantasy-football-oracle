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
