"use strict";

const core = require("../app-core.js");

const POSITIONS = ["QB", "RB", "WR", "TE", "DST", "K"];

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

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniquePlayers(rows) {
  const seen = new Set();
  return (rows || []).map(core.normalizePlayer).filter((player) => {
    if (!player.id || seen.has(player.id)) return false;
    seen.add(player.id);
    return true;
  });
}

function positionTargets(settings = {}) {
  const config = core.cloneSettings(settings);
  const slots = config.slots;
  const bench = Math.max(0, finite(slots.BN, 0));
  return {
    QB: finite(slots.QB, 0) + finite(slots.SUPERFLEX, 0) * 0.72 + bench * 0.08,
    RB: finite(slots.RB, 0) + finite(slots.FLEX, 0) * 0.46 + bench * 0.34,
    WR: finite(slots.WR, 0) + finite(slots.FLEX, 0) * 0.44 + bench * 0.38,
    TE: finite(slots.TE, 0) + finite(slots.FLEX, 0) * 0.1 + bench * 0.08,
    DST: finite(slots.DST, 0),
    K: finite(slots.K, 0),
  };
}

function lineupRange(lineup, week) {
  let floor = 0;
  let ceiling = 0;
  let reliability = 0;
  let injuryExposure = 0;
  let starters = 0;
  for (const row of lineup.starters || []) {
    if (!row.player) continue;
    const player = core.normalizePlayer(row.player);
    const range = core.playerWeekRange(player, week);
    floor += range.floor;
    ceiling += range.ceiling;
    reliability += player.reliability;
    injuryExposure += player.injuryRisk * core.playerWeekProjection(player, week);
    starters += 1;
  }
  return { floor, ceiling, reliability, injuryExposure, starters };
}

function positionNeedRows(roster, universe, settings, startWeek = 1) {
  const config = core.cloneSettings(settings);
  const targets = positionTargets(config);
  const replacement = core.computeReplacementLevels(universe, config);
  const counts = Object.fromEntries(POSITIONS.map((position) => [
    position,
    roster.filter((player) => player.position === position).length,
  ]));
  return POSITIONS.map((position) => {
    const rows = roster.filter((player) => player.position === position)
      .sort((left, right) => right.projectedPoints - left.projectedPoints);
    const target = targets[position] || 0;
    const countGap = Math.max(0, target - rows.length);
    const starterRequirement = Math.max(0, finite(config.slots[position], 0));
    const starterRows = rows.slice(0, Math.max(1, Math.ceil(starterRequirement)));
    const average = mean(starterRows.map((player) => player.projectedPoints));
    const level = finite(replacement[position], 0);
    const quality = level > 0 ? clamp((average - level) / Math.max(20, level * 0.35), -1, 1) : 0;
    const weeklyCoverage = mean(Array.from({ length: Math.max(1, 18 - startWeek) }, (_, index) => {
      const week = startWeek + index;
      return rows.filter((player) => core.playerWeekProjection(player, week) > 0).length;
    }));
    const coverageGap = Math.max(0, Math.ceil(starterRequirement) - weeklyCoverage);
    const need = clamp(countGap * 34 + coverageGap * 24 + (1 - quality) * 21, 0, 100);
    return {
      position,
      count: counts[position],
      target: round(target, 2),
      countGap: round(countGap, 2),
      coverageGap: round(coverageGap, 2),
      replacement: round(level, 2),
      quality: round(quality, 3),
      need: round(need, 1),
    };
  }).filter((row) => row.target > 0 || row.count > 0);
}

function historicalPlayerValue(player, calibration, scoring = "ppr") {
  const position = String(player?.position || "").toUpperCase();
  const rank = core.rankForScoring(core.normalizePlayer(player), scoring);
  const rows = calibration?.valueCurves?.[scoring]?.[position] || [];
  const bucket = rows.find((row) => rank >= row.rankStart && rank <= row.rankEnd) || null;
  if (!bucket) return null;
  return {
    rank,
    rankStart: bucket.rankStart,
    rankEnd: bucket.rankEnd,
    expectedPoints: finite(bucket.meanPoints, 0),
    medianPoints: finite(bucket.medianPoints, 0),
    standardDeviation: finite(bucket.standardDeviation, 0),
    hitRate: finite(bucket.hitRate, 0),
    bustRate: finite(bucket.bustRate, 0),
    samples: finite(bucket.samples, 0),
  };
}

