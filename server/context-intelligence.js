"use strict";

const CONTEXT_MODEL_VERSION = "oracle-context-2026.3-health";
const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DST"]);
const SKILL_POSITIONS = new Set(["RB", "WR", "TE"]);
const MATCHUP_COEFFICIENT = Object.freeze({
  QB: 0.016,
  RB: 0.012,
  WR: 0.016,
  TE: 0.013,
  K: 0,
  DST: 0.018,
});
const ECOSYSTEM_COEFFICIENT = Object.freeze({
  QB: 0.012,
  RB: 0.014,
  WR: 0.014,
  TE: 0.012,
  K: 0.011,
  DST: 0.013,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0;
}

function standardDeviation(values) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 2) return 0;
  const average = mean(rows);
  return Math.sqrt(mean(rows.map((value) => (value - average) ** 2)));
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [1.061405429, -1.453152027, 1.421413741, -0.284496736, 0.254829592];
  let polynomial = coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1) polynomial = polynomial * t + coefficients[index];
  const erf = sign * (1 - polynomial * t * Math.exp(-(x ** 2)));
  return 0.5 * (1 + erf);
}

function projected(player) {
  return Math.max(0, finite(player?.weeklyProjection, 0));
}
function positionRows(players) {
  const rows = Object.fromEntries(POSITIONS.map((position) => [position, []]));
  for (const player of players) {
    const position = String(player.position || "").toUpperCase();
    if (rows[position]) rows[position].push(player);
  }
  for (const position of POSITIONS) {
    rows[position].sort((left, right) => projected(right) - projected(left));
  }
  return rows;
}

function sumTop(rows, limit) {
  return rows.slice(0, limit).reduce((sum, player) => sum + projected(player), 0);
}

function concentration(players) {
  const values = players.map(projected).filter((value) => value > 0.05);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return { hhi: 0, topShare: 0, effectiveOptions: 0 };
  const shares = values.map((value) => value / total);
  const hhi = shares.reduce((sum, share) => sum + share ** 2, 0);
  return {
    hhi: round(hhi, 4),
    topShare: round(Math.max(...shares), 4),
    effectiveOptions: round(1 / Math.max(hhi, 0.0001), 2),
  };
}

function groupTeams(players, schedule) {
  const teams = new Map();
  for (const team of Object.keys(schedule || {})) teams.set(team, []);
  for (const player of players) {
    const team = String(player.team || "FA").toUpperCase();
    if (team === "FA") continue;
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(player);
  }
  return teams;
}
function rawTeamProfile(team, players, schedule) {
  const byPosition = positionRows(players);
  const skillPlayers = [...byPosition.RB, ...byPosition.WR, ...byPosition.TE]
    .filter((player) => projected(player) > 0.05);
  const qb = sumTop(byPosition.QB, 1);
  const rb = sumTop(byPosition.RB, 3);
  const wr = sumTop(byPosition.WR, 4);
  const te = sumTop(byPosition.TE, 2);
  const kicker = sumTop(byPosition.K, 1);
  const defense = sumTop(byPosition.DST, 1);
  const coaching = players.find((player) => player.coachingContext)?.coachingContext || null;
  return {
    team,
    name: schedule?.[team]?.name || coaching?.teamName || team,
    players,
    byPosition,
    coaching,
    concentration: concentration(skillPlayers),
    offenseRaw: qb * 0.34 + rb * 0.22 + wr * 0.28 + te * 0.11 + kicker * 0.05,
    passingRaw: qb * 0.42 + wr * 0.4 + te * 0.18,
    rushingRaw: rb * 0.86 + qb * 0.14,
    defenseRaw: defense,
    skillRaw: rb + wr + te,
  };
}

function normalizeMetric(profiles, rawKey, prefix) {
  const values = profiles.map((profile) => finite(profile[rawKey], 0));
  const average = mean(values);
  const deviation = Math.max(0.001, standardDeviation(values));
  const sorted = [...values].sort((left, right) => left - right);
  profiles.forEach((profile) => {
    const value = finite(profile[rawKey], average);
    const below = sorted.filter((row) => row < value).length;
    const equal = sorted.filter((row) => row === value).length;
    profile[`${prefix}Index`] = clamp((value - average) / (deviation * 2.25), -1, 1);
    profile[`${prefix}Percentile`] = clamp((below + equal * 0.5) / Math.max(1, sorted.length), 0, 1);
  });
}
function roleBaselines(profiles) {
  const samples = Object.fromEntries(POSITIONS.map((position) => [position, new Map()]));
  for (const profile of profiles) {
    for (const position of POSITIONS) {
      const rows = profile.byPosition[position].filter((player) => projected(player) > 0.05);
      const total = rows.reduce((sum, player) => sum + projected(player), 0);
      rows.slice(0, 6).forEach((player, index) => {
        const rank = index + 1;
        if (!samples[position].has(rank)) samples[position].set(rank, []);
        samples[position].get(rank).push(total ? projected(player) / total : 0);
      });
    }
  }
  return Object.fromEntries(POSITIONS.map((position) => [
    position,
    Object.fromEntries([...samples[position]].map(([rank, values]) => [rank, mean(values)])),
  ]));
}

