"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./lineage.js");
const {
  lowerTailMean,
  mixtureCdf,
  mixtureMoments,
  mixtureQuantile,
} = require("./probabilistic-forecast.js");

const FREE_CONTEXT_POLICY_VERSION = "oracle-free-context-policy-2026.1";
const FREE_CONTEXT_POLICY_SCHEMA = "free-context-policy/v1";
const DEFAULT_CONTEXT_POLICY_PATH = path.resolve(
  __dirname,
  "..",
  "data",
  "calibration",
  "free-context-policy.json",
);

const CONTEXT_FEATURES = Object.freeze([
  "airYardsShare",
  "wopr",
  "receivingEpaPerTarget",
  "rushingEpaPerCarry",
  "passingEpaPerDropback",
  "opportunityTrend",
  "pointsPerOpportunityTrend",
]);
const RUNTIME_FEATURES = Object.freeze({
  airYardsShare: "role.air_yards_share",
  wopr: "role.wopr",
  receivingEpaPerTarget: "efficiency.receiving_epa_per_target",
  rushingEpaPerCarry: "efficiency.rushing_epa_per_carry",
  passingEpaPerDropback: "efficiency.passing_epa_per_dropback",
  opportunityTrend: "role.opportunity_trend",
  pointsPerOpportunityTrend: "efficiency.points_per_opportunity_trend",
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 5) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function policyCore(value) {
  const { digest, ...core } = value || {};
  return core;
}
function validateContextPolicyDocument(value) {
  if (!value || value.version !== FREE_CONTEXT_POLICY_VERSION) {
    return { valid: false, error: "Free context policy version is invalid" };
  }
  if (value.schemaVersion !== FREE_CONTEXT_POLICY_SCHEMA) {
    return { valid: false, error: "Free context policy schema is invalid" };
  }
  if (value.approved !== true || value.validation?.nestedChronological !== true) {
    return { valid: false, error: "Free context policy lacks approval or nested validation" };
  }
  if (value.validation?.productionOrderMatched !== true
    || value.validation?.correctionTarget !== "post-calibration residual") {
    return { valid: false, error: "Free context policy does not match production order" };
  }
  if (!Number.isInteger(Number(value.holdoutSeason)) || !value.trainingSeasons?.length) {
    return { valid: false, error: "Free context policy lacks chronological seasons" };
  }
  if (value.validation?.improvement?.wis <= 0
    || value.validation?.improvement?.rmse < 0
    || value.validation?.improvement?.mae < 0) {
    return { valid: false, error: "Free context policy failed holdout improvement gates" };
  }
  if (!Array.isArray(value.features)
    || value.features.join("|") !== CONTEXT_FEATURES.join("|")) {
    return { valid: false, error: "Free context policy feature contract is invalid" };
  }
  if (!value.models || typeof value.models !== "object") {
    return { valid: false, error: "Free context policy models are missing" };
  }
  for (const [position, model] of Object.entries(value.models)) {
    if (!["QB", "RB", "WR", "TE"].includes(position)) {
      return { valid: false, error: `Unsupported context-policy position ${position}` };
    }
    if (!Array.isArray(model.coefficients)
      || model.coefficients.length !== CONTEXT_FEATURES.length) {
      return { valid: false, error: `Context-policy coefficients are invalid for ${position}` };
    }
  }
  if (!value.digest || sha256(policyCore(value)) !== value.digest) {
    return { valid: false, error: "Free context policy digest is invalid" };
  }
  return { valid: true };
}
function evidenceMap(forecast = {}) {
  return new Map((forecast.evidence?.used || []).map((row) => [row.feature, row]));
}

function runtimeFeatureVector(forecast = {}) {
  const evidence = evidenceMap(forecast);
  return Object.fromEntries(CONTEXT_FEATURES.map((feature) => {
    const row = evidence.get(RUNTIME_FEATURES[feature]);
    const value = Number(row?.value);
    return [feature, Number.isFinite(value) ? value : null];
  }));
}

function selectContextModel(policy, position) {
  return policy?.models?.[String(position || "").toUpperCase()] || null;
}

function contextCorrection(forecast, policy) {
  const model = selectContextModel(policy, forecast?.player?.position);
  if (!model) return { correction: 0, available: 0, model: null, inputs: {} };
  const inputs = runtimeFeatureVector(forecast);
  let correction = 0;
  let available = 0;
  CONTEXT_FEATURES.forEach((feature, index) => {
    const value = inputs[feature];
    if (!Number.isFinite(value)) return;
    const mean = finite(model.means?.[feature]);
    const scale = Math.max(0.05, Math.abs(finite(model.scales?.[feature], 1)));
    correction += finite(model.coefficients[index]) * ((value - mean) / scale);
    available += 1;
  });
  const strength = clamp(policy.selection?.strength, 0, 1);
  const cap = Math.max(0, finite(policy.selection?.cap, 0));
  return {
    correction: available ? clamp(correction * strength, -cap, cap) : 0,
    available,
    model,
    inputs,
  };
}
function applyContextPolicy(forecast, policy, options = {}) {
  const validation = validateContextPolicyDocument(policy);
  if (!validation.valid && options.force !== true) {
    return {
      ...forecast,
      contextPolicy: {
        applied: false,
        reason: validation.error,
        policyVersion: policy?.version || null,
        policyDigest: policy?.digest || null,
      },
    };
  }
  const result = contextCorrection(forecast, policy);
  if (!result.model || result.available === 0 || result.correction === 0) {
    return {
      ...forecast,
      contextPolicy: {
        applied: false,
        reason: result.model ? "no-context-evidence" : "unsupported-position",
        policyVersion: policy.version,
        policyDigest: policy.digest,
        availableFeatures: result.available,
      },
    };
  }
  const availability = clamp(forecast.availability?.probability, 0, 1);
  const activeMean = Math.max(0, finite(forecast.activeDistribution?.mean)
    + result.correction / Math.max(0.35, availability));
  const activeStdDev = Math.max(0.01, finite(
    forecast.activeDistribution?.standardDeviation,
    forecast.distribution?.standardDeviation,
  ));
  const moments = mixtureMoments(availability, activeMean, activeStdDev);
  const quantiles = Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((p) => [
    `p${Math.round(p * 100)}`,
    round(mixtureQuantile(p, availability, activeMean, activeStdDev), 3),
  ]));
  const bustThreshold = finite(forecast.probabilities?.bustThreshold);
  const ceilingThreshold = finite(forecast.probabilities?.ceilingThreshold);
  return {
    ...forecast,
    activeDistribution: {
      ...forecast.activeDistribution,
      mean: round(activeMean, 3),
    },
    distribution: {
      ...forecast.distribution,
      mean: round(moments.mean, 3),
      standardDeviation: round(moments.standardDeviation, 3),
      ...quantiles,
      cvar10: round(lowerTailMean(availability, activeMean, activeStdDev, 0.1), 3),
    },
    probabilities: {
      ...forecast.probabilities,
      bust: round(mixtureCdf(
        bustThreshold,
        availability,
        activeMean,
        activeStdDev,
      ), 5),
      ceiling: round(1 - mixtureCdf(
        ceilingThreshold,
        availability,
        activeMean,
        activeStdDev,
      ), 5),
    },
    contextPolicy: {
      applied: true,
      policyVersion: policy.version,
      policyDigest: policy.digest,
      holdoutSeason: policy.holdoutSeason,
      correction: round(result.correction, 5),
      availableFeatures: result.available,
      modelPosition: String(forecast.player?.position || "").toUpperCase(),
      inputs: result.inputs,
    },
  };
}

