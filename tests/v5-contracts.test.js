"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sourceDataset = require("../data/players-2026.json");
const { EvidenceStore, normalizeObservation } = require("../server/evidence-store.js");
const { forecastRecord } = require("../server/forecast-journal.js");
const committedCalibration = require("../data/calibration/free-probabilistic.json");
const committedContextPolicy = require("../data/calibration/free-context-policy.json");
const { forecastPlayer } = require("../server/probabilistic-forecast.js");
const { applyProjectionModel } = require("../server/projection-model.js");
const { rankPairedActions } = require("../server/robust-decision.js");
const {
  SCHEMA_VERSIONS,
  registrySummary,
  validateRecord,
} = require("../server/schema-registry.js");

const NOW = "2026-08-02T17:00:00.000Z";
const dataset = applyProjectionModel(sourceDataset);
const player = dataset.players.find((row) => row.position === "WR");

test("v5 schema registry advertises temporal decision contracts", () => {
  const summary = registrySummary();
  assert.equal(summary.schemas.evidenceObservation, "evidence-observation/v1");
  assert.equal(summary.schemas.probabilisticForecast, "probabilistic-forecast/v1");
  assert.equal(summary.schemas.portfolioDecision, "portfolio-decision/v1");
  assert.equal(summary.schemas.probabilisticCalibration, "probabilistic-calibration/v1");
  assert.equal(summary.schemas.forecastJournalRecord, "forecast-journal-record/v1");
  assert.equal(summary.schemas.freeContextPolicy, "free-context-policy/v1");
});

test("normalized evidence satisfies the registered evidence schema", () => {
  const observation = normalizeObservation({
    entityType: "player",
    entityId: String(player.id),
    feature: "market.player_points",
    value: 20,
    source: { name: "contract-test", reliability: 0.9 },
    confidence: 0.9,
    observedAt: NOW,
  }, { now: Date.parse(NOW) });
  assert.equal(observation.schemaVersion, SCHEMA_VERSIONS.evidenceObservation);
  assert.deepEqual(validateRecord("evidenceObservation", observation), {
    valid: true,
    errors: [],
  });
});

test("probabilistic forecasts satisfy the registered forecast schema", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-contract-"));
  const store = new EvidenceStore({
    filePath: path.join(directory, "evidence.jsonl"),
    clock: () => Date.parse(NOW),
  });
  try {
    await store.initialize();
    const forecast = forecastPlayer(player, store, { week: 1, asOf: NOW });
    assert.equal(forecast.schemaVersion, SCHEMA_VERSIONS.probabilisticForecast);
    assert.deepEqual(validateRecord("probabilisticForecast", forecast), {
      valid: true,
      errors: [],
    });
  } finally {
    await store.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("robust portfolio decisions satisfy the registered decision schema", () => {
  const decision = rankPairedActions([
    { id: "alpha", samples: [8, 10, 12, 14, 16] },
    { id: "beta", samples: [5, 9, 13, 17, 21] },
  ], { riskAversion: 0.4 });
  assert.equal(decision.schemaVersion, SCHEMA_VERSIONS.portfolioDecision);
  assert.deepEqual(validateRecord("portfolioDecision", decision), {
    valid: true,
    errors: [],
  });

  const corrupted = {
    ...decision,
    preferredActionId: "missing",
  };
  const validation = validateRecord("portfolioDecision", corrupted);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("preferredActionId")));
});


test("approved free calibration satisfies the registered calibration schema", () => {
  assert.equal(
    committedCalibration.schemaVersion,
    SCHEMA_VERSIONS.probabilisticCalibration,
  );
  assert.deepEqual(validateRecord("probabilisticCalibration", committedCalibration), {
    valid: true,
    errors: [],
  });
});

test("approved free context policy satisfies the registered schema", () => {
  assert.equal(committedContextPolicy.schemaVersion, SCHEMA_VERSIONS.freeContextPolicy);
  assert.deepEqual(validateRecord("freeContextPolicy", committedContextPolicy), {
    valid: true, errors: [],
  });
});

test("forecast journal records satisfy the registered journal schema", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-journal-contract-"));
  const store = new EvidenceStore({
    filePath: path.join(directory, "evidence.jsonl"),
    clock: () => Date.parse(NOW),
  });
  try {
    await store.initialize();
    const forecast = forecastPlayer(player, store, { week: 1, asOf: NOW });
    const record = forecastRecord(forecast, {
      season: 2026,
      week: 1,
      asOf: NOW,
      createdAt: NOW,
      evidenceHead: "0".repeat(64),
      forecastDigest: "a".repeat(64),
    });
    assert.equal(record.schemaVersion, SCHEMA_VERSIONS.forecastJournalRecord);
    assert.deepEqual(validateRecord("forecastJournalRecord", record), {
      valid: true,
      errors: [],
    });
    const tampered = structuredClone(record);
    tampered.forecast.distribution.mean += 1;
    assert.equal(validateRecord("forecastJournalRecord", tampered).valid, false);
  } finally {
    await store.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