function buildContextModel(players, schedule = {}) {
  const profiles = [...groupTeams(players, schedule)]
    .map(([team, rows]) => rawTeamProfile(team, rows, schedule));
  normalizeMetric(profiles, "offenseRaw", "offense");
  normalizeMetric(profiles, "passingRaw", "passing");
  normalizeMetric(profiles, "rushingRaw", "rushing");
  normalizeMetric(profiles, "defenseRaw", "defense");
  normalizeMetric(profiles, "skillRaw", "skill");
  return {
    schedule,
    profiles: new Map(profiles.map((profile) => [profile.team, profile])),
    roleBaselines: roleBaselines(profiles),
  };
}

function ecosystemIndex(position, profile) {
  if (!profile) return 0;
  if (position === "QB" || position === "WR" || position === "TE") return profile.passingIndex;
  if (position === "RB") return profile.rushingIndex;
  if (position === "DST") return profile.defenseIndex;
  return profile.offenseIndex;
}
function matchupRows(player, model) {
  const team = String(player.team || "").toUpperCase();
  const position = String(player.position || "").toUpperCase();
  const schedule = model.schedule?.[team]?.weeks || [];
  return Array.from({ length: 18 }, (_, index) => {
    const game = schedule[index] || null;
    if (!game) return { week: index + 1, bye: true, opponent: null, edge: 0, factor: 0, grade: null };
    const opponent = model.profiles.get(String(game.opponent || "").toUpperCase());
    const opponentIndex = position === "DST"
      ? finite(opponent?.offenseIndex, 0)
      : finite(opponent?.defenseIndex, 0);
    const coefficient = MATCHUP_COEFFICIENT[position] || 0;
    const edge = position === "DST"
      ? -opponentIndex * coefficient
      : -opponentIndex * coefficient;
    return {
      week: index + 1,
      bye: false,
      opponent: game.opponent || null,
      home: Boolean(game.home),
      indoor: Boolean(game.indoor),
      edge: round(edge, 4),
      factor: round(clamp(1 + edge, 0.965, 1.035), 4),
      grade: Math.round(clamp(50 - opponentIndex * 25, 20, 80)),
      proxy: position === "DST" ? "opponent offense proxy" : "opponent DST proxy",
    };
  });
}

