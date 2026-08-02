"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { atomicWrite } = require("./event-store.js");
const { canonicalize, sha256 } = require("./lineage.js");

const DRIFT_MONITOR_VERSION = "oracle-drift-2026.1";

function finite(value, fallback = Number.NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

function calibrationBins(rows, count = 10) {
  const bins = Array.from({ length: count }, (_, index) => ({
    lower: index / count,
    upper: (index + 1) / count,
    predictions: [],
    outcomes: [],
  }));
  for (const row of rows) {
    const probability = clamp(row.prediction, 0, 1);
    const index = Math.min(count - 1, Math.floor(probability * count));
    bins[index].predictions.push(probability);
    bins[index].outcomes.push(clamp(row.outcome, 0, 1));
  }
  return bins.map((bin) => ({
    lower: bin.lower,
    upper: bin.upper,
    samples: bin.predictions.length,
    meanPrediction: mean(bin.predictions),
    observedRate: mean(bin.outcomes),
  })).filter((bin) => bin.samples > 0);
}

function summarizeRows(rows) {
  const binary = rows.filter((row) => row.metricType === "probability");
  const numeric = rows.filter((row) => row.metricType === "numeric");
  const probabilityErrors = binary.map((row) => row.prediction - row.outcome);
  const numericErrors = numeric.map((row) => row.prediction - row.outcome);
  const brier = binary.length
    ? mean(binary.map((row) => (row.prediction - row.outcome) ** 2))
    : null;
  const calibrationError = binary.length
    ? mean(calibrationBins(binary).map((bin) => (
      Math.abs(bin.meanPrediction - bin.observedRate) * bin.samples / binary.length
    )))
    : null;
  return {
    samples: rows.length,
    probabilitySamples: binary.length,
    numericSamples: numeric.length,
    brier,
    calibrationError,
    probabilityBias: mean(probabilityErrors),
    numericMae: numeric.length ? mean(numericErrors.map(Math.abs)) : null,
    numericRmse: numeric.length
      ? Math.sqrt(mean(numericErrors.map((value) => value ** 2)))
      : null,
    numericBias: mean(numericErrors),
    absoluteErrorP95: percentile(
      rows.map((row) => Math.abs(row.prediction - row.outcome)),
      0.95,
    ),
    calibrationBins: calibrationBins(binary),
  };
}

function driftState(summary, baseline = {}, thresholds = {}) {
  const alerts = [];
  const minimumSamples = Math.max(1, finite(thresholds.minimumSamples, 30));
  if (summary.samples < minimumSamples) {
    return { state: "unknown", alerts: [`only ${summary.samples}/${minimumSamples} outcomes observed`] };
  }
  if (summary.brier !== null && baseline.brier !== undefined) {
    const increase = summary.brier - finite(baseline.brier, summary.brier);
    if (increase > finite(thresholds.brierIncreaseUnsafe, 0.08)) alerts.push(`Brier score worsened by ${increase.toFixed(4)}`);
    else if (increase > finite(thresholds.brierIncreaseDegraded, 0.03)) alerts.push(`Brier score drifted by ${increase.toFixed(4)}`);
  }
  if (summary.numericRmse !== null && baseline.numericRmse !== undefined) {
    const ratio = summary.numericRmse / Math.max(0.0001, finite(baseline.numericRmse, summary.numericRmse));
    if (ratio > finite(thresholds.rmseRatioUnsafe, 1.35)) alerts.push(`RMSE is ${ratio.toFixed(2)}x baseline`);
    else if (ratio > finite(thresholds.rmseRatioDegraded, 1.15)) alerts.push(`RMSE is ${ratio.toFixed(2)}x baseline`);
  }
  if (summary.calibrationError !== null && summary.calibrationError > finite(thresholds.calibrationUnsafe, 0.12)) {
    alerts.push(`calibration error ${summary.calibrationError.toFixed(4)} exceeds unsafe threshold`);
  }
  const unsafe = alerts.some((message) => /worsened|unsafe|1\.[3-9]|[2-9]\./.test(message));
  return { state: alerts.length ? (unsafe ? "unsafe" : "degraded") : "healthy", alerts };
}

class DriftMonitor {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError("DriftMonitor requires filePath");
    this.filePath = path.resolve(options.filePath);
    this.clock = options.clock || (() => new Date());
    this.eventStore = options.eventStore || null;
    this.maxRows = Math.max(100, finite(options.maxRows, 20_000));
    this.baselines = canonicalize(options.baselines || {});
    this.thresholds = canonicalize(options.thresholds || {});
    this.rows = [];
  }

  async initialize() {
    try {
      const document = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (document.version !== DRIFT_MONITOR_VERSION || !Array.isArray(document.rows)) {
        throw new Error("Drift monitor file has an invalid format");
      }
      this.rows = document.rows.slice(-this.maxRows);
      this.baselines = { ...this.baselines, ...(document.baselines || {}) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
    return this.status();
  }

  async persist() {
    const document = {
      version: DRIFT_MONITOR_VERSION,
      updatedAt: new Date(this.clock()).toISOString(),
      baselines: this.baselines,
      rows: this.rows.slice(-this.maxRows),
    };
    document.digest = sha256({
      version: document.version,
      baselines: document.baselines,
      rows: document.rows,
    });
    await atomicWrite(this.filePath, `${JSON.stringify(document, null, 2)}\n`);
  }

  async record(observation = {}) {
    const prediction = finite(observation.prediction);
    const outcome = finite(observation.outcome);
    if (!Number.isFinite(prediction) || !Number.isFinite(outcome)) {
      throw new TypeError("Drift observation requires finite prediction and outcome values");
    }
    const metricType = observation.metricType === "probability" ? "probability" : "numeric";
    if (metricType === "probability" && (
      prediction < 0 || prediction > 1 || outcome < 0 || outcome > 1
    )) {
      throw new RangeError("Probability observations must be between 0 and 1");
    }
    const row = {
      id: String(observation.id || sha256({ observation, at: new Date(this.clock()).toISOString() }).slice(0, 24)),
      domain: String(observation.domain || "unknown"),
      modelVersion: String(observation.modelVersion || "unknown"),
      metric: String(observation.metric || "prediction"),
      metricType,
      prediction,
      outcome,
      predictedAt: observation.predictedAt ? new Date(observation.predictedAt).toISOString() : null,
      observedAt: new Date(observation.observedAt || this.clock()).toISOString(),
      metadata: canonicalize(observation.metadata || {}),
    };
    this.rows.push(row);
    if (this.rows.length > this.maxRows) this.rows.splice(0, this.rows.length - this.maxRows);
    await this.persist();
    await this.eventStore?.append?.("model.outcome-observed", row, { source: "drift-monitor" });
    return row;
  }

  report(options = {}) {
    const domain = options.domain ? String(options.domain) : null;
    const modelVersion = options.modelVersion ? String(options.modelVersion) : null;
    const metric = options.metric ? String(options.metric) : null;
    const limit = Math.max(1, finite(options.limit, 1000));
    const rows = this.rows.filter((row) => (
      (!domain || row.domain === domain) &&
      (!modelVersion || row.modelVersion === modelVersion) &&
      (!metric || row.metric === metric)
    )).slice(-limit);
    const summary = summarizeRows(rows);
    const baselineKey = [domain || "all", modelVersion || "all", metric || "all"].join(":");
    const baseline = this.baselines[baselineKey] || this.baselines[domain || "all"] || {};
    const assessment = driftState(summary, baseline, this.thresholds);
    return {
      version: DRIFT_MONITOR_VERSION,
      filters: { domain, modelVersion, metric, limit },
      summary,
      baseline,
      assessment,
      newestObservedAt: rows.at(-1)?.observedAt || null,
    };
  }

  status() {
    const byDomain = {};
    for (const row of this.rows) {
      byDomain[row.domain] = (byDomain[row.domain] || 0) + 1;
    }
    const overall = this.report({ limit: this.maxRows });
    return {
      version: DRIFT_MONITOR_VERSION,
      observations: this.rows.length,
      maxRows: this.maxRows,
      domains: byDomain,
      state: overall.assessment.state,
      alerts: overall.assessment.alerts,
      newestObservedAt: overall.newestObservedAt,
    };
  }
}

module.exports = {
  DRIFT_MONITOR_VERSION,
  DriftMonitor,
  summarizeRows,
  driftState,
  calibrationBins,
};