class FreeContextPolicyLoader {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || DEFAULT_CONTEXT_POLICY_PATH);
    this.policy = null;
    this.mtimeMs = 0;
    this.lastError = null;
  }

  load(options = {}) {
    try {
      const stat = fs.statSync(this.filePath);
      if (!options.force && this.policy && stat.mtimeMs === this.mtimeMs) {
        return this.policy;
      }
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const validation = validateContextPolicyDocument(value);
      if (!validation.valid) {
        throw Object.assign(new Error(validation.error), {
          code: "FREE_CONTEXT_POLICY_INVALID",
        });
      }
      this.policy = value;
      this.mtimeMs = stat.mtimeMs;
      this.lastError = null;
      return this.policy;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.policy = null;
        this.mtimeMs = 0;
        this.lastError = null;
        return null;
      }
      this.lastError = {
        code: error.code || "FREE_CONTEXT_POLICY_INVALID",
        message: String(error.message || error),
      };
      if (options.optional === true) return null;
      throw error;
    }
  }
  status() {
    const policy = this.load({ optional: true });
    return {
      version: policy?.version || FREE_CONTEXT_POLICY_VERSION,
      ready: Boolean(policy),
      valid: Boolean(policy) && !this.lastError,
      approved: policy?.approved === true,
      digest: policy?.digest || null,
      generatedAt: policy?.generatedAt || null,
      trainingSeasons: policy?.trainingSeasons || [],
      holdoutSeason: policy?.holdoutSeason || null,
      validation: policy?.validation || null,
      error: this.lastError,
    };
  }
}

module.exports = {
  CONTEXT_FEATURES,
  DEFAULT_CONTEXT_POLICY_PATH,
  FREE_CONTEXT_POLICY_SCHEMA,
  FREE_CONTEXT_POLICY_VERSION,
  FreeContextPolicyLoader,
  RUNTIME_FEATURES,
  applyContextPolicy,
  contextCorrection,
  policyCore,
  runtimeFeatureVector,
  selectContextModel,
  validateContextPolicyDocument,
};
