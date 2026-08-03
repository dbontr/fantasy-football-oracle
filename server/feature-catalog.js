"use strict";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FEATURE_CATALOG_VERSION = "oracle-features-2026.2";

function numberFeature(family, unit, minimum, maximum, halfLifeMs, options = {}) {
  return Object.freeze({
    type: "number",
    family,
    unit,
    minimum,
    maximum,
    halfLifeMs,
    scale: options.scale ?? Math.max(1, Math.abs(maximum - minimum)),
    description: options.description || null,
  });
}

const FEATURES = Object.freeze({
  "role.snap_share": numberFeature("opportunity", "ratio", 0, 1, 3 * DAY_MS),
  "role.route_share": numberFeature("opportunity", "ratio", 0, 1, 3 * DAY_MS),
  "role.target_share": numberFeature("opportunity", "ratio", 0, 1, 3 * DAY_MS),
  "role.air_yards_share": numberFeature("opportunity", "ratio", 0, 1.5, 3 * DAY_MS),
  "role.wopr": numberFeature("opportunity", "normalized", 0, 2, 3 * DAY_MS),
  "role.carry_share": numberFeature("opportunity", "ratio", 0, 1, 3 * DAY_MS),
  "role.red_zone_share": numberFeature("opportunity", "ratio", 0, 1, 3 * DAY_MS),
  "role.expected_opportunities": numberFeature("opportunity", "count", 0, 60, 3 * DAY_MS),
  "role.opportunity_trend": numberFeature("opportunity", "relative-change", -1, 10, 3 * DAY_MS),
  "role.depth_chart_order": numberFeature("opportunity", "order", 1, 10, 7 * DAY_MS, { scale: 3 }),
  "efficiency.expected_points_per_opportunity": numberFeature("efficiency", "points", 0, 4, 14 * DAY_MS),
  "efficiency.points_per_opportunity_trend": numberFeature("efficiency", "relative-change", -1, 10, 7 * DAY_MS),
  "efficiency.receiving_epa_per_target": numberFeature("efficiency", "epa", -3, 5, 14 * DAY_MS),
  "efficiency.rushing_epa_per_carry": numberFeature("efficiency", "epa", -3, 5, 14 * DAY_MS),
  "efficiency.passing_epa_per_dropback": numberFeature("efficiency", "epa", -3, 5, 14 * DAY_MS),
  "market.player_points": numberFeature("market", "fantasy-points", 0, 80, 6 * HOUR_MS),
  "market.team_total": numberFeature("market", "points", 0, 70, 6 * HOUR_MS),
  "market.game_total": numberFeature("market", "points", 0, 100, 6 * HOUR_MS),
  "market.spread": numberFeature("market", "points", -35, 35, 6 * HOUR_MS),
  "market.roster_momentum": numberFeature("market", "normalized", -1, 1, 12 * HOUR_MS, { scale: 1 }),
  "environment.wind_mph": numberFeature("environment", "mph", 0, 100, 2 * HOUR_MS),
  "environment.temperature_f": numberFeature("environment", "fahrenheit", -40, 140, 2 * HOUR_MS),
  "environment.precip_probability": numberFeature("environment", "ratio", 0, 1, 2 * HOUR_MS),
  "environment.indoor": Object.freeze({
    type: "boolean",
    family: "environment",
    unit: "boolean",
    halfLifeMs: 30 * DAY_MS,
    scale: 1,
    description: "Whether the game environment is effectively indoors.",
  }),
  "matchup.pass_grade": numberFeature("matchup", "normalized", -1, 1, 7 * DAY_MS),
  "matchup.rush_grade": numberFeature("matchup", "normalized", -1, 1, 7 * DAY_MS),
  "line.pass_block_grade": numberFeature("offensive-line", "normalized", -1, 1, 7 * DAY_MS),
  "line.run_block_grade": numberFeature("offensive-line", "normalized", -1, 1, 7 * DAY_MS),
  "team.pace_grade": numberFeature("environment", "normalized", -1, 1, 7 * DAY_MS),
  "health.active_probability": numberFeature("health", "ratio", 0, 1, 8 * HOUR_MS),
  "health.snap_retention": numberFeature("health", "ratio", 0, 1.25, 12 * HOUR_MS),
  "health.recurrence_risk": numberFeature("health", "ratio", 0, 1, 7 * DAY_MS),
  "news.role_delta": numberFeature("news", "normalized", -1, 1, 24 * HOUR_MS),
  "tracking.separation_yards": numberFeature("tracking", "yards", -5, 10, 14 * DAY_MS),
  "tracking.route_win_rate": numberFeature("tracking", "ratio", 0, 1, 14 * DAY_MS),
  "coaching.role_confidence": numberFeature("coaching", "ratio", 0, 1, 14 * DAY_MS),
  "health.practice_participation": Object.freeze({
    type: "categorical",
    family: "health",
    unit: "participation",
    halfLifeMs: 24 * HOUR_MS,
    scale: 1,
    values: Object.freeze(["full", "limited", "dnp", "other"]),
    description: "Normalized practice participation from a public source.",
  }),
  "availability.designation": Object.freeze({
    type: "categorical",
    family: "health",
    unit: "designation",
    halfLifeMs: 8 * HOUR_MS,
    scale: 1,
    values: Object.freeze(["active", "questionable", "doubtful", "out", "ir", "suspended"]),
    description: "Normalized player availability designation.",
  }),
});

function finite(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Feature values must be finite");
  return number;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function definitionFor(feature) {
  return FEATURES[String(feature || "")] || null;
}

function normalizeFeatureValue(feature, value) {
  const definition = definitionFor(feature);
  if (!definition) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim()) return value.trim();
    return finite(value);
  }
  if (definition.type === "number") {
    return clamp(finite(value), definition.minimum, definition.maximum);
  }
  if (definition.type === "boolean") {
    if (value === true || value === false) return value;
    if (["true", "1", "yes"].includes(String(value).toLowerCase())) return true;
    if (["false", "0", "no"].includes(String(value).toLowerCase())) return false;
    throw new TypeError(`Feature ${feature} requires a boolean value`);
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) throw new TypeError(`Feature ${feature} requires a non-empty value`);
  if (definition.values && !definition.values.includes(normalized)) {
    throw new RangeError(`Feature ${feature} does not accept ${normalized}`);
  }
  return normalized;
}
function featureCatalogSummary() {
  const families = {};
  for (const [feature, definition] of Object.entries(FEATURES)) {
    const family = definition.family || "custom";
    families[family] = families[family] || [];
    families[family].push(feature);
  }
  return {
    version: FEATURE_CATALOG_VERSION,
    features: Object.keys(FEATURES).length,
    families,
    definitions: Object.fromEntries(Object.entries(FEATURES).map(([feature, definition]) => [
      feature,
      { ...definition, values: definition.values ? [...definition.values] : undefined },
    ])),
  };
}

module.exports = {
  DAY_MS,
  FEATURES,
  FEATURE_CATALOG_VERSION,
  HOUR_MS,
  definitionFor,
  featureCatalogSummary,
  normalizeFeatureValue,
};
