"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  backtestFreeCalibration,
  runWalkForward,
} = require("../server/free-walk-forward.js");

function outcomes(seasons = [2023, 2024, 2025], players = 36) {
  const rows = [];
  for (const season of seasons) {
    for (let week = 1; week <= 17; week += 1) {
      for (let index = 0; index < players; index += 1) {
        const position = index % 3 === 0 ? "RB" : index % 3 === 1 ? "WR" : "QB";
        const base = position === "QB" ? 18 : position === "RB" ? 11 : 10;
        const ability = (index % 9) * 0.65;
        const seasonal = (season - seasons[0]) * 0.25;
        const weekly = ((week + index * 2) % 7) - 3;
        const played = (week + index) % 23 !== 0;
        const points = played ? Math.max(0, base + ability + seasonal + weekly * 0.8) : 0;
        const opportunities = played
          ? position === "QB" ? 30 + (index % 8) : 8 + (index % 12)
          : 0;
        rows.push({
          season,
          week,
          sourcePlayerId: `player-${index}`,
          oraclePlayerId: null,
          name: `Player ${index}`,
          position,
          team: `T${index % 8}`,
          played,
          pointsPpr: points,
          pointsHalf: points - (position === "WR" ? 1 : 0),
          pointsStandard: points - (position === "WR" ? 2 : 0),
          opportunities,
          pointsPerOpportunity: opportunities ? points / opportunities : null,
          receptions: position === "WR" && played ? 4 + (index % 4) : 0,
          targets: position === "WR" && played ? 6 + (index % 5) : 0,
          carries: position === "RB" && played ? opportunities : 0,
          passAttempts: position === "QB" && played ? opportunities : 0,
        });
      }
    }
  }
  return rows;
}

test("walk-forward forecasts use only outcomes from earlier weeks", () => {
  const source = outcomes([2024], 20);
  const original = runWalkForward(source, { minimumPlayerHistory: 2 });
  const target = original.forecastRows.find((row) => (
    row.player.id === "player-3" && row.week === 8
  ));
  assert.ok(target);
  assert.equal(target.modelInputs.cutoff, "2024:7");

  const mutated = source.map((row) => (
    row.sourcePlayerId === "player-3" && row.week === 8
      ? { ...row, pointsPpr: row.pointsPpr + 1000 }
      : row
  ));
  const rerun = runWalkForward(mutated, { minimumPlayerHistory: 2 });
  const sameTarget = rerun.forecastRows.find((row) => (
    row.player.id === "player-3" && row.week === 8
  ));
  assert.deepEqual(sameTarget.distribution, target.distribution);
  assert.deepEqual(sameTarget.modelInputs, target.modelInputs);

  const nextWeek = rerun.forecastRows.find((row) => (
    row.player.id === "player-3" && row.week === 9
  ));
  const originalNext = original.forecastRows.find((row) => (
    row.player.id === "player-3" && row.week === 9
  ));
  assert.notEqual(nextWeek.distribution.mean, originalNext.distribution.mean);
});

test("walk-forward output is deterministic and probabilistically ordered", () => {
  const source = outcomes([2024], 24);
  const first = runWalkForward(source, { minimumPlayerHistory: 2, generatedAt: "2026-01-01T00:00:00Z" });
  const second = runWalkForward([...source].reverse(), {
    minimumPlayerHistory: 2,
    generatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(first.forecasts, second.forecasts);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.forecastRows, second.forecastRows);
  assert.ok(first.coverage > 0.7);
  assert.ok(first.forecastRows.every((forecast) => (
    forecast.distribution.p10 <= forecast.distribution.p50
      && forecast.distribution.p50 <= forecast.distribution.p90
  )));
  assert.ok(first.summary.rmse > 0);
  assert.ok(first.summary.wis > 0);
});

test("free calibration backtest reserves the final season as holdout", () => {
  const result = backtestFreeCalibration(outcomes(), {
    minimumPlayerHistory: 2,
    minimumSamples: 80,
    minimumHoldoutSamples: 200,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(result.seasons, [2023, 2024, 2025]);
  assert.deepEqual(result.trainingSeasons, [2023, 2024]);
  assert.equal(result.holdoutSeason, 2025);
  assert.equal(result.calibration.validation.leakageSafe, true);
  assert.equal(result.calibration.validation.holdoutSeason, 2025);
  assert.ok(result.calibration.validation.evaluation.samples >= 200);
  assert.equal(result.calibration.trainingSeasons.includes(2025), false);
  assert.ok(result.leakageControls.some((row) => /final season/i.test(row)));
  assert.equal(result.digest.length, 64);
});

test("free calibration backtest rejects a single-season evaluation", () => {
  assert.throws(
    () => backtestFreeCalibration(outcomes([2025], 20)),
    /at least two seasons/i,
  );
});
