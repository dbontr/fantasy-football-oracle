"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const compress = require("@fastify/compress");
const helmet = require("@fastify/helmet");
const rateLimit = require("@fastify/rate-limit");
const staticPlugin = require("@fastify/static");

const defaultConfig = require("./config.js");
const { registerApiRoutes } = require("./api.js");
const { DataStore } = require("./data-store.js");
const { WorkerPool } = require("./worker-pool.js");
const { NativeEnginePool } = require("./native-engine-pool.js");
const { HybridComputePool } = require("./hybrid-compute-pool.js");
const { PlatformControlPlane } = require("./platform-control-plane.js");
const { publicErrorPayload, statusForError } = require("./http-errors.js");
const { createShutdownController, installSignalHandlers } = require("./lifecycle.js");

const STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "app-core.js",
  "app.js",
  "simulation-worker.js",
  "service-worker.js",
  "manifest.webmanifest",
]);

function isAllowedStaticPath(pathName) {
  const normalized = String(pathName || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (STATIC_FILES.has(normalized)) return true;
  if (/^data\/players-\d{4}\.json$/.test(normalized)) return true;
  if (/^icons\/[a-z0-9._-]+\.(?:png|svg)$/.test(normalized)) return true;
  return normalized === "tools/espn-oracle.user.js";
}

async function buildServer(options = {}) {
  const config = { ...defaultConfig, ...(options.config || {}) };
  const fastify = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
  });
  const dataStore = options.dataStore || new DataStore(config, fastify.log);
  const fallbackPool = new WorkerPool({
    workerFile: config.workerFile,
    size: config.workerCount,
    maxQueue: config.maxQueue,
    taskTimeoutMs: config.taskTimeoutMs,
    logger: fastify.log,
  });
  const nativePool = new NativeEnginePool({
    binary: config.nativeDisabled ? null : config.nativeBinary,
    size: config.nativeWorkerCount,
    maxQueue: config.maxQueue,
    taskTimeoutMs: config.taskTimeoutMs,
    logger: fastify.log,
  });
  const pool = options.pool || new HybridComputePool({
    native: nativePool,
    fallback: fallbackPool,
    required: config.nativeRequired,
    logger: fastify.log,
  });
  const ephemeralPlatform = !options.controlPlane && options.logger === false;
  const platformRuntimeDir = options.platformRuntimeDir || (ephemeralPlatform
    ? path.join(os.tmpdir(), `oracle-platform-${process.pid}-${crypto.randomUUID()}`)
    : config.platformRuntimeDir);
  const controlPlane = options.controlPlane || new PlatformControlPlane({
    config, rootDir: config.rootDir, runtimeDir: platformRuntimeDir, logger: fastify.log,
  });

  await fastify.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://a.espncdn.com", "https://sleepercdn.com"],
        connectSrc: [
          "'self'",
          "https://api.sleeper.app",
          "https://lm-api-reads.fantasy.espn.com",
        ],
      },
    },
  });

  await fastify.register(compress, {
    global: true,
    threshold: 1024,
  });
  await fastify.register(rateLimit, {
    global: false,
  });

  let unsubscribeDataset = null;
  try {
    controlPlane.attachFastify?.(fastify);
    pool.start();
    await dataStore.initialize();
    const initialStatus = dataStore.getStatus();
    if (typeof pool.setDataset === "function") {
      await pool.setDataset(initialStatus.etag, dataStore.getDataset().players);
    }
    unsubscribeDataset = typeof dataStore.onDataset === "function"
      ? dataStore.onDataset((dataset, status) => (
          typeof pool.setDataset === "function"
            ? pool.setDataset(status.etag, dataset.players)
            : null
        ))
      : null;
    await controlPlane.initialize?.({ dataStore, pool });
    fastify.decorate("oracleServices", { config, dataStore, pool, controlPlane });
    await registerApiRoutes(fastify, { config, dataStore, pool, controlPlane });
  } catch (error) {
    unsubscribeDataset?.();
    dataStore.stop?.();
    try {
      await controlPlane.stop?.();
    } catch (cleanupError) {
      fastify.log.warn?.({ error: cleanupError }, "Control-plane startup cleanup failed");
    }
    try {
      await pool.close();
    } catch (cleanupError) {
      fastify.log.warn?.({ error: cleanupError }, "Compute-pool startup cleanup failed");
    }
    if (ephemeralPlatform) {
      await fs.rm(platformRuntimeDir, { recursive: true, force: true });
    }
    throw error;
  }

  await fastify.register(staticPlugin, {
    root: config.rootDir,
    prefix: "/",
    index: false,
    redirect: false,
    serveDotFiles: false,
    allowedPath: isAllowedStaticPath,
    cacheControl: true,
    maxAge: "5m",
    immutable: false,
  });

  fastify.get("/", async (_request, reply) => (
    reply.header("cache-control", "no-cache").sendFile("index.html")
  ));
  fastify.get("/index.html", async (_request, reply) => (
    reply.header("cache-control", "no-cache").sendFile("index.html")
  ));

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: "Not Found",
        message: "Unknown Oracle API route",
      });
    }
    if (!path.extname(request.url.split("?")[0])) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = statusForError(error);
    const log = statusCode >= 500 ? request.log.error : request.log.warn;
    log.call(request.log, { error, requestId: request.id }, "Request failed");
    return reply
      .header("cache-control", "no-store")
      .code(statusCode)
      .send(publicErrorPayload(error, statusCode, request.id));
  });

  fastify.addHook("onClose", async () => {
    try {
      await controlPlane.eventStore?.append?.(
        "platform.stopped",
        { uptimeSeconds: Math.round(process.uptime()) },
        { source: "platform-control-plane" },
      );
    } catch {}
    await controlPlane.stop?.();
    unsubscribeDataset?.();
    dataStore.stop();
    await pool.close();
    if (ephemeralPlatform) await fs.rm(platformRuntimeDir, { recursive: true, force: true });
  });

  return fastify;
}

async function start() {
  const server = await buildServer();
  const address = await server.listen({
    host: defaultConfig.host,
    port: defaultConfig.port,
  });
  server.log.info({ address }, "Fantasy Football Oracle server ready");

  const shutdown = createShutdownController({ server });
  installSignalHandlers({ shutdown });
}

module.exports = {
  buildServer,
  isAllowedStaticPath,
};

if (require.main === module) {
  start().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
