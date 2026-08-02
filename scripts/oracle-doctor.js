"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  loadArtifactManifest,
  validateArtifactManifest,
} = require("../server/artifact-registry.js");
const { parseNativeCapabilities } = require("../native/capabilities.js");
const { verifyNativeBinaryIntegrity } = require("../native/integrity.js");

function result(id, status, message, details = null) {
  return { id, status, message, ...(details ? { details } : {}) };
}

function summarizeChecks(checks) {
  return checks.reduce((summary, check) => {
    summary[check.status] = (summary[check.status] || 0) + 1;
    return summary;
  }, { pass: 0, warn: 0, fail: 0 });
}

function runCommand(command, args, options = {}) {
  const execution = (options.spawnSync || spawnSync)(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 15_000,
  });
  return {
    ok: execution.status === 0,
    status: execution.status,
    stdout: String(execution.stdout || "").trim(),
    stderr: String(execution.stderr || "").trim(),
    error: execution.error?.message || null,
  };
}

function productionPolicyChecks(config, options = {}) {
  const strict = options.strict === true;
  const checks = [];
  const policyStatus = (condition) => condition ? "pass" : (strict ? "fail" : "warn");
  checks.push(result(
    "config.native-required",
    policyStatus(config.nativeRequired === true),
    config.nativeRequired ? "Native compute is required" : "Native compute is not required",
  ));
  checks.push(result(
    "config.strict-artifacts",
    policyStatus(config.strictArtifactIntegrity === true),
    config.strictArtifactIntegrity
      ? "Strict artifact integrity is enabled"
      : "Strict artifact integrity is disabled",
  ));
  const proxySafe = !config.trustProxy || Boolean(config.adminToken);
  checks.push(result(
    "config.proxy-admin-token",
    proxySafe ? "pass" : "fail",
    proxySafe
      ? "Administrative proxy access is explicitly protected"
      : "ORACLE_TRUST_PROXY requires ORACLE_ADMIN_TOKEN",
  ));
  const productionEnvironment = process.env.NODE_ENV === "production";
  checks.push(result(
    "config.node-environment",
    productionEnvironment ? "pass" : (strict ? "fail" : "warn"),
    productionEnvironment
      ? "NODE_ENV is production"
      : "NODE_ENV is not production",
  ));
  return checks;
}

function probeNativeBinary(binary, options = {}) {
  const execution = runCommand(binary, ["--capabilities"], {
    spawnSync: options.spawnSync,
    timeout: 10_000,
  });
  if (!execution.ok) {
    return { ok: false, error: execution.stderr || execution.error || "probe failed" };
  }
  try {
    return { ok: true, capabilities: parseNativeCapabilities(execution.stdout) };
  } catch (error) {
    return { ok: false, error: `invalid capability response: ${error.message}` };
  }
}

