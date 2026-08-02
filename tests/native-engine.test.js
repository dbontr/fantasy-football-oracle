"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../app-core.js");
const { NativeEnginePool } = require("../server/native-engine-pool.js");

const root = path.resolve(__dirname, "..");
const binary = path.join(root, "native", "bin", process.platform === "win32"
  ? "oracle-engine.exe"
  : "oracle-engine");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "data", "players-2026.json"), "utf8"));
const players = dataset.players.map(core.normalizePlayer);
const settings = core.cloneSettings({
  teams: 12,
  rounds: 16,
  draftPosition: 6,
  scoring: "ppr",
  riskTolerance: 0.5,
});

if (!fs.existsSync(binary)) {
  throw new Error(`Native test binary is missing: ${binary}. Run npm run build:native.`);
}

const pool = new NativeEnginePool({
  binary,
  size: 1,
  maxQueue: 8,
  taskTimeoutMs: 30_000,
  logger: { warn() {} },
}).start();

test.before(async () => {
  await pool.setDataset(
    dataset.meta?.modelDigest || dataset.meta?.generatedAt || "native-test-dataset",
    players,
  );
});
test.after(async () => pool.close());

function byPosition(position, count, used = new Set()) {
  return players
    .filter((player) => player.position === position && !used.has(player.id))
    .sort((left, right) => left.pprRank - right.pprRank)
    .slice(0, count);
}

function representativeRoster(offset = 0) {
  const used = new Set();
  const rows = [];
  for (const [position, count] of [["QB", 2], ["RB", 4], ["WR", 4], ["TE", 2], ["DST", 1], ["K", 1]]) {
    const candidates = players
      .filter((player) => player.position === position && !used.has(player.id))
      .sort((left, right) => left.pprRank - right.pprRank)
      .slice(offset, offset + count);
    candidates.forEach((player) => used.add(player.id));
    rows.push(...candidates);
  }
  return rows;
}

function starterIds(lineup) {
  return lineup.starters
    .filter((row) => row.player)
    .map((row) => row.player.id)
    .sort();
}

test("native engine reports C++ capabilities", () => {
  const stats = pool.stats();
  assert.equal(stats.available, true);
  assert.equal(stats.engine, "oracle-native");
  assert.equal(stats.language, "C++20");
});

test("native seeded draft simulation exactly matches JavaScript", async () => {
  const state = core.createDraftState(settings);
  const payload = {
    players,
    state,
    settings,
    targetTeamId: 6,
    simulations: 2_000,
    seed: 2026,
    trackLimit: 140,
    exactNoise: true,
  };
  const expected = core.simulatePickWindow(payload);
  const native = (await pool.run("draft-simulate", payload)).data;
  assert.equal(native.targetPick, expected.targetPick);
  assert.equal(native.currentPick, expected.currentPick);
  assert.deepEqual(native.availabilityById, expected.availabilityById);
  assert.deepEqual(native.positionRunRates, expected.positionRunRates);
});

test("native exact lineup assignment matches JavaScript", async () => {
  const roster = representativeRoster();
  const expected = core.optimizeWeeklyLineup(roster, settings, 6);
  const native = (await pool.run("lineup-optimize", {
    roster,
    settings,
    week: 6,
  })).data;
  assert.equal(native.total, expected.total);
  assert.equal(native.filled, expected.filled);
  assert.deepEqual(starterIds(native), starterIds(expected));
});

test("native trade analysis preserves the JavaScript decision model", async () => {
  const roster = representativeRoster();
  const give = [roster.find((player) => player.position === "RB")];
  const receive = [players
    .filter((player) => player.position === "RB" && !roster.some((row) => row.id === player.id))
    .sort((left, right) => left.pprRank - right.pprRank)[0]];
  const payload = { roster, give, receive, players, settings, week: 6 };
  const expected = core.analyzeTrade(payload);
  const native = (await pool.run("trade-analyze", payload)).data;
  assert.ok(Math.abs(native.lineupGain - expected.lineupGain) <= 0.02);
  assert.ok(Math.abs(native.assetGain - expected.assetGain) <= 0.02);
  assert.ok(Math.abs(native.score - expected.score) <= 0.05);
  assert.equal(native.fairness, expected.fairness);
});

test("native waiver analysis includes bounded FAAB guidance", async () => {
  const roster = representativeRoster(5);
  const rosterIds = new Set(roster.map((player) => player.id));
  const freeAgents = players
    .filter((player) => !rosterIds.has(player.id) && ["RB", "WR", "TE"].includes(player.position))
    .slice(0, 80);
  const native = (await pool.run("waivers", {
    roster,
    freeAgents,
    settings,
    week: 6,
    limit: 10,
    budgetRemaining: 100,
    weeksRemaining: 12,
    aggressiveness: 0.6,
  })).data;
  assert.ok(native.length > 0);
  assert.ok(native[0].score > 0);
  assert.ok(native[0].faab.target >= native[0].faab.floor);
  assert.ok(native[0].faab.ceiling >= native[0].faab.target);
  assert.ok(native[0].faab.ceiling <= 100);
});

test("native start-sit analysis returns risk profiles and confidence", async () => {
  const roster = representativeRoster();
  const native = (await pool.run("start-sit", {
    roster,
    settings,
    week: 6,
    opponentTarget: 135,
  })).data;
  assert.equal(native.week, 6);
  assert.ok(native.profiles.balanced.total > 0);
  assert.ok(native.profiles.floor.total <= native.profiles.ceiling.total);
  assert.equal(native.decisions.length, native.recommended.slots);
  assert.ok(native.decisions.every((row) => row.confidence >= 0 && row.confidence <= 1));
  assert.equal(native.model, "native-start-sit-v2-regret");
  assert.ok(native.regret.totalExpectedRegret >= 0);
  assert.ok(native.regret.averageExpectedRegret >= 0);
  assert.ok(native.regret.fragileDecisions >= 0);
  const alternatives = native.decisions.flatMap((row) => row.alternatives || []);
  assert.ok(alternatives.every((row) => row.expectedRegret >= 0));
  assert.ok(alternatives.every((row) => row.alternativeOutscoresProbability >= 0 && row.alternativeOutscoresProbability <= 1));
  assert.ok(native.decisions.every((row) => row.expectedRegret >= 0 && row.fragility >= 0 && row.fragility <= 1));
});

