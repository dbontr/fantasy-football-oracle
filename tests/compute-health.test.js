"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeComputeStats,
} = require("../server/platform-control-plane.js");

test("normalizes hybrid native compute stats", () => {
  const result = normalizeComputeStats({
    mode: "native-cpp-primary",
    native: {
      available: true,
      engine: "oracle-native",
      engineVersion: "1.1.0",
      workers: 4,
      readyWorkers: 4,
      busy: 1,
      queued: 2,
      completed: 8,
      failed: 0,
    },
    fallback: { workers: 4 },
    nativeFailures: 1,
    fallbackRuns: 2,
  });
  assert.equal(result.mode, "native-cpp-primary");
  assert.equal(result.nativeAvailable, true);
  assert.equal(result.engine, "oracle-native");
  assert.equal(result.engineVersion, "1.1.0");
  assert.equal(result.workers, 4);
  assert.equal(result.readyWorkers, 4);
  assert.equal(result.busy, 1);
  assert.equal(result.queued, 2);
  assert.equal(result.completed, 8);
  assert.equal(result.failed, 0);
  assert.equal(result.nativeFailures, 1);
  assert.equal(result.fallbackRuns, 2);
  assert.equal(result.fallbackWorkers, 4);
});

test("preserves legacy flat compute stats", () => {
  const result = normalizeComputeStats({
    workers: 2,
    busy: 0,
    queued: 0,
    completed: 3,
    failed: 0,
  });

  assert.equal(result.nativeAvailable, null);
  assert.equal(result.workers, 2);
  assert.equal(result.readyWorkers, 2);
  assert.equal(result.completed, 3);
});
