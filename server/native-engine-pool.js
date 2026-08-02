"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");

const { parseNativeCapabilities } = require("../native/capabilities.js");
const { verifyNativeBinaryIntegrity } = require("../native/integrity.js");
const { restartDelay } = require("./restart-policy.js");

class NativeEnginePool {
  constructor(options = {}) {
    this.binary = options.binary;
    this.metadataPath = options.metadataPath || (
      this.binary ? path.join(path.dirname(this.binary), "build-metadata.json") : null
    );
    this.requireIntegrity = options.requireIntegrity === true;
    this.size = Math.max(1, Number(options.size || 1));
    this.maxQueue = Math.max(1, Number(options.maxQueue || 64));
    this.taskTimeoutMs = Math.max(1000, Number(options.taskTimeoutMs || 45_000));
    this.log = options.logger || console;
    this.spawnProcess = options.spawn || spawn;
    this.probeProcess = options.spawnSync || spawnSync;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || Date.now;
    this.restartBaseDelayMs = Math.max(1, Number(options.restartBaseDelayMs || 250));
    this.restartMaxDelayMs = Math.max(
      this.restartBaseDelayMs,
      Number(options.restartMaxDelayMs || 30_000),
    );
    this.restartResetMs = Math.max(1000, Number(options.restartResetMs || 30_000));
    this.closeTimeoutMs = Math.max(100, Number(options.closeTimeoutMs || 3_000));
    this.slots = [];
    this.queue = [];
    this.nextTaskId = 1;
    this.closed = false;
    this.available = false;
    this.capabilities = null;
    this.integrity = { required: this.requireIntegrity, valid: null, reason: null };
    this.dataset = null;
    this.completed = 0;
    this.failed = 0;
    this.restarts = 0;
    this.datasetLoads = 0;
  }

