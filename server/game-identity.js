"use strict";

const { normalizeTeam } = require("./player-identity.js");

function oracleGameId(season, week, team, opponent) {
  const normalizedSeason = Number(season);
  const normalizedWeek = Number(week);
  const teams = [normalizeTeam(team), normalizeTeam(opponent)].sort();
  if (!Number.isInteger(normalizedSeason) || !Number.isInteger(normalizedWeek)
    || teams.some((value) => !value || value === "FA")) {
    return null;
  }
  return `${normalizedSeason}:W${normalizedWeek}:${teams.join("-")}`;
}

function scheduledGame(dataset, team, week) {
  const normalizedTeam = normalizeTeam(team);
  const normalizedWeek = Number(week);
  const row = dataset?.schedule?.[normalizedTeam]?.weeks?.[normalizedWeek - 1] || null;
  if (!row || row.bye || !row.opponent) return null;
  const opponent = normalizeTeam(row.opponent);
  const homeTeam = row.home === true ? normalizedTeam : opponent;
  const awayTeam = row.home === true ? opponent : normalizedTeam;
  const season = Number(dataset?.meta?.season || new Date(Number(row.date)).getUTCFullYear());
  return {
    id: oracleGameId(season, normalizedWeek, normalizedTeam, opponent),
    season,
    week: normalizedWeek,
    team: normalizedTeam,
    opponent,
    homeTeam,
    awayTeam,
    kickoff: Number.isFinite(Number(row.date)) ? new Date(Number(row.date)).toISOString() : null,
    scheduleIndoor: row.indoor === true,
    detail: row.detail || null,
  };
}

function gamesForWeek(dataset, week) {
  const games = new Map();
  for (const team of Object.keys(dataset?.schedule || {})) {
    const game = scheduledGame(dataset, team, week);
    if (game?.id && !games.has(game.id)) games.set(game.id, game);
  }
  return [...games.values()].sort((left, right) => (
    Date.parse(left.kickoff || 0) - Date.parse(right.kickoff || 0)
    || left.id.localeCompare(right.id)
  ));
}

module.exports = {
  gamesForWeek,
  oracleGameId,
  scheduledGame,
};
