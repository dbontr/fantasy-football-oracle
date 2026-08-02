"use strict";

const { gamesForWeek } = require("./game-identity.js");
const { HOUR_MS } = require("./free-source-catalog.js");
const { TEAM_VENUES } = require("./team-venues.js");

const OPEN_METEO_CONNECTOR_VERSION = "oracle-open-meteo-connector-2026.1";
const BASE_URL = "https://api.open-meteo.com/v1/forecast";

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function utcMilliseconds(value) {
  const text = String(value || "");
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  return Date.parse(normalized);
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function forecastUrl(venue, kickoff) {
  const date = isoDate(kickoff);
  const url = new URL(BASE_URL);
  url.searchParams.set("latitude", String(venue.latitude));
  url.searchParams.set("longitude", String(venue.longitude));
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,wind_speed_10m");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  return url.href;
}

function nearestHourly(data, kickoff) {
  const times = Array.isArray(data?.hourly?.time) ? data.hourly.time : [];
  if (!times.length) return null;
  const target = Date.parse(kickoff);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  times.forEach((value, index) => {
    const milliseconds = utcMilliseconds(value);
    const distance = Math.abs(milliseconds - target);
    if (Number.isFinite(milliseconds) && distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  if (bestIndex < 0 || bestDistance > 3 * HOUR_MS) return null;
  return {
    time: new Date(utcMilliseconds(times[bestIndex])).toISOString(),
    temperatureF: finite(data.hourly.temperature_2m?.[bestIndex]),
    precipitationProbability: finite(data.hourly.precipitation_probability?.[bestIndex]),
    windMph: finite(data.hourly.wind_speed_10m?.[bestIndex]),
    distanceMs: bestDistance,
  };
}

function venueObservation(game, venue, now) {
  return {
    entityType: "game",
    entityId: game.id,
    feature: "environment.indoor",
    value: venue.indoor === true,
    source: {
      name: "Oracle team venue map",
      recordId: game.homeTeam,
      reliability: 0.96,
    },
    confidence: 0.98,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(Date.parse(game.kickoff) + 12 * HOUR_MS).toISOString(),
    metadata: {
      venue: venue.name,
      homeTeam: game.homeTeam,
      kickoff: game.kickoff,
      derived: false,
    },
  };
}

function weatherObservations(game, venue, weather, now) {
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(Date.parse(game.kickoff) + 4 * HOUR_MS).toISOString();
  const source = {
    name: "Open-Meteo forecast API",
    recordId: `${venue.latitude},${venue.longitude}:${weather.time}`,
    reliability: 0.82,
  };
  const metadata = {
    venue: venue.name,
    homeTeam: game.homeTeam,
    kickoff: game.kickoff,
    forecastHour: weather.time,
    distanceMs: weather.distanceMs,
    attribution: "Weather data by Open-Meteo.com",
    derived: false,
  };
  const observations = [venueObservation(game, venue, now)];
  if (weather.temperatureF !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.temperature_f",
    value: weather.temperatureF, source, confidence: 0.78, observedAt, expiresAt, metadata,
  });
  if (weather.windMph !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.wind_mph",
    value: weather.windMph, source, confidence: 0.78, observedAt, expiresAt, metadata,
  });
  if (weather.precipitationProbability !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.precip_probability",
    value: weather.precipitationProbability / 100, source, confidence: 0.72,
    observedAt, expiresAt, metadata,
  });
  return observations;
}

class OpenMeteoConnector {
  constructor(options = {}) {
    if (!options.cache) throw new TypeError("OpenMeteoConnector requires a free source cache");
    if (typeof options.datasetProvider !== "function") {
      throw new TypeError("OpenMeteoConnector requires datasetProvider");
    }
    this.cache = options.cache;
    this.datasetProvider = options.datasetProvider;
    this.clock = options.clock || Date.now;
    this.nonCommercialAcknowledged = options.nonCommercialAcknowledged === true;
    this.maximumFutureMs = Math.max(
      24 * HOUR_MS,
      Number(options.maximumFutureMs || 16 * 24 * HOUR_MS),
    );
  }

  async sync(options = {}) {
    if (!this.nonCommercialAcknowledged) {
      throw Object.assign(new Error(
        "Open-Meteo hosted free API use requires ORACLE_OPEN_METEO_NONCOMMERCIAL_ACK=true",
      ), { code: "OPEN_METEO_TERMS_ACK_REQUIRED" });
    }
    const week = Number(options.week || options.currentWeek);
    if (!Number.isInteger(week) || week < 1 || week > 22) {
      throw new RangeError("Open-Meteo sync requires a valid week");
    }
    const dataset = this.datasetProvider();
    const now = Number(this.clock());
    const maximumGames = Math.min(20, Math.max(1, Number(options.maximumGames || 16)));
    const games = gamesForWeek(dataset, week);
    const observations = [];
    const results = [];
    let networkRequests = 0;

    for (const game of games.slice(0, maximumGames)) {
      const venue = TEAM_VENUES[game.homeTeam];
      if (!venue) {
        results.push({ gameId: game.id, status: "skipped", reason: "unknown-venue" });
        continue;
      }
      if (!game.kickoff) {
        results.push({ gameId: game.id, status: "skipped", reason: "unknown-kickoff" });
        continue;
      }
      observations.push(venueObservation(game, venue, now));
      if (venue.indoor) {
        results.push({ gameId: game.id, status: "indoor", venue: venue.name, observations: 1 });
        continue;
      }
      const untilKickoff = Date.parse(game.kickoff) - now;
      if (untilKickoff < -6 * HOUR_MS || untilKickoff > this.maximumFutureMs) {
        results.push({
          gameId: game.id,
          status: "skipped",
          reason: "outside-forecast-horizon",
          kickoff: game.kickoff,
        });
        continue;
      }
      const response = await this.cache.fetchJson(
        "open-meteo",
        forecastUrl(venue, game.kickoff),
        {
          maximumAgeMs: options.force ? 0 : 60 * 60 * 1000,
          force: options.force === true,
        },
      );
      networkRequests += Number(!response.fromCache);
      const weather = nearestHourly(response.data, game.kickoff);
      if (!weather) {
        results.push({ gameId: game.id, status: "skipped", reason: "hourly-data-missing" });
        continue;
      }
      const rows = weatherObservations(game, venue, weather, now);
      observations.push(...rows.filter((row) => row.feature !== "environment.indoor"));
      results.push({
        gameId: game.id,
        status: "weather",
        venue: venue.name,
        kickoff: game.kickoff,
        weather,
        stale: response.stale,
        observations: rows.length,
      });
    }

    return {
      version: OPEN_METEO_CONNECTOR_VERSION,
      syncedAt: new Date(now).toISOString(),
      week,
      games: results,
      observations,
      networkRequests,
      stale: results.some((row) => row.stale === true),
      attribution: {
        name: "Open-Meteo",
        text: "Weather data by Open-Meteo.com",
        license: "CC-BY-4.0 data; hosted free API acknowledged as non-commercial use",
        url: "https://open-meteo.com/",
      },
    };
  }
}

module.exports = {
  BASE_URL,
  OPEN_METEO_CONNECTOR_VERSION,
  OpenMeteoConnector,
  forecastUrl,
  nearestHourly,
  utcMilliseconds,
  venueObservation,
  weatherObservations,
};
