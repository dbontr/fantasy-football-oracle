const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENGINE_BLUEPRINT_VERSION,
  LAYERS,
  modelBlueprint,
} = require("../server/engine-blueprint.js");

test("model blueprint describes the complete analytics stack", () => {
  const blueprint = modelBlueprint({ meta: { modelVersion: "test-model" } });
  assert.equal(blueprint.version, ENGINE_BLUEPRINT_VERSION);
  assert.equal(blueprint.modelVersion, "test-model");
  assert.equal(blueprint.layers.length, 15);
  assert.ok(blueprint.readinessScore > 0 && blueprint.readinessScore < 100);
  assert.equal(blueprint.implemented + blueprint.partial + blueprint.planned, LAYERS.length);
});

test("blueprint marks coaching and simulation as operational", () => {
  const blueprint = modelBlueprint();
  const coaching = blueprint.layers.find((layer) => layer.id === "coaching");
  const simulation = blueprint.layers.find((layer) => layer.id === "simulation");
  const tracking = blueprint.layers.find((layer) => layer.id === "tracking");
  assert.equal(coaching.status, "implemented");
  assert.equal(simulation.status, "implemented");
  assert.equal(tracking.status, "partial");
  assert.ok(coaching.available.includes("position development"));
  assert.ok(tracking.available.includes("versioned tracking evidence schema"));
  assert.ok(tracking.missing.includes("coverage shell"));
});
