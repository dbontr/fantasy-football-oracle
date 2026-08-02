"use strict";

const { DAY_MS, HOUR_MS } = require("./free-source-catalog.js");

const SLEEPER_CONNECTOR_VERSION = "oracle-sleeper-connector-2026.1";
const BASE_URL = "https://api.sleeper.app/v1";
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "DST"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function normalizedPosition(value) {
  const position = String(value || "").toUpperCase();
  return position === "DEF" ? "DST" : position;
}

function normalizeSleeperPlayers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([playerId, row]) => ({
    ...row,
    player_id: String(row?.player_id || playerId),
    sleeper_id: String(row?.player_id || playerId),
    espn_id: row?.espn_id ? String(row.espn_id) : null,
    full_name: row?.full_name || [row?.first_name, row?.last_name].filter(Boolean).join(" "),
    position: normalizedPosition(row?.position || row?.fantasy_positions?.[0]),
    team: row?.team || "FA",
  })).filter((row) => SKILL_POSITIONS.has(row.position));
}

function sleeperDesignation(row = {}) {
  const injury = String(row.injury_status || row.injuryStatus || "").toLowerCase();
  const status = String(row.status || "").toLowerCase();
  if (status.includes("suspend")) return "suspended";
  if (status === "injured reserve" || status === "ir" || injury === "ir") return "ir";
  if (injury.includes("out")) return "out";
  if (injury.includes("doubt")) return "doubtful";
  if (injury.includes("question")) return "questionable";
  if (status === "active" && !injury) return "active";
  return null;
}

function practiceParticipation(row = {}) {
  const value = String(row.practice_participation || "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("full")) return "full";
  if (value.includes("limit")) return "limited";
  if (value.includes("did not") || value === "dnp") return "dnp";
  return "other";
}

function trendCounts(rows = []) {
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [
    String(row.player_id),
    Math.max(0, finite(row.count)),
  ]));
}

function rosterMomentum(adds, drops) {
  const total = Math.max(0, adds) + Math.max(0, drops);
  if (!total) return 0;
  const signed = (adds - drops) / Math.max(20, total);
  return clamp(signed, -1, 1);
}

function expiry(now, milliseconds) {
  return new Date(now + milliseconds).toISOString();
}

function sleeperObservations(players, trends, resolver, options = {}) {
  const now = Number(options.now || Date.now());
  const observedAt = new Date(now).toISOString();
  const adds = trendCounts(trends?.adds);
  const drops = trendCounts(trends?.drops);
  const observations = [];
  const unresolved = [];
  let matched = 0;

  for (const row of players) {
    const resolution = resolver.resolve(row);
    if (!resolution.matched) {
      unresolved.push({
        sleeperId: row.sleeper_id,
        name: row.full_name,
        team: row.team,
        position: row.position,
        method: resolution.method,
      });
      continue;
    }
    matched += 1;
    const entityId = resolution.oraclePlayerId;
    const source = {
      name: "Sleeper public API",
      recordId: row.sleeper_id,
      reliability: 0.78,
    };
    const designation = sleeperDesignation(row);
    if (designation) {
      observations.push({
        entityType: "player",
        entityId,
        feature: "availability.designation",
        value: designation,
        source,
        confidence: designation === "active" ? 0.62 : 0.82,
        observedAt,
        expiresAt: expiry(now, 36 * HOUR_MS),
        metadata: { sleeperId: row.sleeper_id, derived: false },
      });
    }
    const practice = practiceParticipation(row);
    if (practice) {
      observations.push({
        entityType: "player",
        entityId,
        feature: "health.practice_participation",
        value: practice,
        source,
        confidence: 0.72,
        observedAt,
        expiresAt: expiry(now, 48 * HOUR_MS),
        metadata: { sleeperId: row.sleeper_id, derived: false },
      });
    }
    const depth = finite(row.depth_chart_order ?? row.depth_chart_position, 0);
    if (depth >= 1 && depth <= 10) {
      observations.push({
        entityType: "player",
        entityId,
        feature: "role.depth_chart_order",
        value: depth,
        source,
        confidence: 0.68,
        observedAt,
        expiresAt: expiry(now, 7 * DAY_MS),
        metadata: { sleeperId: row.sleeper_id, derived: false },
      });
    }
    const addCount = adds.get(row.sleeper_id) || 0;
    const dropCount = drops.get(row.sleeper_id) || 0;
    if (addCount || dropCount) {
      observations.push({
        entityType: "player",
        entityId,
        feature: "market.roster_momentum",
        value: rosterMomentum(addCount, dropCount),
        source: { ...source, recordId: `trend:${row.sleeper_id}` },
        confidence: clamp(0.48 + Math.log1p(addCount + dropCount) / 18, 0.48, 0.82),
        observedAt,
        expiresAt: expiry(now, 18 * HOUR_MS),
        metadata: { sleeperId: row.sleeper_id, adds: addCount, drops: dropCount, derived: true },
      });
    }
  }
  return { observations, matched, unresolved };
}

