const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const core = require("../app-core.js");
const { WorkerPool } = require("../server/worker-pool.js");

const settings = core.cloneSettings({
  teams: 4,
  rounds: 5,
  draftPosition: 2,
  scoring: "ppr",
  slots: {
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    FLEX: 1,
    SUPERFLEX: 0,
    DST: 0,
    K: 0,
    BN: 4,
  },
});

test("worker pool executes deterministic draft simulation off the main thread", async () => {
  const pool = new WorkerPool({
    workerFile: path.join(__dirname, "..", "server", "compute-worker.js"),
    size: 1,
    maxQueue: 4,
    taskTimeoutMs: 10_000,
    logger: { warn() {} },
  }).start();
  try {
    const result = await pool.run("draft-simulate", {
      players: bundled.players.slice(0, 80),
      state: core.createDraftState(settings),
      settings,
      targetTeamId: 2,
      simulations: 200,
      seed: 2026,
      trackLimit: 60,
    });
    assert.equal(result.data.simulations, 200);
    assert.equal(result.data.targetTeamId, 2);
    assert.ok(result.computeMs >= 0);
    Object.values(result.data.availabilityById).forEach((probability) => {
      assert.ok(probability >= 0 && probability <= 1);
    });
    assert.equal(pool.stats().completed, 1);
  } finally {
    await pool.close();
  }
});