test("native correlated season simulation exposes downside and upside", async () => {
  const native = (await pool.run("season-simulate", {
    roster: representativeRoster(),
    settings,
    startWeek: 1,
    endWeek: 17,
    simulations: 2_500,
    seed: 2026,
  }, { timeoutMs: 60_000 })).data;
  assert.equal(native.weeks.length, 17);
  assert.ok(native.p10 < native.median);
  assert.ok(native.median < native.p90);
  assert.ok(native.cvar10 <= native.p10);
  assert.ok(native.coefficientOfVariation > 0);
});

test("native league simulation produces coherent playoff probabilities", async () => {
  const teams = Array.from({ length: 4 }, (_, index) => ({
    teamId: String(index + 1),
    name: `Team ${index + 1}`,
    roster: representativeRoster(index * 4),
  }));
  const native = (await pool.run("league-simulate", {
    teams,
    settings: { ...settings, teams: 4 },
    startWeek: 1,
    regularSeasonEnd: 14,
    championshipWeek: 17,
    playoffTeams: 4,
    simulations: 1_500,
    seed: 2026,
  }, { timeoutMs: 60_000 })).data;
  assert.equal(native.teams.length, 4);
  const championshipTotal = native.teams.reduce(
    (sum, team) => sum + team.championshipProbability,
    0,
  );
  assert.ok(Math.abs(championshipTotal - 1) <= 0.01);
  assert.ok(native.teams.every((team) => (
    team.playoffProbability >= 0 &&
    team.playoffProbability <= 1 &&
    team.allPlayWinPct >= 0 &&
    team.allPlayWinPct <= 1
  )));
});

test("native league simulation preserves current standings and exact league rules", async () => {
  const teams = Array.from({ length: 4 }, (_, index) => ({
    teamId: String(index + 1),
    name: `Team ${index + 1}`,
    roster: representativeRoster(index * 4),
    standing: {
      wins: 8 - index,
      losses: 4 + index,
      ties: index === 0 ? 1 : 0,
      pointsFor: 1400 - index * 75,
    },
  }));
  const result = (await pool.run("league-simulate", {
    teams,
    settings: { ...settings, teams: 4 },
    startWeek: 14,
    regularSeasonEnd: 14,
    championshipWeek: 16,
    playoffTeams: 4,
    playoffByes: 0,
    medianGame: true,
    simulations: 2_000,
    seed: 411,
  }, { timeoutMs: 60_000 })).data;
  const first = result.teams.find((team) => team.teamId === "1");
  assert.equal(result.model, "native-league-monte-carlo-v2-exact-state");
  assert.equal(result.playoffByes, 0);
  assert.equal(result.medianGame, true);
  assert.equal(first.currentWins, 8.5);
  assert.equal(first.currentPoints, 1400);
  assert.ok(first.expectedWins >= first.currentWins);
  assert.ok(first.futureExpectedWins >= 0 && first.futureExpectedWins <= 2);
  assert.ok(first.expectedPoints > first.currentPoints);
  assert.ok(Math.abs(first.futureExpectedPoints - (first.expectedPoints - first.currentPoints)) <= 0.02);
});

test("native lookup-noise draft mode preserves Monte Carlo probabilities", async () => {
  const state = core.createDraftState(settings);
  const payload = {
    players,
    state,
    settings,
    targetTeamId: 6,
    simulations: 10_000,
    seed: 2026,
    trackLimit: 140,
  };
  const exact = core.simulatePickWindow(payload);
  const fast = (await pool.run("draft-simulate", payload)).data;
  const ids = Object.keys(exact.availabilityById);
  const differences = ids.map((id) => Math.abs(
    exact.availabilityById[id] - fast.availabilityById[id],
  ));
  const meanDifference = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  assert.ok(meanDifference < 0.01, `mean probability drift ${meanDifference}`);
  assert.ok(Math.max(...differences) < 0.04);
  assert.equal(fast.noiseMode, "lookup");
});

test("native workers reuse the preloaded player dataset", async () => {
  const result = await pool.run("draft-simulate", {
    players,
    state: core.createDraftState(settings),
    settings,
    targetTeamId: 6,
    simulations: 500,
    seed: 2026,
    trackLimit: 100,
  }, { useDataset: true });
  assert.equal(result.engine, "oracle-native");
  assert.equal(result.data.simulations, 500);
  const stats = pool.stats();
  assert.equal(stats.readyWorkers, 1);
  assert.ok(stats.datasetLoads >= 1);
  assert.ok(stats.datasetKey);
});

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for native worker state");
}

test("restarted native workers reload the current dataset", async () => {
  const restartsBefore = pool.stats().restarts;
  pool.slots[0].child.kill();
  await waitFor(() => (
    pool.stats().restarts > restartsBefore &&
    pool.stats().readyWorkers === 1
  ));
  const result = await pool.run("draft-simulate", {
    players,
    state: core.createDraftState(settings),
    settings,
    targetTeamId: 6,
    simulations: 250,
    seed: 2027,
  }, { useDataset: true });
  assert.equal(result.data.simulations, 250);
  assert.ok(pool.stats().datasetLoads >= 2);
});
