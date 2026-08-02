"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readinessSnapshot } = require("../server/api.js");

function services(overrides = {}) {
  return {
    config: {
      nativeRequired: true,
      strictArtifactIntegrity: true,
      ...overrides.config,
    },
    dataStore: {
      getStatus: () => ({ ready: true, players: 700, source: "test" }),
      ...overrides.dataStore,
    },
    pool: {
      stats: () => ({
        mode: "native-cpp-primary",
        native: { available: true, workers: 4, liveWorkers: 4, readyWorkers: 4 },
      }),
      ...overrides.pool,
    },
    controlPlane: {
      artifacts: { status: () => ({ valid: true }) },
      eventStore: { status: () => ({ valid: true }) },
      ...overrides.controlPlane,
    },
  };
}
test("readiness is healthy when required dependencies are healthy", () => {
  const result = readinessSnapshot(services());
  assert.deepEqual(result, {
    ready: true,
    status: "ready",
    dataReady: true,
    players: 700,
    dataSource: "test",
    nativeRequired: true,
    nativeAvailable: true,
    liveWorkers: 4,
    readyWorkers: 4,
    strictArtifacts: true,
    artifactValid: true,
    eventChainValid: true,
    failures: [],
  });
});

test("readiness remains healthy while every native worker is busy", () => {
  const result = readinessSnapshot(services({
    pool: { stats: () => ({
      mode: "native-cpp-primary",
      native: { available: true, workers: 4, liveWorkers: 4, readyWorkers: 0, busy: 4 },
    }) },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.readyWorkers, 0);
  assert.deepEqual(result.failures, []);
});

test("readiness fails when native compute is required but unavailable", () => {
  const result = readinessSnapshot(services({
    pool: { stats: () => ({ mode: "javascript-fallback", native: { available: false, workers: 0, liveWorkers: 0, readyWorkers: 0 } }) },
  }));
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("native-compute-unavailable"));
});


test("readiness fails when configured native workers are not live", () => {
  const result = readinessSnapshot(services({
    pool: { stats: () => ({
      mode: "native-cpp-primary",
      native: { available: true, workers: 4, liveWorkers: 0, readyWorkers: 0 },
    }) },
  }));
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("native-compute-unavailable"));
});
test("readiness fails when strict artifact integrity is invalid", () => {
  const result = readinessSnapshot(services({
    controlPlane: { artifacts: { status: () => ({ valid: false }) }, eventStore: { status: () => ({ valid: true }) } },
  }));
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("artifact-integrity-invalid"));
});
test("readiness fails for invalid event chain or unavailable data", () => {
  const result = readinessSnapshot(services({
    dataStore: { getStatus: () => ({ ready: false, players: 0, source: "none" }) },
    controlPlane: { artifacts: { status: () => ({ valid: true }) }, eventStore: { status: () => ({ valid: false }) } },
  }));
  assert.equal(result.ready, false);
  assert.ok(result.failures.includes("player-data-unavailable"));
  assert.ok(result.failures.includes("event-chain-invalid"));
});

test("fallback compute is ready when native is not required", () => {
  const result = readinessSnapshot(services({
    config: { nativeRequired: false },
    pool: { stats: () => ({ mode: "javascript-fallback", native: { available: false, workers: 0, liveWorkers: 0, readyWorkers: 0 } }) },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.nativeAvailable, false);
});
