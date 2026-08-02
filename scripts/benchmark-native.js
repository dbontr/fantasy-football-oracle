"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const core = require("../app-core.js");
const { NativeEnginePool } = require("../server/native-engine-pool.js");
const { WorkerPool } = require("../server/worker-pool.js");

const root = path.resolve(__dirname, "..");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "data", "players-2026.json"), "utf8"));
const players = dataset.players.map(core.normalizePlayer);
const binary = path.join(root, "native", "bin", process.platform === "win32"
  ? "oracle-engine.exe"
  : "oracle-engine");
const settings = core.cloneSettings({ teams: 12, rounds: 16, draftPosition: 6 });

function roster(offset = 0) {
  const rows = [];
  for (const [position, count] of [["QB", 2], ["RB", 4], ["WR", 4], ["TE", 2], ["DST", 1], ["K", 1]]) {
    rows.push(...players
      .filter((player) => player.position === position)
      .sort((left, right) => left.pprRank - right.pprRank)
      .slice(offset, offset + count));
  }
  return rows;
}

async function measure(pool, type, payload, runs = 3, options = {}) {
  await pool.run(type, payload, options);
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const result = await pool.run(type, payload, options);
    samples.push({ wallMs: performance.now() - started, computeMs: result.computeMs });
  }
  const average = (key) => samples.reduce((sum, row) => sum + row[key], 0) / samples.length;
  return { wallMs: average("wallMs"), computeMs: average("computeMs"), samples };
}

async function main() {
  const native = new NativeEnginePool({
    binary,
    size: 1,
    maxQueue: 8,
    taskTimeoutMs: 120_000,
    logger: { warn() {} },
  }).start();
  const javascript = new WorkerPool({
    workerFile: path.join(root, "server", "compute-worker.js"),
    size: 1,
    maxQueue: 8,
    taskTimeoutMs: 120_000,
    logger: { warn() {} },
  }).start();
  await native.setDataset(
    dataset.meta?.modelDigest || dataset.meta?.generatedAt || "benchmark-dataset",
    players,
  );
  const draft = {
    players,
    state: core.createDraftState(settings),
    settings,
    targetTeamId: 6,
    simulations: 15_000,
    seed: 2026,
    trackLimit: 220,
  };
  const draftRecommend = {
    players,
    state: draft.state,
    settings,
    targetTeamId: 6,
    limit: 260,
    simulation: { ...draft },
  };
  const userRoster = roster(0);
  const opponentRoster = roster(5);
  const trades = {
    userRoster,
    opponentRoster,
    players,
    settings,
    week: 6,
    limit: 20,
    assetLimit: 12,
    includeTwoForTwo: true,
  };
  const waiverRoster = roster(8);
  const unavailable = new Set(waiverRoster.map((player) => player.id));
  const waivers = {
    roster: waiverRoster,
    freeAgents: players.filter((player) => !unavailable.has(player.id)).slice(0, 160),
    settings,
    week: 6,
    limit: 15,
    budgetRemaining: 100,
    weeksRemaining: 12,
    aggressiveness: 0.6,
  };

  try {
    const results = {
      generatedAt: new Date().toISOString(),
      system: { platform: process.platform, architecture: process.arch },
      draft15000: {
        native: await measure(native, "draft-simulate", draft, 3, { useDataset: true }),
        javascript: await measure(javascript, "draft-simulate", draft, 3),
      },
      draftRecommendations: {
        native: await measure(native, "draft-recommend", draftRecommend, 3, { useDataset: true }),
        javascript: await measure(javascript, "draft-recommend", draftRecommend, 3),
      },
      deepTrades: {
        native: await measure(native, "trades-generate", trades, 3, {
          timeoutMs: 120_000,
          useDataset: true,
        }),
        javascript: await measure(javascript, "trades-generate", trades, 3, { timeoutMs: 120_000 }),
      },
      waivers: {
        native: await measure(native, "waivers", waivers, 5),
        javascript: await measure(javascript, "waivers", waivers, 5),
      },
      season25000: await measure(native, "season-simulate", {
        roster: userRoster,
        settings,
        startWeek: 1,
        endWeek: 17,
        simulations: 25_000,
        seed: 2026,
      }, 3, { timeoutMs: 120_000 }),
    };
    for (const key of ["draft15000", "draftRecommendations", "deepTrades", "waivers"]) {
      results[key].speedup = Number((
        results[key].javascript.wallMs / results[key].native.wallMs
      ).toFixed(2));
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await Promise.all([native.close(), javascript.close()]);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
