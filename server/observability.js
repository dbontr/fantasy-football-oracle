"use strict";

const { canonicalize } = require("./lineage.js");

const OBSERVABILITY_VERSION = "oracle-observability-2026.1";

function labelKey(labels = {}) {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(",");
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

class MetricsRegistry {
  constructor(options = {}) {
    this.clock = options.clock || Date.now;
    this.maxSamples = Math.max(32, Number(options.maxSamples || 2048));
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.startedAt = Number(this.clock());
  }

  metricKey(name, labels) {
    const suffix = labelKey(labels);
    return suffix ? `${name}{${suffix}}` : String(name);
  }

  increment(name, value = 1, labels = {}) {
    const key = this.metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + Number(value || 0));
    return this.counters.get(key);
  }

  gauge(name, value, labels = {}) {
    const key = this.metricKey(name, labels);
    this.gauges.set(key, Number(value));
    return this.gauges.get(key);
  }

  observe(name, value, labels = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const key = this.metricKey(name, labels);
    const row = this.histograms.get(key) || {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      samples: [],
    };
    row.count += 1;
    row.sum += number;
    row.min = Math.min(row.min, number);
    row.max = Math.max(row.max, number);
    row.samples.push(number);
    if (row.samples.length > this.maxSamples) row.samples.shift();
    this.histograms.set(key, row);
    return number;
  }

  async timed(name, labels, operation) {
    const started = Number(this.clock());
    try {
      const result = await operation();
      this.increment(`${name}_total`, 1, { ...labels, outcome: "success" });
      return result;
    } catch (error) {
      this.increment(`${name}_total`, 1, { ...labels, outcome: "failure" });
      throw error;
    } finally {
      this.observe(`${name}_duration_ms`, Number(this.clock()) - started, labels);
    }
  }

  histogramSnapshot(row) {
    return {
      count: row.count,
      sum: row.sum,
      mean: row.count ? row.sum / row.count : null,
      min: Number.isFinite(row.min) ? row.min : null,
      max: Number.isFinite(row.max) ? row.max : null,
      p50: percentile(row.samples, 0.5),
      p95: percentile(row.samples, 0.95),
      p99: percentile(row.samples, 0.99),
      sampleCount: row.samples.length,
    };
  }

  snapshot() {
    return {
      version: OBSERVABILITY_VERSION,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.max(0, Math.round((Number(this.clock()) - this.startedAt) / 1000)),
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      gauges: Object.fromEntries([...this.gauges.entries()].sort()),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([key, row]) => [key, this.histogramSnapshot(row)]),
      ),
    };
  }

  toPrometheus() {
    const lines = [];
    for (const [key, value] of [...this.counters.entries(), ...this.gauges.entries()]) {
      lines.push(`${key} ${Number(value)}`);
    }
    for (const [key, row] of this.histograms.entries()) {
      const normalized = key.replace(/\{/, "_sum{");
      lines.push(`${normalized} ${row.sum}`);
      lines.push(`${key.replace(/\{/, "_count{")} ${row.count}`);
    }
    return `${lines.sort().join("\n")}\n`;
  }
}

function normalizeState(state) {
  const normalized = String(state || "unknown").toLowerCase();
  if (["healthy", "degraded", "stale", "unsafe", "unknown"].includes(normalized)) return normalized;
  return "unknown";
}

class ComponentHealthRegistry {
  constructor(options = {}) {
    this.clock = options.clock || Date.now;
    this.components = new Map();
  }

  set(name, state, details = {}) {
    const now = Number(this.clock());
    const row = {
      name: String(name),
      state: normalizeState(state),
      checkedAt: new Date(now).toISOString(),
      observedAt: details.observedAt ? new Date(details.observedAt).toISOString() : null,
      maxAgeMs: Number.isFinite(Number(details.maxAgeMs)) ? Number(details.maxAgeMs) : null,
      message: details.message ? String(details.message) : null,
      details: canonicalize(details.details || {}),
    };
    this.components.set(row.name, row);
    return row;
  }

  get(name) {
    const row = this.components.get(String(name));
    if (!row) return null;
    return this.evaluateFreshness({ ...row });
  }

  evaluateFreshness(row) {
    if (!row.observedAt || !row.maxAgeMs || row.state === "unsafe") return row;
    const ageMs = Number(this.clock()) - Date.parse(row.observedAt);
    if (Number.isFinite(ageMs) && ageMs > row.maxAgeMs && row.state === "healthy") {
      return { ...row, state: "stale", ageMs };
    }
    return { ...row, ageMs: Number.isFinite(ageMs) ? ageMs : null };
  }

  snapshot() {
    const components = [...this.components.values()]
      .map((row) => this.evaluateFreshness({ ...row }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const severity = { healthy: 0, unknown: 1, degraded: 2, stale: 3, unsafe: 4 };
    const worst = components.reduce((current, row) => (
      severity[row.state] > severity[current] ? row.state : current
    ), "healthy");
    return {
      version: OBSERVABILITY_VERSION,
      state: components.length ? worst : "unknown",
      checkedAt: new Date(Number(this.clock())).toISOString(),
      components,
    };
  }
}

function evaluateSLOs(metricsSnapshot, targets = {}) {
  const results = [];
  const histograms = metricsSnapshot?.histograms || {};
  const gauges = metricsSnapshot?.gauges || {};
  for (const [name, target] of Object.entries(targets.latencyP95Ms || {})) {
    const candidates = Object.entries(histograms).filter(([key]) => key.startsWith(name));
    const observed = candidates.length
      ? Math.max(...candidates.map(([, row]) => Number(row.p95 || 0)))
      : null;
    results.push({
      name: `${name}.p95`,
      objective: Number(target),
      observed,
      unit: "ms",
      met: observed === null ? null : observed <= Number(target),
    });
  }
  for (const [name, minimum] of Object.entries(targets.minimumGauge || {})) {
    const observed = Number(gauges[name]);
    results.push({
      name,
      objective: Number(minimum),
      observed: Number.isFinite(observed) ? observed : null,
      unit: "ratio",
      met: Number.isFinite(observed) ? observed >= Number(minimum) : null,
    });
  }
  const evaluated = results.filter((row) => row.met !== null);
  return {
    version: OBSERVABILITY_VERSION,
    met: evaluated.length ? evaluated.every((row) => row.met) : null,
    evaluated: evaluated.length,
    unknown: results.length - evaluated.length,
    results,
  };
}

module.exports = {
  OBSERVABILITY_VERSION,
  MetricsRegistry,
  ComponentHealthRegistry,
  evaluateSLOs,
  labelKey,
  percentile,
};
