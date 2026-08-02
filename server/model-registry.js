"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { canonicalize, sha256 } = require("./lineage.js");
const { atomicWrite } = require("./event-store.js");

const MODEL_REGISTRY_VERSION = "oracle-model-registry-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function promotionGate(champion = {}, challenger = {}, gate = {}) {
  const errors = [];
  const direction = gate.direction === "higher" ? "higher" : "lower";
  const championValue = finite(gate.championValue, Number.NaN);
  const challengerValue = finite(gate.challengerValue, Number.NaN);
  const minimumImprovement = Math.max(0, finite(gate.minimumImprovement, 0));
  const sampleSize = Math.max(0, finite(gate.sampleSize, 0));
  const minimumSampleSize = Math.max(1, finite(gate.minimumSampleSize, 100));
  if (!gate.primaryMetric) errors.push("primaryMetric is required");
  if (!Number.isFinite(championValue) || !Number.isFinite(challengerValue)) {
    errors.push("finite championValue and challengerValue are required");
  }
  if (sampleSize < minimumSampleSize) errors.push(`sample size ${sampleSize} is below ${minimumSampleSize}`);
  if (gate.leakageSafe !== true) errors.push("evaluation is not marked leakage-safe");
  if (!gate.holdoutId && !gate.holdoutSeason) errors.push("an untouched holdout identifier is required");
  const improvement = direction === "higher"
    ? challengerValue - championValue
    : championValue - challengerValue;
  if (Number.isFinite(improvement) && improvement < minimumImprovement) {
    errors.push(`improvement ${improvement} is below required ${minimumImprovement}`);
  }
  if (challenger.version && champion.version && challenger.version === champion.version) {
    errors.push("challenger is already the champion");
  }
  return {
    passed: errors.length === 0,
    errors,
    primaryMetric: gate.primaryMetric || null,
    direction,
    championValue: Number.isFinite(championValue) ? championValue : null,
    challengerValue: Number.isFinite(challengerValue) ? challengerValue : null,
    improvement: Number.isFinite(improvement) ? improvement : null,
    minimumImprovement,
    sampleSize,
    minimumSampleSize,
    holdoutId: gate.holdoutId || gate.holdoutSeason || null,
    evaluatedAt: gate.evaluatedAt || new Date().toISOString(),
  };
}

class ModelRegistry {
  constructor(options = {}) {
    if (!options.seedPath) throw new TypeError("ModelRegistry requires seedPath");
    if (!options.runtimePath) throw new TypeError("ModelRegistry requires runtimePath");
    this.seedPath = path.resolve(options.seedPath);
    this.runtimePath = path.resolve(options.runtimePath);
    this.eventStore = options.eventStore || null;
    this.clock = options.clock || (() => new Date());
    this.registry = null;
    this.source = null;
  }

  async initialize() {
    try {
      this.registry = JSON.parse(await fs.readFile(this.runtimePath, "utf8"));
      this.source = "runtime";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.registry = JSON.parse(await fs.readFile(this.seedPath, "utf8"));
      this.source = "seed";
      await this.persist();
    }
    this.validate();
    return this.status();
  }

  validate() {
    if (!this.registry || this.registry.version !== MODEL_REGISTRY_VERSION) {
      const error = new Error("Model registry version is invalid");
      error.code = "MODEL_REGISTRY_INVALID";
      throw error;
    }
    if (!this.registry.domains || typeof this.registry.domains !== "object") {
      throw Object.assign(new Error("Model registry domains are missing"), { code: "MODEL_REGISTRY_INVALID" });
    }
    for (const [domainName, domain] of Object.entries(this.registry.domains)) {
      if (!domain.champion || !domain.models?.[domain.champion]) {
        throw Object.assign(
          new Error(`Model registry champion is invalid for ${domainName}`),
          { code: "MODEL_REGISTRY_INVALID" },
        );
      }
    }
    return true;
  }

  async persist() {
    this.registry.updatedAt = new Date(this.clock()).toISOString();
    this.registry.digest = sha256({
      version: this.registry.version,
      domains: this.registry.domains,
    });
    await atomicWrite(this.runtimePath, `${JSON.stringify(this.registry, null, 2)}\n`);
  }

