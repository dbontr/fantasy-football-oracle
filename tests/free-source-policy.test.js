"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FREE_SOURCES, publicSourceCatalog } = require("../server/free-source-catalog.js");
const { FreeSourceCache } = require("../server/free-source-cache.js");
const {
  assertPerpetualFreeSource,
  perpetualFreeReport,
  validatePerpetualFreeSource,
} = require("../server/free-source-policy.js");

const compliant = {
  id: "fixture",
  origins: ["https://example.test"],
  license: "public domain",
  termsUrl: "https://example.test/terms",
  access: { anonymous: true, accountRequired: false, apiKeyRequired: false, oauthRequired: false },
  cost: { priceUsd: 0, trialOnly: false, paymentMethodRequired: false, expires: false,
    paidFallbackRequired: false, quotaRequiresUpgrade: false },
};

compliant.operations = { offlineFallback: true, startupNetworkRequired: false, failureIsolated: true };
compliant.usage = { hostedFreeRestriction: false };

test("committed sources satisfy the perpetual-free contract", () => {
  const report = perpetualFreeReport(FREE_SOURCES);
  assert.equal(report.valid, true);
  assert.equal(report.guarantees.noTrials, true);
  assert.equal(report.guarantees.noPaymentMethods, true);
  assert.equal(report.guarantees.noMandatoryAccounts, true);
  assert.equal(report.guarantees.noPaidFallbacks, true);
  assert.deepEqual(report.rejected, []);
  assert.equal(publicSourceCatalog().policy.valid, true);
});

test("policy rejects trials, payment methods, accounts, and restricted hosted tiers", () => {
  for (const mutation of [
    { cost: { ...compliant.cost, trialOnly: true } },
    { cost: { ...compliant.cost, paymentMethodRequired: true } },
    { access: { ...compliant.access, accountRequired: true } },
    { usage: { hostedFreeRestriction: true } },
  ]) {

    const candidate = { ...compliant, ...mutation };
    const result = validatePerpetualFreeSource(candidate);
    assert.equal(result.valid, false);
    assert.throws(() => assertPerpetualFreeSource(candidate), { code: "FREE_SOURCE_POLICY_REJECTED" });
  }
});

test("cache rejects a noncompliant source before any network request", () => {
  assert.throws(() => new FreeSourceCache({
    rootDir: process.cwd(),
    sources: [{ ...compliant, id: "trial", cost: { ...compliant.cost, trialOnly: true } }],
    fetchImpl: async () => { throw new Error("must not run"); },
  }), { code: "FREE_SOURCE_POLICY_REJECTED" });
});
