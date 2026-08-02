#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { retry, withTimeout } = require("../server/resilience.js");
const { createLineage, sha256 } = require("../server/lineage.js");

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

const POSITION_VOLATILITY = {
  QB: 0.28,
  RB: 0.42,
  WR: 0.48,
  TE: 0.50,
  K: 0.45,
  DST: 0.55,
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
    "Build the browser player and schedule snapshot from ESPN's public feeds.",
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

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((total, value) => total + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
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

function weeklyProjectionArray(stats, season) {
  const weekly = Array.from({ length: 18 }, () => 0);
  (stats || []).forEach((item) => {
    const week = Number(item.scoringPeriodId);
    if (
      Number(item.seasonId) === Number(season) &&
      Number(item.statSourceId) === 1 &&
      Number(item.statSplitTypeId) === 1 &&
      week >= 1 && week <= 18
    ) {
      weekly[week - 1] = round(item.appliedTotal, 2);
    }
  });
  return weekly;
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

async function fetchJson(url, options = {}) {
  const name = String(options.name || new URL(url).hostname);
  const startedAt = Date.now();
  let attempts = 0;
  try {
    const payload = await retry(async () => {
      attempts += 1;
      return withTimeout(async () => {
        const response = await fetch(url, { headers: options.headers || {} });
        if (!response.ok) {
          const error = new Error(`${name} returned HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return response.json();
      }, options.timeoutMs || 8_000, name);
    }, {
      attempts: options.attempts || 3,
      baseDelayMs: options.baseDelayMs || 150,
      maxDelayMs: options.maxDelayMs || 1_500,
    });
    const fetchedAt = new Date().toISOString();
    const lineage = createLineage({
      kind: "feed-snapshot",
      schemaVersion: "external-feed/v1",
      source: name,
      fetchedAt,
      confidence: options.required === true ? 0.9 : 0.75,
      payload,
      metadata: { url, attempts },
    });
    const telemetry = {
      name,
      required: options.required === true,
      ok: true,
      attempts,
      elapsedMs: Date.now() - startedAt,
      fetchedAt,
      payloadHash: lineage.payloadHash,
      lineageHash: lineage.lineageHash,
      error: null,
    };
    options.telemetry?.push(telemetry);
    return payload;
  } catch (error) {
    options.telemetry?.push({
      name,
      required: options.required === true,
      ok: false,
      attempts,
      elapsedMs: Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
      payloadHash: null,
      error: error.message,
    });
    throw error;
  }
}

async function fetchPlayers(season, limit, telemetry) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;
  const filter = {
    players: {
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
    },
  };
  return fetchJson(url, {
    name: "espn-fantasy-players",
    required: true,
    telemetry,
    timeoutMs: 10_000,
    headers: {
      "x-fantasy-filter": JSON.stringify(filter),
      "user-agent": "fantasy-football-oracle-data-builder/4.0",
    },
  });
}

const TEAM_ALIASES = Object.freeze({ JAC: "JAX", LA: "LAR" });

function normalizeTeam(value) {
  const team = String(value || "FA").toUpperCase();
  return TEAM_ALIASES[team] || team;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function fetchSleeperPlayers(telemetry) {
  return fetchJson("https://api.sleeper.app/v1/players/nfl", {
    name: "sleeper-players",
    telemetry,
    timeoutMs: 8_000,
    headers: { "user-agent": "fantasy-football-oracle-data-builder/4.0" },
  });
}

async function fetchEspnNews(limit = 150, telemetry) {
  return fetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=${limit}`,
    {
      name: "espn-news",
      telemetry,
      timeoutMs: 8_000,
      headers: { "user-agent": "fantasy-football-oracle-data-builder/4.0" },
    },
  );
}

async function fetchSchedule(season, telemetry) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules`;
  return fetchJson(url, {
    name: "espn-nfl-schedule",
    required: true,
    telemetry,
    timeoutMs: 10_000,
    headers: { "user-agent": "fantasy-football-oracle-data-builder/4.0" },
  });
}

function buildSleeperIndex(payload) {
  const byEspn = new Map();
  const byIdentity = new Map();
  for (const row of Object.values(payload || {})) {
    if (!row || !row.full_name) continue;
    if (row.espn_id !== null && row.espn_id !== undefined) {
      byEspn.set(String(row.espn_id), row);
    }
    const position = String(row.position || row.fantasy_positions?.[0] || "").toUpperCase();
    const key = [normalizeName(row.full_name), normalizeTeam(row.team), position].join("|");
    byIdentity.set(key, row);
  }
  return { byEspn, byIdentity };
}

function buildNewsIndex(payload) {
  const byEspn = new Map();
  for (const article of payload?.articles || []) {
    const athletes = (article.categories || [])
      .filter((category) => category.type === "athlete" && category.athlete?.id)
      .map((category) => ({
        id: String(category.athlete.id),
        name: String(category.description || ""),
      }));
    if (!athletes.length) continue;
    const headline = String(article.headline || "");
    for (const athlete of athletes) {
      const surname = normalizeName(athlete.name.split(/\s+/).pop());
      const headlineKey = normalizeName(headline);
      const compact = {
        headline,
        description: String(article.description || ""),
        published: String(article.published || ""),
        link: String(article.links?.web?.href || ""),
        source: "ESPN",
        playerName: athlete.name,
        athleteCount: athletes.length,
        focused: athletes.length === 1 || (surname.length >= 4 && headlineKey.includes(surname)),
      };
      if (!byEspn.has(athlete.id)) byEspn.set(athlete.id, []);
      byEspn.get(athlete.id).push(compact);
    }
  }
  for (const rows of byEspn.values()) {
    rows.sort((left, right) => Date.parse(right.published || 0) - Date.parse(left.published || 0));
    rows.splice(5);
  }
  return byEspn;
}

function sleeperForPlayer(player, index) {
  const direct = index.byEspn.get(String(player.id));
  if (direct) return direct;
  const key = [normalizeName(player.name), normalizeTeam(player.team), player.position].join("|");
  return index.byIdentity.get(key) || null;
}

function enrichPlayerHealth(player, sleeperIndex, newsIndex) {
  const sleeper = sleeperForPlayer(player, sleeperIndex);
  const news = newsIndex.get(String(player.id)) || [];
  const sleeperNews = finite(sleeper?.news_updated, 0);
  const articleNews = Math.max(0, ...news.map((article) => Date.parse(article.published || 0) || 0));
  const status = String(sleeper?.injury_status || player.injuryStatus || "ACTIVE");
  return {
    ...player,
    injuryStatus: status,
    lastNewsDate: Math.max(player.lastNewsDate || 0, sleeperNews, articleNews),
    healthSource: sleeper ? {
      sleeperId: String(sleeper.player_id || ""),
      gsisId: String(sleeper.gsis_id || ""),
      injuryStatus: String(sleeper.injury_status || ""),
      injuryBodyPart: String(sleeper.injury_body_part || ""),
      injuryNotes: String(sleeper.injury_notes || ""),
      injuryStartDate: sleeper.injury_start_date || null,
      practiceParticipation: String(sleeper.practice_participation || ""),
      practiceDescription: String(sleeper.practice_description || ""),
      newsUpdated: sleeperNews,
      depthChartOrder: finite(sleeper.depth_chart_order, 0),
      rosterStatus: String(sleeper.status || ""),
    } : null,
    news,
  };
}

function normalizeSchedule(payload) {
  const proTeams = payload?.settings?.proTeams || [];
  const schedule = {};
  proTeams.forEach((team) => {
    const abbreviation = TEAM_BY_ID[Number(team.id)] || String(team.abbrev || "").toUpperCase();
    if (!abbreviation || abbreviation === "FA") return;
    const weeks = Array.from({ length: 18 }, () => null);
    Object.entries(team.proGamesByScoringPeriod || {}).forEach(([weekKey, games]) => {
      const week = Number(weekKey);
      const game = Array.isArray(games) ? games[0] : null;
      if (!game || week < 1 || week > 18) return;
      const isHome = Number(game.homeProTeamId) === Number(team.id);
      const opponentId = isHome ? Number(game.awayProTeamId) : Number(game.homeProTeamId);
      weeks[week - 1] = {
        opponent: TEAM_BY_ID[opponentId] || "TBD",
        home: isHome,
        date: finite(game.date, 0),
        detail: String(game.detail || "TBD"),
        indoor: Boolean(game.indoor),
      };
    });
    schedule[abbreviation] = {
      proTeamId: Number(team.id),
      name: [team.location, team.name].filter(Boolean).join(" "),
      byeWeek: finite(team.byeWeek, 0),
      weeks,
    };
  });
  return schedule;
}

function projectionRange(position, weeklyValues, risk, previous, projection) {
  const activeWeeks = weeklyValues.filter((value) => value > 0);
  const weeklyMean = activeWeeks.length ? mean(activeWeeks) : projection / 17;
  const scheduleVariation = standardDeviation(activeWeeks);
  const baseVolatility = POSITION_VOLATILITY[position] || 0.45;
  const priorGap = previous > 0 ? Math.abs(projection - previous) / Math.max(1, previous) : 0.35;
  const modeledDeviation = Math.max(
    scheduleVariation,
    weeklyMean * baseVolatility * (0.8 + risk * 0.55 + Math.min(0.35, priorGap) * 0.45),
  );
  const floor = Math.max(0, weeklyMean - modeledDeviation);
  const ceiling = weeklyMean + modeledDeviation * 1.45;
  const reliability = Math.max(0.3, Math.min(
    0.97,
    0.94 - risk * 0.48 - Math.min(0.28, priorGap * 0.22) - (previous <= 0 ? 0.12 : 0),
  ));
  return {
    weeklyMean: round(weeklyMean, 2),
    projectionStdDev: round(modeledDeviation, 2),
    floorProjection: round(floor, 2),
    ceilingProjection: round(ceiling, 2),
    reliability: round(reliability, 3),
  };
}

function normalizePlayer(wrapper, season, schedule) {
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
  const weeklyProjections = weeklyProjectionArray(player.stats, season);
  const risk = injuryRisk(player.injuryStatus);
  const range = projectionRange(position, weeklyProjections, risk, previous, projection);
  const teamSchedule = schedule[team] || {};

  return {
    id: String(player.id || wrapper.id),
    name: String(player.fullName || "Unknown player"),
    firstName: String(player.firstName || ""),
    lastName: String(player.lastName || ""),
    position,
    team,
    proTeamId: Number(player.proTeamId || 0),
    projectedPoints: round(projection, 2),
    weeklyProjection: range.weeklyMean,
    weeklyProjections,
    previousPoints: round(previous, 2),
    floorProjection: range.floorProjection,
    ceilingProjection: range.ceilingProjection,
    projectionStdDev: range.projectionStdDev,
    reliability: range.reliability,
    byeWeek: finite(teamSchedule.byeWeek, 0),
    adp: adp < 900 ? round(adp, 2) : null,
    adpTrend: round(ownership.averageDraftPositionPercentChange, 2),
    auctionValue: round(ownership.auctionValueAverage, 2),
    auctionTrend: round(ownership.auctionValueAverageChange, 2),
    activityLevel: round(ownership.activityLevel, 2),
    percentOwned: round(percentOwned, 2),
    percentStarted: round(ownership.percentStarted, 2),
    pprRank,
    standardRank,
    superflexRank,
    injuryStatus: String(player.injuryStatus || "ACTIVE"),
    injuryRisk: risk,
    active: player.active !== false,
    lastNewsDate: finite(player.lastNewsDate, 0),
    image: playerImage(player, team, position),
  };
}

function sortPlayers(a, b) {
  const rankA = a.pprRank || a.adp || 9999;
  const rankB = b.pprRank || b.adp || 9999;
  return rankA - rankB || b.projectedPoints - a.projectedPoints || a.name.localeCompare(b.name);
}

async function buildDataset(options = {}) {
  const season = Number(options.season || new Date().getUTCFullYear());
  const limit = Number(options.limit || 700);
  const feedTelemetry = [];
  const [playerPayload, schedulePayload] = await Promise.all([
    fetchPlayers(season, limit, feedTelemetry),
    fetchSchedule(season, feedTelemetry),
  ]);
  const [sleeperResult, newsResult] = await Promise.allSettled([
    fetchSleeperPlayers(feedTelemetry),
    fetchEspnNews(150, feedTelemetry),
  ]);
  const sleeperPayload = sleeperResult.status === "fulfilled" ? sleeperResult.value : {};
  const newsPayload = newsResult.status === "fulfilled" ? newsResult.value : { articles: [] };
  const sleeperIndex = buildSleeperIndex(sleeperPayload);
  const newsIndex = buildNewsIndex(newsPayload);
  const schedule = normalizeSchedule(schedulePayload);
  const players = (playerPayload.players || [])
    .map((row) => normalizePlayer(row, season, schedule))
    .filter(Boolean)
    .filter((player) => player.active || player.percentOwned >= 1)
    .map((player) => enrichPlayerHealth(player, sleeperIndex, newsIndex))
    .sort(sortPlayers);
  const requiredFeeds = feedTelemetry.filter((row) => row.required);
  const successfulFeeds = feedTelemetry.filter((row) => row.ok);
  const sourceDigest = sha256({
    season,
    feeds: successfulFeeds.map((row) => [row.name, row.payloadHash]).sort(),
  });
  return {
    meta: {
      version: 4,
      season,
      generatedAt: new Date().toISOString(),
      source: "Resilient ESPN Fantasy, ESPN News, and Sleeper public feeds",
      sourceDigest,
      scoring: "ESPN default PPR projection",
      weeks: 18,
      count: players.length,
      healthFeeds: {
        sleeper: sleeperResult.status === "fulfilled",
        espnNews: newsResult.status === "fulfilled",
      },
      provenance: {
        version: "oracle-feed-provenance-2026.1",
        requiredHealthy: requiredFeeds.every((row) => row.ok),
        allHealthy: feedTelemetry.every((row) => row.ok),
        liveFeeds: successfulFeeds.length,
        failedFeeds: feedTelemetry.length - successfulFeeds.length,
        feeds: feedTelemetry,
      },
    },
    schedule,
    players,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const output = await buildDataset(args);
  const outPath = path.resolve(
    process.cwd(),
    args.out || `data/players-${args.season}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: outPath,
    season: output.meta.season,
    players: output.players.length,
    teams: Object.keys(output.schedule).length,
    bytes: fs.statSync(outPath).size,
    positions: Object.fromEntries(
      [...new Set(Object.values(POSITION_BY_ID))].map((position) => [
        position,
        output.players.filter((player) => player.position === position).length,
      ]),
    ),
  }, null, 2));
}

module.exports = {
  buildDataset,
  normalizePlayer,
  normalizeSchedule,
  projectionRange,
  weeklyProjectionArray,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
