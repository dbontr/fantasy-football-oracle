"use strict";

const { assertValid, SCHEMA_VERSIONS } = require("./schema-registry.js");
const { canonicalize, sha256 } = require("./lineage.js");

const LEAGUE_STATE_VERSION = "oracle-league-state-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(finite(value, fallback))));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function normalizeSlots(slots = {}) {
  const defaults = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 1, K: 1, BN: 6 };
  return Object.fromEntries(Object.entries(defaults).map(([position, fallback]) => [
    position,
    integer(slots[position], fallback, 0, 20),
  ]));
}

function normalizeSettings(raw = {}, teamCount = 12) {
  return {
    scoring: String(raw.scoring || "ppr").toLowerCase(),
    teams: integer(raw.teams, teamCount, 2, 20),
    slots: normalizeSlots(raw.slots),
    regularSeasonEnd: integer(raw.regularSeasonEnd, 14, 1, 17),
    championshipWeek: integer(raw.championshipWeek, 17, 2, 18),
    playoffTeams: integer(raw.playoffTeams, Math.min(6, teamCount), 2, teamCount),
    playoffByes: integer(raw.playoffByes, teamCount >= 10 ? 2 : 0, 0, 4),
    medianGame: raw.medianGame === true,
    waiverType: String(raw.waiverType || "faab").toLowerCase(),
    faabBudget: Math.max(0, finite(raw.faabBudget, 100)),
    tradeDeadlineWeek: integer(raw.tradeDeadlineWeek, 11, 1, 18),
    keeperCount: integer(raw.keeperCount, 0, 0, 40),
  };
}

function normalizeTeam(team = {}, index = 0) {
  const teamId = String(team.teamId ?? team.id ?? index + 1);
  return {
    teamId,
    name: String(team.name || `Team ${index + 1}`),
    rosterIds: uniqueStrings(team.rosterIds || team.roster?.map((player) => player?.id)),
    wins: Math.max(0, finite(team.wins, 0)),
    losses: Math.max(0, finite(team.losses, 0)),
    ties: Math.max(0, finite(team.ties, 0)),
    pointsFor: Math.max(0, finite(team.pointsFor, 0)),
    pointsAgainst: Math.max(0, finite(team.pointsAgainst, 0)),
    faabRemaining: Math.max(0, finite(team.faabRemaining ?? team.faab, 100)),
    waiverPriority: integer(team.waiverPriority, index + 1, 1, 20),
    division: team.division === undefined || team.division === null ? null : String(team.division),
    managerId: team.managerId === undefined || team.managerId === null ? null : String(team.managerId),
  };
}

function normalizeSchedule(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    week: integer(row.week, 1, 1, 18),
    homeTeamId: String(row.homeTeamId ?? row.home ?? ""),
    awayTeamId: String(row.awayTeamId ?? row.away ?? ""),
    completed: row.completed === true,
    homeScore: row.homeScore === undefined ? null : finite(row.homeScore, 0),
    awayScore: row.awayScore === undefined ? null : finite(row.awayScore, 0),
  })).filter((row) => row.homeTeamId && row.awayTeamId && row.homeTeamId !== row.awayTeamId);
}

function normalizeLeagueState(raw = {}) {
  const teams = (Array.isArray(raw.teams) ? raw.teams : []).map(normalizeTeam);
  const settings = normalizeSettings(raw.settings || raw, teams.length || 12);
  const state = {
    schemaVersion: SCHEMA_VERSIONS.leagueState,
    version: LEAGUE_STATE_VERSION,
    leagueId: String(raw.leagueId || "local-league"),
    season: integer(raw.season, new Date().getUTCFullYear(), 2018, 2035),
    week: integer(raw.week ?? raw.startWeek, 1, 1, 18),
    userTeamId: String(raw.userTeamId ?? teams[0]?.teamId ?? ""),
    settings,
    teams,
    schedule: normalizeSchedule(raw.schedule),
    transactions: canonicalize(Array.isArray(raw.transactions) ? raw.transactions : []),
    source: canonicalize(raw.source || { provider: "manual", fetchedAt: new Date().toISOString() }),
  };
  assertValid("leagueState", state);
  return state;
}

