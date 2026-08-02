"use strict";

const os = require("node:os");
const path = require("node:path");

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function stringList(value) {
  return Object.freeze([...new Set(String(value || "").split(",")
    .map((row) => row.trim()).filter(Boolean))]);
}

function duration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const rootDir = path.resolve(__dirname, "..");
const cpuCount = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
const season = integer(process.env.ORACLE_SEASON, new Date().getUTCFullYear(), 2018, 2035);
const runtimeDir = path.resolve(
  process.env.ORACLE_RUNTIME_DIR || path.join(rootDir, "data", "runtime"),
);

module.exports = Object.freeze({
  rootDir,
  host: process.env.HOST || "0.0.0.0",
  port: integer(process.env.PORT, 8787, 1, 65535),
  season,
  bundledDataPath: path.join(rootDir, "data", `players-${season}.json`),
  runtimeDir,
  runtimeDataPath: path.join(runtimeDir, `players-${season}.json`),
  platformRuntimeDir: path.resolve(
    process.env.ORACLE_PLATFORM_RUNTIME_DIR || path.join(runtimeDir, "platform"),
  ),
  advancedRuntimeDir: path.resolve(
    process.env.ORACLE_ADVANCED_RUNTIME_DIR || path.join(runtimeDir, "platform", "advanced-intelligence"),
  ),
  freeRuntimeDir: path.resolve(
    process.env.ORACLE_FREE_RUNTIME_DIR || path.join(runtimeDir, "platform", "free-intelligence"),
  ),
  freeCalibrationPath: path.resolve(
    process.env.ORACLE_FREE_CALIBRATION_PATH
      || path.join(rootDir, "data", "calibration", "free-probabilistic.json"),
  ),
  shutdownRequestPath: process.env.ORACLE_SHUTDOWN_REQUEST_PATH
    ? path.resolve(process.env.ORACLE_SHUTDOWN_REQUEST_PATH)
    : "",
  artifactManifestPath: path.resolve(
    process.env.ORACLE_ARTIFACT_MANIFEST || path.join(rootDir, "data", "artifact-manifest.json"),
  ),
  workerFile: path.join(__dirname, "compute-worker.js"),
  nativeBinary: path.resolve(
    process.env.ORACLE_NATIVE_BINARY || path.join(
      rootDir,
      "native",
      "bin",
      process.platform === "win32" ? "oracle-engine.exe" : "oracle-engine",
    ),
  ),
  nativeBuildMetadataPath: path.resolve(
    process.env.ORACLE_NATIVE_BUILD_METADATA || path.join(
      rootDir, "native", "bin", "build-metadata.json",
    ),
  ),
  nativeDisabled: process.env.ORACLE_NATIVE_DISABLED === "true",
  nativeRequired: process.env.ORACLE_NATIVE_REQUIRED === "true",
  nativeWorkerCount: integer(
    process.env.ORACLE_NATIVE_WORKERS,
    Math.max(1, Math.min(4, Math.floor(cpuCount / 2))),
    1,
    Math.max(1, cpuCount),
  ),
  workerCount: integer(
    process.env.ORACLE_WORKERS,
    Math.max(1, Math.min(4, cpuCount - 1)),
    1,
    Math.max(1, cpuCount),
  ),
  maxQueue: integer(process.env.ORACLE_MAX_QUEUE, 64, 4, 1000),
  maxEvidenceObservations: integer(
    process.env.ORACLE_MAX_EVIDENCE_OBSERVATIONS, 250_000, 100, 5_000_000,
  ),
  maxEvidenceBatch: integer(process.env.ORACLE_MAX_EVIDENCE_BATCH, 500, 1, 5000),
  maxAdvancedForecastPlayers: integer(
    process.env.ORACLE_MAX_ADVANCED_FORECAST_PLAYERS, 64, 1, 128,
  ),
  maxAdvancedScenarios: integer(
    process.env.ORACLE_MAX_ADVANCED_SCENARIOS, 50_000, 100, 50_000,
  ),
  freeSources: stringList(process.env.ORACLE_FREE_SOURCES),
  freeSyncEnabled: process.env.ORACLE_FREE_SYNC_ENABLED === "true",
  freeSyncIntervalMs: duration(
    process.env.ORACLE_FREE_SYNC_INTERVAL_MS,
    6 * 60 * 60 * 1000,
    60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
  ),
  sleeperLeagueId: String(process.env.ORACLE_SLEEPER_LEAGUE_ID || ""),
  openMeteoNonCommercialAcknowledged:
    process.env.ORACLE_OPEN_METEO_NONCOMMERCIAL_ACK === "true",
  maxForecastJournalRecords: integer(
    process.env.ORACLE_MAX_FORECAST_JOURNAL_RECORDS, 200_000, 1000, 2_000_000,
  ),
  taskTimeoutMs: duration(process.env.ORACLE_TASK_TIMEOUT_MS, 45_000, 2_000, 300_000),
  defaultSimulations: integer(process.env.ORACLE_DEFAULT_SIMULATIONS, 15_000, 100, 50_000),
  maxSimulations: integer(process.env.ORACLE_MAX_SIMULATIONS, 50_000, 1_000, 250_000),
  bodyLimitBytes: integer(process.env.ORACLE_BODY_LIMIT_BYTES, 2_500_000, 64_000, 20_000_000),
  refreshIntervalMs: duration(
    process.env.ORACLE_REFRESH_INTERVAL_MS,
    6 * 60 * 60 * 1000,
    5 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
  ),
  minimumRefreshMs: duration(
    process.env.ORACLE_MINIMUM_REFRESH_MS,
    10 * 60 * 1000,
    30_000,
    24 * 60 * 60 * 1000,
  ),
  strictArtifactIntegrity: process.env.ORACLE_STRICT_ARTIFACT_INTEGRITY === "true",
  backupRpoMs: duration(
    process.env.ORACLE_BACKUP_RPO_MS,
    24 * 60 * 60 * 1000,
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000,
  ),
  maxChampionshipActions: integer(
    process.env.ORACLE_MAX_CHAMPIONSHIP_ACTIONS, 24, 1, 64,
  ),
  championshipTimeoutMs: duration(
    process.env.ORACLE_CHAMPIONSHIP_TIMEOUT_MS, 180_000, 10_000, 600_000,
  ),
  sloTargets: Object.freeze({
    latencyP95Ms: Object.freeze({
      oracle_http_request_duration_ms: duration(
        process.env.ORACLE_HTTP_P95_SLO_MS, 3_000, 100, 60_000,
      ),
      championship_evaluate_duration_ms: duration(
        process.env.ORACLE_CHAMPIONSHIP_P95_SLO_MS, 180_000, 10_000, 600_000,
      ),
    }),
    minimumGauge: Object.freeze({
      oracle_players_loaded: integer(process.env.ORACLE_MIN_PLAYER_COVERAGE, 600, 100, 2000),
    }),
  }),
  adminToken: String(process.env.ORACLE_ADMIN_TOKEN || ""),
  trustProxy: process.env.ORACLE_TRUST_PROXY === "true",
  logLevel: process.env.LOG_LEVEL || "info",
});
