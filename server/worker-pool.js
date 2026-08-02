"use strict";

const { Worker } = require("node:worker_threads");
const { restartDelay } = require("./restart-policy.js");

class WorkerPool {
  constructor(options = {}) {
    this.workerFile = options.workerFile;
    this.size = Math.max(1, Number(options.size || 1));
    this.maxQueue = Math.max(1, Number(options.maxQueue || 64));
    this.taskTimeoutMs = Math.max(1000, Number(options.taskTimeoutMs || 45_000));
    this.log = options.logger || console;
    this.createWorker = options.createWorker || ((workerFile) => new Worker(workerFile));
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || Date.now;
    this.restartBaseDelayMs = Math.max(1, Number(options.restartBaseDelayMs || 250));
    this.restartMaxDelayMs = Math.max(
      this.restartBaseDelayMs,
      Number(options.restartMaxDelayMs || 30_000),
    );
    this.restartResetMs = Math.max(1000, Number(options.restartResetMs || 30_000));
    this.slots = [];
    this.queue = [];
    this.nextTaskId = 1;
    this.closed = false;
    this.completed = 0;
    this.failed = 0;
    this.restarts = 0;
  }

  start() {
    if (this.slots.length || this.closed) return this;
    for (let index = 0; index < this.size; index += 1) {
      const slot = {
        index,
        generation: 0,
        worker: null,
        task: null,
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
    if (this.closed) return;
    if (slot.respawnTimer) {
      this.clearTimer(slot.respawnTimer);
      slot.respawnTimer = null;
    }
    const generation = ++slot.generation;
    let worker;
    try {
      worker = this.createWorker(this.workerFile);
    } catch (error) {
      slot.worker = null;
      if (options.throwOnFailure) throw error;
      this.scheduleRespawn(slot, error, { increment: true });
      return;
    }
    slot.worker = worker;
    slot.startedAt = this.now();
    worker.on("message", (message) => {
      if (slot.generation === generation) this.handleMessage(slot, message);
    });
    worker.on("error", (error) => {
      if (slot.generation === generation) this.replace(slot, error);
    });
    worker.on("exit", (code) => {
      if (slot.generation !== generation || this.closed) return;
      const error = Object.assign(new Error(`Compute worker exited with code ${code}`), {
        code: "WORKER_EXIT",
      });
      this.replace(slot, error);
    });
  }

  createTask(type, payload, options = {}) {
    return {
      id: this.nextTaskId++,
      type,
      payload,
      timeoutMs: Math.max(1000, Number(options.timeoutMs || this.taskTimeoutMs)),
      queuedAt: this.now(),
      timer: null,
      settled: false,
    };
  }

  run(type, payload, options = {}) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error("Compute pool is closed"), {
        code: "WORKER_POOL_CLOSED",
      }));
    }
    if (this.queue.length >= this.maxQueue) {
      const error = new Error("Compute queue is full");
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }
    const task = this.createTask(type, payload, options);
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      task.timer = this.setTimer(() => this.expireTask(task), task.timeoutMs);
      this.queue.push(task);
      this.dispatch();
    });
  }

  expireTask(task) {
    if (task.settled) return;
    const queuedIndex = this.queue.indexOf(task);
    const error = Object.assign(new Error(`Compute task ${task.type} timed out`), {
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

  dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.task || !slot.worker) continue;
      const task = this.queue.shift();
      if (!task) break;
      slot.task = task;
      try {
        slot.worker.postMessage({
          id: task.id,
          type: task.type,
          payload: task.payload,
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
      this.completed += 1;
      this.settleTask(task, "resolve", message.result);
    } else {
      this.failed += 1;
      const error = new Error(message.error || "Compute worker failed");
      error.code = message.code || "WORKER_ERROR";
      this.settleTask(task, "reject", error);
    }
    this.dispatch();
  }

  replace(slot, error) {
    const task = slot.task;
    slot.task = null;
    if (task && !task.settled) {
      this.failed += 1;
      this.settleTask(task, "reject", error);
    }
    const worker = slot.worker;
    slot.worker = null;
    slot.generation += 1;
    if (worker) Promise.resolve(worker.terminate()).catch(() => {});
    if (slot.startedAt && this.now() - slot.startedAt >= this.restartResetMs) {
      slot.restartAttempts = 0;
    }
    slot.startedAt = null;
    this.scheduleRespawn(slot, error, { increment: true });
  }

  scheduleRespawn(slot, error, options = {}) {
    if (this.closed || slot.respawnTimer) return;
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
      "Compute worker restart scheduled",
    );
    slot.respawnTimer = this.setTimer(() => {
      slot.respawnTimer = null;
      this.spawn(slot);
      this.dispatch();
    }, delayMs);
  }

  stats() {
    const liveWorkers = this.slots.filter((slot) => Boolean(slot.worker)).length;
    return {
      workers: this.size,
      configuredWorkers: this.size,
      liveWorkers,
      restartingWorkers: this.slots.filter((slot) => Boolean(slot.respawnTimer)).length,
      busy: this.slots.filter((slot) => Boolean(slot.task)).length,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      restarts: this.restarts,
      closed: this.closed,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = Object.assign(new Error("Compute pool closed"), {
      code: "WORKER_POOL_CLOSED",
    });
    while (this.queue.length) {
      const task = this.queue.shift();
      this.settleTask(task, "reject", error);
    }
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.respawnTimer) this.clearTimer(slot.respawnTimer);
      slot.respawnTimer = null;
      if (slot.task) this.settleTask(slot.task, "reject", error);
      slot.task = null;
      if (slot.worker) await Promise.resolve(slot.worker.terminate()).catch(() => {});
      slot.worker = null;
    }));
  }
}

module.exports = { WorkerPool };
