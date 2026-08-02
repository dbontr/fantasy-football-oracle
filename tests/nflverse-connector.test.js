"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { NflverseConnector, normalizeWeeklyOutcome } = require("../server/nflverse-connector.js");
const { PlayerIdentityResolver } = require("../server/player-identity.js");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-nflverse-"));
  const playerPath = path.join(directory, "players.csv");
  const statsPath = path.join(directory, "stats.csv");
  await fs.writeFile(playerPath, [
    "gsis_id,espn_id,sleeper_id,display_name,position,latest_team",
    "GIBBS,4429795,s1,Jahmyr Gibbs,RB,DET",
    "MONTY,4040655,s2,David Montgomery,RB,DET",
    "OLD,,old,Historical Player,WR,DET",
  ].join("\n"));
  const rows = [
    "season,week,season_type,player_id,player_display_name,position,recent_team,fantasy_points,fantasy_points_ppr,receptions,targets,carries,attempts,games",
    "2026,1,REG,GIBBS,Jahmyr Gibbs,RB,DET,14,18,4,5,12,0,1",
    "2026,1,REG,MONTY,David Montgomery,RB,DET,8,9,1,2,10,0,1",
    "2026,2,REG,GIBBS,Jahmyr Gibbs,RB,DET,16,21,5,6,14,0,1",
    "2026,2,REG,MONTY,David Montgomery,RB,DET,7,8,1,2,8,0,1",
    "2026,3,REG,GIBBS,Jahmyr Gibbs,RB,DET,20,24,4,5,16,0,1",
    "2026,3,REG,MONTY,David Montgomery,RB,DET,6,7,1,2,7,0,1",
    "2026,4,REG,GIBBS,Jahmyr Gibbs,RB,DET,30,35,5,6,20,0,1",
    "2026,1,REG,OLD,Historical Player,WR,DET,10,12,2,4,0,0,1",
  ];
  await fs.writeFile(statsPath, rows.join("\n"));
  const cache = {
    async fetchBuffer(_source, url) {
      return {
        payloadPath: url.includes("players.csv") ? playerPath : statsPath,
        stale: false,
        metadata: { digest: "b".repeat(64), fetchedAt: "2026-09-20T00:00:00.000Z" },
      };
    },
  };
  return { directory, cache };
}

test("nflverse outcome normalization preserves scoring and availability", () => {
  const row = normalizeWeeklyOutcome({
    season: "2025",
    week: "3",
    season_type: "REG",
    player_id: "P1",
    player_display_name: "Player One",
    position: "WR",
    recent_team: "JAC",
    fantasy_points: "10",
    receptions: "4",
    targets: "6",
    carries: "1",
    games: "1",
  });
  assert.equal(row.pointsPpr, 14);
  assert.equal(row.pointsHalf, 12);
  assert.equal(row.opportunities, 7);
  assert.equal(row.team, "JAX");
  assert.equal(row.played, true);
});

test("nflverse sync learns identities and emits leakage-safe rolling evidence", async () => {
  const context = await fixture();
  try {
    const identity = new PlayerIdentityResolver([
      { id: "4429795", name: "Jahmyr Gibbs", position: "RB", team: "DET" },
      { id: "4040655", name: "David Montgomery", position: "RB", team: "DET" },
    ]);
    const connector = new NflverseConnector({
      cache: context.cache,
      identityResolver: identity,
      clock: () => Date.parse("2026-09-24T12:00:00.000Z"),
    });
    const result = await connector.sync({ season: 2026, currentWeek: 4, lookback: 3 });
    assert.equal(result.outcomeSummary.rows, 8);
    assert.equal(result.outcomeSummary.matched, 7);
    assert.deepEqual(result.outcomeSummary.completedWeeks, [1, 2, 3]);
    assert.equal(result.stale, false);
    assert.equal(identity.resolve({ gsis_id: "GIBBS" }).oraclePlayerId, "4429795");

    const gibbs = result.observations.filter((row) => row.entityId === "4429795");
    assert.ok(gibbs.some((row) => row.feature === "role.expected_opportunities"));
    assert.ok(gibbs.some((row) => row.feature === "efficiency.expected_points_per_opportunity"));
    assert.ok(gibbs.some((row) => row.feature === "role.target_share"));
    assert.ok(gibbs.some((row) => row.feature === "role.carry_share"));
    assert.equal(gibbs.every((row) => row.metadata.lookbackWeeks.every((week) => week < 4)), true);
    assert.equal(
      Math.round(gibbs.find((row) => row.feature === "role.expected_opportunities").value),
      19,
    );
  } finally {
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});