function assessLeagueState(state) {
  const errors = [];
  const warnings = [];
  const teamIds = new Set(state.teams.map((team) => team.teamId));
  const playerOwners = new Map();
  for (const team of state.teams) {
    for (const playerId of team.rosterIds) {
      if (playerOwners.has(playerId)) {
        errors.push(`player ${playerId} appears on ${playerOwners.get(playerId)} and ${team.teamId}`);
      } else {
        playerOwners.set(playerId, team.teamId);
      }
    }
    if (!team.rosterIds.length) warnings.push(`team ${team.teamId} has no roster`);
  }
  for (const matchup of state.schedule) {
    if (!teamIds.has(matchup.homeTeamId)) errors.push(`schedule references unknown home team ${matchup.homeTeamId}`);
    if (!teamIds.has(matchup.awayTeamId)) errors.push(`schedule references unknown away team ${matchup.awayTeamId}`);
  }
  if (state.settings.teams !== state.teams.length) {
    warnings.push(`settings expect ${state.settings.teams} teams but ${state.teams.length} are present`);
  }
  if (!state.schedule.length) warnings.push("league schedule is missing");
  if (state.settings.playoffTeams > state.teams.length) errors.push("playoff team count exceeds loaded teams");
  if (state.settings.regularSeasonEnd >= state.settings.championshipWeek) {
    errors.push("championship week must follow the regular season");
  }
  const completenessSignals = [
    state.teams.length === state.settings.teams,
    state.teams.every((team) => team.rosterIds.length > 0),
    state.schedule.length > 0,
    state.teams.some((team) => team.wins + team.losses + team.ties > 0) || state.week === 1,
    Boolean(state.source?.fetchedAt),
    state.settings.faabBudget >= 0,
    state.settings.playoffTeams >= 2,
    state.settings.championshipWeek > state.settings.regularSeasonEnd,
  ];
  const completeness = completenessSignals.filter(Boolean).length / completenessSignals.length;
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    completeness: Math.round(completeness * 1000) / 1000,
    confidence: Math.max(0.15, Math.min(0.98, completeness - warnings.length * 0.025)),
    playersOwned: playerOwners.size,
    teamsLoaded: state.teams.length,
  };
}

function replaceTeam(state, teamId, updater) {
  let found = false;
  const teams = state.teams.map((team) => {
    if (team.teamId !== String(teamId)) return team;
    found = true;
    return updater({ ...team, rosterIds: [...team.rosterIds] });
  });
  if (!found) {
    const error = new Error(`Unknown team: ${teamId}`);
    error.code = "LEAGUE_TEAM_UNKNOWN";
    throw error;
  }
  return { ...state, teams };
}

function requireOwned(team, playerId) {
  if (!team.rosterIds.includes(String(playerId))) {
    const error = new Error(`${playerId} is not on team ${team.teamId}`);
    error.code = "PLAYER_NOT_OWNED";
    throw error;
  }
}

function ensureUnowned(state, playerId, allowedTeamIds = []) {
  const owner = state.teams.find((team) => (
    !allowedTeamIds.includes(team.teamId) && team.rosterIds.includes(String(playerId))
  ));
  if (owner) {
    const error = new Error(`${playerId} is already rostered by ${owner.teamId}`);
    error.code = "PLAYER_ALREADY_OWNED";
    throw error;
  }
}

function applyAddDrop(state, action) {
  const teamId = String(action.teamId || state.userTeamId);
  const addPlayerId = String(action.addPlayerId || "");
  const dropPlayerId = action.dropPlayerId === null || action.dropPlayerId === undefined
    ? null
    : String(action.dropPlayerId);
  if (!addPlayerId) throw Object.assign(new Error("add-drop requires addPlayerId"), { code: "ACTION_INVALID" });
  ensureUnowned(state, addPlayerId, [teamId]);
  return replaceTeam(state, teamId, (team) => {
    if (dropPlayerId) requireOwned(team, dropPlayerId);
    const rosterIds = team.rosterIds.filter((id) => id !== dropPlayerId && id !== addPlayerId);
    rosterIds.push(addPlayerId);
    return {
      ...team,
      rosterIds,
      faabRemaining: Math.max(0, team.faabRemaining - Math.max(0, finite(action.faabBid, 0))),
    };
  });
}

