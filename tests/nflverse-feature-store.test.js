"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  NflverseFeatureStore,
  datasetUrl,
  normalizeDesignation,
  normalizePractice,
} = require("../server/nflverse-feature-store.js");
const { PlayerIdentityResolver } = require("../server/player-identity.js");

const NOW = Date.parse("2026-09-22T12:00:00Z");
const players = [
  { id: "1", name: "Alpha Receiver", position: "WR", team: "KC" },
  { id: "2", name: "Beta Runner", position: "RB", team: "BUF" },
];
const dataset = {
  players,
  schedule: {
    KC: { weeks: [{}, {}, { opponent: "BUF" }] },
    BUF: { weeks: [{}, {}, { opponent: "KC" }] },
  },
};

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-nflverse-features-"));
  const files = {};
  async function write(name, content) {
    const file = path.join(directory, `${name}.csv`);
    await fs.writeFile(file, `${content.trim()}\n`, "utf8");
    files[name] = file;
  }

  await write("injuries", `season,season_type,team,week,gsis_id,position,full_name,report_primary_injury,report_status,practice_status
2026,REG,KC,2,00-1,WR,Alpha Receiver,Hamstring,Questionable,Limited Participation in Practice
2026,REG,KC,4,00-1,WR,Alpha Receiver,Hamstring,Out,Did Not Participate In Practice`);
  await write("depthCharts", `dt,team,player_name,espn_id,gsis_id,pos_grp,pos_abb,pos_name,pos_slot,pos_rank
2026-09-20T10:00:00Z,KC,Alpha Receiver,1,00-1,Wide Receiver,WR,Wide Receiver,1,2
2026-09-23T10:00:00Z,KC,Alpha Receiver,1,00-1,Wide Receiver,WR,Wide Receiver,1,1`);
  await write("snapCounts", `game_id,season,game_type,week,player,position,team,opponent,offense_snaps,offense_pct
2026_01,2026,REG,1,Alpha Receiver,WR,KC,BUF,40,0.50
2026_02,2026,REG,2,Alpha Receiver,WR,KC,BUF,60,0.75
2026_03,2026,REG,3,Alpha Receiver,WR,KC,BUF,70,0.90`);

  await write("weeklyRosters", `season,team,position,depth_chart_position,status,full_name,gsis_id,espn_id,sleeper_id,week,game_type,status_description_abbr
2026,KC,WR,WR,ACT,Alpha Receiver,00-1,1,s1,3,REG,A01
2026,KC,WR,WR,RES,Alpha Receiver,00-1,1,s1,4,REG,R01`);
  await write("teamStats", `season,week,team,season_type,opponent_team,attempts,sacks_suffered,carries,rushing_epa,passing_epa
2026,1,KC,REG,BUF,40,1,20,4,10
2026,2,KC,REG,BUF,38,2,22,2,8
2026,3,KC,REG,BUF,60,0,30,30,30
2026,1,BUF,REG,KC,25,5,30,-4,-8
2026,2,BUF,REG,KC,28,4,28,-2,-6`);

  const identity = new PlayerIdentityResolver(players);
  identity.registerRecords([
    { espn_id: "1", gsis_id: "00-1", sleeper_id: "s1", full_name: "Alpha Receiver", position: "WR", team: "KC" },
    { espn_id: "2", gsis_id: "00-2", full_name: "Beta Runner", position: "RB", team: "BUF" },
  ], { source: "test" });
  return { directory, files, identity };
}

async function cleanup(context) {
  await fs.rm(context.directory, { recursive: true, force: true });
}

test("nflverse feature normalization is explicit", () => {
  assert.equal(normalizeDesignation("Questionable"), "questionable");
  assert.equal(normalizeDesignation("Reserve/Injured"), "ir");
  assert.equal(normalizePractice("Limited Participation in Practice"), "limited");
  assert.equal(normalizePractice("Did Not Participate In Practice"), "dnp");
  assert.match(datasetUrl("snapCounts", 2026), /snap_counts_2026\.csv$/);
});

test("feature store emits leakage-safe health, role, line, pace, and matchup evidence", async () => {
  const context = await fixture();
  try {
    const mapping = {
      injuries: context.files.injuries,
      depth_charts: context.files.depthCharts,
      snap_counts: context.files.snapCounts,
      weekly_rosters: context.files.weeklyRosters,
      stats_team: context.files.teamStats,
    };
    const store = new NflverseFeatureStore({
      cache: {
        async fetchBuffer(_source, url) {
          const key = Object.keys(mapping).find((name) => url.includes(`/${name}/`));
          return { payloadPath: mapping[key], stale: false, metadata: {} };
        },
      },
      identityResolver: context.identity,
      datasetProvider: () => dataset,
      clock: () => NOW,
    });
    const result = await store.sync({ season: 2026, currentWeek: 3, lookback: 4, asOf: NOW });
    assert.equal(result.successes, 5);
    assert.equal(result.failures, 0);
    assert.equal(result.stale, false);

    const byFeature = new Map(result.observations.map((row) => [
      `${row.entityType}:${row.entityId}:${row.feature}`, row,
    ]));
    assert.equal(byFeature.get("player:1:availability.designation").value, "active");
    assert.equal(byFeature.get("player:1:health.practice_participation").value, "limited");
    assert.equal(byFeature.get("player:1:role.depth_chart_order").value, 2);
    assert.ok(byFeature.get("player:1:role.snap_share").value > 0.64);
    assert.ok(byFeature.get("player:1:role.snap_share").value < 0.65);

    assert.ok(byFeature.get("team:KC:team.pace_grade").value > 0);
    assert.ok(byFeature.get("team:KC:line.pass_block_grade").value > 0);
    assert.ok(byFeature.get("team:KC:line.run_block_grade").value > 0);
    assert.ok(byFeature.get("team:KC:matchup.pass_grade").value > 0);
    assert.ok(byFeature.get("team:KC:matchup.rush_grade").value > 0);
    assert.deepEqual(
      byFeature.get("team:KC:team.pace_grade").metadata.lookbackWeeks,
      [2, 1],
    );
    assert.equal(JSON.stringify(result).includes('"week":3'), true);
    assert.equal(result.observations.some((row) => (
      row.metadata.dataset === "snap_counts" && row.metadata.lookbackWeeks.includes(3)
    )), false);
  } finally {
    await cleanup(context);
  }
});

test("feature store isolates a missing optional release", async () => {
  const context = await fixture();
  try {
    const store = new NflverseFeatureStore({
      cache: {
        async fetchBuffer(_source, url) {
          if (url.includes("/depth_charts/")) {
            throw Object.assign(new Error("not published"), { code: "FREE_SOURCE_HTTP_ERROR" });
          }
          const mapping = {
            injuries: context.files.injuries,
            snap_counts: context.files.snapCounts,
            weekly_rosters: context.files.weeklyRosters,
            stats_team: context.files.teamStats,
          };
          const key = Object.keys(mapping).find((name) => url.includes(`/${name}/`));
          return { payloadPath: mapping[key], stale: false, metadata: {} };
        },
      },
      identityResolver: context.identity,
      datasetProvider: () => dataset,
      clock: () => NOW,
    });

    const result = await store.sync({ season: 2026, currentWeek: 3 });
    assert.equal(result.successes, 4);
    assert.equal(result.failures, 1);
    assert.equal(result.feeds.depthCharts.ok, false);
    assert.equal(result.feeds.depthCharts.error.code, "FREE_SOURCE_HTTP_ERROR");
    assert.ok(result.observations.length > 0);
  } finally {
    await cleanup(context);
  }
});