class SleeperConnector {
  constructor(options = {}) {
    if (!options.cache) throw new TypeError("SleeperConnector requires a free source cache");
    if (!options.identityResolver) throw new TypeError("SleeperConnector requires an identity resolver");
    this.cache = options.cache;
    this.identity = options.identityResolver;
    this.clock = options.clock || Date.now;
  }

  async request(pathname, options = {}) {
    return this.cache.fetchJson("sleeper", `${BASE_URL}${pathname}`, options);
  }

  async leagueContext(leagueId, week, options = {}) {
    if (!leagueId) return null;
    const encoded = encodeURIComponent(String(leagueId));
    const maximumAgeMs = options.force ? 0 : 5 * 60 * 1000;
    const [league, rosters, users, matchups] = await Promise.all([
      this.request(`/league/${encoded}`, { maximumAgeMs, force: options.force }),
      this.request(`/league/${encoded}/rosters`, { maximumAgeMs, force: options.force }),
      this.request(`/league/${encoded}/users`, { maximumAgeMs, force: options.force }),
      week ? this.request(`/league/${encoded}/matchups/${week}`, {
        maximumAgeMs,
        force: options.force,
      }) : Promise.resolve(null),
    ]);
    return {
      league: league.data,
      rosters: rosters.data,
      users: users.data,
      matchups: matchups?.data || [],
      stale: [league, rosters, users, matchups].filter(Boolean).some((row) => row.stale),
    };
  }

  async sync(options = {}) {
    const force = options.force === true;
    const [stateResult, playerResult, addResult, dropResult] = await Promise.all([
      this.request("/state/nfl", { maximumAgeMs: 5 * 60 * 1000, force }),
      this.request("/players/nfl?active=true", { maximumAgeMs: DAY_MS, force }),
      this.request("/players/nfl/trending/add?lookback_hours=24&limit=100", {
        maximumAgeMs: 15 * 60 * 1000,
        force,
      }),
      this.request("/players/nfl/trending/drop?lookback_hours=24&limit=100", {
        maximumAgeMs: 15 * 60 * 1000,
        force,
      }),
    ]);
    const players = normalizeSleeperPlayers(playerResult.data);
    const identity = this.identity.registerRecords(players, {
      source: "sleeper",
      allowTeamMismatch: true,
    });
    const evidence = sleeperObservations(
      players,
      { adds: addResult.data, drops: dropResult.data },
      this.identity,
      { now: this.clock() },
    );
    const state = stateResult.data || {};
    const week = Number(options.week || state.week || state.display_week || 0);
    const league = await this.leagueContext(options.leagueId, week, { force });
    return {
      version: SLEEPER_CONNECTOR_VERSION,
      syncedAt: new Date(this.clock()).toISOString(),
      state,
      players: {
        received: players.length,
        matched: evidence.matched,
        unresolved: evidence.unresolved,
        identity,
      },
      trends: {
        adds: Array.isArray(addResult.data) ? addResult.data : [],
        drops: Array.isArray(dropResult.data) ? dropResult.data : [],
      },
      observations: evidence.observations,
      league,
      stale: [stateResult, playerResult, addResult, dropResult].some((row) => row.stale)
        || Boolean(league?.stale),
      attribution: {
        name: "Sleeper",
        url: "https://docs.sleeper.com/",
        note: "Trending data attribution required by Sleeper documentation.",
      },
    };
  }
}

module.exports = {
  BASE_URL,
  SLEEPER_CONNECTOR_VERSION,
  SleeperConnector,
  normalizeSleeperPlayers,
  practiceParticipation,
  rosterMomentum,
  sleeperDesignation,
  sleeperObservations,
  trendCounts,
};