function applyTrade(state, action) {
  const fromTeamId = String(action.fromTeamId || state.userTeamId);
  const toTeamId = String(action.toTeamId || "");
  const sendPlayerIds = uniqueStrings(action.sendPlayerIds);
  const receivePlayerIds = uniqueStrings(action.receivePlayerIds);
  if (!toTeamId || !sendPlayerIds.length || !receivePlayerIds.length) {
    throw Object.assign(new Error("trade requires two teams and assets in both directions"), { code: "ACTION_INVALID" });
  }
  const from = state.teams.find((team) => team.teamId === fromTeamId);
  const to = state.teams.find((team) => team.teamId === toTeamId);
  if (!from || !to) throw Object.assign(new Error("trade references an unknown team"), { code: "LEAGUE_TEAM_UNKNOWN" });
  sendPlayerIds.forEach((id) => requireOwned(from, id));
  receivePlayerIds.forEach((id) => requireOwned(to, id));
  const teams = state.teams.map((team) => {
    if (team.teamId === fromTeamId) {
      return {
        ...team,
        rosterIds: uniqueStrings([
          ...team.rosterIds.filter((id) => !sendPlayerIds.includes(id)),
          ...receivePlayerIds,
        ]),
      };
    }
    if (team.teamId === toTeamId) {
      return {
        ...team,
        rosterIds: uniqueStrings([
          ...team.rosterIds.filter((id) => !receivePlayerIds.includes(id)),
          ...sendPlayerIds,
        ]),
      };
    }
    return team;
  });
  return { ...state, teams };
}

function applyRosterSet(state, action) {
  const teamId = String(action.teamId || state.userTeamId);
  const rosterIds = uniqueStrings(action.rosterIds);
  rosterIds.forEach((id) => ensureUnowned(state, id, [teamId]));
  return replaceTeam(state, teamId, (team) => ({ ...team, rosterIds }));
}

function applyLeagueAction(rawState, action = {}) {
  const state = normalizeLeagueState(rawState);
  const type = String(action.type || "none").toLowerCase();
  let next = state;
  if (type === "none") return state;
  if (type === "add-drop" || type === "waiver") next = applyAddDrop(state, action);
  else if (type === "trade") next = applyTrade(state, action);
  else if (type === "roster-set" || type === "draft") next = applyRosterSet(state, action);
  else {
    const error = new Error(`Unsupported league action: ${type}`);
    error.code = "ACTION_UNSUPPORTED";
    throw error;
  }
  const assessment = assessLeagueState(next);
  if (!assessment.valid) {
    const error = new Error(`Action produces invalid league state: ${assessment.errors.join("; ")}`);
    error.code = "ACTION_INVALID_STATE";
    throw error;
  }
  return next;
}

function leagueStateDigest(state) {
  return sha256(normalizeLeagueState(state));
}

function resolveSimulationTeams(state, players) {
  const byId = players instanceof Map
    ? players
    : new Map((players || []).map((player) => [String(player.id), player]));
  return state.teams.map((team) => ({
    teamId: team.teamId,
    name: team.name,
    roster: team.rosterIds.map((id) => byId.get(String(id))).filter(Boolean),
    standing: {
      wins: team.wins,
      losses: team.losses,
      ties: team.ties,
      pointsFor: team.pointsFor,
    },
  }));
}

module.exports = {
  LEAGUE_STATE_VERSION,
  normalizeLeagueState,
  normalizeSettings,
  assessLeagueState,
  applyLeagueAction,
  leagueStateDigest,
  resolveSimulationTeams,
  uniqueStrings,
};
