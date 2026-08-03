"use strict";

const { perpetualFreeReport } = require("./free-source-policy.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FREE_SOURCE_CATALOG_VERSION = "oracle-free-sources-2026.2";

const PERPETUAL_ACCESS = Object.freeze({
  anonymous: true,
  accountRequired: false,
  apiKeyRequired: false,
  oauthRequired: false,
});

const PERPETUAL_COST = Object.freeze({
  priceUsd: 0,
  trialOnly: false,
  paymentMethodRequired: false,
  expires: false,
  paidFallbackRequired: false,
  quotaRequiresUpgrade: false,
});

const PERPETUAL_OPERATIONS = Object.freeze({
  offlineFallback: true,
  startupNetworkRequired: false,
  failureIsolated: true,
});

function source(options) {
  return Object.freeze({
    ...options,
    access: PERPETUAL_ACCESS,
    cost: PERPETUAL_COST,
    operations: PERPETUAL_OPERATIONS,
    usage: Object.freeze({ hostedFreeRestriction: false, ...(options.usage || {}) }),
  });
}

const FREE_SOURCES = Object.freeze([
  source({
    id: "sleeper",
    origins: ["https://api.sleeper.app"],
    pathPrefixes: ["/v1/"],
    attribution: "Sleeper",
    license: "Public read-only API",
    termsUrl: "https://docs.sleeper.com/",

    maxBytes: 32 * 1024 * 1024,
    minFetchIntervalMs: 15 * 60 * 1000,
    maxStaleMs: 7 * DAY_MS,
  }),
  source({
    id: "nflverse",
    origins: ["https://github.com"],
    redirectOrigins: [
      "https://release-assets.githubusercontent.com",
      "https://objects.githubusercontent.com",
    ],
    pathPrefixes: ["/nflverse/nflverse-data/releases/download/"],
    attribution: "nflverse",
    license: "CC-BY-4.0 unless an individual release states otherwise",
    termsUrl: "https://github.com/nflverse/nflverse-data",
    maxBytes: 180 * 1024 * 1024,
    minFetchIntervalMs: 6 * HOUR_MS,
    maxStaleMs: 45 * DAY_MS,
  }),

  source({
    id: "nws",
    origins: ["https://api.weather.gov"],
    pathPrefixes: ["/points/", "/gridpoints/"],
    attribution: "NOAA National Weather Service",
    license: "United States Government open data; free for any purpose",
    termsUrl: "https://www.weather.gov/documentation/services-web-api",
    maxBytes: 8 * 1024 * 1024,
    minFetchIntervalMs: 30 * 60 * 1000,
    maxStaleMs: 18 * HOUR_MS,
  }),
]);

function publicSourceCatalog() {
  const compliance = perpetualFreeReport(FREE_SOURCES);
  return {
    version: FREE_SOURCE_CATALOG_VERSION,
    policy: compliance,
    sources: FREE_SOURCES.map((entry) => ({
      id: entry.id,
      attribution: entry.attribution,
      license: entry.license,
      termsUrl: entry.termsUrl,
      defaultEnabled: true,

      access: { ...entry.access },
      cost: { ...entry.cost },
      operations: { ...entry.operations },
      usage: { ...entry.usage },
      limits: {
        maxBytes: entry.maxBytes,
        minFetchIntervalMs: entry.minFetchIntervalMs,
        maxStaleMs: entry.maxStaleMs,
      },
    })),
  };
}

module.exports = {
  DAY_MS,
  FREE_SOURCES,
  FREE_SOURCE_CATALOG_VERSION,
  HOUR_MS,
  PERPETUAL_ACCESS,
  PERPETUAL_COST,
  PERPETUAL_OPERATIONS,
  publicSourceCatalog,
};
