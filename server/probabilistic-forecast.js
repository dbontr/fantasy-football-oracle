"use strict";

const { FEATURES, definitionFor } = require("./feature-catalog.js");

const PROBABILISTIC_FORECAST_VERSION = "oracle-probabilistic-2026.1";
const POSITION_VOLATILITY = Object.freeze({
  QB: 0.27,
  RB: 0.43,
  WR: 0.49,
  TE: 0.51,
  K: 0.46,
  DST: 0.56,
});
const FAMILY_CAPS = Object.freeze({
  market: 0.3,
  opportunity: 0.28,
  efficiency: 0.16,
  health: 0.45,
  environment: 0.12,
  matchup: 0.12,
  "offensive-line": 0.1,
  news: 0.18,
  tracking: 0.12,
  coaching: 0.06,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function normalCdf(value) {
  const x = finite(value) / Math.sqrt(2);
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-absolute * absolute));
  return clamp(0.5 * (1 + erf), 0, 1);
}

function inverseNormalCdf(probability) {
  const p = clamp(probability, 1e-12, 1 - 1e-12);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143,
    3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function mixtureQuantile(probability, activeProbability, activeMean, activeStdDev) {
  const inactiveProbability = 1 - activeProbability;
  if (probability <= inactiveProbability) return 0;
  const conditional = (probability - inactiveProbability) / Math.max(activeProbability, 1e-12);
  return Math.max(0, activeMean + activeStdDev * inverseNormalCdf(conditional));
}

function mixtureCdf(value, activeProbability, activeMean, activeStdDev) {
  if (value < 0) return 0;
  const inactiveProbability = 1 - activeProbability;
  if (activeStdDev <= 0) {
    return inactiveProbability + activeProbability * Number(value >= activeMean);
  }
  return clamp(
    inactiveProbability + activeProbability * normalCdf((value - activeMean) / activeStdDev),
    0,
    1,
  );
}

function mixtureMoments(activeProbability, activeMean, activeStdDev) {
  const expected = activeProbability * activeMean;
  const secondMoment = activeProbability * (activeStdDev ** 2 + activeMean ** 2);
  return {
    mean: expected,
    variance: Math.max(0, secondMoment - expected ** 2),
    standardDeviation: Math.sqrt(Math.max(0, secondMoment - expected ** 2)),
  };
}

function lowerTailMean(activeProbability, activeMean, activeStdDev, probability = 0.1) {
  const samples = 101;
  let total = 0;
  for (let index = 0; index < samples; index += 1) {
    total += mixtureQuantile(
      ((index + 0.5) / samples) * probability,
      activeProbability,
      activeMean,
      activeStdDev,
    );
  }
  return total / samples;
}
function weeklyBaseline(player, week) {
  const index = Math.max(0, Math.min(17, Number(week || 1) - 1));
  const weekly = Number(player.weeklyProjections?.[index]);
  const meanValue = Number.isFinite(weekly)
    ? Math.max(0, weekly)
    : Math.max(0, finite(player.weeklyProjection, finite(player.projectedPoints, 0) / 17));
  const scale = meanValue > 0
    ? meanValue / Math.max(0.1, finite(player.weeklyProjection, meanValue))
    : 0;
  const baseStdDev = Math.max(
    meanValue * 0.12,
    finite(player.projectionStdDev, meanValue * (POSITION_VOLATILITY[player.position] || 0.46)) * scale,
  );
  const healthWeek = player.healthContext?.weekly?.find((row) => Number(row.week) === index + 1);
  const availability = clamp(
    healthWeek?.availability
      ?? player.healthContext?.currentAvailability
      ?? (player.active === false ? 0.05 : 0.99),
    0,
    1,
  );
  return {
    week: index + 1,
    mean: meanValue,
    standardDeviation: baseStdDev,
    availability,
    reliability: clamp(player.reliability ?? player.projectionModel?.confidence ?? 0.65, 0.05, 0.995),
    bye: Number(player.byeWeek) === index + 1 || meanValue === 0,
  };
}

function featureScope(player, feature, options = {}) {
  if (feature === "market.player_points" || feature.startsWith("role.")
    || feature.startsWith("health.") || feature.startsWith("news.")
    || feature.startsWith("tracking.") || feature.startsWith("efficiency.")
    || feature.startsWith("coaching.") || feature.startsWith("availability.")) {
    return ["player", String(player.id)];
  }
  if ((feature.startsWith("environment.") || feature === "market.game_total"
    || feature === "market.spread") && options.gameId) {
    return ["game", String(options.gameId)];
  }
  return ["team", String(player.team || "FA")];
}

function resolveFeature(evidenceStore, player, feature, options = {}) {
  const [entityType, entityId] = featureScope(player, feature, options);
  const primary = evidenceStore.resolve(entityType, entityId, feature, {
    asOf: options.asOf,
    additionalObservations: options.additionalObservations,
  });
  if (primary.available || entityType === "player") return primary;
  return evidenceStore.resolve("player", String(player.id), feature, {
    asOf: options.asOf,
    additionalObservations: options.additionalObservations,
  });
}

function rolePrior(position, feature) {
  const priors = {
    QB: { snap: 0.98, route: 0.02, target: 0, carry: 0.08, redZone: 0.12 },
    RB: { snap: 0.56, route: 0.38, target: 0.1, carry: 0.48, redZone: 0.35 },
    WR: { snap: 0.74, route: 0.72, target: 0.2, carry: 0.02, redZone: 0.23 },
    TE: { snap: 0.7, route: 0.64, target: 0.17, carry: 0.01, redZone: 0.22 },
    K: { snap: 1, route: 0, target: 0, carry: 0, redZone: 0 },
    DST: { snap: 1, route: 0, target: 0, carry: 0, redZone: 0 },
  };
  const row = priors[position] || priors.WR;
  return row[feature];
}
function contributionFor(feature, resolved, player, baseline) {
  if (!resolved?.available || resolved.type === "categorical") return null;
  const value = finite(resolved.probability ?? resolved.value);
  const confidence = clamp(resolved.confidence, 0, 1);
  const position = player.position;
  let impact = 0;
  let label = feature;

  switch (feature) {
    case "market.player_points":
      impact = (value - baseline.mean) * 0.65;
      label = "player market consensus";
      break;
    case "market.team_total":
      impact = (value - 23.5) * baseline.mean * 0.015;
      label = "team scoring environment";
      break;
    case "market.game_total":
      impact = (value - 46.5) * baseline.mean * 0.006;
      label = "game total";
      break;
    case "market.spread": {
      const coefficient = position === "RB" || position === "DST" ? 0.004 : -0.0015;
      impact = value * baseline.mean * coefficient;
      label = "expected game script";
      break;
    }
    case "role.snap_share":
      impact = (value - rolePrior(position, "snap")) * baseline.mean * 0.35;
      label = "snap share";
      break;
    case "role.route_share":
      impact = (value - rolePrior(position, "route")) * baseline.mean * 0.28;
      label = "route participation";
      break;
    case "role.target_share":
      impact = (value - rolePrior(position, "target")) * baseline.mean * 1.1;
      label = "target share";
      break;
    case "role.carry_share":
      impact = (value - rolePrior(position, "carry")) * baseline.mean * 0.65;
      label = "carry share";
      break;
    case "role.red_zone_share":
      impact = (value - rolePrior(position, "redZone")) * baseline.mean * 0.28;
      label = "red-zone share";
      break;
    case "role.expected_opportunities": {
      const prior = Math.max(1, finite(player.opportunityContext?.weightedOpportunityPerGame, 14));
      impact = clamp((value - prior) / prior, -0.5, 0.5) * baseline.mean * 0.45;
      label = "expected opportunity volume";
      break;
    }
    case "efficiency.expected_points_per_opportunity": {
      const opportunities = Math.max(1, finite(player.opportunityContext?.weightedOpportunityPerGame, 14));
      const prior = baseline.mean / opportunities;
      impact = clamp((value - prior) / Math.max(0.1, prior), -0.5, 0.5) * baseline.mean * 0.3;
      label = "efficiency per opportunity";
      break;
    }
    case "environment.wind_mph": {
      const excess = Math.max(0, value - 15);
      const sensitivity = ["QB", "WR", "TE", "K"].includes(position) ? -0.006 : 0.0015;
      impact = excess * baseline.mean * sensitivity;
      label = "wind exposure";
      break;
    }
    case "environment.temperature_f": {
      const cold = Math.max(0, 25 - value);
      const heat = Math.max(0, value - 95);
      impact = -(cold * 0.0015 + heat * 0.001) * baseline.mean;
      label = "temperature stress";
      break;
    }
    case "environment.precip_probability":
      impact = value * baseline.mean * (["DST", "RB"].includes(position) ? 0.015 : -0.035);
      label = "precipitation risk";
      break;
    case "environment.indoor":
      impact = Number(resolved.probability ?? resolved.value) * baseline.mean
        * (["QB", "WR", "TE", "K"].includes(position) ? 0.012 : 0.003);
      label = "indoor environment";
      break;
    case "matchup.pass_grade":
      impact = ["QB", "WR", "TE"].includes(position) ? value * baseline.mean * 0.08 : 0;
      label = "pass matchup";
      break;
    case "matchup.rush_grade":
      impact = ["RB", "QB"].includes(position) ? value * baseline.mean * 0.07 : 0;
      label = "rush matchup";
      break;
    case "line.pass_block_grade":
      impact = ["QB", "WR", "TE"].includes(position) ? value * baseline.mean * 0.045 : 0;
      label = "pass protection";
      break;
    case "line.run_block_grade":
      impact = ["RB", "QB"].includes(position) ? value * baseline.mean * 0.055 : 0;
      label = "run blocking";
      break;
    case "team.pace_grade":
      impact = value * baseline.mean * 0.05;
      label = "team pace";
      break;
    case "health.snap_retention":
      impact = (value - 1) * baseline.mean * 0.85;
      label = "expected snap retention";
      break;
    case "news.role_delta":
      impact = value * baseline.mean * 0.18;
      label = "reported role change";
      break;
    case "tracking.separation_yards":
      impact = ["WR", "TE"].includes(position) ? (value - 2.5) * baseline.mean * 0.025 : 0;
      label = "route separation";
      break;
    case "tracking.route_win_rate":
      impact = ["WR", "TE"].includes(position) ? (value - 0.5) * baseline.mean * 0.18 : 0;
      label = "route win rate";
      break;
    default:
      return null;
  }
  return {
    feature,
    family: definitionFor(feature)?.family || "custom",
    label,
    rawImpact: impact * confidence,
    confidence,
    conflict: clamp(resolved.conflict, 0, 1),
    value: resolved.value,
    unit: resolved.unit,
    sources: resolved.provenance?.map((row) => row.source) || [],
  };
}
function applyFamilyCaps(contributions, baselineMean) {
  const grouped = new Map();
  for (const contribution of contributions.filter(Boolean)) {
    const rows = grouped.get(contribution.family) || [];
    rows.push(contribution);
    grouped.set(contribution.family, rows);
  }
  const adjusted = [];
  for (const [family, rows] of grouped) {
    const absoluteImpact = rows.reduce((sum, row) => sum + Math.abs(row.rawImpact), 0);
    const cap = Math.max(0.25, baselineMean * (FAMILY_CAPS[family] || 0.08));
    const scale = absoluteImpact > cap ? cap / absoluteImpact : 1;
    for (const row of rows) {
      adjusted.push({
        ...row,
        impact: row.rawImpact * scale,
        capApplied: scale < 1,
        capScale: scale,
      });
    }
  }
  return adjusted.sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact));
}

