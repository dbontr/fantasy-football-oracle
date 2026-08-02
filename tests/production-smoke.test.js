"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateHealth,
  validateReadiness,
} = require("../scripts/smoke-production.js");

test("production smoke accepts a strict native-ready service", () => {
  assert.doesNotThrow(() => validateReadiness({
    ready: true,
    status: "ready",
    dataReady: true,
    nativeRequired: true,
    nativeAvailable: true,
    readyWorkers: 4,
    strictArtifacts: true,
    artifactValid: true,
    eventChainValid: true,
    failures: [],
  }));
  assert.doesNotThrow(() => validateHealth({
    status: "ok",
    compute: { native: { available: true, readyWorkers: 4 } },
    platform: { artifacts: { strict: true, valid: true } },
  }, { requireStrict: true }));
});
test("production smoke rejects degraded readiness", () => {
  assert.throws(() => validateReadiness({
    ready: false,
    status: "not-ready",
    failures: ["event-chain-invalid"],
  }), /event-chain-invalid/);
});

test("production smoke rejects non-strict or native-unavailable health", () => {
  assert.throws(() => validateHealth({
    status: "ok",
    compute: { native: { available: false, readyWorkers: 0 } },
    platform: { artifacts: { strict: false, valid: true } },
  }, { requireStrict: true }), /native engine/i);
});
