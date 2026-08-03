"use strict";

const { forEachCsvRow } = require("../scripts/lib/csv.js");
const { DAY_MS } = require("./free-source-catalog.js");
const { normalizePosition, normalizeTeam } = require("./player-identity.js");

const NFLVERSE_FEATURE_STORE_VERSION = "oracle-nflverse-feature-store-2026.1";
const RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K"]);

const DATASETS = Object.freeze({
  injuries: { tag: "injuries", file: (season) => `injuries_${season}.csv` },
  depthCharts: { tag: "depth_charts", file: (season) => `depth_charts_${season}.csv` },
  snapCounts: { tag: "snap_counts", file: (season) => `snap_counts_${season}.csv` },
  weeklyRosters: { tag: "weekly_rosters", file: (season) => `roster_weekly_${season}.csv` },
  teamStats: { tag: "stats_team", file: (season) => `stats_team_week_${season}.csv` },
});

function datasetUrl(name, season) {
  const definition = DATASETS[name];
  if (!definition) throw new RangeError(`Unknown nflverse dataset ${name}`);
  return `${RELEASE_BASE}/${definition.tag}/${definition.file(season)}`;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function iso(value) {
  return new Date(Number(value)).toISOString();
}

function source(name, recordId, reliability = 0.86) {
  return {
    name: `nflverse ${name}`,
    recordId: String(recordId),
    reliability,
  };
}

function observation(entityType, entityId, feature, value, details = {}) {
  return {
    entityType,
    entityId: String(entityId),
    feature,
    value,
    source: details.source,
    confidence: clamp(details.confidence ?? 0.75, 0, 0.98),
    observedAt: iso(details.now),
    expiresAt: iso(details.now + (details.ttlMs || 8 * DAY_MS)),
    metadata: {
      dataset: details.dataset,
      season: details.season,
      week: details.week ?? null,
      derived: details.derived === true,
      ...(details.metadata || {}),
    },
  };
}

function normalizeDesignation(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (text.includes("question")) return "questionable";
  if (text.includes("doubt")) return "doubtful";
  if (text === "out" || text.includes("inactive")) return "out";
  if (text.includes("suspend") || text === "sus") return "suspended";
  if (text.includes("reserve") || text.includes("injured") || text === "ir"
    || text.includes("pup") || text.includes("nfi") || text === "res") return "ir";
  if (text.includes("active") || text === "act" || text === "a01") return "active";
  return null;
}

function normalizePractice(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (text.includes("full")) return "full";
  if (text.includes("limited")) return "limited";
  if (text.includes("did not") || text === "dnp") return "dnp";
  return "other";
}

function resolutionFor(identity, row = {}, options = {}) {
  return identity.resolve({
    espn_id: row.espn_id,
    gsis_id: row.gsis_id || row.player_id,
    sleeper_id: row.sleeper_id,
    full_name: row.full_name || row.player_name || row.player,
    position: row.position || row.pos_abb || row.depth_chart_position,
    team: row.team,
  }, { allowTeamMismatch: options.allowTeamMismatch !== false });
}

async function injuryEvidence(filePath, identity, options = {}) {
  const season = Number(options.season);
  const currentWeek = Number(options.currentWeek);
  const latest = new Map();
  let rows = 0;
  let matched = 0;
  await forEachCsvRow(filePath, (row) => {
    if (String(row.season_type || row.game_type || "REG").toUpperCase() !== "REG") return;
    const week = Number(row.week);
    if (!Number.isInteger(week) || week > currentWeek) return;
    rows += 1;
    const resolved = resolutionFor(identity, row);
    if (!resolved.matched) return;
    matched += 1;
    const existing = latest.get(resolved.oraclePlayerId);
    if (!existing || week >= existing.week) {
      latest.set(resolved.oraclePlayerId, { row, week, resolved });
    }
  });

  const observations = [];
  for (const [entityId, entry] of latest) {
    const designation = normalizeDesignation(entry.row.report_status);
    const practice = normalizePractice(entry.row.practice_status);
    const recordId = `${season}:${entry.week}:${entry.row.gsis_id || entityId}`;
    const common = {
      source: source("injury reports", recordId, 0.9),
      confidence: entry.week === currentWeek ? 0.9 : 0.72,
      now: options.now,
      ttlMs: entry.week === currentWeek ? 36 * 60 * 60 * 1000 : 3 * DAY_MS,
      dataset: "injuries",
      season,
      week: entry.week,
      metadata: {
        primaryInjury: entry.row.report_primary_injury || entry.row.practice_primary_injury || null,
        secondaryInjury: entry.row.report_secondary_injury || entry.row.practice_secondary_injury || null,
      },
    };

    if (designation) {
      observations.push(observation(
        "player", entityId, "availability.designation", designation, common,
      ));
    }
    if (practice) {
      observations.push(observation(
        "player", entityId, "health.practice_participation", practice, common,
      ));
    }
  }
  return { rows, matched, players: latest.size, observations };
}

function depthPosition(row = {}) {
  const direct = normalizePosition(row.pos_abb || row.position);
  if (SKILL_POSITIONS.has(direct)) return direct;
  const group = String(row.pos_grp || "").toUpperCase();
  if (group.includes("QUARTERBACK")) return "QB";
  if (group.includes("RUNNING BACK")) return "RB";
  if (group.includes("WIDE RECEIVER")) return "WR";
  if (group.includes("TIGHT END")) return "TE";
  if (group.includes("KICK")) return "K";
  return direct;
}

async function depthChartEvidence(filePath, identity, options = {}) {
  const season = Number(options.season);
  const asOf = Number(options.asOf || options.now);
  const latest = new Map();
  let rows = 0;
  let matched = 0;
  await forEachCsvRow(filePath, (row) => {
    const position = depthPosition(row);
    if (!SKILL_POSITIONS.has(position)) return;
    const timestamp = Date.parse(row.dt);
    if (!Number.isFinite(timestamp) || timestamp > asOf) return;
    rows += 1;
    const resolved = resolutionFor(identity, { ...row, position });
    if (!resolved.matched) return;
    matched += 1;

    const rank = Math.max(1, finite(row.pos_rank, 10));
    const existing = latest.get(resolved.oraclePlayerId);
    if (!existing || timestamp > existing.timestamp
      || (timestamp === existing.timestamp && rank < existing.rank)) {
      latest.set(resolved.oraclePlayerId, { row, rank, timestamp });
    }
  });

  const observations = [...latest.entries()].map(([entityId, entry]) => observation(
    "player",
    entityId,
    "role.depth_chart_order",
    entry.rank,
    {
      source: source("depth charts", `${season}:${entry.row.team}:${entityId}:${entry.timestamp}`, 0.84),
      confidence: 0.82,
      now: options.now,
      ttlMs: 10 * DAY_MS,
      dataset: "depth_charts",
      season,
      metadata: {
        depthChartTimestamp: iso(entry.timestamp),
        positionName: entry.row.pos_name || null,
        positionSlot: entry.row.pos_slot || null,
      },
    },
  ));
  return { rows, matched, players: latest.size, observations };
}

function weightedRecent(rows, field) {
  const sorted = [...rows].sort((left, right) => right.week - left.week);
  let weighted = 0;
  let weights = 0;
  sorted.forEach((row, index) => {
    const value = finite(row[field], Number.NaN);
    if (!Number.isFinite(value)) return;
    const weight = Math.pow(0.72, index);
    weighted += value * weight;
    weights += weight;
  });
  return weights ? weighted / weights : null;
}

async function snapEvidence(filePath, identity, options = {}) {
  const season = Number(options.season);
  const currentWeek = Number(options.currentWeek);
  const lookback = Math.min(8, Math.max(2, Number(options.lookback || 4)));
  const byPlayer = new Map();
  let rows = 0;
  let matched = 0;
  await forEachCsvRow(filePath, (row) => {
    if (String(row.game_type || "REG").toUpperCase() !== "REG") return;
    const week = Number(row.week);
    const position = normalizePosition(row.position);
    if (!SKILL_POSITIONS.has(position) || week >= currentWeek || week < 1) return;
    const share = finite(row.offense_pct, Number.NaN);
    if (!Number.isFinite(share) || share < 0 || share > 1) return;
    rows += 1;
    const resolved = resolutionFor(identity, {
      player_name: row.player,
      position,
      team: row.team,
    }, { allowTeamMismatch: false });
    if (!resolved.matched) return;
    matched += 1;
    const existing = byPlayer.get(resolved.oraclePlayerId) || [];
    existing.push({ week, share, snaps: finite(row.offense_snaps) });
    byPlayer.set(resolved.oraclePlayerId, existing);
  });

  const observations = [];
  for (const [entityId, allRows] of byPlayer) {
    const recent = allRows.sort((left, right) => right.week - left.week).slice(0, lookback);
    if (recent.length < 2) continue;
    const share = weightedRecent(recent, "share");
    if (share === null) continue;
    observations.push(observation("player", entityId, "role.snap_share", share, {
      source: source("snap counts", `${season}:${recent[0].week}:${entityId}`, 0.88),
      confidence: clamp(0.62 + recent.length * 0.06, 0.62, 0.9),
      now: options.now,
      ttlMs: 8 * DAY_MS,
      dataset: "snap_counts",
      season,
      week: recent[0].week,
      derived: true,
      metadata: { lookbackWeeks: recent.map((row) => row.week), latestSnaps: recent[0].snaps },
    }));
  }
  return { rows, matched, players: byPlayer.size, observations };
}

function rosterDesignation(row = {}) {
  const status = String(row.status || row.status_description_abbr || "").trim().toLowerCase();
  if (!status) return null;
  if (["act", "active", "a01"].includes(status)) return "active";
  if (status.includes("sus")) return "suspended";
  if (["res", "ir", "pup", "nfi", "reserve"].some((value) => status.includes(value))) {
    return "ir";
  }
  if (["dev", "out", "inactive"].some((value) => status.includes(value))) return "out";
  return null;
}

function rosterKey(row = {}) {
  return String(row.gsis_id || row.espn_id || row.sleeper_id
    || `${row.full_name}|${row.team}|${row.position}`);
}

async function rosterEvidence(filePath, identity, options = {}) {
  const season = Number(options.season);
  const currentWeek = Number(options.currentWeek);
  const latest = new Map();
  let rows = 0;
  await forEachCsvRow(filePath, (row) => {
    if (String(row.game_type || "REG").toUpperCase() !== "REG") return;
    const week = Number(row.week);
    const position = normalizePosition(row.position || row.depth_chart_position);
    if (!SKILL_POSITIONS.has(position) || week > currentWeek || week < 1) return;
    rows += 1;
    const key = rosterKey(row);
    const existing = latest.get(key);
    if (!existing || week >= existing.week) latest.set(key, { row: { ...row, position }, week });
  });

  const records = [...latest.values()].map((entry) => entry.row);
  const registered = identity.registerRecords(records, {
    source: "nflverse-weekly-rosters",
    allowTeamMismatch: true,
  });
  const observations = [];
  let matched = 0;
  for (const entry of latest.values()) {
    const resolved = resolutionFor(identity, entry.row);
    if (!resolved.matched) continue;
    matched += 1;
    const designation = rosterDesignation(entry.row);
    if (!designation) continue;

    observations.push(observation(
      "player",
      resolved.oraclePlayerId,
      "availability.designation",
      designation,
      {
        source: source("weekly rosters", `${season}:${entry.week}:${rosterKey(entry.row)}`, 0.91),
        confidence: entry.week === currentWeek ? 0.88 : 0.68,
        now: options.now,
        ttlMs: 4 * DAY_MS,
        dataset: "weekly_rosters",
        season,
        week: entry.week,
        metadata: {
          rosterStatus: entry.row.status || null,
          statusCode: entry.row.status_description_abbr || null,
          depthChartPosition: entry.row.depth_chart_position || null,
        },
      },
    ));
  }
  return { rows, matched, players: latest.size, registered, observations };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values, average = mean(values)) {
  if (!values.length || average === null) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function grades(valuesByTeam) {
  const values = [...valuesByTeam.values()].filter(Number.isFinite);
  const average = mean(values) ?? 0;
  const deviation = standardDeviation(values, average);
  return new Map([...valuesByTeam.entries()].map(([team, value]) => [
    team,
    deviation > 1e-9 ? clamp((value - average) / (2 * deviation), -1, 1) : 0,
  ]));
}

function recentRows(rows, lookback) {
  return [...rows].sort((left, right) => right.week - left.week).slice(0, lookback);
}

function teamMetricMaps(byTeam, lookback) {
  const pace = new Map();
  const passBlock = new Map();
  const runBlock = new Map();
  const passAllowedRows = new Map();
  const rushAllowedRows = new Map();

  for (const [team, allRows] of byTeam) {
    const rows = recentRows(allRows, lookback);
    pace.set(team, mean(rows.map((row) => row.plays)) ?? 0);
    passBlock.set(team, mean(rows.map((row) => row.passBlock)) ?? 0);
    runBlock.set(team, mean(rows.map((row) => row.runBlock)) ?? 0);
    for (const row of rows) {
      const pass = passAllowedRows.get(row.opponent) || [];
      pass.push(row.passEfficiency);
      passAllowedRows.set(row.opponent, pass);
      const rush = rushAllowedRows.get(row.opponent) || [];
      rush.push(row.runEfficiency);
      rushAllowedRows.set(row.opponent, rush);
    }
  }
  return {
    pace: grades(pace),
    passBlock: grades(passBlock),
    runBlock: grades(runBlock),
    passAllowed: grades(new Map([...passAllowedRows].map(([team, values]) => [team, mean(values) ?? 0]))),
    rushAllowed: grades(new Map([...rushAllowedRows].map(([team, values]) => [team, mean(values) ?? 0]))),
  };
}

function nextOpponent(dataset, team, week) {
  return normalizeTeam(dataset?.schedule?.[team]?.weeks?.[week - 1]?.opponent || "");
}

async function teamEvidence(filePath, dataset, options = {}) {
  const season = Number(options.season);
  const currentWeek = Number(options.currentWeek);
  const lookback = Math.min(8, Math.max(2, Number(options.lookback || 4)));
  const byTeam = new Map();
  let rows = 0;
  await forEachCsvRow(filePath, (row) => {
    if (String(row.season_type || "REG").toUpperCase() !== "REG") return;
    const week = Number(row.week);
    if (!Number.isInteger(week) || week >= currentWeek || week < 1) return;
    const team = normalizeTeam(row.team);
    const opponent = normalizeTeam(row.opponent_team);
    if (!team || !opponent) return;
    const attempts = finite(row.attempts);
    const sacks = finite(row.sacks_suffered);
    const carries = finite(row.carries);
    rows += 1;
    const values = byTeam.get(team) || [];
    values.push({
      week,
      opponent,
      plays: attempts + sacks + carries,
      passBlock: -(sacks / Math.max(1, attempts + sacks)),
      runBlock: finite(row.rushing_epa) / Math.max(1, carries),
      passEfficiency: finite(row.passing_epa) / Math.max(1, attempts + sacks),
      runEfficiency: finite(row.rushing_epa) / Math.max(1, carries),
    });
    byTeam.set(team, values);
  });

  const metrics = teamMetricMaps(byTeam, lookback);
  const observations = [];
  for (const [team, allRows] of byTeam) {
    const recent = recentRows(allRows, lookback);
    const latestWeek = recent[0]?.week;
    const opponent = nextOpponent(dataset, team, currentWeek);
    const confidence = clamp(0.6 + recent.length * 0.06, 0.6, 0.88);
    const common = {
      source: source("weekly team stats", `${season}:${latestWeek}:${team}`, 0.88),
      confidence,
      now: options.now,
      ttlMs: 8 * DAY_MS,
      dataset: "stats_team",
      season,
      week: latestWeek,
      derived: true,
      metadata: { lookbackWeeks: recent.map((row) => row.week), nextOpponent: opponent || null },
    };

    observations.push(observation("team", team, "team.pace_grade", metrics.pace.get(team) ?? 0, common));
    observations.push(observation(
      "team", team, "line.pass_block_grade", metrics.passBlock.get(team) ?? 0, common,
    ));
    observations.push(observation(
      "team", team, "line.run_block_grade", metrics.runBlock.get(team) ?? 0, common,
    ));
    if (opponent) {
      if (metrics.passAllowed.has(opponent)) observations.push(observation(
        "team", team, "matchup.pass_grade", metrics.passAllowed.get(opponent), common,
      ));
      if (metrics.rushAllowed.has(opponent)) observations.push(observation(
        "team", team, "matchup.rush_grade", metrics.rushAllowed.get(opponent), common,
      ));
    }
  }
  return { rows, teams: byTeam.size, observations };
}

class NflverseFeatureStore {
  constructor(options = {}) {
    if (!options.cache) throw new TypeError("NflverseFeatureStore requires a free source cache");
    if (!options.identityResolver) {
      throw new TypeError("NflverseFeatureStore requires an identity resolver");
    }
    if (typeof options.datasetProvider !== "function") {
      throw new TypeError("NflverseFeatureStore requires datasetProvider");
    }
    this.cache = options.cache;
    this.identity = options.identityResolver;
    this.datasetProvider = options.datasetProvider;
    this.clock = options.clock || Date.now;
  }

  async fetchDataset(name, season, options = {}) {
    return this.cache.fetchBuffer("nflverse", datasetUrl(name, season), {
      maximumAgeMs: options.force ? 0 : 6 * 60 * 60 * 1000,
      force: options.force === true,
      accept: "text/csv",
    });
  }

  async sync(options = {}) {
    const season = Number(options.season);
    const currentWeek = Number(options.currentWeek);
    if (!Number.isInteger(season) || season < 1999 || season > 2100) {
      throw new RangeError(`Invalid nflverse feature season ${options.season}`);
    }
    if (!Number.isInteger(currentWeek) || currentWeek < 1 || currentWeek > 22) {
      throw new RangeError(`Invalid nflverse feature week ${options.currentWeek}`);
    }
    const now = Number(this.clock());
    const requested = Array.isArray(options.datasets) && options.datasets.length
      ? [...new Set(options.datasets.map(String))]
      : Object.keys(DATASETS);
    const loaders = {
      injuries: (file) => injuryEvidence(file, this.identity, { season, currentWeek, now }),
      depthCharts: (file) => depthChartEvidence(file, this.identity, {
        season, currentWeek, now, asOf: options.asOf || now,
      }),
      snapCounts: (file) => snapEvidence(file, this.identity, {
        season, currentWeek, lookback: options.lookback, now,
      }),
      weeklyRosters: (file) => rosterEvidence(file, this.identity, { season, currentWeek, now }),
      teamStats: (file) => teamEvidence(file, this.datasetProvider(), {
        season, currentWeek, lookback: options.lookback, now,
      }),
    };
    const feeds = {};
    const observations = [];
    let stale = false;
    let successes = 0;

    for (const name of requested) {
      if (!DATASETS[name] || !loaders[name]) {
        feeds[name] = { ok: false, error: { code: "NFLVERSE_DATASET_UNKNOWN" } };
        continue;
      }
      try {
        const fetched = await this.fetchDataset(name, season, options);
        const result = await loaders[name](fetched.payloadPath);
        observations.push(...result.observations);
        stale ||= fetched.stale;
        successes += 1;
        feeds[name] = {
          ok: true,
          stale: fetched.stale,
          ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "observations")),
          observations: result.observations.length,
        };
      } catch (error) {
        feeds[name] = {
          ok: false,
          error: { code: error.code || error.name || "NFLVERSE_FEATURE_ERROR", message: error.message },
        };
      }
    }

    return {
      version: NFLVERSE_FEATURE_STORE_VERSION,
      syncedAt: iso(now),
      season,
      currentWeek,
      requested,
      successes,
      failures: requested.length - successes,
      feeds,
      observations,
      stale,
      attribution: {
        name: "nflverse",
        license: "CC-BY-4.0 unless an individual release states otherwise",
        url: "https://github.com/nflverse/nflverse-data",
      },
    };
  }
}

module.exports = {
  DATASETS,
  NFLVERSE_FEATURE_STORE_VERSION,
  NflverseFeatureStore,
  datasetUrl,
  depthChartEvidence,
  depthPosition,
  grades,
  injuryEvidence,
  nextOpponent,
  normalizeDesignation,
  normalizePractice,
  rosterDesignation,
  rosterEvidence,
  snapEvidence,
  teamEvidence,
  teamMetricMaps,
  weightedRecent,
};