function designationAvailability(value) {
  return ({
    active: 0.995,
    questionable: 0.82,
    doubtful: 0.35,
    out: 0.01,
    ir: 0.005,
    suspended: 0,
  })[String(value || "").toLowerCase()] ?? null;
}

function evidenceAuthority(resolved) {
  const provenanceAuthority = Math.max(0, ...(resolved?.provenance || []).map((row) => (
    clamp(row.confidence, 0, 1) * clamp(row.reliability, 0, 1)
  )));
  return Math.max(clamp(resolved?.confidence, 0, 1), provenanceAuthority);
}

function resolveAvailability(baseline, evidence) {
  let probability = baseline.availability;
  let confidence = baseline.reliability;
  const drivers = [];
  const active = evidence["health.active_probability"];
  if (active?.available) {
    const authority = evidenceAuthority(active);
    const weight = clamp(authority * 0.85, 0, 0.9);
    probability = probability * (1 - weight) + finite(active.value) * weight;
    confidence = Math.max(confidence, authority);
    drivers.push({
      feature: "health.active_probability",
      value: active.value,
      confidence: active.confidence,
    });
  }
  const designation = evidence["availability.designation"];
  const designated = designation?.available ? designationAvailability(designation.value) : null;
  if (designated !== null) {
    const authority = evidenceAuthority(designation);
    const weight = clamp(authority * 0.95, 0, 0.98);
    probability = probability * (1 - weight) + designated * weight;
    confidence = Math.max(confidence, authority);
    drivers.push({
      feature: "availability.designation",
      value: designation.value,
      confidence: designation.confidence,
    });
  }
  return {
    probability: clamp(probability, 0, 1),
    confidence: clamp(confidence, 0, 0.995),
    drivers,
  };
}