function rosterHistoricalValue(roster, calibration, scoring) {
  const values = roster.map((player) => historicalPlayerValue(player, calibration, scoring))
    .filter(Boolean);
  if (!values.length) return { expectedPoints: 0, hitRate: 0, bustRate: 0, coverage: 0 };
  return {
    expectedPoints: round(values.reduce((sum, value) => sum + value.expectedPoints, 0), 2),
    hitRate: round(mean(values.map((value) => value.hitRate)), 4),
    bustRate: round(mean(values.map((value) => value.bustRate)), 4),
    coverage: round(values.length / Math.max(1, roster.length), 4),
  };
}

function rosterUtility(options = {}) {
  const settings = core.cloneSettings(options.settings || {});
  const roster = uniquePlayers(options.roster || []);
  const universe = uniquePlayers(options.players || roster);
  const startWeek = Math.round(clamp(options.startWeek || 1, 1, 17));
  const endWeek = Math.round(clamp(options.endWeek || 17, startWeek, 17));
  const weekly = [];
  for (let week = startWeek; week <= endWeek; week += 1) {
    const lineup = core.optimizeWeeklyLineup(roster, settings, week);
    const range = lineupRange(lineup, week);
    const bench = (lineup.bench || []).slice(0, 5).reduce((sum, player, index) => (
      sum + core.playerWeekProjection(player, week) * (1 - index * 0.13)
    ), 0);
    weekly.push({
      week,
      points: lineup.total,
      floor: range.floor,
      ceiling: range.ceiling,
      reliability: range.reliability / Math.max(1, range.starters),
      injuryExposure: range.injuryExposure / Math.max(1, lineup.total),
      depth: bench,
    });
  }
  const needs = positionNeedRows(roster, universe, settings, startWeek);
  const playoff = weekly.filter((row) => row.week >= 15 && row.week <= 17);
  const byeCollisions = Array.from({ length: endWeek - startWeek + 1 }, (_, index) => {
    const week = startWeek + index;
    return roster.filter((player) => player.byeWeek === week).length;
  });

  const averagePoints = mean(weekly.map((row) => row.points));
  const averageFloor = mean(weekly.map((row) => row.floor));
  const averageCeiling = mean(weekly.map((row) => row.ceiling));
  const depth = mean(weekly.map((row) => row.depth));
  const reliability = mean(weekly.map((row) => row.reliability));
  const injuryExposure = mean(weekly.map((row) => row.injuryExposure));
  const playoffPoints = playoff.length ? mean(playoff.map((row) => row.points)) : averagePoints;
  const needPressure = mean(needs.map((row) => row.need));
  const worstNeeds = [...needs].sort((left, right) => right.need - left.need).slice(0, 3);
  const historical = rosterHistoricalValue(roster, options.calibration, settings.scoring);
  const byePenalty = mean(byeCollisions.map((count) => Math.max(0, count - 1) ** 1.35));
  const total = averagePoints * 5 + playoffPoints * 1.4 + depth * 0.38 +
    averageFloor * 0.7 + reliability * 24 - injuryExposure * 30 -
    needPressure * 0.18 - byePenalty * 1.6 + historical.hitRate * 8 - historical.bustRate * 5;
  return {
    version: "oracle-roster-utility-2026.1",
    startWeek,
    endWeek,
    total: round(total, 3),
    averagePoints: round(averagePoints, 3),
    playoffPoints: round(playoffPoints, 3),
    averageFloor: round(averageFloor, 3),
    averageCeiling: round(averageCeiling, 3),
    depth: round(depth, 3),
    reliability: round(reliability, 4),
    injuryExposure: round(injuryExposure, 4),
    byePenalty: round(byePenalty, 3),
    needPressure: round(needPressure, 2),
    needs,
    worstNeeds,
    historical,
    weekly: options.includeWeekly ? weekly.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === "number" ? round(value, 3) : value]),
    )) : undefined,
  };
}