  domain(name) {
    const domain = this.registry?.domains?.[String(name)];
    if (!domain) {
      const error = new Error(`Unknown model domain: ${name}`);
      error.code = "MODEL_DOMAIN_UNKNOWN";
      throw error;
    }
    return domain;
  }

  registerChallenger(domainName, model = {}) {
    const domain = this.domain(domainName);
    const version = String(model.version || "");
    if (!version) throw new Error("Challenger version is required");
    domain.models[version] = {
      ...canonicalize(model),
      version,
      status: "challenger",
      registeredAt: model.registeredAt || new Date(this.clock()).toISOString(),
      rollback: domain.champion,
    };
    return domain.models[version];
  }

  async evaluateAndPromote(domainName, challengerVersion, gateOptions = {}) {
    const domain = this.domain(domainName);
    const championVersion = domain.champion;
    const champion = { version: championVersion, ...domain.models[championVersion] };
    const challengerRow = domain.models[String(challengerVersion)];
    if (!challengerRow) {
      const error = new Error(`Unknown challenger: ${challengerVersion}`);
      error.code = "MODEL_CHALLENGER_UNKNOWN";
      throw error;
    }
    const challenger = { version: String(challengerVersion), ...challengerRow };
    const evaluation = promotionGate(champion, challenger, gateOptions);
    challengerRow.lastEvaluation = evaluation;
    challengerRow.status = evaluation.passed ? "production" : "rejected";
    if (evaluation.passed) {
      domain.models[championVersion].status = "rollback";
      domain.models[championVersion].replacedAt = new Date(this.clock()).toISOString();
      challengerRow.deployedAt = new Date(this.clock()).toISOString();
      challengerRow.rollback = championVersion;
      domain.champion = challenger.version;
    }
    await this.persist();
    await this.eventStore?.append?.(
      evaluation.passed ? "model.promoted" : "model.rejected",
      {
        domain: String(domainName),
        championBefore: championVersion,
        challenger: challenger.version,
        championAfter: domain.champion,
        evaluation,
      },
      { source: "model-registry" },
    );
    return {
      domain: String(domainName),
      championBefore: championVersion,
      championAfter: domain.champion,
      challenger: challenger.version,
      evaluation,
    };
  }

  async rollback(domainName, targetVersion = null) {
    const domain = this.domain(domainName);
    const currentVersion = domain.champion;
    const current = domain.models[currentVersion];
    const target = String(targetVersion || current.rollback || "");
    if (!target || !domain.models[target]) {
      const error = new Error(`No valid rollback target for ${domainName}`);
      error.code = "MODEL_ROLLBACK_UNAVAILABLE";
      throw error;
    }
    current.status = "challenger";
    current.rolledBackAt = new Date(this.clock()).toISOString();
    domain.models[target].status = "production";
    domain.models[target].restoredAt = new Date(this.clock()).toISOString();
    domain.champion = target;
    await this.persist();
    await this.eventStore?.append?.("model.rolled-back", {
      domain: String(domainName),
      from: currentVersion,
      to: target,
    }, { source: "model-registry" });
    return { domain: String(domainName), from: currentVersion, to: target };
  }

  status() {
    const domains = Object.fromEntries(Object.entries(this.registry?.domains || {}).map(([name, domain]) => [
      name,
      {
        champion: domain.champion,
        challengers: Object.entries(domain.models || {})
          .filter(([version]) => version !== domain.champion)
          .map(([version, row]) => ({
            version,
            status: row.status,
            lastEvaluation: row.lastEvaluation || null,
          })),
        rollback: domain.models?.[domain.champion]?.rollback || null,
      },
    ]));
    return {
      version: MODEL_REGISTRY_VERSION,
      source: this.source,
      digest: this.registry?.digest || sha256({ domains: this.registry?.domains || {} }),
      updatedAt: this.registry?.updatedAt || this.registry?.generatedAt || null,
      domains,
    };
  }

  fullRegistry() {
    return structuredClone(this.registry);
  }
}

module.exports = {
  MODEL_REGISTRY_VERSION,
  ModelRegistry,
  promotionGate,
};
