"use strict";

const { Worker } = require("node:worker_threads");

class WorkerPool {
  constructor(options = {}) {
    this.workerFile = options.workerFile;
    this.size = Math.max(1, Number(options.size || 1));
    this.maxQueue = Math.max(1, Number(options.maxQueue || 64));
    this.taskTimeoutMs = Math.max(1000, Number(options.taskTimeoutMs || 45_000));
    this.log = options.logger || console;
    this.slots = [];
    this.queue = [];
    this.nextTaskId = 1;
    this.closed = false;
    this.completed = 0;
    this.failed = 0;
  }

  start() {
    if (this.slots.length) return this;
    for (let index = 0; index < this.size; index += 1) {
      const slot = {
        index,
        generation: 0,
        worker: null,
        task: null,
        timer: null,
      };
      this.slots.push(slot);
      this.spawn(slot);
    }
    return this;
  }

  spawn(slot) {
    if (this.closed) return;
    const generation = slot.generation + 1;
    slot.generation = generation;
    const worker = new Worker(this.workerFile);
    slot.worker = worker;
    worker.on("message", (message) => {
      if (slot.generation !== generation) return;
      this.handleMessage(slot, message);
    });
    worker.on("error", (error) => {
      if (slot.generation !== generation) return;
      this.replace(slot, error);
    });
    worker.on("exit", (code) => {
      if (slot.generation !== generation || this.closed) return;
      if (code !== 0) {
        this.replace(slot, new Error(`Compute worker exited with code ${code}`));
      }
    });
  }

  run(type, payload, options = {}) {
    if (this.closed) return Promise.reject(new Error("Compute pool is closed"));
    if (this.queue.length >= this.maxQueue) {
      const error = new Error("Compute queue is full");
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }
    const task = {
      id: this.nextTaskId++,
      type,
      payload,
      timeoutMs: Math.max(1000, Number(options.timeoutMs || this.taskTimeoutMs)),
      queuedAt: Date.now(),
    };
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      this.queue.push(task);
      this.dispatch();
    });
  }

  dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.task || !slot.worker) continue;
      const task = this.queue.shift();
      if (!task) break;
      slot.task = task;
      slot.timer = setTimeout(() => {
        const error = new Error(`Compute task ${task.type} timed out`);
        error.code = "TASK_TIMEOUT";
        this.replace(slot, error);
      }, task.timeoutMs);
      slot.worker.postMessage({
        id: task.id,
        type: task.type,
        payload: task.payload,
      });
    }
  }

  handleMessage(slot, message) {
    const task = slot.task;
    if (!task || Number(message?.id) !== Number(task.id)) return;
    clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (message.ok) {
      this.completed += 1;
      task.resolve(message.result);
    } else {
      this.failed += 1;
      const error = new Error(message.error || "Compute worker failed");
      error.code = message.code || "WORKER_ERROR";
      task.reject(error);
    }
    this.dispatch();
  }

  replace(slot, error) {
    const task = slot.task;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    if (task) {
      this.failed += 1;
      task.reject(error);
    }
    const worker = slot.worker;
    slot.worker = null;
    slot.generation += 1;
    if (worker) worker.terminate().catch(() => {});
    this.log.warn?.({ error, worker: slot.index }, "Compute worker replaced");
    if (!this.closed) {
      this.spawn(slot);
      this.dispatch();
    }
  }

  stats() {
    return {
      workers: this.size,
      busy: this.slots.filter((slot) => Boolean(slot.task)).length,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      closed: this.closed,
    };
  }

  async close() {
    this.closed = true;
    const error = new Error("Compute pool closed");
    while (this.queue.length) this.queue.shift().reject(error);
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.task) slot.task.reject(error);
      slot.task = null;
      if (slot.worker) await slot.worker.terminate().catch(() => {});
      slot.worker = null;
    }));
  }
}

module.exports = { WorkerPool };