function utilityDelta(before, after) {
  return {
    total: round(after.total - before.total, 3),
    averagePoints: round(after.averagePoints - before.averagePoints, 3),
    playoffPoints: round(after.playoffPoints - before.playoffPoints, 3),
    floor: round(after.averageFloor - before.averageFloor, 3),
    ceiling: round(after.averageCeiling - before.averageCeiling, 3),
    depth: round(after.depth - before.depth, 3),
    reliability: round(after.reliability - before.reliability, 4),
    injuryMitigation: round(before.injuryExposure - after.injuryExposure, 4),
    byeMitigation: round(before.byePenalty - after.byePenalty, 3),
    needReduction: round(before.needPressure - after.needPressure, 3),
    historicalHitRate: round(after.historical.hitRate - before.historical.hitRate, 4),
    historicalBustReduction: round(before.historical.bustRate - after.historical.bustRate, 4),
  };
}

function calibratedTradeScore(nativeScore, utilityTotal, policy = {}) {
  const normalization = policy.normalization || {};
  const nativeZ = (finite(nativeScore, 0) - finite(normalization.nativeMean, 0)) /
    Math.max(1e-6, finite(normalization.nativeStdDev, 1));
  const utilityZ = (finite(utilityTotal, 0) - finite(normalization.utilityMean, 0)) /
    Math.max(1e-6, finite(normalization.utilityStdDev, 1));
  const utilityShare = clamp(policy.utilityShare ?? 0.5, 0, 1);
  return nativeZ * (1 - utilityShare) + utilityZ * utilityShare;
}

function evaluateRosterChange(options = {}) {
  const common = {
    players: options.players,
    settings: options.settings,
    startWeek: options.startWeek,
    endWeek: options.endWeek,
    calibration: options.calibration,
  };
  const before = options.beforeUtility || rosterUtility({ ...common, roster: options.beforeRoster });
  const after = rosterUtility({ ...common, roster: options.afterRoster });
  return { before, after, delta: utilityDelta(before, after) };
}

function rosterFromState(state, teamId, byId) {
  const ids = state?.rosters?.[String(teamId)] || state?.rosters?.[teamId] || [];
  return ids.map((row) => byId.get(String(row?.id || row))).filter(Boolean);
}

function changeReasons(change, positionNeed, historical) {
  const reasons = [];
  if (change.delta.averagePoints >= 0.12) {
    reasons.push(`adds ${change.delta.averagePoints.toFixed(1)} multi-week lineup points`);
  }
  if (change.delta.playoffPoints >= 0.12) {
    reasons.push(`adds ${change.delta.playoffPoints.toFixed(1)} playoff-week points`);
  }
  if (positionNeed >= 45) reasons.push(`${Math.round(positionNeed)}/100 roster-need fit`);
  if (change.delta.needReduction >= 1) {
    reasons.push(`reduces roster need by ${change.delta.needReduction.toFixed(0)}`);
  }
  if (change.delta.depth >= 0.2) reasons.push(`adds ${change.delta.depth.toFixed(1)} depth value`);
  if (historical?.samples >= 20) {
    reasons.push(`${Math.round(historical.hitRate * 100)}% historical hit rate for rank bucket`);
  }
  return reasons;
}

