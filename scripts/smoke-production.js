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
  if (payload.nativeRequired) {
    assertCondition(payload.nativeAvailable === true, "Required native engine is unavailable");
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
  const workerCount = Number(native.workers ?? native.readyWorkers ?? 0);
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
  return { baseUrl, readiness, health, rootStatus: root.status };
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
    readyWorkers: result.readiness.readyWorkers,
    nativeAvailable: result.readiness.nativeAvailable,
    artifactValid: result.readiness.artifactValid,
    strictArtifacts: result.readiness.strictArtifacts,
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
