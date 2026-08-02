"use strict";

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");

class NativeEnginePool {
  constructor(options = {}) {
    this.binary = options.binary;
    this.size = Math.max(1, Number(options.size || 1));
    this.maxQueue = Math.max(1, Number(options.maxQueue || 64));
    this.taskTimeoutMs = Math.max(1000, Number(options.taskTimeoutMs || 45_000));
    this.log = options.logger || console;
    this.slots = [];
    this.queue = [];
    this.nextTaskId = 1;
    this.closed = false;
    this.available = false;
    this.capabilities = null;
    this.dataset = null;
    this.completed = 0;
    this.failed = 0;
    this.restarts = 0;
    this.datasetLoads = 0;
  }

  start() {
    if (this.slots.length || this.closed) return this;
    if (!this.binary || !fs.existsSync(this.binary)) return this;
    const probe = spawnSync(this.binary, ["--capabilities"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (probe.status !== 0) {
      this.log.warn?.({ stderr: probe.stderr, binary: this.binary }, "Native engine probe failed");
      return this;
    }
    try {
      this.capabilities = JSON.parse(probe.stdout.trim());
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
        timer: null,
        ready: true,
        datasetKey: null,
      };
      this.slots.push(slot);
      this.spawn(slot);
    }
    return this;
  }
  spawn(slot) {
    if (this.closed || !this.available) return;
    const generation = ++slot.generation;
    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    slot.child = child;
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
      const error = new Error(`Native engine exited with code ${code ?? "null"} signal ${signal ?? "none"}`);
      error.code = "NATIVE_ENGINE_EXIT";
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
      queuedAt: Date.now(),
    };
  }

  enqueueTask(task, front = false) {
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
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
    const task = this.createTask(type, taskPayload, options);
    return this.enqueueTask(task, options.front === true);
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
      slot.timer = setTimeout(() => {
        const error = Object.assign(new Error(`Native task ${task.type} timed out`), {
          code: "TASK_TIMEOUT",
        });
        this.replace(slot, error);
      }, task.timeoutMs);
      const line = `${JSON.stringify({
        id: task.id,
        type: task.type,
        payload: task.payload,
      })}\n`;
      slot.child.stdin.write(line, (error) => {
        if (error && slot.task === task) this.replace(slot, error);
      });
    }
  }

  handleMessage(slot, message) {
    const task = slot.task;
    if (!task || Number(message?.id) !== Number(task.id)) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (message.ok) {
      if (task.type === "dataset-load") {
        const loadedKey = message.result?.data?.datasetKey || task.payload.datasetKey;
        slot.datasetKey = loadedKey;
        slot.ready = loadedKey === this.dataset?.key;
        this.datasetLoads += 1;
      }
      this.completed += 1;
      task.resolve(message.result);
    } else {
      this.failed += 1;
      const error = Object.assign(new Error(message.error || "Native compute failed"), {
        code: message.code || "NATIVE_COMPUTE_FAILED",
      });
      task.reject(error);
      if (task.type === "dataset-load") {
        this.replace(slot, error);
        return;
      }
    }
    this.dispatch();
  }

  replace(slot, error) {
    const task = slot.task;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    slot.ready = false;
    slot.datasetKey = null;
    if (task) {
      this.failed += 1;
      task.reject(error);
    }
    const child = slot.child;
    slot.child = null;
    slot.reader?.close();
    slot.reader = null;
    slot.generation += 1;
    if (child && !child.killed) child.kill();
    this.restarts += 1;
    this.log.warn?.({ error, worker: slot.index }, "Native engine worker replaced");
    if (!this.closed && this.available) {
      this.spawn(slot);
      this.dispatch();
    }
  }

  stats() {
    return {
      available: this.available,
      engine: this.capabilities?.engine || null,
      engineVersion: this.capabilities?.version || null,
      language: this.capabilities?.language || null,
      workers: this.available ? this.size : 0,
      readyWorkers: this.slots.filter((slot) => slot.ready).length,
      busy: this.slots.filter((slot) => Boolean(slot.task)).length,
      queued: this.queue.length,
      datasetKey: this.dataset?.key || null,
      datasetLoads: this.datasetLoads,
      completed: this.completed,
      failed: this.failed,
      restarts: this.restarts,
      closed: this.closed,
    };
  }
  async close() {
    this.closed = true;
    const error = Object.assign(new Error("Native engine pool closed"), {
      code: "NATIVE_POOL_CLOSED",
    });
    while (this.queue.length) this.queue.shift().reject(error);
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.task) slot.task.reject(error);
      slot.task = null;
      slot.reader?.close();
      slot.reader = null;
      if (slot.child && !slot.child.killed) slot.child.kill();
      slot.child = null;
      slot.ready = false;
      slot.datasetKey = null;
    }
  }
}

module.exports = { NativeEnginePool };