function decorateDraftRecommendations(rows, options = {}) {
  const universe = uniquePlayers(options.players || []);
  const byId = new Map(universe.map((player) => [player.id, player]));
  const roster = rosterFromState(options.state, options.teamId, byId);
  const before = rosterUtility({
    roster,
    players: universe,
    settings: options.settings,
    startWeek: options.startWeek || 1,
    calibration: options.calibration,
  });
  const needByPosition = Object.fromEntries(before.needs.map((row) => [row.position, row.need]));
  return (rows || []).map((rawRow, nativeIndex) => {
    const player = byId.get(String(rawRow.id)) || core.normalizePlayer(rawRow);
    const afterRoster = uniquePlayers([...roster, player]);
    const after = rosterUtility({
      roster: afterRoster,
      players: universe,
      settings: options.settings,
      startWeek: options.startWeek || 1,
      calibration: options.calibration,
    });
    const delta = utilityDelta(before, after);
    const historical = historicalPlayerValue(player, options.calibration, options.settings?.scoring);
    const needFit = finite(needByPosition[player.position], 0);
    const utilityBonus = clamp(
      delta.total * 0.42 + delta.needReduction * 0.55 + needFit * 0.035 +
        finite(historical?.hitRate, 0) * 3 - finite(historical?.bustRate, 0) * 2,
      -12,
      18,
    );
    const marketWeight = clamp(options.calibration?.draftPolicy?.marketWeight ?? 0.68, 0.35, 0.9);
    const marketRank = core.rankForScoring(player, options.settings?.scoring || "ppr");
    const policyRank = marketRank * marketWeight + (nativeIndex + 1) * (1 - marketWeight);
    const reasons = [
      ...(rawRow.reasons || []),
      ...changeReasons({ delta }, needFit, historical),
    ];
    return {
      ...rawRow,
      score: round(finite(rawRow.score, 0) + utilityBonus, 2),
      nativeScore: round(finite(rawRow.score, 0), 2),
      utilityBonus: round(utilityBonus, 2),
      utilityRole: "advisory-explanation",
      policyRank: round(policyRank, 3),
      policy: {
        version: options.calibration?.draftPolicy?.version || "oracle-draft-policy-fallback",
        marketWeight: round(marketWeight, 3),
        modelWeight: round(1 - marketWeight, 3),
        marketRank: round(marketRank, 2),
        nativeRank: nativeIndex + 1,
      },
      rosterUtility: { before: before.total, after: after.total, delta },
      rosterNeedFit: round(needFit, 1),
      historicalValue: historical,
      reasons: [...new Set(reasons)],
    };
  }).sort((left, right) => left.policyRank - right.policyRank || right.score - left.score);
}

function applyRosterChange(roster, give, receive) {
  const removed = new Set((give || []).map((player) => String(player.id)));
  return uniquePlayers([
    ...roster.filter((player) => !removed.has(player.id)),
    ...(receive || []),
  ]);
}

function decorateTradeAnalysis(data, options = {}) {
  const roster = uniquePlayers(options.roster || []);
  const afterRoster = applyRosterChange(roster, options.give, options.receive);
  const change = evaluateRosterChange({
    beforeRoster: roster,
    afterRoster,
    players: options.players,
    settings: options.settings,
    startWeek: options.startWeek || options.week || 1,
    calibration: options.calibration,
    beforeUtility: options.beforeUtility,
  });
  const policy = options.calibration?.decisionPolicies?.trade || {};
  return {
    ...data,
    decisionScore: round(calibratedTradeScore(data?.score, change.delta.total, policy), 3),
    rosterUtility: change,
    needFit: round(change.delta.needReduction, 2),
    historicalCalibration: {
      version: policy.version || null,
      confidence: round(policy.confidence, 3),
      thresholdPrecision: round(policy.thresholdPrecision, 3),
      scoreThreshold: round(policy.scoreThreshold, 3),
      minimumFairness: round(policy.minimumFairness, 1),
      utilityShare: round(policy.utilityShare, 3),
      nativeShare: round(policy.nativeShare, 3),
      selectedWithoutHoldout: Boolean(policy.selectedWithoutHoldout),
      holdoutSeason: policy.holdoutSeason || null,
      interpretation: policy.interpretation || null,
    },
  };
}

