"use strict";

const crypto = require("node:crypto");
const {
  COACH_MODEL_VERSION,
  applyCoachingToPlayer,
  coachingSummary,
} = require("./coaching-model.js");
const {
  CONTEXT_MODEL_VERSION,
  applyContextIntelligence,
} = require("./context-intelligence.js");
const {
  OPPORTUNITY_MODEL_VERSION,
  applyOpportunityIntelligence,
} = require("./opportunity-model.js");
const {
  HEALTH_MODEL_VERSION,
  applyHealthIntelligence,
} = require("./health-model.js");

const MODEL_VERSION = "oracle-ensemble-2026.5-health";
const POSITION_VOLATILITY = Object.freeze({
  QB: 0.27,
  RB: 0.43,
  WR: 0.49,
  TE: 0.51,
  K: 0.46,
  DST: 0.56,
});

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
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce(
    (total, value) => total + ((value - average) ** 2),
    0,
  ) / values.length;
  return Math.sqrt(variance);
}

function statusAvailability(player) {
  const status = String(player.injuryStatus || "ACTIVE").toUpperCase();
  if (status.includes("IR") || status.includes("OUT")) return 0.2;
  if (status.includes("DOUBTFUL")) return 0.62;
  if (status.includes("SUSPENSION")) return 0.7;
  if (status.includes("QUESTIONABLE")) return 0.92;
  return 1;
}

function roleStability(player) {
  const owned = clamp(player.percentOwned, 0, 100) / 100;
  const started = clamp(player.percentStarted, 0, 100) / 100;
  const prior = finite(player.previousPoints, 0) > 0 ? 0.12 : 0;
  return clamp(0.34 + owned * 0.3 + started * 0.24 + prior, 0.34, 0.98);
}

function scheduleFactor(game) {
  if (!game) return 1;
  return (game.home ? 1.012 : 0.994) * (game.indoor ? 1.008 : 1);
}

function modelPlayer(rawPlayer, schedule, generatedAt) {
  const player = { ...rawPlayer };
  const teamSchedule = schedule?.[player.team] || null;
  const sourceWeekly = Array.from({ length: 18 }, (_, index) => {
    const value = Number(player.weeklyProjections?.[index]);
    return Number.isFinite(value) ? Math.max(0, value) : null;
  });
  const seasonMean = finite(player.projectedPoints, 0) / 17;
  const priorMean = finite(player.previousPoints, 0) / 17;
  const reliability = clamp(player.reliability ?? 0.72, 0.25, 0.98);
  const stability = roleStability(player);
  const availability = player.healthSource ? 1 : statusAvailability(player);
  const sourceWeight = 0.72 + reliability * 0.16;
  const priorWeight = priorMean > 0 ? 0.1 + stability * 0.06 : 0;
  const baselineWeight = Math.max(0, 1 - sourceWeight - priorWeight);

  const modeledWeekly = sourceWeekly.map((sourceValue, index) => {
    const week = index + 1;
    if (Number(player.byeWeek) === week) return 0;
    const source = sourceValue === null ? seasonMean : sourceValue;
    const totalWeight = sourceWeight + priorWeight + baselineWeight;
    const blended = (
      source * sourceWeight +
      priorMean * priorWeight +
      seasonMean * baselineWeight
    ) / Math.max(0.001, totalWeight);
    const game = teamSchedule?.weeks?.[index] || null;
    const roleFactor = 0.97 + stability * 0.045;
    const injuryFactor = 0.94 + availability * 0.06;
    return round(Math.max(0, blended * roleFactor * injuryFactor * scheduleFactor(game)), 2);
  });

  const activeWeeks = modeledWeekly.filter((value) => value > 0);
  const modeledMean = activeWeeks.length ? mean(activeWeeks) : finite(player.weeklyProjection, 0);
  const observedVariation = standardDeviation(activeWeeks);
  const baseVolatility = POSITION_VOLATILITY[player.position] || 0.46;
  const uncertainty = Math.max(
    observedVariation,
    modeledMean * baseVolatility * (1.12 - reliability * 0.38),
  );
  const confidence = clamp(
    reliability * 0.52 + stability * 0.34 + availability * 0.14,
    0.2,
    0.98,
  );
  const projectedPoints = modeledWeekly.reduce((total, value) => total + value, 0);

  return applyCoachingToPlayer({
    ...player,
    sourceWeeklyProjection: finite(player.weeklyProjection, seasonMean),
    sourceWeeklyProjections: sourceWeekly,
    weeklyProjection: round(modeledMean, 2),
    weeklyProjections: modeledWeekly,
    projectedPoints: round(projectedPoints, 2),
    floorProjection: round(Math.max(0, modeledMean - uncertainty), 2),
    ceilingProjection: round(modeledMean + uncertainty * 1.5, 2),
    projectionStdDev: round(uncertainty, 2),
    reliability: round(confidence, 3),
    projectionModel: {
      version: MODEL_VERSION,
      generatedAt,
      confidence: round(confidence, 3),
      roleStability: round(stability, 3),
      availability: round(availability, 3),
      components: ["espn-weekly", "season-baseline", "prior-production", "role", "schedule"],
    },
  });
}

function applyProjectionModel(dataset) {
  const generatedAt = new Date().toISOString();
  const schedule = dataset?.schedule || {};
  const coachedPlayers = (dataset?.players || []).map((player) => (
    modelPlayer(player, schedule, generatedAt)
  ));
  const opportunityModel = applyOpportunityIntelligence(coachedPlayers);
  const healthModel = applyHealthIntelligence(
    opportunityModel.players,
    schedule,
    Date.parse(generatedAt),
  );
  const contextModel = applyContextIntelligence(healthModel.players, schedule);
  const players = contextModel.players;
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({
      sourceGeneratedAt: dataset?.meta?.generatedAt || null,
      modelVersion: MODEL_VERSION,
      coachingVersion: COACH_MODEL_VERSION,
      coachingVerifiedAt: coachingSummary().verifiedAt,
      contextVersion: CONTEXT_MODEL_VERSION,
      opportunityVersion: OPPORTUNITY_MODEL_VERSION,
      healthVersion: HEALTH_MODEL_VERSION,
      count: players.length,
    }))
    .digest("hex");
  return {
    ...dataset,
    meta: {
      ...(dataset?.meta || {}),
      modelVersion: MODEL_VERSION,
      coachingVersion: COACH_MODEL_VERSION,
      coachingVerifiedAt: coachingSummary().verifiedAt,
      contextVersion: CONTEXT_MODEL_VERSION,
      opportunityVersion: OPPORTUNITY_MODEL_VERSION,
      healthVersion: HEALTH_MODEL_VERSION,
      modelGeneratedAt: generatedAt,
      modelDigest: digest,
      count: players.length,
      serverModeled: true,
    },
    coaching: coachingSummary(),
    opportunity: opportunityModel.summary,
    health: healthModel.summary,
    intelligence: contextModel.intelligence,
    players,
  };
}

module.exports = {
  MODEL_VERSION,
  applyProjectionModel,
  modelPlayer,
};