  start() {
    if (this.slots.length || this.closed) return this;
    if (!this.binary || !fs.existsSync(this.binary)) return this;

    const integrity = verifyNativeBinaryIntegrity(this.binary, this.metadataPath);
    this.integrity = {
      required: this.requireIntegrity,
      valid: integrity.valid,
      reason: integrity.valid ? null : integrity.reason,
      binaryDigest: integrity.binaryDigest || null,
    };
    if (this.requireIntegrity && !integrity.valid) {
      this.log.warn?.(
        { binary: this.binary, metadataPath: this.metadataPath, reason: integrity.reason },
        "Native engine integrity verification failed",
      );
      return this;
    }

    const probe = this.probeProcess(this.binary, ["--capabilities"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (probe.status !== 0) {
      this.log.warn?.({ stderr: probe.stderr, binary: this.binary }, "Native engine probe failed");
      return this;
    }
    try {
      this.capabilities = parseNativeCapabilities(probe.stdout);
      this.available = true;
    } catch (error) {
      this.log.warn?.({ error, binary: this.binary }, "Native engine capabilities were invalid");
      return this;
    }

    for (let index = 0; index < this.size; index += 1) {
      const slot = {
        index,
        generation: 0,
        child: null,
        reader: null,
        task: null,
        ready: true,
        datasetKey: null,
        respawnTimer: null,
        restartAttempts: 0,
        startedAt: null,
      };
      this.slots.push(slot);
      this.spawn(slot, { throwOnFailure: true });
    }
    return this;
  }

  spawn(slot, options = {}) {
    if (this.closed || !this.available) return;
    if (slot.respawnTimer) {
      this.clearTimer(slot.respawnTimer);
      slot.respawnTimer = null;
    }
    const generation = ++slot.generation;
    let child;
    try {
      child = this.spawnProcess(this.binary, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      slot.child = null;
      if (options.throwOnFailure) throw error;
      this.scheduleRespawn(slot, error, { increment: true });
      return;
    }
    slot.child = child;
    slot.startedAt = this.now();
    slot.ready = !this.dataset;
    slot.datasetKey = null;
    slot.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    slot.reader.on("line", (line) => {
      if (slot.generation !== generation || !line.trim()) return;
      try {
        this.handleMessage(slot, JSON.parse(line));
      } catch (error) {
        this.replace(slot, Object.assign(new Error("Native engine returned invalid JSON"), {
          code: "NATIVE_PROTOCOL_ERROR",
          cause: error,
        }));
      }
    });
    child.stderr.on("data", (chunk) => {
      this.log.warn?.({ worker: slot.index, stderr: String(chunk).trim() }, "Native engine stderr");
    });
    child.on("error", (error) => {
      if (slot.generation === generation) this.replace(slot, error);
    });
    child.on("exit", (code, signal) => {
      if (slot.generation !== generation || this.closed) return;
      const error = Object.assign(
        new Error(`Native engine exited with code ${code ?? "null"} signal ${signal ?? "none"}`),
        { code: "NATIVE_ENGINE_EXIT" },
      );
      this.replace(slot, error);
    });
    if (this.dataset) this.enqueueDatasetLoad(slot);
  }

  createTask(type, payload, options = {}) {
    return {
      id: this.nextTaskId++,
      type,
      payload,
      targetSlot: Number.isInteger(options.slotIndex) ? options.slotIndex : null,
      timeoutMs: Math.max(1000, Number(options.timeoutMs || this.taskTimeoutMs)),
      queuedAt: this.now(),
      timer: null,
      settled: false,
    };
  }

  enqueueTask(task, front = false) {
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      task.timer = this.setTimer(() => this.expireTask(task), task.timeoutMs);
      if (front) this.queue.unshift(task);
      else this.queue.push(task);
      this.dispatch();
    });
  }

  run(type, payload, options = {}) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error("Native engine pool is closed"), {
        code: "NATIVE_POOL_CLOSED",
      }));
    }
    if (!this.available) {
      return Promise.reject(Object.assign(new Error("Native engine is unavailable"), {
        code: "NATIVE_UNAVAILABLE",
      }));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(Object.assign(new Error("Native compute queue is full"), {
        code: "QUEUE_FULL",
      }));
    }
    let taskPayload = payload;
    if (options.useDataset === true && this.dataset?.key) {
      taskPayload = { ...payload, datasetKey: this.dataset.key };
      delete taskPayload.players;
      if (taskPayload.simulation?.players) {
        taskPayload.simulation = { ...taskPayload.simulation };
        delete taskPayload.simulation.players;
      }
    }
    return this.enqueueTask(
      this.createTask(type, taskPayload, options),
      options.front === true,
    );
  }

  expireTask(task) {
    if (task.settled) return;
    const queuedIndex = this.queue.indexOf(task);
    const error = Object.assign(new Error(`Native task ${task.type} timed out`), {
      code: "TASK_TIMEOUT",
    });
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.failed += 1;
      this.settleTask(task, "reject", error);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.task === task);
    if (slot) this.replace(slot, error);
  }

  settleTask(task, method, value) {
    if (!task || task.settled) return;
    task.settled = true;
    if (task.timer) this.clearTimer(task.timer);
    task.timer = null;
    task[method](value);
  }

  async setDataset(key, players) {
    if (!this.available) return { loaded: false, reason: "native-unavailable" };
    if (!key || !Array.isArray(players) || !players.length) {
      throw new TypeError("Native dataset requires a key and non-empty player array");
    }
    this.dataset = { key: String(key), players };
    const loads = this.slots.map((slot) => {
      slot.ready = false;
      slot.datasetKey = null;
      return this.run("dataset-load", {
        datasetKey: this.dataset.key,
        players: this.dataset.players,
      }, {
        slotIndex: slot.index,
        timeoutMs: Math.max(this.taskTimeoutMs, 60_000),
        front: true,
      });
    });
    const results = await Promise.all(loads);
    return {
      loaded: true,
      datasetKey: this.dataset.key,
      players: players.length,
      workers: results.length,
    };
  }

  enqueueDatasetLoad(slot) {
    if (!this.dataset || this.closed) return;
    slot.ready = false;
    const task = this.createTask("dataset-load", {
      datasetKey: this.dataset.key,
      players: this.dataset.players,
    }, {
      slotIndex: slot.index,
      timeoutMs: Math.max(this.taskTimeoutMs, 60_000),
    });
    this.enqueueTask(task, true).catch((error) => {
      this.log.warn?.({ error, worker: slot.index }, "Native dataset reload failed");
    });
  }

  dispatch() {
    if (this.closed || !this.available) return;
    for (const slot of this.slots) {
      if (slot.task || !slot.child || slot.child.killed || !slot.child.stdin.writable) continue;
      const taskIndex = this.queue.findIndex((task) => {
        const slotMatches = task.targetSlot === null || task.targetSlot === slot.index;
        const readinessMatches = slot.ready || task.type === "dataset-load";
        return slotMatches && readinessMatches;
      });
      if (taskIndex < 0) continue;
      const [task] = this.queue.splice(taskIndex, 1);
      slot.task = task;
      const line = `${JSON.stringify({
        id: task.id,
        type: task.type,
        payload: task.payload,
      })}\n`;
      try {
        slot.child.stdin.write(line, (error) => {
          if (error && slot.task === task) this.replace(slot, error);
        });
      } catch (error) {
        this.replace(slot, error);
      }
    }
  }

  handleMessage(slot, message) {
    const task = slot.task;
    if (!task || Number(message?.id) !== Number(task.id)) return;
    slot.task = null;
    slot.restartAttempts = 0;
    if (message.ok) {
      if (task.type === "dataset-load") {
        const loadedKey = message.result?.data?.datasetKey || task.payload.datasetKey;
        slot.datasetKey = loadedKey;
        slot.ready = loadedKey === this.dataset?.key;
        this.datasetLoads += 1;
      }
      this.completed += 1;
      this.settleTask(task, "resolve", message.result);
    } else {
      this.failed += 1;
      const error = Object.assign(new Error(message.error || "Native compute failed"), {
        code: message.code || "NATIVE_COMPUTE_FAILED",
      });
      this.settleTask(task, "reject", error);
      if (task.type === "dataset-load") {
        this.replace(slot, error);
        return;
      }
    }
    this.dispatch();
  }

  replace(slot, error) {
    const task = slot.task;
    slot.task = null;
    slot.ready = false;
    slot.datasetKey = null;
    if (task && !task.settled) {
      this.failed += 1;
      this.settleTask(task, "reject", error);
    }
    const child = slot.child;
    slot.child = null;
    try {
      slot.reader?.close();
    } catch {}
    slot.reader = null;
    slot.generation += 1;
    if (child && !child.killed) child.kill();
    if (slot.startedAt && this.now() - slot.startedAt >= this.restartResetMs) {
      slot.restartAttempts = 0;
    }
    slot.startedAt = null;
    this.scheduleRespawn(slot, error, { increment: true });
  }

  scheduleRespawn(slot, error, options = {}) {
    if (this.closed || !this.available || slot.respawnTimer) return;
    if (options.increment) {
      slot.restartAttempts += 1;
      this.restarts += 1;
    }
    const delayMs = restartDelay(slot.restartAttempts, {
      baseMs: this.restartBaseDelayMs,
      maxMs: this.restartMaxDelayMs,
    });
    this.log.warn?.(
      { error, worker: slot.index, restartAttempt: slot.restartAttempts, delayMs },
      "Native engine worker restart scheduled",
    );
    slot.respawnTimer = this.setTimer(() => {
      slot.respawnTimer = null;
      this.spawn(slot);
      this.dispatch();
    }, delayMs);
  }

  stats() {
    const liveWorkers = this.slots.filter((slot) => (
      slot.child && !slot.child.killed && slot.child.exitCode === null
    )).length;
    return {
      available: this.available,
      engine: this.capabilities?.engine || null,
      engineVersion: this.capabilities?.version || null,
      language: this.capabilities?.language || null,
      workers: this.available ? this.size : 0,
      configuredWorkers: this.size,
      liveWorkers,
      restartingWorkers: this.slots.filter((slot) => Boolean(slot.respawnTimer)).length,
      readyWorkers: this.slots.filter((slot) => slot.ready).length,
      busy: this.slots.filter((slot) => Boolean(slot.task)).length,
      queued: this.queue.length,
      datasetKey: this.dataset?.key || null,
      datasetLoads: this.datasetLoads,
      completed: this.completed,
      failed: this.failed,
      restarts: this.restarts,
      integrity: this.integrity,
      closed: this.closed,
    };
  }

  async stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        this.clearTimer(timer);
        resolve();
      };
      const timer = this.setTimer(done, this.closeTimeoutMs);
      child.once("exit", done);
      try {
        child.kill();
      } catch {
        done();
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.available = false;
    const error = Object.assign(new Error("Native engine pool closed"), {
      code: "NATIVE_POOL_CLOSED",
    });
    while (this.queue.length) {
      const task = this.queue.shift();
      this.settleTask(task, "reject", error);
    }
    const children = [];
    for (const slot of this.slots) {
      if (slot.respawnTimer) this.clearTimer(slot.respawnTimer);
      slot.respawnTimer = null;
      if (slot.task) this.settleTask(slot.task, "reject", error);
      slot.task = null;
      try {
        slot.reader?.close();
      } catch {}
      slot.reader = null;
      if (slot.child) children.push(slot.child);
      slot.child = null;
      slot.ready = false;
      slot.datasetKey = null;
    }
    await Promise.all(children.map((child) => this.stopChild(child)));
  }
}

module.exports = { NativeEnginePool };