function decorateTradeProposals(rows, options = {}) {
  const policy = options.calibration?.decisionPolicies?.trade || {};
  const utilityOptions = {
    players: options.players,
    settings: options.settings,
    startWeek: options.week || 1,
    calibration: options.calibration,
  };
  const userBefore = rosterUtility({ ...utilityOptions, roster: options.userRoster });
  const opponentBefore = rosterUtility({ ...utilityOptions, roster: options.opponentRoster });
  return (rows || []).map((proposal) => {
    const user = decorateTradeAnalysis(proposal.userAnalysis, {
      roster: options.userRoster,
      give: proposal.give,
      receive: proposal.receive,
      players: options.players,
      settings: options.settings,
      week: options.week,
      calibration: options.calibration,
      beforeUtility: userBefore,
    });
    const opponent = decorateTradeAnalysis(proposal.opponentAnalysis, {
      roster: options.opponentRoster,
      give: proposal.receive,
      receive: proposal.give,
      players: options.players,
      settings: options.settings,
      week: options.week,
      calibration: options.calibration,
      beforeUtility: opponentBefore,
    });
    const calibratedMutual = user.decisionScore + Math.max(-1.5, opponent.decisionScore) * 0.45 +
      (finite(proposal.fairness, 50) - 50) * 0.015;
    return {
      ...proposal,
      userAnalysis: user,
      opponentAnalysis: opponent,
      nativeMutualScore: round(finite(proposal.mutualScore, 0), 2),
      mutualScore: round(calibratedMutual, 3),
      rosterNeedGain: user.rosterUtility.delta.needReduction,
    };
  }).sort((left, right) => right.mutualScore - left.mutualScore);
}

function decorateWaivers(rows, options = {}) {
  const roster = uniquePlayers(options.roster || []);
  const policy = options.calibration?.decisionPolicies?.waiver || {};
  const beforeUtility = rosterUtility({
    roster,
    players: options.players,
    settings: options.settings,
    startWeek: options.week || 1,
    calibration: options.calibration,
  });
  const utilityRerank = Boolean(policy.utilityRerank);
  const decorated = (rows || []).map((row, index) => {
    const add = core.normalizePlayer(row.add);
    const drop = core.normalizePlayer(row.drop);
    const afterRoster = applyRosterChange(roster, [drop], [add]);
    const change = evaluateRosterChange({
      beforeRoster: roster,
      afterRoster,
      players: options.players,
      settings: options.settings,
      startWeek: options.week || 1,
      calibration: options.calibration,
      beforeUtility,
    });
    const historical = historicalPlayerValue(add, options.calibration, options.settings?.scoring);
    const utilityBonus = clamp(change.delta.total * 0.72 + change.delta.needReduction * 0.4, -8, 14);
    const reasons = changeReasons(change, change.before.needs.find(
      (need) => need.position === add.position,
    )?.need || 0, historical);
    return {
      ...row,
      nativeScore: round(finite(row.score, 0), 2),
      decisionScore: round(finite(row.score, 0) + utilityBonus, 2),
      utilityBonus: round(utilityBonus, 2),
      rosterUtility: change,
      historicalValue: historical,
      historicalCalibration: {
        version: policy.version || null,
        utilityRerank,
        selectedWithoutHoldout: Boolean(policy.selectedWithoutHoldout),
        holdoutSeason: policy.holdoutSeason || null,
        interpretation: policy.interpretation || null,
      },
      originalOrder: index,
      reason: [...new Set([row.reason, ...reasons].filter(Boolean))].join(" "),
    };
  });
  return utilityRerank
    ? decorated.sort((left, right) => right.decisionScore - left.decisionScore)
    : decorated.sort((left, right) => left.originalOrder - right.originalOrder);
}

function decorateRosterAnalysis(data, options = {}) {
  const utility = rosterUtility({
    roster: options.roster,
    players: options.players,
    settings: options.settings,
    startWeek: options.week || 1,
    calibration: options.calibration,
    includeWeekly: true,
  });
  return {
    ...data,
    rosterUtility: utility,
    weakestPositions: utility.worstNeeds.slice(0, 2).map((row) => row.position),
  };
}

module.exports = {
  decorateDraftRecommendations,
  decorateRosterAnalysis,
  decorateTradeAnalysis,
  decorateTradeProposals,
  decorateWaivers,
  evaluateRosterChange,
  historicalPlayerValue,
  positionNeedRows,
  rosterHistoricalValue,
  rosterUtility,
  utilityDelta,
};
