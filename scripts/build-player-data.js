#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const POSITION_BY_ID = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "DST",
};

const TEAM_BY_ID = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE",
  6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND",
  12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE",
  18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
  24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR",
  30: "JAX", 33: "BAL", 34: "HOU",
};

function parseArgs(argv) {
  const args = { season: new Date().getUTCFullYear(), limit: 700 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--season" && argv[index + 1]) {
      args.season = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--limit" && argv[index + 1]) {
      args.limit = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--out" && argv[index + 1]) {
      args.out = argv[index + 1];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function printHelp() {
  console.log([
    "Build the compact browser player snapshot from ESPN's public player feed.",
    "",
    "Usage:",
    "  node scripts/build-player-data.js --season 2026 --limit 700",
    "",
    "Options:",
    "  --season <year>",
    "  --limit <players>",
    "  --out <json>",
  ].join("\n"));
}
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function seasonTotal(stats, season, sourceId) {
  const row = (stats || []).find((item) => (
    Number(item.seasonId) === Number(season) &&
    Number(item.scoringPeriodId) === 0 &&
    Number(item.statSourceId) === Number(sourceId) &&
    Number(item.statSplitTypeId) === 0
  ));
  return row ? finite(row.appliedTotal, 0) : 0;
}

function draftRank(player, rankType) {
  const row = player?.draftRanksByRankType?.[rankType];
  return row && finite(row.rank, 0) > 0 ? finite(row.rank) : null;
}

function injuryRisk(status) {
  const normalized = String(status || "ACTIVE").toUpperCase();
  if (normalized.includes("OUT") || normalized.includes("IR")) return 0.92;
  if (normalized.includes("DOUBTFUL")) return 0.72;
  if (normalized.includes("QUESTIONABLE")) return 0.38;
  if (normalized.includes("SUSPENSION")) return 0.55;
  return 0.08;
}

function playerImage(player, team, position) {
  if (position === "DST") {
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(team).toLowerCase()}.png`;
  }
  return `https://a.espncdn.com/i/headshots/nfl/players/full/${player.id}.png`;
}
async function fetchPlayers(season, limit) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;
  const filter = {
    players: {
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  const response = await fetch(url, {
    headers: {
      "x-fantasy-filter": JSON.stringify(filter),
      "user-agent": "fantasy-football-oracle-data-builder/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`ESPN player feed returned HTTP ${response.status}`);
  }
  return response.json();
}

function normalizePlayer(wrapper, season) {
  const player = wrapper?.player || {};
  const position = POSITION_BY_ID[Number(player.defaultPositionId)];
  if (!position) return null;

  const team = TEAM_BY_ID[Number(player.proTeamId)] || "FA";
  const projected = seasonTotal(player.stats, season, 1);
  const previous = seasonTotal(player.stats, season - 1, 0);
  const pprRank = draftRank(player, "PPR");
  const standardRank = draftRank(player, "STANDARD");
  const superflexRank = draftRank(player, "SUPERFLEX");
  const ownership = player.ownership || {};
  const adp = finite(ownership.averageDraftPosition, 999);
  const percentOwned = finite(ownership.percentOwned, 0);
  const projection = projected > 0 ? projected : Math.max(0, previous * 0.92);
  return {
    id: String(player.id || wrapper.id),
    name: String(player.fullName || "Unknown player"),
    firstName: String(player.firstName || ""),
    lastName: String(player.lastName || ""),
    position,
    team,
    proTeamId: Number(player.proTeamId || 0),
    projectedPoints: Number(projection.toFixed(2)),
    weeklyProjection: Number((projection / 17).toFixed(2)),
    previousPoints: Number(previous.toFixed(2)),
    adp: adp < 900 ? Number(adp.toFixed(2)) : null,
    auctionValue: Number(finite(ownership.auctionValueAverage, 0).toFixed(2)),
    percentOwned: Number(percentOwned.toFixed(2)),
    percentStarted: Number(finite(ownership.percentStarted, 0).toFixed(2)),
    pprRank,
    standardRank,
    superflexRank,
    injuryStatus: String(player.injuryStatus || "ACTIVE"),
    injuryRisk: injuryRisk(player.injuryStatus),
    active: player.active !== false,
    image: playerImage(player, team, position),
  };
}

function sortPlayers(a, b) {
  const rankA = a.pprRank || a.adp || 9999;
  const rankB = b.pprRank || b.adp || 9999;
  return rankA - rankB || b.projectedPoints - a.projectedPoints || a.name.localeCompare(b.name);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const payload = await fetchPlayers(args.season, args.limit);
  const players = (payload.players || [])
    .map((row) => normalizePlayer(row, args.season))
    .filter(Boolean)
    .filter((player) => player.active || player.percentOwned >= 1)
    .sort(sortPlayers);
  const output = {
    meta: {
      season: args.season,
      generatedAt: new Date().toISOString(),
      source: "ESPN Fantasy public player feed",
      scoring: "ESPN default PPR projection",
      count: players.length,
    },
    players,
  };

  const outPath = path.resolve(
    process.cwd(),
    args.out || `data/players-${args.season}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: outPath,
    season: args.season,
    fetched: payload.players?.length || 0,
    players: players.length,
    positions: Object.fromEntries(
      Object.keys(POSITION_BY_ID).map((id) => {
        const position = POSITION_BY_ID[id];
        return [position, players.filter((player) => player.position === position).length];
      }),
    ),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
