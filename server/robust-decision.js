"use strict";

const ROBUST_DECISION_VERSION = "oracle-robust-decision-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average = mean(values)) {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / values.length);
}

function quantileSorted(sorted, probability) {
  if (!sorted.length) return 0;
  const index = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeSamples(samples, options = {}) {
  if (!Array.isArray(samples) || !samples.length) {
    throw new TypeError("Sample summary requires a non-empty array");
  }
  const values = samples.map((value) => finite(value)).sort((left, right) => left - right);
  const average = mean(values);
  const tailCount = Math.max(1, Math.ceil(values.length * 0.1));
  const target = finite(options.target, average);
  return {
    samples: values.length,
    mean: average,
    standardDeviation: standardDeviation(values, average),
    p10: quantileSorted(values, 0.1),
    p25: quantileSorted(values, 0.25),
    p50: quantileSorted(values, 0.5),
    p75: quantileSorted(values, 0.75),
    p90: quantileSorted(values, 0.9),
    cvar10: mean(values.slice(0, tailCount)),
    downsideProbability: values.filter((value) => value < target).length / values.length,
    targetProbability: values.filter((value) => value >= target).length / values.length,
  };
}

function pairedRegrets(actions, sampleCount) {
  const regrets = actions.map(() => Array(sampleCount).fill(0));
  const bestCredits = actions.map(() => 0);
  for (let index = 0; index < sampleCount; index += 1) {
    const values = actions.map((action) => finite(action.samples[index]));
    const best = Math.max(...values);
    const winners = values
      .map((value, actionIndex) => ({ value, actionIndex }))
      .filter((row) => Math.abs(row.value - best) <= 1e-9);
    const credit = 1 / winners.length;
    winners.forEach((row) => { bestCredits[row.actionIndex] += credit; });
    values.forEach((value, actionIndex) => {
      regrets[actionIndex][index] = best - value;
    });
  }
  return {
    regrets,
    probabilityBest: bestCredits.map((count) => count / sampleCount),
  };
}

function robustScore(summary, regret, probabilityBest, options = {}) {
  const riskAversion = clamp(options.riskAversion ?? 0.35, 0, 1);
  const regretPenalty = Math.max(0, finite(options.regretPenalty, 0.15));
  const bestBonus = Math.max(0, finite(options.bestProbabilityBonus, 0.05));
  const scale = Math.max(1, Math.abs(summary.mean));
  return (
    summary.mean * (1 - riskAversion)
    + summary.cvar10 * riskAversion
    - regret.expected * regretPenalty
    + probabilityBest * scale * bestBonus
  );
}

function paretoFrontier(rows) {
  return rows.filter((candidate) => !rows.some((other) => {
    if (candidate.id === other.id) return false;
    const noWorse = other.summary.mean >= candidate.summary.mean
      && other.summary.cvar10 >= candidate.summary.cvar10
      && other.probabilityBest >= candidate.probabilityBest
      && other.regret.expected <= candidate.regret.expected;
    const strictlyBetter = other.summary.mean > candidate.summary.mean
      || other.summary.cvar10 > candidate.summary.cvar10
      || other.probabilityBest > candidate.probabilityBest
      || other.regret.expected < candidate.regret.expected;
    return noWorse && strictlyBetter;
  })).map((row) => row.id);
}
function rankPairedActions(actions, options = {}) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new TypeError("Robust ranking requires at least one action");
  }
  const normalized = actions.map((action, index) => {
    if (!Array.isArray(action.samples) || !action.samples.length) {
      throw new TypeError(`Action ${index + 1} requires outcome samples`);
    }
    return {
      id: String(action.id || `action-${index + 1}`),
      label: String(action.label || action.id || `Action ${index + 1}`),
      samples: action.samples.map((value) => finite(value)),
      metadata: action.metadata || {},
    };
  });
  const sampleCount = normalized[0].samples.length;
  if (normalized.some((action) => action.samples.length !== sampleCount)) {
    throw new RangeError("Paired action samples must have equal lengths");
  }
  if (new Set(normalized.map((action) => action.id)).size !== normalized.length) {
    throw new RangeError("Robust action ids must be unique");
  }

  const paired = pairedRegrets(normalized, sampleCount);
  const rows = normalized.map((action, index) => {
    const summary = summarizeSamples(action.samples, { target: options.target });
    const sortedRegret = [...paired.regrets[index]].sort((left, right) => left - right);
    const regret = {
      expected: mean(sortedRegret),
      p90: quantileSorted(sortedRegret, 0.9),
      maximum: sortedRegret.at(-1) || 0,
      probability: sortedRegret.filter((value) => value > 1e-9).length / sampleCount,
    };
    return {
      ...action,
      summary,
      probabilityBest: paired.probabilityBest[index],
      regret,
      robustScore: robustScore(summary, regret, paired.probabilityBest[index], options),
    };
  });
  rows.sort((left, right) => (
    right.robustScore - left.robustScore
    || right.probabilityBest - left.probabilityBest
    || right.summary.mean - left.summary.mean
    || right.summary.cvar10 - left.summary.cvar10
  ));
  const preferred = rows[0];
  const frontier = new Set(paretoFrontier(rows));
  const riskLevels = options.riskLevels || [0, 0.25, 0.5, 0.75, 1];
  const sensitivity = riskLevels.map((riskAversion) => {
    const ranked = rows.map((row) => ({
      id: row.id,
      score: robustScore(row.summary, row.regret, row.probabilityBest, {
        ...options,
        riskAversion,
      }),
    })).sort((left, right) => right.score - left.score);
    return {
      riskAversion,
      preferredActionId: ranked[0].id,
      margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : null,
    };
  });
  const stability = sensitivity.filter(
    (row) => row.preferredActionId === preferred.id,
  ).length / sensitivity.length;
  const riskAversion = clamp(options.riskAversion ?? 0.35, 0, 1);
  rows.forEach((row, index) => {
    const scoreGap = Math.max(0, preferred.robustScore - row.robustScore);
    row.rank = index + 1;
    row.paretoOptimal = frontier.has(row.id);
    row.reversal = row.id === preferred.id ? {
      scoreGap: 0,
      description: "This action is preferred under the selected risk policy.",
    } : {
      scoreGap,
      meanLiftNeeded: scoreGap / Math.max(0.05, 1 - riskAversion),
      tailLiftNeeded: scoreGap / Math.max(0.05, riskAversion),
      description: "The action must improve its mean, lower tail, or paired regret enough to close the robust-score gap.",
    };
  });

  return {
    schemaVersion: "portfolio-decision/v1",
    version: ROBUST_DECISION_VERSION,
    evaluatedAt: new Date().toISOString(),
    sampleCount,
    policy: {
      riskAversion,
      regretPenalty: Math.max(0, finite(options.regretPenalty, 0.15)),
      target: options.target ?? null,
    },
    preferredActionId: preferred.id,
    stability: round(stability, 4),
    paretoFrontier: [...frontier],
    sensitivity,
    actions: rows.map(({ samples, ...row }) => ({
      ...row,
      robustScore: round(row.robustScore, 4),
      probabilityBest: round(row.probabilityBest, 4),
      summary: Object.fromEntries(Object.entries(row.summary).map(([key, value]) => [
        key,
        typeof value === "number" ? round(value, 4) : value,
      ])),
      regret: Object.fromEntries(Object.entries(row.regret).map(([key, value]) => [
        key,
        round(value, 4),
      ])),
      reversal: Object.fromEntries(Object.entries(row.reversal).map(([key, value]) => [
        key,
        typeof value === "number" ? round(value, 4) : value,
      ])),
    })),
  };
}

