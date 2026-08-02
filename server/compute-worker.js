"use strict";

const { parentPort } = require("node:worker_threads");
const core = require("../app-core.js");

if (!parentPort) throw new Error("Compute worker requires a parent port");

function runTask(type, payload = {}) {
  if (type === "draft-simulate") {
    return core.simulatePickWindow(payload);
  }
  if (type === "draft-recommend") {
    const simulation = core.simulatePickWindow(payload.simulation);
    const recommendations = core.advancedDraftRecommendations(
      payload.players,
      payload.state,
      payload.settings,
      payload.targetTeamId,
      payload.limit || 60,
      simulation,
    );
    return { simulation, recommendations };
  }
  if (type === "roster-analyze") {
    return core.analyzeRoster(payload);
  }
  if (type === "waivers") {
    return core.waiverRecommendations(
      payload.roster,
      payload.freeAgents,
      payload.settings,
      payload.limit,
      payload.week,
    );
  }
  if (type === "trade-analyze") {
    return core.analyzeTrade(payload);
  }
  if (type === "trades-generate") {
    return core.generateTradeProposals(payload);
  }
  throw new Error(`Unknown compute task: ${type}`);
}

parentPort.on("message", (message) => {
  const startedAt = performance.now();
  try {
    const result = runTask(message.type, message.payload);
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: {
        data: result,
        computeMs: Number((performance.now() - startedAt).toFixed(2)),
      },
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      code: error?.code || "COMPUTE_FAILED",
      error: error?.message || String(error),
    });
  }
});
