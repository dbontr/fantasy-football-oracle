"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const { FreeIntelligence } = require("../server/free-intelligence.js");
const { applyProjectionModel } = require("../server/projection-model.js");
const { forecastPlayer } = require("../server/probabilistic-forecast.js");
const { EvidenceStore } = require("../server/evidence-store.js");

const dataset = applyProjectionModel(sourceDataset);
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

async function createService(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-free-intelligence-"));
  const evidence = new EvidenceStore({
    filePath: path.join(directory, "evidence.jsonl"),
    clock: () => NOW,
  });
  await evidence.initialize();
  const ingested = [];
  const advanced = {
    evidence,
    async ingestEvidence(rows) {
      ingested.push(...rows);
      const results = await evidence.ingestMany(rows);
      return {
        accepted: results.filter((row) => row.inserted).length,
        duplicates: results.filter((row) => row.duplicate).length,
      };
    },
  };
  let cacheStatusCalls = 0;
  const cache = {
    status() {
      cacheStatusCalls += 1;
      return { version: "fixture", sources: {}, digest: "c".repeat(64) };
    },
    async fetchJson() { throw new Error("Network should not be called during initialization"); },
    async fetchBuffer() { throw new Error("Network should not be called during initialization"); },
  };
  const service = new FreeIntelligence({
    datasetProvider: () => dataset,
    advancedIntelligence: advanced,
    runtimeDir: path.join(directory, "free"),
    cache,
    enabledSources: options.enabledSources || [],
    syncEnabled: options.syncEnabled || false,
    clock: () => NOW,
    logger: { warn() {}, error() {} },
  });
  await service.initialize();
  return { directory, service, evidence, ingested, cacheStatusCalls: () => cacheStatusCalls };
}

async function cleanup(context) {
  await context.service.stop();
  await context.evidence.stop();
  await fs.rm(context.directory, { recursive: true, force: true });
}

test("free intelligence initializes without network and loads approved calibration", async () => {
  const context = await createService();
  try {
    const status = context.service.status();
    assert.equal(status.initialized, true);
    assert.equal(status.networkAtStartup, false);
    assert.equal(status.sync.enabled, false);
    assert.deepEqual(status.sync.enabledSources, []);
    assert.equal(status.calibration.ready, true);
    assert.equal(status.calibration.approved, true);
    assert.equal(status.calibration.valid, true);
    assert.equal(status.journal.valid, true);
    assert.equal(context.cacheStatusCalls() > 0, true);
  } finally {
    await cleanup(context);
  }
});

test("free intelligence applies the approved calibration before journaling", async () => {
  const context = await createService();
  try {
    const player = dataset.players.find((row) => row.position === "WR" && row.weeklyProjections[0] > 0);
    const raw = forecastPlayer(player, context.evidence, {
      week: 1,
      asOf: new Date(NOW).toISOString(),
    });
    const calibrated = context.service.calibrateForecast(raw);
    assert.equal(calibrated.calibration.applied, true);
    assert.equal(calibrated.calibration.modelDigest.length, 64);
    assert.notEqual(calibrated.distribution.mean, raw.distribution.mean);

    const recorded = await context.service.recordForecasts([calibrated], {
      week: 1,
      asOf: calibrated.asOf,
      evidenceHead: context.evidence.status().headHash,
      forecastDigest: "d".repeat(64),
    });
    assert.equal(recorded[0].inserted, true);
    assert.equal(context.service.status().journal.forecasts, 1);
    assert.equal(context.service.journalReport().summary.samples, 0);
  } finally {
    await cleanup(context);
  }
});

test("free intelligence isolates optional provider failures", async () => {
  const context = await createService({ enabledSources: ["sleeper", "nflverse"] });
  try {
    context.service.sleeper = {
      async sync() {
        return {
          syncedAt: new Date(NOW).toISOString(),
          stale: false,
          state: { season: "2026", week: 3 },
          players: { received: 1, matched: 1, unresolved: [], identity: {} },
          trends: { adds: [], drops: [] },
          observations: [{
            entityType: "player",
            entityId: String(dataset.players[0].id),
            feature: "market.roster_momentum",
            value: 0.5,
            source: { name: "fixture", reliability: 0.8 },
            confidence: 0.8,
            observedAt: new Date(NOW).toISOString(),
          }],
          league: null,
          attribution: { name: "Sleeper" },
        };
      },
    };
    context.service.nflverse = {
      async sync() {
        throw Object.assign(new Error("fixture outage"), { code: "FIXTURE_OUTAGE" });
      },
    };
    const result = await context.service.sync({ providers: ["sleeper", "nflverse"] });
    assert.equal(result.successes, 1);
    assert.equal(result.failures, 1);
    assert.equal(result.providers.sleeper.ok, true);
    assert.equal(result.providers.sleeper.evidence.accepted, 1);
    assert.equal(result.providers.nflverse.ok, false);
    assert.equal(result.providers.nflverse.error.code, "FIXTURE_OUTAGE");
    assert.equal(context.ingested.length, 1);
    assert.equal(context.service.status().sync.last.failures, 1);
  } finally {
    await cleanup(context);
  }
});

test("free intelligence refuses unenabled and unsupported sources", async () => {
  const context = await createService({ enabledSources: ["sleeper"] });
  try {
    await assert.rejects(
      () => context.service.sync({ providers: ["nflverse"] }),
      { code: "FREE_SOURCE_DISABLED" },
    );
    await assert.rejects(
      () => context.service.sync({ providers: ["unknown"] }),
      { code: "FREE_SOURCE_UNSUPPORTED" },
    );
  } finally {
    await cleanup(context);
  }
});
