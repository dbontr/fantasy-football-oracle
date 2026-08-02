"use strict";

const opportunityData = require("../data/opportunity-2026.json");

const OPPORTUNITY_MODEL_VERSION = opportunityData.meta?.version || "oracle-opportunity-unknown";
const PROFILE_BY_ID = new Map(Object.entries(opportunityData.profiles || {}));
const PROFILE_BY_NAME = new Map(Object.values(opportunityData.profiles || {}).map((profile) => (
  [canonicalName(profile.name), profile]
)));

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function canonicalName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function profileForPlayer(player) {
  const byId = PROFILE_BY_ID.get(String(player?.id || ""));
  if (byId) return byId;
  return PROFILE_BY_NAME.get(canonicalName(player?.name)) || null;
}

function positionDiagnostics(position) {
  return opportunityData.diagnostics?.byPosition?.[position] || null;
}

function rawOpportunityContext(player) {
  const profile = profileForPlayer(player);
  if (!profile) return null;
  const sourceWeekly = Math.max(0.1, finite(player.weeklyProjection, profile.predictedPpg));
  const modelEdge = clamp(profile.predictedPpg / sourceWeekly - 1, -0.75, 0.75);
  const diagnostics = positionDiagnostics(player.position);
  const holdoutSkill = clamp(finite(diagnostics?.rmseImprovement, 0.05) / 0.2, 0.2, 1);
  const sourceRatio = Math.min(sourceWeekly, profile.priorPpg) / Math.max(0.1, Math.max(sourceWeekly, profile.priorPpg));
  const ownership = clamp(finite(player.percentOwned, 0) / 100, 0, 1);
  const startRate = clamp(finite(player.percentStarted, 0) / 100, 0, 1);
  const currentRoleEvidence = clamp(0.3 + ownership * 0.42 + startRate * 0.28, 0.3, 1);
  const continuity = clamp(sourceRatio * 0.7 + currentRoleEvidence * 0.3, 0.3, 1);
  const evidence = clamp(profile.reliability * (0.65 + holdoutSkill * 0.35) * (0.55 + continuity * 0.45), 0.08, 0.98);
  const blendWeight = clamp(0.06 + evidence * 0.18, 0.08, 0.24);
  const maximumEdge = 0.02 + continuity * 0.02;
  const rawMeanEdge = clamp(modelEdge * blendWeight, -maximumEdge, maximumEdge);
  const stableVolume = finite(profile.volumeStability, 0.5) - 0.5;
  const availability = finite(profile.availability, 0.7) - 0.7;
  const reliabilityDelta = clamp(stableVolume * 0.055 + availability * 0.035, -0.035, 0.035);
  return {
    player,
    profile,
    diagnostics,
    sourceWeekly,
    modelEdge,
    evidence,
    currentRoleEvidence,
    continuity,
    blendWeight,
    rawMeanEdge,
    reliabilityDelta,
  };
}

function positionBaselines(contexts) {
  const groups = new Map();
  for (const context of contexts) {
    const position = context.player.position;
    if (!groups.has(position)) groups.set(position, []);
    groups.get(position).push(context);
  }
  const result = {};
  for (const [position, rows] of groups) {
    const totalWeight = rows.reduce((sum, row) => sum + Math.max(0.25, row.sourceWeekly), 0);
    result[position] = rows.reduce((sum, row) => (
      sum + row.rawMeanEdge * Math.max(0.25, row.sourceWeekly)
    ), 0) / Math.max(0.001, totalWeight);
  }
  return result;
}

function driverLabel(feature) {
  const labels = {
    priorPpg: "prior production",
    attemptsPerGame: "passing volume",
    carriesPerGame: "rushing volume",
    targetsPerGame: "target volume",
    targetShare: "target share",
    airYardsShare: "air-yards share",
    wopr: "weighted opportunity rating",
    usageCv: "role stability",
    usageTrend: "late-season role trend",
    yardsPerAttempt: "passing efficiency",
    yardsPerCarry: "rushing efficiency",
    yardsPerTarget: "receiving efficiency",
    catchRate: "catch efficiency",
    cpoe: "completion over expectation",
    age: "age curve",
    experience: "experience curve",
  };
  return labels[feature] || feature;
}

function opportunityDrivers(context, centeredEdge) {
  const rows = (context.profile.drivers || []).map((driver) => ({
    label: driverLabel(driver.feature),
    direction: driver.direction,
    impact: round(driver.contribution, 3),
  }));
  rows.unshift({
    label: "league-centered opportunity model",
    direction: centeredEdge >= 0 ? "positive" : "negative",
    impact: round(centeredEdge, 4),
  });
  return rows.slice(0, 5);
}

