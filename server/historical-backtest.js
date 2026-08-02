"use strict";

const core = require("../app-core.js");
const { evaluateRosterChange } = require("./roster-utility.js");

const STRATEGIES = ["market", "value", "legacy", "oracle"];
const POSITIONS = ["QB", "RB", "WR", "TE"];
const DEFAULT_SETTINGS = {
  teams: 12,
  rounds: 14,
  draftPosition: 1,
  scoring: "ppr",
  riskTolerance: 0.5,
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, DST: 0, K: 0, BN: 7 },
};

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function seededRandom(seed) {
  let value = (Math.round(finite(seed, 1)) >>> 0) || 1;
  return function random() {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function gumbel(random) {
  const value = clamp(random(), 1e-9, 1 - 1e-9);
  return -Math.log(-Math.log(value));
}

function scoringKey(scoring) {
  if (scoring === "standard") return "actualSeasonStandard";
  if (scoring === "half") return "actualSeasonHalf";
  return "actualSeasonPpr";
}

function weeklyKey(scoring) {
  if (scoring === "standard") return "actualWeeklyStandard";
  if (scoring === "half") return "actualWeeklyHalf";
  return "actualWeeklyPpr";
}

function addPositionRanks(dataset) {
  const ranks = new Map();
  for (const position of POSITIONS) {
    dataset.players.filter((player) => player.position === position)
      .sort((left, right) => left.marketRank - right.marketRank)
      .forEach((player, index) => ranks.set(player.id, index + 1));
  }
  return dataset.players.map((player) => ({
    ...player,
    positionRank: ranks.get(player.id) || 999,
  }));
}

function weightedMarketEstimate(training, target, scoring) {
  const key = scoringKey(scoring);
  const candidates = training.filter((player) => player.position === target.position)
    .map((player) => ({
      player,
      distance: Math.abs(finite(player.positionRank, 999) - finite(target.positionRank, 999)),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 36);
  if (!candidates.length) return { mean: 0, deviation: 0, samples: 0 };
  let weighted = 0;
  let weights = 0;
  for (const row of candidates) {
    const weight = 1 / Math.sqrt(2 + row.distance);
    weighted += finite(row.player[key], 0) * weight;
    weights += weight;
  }
  const estimate = weighted / Math.max(1e-9, weights);
  const residuals = candidates.map((row) => finite(row.player[key], 0) - estimate);
  return {
    mean: estimate,
    deviation: standardDeviation(residuals),
    samples: candidates.length,
  };
}

function modelHistoricalSeason(trainingDatasets, targetDataset, scoring = "ppr") {
  const training = trainingDatasets.flatMap(addPositionRanks);
  const targets = addPositionRanks(targetDataset);
  return targets.map((player) => {
    const estimate = weightedMarketEstimate(training, player, scoring);
    const prior = finite(player.previousPoints, 0);
    const priorWeight = prior > 0 ? clamp(0.22 + player.reliability * 0.14, 0.22, 0.36) : 0;
    const projected = Math.max(0, estimate.mean * (1 - priorWeight) + prior * priorWeight);
    const weekly = projected / 17;
    const deviation = Math.max(weekly * 0.32, estimate.deviation / 17);
    const weeklyValues = Array.from({ length: 18 }, (_, index) => (
      player.byeWeek === index + 1 ? 0 : round(weekly, 3)
    ));
    const confidence = clamp(
      player.reliability * 0.55 + Math.min(1, estimate.samples / 30) * 0.25 +
        (prior > 0 ? 0.12 : 0) - finite(player.rankSd, 0) / 500,
      0.3,
      0.96,
    );
    return core.normalizePlayer({
      ...player,
      projectedPoints: round(projected, 2),
      weeklyProjection: round(weekly, 3),
      weeklyProjections: weeklyValues,
      floorProjection: round(Math.max(0, weekly - deviation), 3),
      ceilingProjection: round(weekly + deviation * 1.5, 3),
      projectionStdDev: round(deviation, 3),
      reliability: round(confidence, 4),
      marketProjection: round(estimate.mean, 2),
      historicalModel: {
        version: "oracle-historical-projection-2026.1",
        trainingSeasons: trainingDatasets.map((dataset) => dataset.meta.season),
        neighborSamples: estimate.samples,
        positionRank: player.positionRank,
        priorWeight: round(priorWeight, 4),
        residualDeviation: round(estimate.deviation, 2),
      },
    });
  });
}

function rosterCounts(state, teamId, byId) {
  const roster = (state.rosters[String(teamId)] || []).map((id) => byId.get(String(id))).filter(Boolean);
  return roster.reduce((counts, player) => {
    counts[player.position] = (counts[player.position] || 0) + 1;
    return counts;
  }, {});
}

function draftNeed(position, counts, settings) {
  const slots = settings.slots;
  const direct = Math.max(0, finite(slots[position], 0) - finite(counts[position], 0));
  if (!["RB", "WR", "TE"].includes(position)) return direct;
  const skill = finite(counts.RB, 0) + finite(counts.WR, 0) + finite(counts.TE, 0);
  const target = finite(slots.RB, 0) + finite(slots.WR, 0) + finite(slots.TE, 0) + finite(slots.FLEX, 0);
  return Math.max(direct, Math.min(1, Math.max(0, target - skill)));
}

function availablePlayers(players, state) {
  const drafted = new Set((state.picks || []).map((pick) => String(pick.playerId)));
  return players.filter((player) => !drafted.has(player.id));
}

function marketPick(players, state, settings, teamId, random) {
  const byId = new Map(players.map((player) => [player.id, player]));
  const counts = rosterCounts(state, teamId, byId);
  const pick = state.picks.length + 1;
  const early = pick / Math.max(1, settings.teams * settings.rounds);
  let best = null;
  let bestScore = -Infinity;
  for (const player of availablePlayers(players, state)
    .sort((left, right) => left.marketRank - right.marketRank)
    .slice(0, 56)) {
    const need = draftNeed(player.position, counts, settings);
    let construction = 0;
    if (player.position === "QB" && finite(counts.QB, 0) >= 1 && early < 0.62) construction += 9;
    if (player.position === "TE" && finite(counts.TE, 0) >= 2 && early < 0.72) construction += 7;
    if (finite(counts[player.position], 0) >= finite(settings.slots[player.position], 0) + 4) construction += 6;
    const spread = clamp(5 + finite(player.marketRank, 200) * 0.055, 5, 22);
    const score = -finite(player.marketRank, 999) + need * 9 - construction + gumbel(random) * spread;
    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }
  return best;
}

function valuePick(players, state, settings) {
  const replacement = core.computeReplacementLevels(players, settings);
  return availablePlayers(players, state).reduce((best, player) => {
    const value = core.draftAssetValue(player, replacement, settings);
    return !best || value > best.value ? { player, value } : best;
  }, null)?.player || null;
}

function legacyOraclePick(players, state, settings, teamId) {
  return core.advancedDraftRecommendations(players, state, settings, teamId, 1)[0] || null;
}

function calibratedOraclePick(players, state, settings, teamId, policy = {}) {
  const marketWeight = clamp(policy.marketWeight ?? 0.68, 0.35, 0.9);
  const modelWeight = 1 - marketWeight;
  const recommendations = core.recommendPlayers(players, state, settings, teamId, 140);
  const modelRank = new Map(recommendations.map((player, index) => [player.id, index + 1]));
  return availablePlayers(players, state)
    .filter((player) => modelRank.has(player.id))
    .map((player) => ({
      player,
      blendedRank: finite(player.marketRank, 999) * marketWeight +
        finite(modelRank.get(player.id), 999) * modelWeight + finite(player.rankSd, 0) * 0.035,
    }))
    .sort((left, right) => left.blendedRank - right.blendedRank)[0]?.player || null;
}

function strategyPick(strategy, players, state, settings, teamId, random, policy) {
  if (strategy === "legacy") return legacyOraclePick(players, state, settings, teamId);
  if (strategy === "oracle") return calibratedOraclePick(players, state, settings, teamId, policy);
  if (strategy === "value") return valuePick(players, state, settings);
  return marketPick(players, state, settings, teamId, random);
}

function simulateDraft(options = {}) {
  const settings = core.cloneSettings({ ...DEFAULT_SETTINGS, ...(options.settings || {}) });
  const players = options.players.map(core.normalizePlayer);
  const byId = new Map(players.map((player) => [player.id, player]));
  const trackedTeam = Number(options.draftPosition || settings.draftPosition || 1);
  let state = core.createDraftState(settings);
  const decisions = [];
  const actualKey = scoringKey(settings.scoring);
  const totalPicks = settings.teams * settings.rounds;
  for (let pick = 1; pick <= totalPicks; pick += 1) {
    const teamId = core.snakeTeamForPick(pick, settings.teams);
    const strategy = teamId === trackedTeam ? options.strategy : "market";
    const random = seededRandom((options.seed || 1) ^ (pick * 10007) ^ (teamId * 7919));
    const available = availablePlayers(players, state);
    const counts = rosterCounts(state, teamId, byId);
    const selected = strategyPick(strategy, players, state, settings, teamId, random, options.policy);
    if (!selected) break;
    if (teamId === trackedTeam) {
      const samePosition = available.filter((player) => player.position === selected.position);
      const bestActual = Math.max(0, ...samePosition.map((player) => finite(player[actualKey], 0)));
      decisions.push({
        pick,
        round: Math.floor((pick - 1) / settings.teams) + 1,
        playerId: selected.id,
        playerName: selected.name,
        position: selected.position,
        need: draftNeed(selected.position, counts, settings),
        selectedActual: finite(selected[actualKey], 0),
        bestAvailablePositionActual: bestActual,
        regret: Math.max(0, bestActual - finite(selected[actualKey], 0)),
      });
    }
    state = core.applyDraftPick(state, selected.id, settings, teamId);
  }
  const rosters = Object.fromEntries(Object.entries(state.rosters).map(([teamId, ids]) => [
    teamId,
    ids.map((id) => byId.get(String(id))).filter(Boolean),
  ]));
  return { state, rosters, decisions, trackedTeam, settings };
}

function playerActualWeek(player, week, scoring) {
  const values = player?.[weeklyKey(scoring)] || [];
  return Math.max(0, finite(values[week - 1], 0));
}

function decisionProjection(player, week, scoring) {
  if (player.byeWeek === week) return -1;
  const preseason = finite(player.projectedPoints, 0) / 17;
  if (week <= 1) return preseason;
  const actual = player?.[weeklyKey(scoring)] || [];
  const prior = actual.slice(0, week - 1).map((value) => finite(value, 0));
  const recent = prior.slice(-4);
  const observed = mean(prior);
  const recentMean = mean(recent);
  const sampleWeight = Math.min(10, prior.length);
  const blended = (preseason * 4 + observed * sampleWeight) / (4 + sampleWeight);
  return Math.max(0, blended * 0.72 + recentMean * 0.28);
}

function scoreRosterWeek(roster, settings, week, scoring) {
  const rows = roster.map((player) => ({
    ...player,
    decisionProjection: decisionProjection(player, week, scoring),
    actualWeekPoints: playerActualWeek(player, week, scoring),
  }));
  const managed = core.optimizeLineup(rows, settings, "decisionProjection");
  const best = core.optimizeLineup(rows, settings, "actualWeekPoints");
  const managedPoints = managed.starters.reduce((sum, row) => (
    sum + finite(row.player?.actualWeekPoints, 0)
  ), 0);
  return {
    managed: managedPoints,
    best: best.total,
    starterIds: managed.starters.filter((row) => row.player).map((row) => row.player.id),
  };
}

function roundRobinPairs(teamCount, week) {
  const rotation = Array.from({ length: teamCount }, (_, index) => index);
  if (rotation.length % 2) rotation.push(-1);
  for (let step = 0; step < (week - 1) % Math.max(1, rotation.length - 1); step += 1) {
    rotation.splice(1, 0, rotation.pop());
  }
  const pairs = [];
  for (let index = 0; index < rotation.length / 2; index += 1) {
    const left = rotation[index];
    const right = rotation[rotation.length - 1 - index];
    if (left >= 0 && right >= 0) pairs.push([left, right]);
  }
  return pairs;
}

function playoffChampion(ranking, weeklyScores) {
  const seeds = ranking.slice(0, Math.min(6, ranking.length));
  if (seeds.length < 4) return seeds[0]?.team ?? -1;
  const score = (team, week) => finite(weeklyScores[team]?.[week - 1], 0);
  const winner = (left, right, week) => score(left.team, week) >= score(right.team, week) ? left : right;
  if (seeds.length === 4) {
    const first = winner(seeds[0], seeds[3], 15);
    const second = winner(seeds[1], seeds[2], 15);
    return winner(first, second, 16).team;
  }
  const quarterA = winner(seeds[2], seeds[5], 15);
  const quarterB = winner(seeds[3], seeds[4], 15);
  const semiA = winner(seeds[0], quarterB, 16);
  const semiB = winner(seeds[1], quarterA, 16);
  return winner(semiA, semiB, 17).team;
}

function scoreLeague(draft, scoring = "ppr") {
  const teamIds = Object.keys(draft.rosters).map(Number).sort((a, b) => a - b);
  const weeklyScores = {};
  const weeklyBest = {};
  for (const teamId of teamIds) {
    weeklyScores[teamId] = [];
    weeklyBest[teamId] = [];
    for (let week = 1; week <= 17; week += 1) {
      const result = scoreRosterWeek(draft.rosters[teamId], draft.settings, week, scoring);
      weeklyScores[teamId].push(result.managed);
      weeklyBest[teamId].push(result.best);
    }
  }
  const wins = Object.fromEntries(teamIds.map((teamId) => [teamId, 0]));
  const points = Object.fromEntries(teamIds.map((teamId) => [
    teamId,
    weeklyScores[teamId].slice(0, 14).reduce((sum, value) => sum + value, 0),
  ]));
  for (let week = 1; week <= 14; week += 1) {
    for (const [leftIndex, rightIndex] of roundRobinPairs(teamIds.length, week)) {
      const left = teamIds[leftIndex];
      const right = teamIds[rightIndex];
      const leftScore = weeklyScores[left][week - 1];
      const rightScore = weeklyScores[right][week - 1];
      if (leftScore > rightScore) wins[left] += 1;
      else if (rightScore > leftScore) wins[right] += 1;
      else { wins[left] += 0.5; wins[right] += 0.5; }
    }
  }

  const ranking = teamIds.map((teamId) => ({
    team: teamId,
    wins: wins[teamId],
    points: points[teamId],
  })).sort((left, right) => right.wins - left.wins || right.points - left.points);
  const champion = playoffChampion(ranking, weeklyScores);
  const tracked = draft.trackedTeam;
  let allPlayWins = 0;
  let allPlayGames = 0;
  for (let week = 1; week <= 14; week += 1) {
    for (const other of teamIds) {
      if (other === tracked) continue;
      const trackedScore = weeklyScores[tracked][week - 1];
      const otherScore = weeklyScores[other][week - 1];
      allPlayWins += trackedScore > otherScore ? 1 : trackedScore === otherScore ? 0.5 : 0;
      allPlayGames += 1;
    }
  }
  const seed = ranking.findIndex((row) => row.team === tracked) + 1;
  return {
    weeklyScores,
    weeklyBest,
    ranking,
    champion,
    tracked: {
      seed,
      wins: wins[tracked],
      regularSeasonPoints: points[tracked],
      seasonPoints: weeklyScores[tracked].reduce((sum, value) => sum + value, 0),
      bestBallPoints: weeklyBest[tracked].reduce((sum, value) => sum + value, 0),
      allPlayWinPct: allPlayWins / Math.max(1, allPlayGames),
      playoff: seed <= Math.min(6, teamIds.length),
      champion: champion === tracked,
    },
  };
}

function actualReplacementLevels(players, settings, scoring) {
  const key = scoringKey(scoring);
  const projected = players.map((player) => ({
    ...player,
    projectedPoints: finite(player[key], 0),
  }));
  return core.computeReplacementLevels(projected, settings);
}

function evaluateDraft(draft, players, scoring = "ppr") {
  const league = scoreLeague(draft, scoring);
  const trackedRoster = draft.rosters[draft.trackedTeam] || [];
  const replacement = actualReplacementLevels(players, draft.settings, scoring);
  const key = scoringKey(scoring);
  const actualVorp = trackedRoster.reduce((sum, player) => (
    sum + Math.max(0, finite(player[key], 0) - finite(replacement[player.position], 0))
  ), 0);
  const counts = trackedRoster.reduce((output, player) => {
    output[player.position] = (output[player.position] || 0) + 1;
    return output;
  }, {});

  const starterGaps = ["QB", "RB", "WR", "TE"].reduce((sum, position) => (
    sum + Math.max(0, finite(draft.settings.slots[position], 0) - finite(counts[position], 0))
  ), 0);
  const needPicks = draft.decisions.filter((decision) => decision.need > 0).length;
  const regret = draft.decisions.map((decision) => decision.regret);
  const tracked = league.tracked;
  return {
    ...tracked,
    managedEfficiency: tracked.seasonPoints / Math.max(1, tracked.bestBallPoints),
    actualVorp,
    starterGaps,
    needPickRate: needPicks / Math.max(1, draft.decisions.length),
    averagePickRegret: mean(regret),
    medianPickRegret: median(regret),
    maximumPickRegret: Math.max(0, ...regret),
    decisions: draft.decisions,
  };
}

function summarizeStrategy(rows) {
  const fields = [
    "seasonPoints", "bestBallPoints", "managedEfficiency", "wins", "allPlayWinPct",
    "actualVorp", "starterGaps", "needPickRate", "averagePickRegret", "medianPickRegret",
  ];
  const output = { samples: rows.length };
  for (const field of fields) {
    const values = rows.map((row) => finite(row[field], 0));
    output[field] = round(mean(values), field.includes("Rate") || field.includes("Pct") || field.includes("Efficiency") ? 4 : 3);
    output[`${field}P10`] = round(percentile(values, 0.1), 3);
    output[`${field}P90`] = round(percentile(values, 0.9), 3);
  }
  output.playoffRate = round(mean(rows.map((row) => Number(row.playoff))), 4);
  output.championshipRate = round(mean(rows.map((row) => Number(row.champion))), 4);
  return output;
}

function strategyLift(summary, baseline) {
  return {
    seasonPoints: round(summary.seasonPoints - baseline.seasonPoints, 3),
    wins: round(summary.wins - baseline.wins, 3),
    allPlayWinPct: round(summary.allPlayWinPct - baseline.allPlayWinPct, 4),
    playoffRate: round(summary.playoffRate - baseline.playoffRate, 4),
    championshipRate: round(summary.championshipRate - baseline.championshipRate, 4),
    actualVorp: round(summary.actualVorp - baseline.actualVorp, 3),
    pickRegretReduction: round(baseline.averagePickRegret - summary.averagePickRegret, 3),
    starterGapReduction: round(baseline.starterGaps - summary.starterGaps, 3),
  };
}

function valueCurveForPosition(datasets, position, scoring, bucketSize = 24) {
  const key = scoringKey(scoring);
  const rows = datasets.flatMap((dataset) => dataset.players)
    .filter((player) => player.position === position && finite(player.marketRank, 0) > 0);
  const maximum = Math.max(0, ...rows.map((player) => finite(player.marketRank, 0)));
  const curve = [];
  for (let start = 1; start <= maximum; start += bucketSize) {
    const end = start + bucketSize - 1;
    const bucket = rows.filter((player) => player.marketRank >= start && player.marketRank <= end);
    if (bucket.length < 4) continue;
    const values = bucket.map((player) => finite(player[key], 0));
    const average = mean(values);
    const deviation = standardDeviation(values);
    const hitThreshold = average + deviation * 0.45;
    const bustThreshold = Math.max(0, average - deviation * 0.65);
    curve.push({
      rankStart: start,
      rankEnd: end,
      samples: bucket.length,
      meanPoints: round(average, 2),
      medianPoints: round(median(values), 2),
      standardDeviation: round(deviation, 2),
      p10: round(percentile(values, 0.1), 2),
      p90: round(percentile(values, 0.9), 2),
      hitRate: round(mean(values.map((value) => Number(value >= hitThreshold))), 4),
      bustRate: round(mean(values.map((value) => Number(value <= bustThreshold))), 4),
    });
  }
  return curve;
}

function createValueCurves(datasets) {
  return Object.fromEntries(["ppr", "half", "standard"].map((scoring) => [
    scoring,
    Object.fromEntries(POSITIONS.map((position) => [
      position,
      valueCurveForPosition(datasets, position, scoring),
    ])),
  ]));
}

function datasetCoverage(datasets) {
  const players = datasets.flatMap((dataset) => dataset.players);
  return {
    seasons: datasets.map((dataset) => dataset.meta.season),
    playerSeasons: players.length,
    identifierCoverage: round(mean(datasets.map((dataset) => dataset.coverage.identifierMap)), 4),
    pointsCoverage: round(mean(datasets.map((dataset) => dataset.coverage.playersWithPoints)), 4),
    preseasonSnapshots: Object.fromEntries(datasets.map((dataset) => [
      dataset.meta.season,
      dataset.meta.rankDate,
    ])),
  };
}

function pairedStrategyLift(rows, strategy, baseline = "market") {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.season}:${row.slot}:${row.simulation}`;
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[row.strategy] = row;
  }
  const pairs = [...byKey.values()].filter((pair) => pair[strategy] && pair[baseline]);
  const fields = ["seasonPoints", "wins", "allPlayWinPct", "actualVorp", "averagePickRegret"];
  const output = { pairs: pairs.length };
  for (const field of fields) {
    const values = pairs.map((pair) => finite(pair[strategy][field], 0) - finite(pair[baseline][field], 0));
    output[field] = round(mean(values), 4);
    output[`${field}P10`] = round(percentile(values, 0.1), 4);
    output[`${field}P90`] = round(percentile(values, 0.9), 4);
  }
  output.playoffRate = round(mean(pairs.map((pair) => (
    Number(pair[strategy].playoff) - Number(pair[baseline].playoff)
  ))), 4);
  output.championshipRate = round(mean(pairs.map((pair) => (
    Number(pair[strategy].champion) - Number(pair[baseline].champion)
  ))), 4);
  output.pickRegretReduction = round(-output.averagePickRegret, 4);
  return output;
}

function groupedSummary(rows, property) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[property]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [
    key,
    Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      summarizeStrategy(group.filter((row) => row.strategy === strategy)),
    ])),
  ]));
}

function cleanEvaluation(evaluation, metadata) {
  const { decisions, ...metrics } = evaluation;
  return {
    ...metadata,
    ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
      key,
      typeof value === "number" ? round(value, 5) : value,
    ])),
  };
}

function runHistoricalBacktest(options = {}) {
  const datasets = [...(options.datasets || [])].sort((left, right) => (
    left.meta.season - right.meta.season
  ));
  if (datasets.length < 2) throw new Error("Historical backtesting requires at least two seasons");
  const scoring = options.scoring || "ppr";
  const settings = core.cloneSettings({
    ...DEFAULT_SETTINGS,
    ...(options.settings || {}),
    scoring,
  });
  const strategies = options.strategies || STRATEGIES;
  const slots = options.slots || Array.from({ length: settings.teams }, (_, index) => index + 1);
  const simulationsPerSlot = Math.max(1, Math.round(options.simulationsPerSlot || 8));
  const rows = [];
  const modelDiagnostics = {};
  for (let datasetIndex = 1; datasetIndex < datasets.length; datasetIndex += 1) {
    const target = datasets[datasetIndex];
    const training = datasets.slice(0, datasetIndex);
    const players = modelHistoricalSeason(training, target, scoring);
    modelDiagnostics[target.meta.season] = {
      trainingSeasons: training.map((dataset) => dataset.meta.season),
      players: players.length,
      meanProjection: round(mean(players.map((player) => player.projectedPoints)), 3),
      meanActual: round(mean(players.map((player) => finite(player[scoringKey(scoring)], 0))), 3),
    };
    for (const slot of slots) {
      for (let simulation = 0; simulation < simulationsPerSlot; simulation += 1) {
        const seed = finite(options.seed, 2026) + target.meta.season * 104729 + slot * 7919 + simulation * 65537;
        for (const strategy of strategies) {
          const draft = simulateDraft({
            players,
            settings: { ...settings, draftPosition: slot },
            draftPosition: slot,
            strategy,
            seed,
            policy: options.policy,
          });
          const evaluation = evaluateDraft(draft, players, scoring);
          rows.push(cleanEvaluation(evaluation, {
            season: target.meta.season,
            slot,
            simulation,
            strategy,
            seed,
          }));
        }
      }
    }
    options.onProgress?.({
      season: target.meta.season,
      completedRows: rows.length,
      totalRows: (datasets.length - 1) * slots.length * simulationsPerSlot * strategies.length,
    });
  }

  const summaries = Object.fromEntries(strategies.map((strategy) => [
    strategy,
    summarizeStrategy(rows.filter((row) => row.strategy === strategy)),
  ]));
  const baseline = summaries.market;
  const lifts = Object.fromEntries(strategies.filter((strategy) => strategy !== "market").map((strategy) => [
    strategy,
    {
      unpaired: strategyLift(summaries[strategy], baseline),
      paired: pairedStrategyLift(rows, strategy, "market"),
    },
  ]));
  const valueCurves = createValueCurves(datasets);
  return {
    version: "oracle-historical-backtest-2026.1",
    generatedAt: new Date().toISOString(),
    seasons: datasets.slice(1).map((dataset) => dataset.meta.season),
    trainingSeasons: datasets.map((dataset) => dataset.meta.season),
    scoring,
    settings,
    simulationsPerSlot,
    draftReplays: rows.length,
    pairedScenarios: (datasets.length - 1) * slots.length * simulationsPerSlot,
    strategies: summaries,
    lifts,
    bySeason: groupedSummary(rows, "season"),
    bySlot: groupedSummary(rows, "slot"),
    modelDiagnostics,
    valueCurves,
    dataCoverage: datasetCoverage(datasets),
    leakageControls: [
      "Rankings are the latest archived August redraft consensus snapshot for each season.",
      "Each test season is projected only from seasons that occurred earlier.",
      "Current coaching profiles, current injuries, and future-season outcomes are excluded.",
      "Weekly lineup choices use only preseason projections and results from completed prior weeks.",
      "Oracle and baseline strategies use paired season, slot, and random-seed scenarios.",
    ],
    limitations: [
      "The committed benchmark covers skill positions and excludes kicker and team-defense slots.",
      "Mock-draft opponents approximate market behavior rather than reproducing every historical room.",
      "Historical value curves describe cohorts and do not guarantee an individual outcome.",
      "Transactions after the draft are excluded from the draft-only benchmark.",
    ],
    rows: options.includeRows ? rows : undefined,
  };
}

function actualManagedPoints(roster, settings, scoring, startWeek = 1, endWeek = 17) {
  let points = 0;
  for (let week = startWeek; week <= endWeek; week += 1) {
    points += scoreRosterWeek(roster, settings, week, scoring).managed;
  }
  return points;
}

function pearsonCorrelation(left, right) {
  if (left.length < 2 || left.length !== right.length) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  return numerator / Math.max(1e-9, Math.sqrt(leftVariance * rightVariance));
}

function replaceRosterPlayer(roster, drop, add) {
  return [
    ...roster.filter((player) => player.id !== drop.id),
    add,
  ];
}
function tradeNormalization(rows) {
  const native = rows.map((row) => finite(row.predictedScore, 0));
  const utility = rows.map((row) => finite(row.predictedUtility, 0));
  return {
    nativeMean: round(mean(native), 6),
    nativeStdDev: round(Math.max(1e-6, standardDeviation(native)), 6),
    utilityMean: round(mean(utility), 6),
    utilityStdDev: round(Math.max(1e-6, standardDeviation(utility)), 6),
  };
}

function tradeDecisionScore(row, policy = {}) {
  const normalization = policy.normalization || tradeNormalization([row]);
  const nativeZ = (finite(row.predictedScore, 0) - finite(normalization.nativeMean, 0)) /
    Math.max(1e-6, finite(normalization.nativeStdDev, 1));
  const utilityZ = (finite(row.predictedUtility, 0) - finite(normalization.utilityMean, 0)) /
    Math.max(1e-6, finite(normalization.utilityStdDev, 1));
  const utilityShare = clamp(policy.utilityShare ?? 0.5, 0, 1);
  return nativeZ * (1 - utilityShare) + utilityZ * utilityShare;
}

function summarizeTradeRows(rows, policy = {}) {
  const minimumFairness = finite(policy.minimumFairness, 55);
  const scores = rows.map((row) => tradeDecisionScore(row, policy));
  const scoreThreshold = Number.isFinite(Number(policy.scoreThreshold))
    ? Number(policy.scoreThreshold)
    : percentile(scores, finite(policy.scoreQuantile, 0.75));
  const scored = rows.map((row) => ({ ...row, decisionScore: tradeDecisionScore(row, policy) }));
  const recommended = scored.filter((row) => (
    row.decisionScore >= scoreThreshold && row.fairness >= minimumFairness
  ));
  const sorted = [...scored].sort((a, b) => b.decisionScore - a.decisionScore);
  const quintile = Math.max(1, Math.ceil(sorted.length * 0.2));
  const top = sorted.slice(0, quintile);
  const bottom = sorted.slice(-quintile);
  return {
    candidates: rows.length,
    decisionCorrelation: round(pearsonCorrelation(
      scored.map((row) => row.decisionScore),
      scored.map((row) => row.actualUserDelta),
    ), 4),
    correlation: round(pearsonCorrelation(
      rows.map((row) => row.predictedScore),
      rows.map((row) => row.actualUserDelta),
    ), 4),
    lineupGainCorrelation: round(pearsonCorrelation(
      rows.map((row) => row.predictedLineupGain),
      rows.map((row) => row.actualUserDelta),
    ), 4),
    utilityCorrelation: round(pearsonCorrelation(
      rows.map((row) => row.predictedUtility),
      rows.map((row) => row.actualUserDelta),
    ), 4),
    needReductionCorrelation: round(pearsonCorrelation(
      rows.map((row) => row.predictedNeedReduction),
      rows.map((row) => row.actualUserDelta),
    ), 4),
    scoreThreshold: round(scoreThreshold, 4),
    minimumFairness,
    recommended: recommended.length,
    recommendationPrecision: round(mean(recommended.map((row) => Number(row.actualUserDelta > 0))), 4),
    mutualPositiveRate: round(mean(recommended.map((row) => Number(
      row.actualUserDelta > 0 && row.actualOpponentDelta >= -5
    ))), 4),
    recommendedActualGain: round(mean(recommended.map((row) => row.actualUserDelta)), 3),
    topQuintileActualGain: round(mean(top.map((row) => row.actualUserDelta)), 3),
    bottomQuintileActualGain: round(mean(bottom.map((row) => row.actualUserDelta)), 3),
    separation: round(
      mean(top.map((row) => row.actualUserDelta)) - mean(bottom.map((row) => row.actualUserDelta)),
      3,
    ),
  };
}

function selectTradePolicy(rows, bySeason) {
  const seasons = Object.keys(bySeason).map(Number).sort((a, b) => a - b);
  const holdoutSeason = seasons.at(-1) || null;
  let training = rows.filter((row) => row.season !== holdoutSeason);
  let selectedWithoutHoldout = training.length >= 20;
  if (!selectedWithoutHoldout) training = rows;
  const normalization = tradeNormalization(training);
  const candidates = Array.from({ length: 11 }, (_, index) => index / 10).map((utilityShare) => {
    const policy = {
      utilityShare,
      normalization,
      minimumFairness: 55,
      scoreQuantile: 0.75,
    };
    const summary = summarizeTradeRows(training, policy);
    const objective = summary.decisionCorrelation * 100 + summary.recommendationPrecision * 20 +
      summary.mutualPositiveRate * 8 + summary.recommendedActualGain * 0.08 + summary.separation * 0.015;
    return { ...policy, scoreThreshold: summary.scoreThreshold, objective: round(objective, 5), summary };
  }).sort((left, right) => right.objective - left.objective);
  const selected = candidates[0] || {
    utilityShare: 0.5,
    normalization,
    minimumFairness: 55,
    scoreQuantile: 0.75,
    scoreThreshold: 0,
    objective: 0,
    summary: summarizeTradeRows([], { normalization }),
  };
  const holdoutRows = rows.filter((row) => row.season === holdoutSeason);
  const holdout = holdoutRows.length ? summarizeTradeRows(holdoutRows, selected) : null;
  return {
    version: "oracle-trade-policy-2026.3",
    utilityShare: selected.utilityShare,
    nativeShare: round(1 - selected.utilityShare, 3),
    normalization: selected.normalization,
    minimumFairness: selected.minimumFairness,
    scoreQuantile: selected.scoreQuantile,
    scoreThreshold: selected.scoreThreshold,
    objective: selected.objective,
    confidence: holdout?.decisionCorrelation ?? selected.summary.decisionCorrelation,
    thresholdPrecision: holdout?.recommendationPrecision ?? selected.summary.recommendationPrecision,
    selectedWithoutHoldout,
    tunedOnSeasons: selectedWithoutHoldout ? seasons.slice(0, -1) : seasons,
    holdoutSeason: selectedWithoutHoldout ? holdoutSeason : null,
    training: selected.summary,
    holdout,
    candidates: candidates.map((row) => ({
      utilityShare: row.utilityShare,
      nativeShare: round(1 - row.utilityShare, 3),
      objective: row.objective,
      decisionCorrelation: row.summary.decisionCorrelation,
      recommendationPrecision: row.summary.recommendationPrecision,
      recommendedActualGain: row.summary.recommendedActualGain,
    })),
    interpretation: "Standardize the native score and multi-week roster utility, then use the leakage-safe training seasons to select their blend.",
  };
}

function runTradeCalibration(options = {}) {
  const datasets = [...(options.datasets || [])].sort((a, b) => a.meta.season - b.meta.season);
  const scoring = options.scoring || "ppr";
  const settings = core.cloneSettings({ ...DEFAULT_SETTINGS, ...(options.settings || {}), scoring });
  const samplesPerSeason = Math.max(1, Math.round(options.samplesPerSeason || 3));
  const candidates = [];
  const bySeason = {};
  for (let targetIndex = 1; targetIndex < datasets.length; targetIndex += 1) {
    const target = datasets[targetIndex];
    const players = modelHistoricalSeason(datasets.slice(0, targetIndex), target, scoring);
    const seasonRows = [];
    for (let sample = 0; sample < samplesPerSeason; sample += 1) {
      const slot = (sample % settings.teams) + 1;
      const draft = simulateDraft({
        players,
        settings: { ...settings, draftPosition: slot },
        draftPosition: slot,
        strategy: "market",
        seed: target.meta.season * 99991 + sample * 65537,
      });
      const opponent = (slot % settings.teams) + 1;
      const userRoster = draft.rosters[slot] || [];
      const opponentRoster = draft.rosters[opponent] || [];
      const userBefore = actualManagedPoints(userRoster, settings, scoring);
      const opponentBefore = actualManagedPoints(opponentRoster, settings, scoring);
      const userAssets = [...userRoster].sort((a, b) => b.projectedPoints - a.projectedPoints).slice(0, 6);
      const opponentAssets = [...opponentRoster].sort((a, b) => b.projectedPoints - a.projectedPoints).slice(0, 6);
      for (const give of userAssets) {
        for (const receive of opponentAssets) {
          const predicted = core.analyzeTrade({
            roster: userRoster,
            give: [give],
            receive: [receive],
            players,
            settings,
            week: 1,
          });
          const userAfterRoster = replaceRosterPlayer(userRoster, give, receive);
          const predictedUtility = evaluateRosterChange({
            beforeRoster: userRoster,
            afterRoster: userAfterRoster,
            players,
            settings,
            startWeek: 1,
          });
          const opponentAfterRoster = replaceRosterPlayer(opponentRoster, receive, give);
          seasonRows.push({
            season: target.meta.season,
            predictedScore: predicted.score,
            predictedLineupGain: predicted.lineupGain,
            predictedUtility: predictedUtility.delta.total,
            predictedNeedReduction: predictedUtility.delta.needReduction,
            fairness: predicted.fairness,
            actualUserDelta: actualManagedPoints(userAfterRoster, settings, scoring) - userBefore,
            actualOpponentDelta: actualManagedPoints(opponentAfterRoster, settings, scoring) - opponentBefore,
          });
        }
      }
    }
    candidates.push(...seasonRows);
    bySeason[target.meta.season] = seasonRows;
  }
  const policy = selectTradePolicy(candidates, bySeason);
  return {
    version: "oracle-trade-calibration-2026.2",
    scoring,
    samplesPerSeason,
    policy,
    overall: summarizeTradeRows(candidates, policy),
    bySeason: Object.fromEntries(Object.entries(bySeason).map(([season, rows]) => [
      season,
      summarizeTradeRows(rows, policy),
    ])),
    limitations: [
      "Synthetic one-for-one preseason offers test score direction, not manager acceptance.",
      "Historical post-draft transactions and keeper costs are not reconstructed.",
    ],
    rows: options.includeRows ? candidates : undefined,
  };
}

function forecastAtWeek(player, week, scoring) {
  const weekly = decisionProjection(player, week, scoring);
  const remaining = Math.max(1, 18 - week);
  return core.normalizePlayer({
    ...player,
    projectedPoints: weekly * remaining,
    weeklyProjection: weekly,
    weeklyProjections: Array.from({ length: 18 }, (_, index) => (
      player.byeWeek === index + 1 ? 0 : weekly
    )),
  });
}

function naiveWaiverMove(roster, freeAgents, week, scoring) {
  const candidate = [...freeAgents]
    .sort((a, b) => decisionProjection(b, week, scoring) - decisionProjection(a, week, scoring))[0];
  if (!candidate) return null;
  const samePosition = roster.filter((player) => player.position === candidate.position);
  const pool = samePosition.length ? samePosition : roster;
  const drop = [...pool].sort((a, b) => (
    decisionProjection(a, week, scoring) - decisionProjection(b, week, scoring)
  ))[0];
  return drop ? { add: candidate, drop } : null;
}

function runWaiverCalibration(options = {}) {
  const datasets = [...(options.datasets || [])].sort((a, b) => a.meta.season - b.meta.season);
  const scoring = options.scoring || "ppr";
  const settings = core.cloneSettings({ ...DEFAULT_SETTINGS, ...(options.settings || {}), scoring });
  const samplesPerSeason = Math.max(1, Math.round(options.samplesPerSeason || 6));
  const evaluationWeek = Math.round(clamp(options.week || 5, 2, 12));
  const rows = [];
  for (let targetIndex = 1; targetIndex < datasets.length; targetIndex += 1) {
    const target = datasets[targetIndex];
    const players = modelHistoricalSeason(datasets.slice(0, targetIndex), target, scoring);
    for (let sample = 0; sample < samplesPerSeason; sample += 1) {
      const slot = (sample % settings.teams) + 1;
      const draft = simulateDraft({
        players,
        settings: { ...settings, draftPosition: slot },
        draftPosition: slot,
        strategy: "market",
        seed: target.meta.season * 1299709 + sample * 104729,
      });
      const roster = draft.rosters[slot] || [];
      const drafted = new Set(draft.state.picks.map((pick) => String(pick.playerId)));
      const freeAgents = players.filter((player) => !drafted.has(player.id))
        .sort((a, b) => decisionProjection(b, evaluationWeek, scoring) - decisionProjection(a, evaluationWeek, scoring))
        .slice(0, 100);
      const forecastRoster = roster.map((player) => forecastAtWeek(player, evaluationWeek, scoring));
      const forecastFreeAgents = freeAgents.map((player) => forecastAtWeek(player, evaluationWeek, scoring));
      const oracleRows = core.waiverRecommendations(
        forecastRoster,
        forecastFreeAgents,
        settings,
        10,
        evaluationWeek,
      );
      const baseOracle = oracleRows[0] || null;
      const forecastUniverse = [...forecastRoster, ...forecastFreeAgents];
      const oracle = oracleRows.map((row) => {
        const afterRoster = replaceRosterPlayer(forecastRoster, row.drop, row.add);
        const utility = evaluateRosterChange({
          beforeRoster: forecastRoster,
          afterRoster,
          players: forecastUniverse,
          settings,
          startWeek: evaluationWeek,
        });
        return {
          ...row,
          utility,
          calibratedScore: finite(row.score, 0) + utility.delta.total * 0.72 +
            utility.delta.needReduction * 0.4,
        };
      }).sort((left, right) => right.calibratedScore - left.calibratedScore)[0] || null;
      const naive = naiveWaiverMove(roster, freeAgents, evaluationWeek, scoring);
      const before = actualManagedPoints(roster, settings, scoring, evaluationWeek, 17);
      const byId = new Map(players.map((player) => [player.id, player]));
      const actualMoveGain = (move) => {
        if (!move) return 0;
        const add = byId.get(String(move.add.id));
        const drop = byId.get(String(move.drop.id));
        if (!add || !drop) return 0;
        return actualManagedPoints(replaceRosterPlayer(roster, drop, add), settings, scoring, evaluationWeek, 17) - before;
      };
      rows.push({
        season: target.meta.season,
        oracleGain: actualMoveGain(oracle),
        baseOracleGain: actualMoveGain(baseOracle),
        naiveGain: actualMoveGain(naive),
        oraclePredictedScore: finite(oracle?.calibratedScore, 0),
      });
    }
  }
  function summarize(input) {
    return {
      scenarios: input.length,
      oracleActualGain: round(mean(input.map((row) => row.oracleGain)), 3),
      baseOracleActualGain: round(mean(input.map((row) => row.baseOracleGain)), 3),
      naiveActualGain: round(mean(input.map((row) => row.naiveGain)), 3),
      gainLift: round(mean(input.map((row) => row.oracleGain - row.naiveGain)), 3),
      baseGainLift: round(mean(input.map((row) => row.baseOracleGain - row.naiveGain)), 3),
      utilityRerankLift: round(mean(input.map((row) => row.oracleGain - row.baseOracleGain)), 3),
      oracleHitRate: round(mean(input.map((row) => Number(row.oracleGain > 0))), 4),
      baseOracleHitRate: round(mean(input.map((row) => Number(row.baseOracleGain > 0))), 4),
      naiveHitRate: round(mean(input.map((row) => Number(row.naiveGain > 0))), 4),
      oracleBeatsNaive: round(mean(input.map((row) => Number(row.oracleGain > row.naiveGain))), 4),
      utilityBeatsBase: round(mean(input.map((row) => Number(row.oracleGain > row.baseOracleGain))), 4),
      scoreCorrelation: round(pearsonCorrelation(
        input.map((row) => row.oraclePredictedScore),
        input.map((row) => row.oracleGain),
      ), 4),
    };
  }
  const seasons = [...new Set(rows.map((row) => row.season))].sort((a, b) => a - b);
  const holdoutSeason = seasons.at(-1) || null;
  let trainingRows = rows.filter((row) => row.season !== holdoutSeason);
  let selectedWithoutHoldout = trainingRows.length >= 2;
  if (!selectedWithoutHoldout) trainingRows = rows;
  const training = summarize(trainingRows);
  const challengerSelected = training.oracleActualGain > training.baseOracleActualGain;
  const holdoutRows = rows.filter((row) => row.season === holdoutSeason);
  const holdout = holdoutRows.length ? summarize(holdoutRows) : null;
  const holdoutPassed = !holdout || holdout.utilityRerankLift >= 0;
  const utilityRerank = challengerSelected && holdoutPassed;
  const policy = {
    version: "oracle-waiver-policy-2026.3",
    utilityRerank,
    challengerSelected,
    holdoutPassed,
    selectedWithoutHoldout,
    tunedOnSeasons: selectedWithoutHoldout ? seasons.slice(0, -1) : seasons,
    holdoutSeason: selectedWithoutHoldout ? holdoutSeason : null,
    training,
    holdout,
    baseActualGain: training.baseOracleActualGain,
    utilityActualGain: training.oracleActualGain,
    naiveActualGain: training.naiveActualGain,
    interpretation: utilityRerank
      ? "Unified-utility reranking won on training seasons and passed the untouched holdout."
      : challengerSelected && !holdoutPassed
        ? "Unified-utility reranking won on training seasons but failed the untouched holdout; retain the need-aware champion."
        : "Historical training seasons favored the existing need-aware ordering; utility remains explanatory.",
  };

  return {
    version: "oracle-waiver-calibration-2026.1",
    scoring,
    evaluationWeek,
    samplesPerSeason,
    policy,
    overall: summarize(rows),
    bySeason: Object.fromEntries([...new Set(rows.map((row) => row.season))].map((season) => [
      season,
      summarize(rows.filter((row) => row.season === season)),
    ])),
    limitations: [
      "Free-agent availability is approximated from players left undrafted in each historical mock.",
      "The replay evaluates one add/drop decision after Week 4 and does not reconstruct real waiver priority.",
    ],
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  STRATEGIES,
  addPositionRanks,
  createValueCurves,
  evaluateDraft,
  modelHistoricalSeason,
  runHistoricalBacktest,
  runTradeCalibration,
  runWaiverCalibration,
  scoreLeague,
  scoreRosterWeek,
  simulateDraft,
};
