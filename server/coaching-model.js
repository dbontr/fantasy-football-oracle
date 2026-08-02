"use strict";

const coachingData = require("../data/coaches-2026.json");

const COACH_MODEL_VERSION = coachingData.meta.version;
const TEAM_PROFILES = Object.values(coachingData.teams);
const BASELINE_CACHE = new Map();

const NEUTRAL_PROFILE = Object.freeze({
  team: "FA",
  teamName: "Free Agent",
  headCoach: "Unassigned",
  offensiveCoordinator: "Unassigned",
  defensiveCoordinator: "Unassigned",
  offensivePlayCaller: "Unassigned",
  schemeLabel: "Neutral",
  newStaff: false,
  evidenceSeasons: 0,
  confidence: 0.25,
  leadership: {
    leadership: .5,
    adaptability: .5,
    roleClarity: .5,
    continuity: .5,
    workloadManagement: .5,
  },
  offense: {
    design: .5,
    pace: .5,
    passRate: .5,
    targetConcentration: .5,
    rbCommittee: .5,
    teUsage: .5,
    qbRun: .5,
    playAction: .5,
    motion: .5,
    redZone: .5,
    aggression: .5,
  },
  defense: {
    design: .5,
    development: .5,
    aggression: .5,
    stability: .5,
  },
  development: {
    QB: .5,
    RB: .5,
    WR: .5,
    TE: .5,
    K: .5,
    DST: .5,
  },
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

function profileForTeam(team) {
  return coachingData.teams[String(team || "").toUpperCase()] || NEUTRAL_PROFILE;
}

function evidenceWeight(profile) {
  const seasons = Math.max(0, finite(profile.evidenceSeasons, 0));
  const sampleWeight = seasons / (seasons + 4);
  return clamp(finite(profile.confidence, .5) * sampleWeight, .08, .9);
}

function shrink(score, profile, direct = false) {
  const weight = direct
    ? clamp(.55 + finite(profile.confidence, .5) * .35, .55, .9)
    : evidenceWeight(profile);
  return .5 + (clamp(score, 0, 1) - .5) * weight;
}
function weighted(values) {
  let numerator = 0;
  let denominator = 0;
  for (const [value, weight] of values) {
    numerator += finite(value, .5) * weight;
    denominator += weight;
  }
  return denominator ? numerator / denominator : .5;
}

function usageScore(position, profile) {
  const offense = profile.offense || NEUTRAL_PROFILE.offense;
  const leadership = profile.leadership || NEUTRAL_PROFILE.leadership;
  if (position === "QB") return weighted([
    [offense.passRate, .22],
    [offense.pace, .14],
    [offense.playAction, .18],
    [offense.motion, .14],
    [offense.qbRun, .18],
    [offense.aggression, .14],
  ]);
  if (position === "RB") return weighted([
    [1 - offense.passRate, .21],
    [offense.pace, .11],
    [1 - offense.rbCommittee, .23],
    [offense.redZone, .18],
    [offense.playAction, .14],
    [leadership.workloadManagement, .13],
  ]);
  if (position === "WR") return weighted([
    [offense.passRate, .27],
    [offense.pace, .15],
    [offense.targetConcentration, .20],
    [offense.motion, .14],
    [offense.aggression, .13],
    [offense.playAction, .11],
  ]);
  if (position === "TE") return weighted([
    [offense.passRate, .18],
    [offense.teUsage, .25],
    [offense.targetConcentration, .13],
    [offense.playAction, .18],
    [offense.redZone, .14],
    [leadership.roleClarity, .12],
  ]);
  if (position === "DST") {
    const defense = profile.defense || NEUTRAL_PROFILE.defense;
    return weighted([
      [defense.design, .31],
      [defense.development, .25],
      [defense.aggression, .24],
      [defense.stability, .20],
    ]);
  }
  if (position === "K") return weighted([
    [offense.pace, .26],
    [1 - offense.redZone, .20],
    [leadership.roleClarity, .24],
    [leadership.continuity, .18],
    [leadership.leadership, .12],
  ]);
  return .5;
}

function effectiveScores(profile, position) {
  const leadership = profile.leadership || NEUTRAL_PROFILE.leadership;
  const defense = profile.defense || NEUTRAL_PROFILE.defense;
  const design = position === "DST"
    ? defense.design
    : profile.offense?.design;
  return {
    leadership: shrink(leadership.leadership, profile),
    adaptability: shrink(leadership.adaptability, profile),
    roleClarity: shrink(leadership.roleClarity, profile),
    continuity: shrink(leadership.continuity, profile, true),
    workload: shrink(leadership.workloadManagement, profile),
    design: shrink(design, profile),
    development: shrink(profile.development?.[position] ?? .5, profile),
    usage: shrink(usageScore(position, profile), profile),
    aggression: shrink(profile.offense?.aggression ?? .5, profile),
  };
}
function leagueBaseline(position) {
  if (BASELINE_CACHE.has(position)) return BASELINE_CACHE.get(position);
  const rows = TEAM_PROFILES.map((profile) => effectiveScores(profile, position));
  const keys = Object.keys(rows[0]);
  const baseline = Object.fromEntries(keys.map((key) => [
    key,
    rows.reduce((sum, row) => sum + row[key], 0) / rows.length,
  ]));
  BASELINE_CACHE.set(position, baseline);
  return baseline;
}

function factorExplanations(position, effective, baseline) {
  const labels = [
    [effective.development - baseline.development, `${position} development`],
    [effective.usage - baseline.usage, "scheme usage"],
    [
      effective.design - baseline.design,
      position === "DST" ? "defensive design" : "play-calling design",
    ],
    [effective.roleClarity - baseline.roleClarity, "role clarity"],
    [effective.continuity - baseline.continuity, "staff continuity"],
    [effective.adaptability - baseline.adaptability, "in-game adaptability"],
    [effective.leadership - baseline.leadership, "leadership environment"],
  ].sort((left, right) => Math.abs(right[0]) - Math.abs(left[0]));
  return labels.slice(0, 3).map(([edge, label]) => ({
    label,
    direction: edge >= 0 ? "positive" : "negative",
    strength: round(Math.abs(edge) * 2, 2),
  }));
}
function coachingContext(player) {
  const profile = profileForTeam(player.team);
  const position = String(player.position || "").toUpperCase();
  const effective = effectiveScores(profile, position);
  const baseline = profile.team === "FA"
    ? effectiveScores(NEUTRAL_PROFILE, position)
    : leagueBaseline(position);
  const edge = (key) => effective[key] - baseline[key];

  const meanEdge = (
    edge("design") * .035 +
    edge("development") * .032 +
    edge("usage") * .045 +
    edge("adaptability") * .018 +
    edge("leadership") * .012
  );
  const reliabilityDelta = (
    edge("roleClarity") * .09 +
    edge("leadership") * .06 +
    edge("continuity") * .08 +
    edge("workload") * .035
  );
  const staffChangePenalty = profile.team !== "FA" && profile.newStaff
    ? .025 + (1 - finite(profile.confidence, .5)) * .02
    : 0;
  const volatilityFactor = clamp(
    1 - edge("roleClarity") * .18 -
      edge("continuity") * .13 +
      edge("aggression") * .09 +
      staffChangePenalty,
    .87,
    1.16,
  );
  const ceilingFactor = clamp(
    1 + edge("development") * .14 +
      edge("usage") * .09 +
      edge("adaptability") * .07,
    .97,
    1.12,
  );
  const injuryRiskFactor = clamp(
    1 - edge("workload") * .08 -
      edge("continuity") * .04 +
      Math.max(0, -edge("continuity")) * .04,
    .94,
    1.08,
  );

  return {
    version: COACH_MODEL_VERSION,
    team: profile.team,
    teamName: profile.teamName || profile.team,
    headCoach: profile.headCoach,
    offensiveCoordinator: profile.offensiveCoordinator,
    defensiveCoordinator: profile.defensiveCoordinator,
    offensivePlayCaller: profile.offensivePlayCaller,
    scheme: profile.schemeLabel,
    newStaff: Boolean(profile.newStaff),
    evidenceSeasons: finite(profile.evidenceSeasons, 0),
    sourceConfidence: round(profile.confidence, 3),
    meanFactor: round(clamp(1 + meanEdge, .95, 1.06), 4),
    reliabilityDelta: round(clamp(reliabilityDelta, -.06, .06), 4),
    volatilityFactor: round(volatilityFactor, 4),
    ceilingFactor: round(ceilingFactor, 4),
    injuryRiskFactor: round(injuryRiskFactor, 4),
    effective: Object.fromEntries(
      Object.entries(effective).map(([key, value]) => [key, round(value, 3)]),
    ),
    leagueBaseline: Object.fromEntries(
      Object.entries(baseline).map(([key, value]) => [key, round(value, 3)]),
    ),
    drivers: factorExplanations(position, effective, baseline),
  };
}

function applyCoachingToPlayer(player) {
  const context = coachingContext(player);
  const weeklyValues = Array.isArray(player.weeklyProjections)
    ? player.weeklyProjections.map((value) => (
      round(Math.max(0, finite(value) * context.meanFactor), 2)
    ))
    : [];
  const active = weeklyValues.filter((value) => value > 0);
  const weeklyProjection = active.length
    ? active.reduce((total, value) => total + value, 0) / active.length
    : finite(player.weeklyProjection) * context.meanFactor;
  const deviation = finite(
    player.projectionStdDev,
    weeklyProjection * .45,
  ) * context.volatilityFactor;
  const reliability = clamp(
    finite(player.reliability, .65) + context.reliabilityDelta,
    .2,
    .98,
  );
  const floor = Math.max(0, weeklyProjection - deviation);
  const ceiling = weeklyProjection + deviation * 1.5 * context.ceilingFactor;
  const injuryRisk = clamp(
    finite(player.injuryRisk, .15) * context.injuryRiskFactor,
    0,
    .95,
  );

  return {
    ...player,
    weeklyProjection: round(weeklyProjection, 2),
    weeklyProjections: weeklyValues,
    projectedPoints: round(
      weeklyValues.reduce((total, value) => total + value, 0),
      2,
    ),
    floorProjection: round(floor, 2),
    ceilingProjection: round(ceiling, 2),
    projectionStdDev: round(deviation, 2),
    reliability: round(reliability, 3),
    injuryRisk: round(injuryRisk, 3),
    projectionModel: {
      ...(player.projectionModel || {}),
      coachingVersion: COACH_MODEL_VERSION,
      components: [...new Set([
        ...(player.projectionModel?.components || []),
        "coaching-staff",
        "scheme",
        "player-development",
      ])],
    },
    coachingContext: context,
  };
}

function coachingSummary() {
  return {
    ...coachingData.meta,
    teams: coachingData.teams,
  };
}

module.exports = {
  COACH_MODEL_VERSION,
  applyCoachingToPlayer,
  coachingContext,
  coachingData,
  coachingSummary,
  effectiveScores,
  evidenceWeight,
  leagueBaseline,
  profileForTeam,
  shrink,
  usageScore,
};
