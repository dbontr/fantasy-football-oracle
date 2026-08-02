"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PlayerIdentityResolver,
  canonicalName,
  normalizeTeam,
} = require("../server/player-identity.js");

const players = [
  { id: "4429795", name: "Jahmyr Gibbs", position: "RB", team: "DET" },
  { id: "4362628", name: "Ja'Marr Chase", position: "WR", team: "CIN" },
  { id: "100", name: "Chris Johnson", position: "RB", team: "TEN" },
  { id: "101", name: "Chris Johnson", position: "RB", team: "NYJ" },
];

test("identity normalization is stable across punctuation and aliases", () => {
  assert.equal(canonicalName("Ja'Marr Chase Jr."), "ja marr chase");
  assert.equal(normalizeTeam("JAC"), "JAX");
  assert.equal(normalizeTeam("WFT"), "WSH");
});

test("identity resolver prioritizes external ids", () => {
  const resolver = new PlayerIdentityResolver(players);
  const result = resolver.resolve({
    espn_id: "4429795",
    display_name: "Wrong Name",
    position: "WR",
    team: "SEA",
  });
  assert.equal(result.matched, true);
  assert.equal(result.oraclePlayerId, "4429795");
  assert.equal(result.method, "espn-id");
  assert.equal(result.confidence, 1);
});

test("identity resolver uses guarded unique name matches", () => {
  const resolver = new PlayerIdentityResolver(players);
  const exact = resolver.resolve({
    full_name: "Ja'Marr Chase",
    position: "WR",
    team: "CIN",
  });
  assert.equal(exact.matched, true);
  assert.equal(exact.method, "name-position-team");

  const ambiguous = resolver.resolve({
    name: "Chris Johnson",
    position: "RB",
  });
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.method, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

test("identity resolver learns non-conflicting external identifiers", () => {
  const resolver = new PlayerIdentityResolver(players);
  const summary = resolver.registerRecords([
    {
      espn_id: "4362628",
      sleeper_id: "sleeper-chase",
      gsis_id: "00-0036900",
      display_name: "Ja'Marr Chase",
      position: "WR",
      team: "CIN",
    },
  ], { source: "fixture" });
  assert.equal(summary.matched, 1);
  assert.equal(summary.registered, 3);
  assert.equal(
    resolver.resolve({ sleeper_id: "sleeper-chase" }).oraclePlayerId,
    "4362628",
  );
  assert.equal(resolver.status().conflictCount, 0);
});

test("identity resolver refuses conflicting external identifiers", () => {
  const resolver = new PlayerIdentityResolver(players);
  resolver.registerRecords([{
    espn_id: "4429795",
    sleeper_id: "shared-id",
    name: "Jahmyr Gibbs",
    position: "RB",
    team: "DET",
  }]);
  resolver.registerRecords([{
    espn_id: "4362628",
    sleeper_id: "shared-id",
    name: "Ja'Marr Chase",
    position: "WR",
    team: "CIN",
  }]);
  assert.equal(resolver.resolve({ sleeper_id: "shared-id" }).oraclePlayerId, "4429795");
  assert.equal(resolver.status().conflictCount, 1);
});
