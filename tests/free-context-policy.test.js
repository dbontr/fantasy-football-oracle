"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const policy = require("../data/calibration/free-context-policy.json");
const {
  applyContextPolicy,
  contextCorrection,
  validateContextPolicyDocument,
} = require("../server/free-context-policy.js");

function forecast(position = "WR", used = []) {
  return {
    player: { id: "p1", name: "Player", team: "DET", position },
    availability: { probability: 0.94 },
    activeDistribution: { mean: 15, standardDeviation: 6 },
    distribution: { mean: 14.1, standardDeviation: 6.5,
      p10: 5, p25: 9, p50: 14, p75: 19, p90: 23, p95: 26, cvar10: 3 },
    probabilities: { bustThreshold: 8, bust: 0.2,
      ceilingThreshold: 22, ceiling: 0.12 },
    evidence: { used },
  };
}
test("committed context policy is approved and digest-valid", () => {
  const validation = validateContextPolicyDocument(policy);
  assert.deepEqual(validation, { valid: true });
  assert.equal(policy.approved, true);
  assert.equal(policy.holdoutSeason, 2025);
  assert.equal(policy.validation.nestedChronological, true);
  assert.equal(policy.validation.productionOrderMatched, true);
  assert.equal(policy.validation.correctionTarget, "post-calibration residual");
  assert.ok(policy.validation.improvement.wis > 0);
  assert.ok(policy.validation.improvement.rmse >= 0);
  assert.ok(policy.validation.improvement.mae >= 0);
});

test("context policy rejects a production-order mismatch", () => {
  const tampered = JSON.parse(JSON.stringify(policy));
  tampered.validation.productionOrderMatched = false;
  assert.equal(validateContextPolicyDocument(tampered).valid, false);
});

test("context policy rejects tampered coefficients", () => {
  const tampered = JSON.parse(JSON.stringify(policy));
  tampered.models.WR.coefficients[0] += 0.1;
  assert.equal(validateContextPolicyDocument(tampered).valid, false);
});

test("context policy applies only bounded evidence-backed corrections", () => {
  const input = forecast("WR", [
    { feature: "role.target_share", value: 0.28 },
    { feature: "role.air_yards_share", value: 0.35 },
    { feature: "role.wopr", value: 0.63 },
    { feature: "efficiency.receiving_epa_per_target", value: 0.4 },
    { feature: "role.opportunity_trend", value: 0.2 },
  ]);
  const correction = contextCorrection(input, policy);
  assert.equal(correction.available, 4);
  assert.ok(Math.abs(correction.correction) <= policy.selection.cap);
  const result = applyContextPolicy(input, policy);
  assert.equal(result.contextPolicy.applied, true);
  assert.equal(result.contextPolicy.policyDigest, policy.digest);
  assert.equal(result.contextPolicy.availableFeatures, 4);
  assert.notEqual(result.distribution.mean, input.distribution.mean);
  assert.ok(result.distribution.p10 <= result.distribution.p50);
  assert.ok(result.distribution.p50 <= result.distribution.p90);
});
test("context policy stays inactive without usable evidence or a supported model", () => {
  const missing = applyContextPolicy(forecast("WR"), policy);
  assert.equal(missing.contextPolicy.applied, false);
  assert.equal(missing.contextPolicy.reason, "no-context-evidence");

  const kicker = applyContextPolicy(forecast("K", [
    { feature: "role.opportunity_trend", value: 0.5 },
  ]), policy);
  assert.equal(kicker.contextPolicy.applied, false);
  assert.equal(kicker.contextPolicy.reason, "unsupported-position");
});

test("context policy artifact remains compact", () => {
  const stat = fs.statSync(require.resolve("../data/calibration/free-context-policy.json"));
  assert.ok(stat.size < 100_000);
});
