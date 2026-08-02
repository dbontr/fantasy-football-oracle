"use strict";

const { assertValid, SCHEMA_VERSIONS } = require("./schema-registry.js");
const { canonicalize, sha256 } = require("./lineage.js");

const DECISION_LEDGER_VERSION = "oracle-decision-ledger-2026.1";

function summarizeResult(result) {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return { type: "array", items: result.length };
  if (typeof result !== "object") return { type: typeof result, value: result };
  const summary = {};
  const preferred = [
    "decision", "score", "grade", "championshipProbability", "playoffProbability",
    "expectedWins", "utility", "computeMs", "engine", "engineVersion",
  ];
  preferred.forEach((key) => {
    if (result[key] !== undefined && typeof result[key] !== "object") summary[key] = result[key];
  });
  if (Array.isArray(result.recommendations)) summary.recommendations = result.recommendations.length;
  if (Array.isArray(result.teams)) summary.teams = result.teams.length;
  if (Array.isArray(result.proposals)) summary.proposals = result.proposals.length;
  return summary;
}

class DecisionLedger {
  constructor(options = {}) {
    if (!options.eventStore) throw new TypeError("DecisionLedger requires eventStore");
    this.eventStore = options.eventStore;
    this.snapshotCatalog = options.snapshotCatalog || null;
    this.clock = options.clock || (() => new Date());
  }

  async initialize() {
    if (!this.eventStore.initialized) await this.eventStore.initialize();
    return this.status();
  }

  async recordDecision(envelope, result, context = {}) {
    assertValid("recommendation", envelope);
    let snapshotDigest = null;
    if (this.snapshotCatalog && context.persistResult !== false) {
      const snapshot = await this.snapshotCatalog.write("decision-result", result, {
        details: {
          decisionId: envelope.decisionId,
          decisionType: envelope.decisionType,
        },
      });
      snapshotDigest = snapshot.digest;
      await this.snapshotCatalog.prune({ kind: "decision-result", keep: 500 });
    }
    const record = {
      schemaVersion: SCHEMA_VERSIONS.recommendation,
      ledgerVersion: DECISION_LEDGER_VERSION,
      envelope: canonicalize(envelope),
      resultDigest: sha256(result),
      resultSnapshotDigest: snapshotDigest,
      resultSummary: summarizeResult(result),
      requestId: context.requestId || null,
      actor: String(context.actor || "oracle"),
      route: context.route || null,
      recordedAt: new Date(this.clock()).toISOString(),
    };
    return this.eventStore.append("decision.recorded", record, {
      id: envelope.decisionId,
      source: "decision-ledger",
      occurredAt: envelope.createdAt,
      details: { replayKey: envelope.replayKey },
    });
  }

  async recordOutcome(decisionId, outcome = {}) {
    const record = {
      schemaVersion: SCHEMA_VERSIONS.outcome,
      decisionId: String(decisionId),
      outcomeType: String(outcome.outcomeType || "observed"),
      recordedAt: new Date(outcome.recordedAt || this.clock()).toISOString(),
      metrics: canonicalize(outcome.metrics || {}),
      notes: String(outcome.notes || ""),
      source: String(outcome.source || "user"),
    };
    assertValid("outcome", record);
    return this.eventStore.append("decision.outcome", record, {
      id: `${record.decisionId}:outcome:${Date.parse(record.recordedAt)}`,
      source: record.source,
      occurredAt: record.recordedAt,
    });
  }

  list(options = {}) {
    const events = this.eventStore.list({
      type: options.type || null,
      afterSequence: options.afterSequence || 0,
      limit: options.limit || 100,
    });
    return events.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      hash: event.hash,
      record: event.payload,
    }));
  }

  findDecision(decisionId) {
    const event = this.eventStore.getById(decisionId);
    if (!event || event.type !== "decision.recorded") return null;
    return {
      sequence: event.sequence,
      hash: event.hash,
      ...event.payload,
    };
  }

  outcomesFor(decisionId) {
    return this.eventStore.list({ type: "decision.outcome", limit: 1000 })
      .filter((event) => event.payload?.decisionId === String(decisionId))
      .map((event) => event.payload);
  }

  status() {
    const store = this.eventStore.status();
    return {
      version: DECISION_LEDGER_VERSION,
      initialized: store.initialized,
      events: store.events,
      valid: store.valid,
      headHash: store.headHash,
      snapshotResults: Boolean(this.snapshotCatalog),
    };
  }
}

module.exports = {
  DECISION_LEDGER_VERSION,
  DecisionLedger,
  summarizeResult,
};
