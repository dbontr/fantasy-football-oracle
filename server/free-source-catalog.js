"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FREE_SOURCE_CATALOG_VERSION = "oracle-free-sources-2026.1";

const FREE_SOURCES = Object.freeze([
  Object.freeze({
    id: "sleeper",
    origins: ["https://api.sleeper.app"],
    pathPrefixes: ["/v1/"],
    attribution: "Sleeper",
    license: "Sleeper public read-only API; attribution required for trending data",
    termsUrl: "https://docs.sleeper.com/",
    maxBytes: 32 * 1024 * 1024,
    minFetchIntervalMs: 15 * 60 * 1000,
    maxStaleMs: 7 * DAY_MS,
  }),
  Object.freeze({
    id: "nflverse",
    origins: ["https://github.com"],
    redirectOrigins: [
      "https://release-assets.githubusercontent.com",
      "https://objects.githubusercontent.com",
    ],
    pathPrefixes: ["/nflverse/nflverse-data/releases/download/"],
    attribution: "nflverse",
    license: "CC-BY-4.0",
    termsUrl: "https://github.com/nflverse/nflverse-data",
    maxBytes: 150 * 1024 * 1024,
    minFetchIntervalMs: 6 * HOUR_MS,
    maxStaleMs: 45 * DAY_MS,
  }),
  Object.freeze({
    id: "open-meteo",
    origins: ["https://api.open-meteo.com"],
    pathPrefixes: ["/v1/"],
    attribution: "Weather data by Open-Meteo.com",
    license: "CC-BY-4.0 data; free hosted API restricted to non-commercial use",
    termsUrl: "https://open-meteo.com/en/terms",
    maxBytes: 8 * 1024 * 1024,
    minFetchIntervalMs: 30 * 60 * 1000,
    maxStaleMs: 36 * HOUR_MS,
  }),
]);

function publicSourceCatalog() {
  return {
    version: FREE_SOURCE_CATALOG_VERSION,
    sources: FREE_SOURCES.map((source) => ({
      id: source.id,
      attribution: source.attribution,
      license: source.license,
      termsUrl: source.termsUrl,
      defaultEnabled: false,
      limits: {
        maxBytes: source.maxBytes,
        minFetchIntervalMs: source.minFetchIntervalMs,
        maxStaleMs: source.maxStaleMs,
      },
    })),
  };
}

module.exports = {
  DAY_MS,
  FREE_SOURCES,
  FREE_SOURCE_CATALOG_VERSION,
  HOUR_MS,
  publicSourceCatalog,
};
