"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  createShutdownController,
  installShutdownFileWatcher,
  installSignalHandlers,
} = require("../server/lifecycle.js");

test("shutdown is idempotent and closes the server once", async () => {
  let closes = 0;
  const processRef = { exitCode: null, exit() { throw new Error("unexpected exit"); } };
  const server = {
    log: { info() {}, error() {} },
    async close() { closes += 1; },
  };
  const shutdown = createShutdownController({ server, processRef });
  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  assert.equal(first, second);
  assert.deepEqual(await first, { closed: true, signal: "SIGTERM" });
  assert.equal(closes, 1);
  assert.equal(processRef.exitCode, 0);
});

test("shutdown timeout fails closed and forces exit", async () => {
  const forced = [];
  const processRef = { exitCode: null };
  const server = {
    log: { info() {}, error() {} },
    close: () => new Promise(() => {}),
  };
  const shutdown = createShutdownController({
    server,
    processRef,
    timeoutMs: 5,
    setTimer(callback) {
      queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimer() {},
    forceExit: (code) => forced.push(code),
  });
  await assert.rejects(shutdown("SIGTERM"), { code: "SHUTDOWN_TIMEOUT" });
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(forced, [1]);
});

test("signal handlers delegate once and can be removed", async () => {
  const processRef = new EventEmitter();
  const signals = [];
  const remove = installSignalHandlers({
    processRef,
    shutdown: async (signal) => signals.push(signal),
  });
  processRef.emit("SIGINT");
  processRef.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ["SIGINT"]);
  remove();
  processRef.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ["SIGINT"]);
});
test("shutdown close failures force process termination", async () => {
  const forced = [];
  const processRef = { exitCode: null };
  const failure = Object.assign(new Error("close failed"), { code: "CLOSE_FAILED" });
  const server = {
    log: { info() {}, error() {} },
    async close() { throw failure; },
  };
  const shutdown = createShutdownController({
    server,
    processRef,
    forceExit: (code) => forced.push(code),
  });
  await assert.rejects(shutdown("SIGTERM"), { code: "CLOSE_FAILED" });
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(forced, [1]);
});

test("shutdown request files trigger one graceful shutdown", async () => {
  let timerCallback = null;
  const removed = [];
  const signals = [];
  const stop = installShutdownFileWatcher({
    filePath: "C:\\oracle\\shutdown.request",
    shutdown: async (signal) => signals.push(signal),
    fsRef: {
      async stat() { return { size: 1 }; },
      async rm(filePath) { removed.push(filePath); },
    },
    setIntervalRef(callback) {
      timerCallback = callback;
      return { unref() {} };
    },
    clearIntervalRef() { timerCallback = null; },
  });
  timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, ["C:\\oracle\\shutdown.request"]);
  assert.deepEqual(signals, ["shutdown-request"]);
  stop();
  assert.equal(timerCallback, null);
});
