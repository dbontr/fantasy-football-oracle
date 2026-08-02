"use strict";

class HybridComputePool {
  constructor(options = {}) {
    this.native = options.native;
    this.fallback = options.fallback;
    this.required = options.required === true;
    this.log = options.logger || console;
    this.nativeOnlyTasks = new Set(["season-simulate", "start-sit", "league-simulate"]);
    this.nativeFailures = 0;
    this.fallbackRuns = 0;
  }

  start() {
    this.fallback?.start();
    this.native?.start();
    if (this.required && !this.native?.available) {
      const error = new Error("Native engine is required but unavailable");
      error.code = "NATIVE_REQUIRED";
      throw error;
    }
    return this;
  }

  async setDataset(key, players) {
    if (!this.native?.available) {
      if (this.required) {
        const error = new Error("Native engine is required but unavailable");
        error.code = "NATIVE_REQUIRED";
        throw error;
      }
      return { loaded: false, reason: "native-unavailable" };
    }
    return this.native.setDataset(key, players);
  }

  async run(type, payload, options = {}) {
    if (this.native?.available) {
      try {
        return await this.native.run(type, payload, options);
      } catch (error) {
        this.nativeFailures += 1;
        if (this.required || error.code === "QUEUE_FULL" || error.code === "TASK_TIMEOUT") throw error;
        this.log.warn?.({ error, type }, "Native compute failed; using JavaScript fallback");
      }
    }
    if (this.nativeOnlyTasks.has(type)) {
      const error = new Error(`Task ${type} requires the native C++ engine`);
      error.code = "NATIVE_REQUIRED_TASK";
      throw error;
    }
    this.fallbackRuns += 1;
    const result = await this.fallback.run(type, payload, options);
    return {
      ...result,
      engine: "oracle-javascript-fallback",
      engineVersion: "2.1.0",
    };
  }

  stats() {
    const native = this.native?.stats() || { available: false };
    const fallback = this.fallback?.stats() || {};
    return {
      mode: native.available ? "native-cpp-primary" : "javascript-fallback",
      native,
      fallback,
      nativeFailures: this.nativeFailures,
      fallbackRuns: this.fallbackRuns,
    };
  }

  async close() {
    await Promise.all([
      this.native?.close(),
      this.fallback?.close(),
    ]);
  }
}

module.exports = { HybridComputePool };