function resolveEvidence(evidenceStore, player, options = {}) {
  return Object.fromEntries(Object.keys(FEATURES).map((feature) => [
    feature,
    resolveFeature(evidenceStore, player, feature, options),
  ]));
}
function zeroForecast(player, baseline, asOf) {
  const distribution = {
    shape: "degenerate",
    mean: 0,
    standardDeviation: 0,
    p10: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p90: 0,
    p95: 0,
    cvar10: 0,
  };
  return {
    schemaVersion: "probabilistic-forecast/v1",
    version: PROBABILISTIC_FORECAST_VERSION,
    generatedAt: new Date().toISOString(),
    asOf,
    week: baseline.week,
    player: {
      id: String(player.id),
      name: player.name,
      team: player.team,
      position: player.position,
    },
    baseline,
    availability: { probability: 0, confidence: 1, drivers: [] },
    activeDistribution: { mean: 0, standardDeviation: 0 },
    distribution,
    confidence: 1,
    uncertainty: { aleatoric: 0, epistemic: 0, availability: 0, evidenceConflict: 0 },
    evidence: { used: [], missingFamilies: [], coverage: 0 },
    contributions: [],
    probabilities: { bust: 1, ceiling: 0 },
    warnings: ["The player is on bye or has a zero weekly baseline."],
  };
}
function forecastPlayer(player, evidenceStore, options = {}) {
  if (!player?.id) throw new TypeError("Probabilistic forecast requires a player");
  if (!evidenceStore || typeof evidenceStore.resolve !== "function") {
    throw new TypeError("Probabilistic forecast requires an evidence store");
  }
  const asOf = new Date(options.asOf || Date.now()).toISOString();
  const baseline = weeklyBaseline(player, options.week || 1);
  if (baseline.bye) return zeroForecast(player, baseline, asOf);

  const evidence = resolveEvidence(evidenceStore, player, {
    ...options,
    asOf,
  });
  const contributions = applyFamilyCaps(
    Object.entries(evidence).map(([feature, resolved]) => (
      contributionFor(feature, resolved, player, baseline)
    )),
    baseline.mean,
  );
  const activeMean = Math.max(0, baseline.mean + contributions.reduce(
    (sum, row) => sum + row.impact,
    0,
  ));
  const availability = resolveAvailability(baseline, evidence);
  const usedEvidence = Object.values(evidence).filter((row) => row.available);
  const usedFamilies = new Set(usedEvidence.map((row) => row.family));
  const criticalFamilies = [
    "market", "opportunity", "health", "environment",
    "matchup", "offensive-line", "tracking",
  ];
  const missingFamilies = criticalFamilies.filter((family) => !usedFamilies.has(family));
  const evidenceConfidence = usedEvidence.length
    ? mean(usedEvidence.map((row) => clamp(row.confidence, 0, 1)))
    : 0;
  const evidenceConflict = usedEvidence.length
    ? usedEvidence.reduce(
      (sum, row) => sum + clamp(row.conflict, 0, 1) * Math.max(0.05, row.confidence),
      0,
    ) / usedEvidence.reduce((sum, row) => sum + Math.max(0.05, row.confidence), 0)
    : 0;
  const familyCount = new Set(Object.values(FEATURES).map((row) => row.family)).size;
  const coverage = clamp(usedFamilies.size / Math.max(1, familyCount), 0, 1);
  const recurrenceRisk = evidence["health.recurrence_risk"]?.available
    ? finite(evidence["health.recurrence_risk"].value)
    : finite(player.healthContext?.recurrenceRisk, finite(player.injuryRisk, 0.08));
  const roleConfidence = evidence["coaching.role_confidence"]?.available
    ? finite(evidence["coaching.role_confidence"].value)
    : finite(player.decisionIntelligence?.opportunity?.roleCertainty, 0.55);

  const aleatoric = baseline.standardDeviation;
  const epistemic = baseline.mean * (
    0.05
    + (1 - baseline.reliability) * 0.28
    + (1 - coverage) * 0.1
    + evidenceConflict * 0.22
  ) * (1.08 - clamp(roleConfidence, 0, 1) * 0.16);
  const conflictUncertainty = baseline.mean * evidenceConflict * 0.18;
  const activeStdDev = Math.max(
    activeMean * 0.08,
    Math.sqrt(aleatoric ** 2 + epistemic ** 2 + conflictUncertainty ** 2)
      * (1 + clamp(recurrenceRisk, 0, 1) * 0.12),
  );
  const moments = mixtureMoments(
    availability.probability,
    activeMean,
    activeStdDev,
  );
  const quantiles = Object.fromEntries([
    ["p10", 0.1], ["p25", 0.25], ["p50", 0.5],
    ["p75", 0.75], ["p90", 0.9], ["p95", 0.95],
  ].map(([label, probability]) => [
    label,
    mixtureQuantile(probability, availability.probability, activeMean, activeStdDev),
  ]));
  const bustThreshold = finite(options.bustThreshold, baseline.mean * 0.6);
  const ceilingThreshold = finite(options.ceilingThreshold, baseline.mean * 1.4);
  const confidence = clamp(
    baseline.reliability * 0.5
      + evidenceConfidence * 0.22
      + availability.confidence * 0.18
      + coverage * 0.1
      - evidenceConflict * 0.2,
    0.05,
    0.995,
  );
  const availabilityUncertainty = Math.sqrt(
    availability.probability * (1 - availability.probability),
  ) * activeMean;
  const distribution = {
    shape: "zero-inflated-normal",
    mean: round(moments.mean, 3),
    standardDeviation: round(moments.standardDeviation, 3),
    ...Object.fromEntries(Object.entries(quantiles).map(([key, value]) => [key, round(value, 3)])),
    cvar10: round(lowerTailMean(
      availability.probability,
      activeMean,
      activeStdDev,
      0.1,
    ), 3),
  };
  const warnings = [];
  if (missingFamilies.length) {
    warnings.push(`Missing live evidence families: ${missingFamilies.join(", ")}`);
  }
  if (evidenceConflict >= 0.35) {
    warnings.push("Material source conflict is widening the forecast distribution.");
  }
  if (availability.probability < 0.75) {
    warnings.push("Availability risk materially affects the lower tail.");
  }

  return {
    schemaVersion: "probabilistic-forecast/v1",
    version: PROBABILISTIC_FORECAST_VERSION,
    generatedAt: new Date().toISOString(),
    asOf,
    week: baseline.week,
    player: {
      id: String(player.id),
      name: player.name,
      team: player.team,
      position: player.position,
    },
    baseline: {
      ...baseline,
      mean: round(baseline.mean, 3),
      standardDeviation: round(baseline.standardDeviation, 3),
      availability: round(baseline.availability, 4),
      reliability: round(baseline.reliability, 4),
    },
    availability: {
      probability: round(availability.probability, 4),
      confidence: round(availability.confidence, 4),
      drivers: availability.drivers,
    },
    activeDistribution: {
      mean: round(activeMean, 3),
      standardDeviation: round(activeStdDev, 3),
    },
    distribution,
    confidence: round(confidence, 4),
    uncertainty: {
      aleatoric: round(aleatoric, 3),
      epistemic: round(epistemic, 3),
      availability: round(availabilityUncertainty, 3),
      evidenceConflict: round(conflictUncertainty, 3),
      recurrenceRisk: round(recurrenceRisk, 4),
    },
    evidence: {
      coverage: round(coverage, 4),
      confidence: round(evidenceConfidence, 4),
      conflict: round(evidenceConflict, 4),
      used: usedEvidence.map((row) => ({
        feature: row.feature,
        family: row.family,
        entityType: row.entityType,
        entityId: row.entityId,
        value: row.value,
        confidence: round(row.confidence, 4),
        conflict: round(row.conflict, 4),
        stale: row.stale,
        freshestAt: row.freshestAt,
        sources: row.provenance?.map((source) => source.source) || [],
      })),
      missingFamilies,
    },
    contributions: contributions.map((row) => ({
      ...row,
      rawImpact: round(row.rawImpact, 4),
      impact: round(row.impact, 4),
      confidence: round(row.confidence, 4),
      conflict: round(row.conflict, 4),
      capScale: round(row.capScale, 4),
    })),
    probabilities: {
      bustThreshold: round(bustThreshold, 3),
      bust: round(mixtureCdf(
        bustThreshold,
        availability.probability,
        activeMean,
        activeStdDev,
      ), 4),
      ceilingThreshold: round(ceilingThreshold, 3),
      ceiling: round(1 - mixtureCdf(
        ceilingThreshold,
        availability.probability,
        activeMean,
        activeStdDev,
      ), 4),
    },
    warnings,
  };
}

function forecastPlayers(players, evidenceStore, options = {}) {
  if (!Array.isArray(players)) throw new TypeError("players must be an array");
  return players.map((player) => forecastPlayer(player, evidenceStore, options));
}

module.exports = {
  FAMILY_CAPS,
  POSITION_VOLATILITY,
  PROBABILISTIC_FORECAST_VERSION,
  applyFamilyCaps,
  contributionFor,
  forecastPlayer,
  forecastPlayers,
  inverseNormalCdf,
  lowerTailMean,
  mixtureCdf,
  mixtureMoments,
  mixtureQuantile,
  normalCdf,
  resolveAvailability,
  resolveEvidence,
  weeklyBaseline,
};
