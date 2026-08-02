"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { REQUIRED_NATIVE_TASKS } = require("../native/capabilities.js");
const { NativeEnginePool } = require("../server/native-engine-pool.js");
const { restartDelay } = require("../server/restart-policy.js");
const { WorkerPool } = require("../server/worker-pool.js");

function fakeTimers() {
  const timers = new Set();
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    run(timer) {
      timers.delete(timer);
      timer.callback();
    },
  };
}

class FakeWorker extends EventEmitter {
  postMessage(message) { this.lastMessage = message; }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

function validCapabilities() {
  return JSON.stringify({
    engine: "oracle-native",
    language: "C++20",
    protocol: 1,
    tasks: REQUIRED_NATIVE_TASKS,
    version: "test",
  });
}

test("restart delay grows exponentially and remains bounded", () => {
  assert.equal(restartDelay(1, { baseMs: 10, maxMs: 40 }), 10);
  assert.equal(restartDelay(2, { baseMs: 10, maxMs: 40 }), 20);
  assert.equal(restartDelay(3, { baseMs: 10, maxMs: 40 }), 40);
  assert.equal(restartDelay(10, { baseMs: 10, maxMs: 40 }), 40);
});

test("worker exits schedule backoff even when the exit code is zero", async () => {
  const timers = fakeTimers();
  const workers = [];
  const pool = new WorkerPool({
    workerFile: "unused",
    size: 1,
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    restartBaseDelayMs: 10,
    restartMaxDelayMs: 40,
    logger: { warn() {} },
  }).start();
  workers[0].emit("exit", 0);
  assert.equal(workers.length, 1);
  assert.equal(pool.stats().liveWorkers, 0);
  assert.equal(pool.stats().restartingWorkers, 1);
  const respawn = [...timers.timers][0];
  assert.equal(respawn.delay, 10);
  timers.run(respawn);
  assert.equal(workers.length, 2);
  assert.equal(pool.stats().liveWorkers, 1);
  await pool.close();
});

test("queued worker tasks time out while every worker is restarting", async () => {
  const timers = fakeTimers();
  const workers = [];
  const pool = new WorkerPool({
    workerFile: "unused",
    size: 1,
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    restartBaseDelayMs: 10,
    logger: { warn() {} },
  }).start();
  workers[0].emit("exit", 1);
  const pending = pool.run("test", {}, { timeoutMs: 1000 });
  const timeout = [...timers.timers].find((timer) => timer.delay === 1000);
  timers.run(timeout);
  await assert.rejects(pending, { code: "TASK_TIMEOUT" });
  assert.equal(pool.stats().queued, 0);
  await pool.close();
});

test("native pool rejects an invalid capability handshake", () => {
  let spawned = false;
  const pool = new NativeEnginePool({
    binary: __filename,
    spawnSync: () => ({ status: 0, stdout: "{}", stderr: "" }),
    spawn: () => { spawned = true; throw new Error("unexpected spawn"); },
    logger: { warn() {} },
  }).start();
  assert.equal(pool.available, false);
  assert.equal(spawned, false);
});

test("strict native integrity blocks a mismatched binary before probing", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-native-integrity-"));
  const binary = path.join(directory, "oracle-engine");
  const metadataPath = path.join(directory, "build-metadata.json");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(metadataPath, JSON.stringify({
    schemaVersion: 2,
    binaryDigest: "0".repeat(64),
  }));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let probed = false;
  const pool = new NativeEnginePool({
    binary,
    metadataPath,
    requireIntegrity: true,
    spawnSync: () => { probed = true; return { status: 0, stdout: validCapabilities() }; },
    logger: { warn() {} },
  }).start();
  assert.equal(pool.available, false);
  assert.equal(pool.stats().integrity.valid, false);
  assert.equal(probed, false);
});

test("native worker crashes enter backoff without immediate respawn", async () => {
  const timers = fakeTimers();
  const children = [];
  const pool = new NativeEnginePool({
    binary: __filename,
    size: 1,
    spawnSync: () => ({ status: 0, stdout: validCapabilities(), stderr: "" }),
    spawn() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    restartBaseDelayMs: 10,
    restartMaxDelayMs: 40,
    logger: { warn() {} },
  }).start();
  children[0].emit("exit", 0, null);
  assert.equal(children.length, 1);
  assert.equal(pool.stats().liveWorkers, 0);
  assert.equal(pool.stats().restartingWorkers, 1);
  const respawn = [...timers.timers][0];
  assert.equal(respawn.delay, 10);
  timers.run(respawn);
  assert.equal(children.length, 2);
  assert.equal(pool.stats().liveWorkers, 1);
  await pool.close();
});
