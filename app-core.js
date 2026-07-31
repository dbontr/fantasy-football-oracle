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
    return {
      ...player,
      id: String(player?.id || player?.playerId || player?.name || ""),
      name: String(player?.name || "Unknown player"),
      position,
      team: String(player?.team || "FA").toUpperCase(),
      projectedPoints: finite(player?.projectedPoints, finite(player?.projection, 0)),
      weeklyProjection: finite(
        player?.weeklyProjection,
        finite(player?.projectedPoints, finite(player?.projection, 0)) / 17,
      ),
      previousPoints: finite(player?.previousPoints, 0),
      adp: Number.isFinite(Number(player?.adp)) ? Number(player.adp) : null,
      pprRank: Number.isFinite(Number(player?.pprRank)) ? Number(player.pprRank) : null,
      standardRank: Number.isFinite(Number(player?.standardRank)) ? Number(player.standardRank) : null,
      superflexRank: Number.isFinite(Number(player?.superflexRank)) ? Number(player.superflexRank) : null,
      auctionValue: finite(player?.auctionValue, 0),
      injuryRisk: clamp(player?.injuryRisk, 0, 1),
      injuryStatus: String(player?.injuryStatus || "ACTIVE"),
    };
  }

  function rankForScoring(player, scoring) {
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
  function optimizeLineup(roster, settings = {}, metric = "weeklyProjection") {
    const players = (roster || []).map(normalizePlayer);
    const slots = expandedStarterSlots(settings).sort((a, b) => {
      const sizeA = slotEligibility(a.slot)?.size || 99;
      const sizeB = slotEligibility(b.slot)?.size || 99;
      return sizeA - sizeB || a.slot.localeCompare(b.slot);
    });
    const memo = new Map();

    function solve(slotIndex, usedMask) {
      if (slotIndex >= slots.length) {
        return { score: 0, assignments: [] };
      }
      const key = `${slotIndex}:${usedMask.toString()}`;
      if (memo.has(key)) return memo.get(key);

      const slot = slots[slotIndex];
      const eligible = slotEligibility(slot.slot);
      const skipped = solve(slotIndex + 1, usedMask);
      let best = {
        score: skipped.score,
        assignments: [{ slot: slot.slot, slotKey: slot.key, player: null }, ...skipped.assignments],
      };

      players.forEach((player, playerIndex) => {
        const bit = 1n << BigInt(playerIndex);
        if ((usedMask & bit) !== 0n || !eligible?.has(player.position)) return;
        const next = solve(slotIndex + 1, usedMask | bit);
        const value = finite(player[metric], finite(player.projectedPoints, 0));
        const score = value + next.score;
        if (score > best.score + 1e-9) {
          best = {
            score,
            assignments: [{ slot: slot.slot, slotKey: slot.key, player }, ...next.assignments],
          };
        }
      });

      memo.set(key, best);
      return best;
    }

    const solved = solve(0, 0n);
    const usedIds = new Set(
      solved.assignments.filter((row) => row.player).map((row) => row.player.id),
    );
    const bench = players
      .filter((player) => !usedIds.has(player.id))
      .sort((a, b) => finite(b[metric]) - finite(a[metric]));
    return {
      starters: solved.assignments,
      bench,
      total: Number(solved.score.toFixed(2)),
      filled: solved.assignments.filter((row) => row.player).length,
      slots: solved.assignments.length,
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

  function benchDepth(lineup) {
    return (lineup?.bench || [])
      .slice(0, 4)
      .reduce((total, player, index) => total + player.weeklyProjection * (1 - index * 0.14), 0);
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
    const replacement = computeReplacementLevels(universe, settings);
    const before = optimizeLineup(roster, settings);
    const after = optimizeLineup(afterRoster, settings);
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
    const depthGain = benchDepth(after) - benchDepth(before);
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

  function waiverRecommendations(roster, freeAgents, settings = {}, limit = 12) {
    const currentRoster = uniquePlayers(roster || []);
    const available = uniquePlayers(freeAgents || [])
      .sort((a, b) => b.weeklyProjection - a.weeklyProjection)
      .slice(0, 120);
    const before = optimizeLineup(currentRoster, settings);
    const currentStarterIds = new Set(
      before.starters.filter((row) => row.player).map((row) => row.player.id),
    );
    const suggestions = [];
    const dropCandidates = [...currentRoster]
      .sort((a, b) => a.weeklyProjection - b.weeklyProjection)
      .slice(0, Math.min(8, currentRoster.length));
    available.slice(0, 36).forEach((add) => {
      dropCandidates.forEach((drop) => {
        if (currentStarterIds.has(drop.id) && add.weeklyProjection <= drop.weeklyProjection) return;
        const nextRoster = uniquePlayers([
          ...currentRoster.filter((player) => player.id !== drop.id),
          add,
        ]);
        const after = optimizeLineup(nextRoster, settings);
        const lineupGain = after.total - before.total;
        const depthGain = benchDepth(after) - benchDepth(before);
        const assetGain = add.projectedPoints - drop.projectedPoints;
        const score = lineupGain * 9 + depthGain * 2 + assetGain * 0.06;
        if (score <= 0.25) return;
        suggestions.push({
          add,
          drop,
          score: Number(score.toFixed(2)),
          lineupGain: Number(lineupGain.toFixed(2)),
          depthGain: Number(depthGain.toFixed(2)),
          assetGain: Number(assetGain.toFixed(2)),
          reason: lineupGain >= 0.5
            ? `Improves the optimized lineup by ${lineupGain.toFixed(1)} points.`
            : `Raises bench and injury-replacement depth by ${depthGain.toFixed(1)} points.`,
        });
      });
    });

    const bestByAdd = new Map();
    suggestions.sort((a, b) => b.score - a.score).forEach((suggestion) => {
      if (!bestByAdd.has(suggestion.add.id)) {
        bestByAdd.set(suggestion.add.id, suggestion);
      }
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
    analyzeTrade,
    applyDraftPick,
    cloneSettings,
    computeReplacementLevels,
    createDraftState,
    draftAssetValue,
    draftPickSummary,
    expandedStarterSlots,
    generateSnakeOrder,
    normalizePlayer,
    optimizeLineup,
    picksUntilTeam,
    positionColor,
    rankForScoring,
    recommendPlayers,
    snakeTeamForPick,
    undoDraftPick,
    waiverRecommendations,
  };
});
