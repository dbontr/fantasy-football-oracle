"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./lineage.js");
const {
  PROBABILISTIC_CALIBRATION_VERSION,
  calibrationStatus,
} = require("./probabilistic-calibration.js");

const DEFAULT_PATH = path.resolve(
  __dirname,
  "..",
  "data",
  "calibration",
  "free-probabilistic.json",
);

function validateCalibrationDocument(value) {
  if (!value || value.version !== PROBABILISTIC_CALIBRATION_VERSION) {
    return { valid: false, error: "Free calibration version is invalid" };
  }
  if (value.schemaVersion !== "probabilistic-calibration/v1") {
    return { valid: false, error: "Free calibration schema is invalid" };
  }
  if (!value.groups?.all || typeof value.groups.all !== "object") {
    return { valid: false, error: "Free calibration groups are missing" };
  }
  const { digest, ...core } = value;
  if (!digest || sha256(core) !== digest) {
    return { valid: false, error: "Free calibration digest is invalid" };
  }
  if (value.validation?.leakageSafe !== true || !value.holdoutSeason) {
    return { valid: false, error: "Free calibration lacks a leakage-safe holdout" };
  }
  return { valid: true };
}

class FreeCalibrationLoader {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || DEFAULT_PATH);
    this.model = null;
    this.mtimeMs = 0;
    this.lastError = null;
  }

  load(options = {}) {
    try {
      const stat = fs.statSync(this.filePath);
      if (!options.force && this.model && stat.mtimeMs === this.mtimeMs) return this.model;
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const validation = validateCalibrationDocument(value);
      if (!validation.valid) {
        throw Object.assign(new Error(validation.error), {
          code: "FREE_CALIBRATION_INVALID",
        });
      }
      this.model = value;
      this.mtimeMs = stat.mtimeMs;
      this.lastError = null;
      return this.model;
    } catch (error) {
      if (error.code === "ENOENT") {
        this.model = null;
        this.mtimeMs = 0;
        this.lastError = null;
        return null;
      }
      this.lastError = {
        code: error.code || "FREE_CALIBRATION_INVALID",
        message: String(error.message || error),
      };
      if (options.optional === true) return null;
      throw error;
    }
  }

  status() {
    const model = this.load({ optional: true });
    return {
      ...calibrationStatus(model),
      valid: Boolean(model) && !this.lastError,
      error: this.lastError,
    };
  }
}

module.exports = {
  DEFAULT_PATH,
  FreeCalibrationLoader,
  validateCalibrationDocument,
};
