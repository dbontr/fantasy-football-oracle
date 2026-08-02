"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EvidenceStore,
  normalizeObservation,
} = require("../server/evidence-store.js");

const NOW = Date.parse("2026-08-02T17:00:00.000Z");

async function temporaryStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-evidence-"));
  const filePath = path.join(directory, "evidence.jsonl");
  const store = new EvidenceStore({ filePath, clock: () => NOW });
  await store.initialize();
  return { directory, filePath, store };
}

function marketEvidence(overrides = {}) {
  return {
    entityType: "player",
    entityId: "p1",
    feature: "market.player_points",
    value: 18,
    source: { name: "book-a", reliability: 0.9 },
    confidence: 0.9,
    observedAt: "2026-08-02T15:00:00.000Z",
    ...overrides,
  };
}
test("evidence normalization is deterministic and bounded", () => {
  const first = normalizeObservation(marketEvidence({ value: 100 }), { now: NOW });
  const second = normalizeObservation(marketEvidence({ value: 100 }), { now: NOW });
  assert.equal(first.value, 80);
  assert.equal(first.id, second.id);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.schemaVersion, "evidence-observation/v1");
  assert.throws(() => normalizeObservation({
    ...marketEvidence(),
    expiresAt: "2026-08-02T14:00:00.000Z",
  }), /expiry/i);
});

test("as-of resolution excludes future and expired observations", async () => {
  const context = await temporaryStore();
  try {
    await context.store.ingestMany([
      marketEvidence(),
      marketEvidence({
        value: 22,
        source: { name: "book-b", reliability: 0.8 },
        observedAt: "2026-08-02T16:00:00.000Z",
      }),
      marketEvidence({
        value: 40,
        source: { name: "future", reliability: 1 },
        observedAt: "2026-08-02T18:00:00.000Z",
      }),
      marketEvidence({
        value: 5,
        source: { name: "expired", reliability: 1 },
        observedAt: "2026-08-02T13:00:00.000Z",
        expiresAt: "2026-08-02T14:00:00.000Z",
      }),
    ]);
    const resolved = context.store.resolve(
      "player",
      "p1",
      "market.player_points",
      { asOf: NOW },
    );
    assert.equal(resolved.available, true);
    assert.equal(resolved.observations, 2);
    assert.ok(resolved.value > 18 && resolved.value < 22);
    assert.ok(resolved.standardDeviation > 0);
    assert.ok(resolved.conflict > 0);
    assert.equal(resolved.provenance.some((row) => row.source === "future"), false);
    assert.equal(resolved.provenance.some((row) => row.source === "expired"), false);

    const historical = context.store.resolve(
      "player",
      "p1",
      "market.player_points",
      { asOf: "2026-08-02T13:30:00.000Z" },
    );
    assert.equal(historical.observations, 1);
    assert.equal(historical.value, 5);
  } finally {
    await context.store.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("duplicate and temporary evidence do not mutate persisted state", async () => {
  const context = await temporaryStore();
  try {
    const first = await context.store.append(marketEvidence());
    const duplicate = await context.store.append(marketEvidence());
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(context.store.status().observations, 1);
    const persisted = context.store.resolve("player", "p1", "market.player_points", { asOf: NOW });
    const whatIf = context.store.resolve("player", "p1", "market.player_points", {
      asOf: NOW,
      additionalObservations: [
        marketEvidence({
          id: "temporary",
          value: 30,
          source: { name: "what-if", reliability: 1 },
          confidence: 1,
          observedAt: "2026-08-02T16:30:00.000Z",
        }),
        {
          entityType: "player", entityId: "p1", feature: "role.snap_share",
          value: 0.1, source: { name: "unrelated", reliability: 1 }, confidence: 1,
          observedAt: "2026-08-02T16:30:00.000Z",
        },
      ],
    });
    assert.ok(whatIf.value > persisted.value);
    assert.equal(whatIf.observations, 2);
    assert.equal(context.store.status().observations, 1);
    assert.equal(context.store.query({ entityId: "p1" }).length, 1);
  } finally {
    await context.store.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("categorical evidence exposes entropy and weighted probability", async () => {
  const context = await temporaryStore();
  try {
    await context.store.ingestMany([
      {
        entityType: "player", entityId: "p2", feature: "availability.designation",
        value: "active", source: { name: "official", reliability: 1 }, confidence: 0.95,
        observedAt: "2026-08-02T16:00:00.000Z",
      },
      {
        entityType: "player", entityId: "p2", feature: "availability.designation",
        value: "questionable", source: { name: "reporter", reliability: 0.65 }, confidence: 0.8,
        observedAt: "2026-08-02T16:30:00.000Z",
      },
    ]);
    const resolved = context.store.resolve(
      "player", "p2", "availability.designation", { asOf: NOW },
    );
    assert.equal(resolved.value, "active");
    assert.ok(resolved.probability > 0.5);
    assert.ok(resolved.conflict > 0 && resolved.conflict < 1);
    assert.equal(Object.keys(resolved.distribution).length, 2);
  } finally {
    await context.store.stop();
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("hash-chain corruption is detected on replay", async () => {
  const context = await temporaryStore();
  await context.store.append(marketEvidence());
  await context.store.stop();
  const body = await fs.readFile(context.filePath, "utf8");
  await fs.writeFile(context.filePath, body.replace('"value":18', '"value":19'), "utf8");
  const replay = new EvidenceStore({ filePath: context.filePath, clock: () => NOW });
  try {
    await assert.rejects(
      () => replay.initialize(),
      { code: "EVIDENCE_CHAIN_INVALID" },
    );
  } finally {
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});