function marketSignals(player) {
  const rank = Math.max(0, finite(player.pprRank, 0));
  const adp = Math.max(0, finite(player.adp, 0));
  const adpEdge = rank && adp ? clamp((adp - rank) / 90, -1, 1) : 0;
  const prior = Math.max(0, finite(player.previousPoints, 0));
  const current = Math.max(0, finite(player.projectedPoints, 0));
  const priorGrowth = prior ? clamp(current / prior - 1, -1, 1) : 0;
  const source = Math.max(0, finite(player.sourceWeeklyProjection, 0));
  const sourceDelta = source
    ? clamp((finite(player.weeklyProjection, source) / source - 1) * 3, -1, 1)
    : 0;
  const signals = [adpEdge, priorGrowth, sourceDelta];
  const disagreement = clamp(standardDeviation(signals) / 0.75, 0, 1);
  return {
    adpEdge,
    priorGrowth,
    sourceDelta,
    signalMean: mean(signals),
    disagreement,
  };
}
function rawPlayerContext(player, model) {
  const position = String(player.position || "").toUpperCase();
  const team = String(player.team || "FA").toUpperCase();
  const profile = model.profiles.get(team) || null;
  const peers = profile?.byPosition?.[position] || [player];
  const activePeers = peers.filter((row) => projected(row) > 0.05);
  const roleIndex = Math.max(0, activePeers.findIndex((row) => String(row.id) === String(player.id)));
  const roleRank = roleIndex + 1;
  const positionTotal = activePeers.reduce((sum, row) => sum + projected(row), 0);
  const positionShare = positionTotal ? projected(player) / positionTotal : 0;
  const nextValue = projected(activePeers[roleIndex + 1]);
  const depthGap = projected(player)
    ? clamp((projected(player) - nextValue) / projected(player), -1, 1)
    : 0;
  const baselineShare = finite(model.roleBaselines?.[position]?.[roleRank], positionShare);
  const roleEdge = clamp(positionShare - baselineShare, -0.5, 0.5);
  const skillTotal = Math.max(0.001, finite(profile?.skillRaw, 0));
  const teamShare = SKILL_POSITIONS.has(position) ? projected(player) / skillTotal : positionShare;
  const ecosystem = ecosystemIndex(position, profile);
  const signals = marketSignals(player);
  const matchups = matchupRows(player, model);
  const activeMatchups = matchups.filter((row) => !row.bye);
  const roleCertainty = clamp(
    0.23 + positionShare * 0.36 + Math.max(0, depthGap) * 0.24 + finite(player.reliability, 0.65) * 0.17,
    0.15,
    0.98,
  );
  return {
    player,
    position,
    team,
    profile,
    roleRank,
    positionShare,
    teamShare,
    depthGap,
    baselineShare,
    roleEdge,
    roleCertainty,
    ecosystem,
    signals,
    matchups,
    matchupAverageEdge: mean(activeMatchups.map((row) => row.edge)),
    matchupVariance: standardDeviation(activeMatchups.map((row) => row.edge)),
    seasonMatchupScore: mean(activeMatchups.slice(0, 17).map((row) => row.grade)),
    playoffMatchupScore: mean(matchups.slice(14, 17).filter((row) => !row.bye).map((row) => row.grade)),
    ecosystemRawEdge: ecosystem * (ECOSYSTEM_COEFFICIENT[position] || 0.01),
    roleRawEdge: roleEdge * 0.035,
    marketRawEdge: signals.signalMean * 0.0025,
  };
}
function normalizeWeights(values) {
  const entries = Object.entries(values).map(([key, value]) => [key, Math.max(0.001, finite(value, 0))]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries(entries.map(([key, value]) => [key, round(value / total, 3)]));
}

function uncertaintyDecomposition(context, player) {
  const coaching = player.coachingContext || {};
  const coachingUncertainty = Math.abs(finite(coaching.volatilityFactor, 1) - 1) * 4 +
    (coaching.newStaff ? 0.18 : 0);
  const health = player.healthContext || {};
  const healthUncertainty = finite(health.uncertainty, finite(player.injuryRisk, 0.12) * 0.5);
  return normalizeWeights({
    baseline: 0.28,
    role: (1 - context.roleCertainty) * 0.3,
    health: healthUncertainty * 0.3 + finite(health.recurrenceRisk, 0) * 0.12,
    coaching: coachingUncertainty * 0.2,
    matchup: clamp(context.matchupVariance / 0.02, 0, 1) * 0.18,
    consensus: context.signals.disagreement * 0.22,
    opportunity: (1 - finite(player.opportunityContext?.volumeStability, 0.5)) * 0.2,
  });
}

function driverRows(context, centered) {
  const coachingEdge = finite(context.player.coachingContext?.meanFactor, 1) - 1;
  const healthEdge = finite(context.player.healthContext?.meanFactor, 1) - 1;
  const rows = [
    [centered.ecosystem, "team ecosystem"],
    [centered.role, "depth-chart opportunity"],
    [context.matchupAverageEdge, "schedule matchup"],
    [centered.market, "market/model signal"],
    [coachingEdge, "coaching and development"],
    [healthEdge, "health and recovery"],
    [finite(context.player.opportunityContext?.meanFactor, 1) - 1, "historical opportunity model"],
    [-(context.signals.disagreement * 0.006), "projection disagreement"],
  ].sort((left, right) => Math.abs(right[0]) - Math.abs(left[0]));
  return rows.slice(0, 5).map(([impact, label]) => ({
    label,
    direction: impact >= 0 ? "positive" : "negative",
    impact: round(impact, 4),
  }));
}

function intelligenceArchetype(opportunity, fragility, breakout, conviction, asymmetry) {
  if (fragility >= 0.68 && breakout >= 0.28) return "fragile ceiling";
  if (breakout >= 0.34 && asymmetry >= 1.2) return "asymmetric upside";
  if (opportunity >= 78 && fragility <= 0.35) return "stable anchor";
  if (conviction >= 0.78) return "high-conviction value";
  if (fragility >= 0.62) return "role-sensitive risk";
  return "balanced projection";
}
function componentBaselines(contexts) {
  const rows = new Map();
  for (const context of contexts) {
    if (!rows.has(context.position)) rows.set(context.position, []);
    rows.get(context.position).push(context);
  }
  const result = {};
  for (const [position, values] of rows) {
    const totalWeight = values.reduce((sum, row) => sum + Math.max(0.25, projected(row.player)), 0);
    const weighted = (selector) => values.reduce((sum, row) => (
      sum + selector(row) * Math.max(0.25, projected(row.player))
    ), 0) / Math.max(0.001, totalWeight);
    result[position] = {
      ecosystem: weighted((row) => row.ecosystemRawEdge),
      role: weighted((row) => row.roleRawEdge),
      market: weighted((row) => row.marketRawEdge),
    };
  }
  return result;
}

function applyPlayerContext(context, baselines) {
  const player = context.player;
  const baseline = baselines[context.position] || { ecosystem: 0, role: 0, market: 0 };
  const centered = {
    ecosystem: context.ecosystemRawEdge - baseline.ecosystem,
    role: context.roleRawEdge - baseline.role,
    market: context.marketRawEdge - baseline.market,
  };
  const constantEdge = clamp(centered.ecosystem + centered.role + centered.market, -0.025, 0.025);
  const sourceWeekly = Array.from({ length: 18 }, (_, index) => (
    Math.max(0, finite(player.weeklyProjections?.[index], 0))
  ));
  const weeklyProjections = sourceWeekly.map((value, index) => {
    if (!value || context.matchups[index]?.bye) return 0;
    const matchupEdge = finite(context.matchups[index]?.edge, 0);
    return round(value * clamp(1 + constantEdge + matchupEdge, 0.955, 1.045), 2);
  });
  const activeSource = sourceWeekly.filter((value) => value > 0);
  const baseWeeklyProjection = activeSource.length ? mean(activeSource) : 0;
  const active = weeklyProjections.filter((value) => value > 0);
  const weeklyProjection = active.length ? mean(active) : 0;
  const roleUncertainty = 1 - context.roleCertainty;
  const matchupVolatility = clamp(context.matchupVariance / 0.02, 0, 1);
  const injuryRisk = clamp(player.injuryRisk, 0, 1);
  const healthContext = player.healthContext || {};
  const healthUncertainty = clamp(healthContext.uncertainty, 0, 1);
  const recurrenceRisk = clamp(healthContext.recurrenceRisk, 0, 1);
  const volatilityFactor = clamp(
    1 + (roleUncertainty - 0.42) * 0.16 +
      (context.signals.disagreement - 0.32) * 0.1 +
      matchupVolatility * 0.05 + injuryRisk * 0.04 - Math.max(0, context.depthGap) * 0.03,
    0.86,
    1.22,
  );
  const deviation = Math.max(0.2, finite(player.projectionStdDev, weeklyProjection * 0.45) * volatilityFactor);
  const reliabilityDelta = clamp(
    (context.roleCertainty - 0.55) * 0.08 +
      (0.45 - context.signals.disagreement) * 0.035 - matchupVolatility * 0.012,
    -0.055,
    0.055,
  );
  const reliability = clamp(finite(player.reliability, 0.65) + reliabilityDelta, 0.2, 0.98);
  const floor = Math.max(0, weeklyProjection - deviation);
  const ceiling = weeklyProjection + deviation * 1.5;
  const breakoutBase = weeklyProjection > 0
    ? 1 - normalCdf((weeklyProjection * 1.2 - weeklyProjection) / deviation)
    : 0;
  const bustBase = weeklyProjection > 0
    ? normalCdf((weeklyProjection * 0.75 - weeklyProjection) / deviation)
    : 0;
  const historicalOpportunity = player.opportunityContext || {};
  const historicalEdge = finite(historicalOpportunity.meanFactor, 1) - 1;
  const historicalStability = finite(historicalOpportunity.volumeStability, 0.5);
  const historicalShare = finite(historicalOpportunity.teamOpportunityShare, context.positionShare);
  const breakoutProbability = clamp(
    breakoutBase + Math.max(0, context.signals.adpEdge) * 0.04 +
      Math.max(0, context.signals.priorGrowth) * 0.03 + Math.max(0, constantEdge) * 2 +
      Math.max(0, historicalEdge) * 2.4,
    0.03,
    0.62,
  );
  const bustProbability = clamp(
    bustBase + injuryRisk * 0.12 + roleUncertainty * 0.08 + Math.max(0, -constantEdge) * 2 +
      Math.max(0, -historicalEdge) * 2.4,
    0.03,
    0.68,
  );
  const asymmetry = (ceiling - weeklyProjection) / Math.max(0.1, weeklyProjection - floor);
  const fragility = clamp(
    roleUncertainty * 0.3 + context.signals.disagreement * 0.22 + injuryRisk * 0.1 +
      healthUncertainty * 0.18 + recurrenceRisk * 0.08 + matchupVolatility * 0.1 +
      Math.max(0, volatilityFactor - 1) * 0.7 +
      (player.coachingContext?.newStaff ? 0.08 : 0) + (1 - historicalStability) * 0.08,
    0,
    1,
  );
  const opportunityIndex = Math.round(clamp(
    context.roleCertainty * 36 + context.positionShare * 18 +
      ((context.ecosystem + 1) / 2) * 12 + reliability * 10 +
      clamp(historicalShare, 0, 0.65) / 0.65 * 12 + historicalStability * 12,
    0,
    100,
  ));
  const conviction = clamp(
    0.42 + (1 - context.signals.disagreement) * 0.24 +
      context.roleCertainty * 0.2 + reliability * 0.16 - fragility * 0.12,
    0.05,
    0.98,
  );
  const decomposition = uncertaintyDecomposition(context, player);
  const archetype = intelligenceArchetype(
    opportunityIndex,
    fragility,
    breakoutProbability,
    conviction,
    asymmetry,
  );

  return {
    ...player,
    weeklyProjection: round(weeklyProjection, 2),
    weeklyProjections,
    projectedPoints: round(weeklyProjections.reduce((sum, value) => sum + value, 0), 2),
    floorProjection: round(floor, 2),
    ceilingProjection: round(ceiling, 2),
    projectionStdDev: round(deviation, 2),
    reliability: round(reliability, 3),
    projectionModel: {
      ...(player.projectionModel || {}),
      contextVersion: CONTEXT_MODEL_VERSION,
      components: [...new Set([
        ...(player.projectionModel?.components || []),
        "team-ecosystem",
        "depth-chart-opportunity",
        "matchup-proxy",
        "projection-consensus",
      ])],
    },
    decisionIntelligence: {
      version: CONTEXT_MODEL_VERSION,
      archetype,
      meanFactor: round(weeklyProjection / Math.max(0.001, baseWeeklyProjection), 4),
      constantEdge: round(constantEdge, 4),
      opportunity: {
        index: opportunityIndex,
        roleRank: context.roleRank,
        positionShare: round(context.positionShare, 4),
        teamSkillShare: round(context.teamShare, 4),
        depthGap: round(context.depthGap, 4),
        roleCertainty: round(context.roleCertainty, 4),
        historical: player.opportunityContext ? {
          version: player.opportunityContext.version,
          archetype: player.opportunityContext.archetype,
          weightedOpportunityPerGame: player.opportunityContext.weightedOpportunityPerGame,
          teamOpportunityShare: player.opportunityContext.teamOpportunityShare,
          volumeStability: player.opportunityContext.volumeStability,
          modelEdge: player.opportunityContext.modelEdge,
          meanFactor: player.opportunityContext.meanFactor,
        } : null,
      },
      health: player.healthContext ? {
        version: player.healthContext.version,
        status: player.healthContext.status,
        practice: player.healthContext.practice,
        family: player.healthContext.family,
        severity: player.healthContext.severity,
        currentAvailability: player.healthContext.currentAvailability,
        returnWindow: player.healthContext.returnWindow,
        earlyReturnToPriorLevelProbability: player.healthContext.earlyReturnToPriorLevelProbability,
        returnToPriorLevelProbability: player.healthContext.returnToPriorLevelProbability,
        recurrenceRisk: player.healthContext.recurrenceRisk,
        uncertainty: player.healthContext.uncertainty,
        reportedFacts: player.healthContext.reportedFacts,
        news: player.healthContext.news,
      } : null,
      ecosystem: {
        team: context.team,
        index: round(context.ecosystem, 4),
        offensePercentile: round(context.profile?.offensePercentile, 4),
        passingPercentile: round(context.profile?.passingPercentile, 4),
        rushingPercentile: round(context.profile?.rushingPercentile, 4),
        defensePercentile: round(context.profile?.defensePercentile, 4),
        concentration: context.profile?.concentration || null,
      },
      matchup: {
        seasonScore: round(context.seasonMatchupScore, 1),
        playoffScore: round(context.playoffMatchupScore, 1),
        averageEdge: round(context.matchupAverageEdge, 4),
        weekly: context.matchups,
        confidence: 0.35,
        source: "schedule plus opponent DST/offense proxy",
      },
      consensus: {
        adpEdge: round(context.signals.adpEdge, 4),
        priorGrowth: round(context.signals.priorGrowth, 4),
        sourceDelta: round(context.signals.sourceDelta, 4),
        disagreement: round(context.signals.disagreement, 4),
        conviction: round(conviction, 4),
      },
      risk: {
        fragility: round(fragility, 4),
        breakoutProbability: round(breakoutProbability, 4),
        bustProbability: round(bustProbability, 4),
        upsideDownsideRatio: round(asymmetry, 3),
        volatilityFactor: round(volatilityFactor, 4),
        uncertainty: decomposition,
      },
      drivers: driverRows(context, centered),
      quality: {
        confidence: round(conviction * 0.75 + reliability * 0.25, 4),
        proxyNotice: "Opportunity and matchup fields are inference proxies until tracking and play-level inputs are connected.",
      },
    },
  };
}
function teamProfileSummary(profile, model) {
  const scheduleOutlook = Object.fromEntries(POSITIONS.map((position) => {
    const rows = matchupRows({ team: profile.team, position }, model).filter((row) => !row.bye);
    return [position, {
      seasonScore: round(mean(rows.slice(0, 17).map((row) => row.grade)), 1),
      playoffScore: round(mean(rows.filter((row) => row.week >= 15 && row.week <= 17).map((row) => row.grade)), 1),
    }];
  }));
  const topAssets = Object.fromEntries(POSITIONS.map((position) => [
    position,
    profile.byPosition[position].slice(0, 3).map((player) => ({
      id: String(player.id),
      name: player.name,
      weeklyProjection: round(projected(player), 2),
    })),
  ]));
  return {
    team: profile.team,
    name: profile.name,
    offenseIndex: round(profile.offenseIndex, 4),
    passingIndex: round(profile.passingIndex, 4),
    rushingIndex: round(profile.rushingIndex, 4),
    defenseIndex: round(profile.defenseIndex, 4),
    offensePercentile: round(profile.offensePercentile, 4),
    passingPercentile: round(profile.passingPercentile, 4),
    rushingPercentile: round(profile.rushingPercentile, 4),
    defensePercentile: round(profile.defensePercentile, 4),
    concentration: profile.concentration,
    scheduleOutlook,
    topAssets,
  };
}

function applyContextIntelligence(players, schedule = {}) {
  const model = buildContextModel(players, schedule);
  const contexts = players.map((player) => rawPlayerContext(player, model));
  const baselines = componentBaselines(contexts);
  const modeledPlayers = contexts.map((context) => applyPlayerContext(context, baselines));
  const factors = modeledPlayers
    .filter((player) => finite(player.weeklyProjection, 0) > 0.05)
    .map((player) => finite(player.decisionIntelligence?.meanFactor, 1));
  const teamProfiles = Object.fromEntries([...model.profiles]
    .map(([team, profile]) => [team, teamProfileSummary(profile, model)]));
  return {
    players: modeledPlayers,
    intelligence: {
      version: CONTEXT_MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      coverage: modeledPlayers.filter((player) => player.decisionIntelligence).length,
      teamCoverage: Object.keys(teamProfiles).length,
      teamProfiles,
      diagnostics: {
        meanFactor: round(mean(factors), 5),
        minimumFactor: round(Math.min(...factors), 4),
        maximumFactor: round(Math.max(...factors), 4),
      },
      methodology: [
        "league-centered team ecosystem indices",
        "depth-chart share and competition proxies",
        "opponent DST and offense matchup proxies",
        "market and projection disagreement",
        "uncertainty decomposition and asymmetric outcome probabilities",
      ],
      limitations: [
        "No route, snap, target-share, betting-market, or tracking feed is connected yet.",
        "Matchup strength uses current DST and offense projections as a deliberately low-confidence proxy.",
      ],
    },
  };
}

module.exports = {
  CONTEXT_MODEL_VERSION,
  applyContextIntelligence,
  buildContextModel,
  marketSignals,
  normalCdf,
  rawPlayerContext,
};
