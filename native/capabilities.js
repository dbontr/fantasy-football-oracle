"use strict";

const REQUIRED_NATIVE_TASKS = Object.freeze([
  "draft-simulate",
  "draft-recommend",
  "lineup-optimize",
  "roster-analyze",
  "waivers",
  "trade-analyze",
  "trades-generate",
  "season-simulate",
  "start-sit",
  "league-simulate",
]);

function validateNativeCapabilities(capabilities) {
  const errors = [];
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return { valid: false, errors: ["capabilities must be an object"] };
  }
  if (capabilities.engine !== "oracle-native") {
    errors.push("unexpected native engine identity");
  }
  if (capabilities.protocol !== 1) {
    errors.push("unsupported native protocol");
  }
  if (!Array.isArray(capabilities.tasks)) {
    errors.push("native task list is missing");
  } else {
    const supported = new Set(capabilities.tasks);
    const missing = REQUIRED_NATIVE_TASKS.filter((task) => !supported.has(task));
    if (missing.length) errors.push(`missing native tasks: ${missing.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}

function parseNativeCapabilities(output) {
  let capabilities;
  try {
    capabilities = JSON.parse(String(output || "").trim());
  } catch (error) {
    const invalid = new Error(`Invalid native capability JSON: ${error.message}`);
    invalid.code = "NATIVE_CAPABILITY_INVALID";
    throw invalid;
  }
  const validation = validateNativeCapabilities(capabilities);
  if (!validation.valid) {
    const invalid = new Error(validation.errors.join("; "));
    invalid.code = "NATIVE_CAPABILITY_INVALID";
    invalid.details = validation.errors;
    throw invalid;
  }
  return capabilities;
}

module.exports = {
  REQUIRED_NATIVE_TASKS,
  parseNativeCapabilities,
  validateNativeCapabilities,
};
