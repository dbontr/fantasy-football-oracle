"use strict";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function assertCondition(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "PRODUCTION_SMOKE_FAILED";
    throw error;
  }
}

function validateReadiness(payload = {}) {
  assertCondition(payload.ready === true, `Service is not ready: ${(payload.failures || []).join(", ") || payload.status || "unknown"}`);
  assertCondition(payload.status === "ready", `Unexpected readiness status: ${payload.status || "missing"}`);
  assertCondition(payload.dataReady === true, "Player data is not ready");
  assertCondition(payload.eventChainValid === true, "Event chain is not valid");
  if (payload.advancedReady !== null && payload.advancedReady !== undefined) {
    assertCondition(payload.advancedReady === true, "Advanced intelligence is not ready");
    assertCondition(payload.advancedEvidenceValid === true, "Advanced evidence chain is invalid");
  }
  if (payload.freeReady !== null && payload.freeReady !== undefined) {
    assertCondition(payload.freeReady === true, "Free intelligence is not ready");
    assertCondition(payload.freeJournalValid === true, "Free forecast journal chain is invalid");
  }
  if (payload.nativeRequired) {
    assertCondition(payload.nativeAvailable === true, "Required native engine is unavailable");
    assertCondition(Number(payload.liveWorkers || 0) > 0, "Required native workers are not live");
  }
  if (payload.strictArtifacts) {
    assertCondition(payload.artifactValid === true, "Strict artifact integrity is invalid");
  }
  return payload;
}
function validateHealth(payload = {}, options = {}) {
  assertCondition(payload.status === "ok", `Unexpected health status: ${payload.status || "missing"}`);
  const native = payload.compute?.native || payload.compute || {};
  assertCondition(native.available === true, "Native engine is unavailable");
  const workerCount = Number(native.liveWorkers ?? native.workers ?? native.readyWorkers ?? 0);
  assertCondition(workerCount > 0, "Native worker pool is unavailable");
  const artifacts = payload.platform?.artifacts || {};
  assertCondition(artifacts.valid === true, "Artifact integrity is invalid");
  if (options.requireStrict) {
    assertCondition(artifacts.strict === true, "Strict artifact integrity is not enabled");
  }
  return payload;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  assertCondition(response.ok, `${url} returned HTTP ${response.status}`);
  assertCondition(body && typeof body === "object", `${url} did not return JSON`);
  return body;
}

async function runSmoke(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const readiness = validateReadiness(await fetchJson(`${baseUrl}/api/ready`));
  const health = validateHealth(await fetchJson(`${baseUrl}/api/health`), options);
  const root = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(15_000) });
  const html = await root.text();
  assertCondition(root.ok, `Application shell returned HTTP ${root.status}`);
  assertCondition(/Championship control center/i.test(html), "Application shell is missing the championship control center");
  const lab = await fetch(`${baseUrl}/lab.html`, { signal: AbortSignal.timeout(15_000) });
  const labHtml = await lab.text();
  assertCondition(lab.ok, `Research Lab returned HTTP ${lab.status}`);
  assertCondition(/Probability film room/i.test(labHtml), "Research Lab is missing the probability film room");
  const v5 = await fetchJson(`${baseUrl}/api/v5/status`);
  assertCondition(v5.initialized === true, "Advanced intelligence status is not initialized");
  assertCondition(v5.evidence?.valid === true, "Advanced evidence status is invalid");
  const free = await fetchJson(`${baseUrl}/api/v5/free-sources`);
  assertCondition(free.initialized === true, "Free intelligence status is not initialized");
  assertCondition(free.networkAtStartup === false, "Free intelligence performed network work at startup");
  assertCondition(free.journal?.valid === true, "Free forecast journal status is invalid");
  const calibration = await fetchJson(`${baseUrl}/api/v5/calibration/status`);
  assertCondition(calibration.valid === true, "Free calibration artifact is invalid");
  assertCondition(calibration.approved === true, "Free calibration is not holdout approved");
  assertCondition(calibration.validation?.leakageSafe === true, "Free calibration is not leakage safe");
  return { baseUrl, readiness, health, rootStatus: root.status, labStatus: lab.status, v5, free, calibration };
}
async function main() {
  const result = await runSmoke({
    baseUrl: argumentValue("--base", process.env.ORACLE_BASE_URL || DEFAULT_BASE_URL),
    requireStrict: process.argv.includes("--strict"),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    baseUrl: result.baseUrl,
    rootStatus: result.rootStatus,
    labStatus: result.labStatus,
    v5EvidenceObservations: result.v5.evidence.observations,
    liveWorkers: result.readiness.liveWorkers,
    readyWorkers: result.readiness.readyWorkers,
    nativeAvailable: result.readiness.nativeAvailable,
    artifactValid: result.readiness.artifactValid,
    strictArtifacts: result.readiness.strictArtifacts,
    advancedReady: result.readiness.advancedReady,
    advancedEvidenceValid: result.readiness.advancedEvidenceValid,
    freeReady: result.readiness.freeReady,
    freeJournalValid: result.readiness.freeJournalValid,
    freeCalibrationApproved: result.calibration.approved,
    freeCalibrationHoldoutSeason: result.calibration.holdoutSeason,
    freeJournalForecasts: result.free.journal.forecasts,
    freeJournalSettlements: result.free.journal.settlements,
  })}\n`);
}

module.exports = {
  runSmoke,
  validateHealth,
  validateReadiness,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
