"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArguments,
  probeNativeBinary,
  productionPolicyChecks,
  summarizeChecks,
  writableDirectoryCheck,
} = require("../scripts/oracle-doctor.js");

function config(overrides = {}) {
  return {
    nativeRequired: true,
    strictArtifactIntegrity: true,
    trustProxy: false,
    adminToken: "",
    ...overrides,
  };
}

test("production policy accepts strict native configuration", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const checks = productionPolicyChecks(config(), { strict: true });
    assert.equal(checks.every((check) => check.status === "pass"), true);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("production policy rejects unsafe proxy and relaxed integrity", () => {
  const previous = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const checks = productionPolicyChecks(config({
      nativeRequired: false,
      strictArtifactIntegrity: false,
      trustProxy: true,
      adminToken: "",
    }), { strict: true });
    const failures = checks.filter((check) => check.status === "fail").map((check) => check.id);
    assert.deepEqual(failures, [
      "config.native-required",
      "config.strict-artifacts",
      "config.proxy-admin-token",
      "config.node-environment",
    ]);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("native capability probe validates engine identity", () => {
  const spawnSync = () => ({
    status: 0,
    stdout: JSON.stringify({ engine: "oracle-native", version: "1.1.0" }),
    stderr: "",
  });
  assert.deepEqual(probeNativeBinary("oracle-engine", { spawnSync }), {
    ok: true,
    capabilities: { engine: "oracle-native", version: "1.1.0" },
  });
  const wrong = probeNativeBinary("oracle-engine", {
    spawnSync: () => ({ status: 0, stdout: '{"engine":"other"}', stderr: "" }),
  });
  assert.equal(wrong.ok, false);
});

test("doctor argument parsing and summary are deterministic", () => {
  assert.deepEqual(parseArguments([
    "--strict", "--allow-dirty", "--json", "--root=C:\\oracle",
  ]), {
    strict: true,
    allowDirty: true,
    json: true,
    rootDir: "C:\\oracle",
  });
  assert.deepEqual(summarizeChecks([
    { status: "pass" },
    { status: "warn" },
    { status: "fail" },
    { status: "pass" },
  ]), { pass: 2, warn: 1, fail: 1 });
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("writable directory check creates and cleans its marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-doctor-"));
  const target = path.join(root, "nested", "runtime");
  try {
    const check = await writableDirectoryCheck(target);
    assert.equal(check.ok, true);
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
