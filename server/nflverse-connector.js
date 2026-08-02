"use strict";

const { forEachCsvRow } = require("../scripts/lib/csv.js");
const { DAY_MS } = require("./free-source-catalog.js");
const { normalizePosition, normalizeTeam } = require("./player-identity.js");

const NFLVERSE_CONNECTOR_VERSION = "oracle-nflverse-connector-2026.1";
const RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function playerUrl() {
  return `${RELEASE_BASE}/players/players.csv`;
}

function weeklyStatsUrl(season) {
  return `${RELEASE_BASE}/stats_player/stats_player_week_${season}.csv`;
}

function normalizedPlayerRow(row = {}) {
  return {
    espn_id: row.espn_id ? String(row.espn_id) : null,
    gsis_id: row.gsis_id ? String(row.gsis_id) : null,
    sleeper_id: row.sleeper_id ? String(row.sleeper_id) : null,
    sportradar_id: row.sportradar_id ? String(row.sportradar_id) : null,
    display_name: row.display_name || row.football_name
      || [row.first_name, row.last_name].filter(Boolean).join(" "),
    position: normalizePosition(row.position),
    team: normalizeTeam(row.latest_team),
  };
}

function opportunityCount(row = {}) {
  const position = normalizePosition(row.position);
  const carries = finite(row.carries);
  const targets = finite(row.targets);
  const attempts = finite(row.attempts || row.passing_attempts);
  if (position === "QB") return attempts + carries;
  if (["RB", "WR", "TE"].includes(position)) return carries + targets;
  if (position === "K") {
    return finite(row.field_goal_attempts) + finite(row.extra_point_attempts);
  }
  return carries + targets + attempts;
}

