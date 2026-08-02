"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readBuildMetadata(metadataPath) {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    return { error: error.message, metadata: null };
  }
}

function verifyNativeBinaryIntegrity(binaryPath, metadataPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return { valid: false, reason: "native binary is missing" };
  }
  const loaded = readBuildMetadata(metadataPath);
  if (!loaded || loaded.error) {
    return { valid: false, reason: `native build metadata is unavailable: ${loaded?.error || "unknown"}` };
  }
  const metadata = loaded.metadata || loaded;
  if (metadata.schemaVersion !== 2 || !/^[a-f0-9]{64}$/i.test(metadata.binaryDigest || "")) {
    return { valid: false, reason: "native build metadata is incomplete or unsupported", metadata };
  }
  const binaryDigest = fileSha256(binaryPath);
  if (binaryDigest !== metadata.binaryDigest) {
    return {
      valid: false,
      reason: "native binary digest does not match build metadata",
      binaryDigest,
      metadata,
    };
  }
  return { valid: true, binaryDigest, metadata };
}

module.exports = {
  fileSha256,
  readBuildMetadata,
  verifyNativeBinaryIntegrity,
};
