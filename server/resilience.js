"use strict";

const RESILIENCE_VERSION = "oracle-resilience-2026.1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(operation, timeoutMs, label = "operation") {
  const duration = Math.max(1, Number(timeoutMs || 10_000));
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${duration} ms`);
      error.code = "UPSTREAM_TIMEOUT";
      reject(error);
    }, duration);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer));
}

function defaultShouldRetry(error) {
  if (!error) return false;
  if (["ABORT_ERR", "ECONNRESET", "ETIMEDOUT", "UPSTREAM_TIMEOUT"].includes(error.code)) return true;
  const status = Number(error.status || error.statusCode || 0);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function retry(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs || 150));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs || 2_000));
  const jitter = Math.min(1, Math.max(0, Number(options.jitter ?? 0.25)));
  const random = options.random || Math.random;
  const sleeper = options.sleep || sleep;
  const shouldRetry = options.shouldRetry || defaultShouldRetry;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const factor = 1 + ((random() * 2) - 1) * jitter;
      await sleeper(Math.max(0, Math.round(exponential * factor)));
    }
  }
  throw lastError;
}

class CircuitBreaker {
  constructor(options = {}) {
    this.name = String(options.name || "provider");
    this.failureThreshold = Math.max(1, Number(options.failureThreshold || 4));
    this.resetTimeoutMs = Math.max(100, Number(options.resetTimeoutMs || 30_000));
    this.clock = options.clock || Date.now;
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.halfOpenInFlight = false;
  }

  canRequest() {
    if (this.state === "closed") return true;
    const now = Number(this.clock());
    if (this.state === "open" && now - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half-open";
      this.halfOpenInFlight = false;
    }
    if (this.state === "half-open" && !this.halfOpenInFlight) {
      this.halfOpenInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess() {
    this.successes += 1;
    this.lastSuccessAt = new Date(Number(this.clock())).toISOString();
    this.state = "closed";
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenInFlight = false;
    this.lastError = null;
  }

  onFailure(error) {
    this.failures += 1;
    this.lastFailureAt = new Date(Number(this.clock())).toISOString();
    this.lastError = error?.message || String(error);
    this.halfOpenInFlight = false;
    if (this.state === "half-open" || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Number(this.clock());
    }
  }

  async run(operation) {
    if (!this.canRequest()) {
      const error = new Error(`Circuit ${this.name} is open`);
      error.code = "CIRCUIT_OPEN";
      error.retryAfterMs = this.openedAt
        ? Math.max(0, this.resetTimeoutMs - (Number(this.clock()) - this.openedAt))
        : this.resetTimeoutMs;
      throw error;
    }
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  status() {
    return {
      version: RESILIENCE_VERSION,
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }
}

class ResilientProvider {
  constructor(options = {}) {
    this.name = String(options.name || "provider");
    this.clock = options.clock || Date.now;
    this.timeoutMs = Math.max(100, Number(options.timeoutMs || 8_000));
    this.retryOptions = { attempts: 3, baseDelayMs: 150, ...(options.retry || {}) };
    this.maxStaleMs = Math.max(0, Number(options.maxStaleMs || 24 * 60 * 60 * 1000));
    this.breaker = options.breaker || new CircuitBreaker({ name: this.name, clock: this.clock });
    this.snapshotCatalog = options.snapshotCatalog || null;
    this.cache = new Map();
    this.requests = 0;
    this.failures = 0;
    this.degradedResponses = 0;
  }

  async execute(key, operation, options = {}) {
    this.requests += 1;
    const cacheKey = String(key || "default");
    try {
      const value = await this.breaker.run(() => retry(
        () => withTimeout(operation, options.timeoutMs || this.timeoutMs, this.name),
        { ...this.retryOptions, ...(options.retry || {}) },
      ));
      const fetchedAtMs = Number(this.clock());
      const entry = {
        value,
        fetchedAtMs,
        fetchedAt: new Date(fetchedAtMs).toISOString(),
      };
      this.cache.set(cacheKey, entry);
      if (this.snapshotCatalog && options.snapshot !== false) {
        await this.snapshotCatalog.write(`provider-${this.name}`, value, {
          details: { key: cacheKey, fetchedAt: entry.fetchedAt },
        });
      }
      return {
        value,
        provider: this.name,
        degraded: false,
        source: "live",
        fetchedAt: entry.fetchedAt,
        ageMs: 0,
        error: null,
      };
    } catch (error) {
      this.failures += 1;
      const cached = this.cache.get(cacheKey);
      const ageMs = cached ? Number(this.clock()) - cached.fetchedAtMs : Number.POSITIVE_INFINITY;
      if (options.allowStale !== false && cached && ageMs <= (options.maxStaleMs ?? this.maxStaleMs)) {
        this.degradedResponses += 1;
        return {
          value: cached.value,
          provider: this.name,
          degraded: true,
          source: "last-known-good",
          fetchedAt: cached.fetchedAt,
          ageMs,
          error: error.message,
        };
      }
      throw error;
    }
  }

  status() {
    return {
      version: RESILIENCE_VERSION,
      name: this.name,
      requests: this.requests,
      failures: this.failures,
      degradedResponses: this.degradedResponses,
      cachedKeys: this.cache.size,
      timeoutMs: this.timeoutMs,
      maxStaleMs: this.maxStaleMs,
      circuit: this.breaker.status(),
    };
  }
}

module.exports = {
  RESILIENCE_VERSION,
  sleep,
  withTimeout,
  retry,
  defaultShouldRetry,
  CircuitBreaker,
  ResilientProvider,
};