function applyOpportunityContext(context, baselines) {
  const player = context.player;
  const baseline = finite(baselines[player.position], 0);
  const centeredEdge = clamp(context.rawMeanEdge - baseline, -0.04, 0.04);
  const meanFactor = clamp(1 + centeredEdge, 0.96, 1.04);
  const stability = finite(context.profile.volumeStability, 0.5);
  const modelEdgeMagnitude = Math.abs(context.modelEdge);
  const volatilityFactor = clamp(
    1 - context.reliabilityDelta * 1.6 + modelEdgeMagnitude * (1 - context.evidence) * 0.04,
    0.94,
    1.08,
  );
  const floorFactor = clamp(1 + centeredEdge * 0.72 + (stability - 0.5) * 0.018, 0.95, 1.05);
  const ceilingFactor = clamp(1 + centeredEdge * 1.18 + Math.max(0, context.modelEdge) * 0.012, 0.95, 1.07);
  const weeklyProjections = (player.weeklyProjections || []).map((value) => (
    round(Math.max(0, finite(value, 0) * meanFactor), 2)
  ));
  const activeWeeks = weeklyProjections.filter((value) => value > 0);
  const weeklyProjection = activeWeeks.length
    ? activeWeeks.reduce((sum, value) => sum + value, 0) / activeWeeks.length
    : finite(player.weeklyProjection, 0) * meanFactor;
  const components = [...new Set([
    ...(player.projectionModel?.components || []),
    "historical-opportunity",
    "usage-regression",
    "age-and-experience-curve",
  ])];
  return {
    ...player,
    weeklyProjection: round(weeklyProjection, 2),
    weeklyProjections,
    projectedPoints: round(weeklyProjections.reduce((sum, value) => sum + value, 0), 2),
    floorProjection: round(Math.max(0, finite(player.floorProjection, 0) * floorFactor), 2),
    ceilingProjection: round(Math.max(0, finite(player.ceilingProjection, 0) * ceilingFactor), 2),
    projectionStdDev: round(Math.max(0.01, finite(player.projectionStdDev, 0) * volatilityFactor), 2),
    reliability: round(clamp(finite(player.reliability, 0.65) + context.reliabilityDelta, 0.2, 0.99), 3),
    projectionModel: {
      ...(player.projectionModel || {}),
      opportunityVersion: OPPORTUNITY_MODEL_VERSION,
      components,
    },
    opportunityContext: {
      version: OPPORTUNITY_MODEL_VERSION,
      sourceSeason: context.profile.sourceSeason,
      predictedPpg: context.profile.predictedPpg,
      sourcePpg: round(context.sourceWeekly, 3),
      modelEdge: round(context.modelEdge, 4),
      blendWeight: round(context.blendWeight, 4),
      evidence: round(context.evidence, 4),
      currentRoleEvidence: round(context.currentRoleEvidence, 4),
      roleContinuity: round(context.continuity, 4),
      meanFactor: round(meanFactor, 4),
      floorFactor: round(floorFactor, 4),
      ceilingFactor: round(ceilingFactor, 4),
      volatilityFactor: round(volatilityFactor, 4),
      reliabilityDelta: round(context.reliabilityDelta, 4),
      weightedOpportunityPerGame: context.profile.weightedOpportunityPerGame,
      teamOpportunityShare: context.profile.teamOpportunityShare,
      carryShare: context.profile.carryShare,
      targetShare: context.profile.targetShare,
      airYardsShare: context.profile.airYardsShare,
      wopr: context.profile.wopr,
      usageTrend: context.profile.usageTrend,
      volumeStability: context.profile.volumeStability,
      availability: context.profile.availability,
      archetype: context.profile.archetype,
      age: context.profile.age,
      experience: context.profile.experience,
      analogs: context.profile.analogs || null,
      holdout: {
        season: context.diagnostics?.holdoutSeason || null,
        samples: context.diagnostics?.holdoutSamples || 0,
        rmseImprovement: round(context.diagnostics?.rmseImprovement, 4),
        correlationLift: round(context.diagnostics?.correlationLift, 4),
      },
      drivers: opportunityDrivers(context, centeredEdge),
    },
  };
}

function applyOpportunityIntelligence(players) {
  const contexts = (players || []).map(rawOpportunityContext).filter(Boolean);
  const baselines = positionBaselines(contexts);
  const byId = new Map(contexts.map((context) => [String(context.player.id), context]));
  const modeled = (players || []).map((player) => {
    const context = byId.get(String(player.id));
    return context ? applyOpportunityContext(context, baselines) : player;
  });
  const adjusted = modeled.filter((player) => player.opportunityContext);
  const totalWeight = adjusted.reduce((sum, player) => sum + Math.max(0.25, finite(player.weeklyProjection, 0)), 0);
  const meanFactor = adjusted.reduce((sum, player) => (
    sum + player.opportunityContext.meanFactor * Math.max(0.25, finite(player.weeklyProjection, 0))
  ), 0) / Math.max(0.001, totalWeight);
  return {
    players: modeled,
    summary: {
      ...opportunitySummary(),
      modeledPlayers: adjusted.length,
      meanFactor: round(meanFactor, 6),
      baselines: Object.fromEntries(Object.entries(baselines).map(
        ([position, value]) => [position, round(value, 6)],
      )),
    },
  };
}

function opportunitySummary() {
  return {
    version: OPPORTUNITY_MODEL_VERSION,
    generatedAt: opportunityData.meta?.generatedAt || null,
    season: opportunityData.meta?.season || null,
    sourceSeason: opportunityData.meta?.sourceSeason || null,
    coverage: opportunityData.meta?.coverage || PROFILE_BY_ID.size,
    holdoutSeason: opportunityData.meta?.holdoutSeason || null,
    diagnostics: opportunityData.diagnostics || null,
    methodology: [
      "Position-specific ridge regressions on prior-season usage, efficiency, role stability, age, and experience.",
      "Ridge penalties selected with season-held-out cross-validation before the untouched 2025 holdout.",
      "Production effects are evidence-weighted, bounded, and centered within position.",
    ],
  };
}

module.exports = {
  OPPORTUNITY_MODEL_VERSION,
  applyOpportunityIntelligence,
  opportunitySummary,
  profileForPlayer,
};
