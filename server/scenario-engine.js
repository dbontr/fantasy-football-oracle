"use strict";

const { sha256 } = require("./lineage.js");
const {
  rankInformationNeeds,
  rankPairedActions,
  summarizeSamples,
} = require("./robust-decision.js");

const SCENARIO_ENGINE_VERSION = "oracle-scenarios-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function fnv1a(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function uniformFromParts(seed, scenario, key, channel) {
  let state = fnv1a(`${seed}|${scenario}|${key}|${channel}`) || 0x6d2b79f5;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return ((state >>> 0) + 0.5) / 4294967296;
}
function normalFromParts(seed, scenario, key, channel) {
  const first = Math.max(1e-12, uniformFromParts(seed, scenario, key, `${channel}:u1`));
  const second = uniformFromParts(seed, scenario, key, `${channel}:u2`);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function gameContext(player, schedule, week) {
  const team = String(player.team || "FA");
  const row = schedule?.[team]?.weeks?.[Math.max(0, Number(week || 1) - 1)] || null;
  const opponent = row?.opponent ? String(row.opponent) : null;
  const gameKey = opponent
    ? [team, opponent].sort().join("-")
    : `unknown-${team}-week-${week}`;
  return {
    team,
    opponent,
    gameKey,
    home: row?.home ?? null,
    indoor: row?.indoor ?? null,
    bye: row?.bye === true,
  };
}

function factorWeights(position) {
  const weights = {
    QB: { scoring: 0.28, passing: 0.35, rushing: 0.08, pace: 0.12, team: 0.12, chaos: 0 },
    RB: { scoring: 0.26, passing: 0.05, rushing: 0.38, pace: 0.1, team: 0.14, chaos: 0 },
    WR: { scoring: 0.3, passing: 0.38, rushing: 0, pace: 0.1, team: 0.12, chaos: 0 },
    TE: { scoring: 0.29, passing: 0.36, rushing: 0, pace: 0.1, team: 0.13, chaos: 0 },
    K: { scoring: 0.38, passing: 0, rushing: 0, pace: 0.15, team: 0.1, chaos: 0.08 },
    DST: { scoring: -0.35, passing: -0.08, rushing: -0.05, pace: -0.08, team: 0.15, chaos: 0.22 },
  };
  return weights[position] || weights.WR;
}
function scenarioZ(forecast, context, seed, scenario) {
  const weights = factorWeights(forecast.player.position);
  const factors = {
    scoring: normalFromParts(seed, scenario, context.gameKey, "game-scoring"),
    passing: normalFromParts(seed, scenario, context.gameKey, "game-passing"),
    rushing: normalFromParts(seed, scenario, context.gameKey, "game-rushing"),
    pace: normalFromParts(seed, scenario, context.gameKey, "game-pace"),
    chaos: normalFromParts(seed, scenario, context.gameKey, "game-chaos"),
    team: normalFromParts(seed, scenario, context.team, "team-performance"),
  };
  const shared = Object.entries(weights).reduce(
    (sum, [factor, weight]) => sum + factors[factor] * weight,
    0,
  );
  const sharedVariance = Object.values(weights).reduce(
    (sum, weight) => sum + weight ** 2,
    0,
  );
  const residualWeight = Math.sqrt(Math.max(0.05, 1 - sharedVariance));
  const residual = normalFromParts(
    seed,
    scenario,
    String(forecast.player.id),
    "player-residual",
  );
  return shared + residual * residualWeight;
}

function sampleForecast(forecast, context, seed, scenario) {
  if (context.bye || forecast.baseline?.bye) return 0;
  const activeProbability = clamp(forecast.availability?.probability, 0, 1);
  const availabilityDraw = uniformFromParts(
    seed,
    scenario,
    String(forecast.player.id),
    "availability",
  );
  if (availabilityDraw > activeProbability) return 0;
  const activeMean = Math.max(0, finite(forecast.activeDistribution?.mean));
  const activeStdDev = Math.max(0, finite(forecast.activeDistribution?.standardDeviation));
  return Math.max(0, activeMean + activeStdDev * scenarioZ(forecast, context, seed, scenario));
}
function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function correlation(left, right) {
  const count = Math.min(left?.length || 0, right?.length || 0);
  if (count < 2) return 0;
  const leftMean = average(left.slice(0, count));
  const rightMean = average(right.slice(0, count));
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < count; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? clamp(covariance / denominator, -1, 1) : 0;
}

function relationship(left, right, schedule, week) {
  if (left.player.team === right.player.team) return "same-team";
  const leftContext = gameContext(left.player, schedule, week);
  const rightContext = gameContext(right.player, schedule, week);
  if (leftContext.gameKey === rightContext.gameKey) return "opponents";
  return "unrelated";
}

function diagnosticPairs(forecasts, options = {}) {
  if (Array.isArray(options.correlationPairs) && options.correlationPairs.length) {
    return options.correlationPairs.slice(0, 50).map((pair) => [String(pair[0]), String(pair[1])]);
  }
  const pairs = [];
  for (let left = 0; left < forecasts.length && pairs.length < 18; left += 1) {
    for (let right = left + 1; right < forecasts.length && pairs.length < 18; right += 1) {
      if (forecasts[left].player.team === forecasts[right].player.team) {
        pairs.push([String(forecasts[left].player.id), String(forecasts[right].player.id)]);
      }
    }
  }
  return pairs;
}
function simulateForecasts(forecasts, options = {}) {
  if (!Array.isArray(forecasts) || !forecasts.length) {
    throw new TypeError("Scenario simulation requires forecasts");
  }
  if (forecasts.length > 128) throw new RangeError("Scenario simulation supports at most 128 players");
  const scenarios = Math.min(50_000, Math.max(100, Number(options.scenarios || 5_000)));
  const seed = String(options.seed ?? 2026);
  const week = Math.max(1, Math.min(18, Number(options.week || forecasts[0].week || 1)));
  const schedule = options.schedule || {};
  const playerSamples = Object.fromEntries(forecasts.map((forecast) => [
    String(forecast.player.id),
    Array(scenarios),
  ]));
  const contexts = Object.fromEntries(forecasts.map((forecast) => [
    String(forecast.player.id),
    gameContext(forecast.player, schedule, week),
  ]));

  for (let scenario = 0; scenario < scenarios; scenario += 1) {
    for (const forecast of forecasts) {
      const id = String(forecast.player.id);
      playerSamples[id][scenario] = sampleForecast(
        forecast,
        contexts[id],
        seed,
        scenario,
      );
    }
  }

  const playerSummaries = Object.fromEntries(forecasts.map((forecast) => {
    const id = String(forecast.player.id);
    return [id, {
      player: forecast.player,
      ...summarizeSamples(playerSamples[id], {
        target: options.playerTargets?.[id] ?? forecast.baseline?.mean,
      }),
    }];
  }));
  const byId = new Map(forecasts.map((forecast) => [String(forecast.player.id), forecast]));
  const correlations = diagnosticPairs(forecasts, options).map(([leftId, rightId]) => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (!left || !right) return null;
    return {
      leftId,
      rightId,
      relationship: relationship(left, right, schedule, week),
      correlation: correlation(playerSamples[leftId], playerSamples[rightId]),
    };
  }).filter(Boolean);
  const digest = sha256({
    version: SCENARIO_ENGINE_VERSION,
    seed,
    scenarios,
    week,
    players: Object.fromEntries(Object.entries(playerSummaries).map(([id, summary]) => [
      id,
      {
        mean: summary.mean,
        p10: summary.p10,
        p90: summary.p90,
      },
    ])),
  });
  return {
    version: SCENARIO_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    seed,
    scenarios,
    week,
    digest,
    playerSamples,
    playerSummaries,
    correlations,
  };
}
function normalizePortfolio(portfolio, index, availableIds) {
  const playerIds = [...new Set((portfolio.playerIds || []).map(String))];
  if (!playerIds.length) {
    throw new TypeError(`Portfolio ${index + 1} requires playerIds`);
  }
  if (playerIds.length > 32) {
    throw new RangeError(`Portfolio ${index + 1} exceeds 32 players`);
  }
  const missing = playerIds.filter((id) => !availableIds.has(id));
  if (missing.length) {
    throw Object.assign(new Error(`Unknown portfolio players: ${missing.join(", ")}`), {
      code: "PORTFOLIO_PLAYER_UNKNOWN",
      details: missing,
    });
  }
  const weights = Object.fromEntries(playerIds.map((id) => [
    id,
    Math.max(0, finite(portfolio.weights?.[id], 1)),
  ]));
  if (Object.values(weights).every((weight) => weight === 0)) {
    throw new RangeError(`Portfolio ${index + 1} cannot have only zero weights`);
  }
  return {
    id: String(portfolio.id || `portfolio-${index + 1}`),
    label: String(portfolio.label || portfolio.id || `Portfolio ${index + 1}`),
    playerIds,
    weights,
    metadata: portfolio.metadata || {},
  };
}

