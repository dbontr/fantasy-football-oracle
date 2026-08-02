#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { forEachCsvRow } = require("./lib/csv.js");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RAW = path.join(ROOT, "data", "historical", "raw");
const DEFAULT_CACHE = path.join(ROOT, "data", "historical", "cache");
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

const TEAM_BY_ID = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
  7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC",
  13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
  19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};

const TEAM_ALIASES = {
  JAC: "JAX", JAX: "JAX", GBP: "GB", KCC: "KC", LVR: "LV", NOS: "NO",
  SFO: "SF", TBB: "TB", WAS: "WSH", WFT: "WSH", OAK: "LV", STL: "LAR",
  SD: "LAC", SDG: "LAC", LA: "LAR",
};

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function canonicalName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTeam(value) {
  const team = String(value || "FA").toUpperCase();
  return TEAM_ALIASES[team] || team;
}

function parseArgs(argv) {
  const options = { seasons: [2021, 2022, 2023, 2024, 2025], limit: 360 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--seasons") options.seasons = argv[++index].split(",").map(Number);
    else if (value === "--limit") options.limit = Number(argv[++index]);
    else if (value === "--raw-dir") options.rawDir = argv[++index];
    else if (value === "--cache-dir") options.cacheDir = argv[++index];
    else if (value === "--force") options.force = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function printHelp() {
  console.log([
    "Build leakage-safe historical fantasy datasets.",
    "",
    "Usage:",
    "  node scripts/build-historical-data.js --seasons 2021,2022,2023,2024,2025",
    "",
    "The script caches public FantasyPros/nflverse source files under data/historical/raw.",
  ].join("\n"));
}

async function download(url, filePath, force = false) {
  if (!force && fs.existsSync(filePath) && fs.statSync(filePath).size > 128) return filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  const response = await fetch(url, {
    headers: { "user-agent": "fantasy-football-oracle-backtest/3.3" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  fs.renameSync(temporary, filePath);
  return filePath;
}

async function sourceFiles(options) {
  const rawDir = path.resolve(options.rawDir || DEFAULT_RAW);
  const files = {
    rankings: path.join(rawDir, "db_fpecr.csv.gz"),
    players: path.join(rawDir, "nflverse_players.csv"),
    stats: {},
  };
  await download("https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_fpecr.csv.gz", files.rankings, options.force);
  await download("https://github.com/nflverse/nflverse-data/releases/download/players/players.csv", files.players, options.force);
  const seasons = new Set(options.seasons.flatMap((season) => [season, season - 1]));
  for (const season of [...seasons].sort()) {
    const file = path.join(rawDir, `stats_player_week_${season}.csv`);
    await download(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`, file, options.force);
    files.stats[season] = file;
  }
  return files;
}

async function loadRankings(filePath, seasons) {
  const requested = new Set(seasons.map(Number));
  const selected = new Map();
  await forEachCsvRow(filePath, (row) => {
    if (row.page_type !== "redraft-overall" || row.ecr_type !== "ro") return;
    if (!SKILL_POSITIONS.has(String(row.pos || "").toUpperCase())) return;
    const date = String(row.scrape_date || "");
    const season = Number(date.slice(0, 4));
    if (!requested.has(season) || !/^\d{4}-08-\d{2}$/.test(date)) return;
    const ecr = finite(row.ecr, 0);
    if (ecr <= 0 || ecr > 500) return;
    let state = selected.get(season);
    if (!state || date > state.date) {
      state = { date, rows: new Map() };
      selected.set(season, state);
    }
    if (date !== state.date) return;
    const position = String(row.pos).toUpperCase();
    const name = String(row.player || "").trim();
    const key = `${canonicalName(name)}|${position}`;
    state.rows.set(key, {
      name,
      canonicalName: canonicalName(name),
      position,
      team: normalizeTeam(row.team || row.tm),
      ecr: round(ecr, 2),
      rankSd: round(row.sd, 2),
      bestRank: round(row.best, 2),
      worstRank: round(row.worst, 2),
      fantasyProsId: String(row.id || ""),
      rankDate: date,
    });
  });
  return Object.fromEntries([...selected].map(([season, state]) => [
    season,
    { date: state.date, rows: [...state.rows.values()].sort((a, b) => a.ecr - b.ecr) },
  ]));
}

async function loadPlayerMap(filePath) {
  const byName = new Map();
  await forEachCsvRow(filePath, (row) => {
    const position = String(row.position || "").toUpperCase();
    if (!SKILL_POSITIONS.has(position) || !row.gsis_id) return;
    const names = [row.display_name, row.football_name, `${row.first_name} ${row.last_name}`];
    for (const rawName of names) {
      const name = canonicalName(rawName);
      if (!name) continue;
      const key = `${name}|${position}`;
      if (!byName.has(key)) byName.set(key, []);
      if (!byName.get(key).some((candidate) => candidate.id === row.gsis_id)) {
        byName.get(key).push({
          id: row.gsis_id,
          name: row.display_name || rawName,
          position,
          latestTeam: normalizeTeam(row.latest_team),
          espnId: String(row.espn_id || ""),
        });
      }
    }
  });
  return byName;
}

function emptyActual() {
  return {
    ppr: Array.from({ length: 18 }, () => 0),
    half: Array.from({ length: 18 }, () => 0),
    standard: Array.from({ length: 18 }, () => 0),
    teams: new Set(),
    name: "",
    position: "",
  };
}

async function loadSeasonStats(filePath) {
  const byId = new Map();
  const byName = new Map();
  const teamWeeks = new Map();
  await forEachCsvRow(filePath, (row) => {
    const position = String(row.position || "").toUpperCase();
    const week = Number(row.week);
    if (!SKILL_POSITIONS.has(position) || row.season_type !== "REG" || week < 1 || week > 18) return;
    const id = String(row.player_id || "");
    if (!id) return;
    const actual = byId.get(id) || emptyActual();
    actual.name = row.player_display_name || row.player_name || actual.name;
    actual.position = position;
    const team = normalizeTeam(row.team);
    actual.teams.add(team);
    if (!teamWeeks.has(team)) teamWeeks.set(team, new Set());
    teamWeeks.get(team).add(week);
    const standard = finite(row.fantasy_points, 0);
    const receptions = finite(row.receptions, 0);
    actual.standard[week - 1] += standard;
    actual.half[week - 1] += standard + receptions * 0.5;
    actual.ppr[week - 1] += finite(row.fantasy_points_ppr, standard + receptions);
    byId.set(id, actual);
  });

  for (const [id, actual] of byId) {
    const key = `${canonicalName(actual.name)}|${actual.position}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id, actual });
  }
  return { byId, byName, teamWeeks };
}

function total(values) {
  return (values || []).reduce((sum, value) => sum + finite(value, 0), 0);
}

function selectActual(rank, stats, playerMap) {
  const key = `${rank.canonicalName}|${rank.position}`;
  const direct = stats.byName.get(key) || [];
  const teamMatch = direct.find((candidate) => candidate.actual.teams.has(rank.team));
  if (teamMatch) return teamMatch;
  if (direct.length === 1) return direct[0];
  const mapped = playerMap.get(key) || [];
  const mappedTeam = mapped.find((candidate) => candidate.latestTeam === rank.team);
  const selectedMap = mappedTeam || (mapped.length === 1 ? mapped[0] : null);
  if (selectedMap) {
    return { id: selectedMap.id, actual: stats.byId.get(selectedMap.id) || emptyActual() };
  }
  return direct[0] || null;
}

function projectionReliability(rank) {
  const normalizedSpread = finite(rank.rankSd, 0) / Math.max(12, finite(rank.ecr, 100));
  return round(clamp(0.91 - normalizedSpread * 0.9, 0.42, 0.94), 3);
}

function inferredDeviation(rank, previousPoints) {
  const rankSpread = Math.max(3, finite(rank.rankSd, 8));
  const priorScale = previousPoints > 0 ? Math.sqrt(previousPoints) * 0.65 : 8;
  return round(Math.max(rankSpread * 0.55, priorScale), 2);
}

function byeWeekForTeam(stats, team) {
  const played = stats.teamWeeks.get(normalizeTeam(team));
  if (!played) return 0;
  for (let week = 1; week <= 18; week += 1) {
    if (!played.has(week)) return week;
  }
  return 0;
}

function previousActual(rank, selected, stats, playerMap) {
  if (selected?.id && stats.byId.has(selected.id)) return stats.byId.get(selected.id);
  const key = `${rank.canonicalName}|${rank.position}`;
  const direct = stats.byName.get(key) || [];
  const teamMatch = direct.find((candidate) => candidate.actual.teams.has(rank.team));
  if (teamMatch) return teamMatch.actual;
  if (direct.length === 1) return direct[0].actual;
  const mapped = playerMap.get(key) || [];
  for (const candidate of mapped) {
    if (stats.byId.has(candidate.id)) return stats.byId.get(candidate.id);
  }
  return emptyActual();
}

function buildSeasonDataset(season, rankingState, currentStats, priorStats, playerMap, limit) {
  const players = rankingState.rows.slice(0, limit).map((rank, index) => {
    const selected = selectActual(rank, currentStats, playerMap);
    const actual = selected?.actual || emptyActual();
    const prior = previousActual(rank, selected, priorStats, playerMap);
    const actualPpr = actual.ppr.map((value) => round(value, 2));
    const actualHalf = actual.half.map((value) => round(value, 2));
    const actualStandard = actual.standard.map((value) => round(value, 2));
    const previousPoints = total(prior.ppr);
    const reliability = projectionReliability(rank);
    const deviation = inferredDeviation(rank, previousPoints);
    return {
      id: selected?.id || `historical:${season}:${rank.canonicalName}:${rank.position}`,
      name: rank.name,
      position: rank.position,
      team: rank.team,
      byeWeek: byeWeekForTeam(currentStats, rank.team),
      marketRank: rank.ecr,
      pprRank: rank.ecr,
      standardRank: rank.ecr,
      adp: rank.ecr,
      rankSd: rank.rankSd,
      bestRank: rank.bestRank,
      worstRank: rank.worstRank,
      previousPoints: round(previousPoints, 2),
      projectedPoints: 0,
      weeklyProjection: 0,
      weeklyProjections: Array.from({ length: 18 }, () => null),
      projectionStdDev: deviation,
      reliability,
      injuryRisk: 0.08,
      injuryStatus: "PRESEASON",
      actualWeeklyPpr: actualPpr,
      actualWeeklyHalf: actualHalf,
      actualWeeklyStandard: actualStandard,
      actualSeasonPpr: round(total(actualPpr), 2),
      actualSeasonHalf: round(total(actualHalf), 2),
      actualSeasonStandard: round(total(actualStandard), 2),
      actualRank: index + 1,
      sourceMapped: Boolean(selected),
    };
  });

  const mapped = players.filter((player) => player.sourceMapped).length;
  const active = players.filter((player) => player.actualSeasonPpr > 0).length;
  return {
    meta: {
      version: 1,
      season,
      rankDate: rankingState.date,
      generatedAt: new Date().toISOString(),
      sources: [
        "FantasyPros expert consensus archive via DynastyProcess",
        "nflverse weekly player statistics",
        "nflverse player identifier map",
      ],
      scoring: ["ppr", "half", "standard"],
      leakageSafe: true,
      count: players.length,
      mapped,
      active,
    },
    coverage: {
      identifierMap: round(mapped / Math.max(1, players.length), 4),
      playersWithPoints: round(active / Math.max(1, players.length), 4),
      rankDate: rankingState.date,
    },
    players,
  };
}

async function buildHistoricalData(options = {}) {
  const seasons = [...new Set(options.seasons.map(Number))].sort();
  const files = await sourceFiles({ ...options, seasons });
  const rankings = await loadRankings(files.rankings, seasons);
  const playerMap = await loadPlayerMap(files.players);
  const stats = {};
  for (const season of [...new Set(seasons.flatMap((value) => [value, value - 1]))].sort()) {
    stats[season] = await loadSeasonStats(files.stats[season]);
  }
  const outputDir = path.resolve(options.cacheDir || DEFAULT_CACHE);
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), seasons: {}, sourceFiles: files };
  for (const season of seasons) {
    if (!rankings[season]) throw new Error(`No August redraft ranking snapshot found for ${season}`);
    const dataset = buildSeasonDataset(
      season,
      rankings[season],
      stats[season],
      stats[season - 1],
      playerMap,
      options.limit,
    );
    const filePath = path.join(outputDir, `season-${season}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(dataset)}\n`);
    manifest.seasons[season] = { filePath, meta: dataset.meta, coverage: dataset.coverage };
  }
  fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const manifest = await buildHistoricalData(options);
  console.log(JSON.stringify({
    generatedAt: manifest.generatedAt,
    seasons: Object.fromEntries(Object.entries(manifest.seasons).map(([season, row]) => [
      season,
      {
        players: row.meta.count,
        mapped: row.meta.mapped,
        active: row.meta.active,
        rankDate: row.meta.rankDate,
        identifierCoverage: row.coverage.identifierMap,
      },
    ])),
  }, null, 2));
}

module.exports = {
  buildHistoricalData,
  buildSeasonDataset,
  canonicalName,
  loadPlayerMap,
  loadRankings,
  loadSeasonStats,
  normalizeTeam,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