function rankInformationNeeds(forecasts, options = {}) {
  const importance = {
    market: 1,
    opportunity: 1,
    health: 1.15,
    environment: 0.55,
    matchup: 0.75,
    "offensive-line": 0.65,
    tracking: 0.8,
    news: 0.7,
    efficiency: 0.8,
    coaching: 0.45,
  };
  const scores = new Map();
  const add = (key, score, reason, player) => {
    const current = scores.get(key) || {
      key,
      score: 0,
      reasons: new Set(),
      players: new Set(),
    };
    current.score += score;
    current.reasons.add(reason);
    current.players.add(String(player.id));
    scores.set(key, current);
  };

  for (const forecast of forecasts || []) {
    const player = forecast.player || {};
    const uncertainty = finite(forecast.uncertainty?.epistemic)
      + finite(forecast.uncertainty?.evidenceConflict);
    for (const family of forecast.evidence?.missingFamilies || []) {
      add(
        `family:${family}`,
        uncertainty * (importance[family] || 0.5),
        "missing evidence family",
        player,
      );
    }
    for (const evidence of forecast.evidence?.used || []) {
      if (finite(evidence.conflict) <= 0.1) continue;
      add(
        `feature:${evidence.feature}`,
        uncertainty * finite(evidence.conflict) * (importance[evidence.family] || 0.5),
        "conflicting sources",
        player,
      );
    }
    if (finite(forecast.availability?.probability, 1) < 0.8) {
      add(
        "feature:health.active_probability",
        finite(forecast.uncertainty?.availability) * 1.2,
        "material availability uncertainty",
        player,
      );
    }
  }

  const limit = Math.min(50, Math.max(1, Number(options.limit || 12)));
  return [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      key: row.key,
      score: round(row.score, 4),
      reasons: [...row.reasons],
      playerIds: [...row.players],
    }));
}

module.exports = {
  ROBUST_DECISION_VERSION,
  mean,
  paretoFrontier,
  pairedRegrets,
  quantileSorted,
  rankInformationNeeds,
  rankPairedActions,
  robustScore,
  standardDeviation,
  summarizeSamples,
};
