"use strict";

const PERPETUAL_FREE_POLICY_VERSION = "oracle-perpetual-free-policy-2026.1";

function boolean(value) {
  return value === true;
}

function validatePerpetualFreeSource(source = {}) {
  const errors = [];
  const warnings = [];
  const id = String(source.id || "").trim();
  if (!id) errors.push("id is required");

  const access = source.access || {};
  const cost = source.cost || {};
  const operations = source.operations || {};
  const usage = source.usage || {};

  if (!boolean(access.anonymous)) errors.push("anonymous access is required");
  if (access.accountRequired !== false) errors.push("mandatory accounts are forbidden");
  if (access.apiKeyRequired !== false) errors.push("API keys are forbidden");
  if (access.oauthRequired !== false) errors.push("OAuth is forbidden");

  if (Number(cost.priceUsd) !== 0) errors.push("the source must have zero price");
  if (cost.trialOnly !== false) errors.push("trial-backed access is forbidden");
  if (cost.paymentMethodRequired !== false) errors.push("payment methods are forbidden");
  if (cost.expires !== false) errors.push("expiring free access is forbidden");
  if (cost.paidFallbackRequired !== false) errors.push("paid fallback is forbidden");
  if (cost.quotaRequiresUpgrade !== false) errors.push("paid quota upgrades are forbidden");

  if (!boolean(operations.offlineFallback)) errors.push("an offline fallback is required");
  if (operations.startupNetworkRequired !== false) {
    errors.push("network access at startup is forbidden");
  }
  if (operations.failureIsolated !== true) errors.push("provider failures must be isolated");
  if (usage.hostedFreeRestriction === true) {
    errors.push("restricted hosted free tiers are forbidden");
  }
  if (!String(source.license || "").trim()) errors.push("license or public-use basis is required");
  if (!String(source.termsUrl || "").startsWith("https://")) {
    warnings.push("terms URL is missing or not HTTPS");
  }

  return {
    version: PERPETUAL_FREE_POLICY_VERSION,
    sourceId: id || null,
    valid: errors.length === 0,
    errors,
    warnings,

    guarantees: {
      anonymous: boolean(access.anonymous),
      noAccount: access.accountRequired === false,
      noApiKey: access.apiKeyRequired === false,
      noOAuth: access.oauthRequired === false,
      zeroPrice: Number(cost.priceUsd) === 0,
      noTrial: cost.trialOnly === false,
      noPaymentMethod: cost.paymentMethodRequired === false,
      noExpiry: cost.expires === false,
      noPaidFallback: cost.paidFallbackRequired === false,
      noPaidQuotaUpgrade: cost.quotaRequiresUpgrade === false,
      offlineFallback: boolean(operations.offlineFallback),
      offlineStartup: operations.startupNetworkRequired === false,
      failureIsolated: operations.failureIsolated === true,
      unrestrictedHostedTier: usage.hostedFreeRestriction !== true,
    },
  };
}

function assertPerpetualFreeSource(source) {
  const result = validatePerpetualFreeSource(source);
  if (result.valid) return result;
  const error = new Error(`Source ${result.sourceId || "unknown"} is not perpetually free: ${result.errors.join("; ")}`);
  error.code = "FREE_SOURCE_POLICY_REJECTED";
  error.details = result;
  throw error;
}

function perpetualFreeReport(sources = []) {
  const results = sources.map((source) => validatePerpetualFreeSource(source));
  return {
    version: PERPETUAL_FREE_POLICY_VERSION,
    valid: results.every((result) => result.valid),
    sources: results,
    rejected: results.filter((result) => !result.valid).map((result) => result.sourceId),
    guarantees: {
      noTrials: results.every((result) => result.guarantees.noTrial),
      noPaymentMethods: results.every((result) => result.guarantees.noPaymentMethod),
      noMandatoryAccounts: results.every((result) => result.guarantees.noAccount),
      noApiKeys: results.every((result) => result.guarantees.noApiKey),
      noPaidFallbacks: results.every((result) => result.guarantees.noPaidFallback),
      offlineStartup: results.every((result) => result.guarantees.offlineStartup),
    },
  };
}

module.exports = {
  PERPETUAL_FREE_POLICY_VERSION,
  assertPerpetualFreeSource,
  perpetualFreeReport,
  validatePerpetualFreeSource,
};
