"use strict";

const { sha256 } = require("./lineage.js");

const PLAYER_IDENTITY_VERSION = "oracle-player-identity-2026.1";
const TEAM_ALIASES = Object.freeze({
  JAC: "JAX", JAX: "JAX", GBP: "GB", KCC: "KC", LVR: "LV", NOS: "NO",
  SFO: "SF", TBB: "TB", WAS: "WSH", WFT: "WSH", OAK: "LV", STL: "LAR",
  SD: "LAC", SDG: "LAC", LA: "LAR",
});

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
  const team = String(value || "FA").trim().toUpperCase();
  return TEAM_ALIASES[team] || team;
}

function normalizePosition(value) {
  return String(value || "").trim().toUpperCase();
}

function stringId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function identityKeys(record = {}) {
  const name = canonicalName(
    record.name || record.fullName || record.full_name || record.displayName || record.display_name
      || [record.firstName || record.first_name, record.lastName || record.last_name]
        .filter(Boolean).join(" "),
  );
  const position = normalizePosition(record.position || record.pos);
  const team = normalizeTeam(record.team || record.latestTeam || record.latest_team);
  return {
    name,
    position,
    team,
    namePosition: name && position ? `${name}|${position}` : null,
    namePositionTeam: name && position && team ? `${name}|${position}|${team}` : null,
  };
}

function externalIds(record = {}) {
  const values = {
    espn: stringId(record.espnId ?? record.espn_id),
    sleeper: stringId(record.sleeperId ?? record.sleeper_id ?? record.player_id),
    gsis: stringId(record.gsisId ?? record.gsis_id),
    sportradar: stringId(record.sportradarId ?? record.sportradar_id),
    fantasyData: stringId(record.fantasyDataId ?? record.fantasy_data_id),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value));
}

function addIndex(map, key, value) {
  if (!key) return;
  const rows = map.get(key) || [];
  if (!rows.some((row) => row.id === value.id)) rows.push(value);
  map.set(key, rows);
}

function uniqueCandidate(rows = []) {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return unique.length === 1 ? unique[0] : null;
}

class PlayerIdentityResolver {
  constructor(players = []) {
    if (!Array.isArray(players)) throw new TypeError("PlayerIdentityResolver requires players");
    this.players = players.map((player) => {
      const id = stringId(player.id);
      if (!id) throw new TypeError("Every Oracle player requires an id");
      return {
        id,
        name: String(player.name || ""),
        team: normalizeTeam(player.team),
        position: normalizePosition(player.position),
        keys: identityKeys(player),
        externalIds: { espn: id, ...externalIds(player) },
      };
    });
    this.byOracleId = new Map();
    this.byExternalId = new Map();
    this.byNamePosition = new Map();
    this.byNamePositionTeam = new Map();
    this.registered = 0;
    this.conflicts = [];
    for (const player of this.players) this.indexPlayer(player);
  }

  indexPlayer(player) {
    this.byOracleId.set(player.id, player);
    addIndex(this.byNamePosition, player.keys.namePosition, player);
    addIndex(this.byNamePositionTeam, player.keys.namePositionTeam, player);
    for (const [namespace, id] of Object.entries(player.externalIds)) {
      this.registerExternal(namespace, id, player, "dataset");
    }
  }

  registerExternal(namespace, value, player, source = "external") {
    const id = stringId(value);
    if (!id) return false;
    const key = `${String(namespace).toLowerCase()}:${id}`;
    const existing = this.byExternalId.get(key);
    if (existing && existing.id !== player.id) {
      this.conflicts.push({ key, existing: existing.id, proposed: player.id, source });
      return false;
    }
    this.byExternalId.set(key, player);
    return true;
  }

  resolve(record = {}, options = {}) {
    const ids = externalIds(record);
    const directOracle = stringId(record.oracleId ?? record.oracle_id ?? record.id);
    if (directOracle && this.byOracleId.has(directOracle)) {
      return this.result(this.byOracleId.get(directOracle), "oracle-id", 1, record);
    }
    for (const namespace of ["espn", "sleeper", "gsis", "sportradar", "fantasyData"]) {
      const value = ids[namespace];
      if (!value) continue;
      const player = this.byExternalId.get(`${namespace.toLowerCase()}:${value}`);
      if (player) return this.result(player, `${namespace}-id`, 1, record);
    }

    const keys = identityKeys(record);
    const exactTeam = uniqueCandidate(this.byNamePositionTeam.get(keys.namePositionTeam));
    if (exactTeam) return this.result(exactTeam, "name-position-team", 0.94, record);
    const exactPosition = uniqueCandidate(this.byNamePosition.get(keys.namePosition));
    if (exactPosition && options.allowTeamMismatch !== false) {
      return this.result(exactPosition, "name-position-unique", 0.86, record);
    }
    const candidates = (this.byNamePosition.get(keys.namePosition) || []).map((player) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
    }));
    return {
      matched: false,
      method: candidates.length ? "ambiguous" : "unresolved",
      confidence: 0,
      oraclePlayerId: null,
      player: null,
      candidates,
      sourceIds: ids,
      normalized: keys,
    };
  }

  result(player, method, confidence, record) {
    return {
      matched: true,
      method,
      confidence,
      oraclePlayerId: player.id,
      player: {
        id: player.id,
        name: player.name,
        team: player.team,
        position: player.position,
      },
      candidates: [],
      sourceIds: externalIds(record),
      normalized: identityKeys(record),
    };
  }

  registerRecords(records = [], options = {}) {
    if (!Array.isArray(records)) throw new TypeError("Identity records must be an array");
    const summary = { records: records.length, matched: 0, registered: 0, unresolved: 0 };
    for (const record of records) {
      const resolution = this.resolve(record, { allowTeamMismatch: options.allowTeamMismatch });
      if (!resolution.matched) {
        summary.unresolved += 1;
        continue;
      }
      summary.matched += 1;
      const player = this.byOracleId.get(resolution.oraclePlayerId);
      for (const [namespace, id] of Object.entries(externalIds(record))) {
        if (this.registerExternal(namespace, id, player, options.source || "external")) {
          summary.registered += 1;
          player.externalIds[namespace] = id;
        }
      }
    }
    this.registered += summary.registered;
    return summary;
  }

  snapshot() {
    const identities = this.players.map((player) => ({
      oraclePlayerId: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      externalIds: { ...player.externalIds },
    }));
    return {
      version: PLAYER_IDENTITY_VERSION,
      players: identities.length,
      registeredExternalIds: this.byExternalId.size,
      conflicts: [...this.conflicts],
      identities,
      digest: sha256(identities),
    };
  }

  status() {
    const snapshot = this.snapshot();
    return {
      version: snapshot.version,
      players: snapshot.players,
      registeredExternalIds: snapshot.registeredExternalIds,
      conflictCount: snapshot.conflicts.length,
      digest: snapshot.digest,
    };
  }
}

module.exports = {
  PLAYER_IDENTITY_VERSION,
  PlayerIdentityResolver,
  canonicalName,
  externalIds,
  identityKeys,
  normalizePosition,
  normalizeTeam,
};
