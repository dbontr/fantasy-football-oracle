"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PlayerIdentityResolver } = require("../server/player-identity.js");
const {
  SleeperConnector,
  normalizeSleeperPlayers,
  rosterMomentum,
  sleeperDesignation,
} = require("../server/sleeper-connector.js");

const players = [
  { id: "4429795", name: "Jahmyr Gibbs", position: "RB", team: "DET" },
  { id: "4362628", name: "Ja'Marr Chase", position: "WR", team: "CIN" },
];

function fixtureCache() {
  const calls = [];
  const responses = new Map([
    ["/v1/state/nfl", { season: "2026", week: 4, display_week: 4 }],
    ["/v1/players/nfl?active=true", {
      s1: {
        espn_id: "4429795",
        full_name: "Jahmyr Gibbs",
        position: "RB",
        team: "DET",
        injury_status: "Questionable",
        practice_participation: "Limited Practice",
        depth_chart_order: 1,
        status: "Active",
      },
      s2: {
        espn_id: "4362628",
        full_name: "Ja'Marr Chase",
        position: "WR",
        team: "CIN",
        status: "Active",
        depth_chart_order: 1,
      },
      unknown: {
        full_name: "Unknown Player",
        position: "WR",
        team: "FA",
        status: "Active",
      },
    }],
  ]);
  responses.set("/v1/players/nfl/trending/add?lookback_hours=24&limit=100", [
    { player_id: "s1", count: 100 },
  ]);
  responses.set("/v1/players/nfl/trending/drop?lookback_hours=24&limit=100", [
    { player_id: "s1", count: 10 },
  ]);
  responses.set("/v1/league/league-1", { league_id: "league-1", name: "Fixture League" });
  responses.set("/v1/league/league-1/rosters", [{ roster_id: 1, players: ["s1"] }]);
  responses.set("/v1/league/league-1/users", [{ user_id: "u1", display_name: "Manager" }]);
  responses.set("/v1/league/league-1/matchups/4", [{ roster_id: 1, matchup_id: 1 }]);
  return {
    calls,
    async fetchJson(source, value, options) {
      assert.equal(source, "sleeper");
      const pathname = new URL(value).pathname + new URL(value).search;
      calls.push({ pathname, options });
      if (!responses.has(pathname)) throw new Error(`No fixture for ${pathname}`);
      return {
        data: structuredClone(responses.get(pathname)),
        stale: false,
        metadata: { digest: "a".repeat(64) },
      };
    },
  };
}

test("Sleeper normalization and status mapping are bounded", () => {
  const normalized = normalizeSleeperPlayers({
    one: { full_name: "Player One", position: "DEF", team: "DET" },
    two: { full_name: "Player Two", position: "OL", team: "DET" },
  });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].position, "DST");
  assert.equal(normalized[0].sleeper_id, "one");
  assert.equal(sleeperDesignation({ injury_status: "Doubtful" }), "doubtful");
  assert.equal(sleeperDesignation({ status: "Injured Reserve" }), "ir");
  assert.ok(rosterMomentum(100, 10) > 0.7);
  assert.ok(rosterMomentum(10, 100) < -0.7);
});

test("Sleeper sync reconciles players and emits bounded evidence", async () => {
  const cache = fixtureCache();
  const identity = new PlayerIdentityResolver(players);
  const connector = new SleeperConnector({
    cache,
    identityResolver: identity,
    clock: () => Date.parse("2026-09-25T12:00:00.000Z"),
  });
  const result = await connector.sync({ leagueId: "league-1" });
  assert.equal(result.state.week, 4);
  assert.equal(result.players.received, 3);
  assert.equal(result.players.matched, 2);
  assert.equal(result.players.unresolved.length, 1);
  assert.equal(result.league.league.name, "Fixture League");
  assert.equal(result.stale, false);
  assert.equal(cache.calls.length, 8);

  const gibbs = result.observations.filter((row) => row.entityId === "4429795");
  assert.deepEqual(
    new Set(gibbs.map((row) => row.feature)),
    new Set([
      "availability.designation",
      "health.practice_participation",
      "role.depth_chart_order",
      "market.roster_momentum",
    ]),
  );
  assert.equal(
    gibbs.find((row) => row.feature === "availability.designation").value,
    "questionable",
  );
  assert.ok(gibbs.find((row) => row.feature === "market.roster_momentum").value > 0);
  assert.equal(identity.resolve({ sleeper_id: "s1" }).oraclePlayerId, "4429795");
});

test("Sleeper connector propagates stale source state", async () => {
  const cache = fixtureCache();
  const original = cache.fetchJson.bind(cache);
  cache.fetchJson = async (...args) => ({ ...(await original(...args)), stale: true });
  const connector = new SleeperConnector({
    cache,
    identityResolver: new PlayerIdentityResolver(players),
  });
  const result = await connector.sync();
  assert.equal(result.stale, true);
  assert.equal(result.league, null);
});
