"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FreeCalibrationLoader,
  validateCalibrationDocument,
} = require("../server/free-calibration-loader.js");

const committed = require("../data/calibration/free-probabilistic.json");

test("committed free calibration is approved, leakage-safe, and digest valid", () => {
  const validation = validateCalibrationDocument(committed);
  assert.deepEqual(validation, { valid: true });
  const loader = new FreeCalibrationLoader();
  const status = loader.status();
  assert.equal(status.ready, true);
  assert.equal(status.valid, true);
  assert.equal(status.approved, true);
  assert.equal(status.holdoutSeason, 2025);
  assert.equal(status.validation.leakageSafe, true);
  assert.ok(status.validation.evaluation.improvement.wis > 0);
});

test("free calibration loader rejects altered model bytes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-calibration-loader-"));
  const filePath = path.join(directory, "calibration.json");
  try {
    const altered = structuredClone(committed);
    altered.groups.all.bias += 1;
    await fs.writeFile(filePath, `${JSON.stringify(altered, null, 2)}\n`);
    const loader = new FreeCalibrationLoader({ filePath });
    assert.throws(
      () => loader.load(),
      { code: "FREE_CALIBRATION_INVALID" },
    );
    const optional = loader.load({ optional: true });
    assert.equal(optional, null);
    assert.equal(loader.status().valid, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("missing calibration remains an explicit safe fallback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-calibration-missing-"));
  try {
    const loader = new FreeCalibrationLoader({ filePath: path.join(directory, "missing.json") });
    assert.equal(loader.load({ optional: true }), null);
    const status = loader.status();
    assert.equal(status.ready, false);
    assert.equal(status.approved, false);
    assert.equal(status.valid, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
