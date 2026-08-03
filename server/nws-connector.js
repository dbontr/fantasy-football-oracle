"use strict";

const { gamesForWeek } = require("./game-identity.js");
const { DAY_MS, HOUR_MS } = require("./free-source-catalog.js");
const { TEAM_VENUES } = require("./team-venues.js");

const NWS_CONNECTOR_VERSION = "oracle-nws-connector-2026.1";
const NWS_ORIGIN = "https://api.weather.gov";
const DEFAULT_USER_AGENT = "FantasyFootballOracle/5.2 (https://github.com/dbontr/fantasy-football-oracle)";

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pointUrl(venue) {
  return `${NWS_ORIGIN}/points/${venue.latitude.toFixed(4)},${venue.longitude.toFixed(4)}`;
}

function parseWindMph(value) {
  const numbers = String(value || "").match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  return numbers.length ? Math.max(...numbers) : null;
}

function temperatureF(value, unit) {
  const number = finite(value);
  if (number === null) return null;
  return String(unit || "F").toUpperCase() === "C" ? number * 9 / 5 + 32 : number;
}

function hourlyForecastUrl(point = {}) {
  const value = point?.properties?.forecastHourly;
  if (!value) return null;
  const url = new URL(value);
  if (url.origin !== NWS_ORIGIN || !url.pathname.startsWith("/gridpoints/")) return null;
  return url.href;
}

function periodDistance(period, target) {
  const start = Date.parse(period?.startTime);
  const end = Date.parse(period?.endTime);
  if (!Number.isFinite(start)) return Number.POSITIVE_INFINITY;
  if (Number.isFinite(end) && target >= start && target < end) return 0;
  return Math.abs(start - target);
}

function nearestHourlyPeriod(data, kickoff) {
  const periods = Array.isArray(data?.properties?.periods) ? data.properties.periods : [];
  const target = Date.parse(kickoff);
  if (!Number.isFinite(target) || !periods.length) return null;
  const candidates = periods
    .map((period) => ({ period, distanceMs: periodDistance(period, target) }))
    .filter((row) => Number.isFinite(row.distanceMs))
    .sort((left, right) => left.distanceMs - right.distanceMs);
  if (!candidates.length || candidates[0].distanceMs > 3 * HOUR_MS) return null;
  const { period, distanceMs } = candidates[0];
  return {
    startTime: new Date(Date.parse(period.startTime)).toISOString(),
    endTime: Number.isFinite(Date.parse(period.endTime))
      ? new Date(Date.parse(period.endTime)).toISOString() : null,
    temperatureF: temperatureF(period.temperature, period.temperatureUnit),
    precipitationProbability: finite(period.probabilityOfPrecipitation?.value),
    windMph: parseWindMph(period.windSpeed),
    shortForecast: String(period.shortForecast || ""),
    distanceMs,
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
    name: "NOAA National Weather Service forecast",
    recordId: `${game.homeTeam}:${weather.startTime}`,
    reliability: 0.88,
  };

  const metadata = {
    venue: venue.name,
    homeTeam: game.homeTeam,
    kickoff: game.kickoff,
    forecastStart: weather.startTime,
    forecastEnd: weather.endTime,
    shortForecast: weather.shortForecast,
    distanceMs: weather.distanceMs,
    attribution: "NOAA National Weather Service",
    derived: false,
  };
  const observations = [venueObservation(game, venue, now)];
  if (weather.temperatureF !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.temperature_f",
    value: weather.temperatureF, source, confidence: 0.84, observedAt, expiresAt, metadata,
  });
  if (weather.windMph !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.wind_mph",
    value: weather.windMph, source, confidence: 0.84, observedAt, expiresAt, metadata,
  });
  if (weather.precipitationProbability !== null) observations.push({
    entityType: "game", entityId: game.id, feature: "environment.precip_probability",
    value: weather.precipitationProbability / 100, source, confidence: 0.8,
    observedAt, expiresAt, metadata,
  });
  return observations;
}

class NwsConnector {
  constructor(options = {}) {
    if (!options.cache) throw new TypeError("NwsConnector requires a free source cache");
    if (typeof options.datasetProvider !== "function") {
      throw new TypeError("NwsConnector requires datasetProvider");
    }
    this.cache = options.cache;
    this.datasetProvider = options.datasetProvider;
    this.clock = options.clock || Date.now;
    this.userAgent = String(options.userAgent || DEFAULT_USER_AGENT).trim();
    this.maximumFutureMs = Math.max(
      24 * HOUR_MS,
      Number(options.maximumFutureMs || 8 * DAY_MS),
    );
  }

  async forecastForGame(game, venue, options = {}) {
    const point = await this.cache.fetchJson("nws", pointUrl(venue), {
      maximumAgeMs: options.force ? 0 : 30 * DAY_MS,
      force: options.force === true,
      userAgent: this.userAgent,
      accept: "application/geo+json",
    });
    const forecastUrl = hourlyForecastUrl(point.data);
    if (!forecastUrl) {
      throw Object.assign(new Error("NWS point metadata did not include a valid hourly forecast URL"), {
        code: "NWS_FORECAST_URL_MISSING",
      });
    }
    const forecast = await this.cache.fetchJson("nws", forecastUrl, {
      maximumAgeMs: options.force ? 0 : 30 * 60 * 1000,
      force: options.force === true,
      userAgent: this.userAgent,
      accept: "application/geo+json",
    });
    return {
      weather: nearestHourlyPeriod(forecast.data, game.kickoff),
      stale: point.stale || forecast.stale,
      networkRequests: Number(!point.fromCache) + Number(!forecast.fromCache),
      sourceMetadata: { point: point.metadata, forecast: forecast.metadata },
    };
  }

  async sync(options = {}) {
    const week = Number(options.week || options.currentWeek);
    if (!Number.isInteger(week) || week < 1 || week > 22) {
      throw new RangeError("NWS sync requires a valid week");
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
        results.push({ gameId: game.id, status: "skipped", reason: "outside-forecast-horizon" });
        continue;
      }

      let result;
      try {
        result = await this.forecastForGame(game, venue, options);
      } catch (error) {
        results.push({
          gameId: game.id,
          status: "unavailable",
          reason: error.code || error.name || "nws-request-failed",
          message: String(error.message || error),
        });
        continue;
      }
      networkRequests += result.networkRequests;
      if (!result.weather) {
        results.push({ gameId: game.id, status: "skipped", reason: "hourly-data-missing" });
        continue;
      }
      const rows = weatherObservations(game, venue, result.weather, now);
      observations.push(...rows.filter((row) => row.feature !== "environment.indoor"));
      results.push({
        gameId: game.id,
        status: "weather",
        venue: venue.name,
        kickoff: game.kickoff,
        weather: result.weather,
        stale: result.stale,
        observations: rows.length,
      });
    }

    return {
      version: NWS_CONNECTOR_VERSION,
      syncedAt: new Date(now).toISOString(),
      week,
      games: results,
      observations,
      networkRequests,
      stale: results.some((row) => row.stale === true),
      attribution: {
        name: "NOAA National Weather Service",
        text: "Weather data from the U.S. National Weather Service",
        license: "United States Government open data; free for any purpose",
        url: "https://www.weather.gov/documentation/services-web-api",
      },
    };
  }
}

module.exports = {
  DEFAULT_USER_AGENT,
  NWS_CONNECTOR_VERSION,
  NWS_ORIGIN,
  NwsConnector,
  hourlyForecastUrl,
  nearestHourlyPeriod,
  parseWindMph,
  pointUrl,
  temperatureF,
  venueObservation,
  weatherObservations,
};