function portfolioConcentration(portfolio) {
  const total = Object.values(portfolio.weights).reduce((sum, value) => sum + value, 0);
  return total > 0
    ? Object.values(portfolio.weights).reduce((sum, value) => sum + (value / total) ** 2, 0)
    : 0;
}
function evaluatePortfolios(forecasts, portfolios, options = {}) {
  if (!Array.isArray(portfolios) || !portfolios.length) {
    throw new TypeError("Portfolio evaluation requires at least one portfolio");
  }
  if (portfolios.length > 32) throw new RangeError("At most 32 portfolios can be evaluated");
  const availableIds = new Set(forecasts.map((forecast) => String(forecast.player.id)));
  const normalized = portfolios.map((portfolio, index) => (
    normalizePortfolio(portfolio, index, availableIds)
  ));
  if (new Set(normalized.map((portfolio) => portfolio.id)).size !== normalized.length) {
    throw new RangeError("Portfolio ids must be unique");
  }
  const usedIds = new Set(normalized.flatMap((portfolio) => portfolio.playerIds));
  const usedForecasts = forecasts.filter((forecast) => usedIds.has(String(forecast.player.id)));
  const simulation = simulateForecasts(usedForecasts, options);
  const actions = normalized.map((portfolio) => {
    const samples = Array(simulation.scenarios).fill(0);
    for (const playerId of portfolio.playerIds) {
      const weight = portfolio.weights[playerId];
      const playerSamples = simulation.playerSamples[playerId];
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] += playerSamples[index] * weight;
      }
    }
    return {
      id: portfolio.id,
      label: portfolio.label,
      samples,
      metadata: {
        ...portfolio.metadata,
        playerIds: portfolio.playerIds,
        weights: portfolio.weights,
        concentration: portfolioConcentration(portfolio),
      },
    };
  });
  const decision = rankPairedActions(actions, {
    riskAversion: options.riskAversion,
    regretPenalty: options.regretPenalty,
    bestProbabilityBonus: options.bestProbabilityBonus,
    target: options.target,
    riskLevels: options.riskLevels,
  });
  return {
    version: SCENARIO_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    simulation: {
      seed: simulation.seed,
      scenarios: simulation.scenarios,
      week: simulation.week,
      digest: simulation.digest,
      correlations: simulation.correlations,
    },
    decision,
    playerSummaries: simulation.playerSummaries,
    informationNeeds: rankInformationNeeds(usedForecasts, { limit: options.informationLimit }),
    ...(options.includeSamples ? {
      samples: {
        players: simulation.playerSamples,
        portfolios: Object.fromEntries(actions.map((action) => [action.id, action.samples])),
      },
    } : {}),
  };
}

module.exports = {
  SCENARIO_ENGINE_VERSION,
  correlation,
  diagnosticPairs,
  evaluatePortfolios,
  factorWeights,
  fnv1a,
  gameContext,
  normalFromParts,
  normalizePortfolio,
  portfolioConcentration,
  sampleForecast,
  scenarioZ,
  simulateForecasts,
  uniformFromParts,
};
