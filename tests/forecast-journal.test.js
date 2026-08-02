"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ForecastJournal } = require("../server/forecast-journal.js");

function forecast(overrides = {}) {
  const mean = overrides.mean ?? 15;
  return {
    schemaVersion: "probabilistic-forecast/v1",
    version: "fixture-v1",
    season: overrides.season ?? 2026,
    week: overrides.week ?? 1,
    asOf: overrides.asOf ?? "2026-09-10T12:00:00.000Z",
    player: {
      id: overrides.playerId ?? "p1",
      name: overrides.name ?? "Player One",
      position: overrides.position ?? "WR",
      team: "DET",
    },
    baseline: { mean: mean - 1, reliability: 0.8 },
    availability: { probability: 0.95, confidence: 0.8 },
    activeDistribution: { mean: mean / 0.95, standardDeviation: 4 },
    distribution: {
      shape: "zero-inflated-normal",
      mean,
      standardDeviation: 5,
      p10: Math.max(0, mean - 6),
      p25: Math.max(0, mean - 3),
      p50: mean,
      p75: mean + 3,
      p90: mean + 6,
      p95: mean + 8,
      cvar10: Math.max(0, mean - 7),
    },
    probabilities: { bustThreshold: 8, ceilingThreshold: 22 },
    confidence: 0.78,
  };
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-forecast-journal-"));
  const filePath = path.join(directory, "journal.jsonl");
  const journal = new ForecastJournal({ filePath, clock: () => Date.parse("2026-09-20T12:00:00Z") });
  await journal.initialize();
  return { directory, filePath, journal };
}

async function cleanup(context) {
  await context.journal.stop();
  await fs.rm(context.directory, { recursive: true, force: true });
}

function outcome(overrides = {}) {
  return {
    season: overrides.season ?? 2026,
    week: overrides.week ?? 1,
    oraclePlayerId: overrides.playerId ?? "p1",
    sourcePlayerId: overrides.sourcePlayerId ?? "gsis-p1",
    name: overrides.name ?? "Player One",
    position: overrides.position ?? "WR",
    team: "DET",
    played: overrides.played ?? true,
    pointsPpr: overrides.pointsPpr ?? 12,
    pointsHalf: overrides.pointsHalf ?? 10,
    pointsStandard: overrides.pointsStandard ?? 8,
    opportunities: overrides.opportunities ?? 10,
  };
}

test("forecast journal deduplicates repeated snapshots within a time bucket", async () => {
  const context = await fixture();
  try {
    const first = await context.journal.recordForecasts([forecast()]);
    const duplicate = await context.journal.recordForecasts([forecast({
      asOf: "2026-09-10T13:00:00.000Z",
    })]);
    const later = await context.journal.recordForecasts([forecast({
      asOf: "2026-09-10T19:00:00.000Z",
      mean: 16,
    })]);
    assert.equal(first[0].inserted, true);
    assert.equal(duplicate[0].duplicate, true);
    assert.equal(later[0].inserted, true);
    assert.equal(context.journal.status().forecasts, 2);
  } finally {
    await cleanup(context);
  }
});

test("settlement scores every eligible snapshot but trains on the latest", async () => {
  const context = await fixture();
  try {
    await context.journal.recordForecasts([
      forecast({ asOf: "2026-09-10T08:00:00.000Z", mean: 15 }),
      forecast({ asOf: "2026-09-10T20:00:00.000Z", mean: 13 }),
    ]);
    const settled = await context.journal.settleOutcomes([outcome()], {
      currentWeek: 2,
      observedAt: "2026-09-15T12:00:00.000Z",
    });
    assert.equal(settled.length, 2);
    assert.ok(settled.every((row) => row.score.absoluteError >= 0));
    assert.equal(context.journal.status().settlements, 2);

    const rows = context.journal.trainingRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].forecast.distribution.mean, 13);
    const report = context.journal.report();
    assert.equal(report.targets, 1);
    assert.equal(report.summary.samples, 1);
    assert.equal(report.byPosition.WR.samples, 1);
  } finally {
    await cleanup(context);
  }
});

test("current and future weeks do not settle without an explicit override", async () => {
  const context = await fixture();
  try {
    await context.journal.recordForecasts([forecast({ week: 2 })]);
    const skipped = await context.journal.settleOutcomes([outcome({ week: 2 })], {
      currentWeek: 2,
      observedAt: "2026-09-22T12:00:00.000Z",
    });
    assert.equal(skipped.length, 0);
    assert.equal(context.journal.status().unresolved, 1);

    const forced = await context.journal.settleOutcomes([outcome({ week: 2 })], {
      currentWeek: 2,
      force: true,
      observedAt: "2026-09-22T12:00:00.000Z",
    });
    assert.equal(forced.length, 1);
  } finally {
    await cleanup(context);
  }
});

test("forecast journal replays persistent state exactly", async () => {
  const context = await fixture();
  try {
    await context.journal.recordForecasts([forecast()]);
    await context.journal.settleOutcomes([outcome()], {
      currentWeek: 2,
      observedAt: "2026-09-15T12:00:00.000Z",
    });
    const before = context.journal.status();
    await context.journal.stop();

    const replay = new ForecastJournal({ filePath: context.filePath });
    await replay.initialize();
    try {
      const after = replay.status();
      assert.equal(after.records, before.records);
      assert.equal(after.forecasts, before.forecasts);
      assert.equal(after.settlements, before.settlements);
      assert.equal(after.headHash, before.headHash);
      assert.equal(replay.trainingRows().length, 1);
      assert.equal((await replay.verifyFile()).valid, true);
    } finally {
      await replay.stop();
    }
  } finally {
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});

test("forecast journal rejects tampered persisted records", async () => {
  const context = await fixture();
  await context.journal.recordForecasts([forecast()]);
  await context.journal.stop();
  const body = await fs.readFile(context.filePath, "utf8");
  const tampered = body.replace('"mean":15', '"mean":16');
  assert.notEqual(tampered, body);
  await fs.writeFile(context.filePath, tampered, "utf8");
  const replay = new ForecastJournal({ filePath: context.filePath });
  try {
    await assert.rejects(
      () => replay.initialize(),
      { code: "FORECAST_JOURNAL_INVALID" },
    );
  } finally {
    await fs.rm(context.directory, { recursive: true, force: true });
  }
});