async function writableDirectoryCheck(directory) {
  const absolute = path.resolve(directory);
  const marker = path.join(absolute, `.oracle-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.mkdir(absolute, { recursive: true });
    await fs.writeFile(marker, "ok\n", "utf8");
    await fs.rm(marker, { force: true });
    return { ok: true, directory: absolute };
  } catch (error) {
    await fs.rm(marker, { force: true }).catch(() => {});
    return { ok: false, directory: absolute, error: error.message };
  }
}
function gitChecks(rootDir, options = {}) {
  const checks = [];
  const commandOptions = { cwd: rootDir, spawnSync: options.spawnSync };
  const inside = runCommand("git", ["rev-parse", "--is-inside-work-tree"], commandOptions);
  if (!inside.ok || inside.stdout !== "true") {
    return [result("git.repository", "warn", "Git metadata is unavailable")];
  }
  const head = runCommand("git", ["rev-parse", "HEAD"], commandOptions);
  checks.push(result(
    "git.repository",
    head.ok ? "pass" : "fail",
    head.ok ? `Repository commit ${head.stdout.slice(0, 12)}` : "Cannot resolve repository commit",
  ));
  const status = runCommand("git", ["status", "--porcelain"], commandOptions);
  const dirty = Boolean(status.stdout);
  checks.push(result(
    "git.clean",
    !dirty || options.allowDirty ? (dirty ? "warn" : "pass") : (options.strict ? "fail" : "warn"),
    dirty ? "Repository contains uncommitted changes" : "Repository is clean",
  ));
  const upstream = runCommand("git", ["rev-parse", "@{upstream}"], commandOptions);
  if (!upstream.ok) {
    checks.push(result("git.upstream", "warn", "No upstream branch is configured"));
    return checks;
  }
  const counts = runCommand(
    "git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], commandOptions,
  );
  const [ahead = "?", behind = "?"] = counts.stdout.split(/\s+/);
  const synchronized = counts.ok && ahead === "0" && behind === "0";
  checks.push(result(
    "git.upstream",
    synchronized ? "pass" : (options.strict ? "fail" : "warn"),
    synchronized ? "HEAD matches its upstream" : `Repository drift: ahead ${ahead}, behind ${behind}`,
  ));
  return checks;
}

async function collectDoctorReport(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const config = options.config || require("../server/config.js");
  const strict = options.strict === true;
  const checks = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  checks.push(result(
    "runtime.node",
    nodeMajor >= 20 ? "pass" : "fail",
    `Node.js ${process.versions.node}`,
  ));
  checks.push(...productionPolicyChecks(config, { strict }));
  checks.push(...gitChecks(rootDir, {
    strict,
    allowDirty: options.allowDirty === true,
    spawnSync: options.spawnSync,
  }));

  try {
    const manifest = await loadArtifactManifest(config.artifactManifestPath);
    const validation = await validateArtifactManifest(rootDir, manifest);
    checks.push(result(
      "artifacts.integrity",
      validation.valid ? "pass" : "fail",
      validation.valid
        ? `${validation.files.length} release artifacts verified`
        : validation.errors.join("; "),
      { semanticDigest: manifest.semanticDigest || null },
    ));
  } catch (error) {
    checks.push(result("artifacts.integrity", "fail", error.message));
  }

  const native = probeNativeBinary(config.nativeBinary, { spawnSync: options.spawnSync });
  checks.push(result(
    "native.capabilities",
    native.ok ? "pass" : (config.nativeRequired || strict ? "fail" : "warn"),
    native.ok
      ? `${native.capabilities.engine} ${native.capabilities.version || "unknown"}`
      : `Native engine unavailable: ${native.error}`,
    native.ok ? native.capabilities : null,
  ));
  const nativeMetadataPath = config.nativeBuildMetadataPath
    || path.join(path.dirname(config.nativeBinary), "build-metadata.json");
  const nativeIntegrity = verifyNativeBinaryIntegrity(config.nativeBinary, nativeMetadataPath);
  checks.push(result(
    "native.integrity",
    nativeIntegrity.valid ? "pass" : (config.nativeRequired || strict ? "fail" : "warn"),
    nativeIntegrity.valid
      ? `Native binary verified: ${nativeIntegrity.binaryDigest.slice(0, 12)}`
      : `Native binary integrity failed: ${nativeIntegrity.reason}`,
    nativeIntegrity.valid ? {
      binaryDigest: nativeIntegrity.binaryDigest,
      inputDigest: nativeIntegrity.metadata.inputDigest || null,
    } : null,
  ));

  for (const [id, directory] of [
    ["runtime.data-directory", config.runtimeDir],
    ["runtime.platform-directory", config.platformRuntimeDir],
  ]) {
    const writable = await writableDirectoryCheck(directory);
    checks.push(result(
      id,
      writable.ok ? "pass" : "fail",
      writable.ok
        ? `Writable directory: ${writable.directory}`
        : `Directory is not writable: ${writable.error}`,
    ));
  }

  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    mode: strict ? "production" : "development",
    checkedAt: new Date().toISOString(),
    rootDir,
    summary,
    checks,
  };
}
function parseArguments(argv) {
  const options = { strict: false, allowDirty: false, json: false, rootDir: null };
  for (const argument of argv) {
    if (argument === "--strict") options.strict = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--json") options.json = true;
    else if (argument.startsWith("--root=")) options.rootDir = argument.slice(7);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function renderHuman(report) {
  const lines = report.checks.map((check) => (
    `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}`
  ));
  lines.push(
    `SUMMARY pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await collectDoctorReport(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : renderHuman(report));
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  collectDoctorReport,
  gitChecks,
  parseArguments,
  probeNativeBinary,
  productionPolicyChecks,
  renderHuman,
  runCommand,
  summarizeChecks,
  writableDirectoryCheck,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
