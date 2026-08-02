"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { gamesForWeek, oracleGameId, scheduledGame } = require("../server/game-identity.js");
const {
  OpenMeteoConnector,
  forecastUrl,
  nearestHourly,
} = require("../server/open-meteo-connector.js");

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const dataset = {
  meta: { season: 2026 },
  schedule: {
    DET: { weeks: [{ opponent: "NO", home: true, date: Date.parse("2026-09-13T17:00:00Z"), indoor: false }] },
    NO: { weeks: [{ opponent: "DET", home: false, date: Date.parse("2026-09-13T17:00:00Z"), indoor: false }] },
    GB: { weeks: [{ opponent: "CHI", home: true, date: Date.parse("2026-09-13T20:25:00Z"), indoor: false }] },
    CHI: { weeks: [{ opponent: "GB", home: false, date: Date.parse("2026-09-13T20:25:00Z"), indoor: false }] },
  },
};

test("game identity is stable and deduplicates team schedule views", () => {
  assert.equal(oracleGameId(2026, 1, "DET", "NO"), "2026:W1:DET-NO");
  assert.equal(oracleGameId(2026, 1, "NO", "DET"), "2026:W1:DET-NO");
  assert.equal(scheduledGame(dataset, "DET", 1).homeTeam, "DET");
  assert.equal(scheduledGame(dataset, "NO", 1).homeTeam, "DET");
  assert.equal(gamesForWeek(dataset, 1).length, 2);
});

test("Open-Meteo hourly selection uses the closest UTC forecast", () => {
  const data = {
    hourly: {
      time: ["2026-09-13T19:00", "2026-09-13T20:00", "2026-09-13T21:00"],
      temperature_2m: [68, 70, 69],
      precipitation_probability: [10, 30, 60],
      wind_speed_10m: [5, 8, 12],
    },
  };
  const weather = nearestHourly(data, "2026-09-13T20:25:00.000Z");
  assert.equal(weather.time, "2026-09-13T20:00:00.000Z");
  assert.equal(weather.temperatureF, 70);
  assert.equal(weather.precipitationProbability, 30);
  assert.equal(weather.windMph, 8);
  const url = new URL(forecastUrl({ latitude: 44.5, longitude: -88.06 }, "2026-09-13T20:25:00Z"));
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("timezone"), "UTC");
  assert.equal(url.searchParams.get("start_date"), "2026-09-13");
});

test("Open-Meteo requires explicit non-commercial acknowledgement", async () => {
  const connector = new OpenMeteoConnector({
    cache: { fetchJson() { throw new Error("network should not be called"); } },
    datasetProvider: () => dataset,
    clock: () => NOW,
  });
  await assert.rejects(
    () => connector.sync({ week: 1 }),
    { code: "OPEN_METEO_TERMS_ACK_REQUIRED" },
  );
});

test("Open-Meteo skips roofed games and emits bounded outdoor evidence", async () => {
  const calls = [];
  const connector = new OpenMeteoConnector({
    cache: {
      async fetchJson(source, url) {
        calls.push({ source, url });
        return {
          fromCache: false,
          stale: false,
          data: {
            hourly: {
              time: ["2026-09-13T20:00", "2026-09-13T21:00"],
              temperature_2m: [70, 69],
              precipitation_probability: [30, 50],
              wind_speed_10m: [8, 11],
            },
          },
        };
      },
    },
    datasetProvider: () => dataset,
    nonCommercialAcknowledged: true,
    clock: () => NOW,
  });
  const result = await connector.sync({ week: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "open-meteo");
  assert.equal(result.games.find((row) => row.gameId === "2026:W1:DET-NO").status, "indoor");
  assert.equal(result.games.find((row) => row.gameId === "2026:W1:CHI-GB").status, "weather");
  assert.equal(result.networkRequests, 1);
  assert.equal(result.stale, false);

  const indoor = result.observations.filter((row) => row.entityId === "2026:W1:DET-NO");
  assert.equal(indoor.length, 1);
  assert.equal(indoor[0].feature, "environment.indoor");
  assert.equal(indoor[0].value, true);

  const outdoor = result.observations.filter((row) => row.entityId === "2026:W1:CHI-GB");
  assert.deepEqual(
    new Set(outdoor.map((row) => row.feature)),
    new Set([
      "environment.indoor",
      "environment.temperature_f",
      "environment.wind_mph",
      "environment.precip_probability",
    ]),
  );
  assert.equal(outdoor.find((row) => row.feature === "environment.precip_probability").value, 0.3);
  assert.equal(outdoor.every((row) => row.expiresAt > row.observedAt), true);
});