function normalizeWeeklyOutcome(row = {}, seasonOverride = null) {
  const season = Number(seasonOverride || row.season);
  const week = Number(row.week);
  const position = normalizePosition(row.position);
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 22) return null;
  if (!SKILL_POSITIONS.has(position)) return null;
  if (row.season_type && String(row.season_type).toUpperCase() !== "REG") return null;
  const sourcePlayerId = String(row.player_id || row.gsis_id || "").trim();
  if (!sourcePlayerId) return null;
  const standard = finite(row.fantasy_points);
  const receptions = finite(row.receptions);
  const ppr = Number.isFinite(Number(row.fantasy_points_ppr))
    ? finite(row.fantasy_points_ppr)
    : standard + receptions;
  const opportunities = opportunityCount(row);
  const games = finite(row.games, Number.NaN);
  const played = Number.isFinite(games)
    ? games > 0
    : opportunities > 0 || receptions > 0 || standard !== 0;
  return {
    season,
    week,
    sourcePlayerId,
    oraclePlayerId: null,
    name: String(row.player_display_name || row.player_name || row.name || sourcePlayerId),
    position,
    team: normalizeTeam(row.team || row.recent_team),
    played,
    pointsPpr: ppr,
    pointsHalf: standard + receptions * 0.5,
    pointsStandard: standard,
    opportunities,
    pointsPerOpportunity: opportunities > 0 ? ppr / opportunities : null,
    receptions,
    targets: finite(row.targets),
    carries: finite(row.carries),
    passAttempts: finite(row.attempts || row.passing_attempts),
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function teamWeekTotals(outcomes) {
  const totals = new Map();
  for (const row of outcomes) {
    const key = `${row.team}|${row.week}`;
    const current = totals.get(key) || { targets: 0, carries: 0 };
    current.targets += row.targets;
    current.carries += row.carries;
    totals.set(key, current);
  }
  return totals;
}

function rollingEvidence(outcomes, options = {}) {
  const currentWeek = Math.max(1, Number(options.currentWeek || 1));
  const lookback = Math.min(8, Math.max(2, Number(options.lookback || 4)));
  const now = Number(options.now || Date.now());
  const observedAt = new Date(now).toISOString();
  const totals = teamWeekTotals(outcomes);
  const byPlayer = new Map();
  for (const row of outcomes) {
    if (!row.oraclePlayerId || row.week >= currentWeek || !row.played) continue;
    const rows = byPlayer.get(row.oraclePlayerId) || [];
    rows.push(row);
    byPlayer.set(row.oraclePlayerId, rows);
  }
  const observations = [];
  for (const [entityId, allRows] of byPlayer) {
    const rows = allRows.sort((left, right) => right.week - left.week).slice(0, lookback);
    if (rows.length < 2) continue;
    const latestWeek = Math.max(...rows.map((row) => row.week));
    const source = {
      name: "nflverse weekly player stats",
      recordId: `${rows[0].season}:${latestWeek}:${rows[0].sourcePlayerId}`,
      reliability: 0.86,
    };
    const confidence = clamp(0.5 + rows.length * 0.07, 0.5, 0.82);
    const common = {
      entityType: "player",
      entityId,
      source,
      confidence,
      observedAt,
      expiresAt: new Date(now + 8 * DAY_MS).toISOString(),
      metadata: { derived: true, lookbackWeeks: rows.map((row) => row.week) },
    };
    observations.push({
      ...common,
      feature: "role.expected_opportunities",
      value: mean(rows.map((row) => row.opportunities)),
    });
    const totalOpportunities = rows.reduce((sum, row) => sum + row.opportunities, 0);
    if (totalOpportunities > 0) {
      observations.push({
        ...common,
        feature: "efficiency.expected_points_per_opportunity",
        value: rows.reduce((sum, row) => sum + row.pointsPpr, 0) / totalOpportunities,
      });
    }
    const targetShares = rows.map((row) => {
      const total = totals.get(`${row.team}|${row.week}`)?.targets || 0;
      return total > 0 ? row.targets / total : null;
    }).filter((value) => value !== null);
    if (targetShares.length >= 2 && ["RB", "WR", "TE"].includes(rows[0].position)) {
      observations.push({
        ...common,
        feature: "role.target_share",
        value: mean(targetShares),
      });
    }
    const carryShares = rows.map((row) => {
      const total = totals.get(`${row.team}|${row.week}`)?.carries || 0;
      return total > 0 ? row.carries / total : null;
    }).filter((value) => value !== null);
    if (carryShares.length >= 2 && ["QB", "RB", "WR"].includes(rows[0].position)) {
      observations.push({
        ...common,
        feature: "role.carry_share",
        value: mean(carryShares),
      });
    }
  }
  return observations;
}

async function loadPlayerRows(filePath) {
  const rows = [];
  await forEachCsvRow(filePath, (row) => {
    const normalized = normalizedPlayerRow(row);
    if (!SKILL_POSITIONS.has(normalized.position)) return;
    if (!normalized.espn_id && !normalized.gsis_id && !normalized.sleeper_id) return;
    rows.push(normalized);
  });
  return rows;
}

async function loadWeeklyOutcomes(filePath, season) {
  const rows = [];
  await forEachCsvRow(filePath, (row) => {
    const normalized = normalizeWeeklyOutcome(row, season);
    if (normalized) rows.push(normalized);
  });
  return rows;
}

class NflverseConnector {
  constructor(options = {}) {
    if (!options.cache) throw new TypeError("NflverseConnector requires a free source cache");
    if (!options.identityResolver) throw new TypeError("NflverseConnector requires an identity resolver");
    this.cache = options.cache;
    this.identity = options.identityResolver;
    this.clock = options.clock || Date.now;
  }

  async syncPlayers(options = {}) {
    const result = await this.cache.fetchBuffer("nflverse", playerUrl(), {
      maximumAgeMs: options.force ? 0 : 7 * DAY_MS,
      force: options.force === true,
      accept: "text/csv",
    });
    const rows = await loadPlayerRows(result.payloadPath);
    const identity = this.identity.registerRecords(rows, {
      source: "nflverse-players",
      allowTeamMismatch: true,
    });
    return {
      rows,
      identity,
      stale: result.stale,
      metadata: result.metadata,
    };
  }

  async syncSeason(season, options = {}) {
    const normalizedSeason = Number(season);
    if (!Number.isInteger(normalizedSeason) || normalizedSeason < 1999 || normalizedSeason > 2100) {
      throw new RangeError(`Invalid nflverse season ${season}`);
    }
    const result = await this.cache.fetchBuffer("nflverse", weeklyStatsUrl(normalizedSeason), {
      maximumAgeMs: options.force ? 0 : 6 * 60 * 60 * 1000,
      force: options.force === true,
      accept: "text/csv",
    });
    const outcomes = await loadWeeklyOutcomes(result.payloadPath, normalizedSeason);
    let matched = 0;
    for (const outcome of outcomes) {
      const resolution = this.identity.resolve({
        gsis_id: outcome.sourcePlayerId,
        name: outcome.name,
        position: outcome.position,
        team: outcome.team,
      });
      if (!resolution.matched) continue;
      outcome.oraclePlayerId = resolution.oraclePlayerId;
      matched += 1;
    }
    return {
      season: normalizedSeason,
      outcomes,
      matched,
      stale: result.stale,
      metadata: result.metadata,
    };
  }

  async sync(options = {}) {
    const season = Number(options.season);
    const currentWeek = Math.max(1, Number(options.currentWeek || 1));
    const players = await this.syncPlayers(options);
    const seasonResult = await this.syncSeason(season, options);
    const observations = rollingEvidence(seasonResult.outcomes, {
      currentWeek,
      lookback: options.lookback,
      now: this.clock(),
    });
    return {
      version: NFLVERSE_CONNECTOR_VERSION,
      syncedAt: new Date(this.clock()).toISOString(),
      season,
      currentWeek,
      players: {
        received: players.rows.length,
        identity: players.identity,
      },
      outcomes: seasonResult.outcomes,
      outcomeSummary: {
        rows: seasonResult.outcomes.length,
        matched: seasonResult.matched,
        completedWeeks: [...new Set(seasonResult.outcomes.map((row) => row.week))]
          .filter((week) => week < currentWeek)
          .sort((left, right) => left - right),
      },
      observations,
      stale: players.stale || seasonResult.stale,
      attribution: {
        name: "nflverse",
        license: "CC-BY-4.0",
        url: "https://github.com/nflverse/nflverse-data",
      },
      sourceMetadata: {
        players: players.metadata,
        weeklyStats: seasonResult.metadata,
      },
    };
  }
}

module.exports = {
  NFLVERSE_CONNECTOR_VERSION,
  NflverseConnector,
  RELEASE_BASE,
  loadPlayerRows,
  loadWeeklyOutcomes,
  normalizeWeeklyOutcome,
  normalizedPlayerRow,
  opportunityCount,
  playerUrl,
  rollingEvidence,
  teamWeekTotals,
  weeklyStatsUrl,
};
