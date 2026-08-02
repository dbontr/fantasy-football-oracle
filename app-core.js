(function attachFantasyOracleCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.FantasyOracleCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createCore() {
  "use strict";

  const STARTER_POSITIONS = ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "DST", "K"];
  const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

  const DEFAULT_SETTINGS = Object.freeze({
    teams: 12,
    rounds: 16,
    draftPosition: 6,
    scoring: "ppr",
    riskTolerance: 0.5,
    slots: Object.freeze({
      QB: 1,
      RB: 2,
      WR: 2,
      TE: 1,
      FLEX: 1,
      SUPERFLEX: 0,
      DST: 1,
      K: 1,
      BN: 6,
    }),
  });

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, finite(value, min)));
  }

  function cloneSettings(settings = {}) {
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      teams: Math.round(clamp(settings.teams ?? DEFAULT_SETTINGS.teams, 4, 20)),
      rounds: Math.round(clamp(settings.rounds ?? DEFAULT_SETTINGS.rounds, 4, 30)),
      draftPosition: Math.round(clamp(
        settings.draftPosition ?? DEFAULT_SETTINGS.draftPosition,
        1,
        settings.teams ?? DEFAULT_SETTINGS.teams,
      )),
      riskTolerance: clamp(settings.riskTolerance ?? DEFAULT_SETTINGS.riskTolerance, 0, 1),
      slots: {
        ...DEFAULT_SETTINGS.slots,
        ...(settings.slots || {}),
      },
    };
  }

  function snakeTeamForPick(pickNumber, teamCount) {
    const teams = Math.max(2, Math.round(finite(teamCount, 12)));
    const pick = Math.max(1, Math.round(finite(pickNumber, 1)));
    const round = Math.floor((pick - 1) / teams) + 1;
    const withinRound = ((pick - 1) % teams) + 1;
    return round % 2 === 1 ? withinRound : teams - withinRound + 1;
  }

  function generateSnakeOrder(teamCount, rounds) {
    const total = Math.max(1, Math.round(finite(teamCount, 12))) *
      Math.max(1, Math.round(finite(rounds, 16)));
    return Array.from({ length: total }, (_, index) => ({
      pick: index + 1,
      round: Math.floor(index / teamCount) + 1,
      teamId: snakeTeamForPick(index + 1, teamCount),
    }));
  }
  function normalizePlayer(player) {
    const position = String(player?.position || "").toUpperCase();
    const projectedPoints = finite(player?.projectedPoints, finite(player?.projection, 0));
    const weeklyProjection = finite(
      player?.weeklyProjection,
      projectedPoints / 17,
    );
    const weeklyProjections = Array.from({ length: 18 }, (_, index) => {
      const value = player?.weeklyProjections?.[index];
      return Number.isFinite(Number(value)) ? Number(value) : null;
    });
    return {
      ...player,
      id: String(player?.id || player?.playerId || player?.name || ""),
      name: String(player?.name || "Unknown player"),
      position,
      team: String(player?.team || "FA").toUpperCase(),
      proTeamId: Math.round(finite(player?.proTeamId, 0)),
      projectedPoints,
      weeklyProjection,
      weeklyProjections,
      previousPoints: finite(player?.previousPoints, 0),
      floorProjection: finite(player?.floorProjection, weeklyProjection * 0.62),
      ceilingProjection: finite(player?.ceilingProjection, weeklyProjection * 1.58),
      projectionStdDev: finite(player?.projectionStdDev, weeklyProjection * 0.42),
      reliability: clamp(player?.reliability ?? 0.72, 0, 1),
      byeWeek: Math.round(clamp(player?.byeWeek, 0, 18)),
      adp: Number.isFinite(Number(player?.adp)) ? Number(player.adp) : null,
      adpTrend: finite(player?.adpTrend, 0),
      pprRank: Number.isFinite(Number(player?.pprRank)) ? Number(player.pprRank) : null,
      standardRank: Number.isFinite(Number(player?.standardRank)) ? Number(player.standardRank) : null,
      superflexRank: Number.isFinite(Number(player?.superflexRank)) ? Number(player.superflexRank) : null,
      auctionValue: finite(player?.auctionValue, 0),
      auctionTrend: finite(player?.auctionTrend, 0),
      activityLevel: finite(player?.activityLevel, 0),
      percentOwned: finite(player?.percentOwned, 0),
      percentStarted: finite(player?.percentStarted, 0),
      injuryRisk: clamp(player?.injuryRisk, 0, 1),
      injuryStatus: String(player?.injuryStatus || "ACTIVE"),
      lastNewsDate: finite(player?.lastNewsDate, 0),
    };
  }

  function playerWeekProjection(player, week, fallback = true) {
    const normalized = normalizePlayer(player);
    const selectedWeek = Math.round(clamp(week, 1, 18));
    if (normalized.byeWeek === selectedWeek) return 0;
    const value = normalized.weeklyProjections[selectedWeek - 1];
    if (Number.isFinite(value)) return Math.max(0, value);
    return fallback ? Math.max(0, normalized.weeklyProjection) : 0;
  }

  function playerWeekRange(player, week) {
    const normalized = normalizePlayer(player);
    const projection = playerWeekProjection(normalized, week);
    if (projection <= 0) return { floor: 0, ceiling: 0 };
    const ratio = normalized.weeklyProjection > 0
      ? projection / normalized.weeklyProjection
      : 1;
    return {
      floor: Math.max(0, normalized.floorProjection * ratio),
      ceiling: Math.max(projection, normalized.ceilingProjection * ratio),
    };
  }  function rankForScoring(player, scoring) {
    if (scoring === "superflex") {
      return player.superflexRank || player.pprRank || player.adp || 9999;
    }
    if (scoring === "standard") {
      return player.standardRank || player.pprRank || player.adp || 9999;
    }
    return player.pprRank || player.adp || player.standardRank || 9999;
  }

  function rosterPlayerIds(state, teamId) {
    const roster = state?.rosters?.[String(teamId)] || state?.rosters?.[teamId] || [];
    return roster.map((player) => typeof player === "string" ? player : String(player.id));
  }
  function positionDemand(settings) {
    const config = cloneSettings(settings);
    const teams = config.teams;
    const slots = config.slots;
    return {
      QB: Math.max(teams, teams * (finite(slots.QB, 1) + finite(slots.SUPERFLEX, 0) * 0.72)),
      RB: teams * (finite(slots.RB, 2) + finite(slots.FLEX, 1) * 0.45 + finite(slots.SUPERFLEX, 0) * 0.08),
      WR: teams * (finite(slots.WR, 2) + finite(slots.FLEX, 1) * 0.43 + finite(slots.SUPERFLEX, 0) * 0.08),
      TE: teams * (finite(slots.TE, 1) + finite(slots.FLEX, 1) * 0.12 + finite(slots.SUPERFLEX, 0) * 0.04),
      DST: teams * finite(slots.DST, 1),
      K: teams * finite(slots.K, 1),
    };
  }

  function computeReplacementLevels(players, settings) {
    const demand = positionDemand(settings);
    const byPosition = {};
    Object.keys(demand).forEach((position) => {
      byPosition[position] = (players || [])
        .map(normalizePlayer)
        .filter((player) => player.position === position)
        .sort((a, b) => b.projectedPoints - a.projectedPoints);
    });

    const levels = {};
    Object.entries(demand).forEach(([position, count]) => {
      const rows = byPosition[position] || [];
      const index = Math.max(0, Math.min(rows.length - 1, Math.round(count) - 1));
      levels[position] = rows.length ? rows[index].projectedPoints : 0;
    });
    return levels;
  }

  function slotEligibility(slot) {
    const normalized = String(slot || "").toUpperCase();
    if (normalized === "FLEX") return new Set(["RB", "WR", "TE"]);
    if (normalized === "SUPERFLEX") return new Set(["QB", "RB", "WR", "TE"]);
    if (normalized === "BN" || normalized === "BENCH") return null;
    return new Set([normalized]);
  }
  function expandedStarterSlots(settings) {
    const slots = cloneSettings(settings).slots;
    const expanded = [];
    STARTER_POSITIONS.forEach((slot) => {
      const count = Math.max(0, Math.round(finite(slots[slot], 0)));
      for (let index = 0; index < count; index += 1) {
        expanded.push({ key: `${slot}${index + 1}`, slot });
      }
    });
    return expanded;
  }

  function countPositions(roster) {
    return (roster || []).reduce((counts, rawPlayer) => {
      const player = normalizePlayer(rawPlayer);
      counts[player.position] = (counts[player.position] || 0) + 1;
      return counts;
    }, {});
  }

  function starterNeed(position, roster, settings) {
    const config = cloneSettings(settings);
    const counts = countPositions(roster);
    const slots = config.slots;
    const direct = Math.max(0, finite(slots[position], 0) - finite(counts[position], 0));
    if (!SKILL_POSITIONS.has(position)) return direct;

    const flexCount = finite(slots.FLEX, 0) + finite(slots.SUPERFLEX, 0);
    const skillRostered = ["RB", "WR", "TE"].reduce(
      (total, key) => total + finite(counts[key], 0),
      0,
    );
    const directSkill = ["RB", "WR", "TE"].reduce(
      (total, key) => total + finite(slots[key], 0),
      0,
    );
    const flexNeed = Math.max(0, directSkill + flexCount - skillRostered);
    const qbSuperflexNeed = position === "QB"
      ? Math.max(0, finite(slots.QB, 1) + finite(slots.SUPERFLEX, 0) - finite(counts.QB, 0))
      : 0;
    return Math.max(direct, position === "QB" ? qbSuperflexNeed : Math.min(1, flexNeed));
  }
  function tierCliff(player, availablePlayers) {
    const peers = (availablePlayers || [])
      .map(normalizePlayer)
      .filter((candidate) => candidate.position === player.position)
      .sort((a, b) => b.projectedPoints - a.projectedPoints);
    const index = peers.findIndex((candidate) => candidate.id === player.id);
    if (index < 0) return 0;
    const comparison = peers[Math.min(peers.length - 1, index + 5)];
    return comparison ? Math.max(0, player.projectedPoints - comparison.projectedPoints) : 0;
  }

  function buildTierCliffMap(availablePlayers) {
    const byPosition = new Map();
    (availablePlayers || []).map(normalizePlayer).forEach((player) => {
      if (!byPosition.has(player.position)) byPosition.set(player.position, []);
      byPosition.get(player.position).push(player);
    });
    const cliffs = new Map();
    byPosition.forEach((rows) => {
      rows.sort((a, b) => b.projectedPoints - a.projectedPoints);
      rows.forEach((player, index) => {
        const comparison = rows[Math.min(rows.length - 1, index + 5)];
        cliffs.set(player.id, comparison ? Math.max(0, player.projectedPoints - comparison.projectedPoints) : 0);
      });
    });
    return cliffs;
  }

  function draftAssetValue(player, replacementLevels, settings) {
    const normalized = normalizePlayer(player);
    const replacement = finite(replacementLevels?.[normalized.position], 0);
    const vorp = normalized.projectedPoints - replacement;
    const rank = rankForScoring(normalized, settings?.scoring || "ppr");
    const rankBonus = Math.max(0, 180 - rank) * 0.11;
    const durability = normalized.previousPoints > 0
      ? Math.min(12, normalized.previousPoints * 0.025)
      : 0;
    const riskPenalty = normalized.injuryRisk * 26;
    return normalized.projectedPoints * 0.22 + vorp * 1.8 + rankBonus + durability - riskPenalty;
  }

  function rosterConstructionPenalty(player, roster, settings, pickNumber) {
    const config = cloneSettings(settings);
    const counts = countPositions(roster);
    const positionCount = finite(counts[player.position], 0);
    const starterCount = finite(config.slots[player.position], 0);
    const earlyFraction = pickNumber / Math.max(1, config.teams * config.rounds);
    let penalty = 0;

    if ((player.position === "K" || player.position === "DST") && earlyFraction < 0.72) {
      penalty += 24 * (0.72 - earlyFraction);
    }
    if (player.position === "QB" && finite(config.slots.SUPERFLEX, 0) === 0 && positionCount >= 1 && earlyFraction < 0.55) {
      penalty += 9;
    }
    if (positionCount >= starterCount + 3 && !["RB", "WR"].includes(player.position)) {
      penalty += 8;
    }
    return penalty;
  }
  function recommendPlayers(players, state = {}, settings = {}, teamId, limit = 20) {
    const config = cloneSettings(settings);
    const normalizedPlayers = (players || []).map(normalizePlayer);
    const byId = new Map(normalizedPlayers.map((player) => [player.id, player]));
    const draftedIds = new Set((state.picks || []).map((pick) => String(pick.playerId)));
    const available = normalizedPlayers.filter((player) => !draftedIds.has(player.id));
    const tierCliffs = buildTierCliffMap(available);
    const replacementLevels = computeReplacementLevels(normalizedPlayers, config);
    const roster = rosterPlayerIds(state, teamId).map((id) => byId.get(id)).filter(Boolean);
    const pickNumber = (state.picks || []).length + 1;

    return available.map((player) => {
      const replacement = finite(replacementLevels[player.position], 0);
      const vorp = player.projectedPoints - replacement;
      const need = starterNeed(player.position, roster, config);
      const cliff = tierCliffs.get(player.id) || 0;
      const rank = rankForScoring(player, config.scoring);
      const adpPressure = player.adp === null
        ? 0
        : clamp((pickNumber - player.adp) * 0.34, -9, 12);
      const needBonus = need > 0 ? 13 + need * 4.5 : 0;
      const riskPenalty = player.injuryRisk * (18 - config.riskTolerance * 10);
      const constructionPenalty = rosterConstructionPenalty(player, roster, config, pickNumber);
      const assetValue = draftAssetValue(player, replacementLevels, config);
      const score = assetValue + needBonus + cliff * 0.9 + adpPressure - riskPenalty - constructionPenalty;
      const reasons = [];

      if (need > 0) reasons.push(`fills ${player.position} starter need`);
      if (vorp > 18) reasons.push(`+${vorp.toFixed(0)} points over replacement`);
      if (cliff > 8) reasons.push(`${player.position} tier drops after him`);
      if (adpPressure > 4) reasons.push(`falling past ADP ${player.adp.toFixed(1)}`);
      if (player.injuryRisk >= 0.35) reasons.push(`${player.injuryStatus.toLowerCase()} risk`);
      if (!reasons.length) reasons.push(`ranked ${Math.round(rank)} for ${config.scoring}`);

      return {
        ...player,
        score: Number(score.toFixed(2)),
        vorp: Number(vorp.toFixed(2)),
        replacement: Number(replacement.toFixed(2)),
        tierCliff: Number(cliff.toFixed(2)),
        need,
        reasons,
      };
    }).sort((a, b) => b.score - a.score || rankForScoring(a, config.scoring) - rankForScoring(b, config.scoring))
      .slice(0, Math.max(1, limit));
  }

  function marketRank(player, settings = {}) {
    const normalized = normalizePlayer(player);
    return normalized.adp || rankForScoring(normalized, settings.scoring || "ppr") || 9999;
  }

  function draftSpread(player, settings = {}) {
    const rank = marketRank(player, settings);
    const positionScale = player.position === "QB" && settings.scoring === "superflex" ? 0.82 : 1;
    return clamp((4.5 + rank * 0.12) * positionScale, 4.5, 28);
  }

  function logistic(value) {
    if (value >= 35) return 1;
    if (value <= -35) return 0;
    return 1 / (1 + Math.exp(-value));
  }

  function conditionalAvailability(player, currentPick, targetPick, settings = {}, pressure = 0) {
    const normalized = normalizePlayer(player);
    const current = Math.max(1, Math.round(finite(currentPick, 1)));
    const target = Math.max(current, Math.round(finite(targetPick, current)));
    if (target <= current) return 1;
    const center = marketRank(normalized, settings);
    const spread = draftSpread(normalized, settings);
    const draftedByCurrent = logistic(((current - 0.5) - center) / spread);
    const draftedByTarget = logistic(((target - 0.5) - center) / spread);
    const survivalCurrent = Math.max(1e-6, 1 - draftedByCurrent);
    const survivalTarget = Math.max(0, 1 - draftedByTarget);
    const conditional = survivalTarget / survivalCurrent;
    const pressureMultiplier = Math.exp(-Math.max(0, finite(pressure, 0)) * 0.035);
    return clamp(conditional * pressureMultiplier, 0, 1);
  }

  function nextPickNumberForTeam(state, settings = {}, targetTeamId, startPick = null) {
    const config = cloneSettings(settings);
    const first = startPick === null
      ? (state?.picks || []).length + 1
      : Math.max(1, Math.round(finite(startPick, 1)));
    const maxPick = config.teams * config.rounds;
    for (let pick = first; pick <= maxPick; pick += 1) {
      if (snakeTeamForPick(pick, config.teams) === Number(targetTeamId)) return pick;
    }
    return null;
  }

  function opponentPositionPressure(position, state, settings, byId, startPick, targetPick, targetTeamId) {
    if (!targetPick || targetPick <= startPick) return 0;
    let pressure = 0;
    for (let pick = startPick; pick < targetPick; pick += 1) {
      const teamId = snakeTeamForPick(pick, settings.teams);
      if (Number(teamId) === Number(targetTeamId)) continue;
      const roster = rosterPlayerIds(state, teamId).map((id) => byId.get(id)).filter(Boolean);
      pressure += starterNeed(position, roster, settings) > 0 ? 1 : 0.18;
    }
    return pressure;
  }

  function expectedFuturePositionValue(player, candidates, currentPick, targetPick, settings, replacementLevels, availabilityById, pressure) {
    const normalized = normalizePlayer(player);
    const peers = candidates
      .filter((candidate) => candidate.id !== normalized.id && candidate.position === normalized.position)
      .sort((a, b) => draftAssetValue(b, replacementLevels, settings) - draftAssetValue(a, replacementLevels, settings))
      .slice(0, 14);
    let noneHigher = 1;
    let expected = 0;
    peers.forEach((peer) => {
      const probability = availabilityById && Number.isFinite(availabilityById[peer.id])
        ? availabilityById[peer.id]
        : conditionalAvailability(peer, currentPick, targetPick, settings, pressure);
      const firstAvailable = noneHigher * probability;
      expected += firstAvailable * draftAssetValue(peer, replacementLevels, settings);
      noneHigher *= (1 - probability);
    });
    expected += noneHigher * finite(replacementLevels[normalized.position], 0) * 0.45;
    return expected;
  }

  function advancedDraftRecommendations(players, state = {}, settings = {}, teamId, limit = 20, simulation = null) {
    const config = cloneSettings(settings);
    const normalizedPlayers = uniquePlayers(players || []);
    const byId = new Map(normalizedPlayers.map((player) => [player.id, player]));
    const draftedIds = new Set((state.picks || []).map((pick) => String(pick.playerId)));
    const available = normalizedPlayers.filter((player) => !draftedIds.has(player.id));
    const base = recommendPlayers(normalizedPlayers, state, config, teamId, Math.max(80, limit * 8));
    const currentPick = (state.picks || []).length + 1;
    const currentTeam = snakeTeamForPick(currentPick, config.teams);
    const targetStart = Number(currentTeam) === Number(teamId) ? currentPick + 1 : currentPick;
    const targetPick = nextPickNumberForTeam(state, config, teamId, targetStart) || currentPick;
    const replacementLevels = computeReplacementLevels(normalizedPlayers, config);
    const picksBetween = Math.max(0, targetPick - currentPick);
    const pressureByPosition = {};
    ["QB", "RB", "WR", "TE", "DST", "K"].forEach((position) => {
      pressureByPosition[position] = opponentPositionPressure(
        position,
        state,
        config,
        byId,
        targetStart,
        targetPick,
        teamId,
      );
    });
    const simulationAvailability = simulation?.availabilityById || null;
    const runRates = simulation?.positionRunRates || {};

    return base.map((player) => {
      const pressure = finite(pressureByPosition[player.position], 0);
      const returnChance = simulationAvailability && Number.isFinite(simulationAvailability[player.id])
        ? simulationAvailability[player.id]
        : conditionalAvailability(player, currentPick, targetPick, config, pressure);
      const futureValue = expectedFuturePositionValue(
        player,
        available,
        currentPick,
        targetPick,
        config,
        replacementLevels,
        simulationAvailability,
        pressure,
      );
      const assetValue = draftAssetValue(player, replacementLevels, config);
      const vona = assetValue - futureValue;
      const runRisk = Number.isFinite(runRates[player.position])
        ? runRates[player.position]
        : clamp(pressure / Math.max(1, picksBetween), 0, 1);
      const urgency = clamp(
        (1 - returnChance) * 58 + Math.max(0, vona) * 1.35 + runRisk * 16 + player.tierCliff * 0.45,
        0,
        100,
      );
      const decision = returnChance < 0.25 || vona >= 12
        ? "Draft now"
        : returnChance < 0.58 || urgency >= 58
          ? "Priority target"
          : "Can wait";
      const advancedReasons = [...player.reasons];
      if (targetPick > currentPick) {
        advancedReasons.push(Math.round(returnChance * 100) + "% estimated chance to return");
      }
      if (vona >= 5) advancedReasons.push("waiting costs about " + vona.toFixed(1) + " value");
      if (runRisk >= 0.45) advancedReasons.push(player.position + " run pressure is elevated");
      const advancedScore = player.score + Math.max(-8, vona * 0.48) + (1 - returnChance) * 8 + runRisk * 3;
      return {
        ...player,
        score: Number(advancedScore.toFixed(2)),
        baseScore: player.score,
        returnChance: Number(returnChance.toFixed(4)),
        vona: Number(vona.toFixed(2)),
        expectedFutureValue: Number(futureValue.toFixed(2)),
        runRisk: Number(runRisk.toFixed(3)),
        urgency: Number(urgency.toFixed(1)),
        decision,
        nextTeamPick: targetPick,
        reasons: advancedReasons,
      };
    }).sort((a, b) => b.score - a.score || a.returnChance - b.returnChance)
      .slice(0, Math.max(1, limit));
  }

  function seededRandom(seed) {
    let value = (Math.round(finite(seed, 1)) >>> 0) || 1;
    return function random() {
      value += 0x6D2B79F5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gumbel(random) {
    const value = clamp(random(), 1e-9, 1 - 1e-9);
    return -Math.log(-Math.log(value));
  }

  function cloneRostersWithPlayers(state, settings, byId) {
    const rosters = {};
    for (let teamId = 1; teamId <= settings.teams; teamId += 1) {
      rosters[String(teamId)] = rosterPlayerIds(state, teamId).map((id) => byId.get(id)).filter(Boolean);
    }
    return rosters;
  }

  function simulationStarterNeed(position, counts, slots) {
    const direct = Math.max(0, finite(slots[position], 0) - finite(counts[position], 0));
    if (!SKILL_POSITIONS.has(position)) return direct;
    const flexCount = finite(slots.FLEX, 0) + finite(slots.SUPERFLEX, 0);
    const skillRostered = finite(counts.RB, 0) + finite(counts.WR, 0) + finite(counts.TE, 0);
    const directSkill = finite(slots.RB, 0) + finite(slots.WR, 0) + finite(slots.TE, 0);
    const flexNeed = Math.max(0, directSkill + flexCount - skillRostered);
    const qbSuperflexNeed = position === "QB"
      ? Math.max(0, finite(slots.QB, 1) + finite(slots.SUPERFLEX, 0) - finite(counts.QB, 0))
      : 0;
    return Math.max(direct, position === "QB" ? qbSuperflexNeed : Math.min(1, flexNeed));
  }

  function simulatePickWindow(options = {}) {
    const config = cloneSettings(options.settings || {});
    const normalizedPlayers = uniquePlayers(options.players || []);
    const byId = new Map(normalizedPlayers.map((player) => [player.id, player]));
    const state = options.state || { picks: [], rosters: {} };
    const draftedIds = new Set((state.picks || []).map((pick) => String(pick.playerId)));
    const market = normalizedPlayers
      .filter((player) => !draftedIds.has(player.id))
      .map((player) => {
        const rank = player.adp || rankForScoring(player, config.scoring) || 9999;
        const positionScale = player.position === "QB" && config.scoring === "superflex" ? 0.82 : 1;
        return {
          player,
          id: player.id,
          position: player.position,
          projectedPoints: player.projectedPoints,
          rank,
          spread: clamp((4.5 + rank * 0.12) * positionScale, 4.5, 28),
        };
      })
      .sort((a, b) => a.rank - b.rank || b.projectedPoints - a.projectedPoints);
    const trackedLength = Math.min(
      market.length,
      Math.max(40, Math.round(finite(options.trackLimit, 140))),
    );
    const currentPick = (state.picks || []).length + 1;
    const targetTeamId = Number(options.targetTeamId || config.draftPosition);
    const currentTeam = snakeTeamForPick(currentPick, config.teams);
    const startPick = Number(currentTeam) === targetTeamId ? currentPick + 1 : currentPick;
    const targetPick = nextPickNumberForTeam(state, config, targetTeamId, startPick) || currentPick;
    const pickSequence = [];
    for (let pick = startPick; pick < targetPick; pick += 1) {
      pickSequence.push({ pick, teamId: snakeTeamForPick(pick, config.teams) });
    }
    const simulations = Math.round(clamp(options.simulations || 800, 20, 250000));
    const random = seededRandom(options.seed ?? (currentPick * 7919 + targetTeamId * 104729));
    const availableCounts = new Uint32Array(trackedLength);
    const takenCounts = Object.create(null);
    const positionCounts = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0, K: 0 };
    const involvedTeams = [...new Set(pickSequence.map((row) => String(row.teamId)))];
    const baseCounts = Object.fromEntries(involvedTeams.map((teamId) => {
      const roster = rosterPlayerIds(state, teamId).map((id) => byId.get(id)).filter(Boolean);
      return [teamId, countPositions(roster)];
    }));

    for (let simulationIndex = 0; simulationIndex < simulations; simulationIndex += 1) {
      const available = new Uint8Array(market.length);
      available.fill(1);
      const countsByTeam = Object.fromEntries(
        involvedTeams.map((teamId) => [teamId, { ...(baseCounts[teamId] || {}) }]),
      );
      for (const selection of pickSequence) {
        const counts = countsByTeam[String(selection.teamId)] || {};
        let selectedIndex = -1;
        let selectedScore = -Infinity;
        let candidateCount = 0;
        for (let index = 0; index < market.length && candidateCount < 52; index += 1) {
          if (!available[index]) continue;
          candidateCount += 1;
          const candidate = market[index];
          const need = simulationStarterNeed(candidate.position, counts, config.slots);
          const reachPenalty = Math.max(0, candidate.rank - selection.pick) * 0.11;
          const fallBonus = Math.max(0, selection.pick - candidate.rank) * 0.24;
          const score = -candidate.rank * 0.62 + need * 9.5 + fallBonus - reachPenalty +
            candidate.projectedPoints * 0.018 + gumbel(random) * candidate.spread * 0.72;
          if (score > selectedScore) {
            selectedIndex = index;
            selectedScore = score;
          }
        }
        if (selectedIndex < 0) break;
        const selected = market[selectedIndex];
        available[selectedIndex] = 0;
        counts[selected.position] = finite(counts[selected.position], 0) + 1;
        countsByTeam[String(selection.teamId)] = counts;
        takenCounts[selected.id] = finite(takenCounts[selected.id], 0) + 1;
        positionCounts[selected.position] = finite(positionCounts[selected.position], 0) + 1;
      }
      for (let index = 0; index < trackedLength; index += 1) {
        if (available[index]) availableCounts[index] += 1;
      }
    }

    const denominator = Math.max(1, simulations);
    const runDenominator = Math.max(1, simulations * Math.max(1, pickSequence.length));
    return {
      currentPick,
      startPick,
      targetPick,
      targetTeamId,
      simulations,
      availabilityById: Object.fromEntries(
        Array.from({ length: trackedLength }, (_, index) => [
          market[index].id,
          Number((availableCounts[index] / denominator).toFixed(4)),
        ]),
      ),
      takenById: Object.fromEntries(
        Object.entries(takenCounts).map(([id, count]) => [id, Number((count / denominator).toFixed(4))]),
      ),
      positionRunRates: Object.fromEntries(
        Object.entries(positionCounts).map(([position, count]) => [position, Number((count / runDenominator).toFixed(4))]),
      ),
    };
  }

  function minimumCostAssignment(costs) {
    const rows = costs.length;
    const columns = rows ? costs[0].length : 0;
    if (!rows || !columns) return [];
    const rowPotential = new Float64Array(rows + 1);
    const columnPotential = new Float64Array(columns + 1);
    const matchedRow = new Int32Array(columns + 1);
    const previousColumn = new Int32Array(columns + 1);

    for (let row = 1; row <= rows; row += 1) {
      matchedRow[0] = row;
      let currentColumn = 0;
      const minimum = new Float64Array(columns + 1);
      minimum.fill(Number.POSITIVE_INFINITY);
      const used = new Uint8Array(columns + 1);
      do {
        used[currentColumn] = 1;
        const currentRow = matchedRow[currentColumn];
        let delta = Number.POSITIVE_INFINITY;
        let nextColumn = 0;
        for (let column = 1; column <= columns; column += 1) {
          if (used[column]) continue;
          const reduced = costs[currentRow - 1][column - 1] -
            rowPotential[currentRow] - columnPotential[column];
          if (reduced < minimum[column]) {
            minimum[column] = reduced;
            previousColumn[column] = currentColumn;
          }
          if (minimum[column] < delta) {
            delta = minimum[column];
            nextColumn = column;
          }
        }
        for (let column = 0; column <= columns; column += 1) {
          if (used[column]) {
            rowPotential[matchedRow[column]] += delta;
            columnPotential[column] -= delta;
          } else {
            minimum[column] -= delta;
          }
        }
        currentColumn = nextColumn;
      } while (matchedRow[currentColumn] !== 0);

      do {
        const priorColumn = previousColumn[currentColumn];
        matchedRow[currentColumn] = matchedRow[priorColumn];
        currentColumn = priorColumn;
      } while (currentColumn !== 0);
    }

    const assignment = Array(rows).fill(-1);
    for (let column = 1; column <= columns; column += 1) {
      if (matchedRow[column] > 0) assignment[matchedRow[column] - 1] = column - 1;
    }
    return assignment;
  }

  function optimizeLineup(roster, settings = {}, metric = "weeklyProjection") {
    const players = (roster || []).map(normalizePlayer);
    const slots = expandedStarterSlots(settings).sort((a, b) => {
      const sizeA = slotEligibility(a.slot)?.size || 99;
      const sizeB = slotEligibility(b.slot)?.size || 99;
      return sizeA - sizeB || a.slot.localeCompare(b.slot);
    });
    if (!slots.length) {
      return { starters: [], bench: players, total: 0, filled: 0, slots: 0 };
    }
    const dummyCount = slots.length;
    const costs = slots.map((slot) => {
      const eligible = slotEligibility(slot.slot);
      const real = players.map((player) => (
        eligible?.has(player.position)
          ? -finite(player[metric], finite(player.projectedPoints, 0))
          : 1_000_000
      ));
      return [...real, ...Array(dummyCount).fill(0)];
    });
    const assignment = minimumCostAssignment(costs);
    const usedIds = new Set();
    let total = 0;
    const starters = slots.map((slot, index) => {
      const column = assignment[index];
      const player = column >= 0 && column < players.length ? players[column] : null;
      const eligible = player && slotEligibility(slot.slot)?.has(player.position);
      if (!eligible) return { slot: slot.slot, slotKey: slot.key, player: null };
      usedIds.add(player.id);
      total += finite(player[metric], finite(player.projectedPoints, 0));
      return { slot: slot.slot, slotKey: slot.key, player };
    });
    const bench = players
      .filter((player) => !usedIds.has(player.id))
      .sort((a, b) => finite(b[metric]) - finite(a[metric]));
    return {
      starters,
      bench,
      total: Number(total.toFixed(2)),
      filled: starters.filter((row) => row.player).length,
      slots: starters.length,
    };
  }

  function optimizeWeeklyLineup(roster, settings = {}, week = 1) {
    const selectedWeek = Math.round(clamp(week, 1, 18));
    const prepared = (roster || []).map((rawPlayer) => {
      const player = normalizePlayer(rawPlayer);
      return { ...player, weekProjection: playerWeekProjection(player, selectedWeek) };
    });
    const result = optimizeLineup(prepared, settings, "weekProjection");
    return { ...result, week: selectedWeek };
  }

  function weeklyReplacementLevels(players, settings = {}, week = 1) {
    const demand = positionDemand(settings);
    const levels = {};
    Object.entries(demand).forEach(([position, count]) => {
      const rows = (players || [])
        .map(normalizePlayer)
        .filter((player) => player.position === position)
        .sort((a, b) => playerWeekProjection(b, week) - playerWeekProjection(a, week));
      const index = Math.max(0, Math.min(rows.length - 1, Math.round(count) - 1));
      levels[position] = rows.length ? playerWeekProjection(rows[index], week) : 0;
    });
    return levels;
  }

  function scoreGrade(score) {
    if (score >= 90) return "A+";
    if (score >= 82) return "A";
    if (score >= 74) return "B";
    if (score >= 64) return "C";
    if (score >= 54) return "D";
    return "F";
  }

  function analyzeRoster(options = {}) {
    const settings = cloneSettings(options.settings || {});
    const roster = uniquePlayers(options.roster || []);
    const universe = uniquePlayers(options.players || roster);
    const week = Math.round(clamp(options.week || 1, 1, 18));
    const lineup = optimizeWeeklyLineup(roster, settings, week);
    const replacement = weeklyReplacementLevels(universe, settings, week);
    const starters = lineup.starters.filter((row) => row.player);
    const starterIds = new Set(starters.map((row) => row.player.id));
    const byePlayers = roster.filter((player) => player.byeWeek === week);
    const injuryPlayers = roster.filter((player) => player.injuryRisk >= 0.35);
    let floor = 0;
    let ceiling = 0;
    let totalVorp = 0;
    let reliabilityTotal = 0;
    starters.forEach((row) => {
      const player = row.player;
      const range = playerWeekRange(player, week);
      floor += range.floor;
      ceiling += range.ceiling;
      totalVorp += playerWeekProjection(player, week) - finite(replacement[player.position], 0);
      reliabilityTotal += player.reliability;
    });
    const benchProjection = lineup.bench.slice(0, 5).reduce(
      (total, player, index) => total + playerWeekProjection(player, week) * (1 - index * 0.12),
      0,
    );
    const starterInjuryExposure = starters.reduce(
      (total, row) => total + row.player.injuryRisk * playerWeekProjection(row.player, week),
      0,
    ) / Math.max(1, lineup.total);
    const byeStarterCount = starters.filter((row) => row.player.byeWeek === week).length;
    const strengthScore = clamp(
      50 + totalVorp * 1.75 + benchProjection * 0.16 - starterInjuryExposure * 21 - byeStarterCount * 7,
      0,
      100,
    );
    const positionRows = ["QB", "RB", "WR", "TE", "DST", "K"].map((position) => {
      const rows = roster.filter((player) => player.position === position);
      const active = starters.filter((row) => row.player.position === position).map((row) => row.player);
      const points = active.reduce((total, player) => total + playerWeekProjection(player, week), 0);
      const baseline = finite(replacement[position], 0) * Math.max(1, active.length);
      const depth = rows.filter((player) => !starterIds.has(player.id)).reduce(
        (total, player) => total + playerWeekProjection(player, week),
        0,
      );
      const score = clamp(55 + (points - baseline) * 4 + Math.min(12, depth * 0.5), 0, 100);
      return {
        position,
        count: rows.length,
        starters: active.length,
        points: Number(points.toFixed(2)),
        replacement: Number(baseline.toFixed(2)),
        depth: Number(depth.toFixed(2)),
        score: Number(score.toFixed(1)),
        grade: scoreGrade(score),
      };
    }).filter((row) => row.count || finite(settings.slots[row.position], 0));
    const byeConflicts = [];
    for (let selectedWeek = 1; selectedWeek <= 18; selectedWeek += 1) {
      const rows = roster.filter((player) => player.byeWeek === selectedWeek);
      if (rows.length >= 2) byeConflicts.push({ week: selectedWeek, players: rows });
    }
    let seasonProjection = 0;
    for (let selectedWeek = 1; selectedWeek <= 17; selectedWeek += 1) {
      seasonProjection += optimizeWeeklyLineup(roster, settings, selectedWeek).total;
    }
    const weakestPositions = [...positionRows]
      .sort((a, b) => a.score - b.score)
      .slice(0, 2)
      .map((row) => row.position);
    return {
      week,
      lineup,
      floor: Number(floor.toFixed(2)),
      ceiling: Number(ceiling.toFixed(2)),
      reliability: Number((reliabilityTotal / Math.max(1, starters.length)).toFixed(3)),
      benchProjection: Number(benchProjection.toFixed(2)),
      strengthScore: Number(strengthScore.toFixed(1)),
      grade: scoreGrade(strengthScore),
      seasonProjection: Number(seasonProjection.toFixed(2)),
      totalVorp: Number(totalVorp.toFixed(2)),
      byePlayers,
      injuryPlayers,
      byeConflicts,
      positions: positionRows,
      weakestPositions,
    };
  }

  function uniquePlayers(players) {
    const seen = new Set();
    return (players || []).map(normalizePlayer).filter((player) => {
      if (!player.id || seen.has(player.id)) return false;
      seen.add(player.id);
      return true;
    });
  }

  function benchDepth(lineup, metric = "weeklyProjection") {
    return (lineup?.bench || [])
      .slice(0, 4)
      .reduce((total, player, index) => total + finite(player?.[metric], finite(player?.weeklyProjection, 0)) * (1 - index * 0.14), 0);
  }

  function tradeGrade(score) {
    if (score >= 18) return { grade: "A+", verdict: "Major upgrade" };
    if (score >= 10) return { grade: "A", verdict: "Strong accept" };
    if (score >= 4) return { grade: "B", verdict: "Helpful trade" };
    if (score > -4) return { grade: "C", verdict: "Mostly even" };
    if (score > -10) return { grade: "D", verdict: "You lose value" };
    return { grade: "F", verdict: "Reject" };
  }

  function analyzeTrade(options = {}) {
    const settings = cloneSettings(options.settings || {});
    const roster = uniquePlayers(options.roster || []);
    const give = uniquePlayers(options.give || []);
    const receive = uniquePlayers(options.receive || []);
    const giveIds = new Set(give.map((player) => player.id));
    const afterRoster = uniquePlayers([
      ...roster.filter((player) => !giveIds.has(player.id)),
      ...receive,
    ]);
    const universe = uniquePlayers(options.players || [...roster, ...give, ...receive]);
    const replacement = options.replacementLevels || computeReplacementLevels(universe, settings);
    const selectedWeek = options.week ? Math.round(clamp(options.week, 1, 18)) : null;
    const before = options.beforeLineup || (selectedWeek ? optimizeWeeklyLineup(roster, settings, selectedWeek) : optimizeLineup(roster, settings));
    const after = selectedWeek ? optimizeWeeklyLineup(afterRoster, settings, selectedWeek) : optimizeLineup(afterRoster, settings);
    const giveValue = give.reduce(
      (total, player) => total + draftAssetValue(player, replacement, settings),
      0,
    );
    const receiveValue = receive.reduce(
      (total, player) => total + draftAssetValue(player, replacement, settings),
      0,
    );
    const lineupGain = after.total - before.total;
    const assetGain = receiveValue - giveValue;
    const depthMetric = selectedWeek ? "weekProjection" : "weeklyProjection";
    const depthGain = benchDepth(after, depthMetric) - benchDepth(before, depthMetric);
    const score = lineupGain * 8 + assetGain * 0.34 + depthGain * 1.8;
    const fairnessDenominator = Math.max(1, giveValue, receiveValue);
    const fairness = 1 - Math.min(1, Math.abs(receiveValue - giveValue) / fairnessDenominator);
    const grade = tradeGrade(score);

    return {
      ...grade,
      score: Number(score.toFixed(2)),
      fairness: Number((fairness * 100).toFixed(0)),
      lineupGain: Number(lineupGain.toFixed(2)),
      assetGain: Number(assetGain.toFixed(2)),
      depthGain: Number(depthGain.toFixed(2)),
      giveValue: Number(giveValue.toFixed(2)),
      receiveValue: Number(receiveValue.toFixed(2)),
      before,
      after,
      afterRoster,
      summary: lineupGain > 0
        ? `Adds ${lineupGain.toFixed(1)} projected starter points per week.`
        : `Changes projected starter output by ${lineupGain.toFixed(1)} points per week.`,
    };
  }


  function combinations(rows, size) {
    if (size === 1) return rows.map((row) => [row]);
    const output = [];
    for (let first = 0; first < rows.length; first += 1) {
      for (let second = first + 1; second < rows.length; second += 1) {
        output.push([rows[first], rows[second]]);
      }
    }
    return output;
  }

  function lowerBoundPackageValue(packages, target) {
    let low = 0;
    let high = packages.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (packages[middle].value < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function valuedPackages(assets, size, assetScore) {
    return combinations(assets, size).map((players) => ({
      players,
      value: players.reduce((total, player) => total + assetScore(player), 0),
    }));
  }

  function generateTradeProposals(options = {}) {
    const settings = cloneSettings(options.settings || {});
    const userRoster = uniquePlayers(options.userRoster || []);
    const opponentRoster = uniquePlayers(options.opponentRoster || []);
    if (!userRoster.length || !opponentRoster.length) return [];
    const universe = uniquePlayers(options.players || [...userRoster, ...opponentRoster]);
    const replacement = computeReplacementLevels(universe, settings);
    const week = options.week ? Math.round(clamp(options.week, 1, 18)) : null;
    const assetLimit = Math.round(clamp(options.assetLimit || 9, 6, 16));
    const includeTwoForTwo = options.includeTwoForTwo === true;
    const minimumRawFairness = clamp(options.minimumRawFairness ?? 0.58, 0.35, 0.95);
    const minimumFairness = Math.round(clamp(options.minimumFairness || 62, 45, 95));
    const neighbors = Math.round(clamp(options.packageNeighbors || (includeTwoForTwo ? 20 : 12), 4, 60));
    const maxEvaluations = Math.round(clamp(options.maxEvaluations || (includeTwoForTwo ? 900 : 600), 100, 12000));
    const assetScore = (player) => draftAssetValue(player, replacement, settings);
    const eligibleAsset = (player) => !["K", "DST"].includes(player.position) || player.percentOwned >= 70;
    const userAssets = userRoster.filter(eligibleAsset).sort((a, b) => assetScore(b) - assetScore(a)).slice(0, assetLimit);
    const opponentAssets = opponentRoster.filter(eligibleAsset).sort((a, b) => assetScore(b) - assetScore(a)).slice(0, assetLimit);
    const userBefore = week ? optimizeWeeklyLineup(userRoster, settings, week) : optimizeLineup(userRoster, settings);
    const opponentBefore = week ? optimizeWeeklyLineup(opponentRoster, settings, week) : optimizeLineup(opponentRoster, settings);
    const pairSizes = [[1, 1], [2, 1], [1, 2]];
    if (includeTwoForTwo) pairSizes.push([2, 2]);
    const candidates = new Map();

    pairSizes.forEach(([giveSize, receiveSize]) => {
      const givePackages = valuedPackages(userAssets, giveSize, assetScore);
      const receivePackages = valuedPackages(opponentAssets, receiveSize, assetScore)
        .sort((a, b) => a.value - b.value);
      givePackages.forEach((givePackage) => {
        const center = lowerBoundPackageValue(receivePackages, givePackage.value);
        const first = Math.max(0, center - neighbors);
        const last = Math.min(receivePackages.length, center + neighbors + 1);
        for (let index = first; index < last; index += 1) {
          const receivePackage = receivePackages[index];
          const rawFairness = 1 - Math.abs(receivePackage.value - givePackage.value) /
            Math.max(1, receivePackage.value, givePackage.value);
          if (rawFairness < minimumRawFairness) continue;
          const key = givePackage.players.map((player) => player.id).sort().join(",") + "->" +
            receivePackage.players.map((player) => player.id).sort().join(",");
          const quickScore = rawFairness * 100 - Math.abs(giveSize - receiveSize) * 1.5;
          const candidate = {
            give: givePackage.players,
            receive: receivePackage.players,
            rawFairness,
            quickScore,
          };
          if (!candidates.has(key) || candidates.get(key).quickScore < quickScore) {
            candidates.set(key, candidate);
          }
        }
      });
    });

    const proposals = [];
    [...candidates.values()]
      .sort((a, b) => b.quickScore - a.quickScore)
      .slice(0, maxEvaluations)
      .forEach(({ give, receive }) => {
        const userAnalysis = analyzeTrade({
          roster: userRoster,
          give,
          receive,
          players: universe,
          settings,
          week,
          replacementLevels: replacement,
          beforeLineup: userBefore,
        });
        const opponentAnalysis = analyzeTrade({
          roster: opponentRoster,
          give: receive,
          receive: give,
          players: universe,
          settings,
          week,
          replacementLevels: replacement,
          beforeLineup: opponentBefore,
        });
        const fairness = Math.round((userAnalysis.fairness + opponentAnalysis.fairness) / 2);
        if (userAnalysis.score < -1.5 || opponentAnalysis.score < -4.5 || fairness < minimumFairness) return;
        const mutualScore = userAnalysis.score + Math.max(-2, opponentAnalysis.score) * 0.45 + fairness * 0.055;
        proposals.push({
          give,
          receive,
          userAnalysis,
          opponentAnalysis,
          fairness,
          mutualScore: Number(mutualScore.toFixed(2)),
          packageType: give.length + "-for-" + receive.length,
          summary: userAnalysis.lineupGain > 0.25 && opponentAnalysis.lineupGain > 0.25
            ? "Both optimized lineups improve."
            : userAnalysis.lineupGain > 0.25
              ? "Improves your starters while preserving plausible value for the opponent."
              : "A value-balanced depth and roster-fit exchange.",
        });
      });

    const deduped = new Map();
    proposals.sort((a, b) => b.mutualScore - a.mutualScore).forEach((proposal) => {
      const key = proposal.give.map((player) => player.id).sort().join(",") + "->" +
        proposal.receive.map((player) => player.id).sort().join(",");
      if (!deduped.has(key)) deduped.set(key, proposal);
    });
    return [...deduped.values()].slice(0, Math.max(1, Math.round(finite(options.limit, 12))));
  }

  function waiverRecommendations(roster, freeAgents, settings = {}, limit = 12, week = null) {
    const selectedWeek = week ? Math.round(clamp(week, 1, 18)) : null;
    const evaluation = (rawPlayer) => {
      const player = normalizePlayer(rawPlayer);
      return {
        ...player,
        evaluationProjection: selectedWeek ? playerWeekProjection(player, selectedWeek) : player.weeklyProjection,
      };
    };
    const currentRoster = uniquePlayers(roster || []).map(evaluation);
    const available = uniquePlayers(freeAgents || []).map(evaluation)
      .sort((a, b) => b.evaluationProjection - a.evaluationProjection)
      .slice(0, 120);
    const before = optimizeLineup(currentRoster, settings, "evaluationProjection");
    const currentStarterIds = new Set(
      before.starters.filter((row) => row.player).map((row) => row.player.id),
    );
    const suggestions = [];
    const dropCandidates = [...currentRoster]
      .sort((a, b) => a.evaluationProjection - b.evaluationProjection)
      .slice(0, Math.min(8, currentRoster.length));
    available.slice(0, 40).forEach((add) => {
      dropCandidates.forEach((drop) => {
        if (currentStarterIds.has(drop.id) && add.evaluationProjection <= drop.evaluationProjection) return;
        const nextRoster = uniquePlayers([
          ...currentRoster.filter((player) => player.id !== drop.id),
          add,
        ]).map(evaluation);
        const after = optimizeLineup(nextRoster, settings, "evaluationProjection");
        const depthValue = (lineup) => lineup.bench.slice(0, 4).reduce(
          (total, player, index) => total + finite(player.evaluationProjection, 0) * (1 - index * 0.14),
          0,
        );
        const lineupGain = after.total - before.total;
        const depthGain = depthValue(after) - depthValue(before);
        const assetGain = add.projectedPoints - drop.projectedPoints;
        const reliabilityGain = add.reliability - drop.reliability;
        const score = lineupGain * 9 + depthGain * 2 + assetGain * 0.055 + reliabilityGain * 3;
        if (score <= 0.25) return;
        suggestions.push({
          add,
          drop,
          week: selectedWeek,
          score: Number(score.toFixed(2)),
          lineupGain: Number(lineupGain.toFixed(2)),
          depthGain: Number(depthGain.toFixed(2)),
          assetGain: Number(assetGain.toFixed(2)),
          reliabilityGain: Number(reliabilityGain.toFixed(3)),
          reason: lineupGain >= 0.5
            ? "Improves the optimized lineup by " + lineupGain.toFixed(1) + " points."
            : "Raises bench and injury-replacement depth by " + depthGain.toFixed(1) + " points.",
        });
      });
    });
    const bestByAdd = new Map();
    suggestions.sort((a, b) => b.score - a.score).forEach((suggestion) => {
      if (!bestByAdd.has(suggestion.add.id)) bestByAdd.set(suggestion.add.id, suggestion);
    });
    return [...bestByAdd.values()].slice(0, Math.max(1, limit));
  }

  function draftPickSummary(state, settings = {}) {
    const config = cloneSettings(settings);
    const pickNumber = (state?.picks || []).length + 1;
    const teamId = snakeTeamForPick(pickNumber, config.teams);
    return {
      pickNumber,
      round: Math.floor((pickNumber - 1) / config.teams) + 1,
      teamId,
      isUserPick: teamId === config.draftPosition,
      remaining: Math.max(0, config.teams * config.rounds - pickNumber + 1),
    };
  }
  function createDraftState(settings = {}) {
    const config = cloneSettings(settings);
    const rosters = {};
    for (let teamId = 1; teamId <= config.teams; teamId += 1) {
      rosters[String(teamId)] = [];
    }
    return { picks: [], rosters };
  }

  function applyDraftPick(state, playerId, settings = {}, explicitTeamId = null) {
    const config = cloneSettings(settings);
    const nextState = {
      picks: [...(state?.picks || [])],
      rosters: Object.fromEntries(
        Object.entries(state?.rosters || {}).map(([key, value]) => [key, [...value]]),
      ),
    };
    const id = String(playerId || "");
    if (!id || nextState.picks.some((pick) => String(pick.playerId) === id)) return nextState;
    const pickNumber = nextState.picks.length + 1;
    const teamId = explicitTeamId || snakeTeamForPick(pickNumber, config.teams);
    const key = String(teamId);
    if (!nextState.rosters[key]) nextState.rosters[key] = [];
    nextState.picks.push({
      pick: pickNumber,
      round: Math.floor((pickNumber - 1) / config.teams) + 1,
      teamId: Number(teamId),
      playerId: id,
    });
    nextState.rosters[key].push(id);
    return nextState;
  }

  function undoDraftPick(state) {
    const picks = [...(state?.picks || [])];
    const last = picks.pop();
    const rosters = Object.fromEntries(
      Object.entries(state?.rosters || {}).map(([key, value]) => [key, [...value]]),
    );
    if (last) {
      const key = String(last.teamId);
      rosters[key] = (rosters[key] || []).filter((id) => String(id) !== String(last.playerId));
    }
    return { picks, rosters };
  }
  function picksUntilTeam(state, settings = {}, targetTeamId) {
    const config = cloneSettings(settings);
    const currentPick = (state?.picks || []).length + 1;
    const maxPick = config.teams * config.rounds;
    for (let pick = currentPick; pick <= maxPick; pick += 1) {
      if (snakeTeamForPick(pick, config.teams) === Number(targetTeamId)) {
        return pick - currentPick;
      }
    }
    return null;
  }

  function positionColor(position) {
    const colors = {
      QB: "#f0a04b",
      RB: "#49c5b6",
      WR: "#65a7ff",
      TE: "#b58cff",
      FLEX: "#f4d35e",
      SUPERFLEX: "#ff7a90",
      DST: "#9aa7a2",
      K: "#e8c26d",
    };
    return colors[String(position || "").toUpperCase()] || "#9aa7a2";
  }

  return {
    DEFAULT_SETTINGS,
    STARTER_POSITIONS,
    advancedDraftRecommendations,
    analyzeRoster,
    analyzeTrade,
    applyDraftPick,
    cloneSettings,
    computeReplacementLevels,
    conditionalAvailability,
    createDraftState,
    draftAssetValue,
    draftPickSummary,
    expandedStarterSlots,
    generateSnakeOrder,
    generateTradeProposals,
    nextPickNumberForTeam,
    normalizePlayer,
    optimizeLineup,
    optimizeWeeklyLineup,
    picksUntilTeam,
    playerWeekProjection,
    playerWeekRange,
    positionColor,
    rankForScoring,
    recommendPlayers,
    simulatePickWindow,
    snakeTeamForPick,
    undoDraftPick,
    waiverRecommendations,
    weeklyReplacementLevels,
  };
});
