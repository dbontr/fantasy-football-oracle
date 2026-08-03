"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { gamesForWeek, oracleGameId, scheduledGame } = require("../server/game-identity.js");
const {
  NwsConnector,
  hourlyForecastUrl,
  nearestHourlyPeriod,
  parseWindMph,
  pointUrl,
} = require("../server/nws-connector.js");

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const dataset = {
  meta: { season: 2026 },
  schedule: {
    DET: { weeks: [{ opponent: "NO", home: true, date: Date.parse("2026-09-13T17:00:00Z") }] },
    NO: { weeks: [{ opponent: "DET", home: false, date: Date.parse("2026-09-13T17:00:00Z") }] },
    GB: { weeks: [{ opponent: "CHI", home: true, date: Date.parse("2026-09-13T20:25:00Z") }] },
    CHI: { weeks: [{ opponent: "GB", home: false, date: Date.parse("2026-09-13T20:25:00Z") }] },
  },
};

test("game identity is stable and deduplicates team schedule views", () => {
  assert.equal(oracleGameId(2026, 1, "DET", "NO"), "2026:W1:DET-NO");
  assert.equal(oracleGameId(2026, 1, "NO", "DET"), "2026:W1:DET-NO");
  assert.equal(scheduledGame(dataset, "DET", 1).homeTeam, "DET");
  assert.equal(scheduledGame(dataset, "NO", 1).homeTeam, "DET");
  assert.equal(gamesForWeek(dataset, 1).length, 2);
});

test("NWS point and hourly URL validation remain on api.weather.gov", () => {
  const url = pointUrl({ latitude: 44.5013, longitude: -88.0622 });
  assert.equal(url, "https://api.weather.gov/points/44.5013,-88.0622");
  assert.equal(hourlyForecastUrl({ properties: {
    forecastHourly: "https://api.weather.gov/gridpoints/GRB/50,70/forecast/hourly",
  } }), "https://api.weather.gov/gridpoints/GRB/50,70/forecast/hourly");
  assert.equal(hourlyForecastUrl({ properties: {
    forecastHourly: "https://example.com/gridpoints/GRB/50,70/forecast/hourly",
  } }), null);
});

test("NWS hourly selection uses the kickoff period and parses wind ranges", () => {
  const data = { properties: { periods: [
    { startTime: "2026-09-13T19:00:00Z", endTime: "2026-09-13T20:00:00Z",
      temperature: 68, temperatureUnit: "F", windSpeed: "5 mph" },
    { startTime: "2026-09-13T20:00:00Z", endTime: "2026-09-13T21:00:00Z",
      temperature: 70, temperatureUnit: "F", windSpeed: "8 to 12 mph",
      probabilityOfPrecipitation: { value: 30 }, shortForecast: "Chance Showers" },
  ] } };

  const weather = nearestHourlyPeriod(data, "2026-09-13T20:25:00.000Z");
  assert.equal(weather.startTime, "2026-09-13T20:00:00.000Z");
  assert.equal(weather.temperatureF, 70);
  assert.equal(weather.precipitationProbability, 30);
  assert.equal(weather.windMph, 12);
  assert.equal(parseWindMph("Calm"), null);
  assert.equal(parseWindMph("15 to 25 mph"), 25);
});

test("NWS skips roofed games and emits bounded outdoor evidence", async () => {
  const calls = [];
  const connector = new NwsConnector({
    cache: {
      async fetchJson(source, url, options) {
        calls.push({ source, url, options });
        if (url.includes("/points/")) {
          return { fromCache: false, stale: false, metadata: {}, data: { properties: {
            forecastHourly: "https://api.weather.gov/gridpoints/GRB/50,70/forecast/hourly",
          } } };
        }
        return { fromCache: false, stale: false, metadata: {}, data: { properties: { periods: [
          { startTime: "2026-09-13T20:00:00Z", endTime: "2026-09-13T21:00:00Z",
            temperature: 70, temperatureUnit: "F", windSpeed: "8 to 12 mph",
            probabilityOfPrecipitation: { value: 30 }, shortForecast: "Chance Showers" },
        ] } } };
      },
    },
    datasetProvider: () => dataset,
    userAgent: "Oracle-Test/1.0",
    clock: () => NOW,
  });

  const result = await connector.sync({ week: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.source === "nws"), true);
  assert.equal(calls.every((call) => call.options.userAgent === "Oracle-Test/1.0"), true);
  assert.equal(result.games.find((row) => row.gameId === "2026:W1:DET-NO").status, "indoor");
  assert.equal(result.games.find((row) => row.gameId === "2026:W1:CHI-GB").status, "weather");
  assert.equal(result.networkRequests, 2);
  assert.equal(result.stale, false);

  const indoor = result.observations.filter((row) => row.entityId === "2026:W1:DET-NO");
  assert.equal(indoor.length, 1);
  assert.equal(indoor[0].feature, "environment.indoor");
  assert.equal(indoor[0].value, true);

  const outdoor = result.observations.filter((row) => row.entityId === "2026:W1:CHI-GB");
  assert.deepEqual(new Set(outdoor.map((row) => row.feature)), new Set([
    "environment.indoor",
    "environment.temperature_f",
    "environment.wind_mph",
    "environment.precip_probability",
  ]));
  assert.equal(outdoor.find((row) => row.feature === "environment.wind_mph").value, 12);
  assert.equal(outdoor.find((row) => row.feature === "environment.precip_probability").value, 0.3);
  assert.equal(outdoor.every((row) => row.expiresAt > row.observedAt), true);
});

test("NWS isolates an unavailable outdoor forecast by game", async () => {
  const connector = new NwsConnector({
    cache: {
      async fetchJson() {
        throw Object.assign(new Error("outside NWS coverage"), { code: "NWS_UNAVAILABLE" });
      },
    },
    datasetProvider: () => dataset,
    clock: () => NOW,
  });
  const result = await connector.sync({ week: 1 });
  assert.equal(result.games.find((row) => row.gameId === "2026:W1:DET-NO").status, "indoor");
  const outdoor = result.games.find((row) => row.gameId === "2026:W1:CHI-GB");
  assert.equal(outdoor.status, "unavailable");
  assert.equal(outdoor.reason, "NWS_UNAVAILABLE");
  assert.equal(result.observations.some((row) => row.entityId === "2026:W1:CHI-GB"
    && row.feature === "environment.indoor"), true);
});
