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
const {
  createShutdownController,
  installShutdownFileWatcher,
  installSignalHandlers,
} = require("./lifecycle.js");

const STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "app-core.js",
  "app.js",
  "simulation-worker.js",
  "service-worker.js",
  "manifest.webmanifest",
  "lab.html",
  "lab.css",
  "lab.js",
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
    metadataPath: config.nativeBuildMetadataPath,
    requireIntegrity: config.strictArtifactIntegrity,
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
  let cleanupPromise = null;
  const cleanupResources = ({ recordStop = false } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      const attempt = async (component, operation) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
          fastify.log.warn?.({ error, component }, "Oracle resource cleanup failed");
        }
      };
      if (recordStop) {
        await attempt("platform-stop-event", () => controlPlane.eventStore?.append?.(
          "platform.stopped",
          { uptimeSeconds: Math.round(process.uptime()) },
          { source: "platform-control-plane" },
        ));
      }
      await attempt("control-plane", () => controlPlane.stop?.());
      await attempt("dataset-subscription", async () => unsubscribeDataset?.());
      unsubscribeDataset = null;
      await attempt("data-store", async () => dataStore.stop?.());
      await attempt("compute-pool", () => pool.close?.());
      if (ephemeralPlatform) {
        await attempt("ephemeral-platform", () => (
          fs.rm(platformRuntimeDir, { recursive: true, force: true })
        ));
      }
      if (failures.length) {
        throw new AggregateError(failures, "Oracle resource cleanup failed");
      }
    })();
    return cleanupPromise;
  };
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
    try {
      await cleanupResources();
    } catch (cleanupError) {
      fastify.log.warn?.({ error: cleanupError }, "Oracle startup cleanup was incomplete");
    }
    throw error;
  }

  try {
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
      await cleanupResources({ recordStop: true });
    });
  } catch (error) {
    try {
      await cleanupResources();
    } catch (cleanupError) {
      fastify.log.warn?.({ error: cleanupError }, "Oracle route setup cleanup was incomplete");
    }
    throw error;
  }

  return fastify;
}

async function start(options = {}) {
  const builder = options.builder || buildServer;
  const server = await builder(options.buildOptions || {});
  const config = options.config || server.oracleServices?.config || defaultConfig;
  const shutdown = createShutdownController({
    server,
    ...(options.shutdownOptions || {}),
  });
  const removeSignalHandlers = installSignalHandlers({
    shutdown,
    processRef: options.processRef || process,
  });
  const removeShutdownWatcher = installShutdownFileWatcher({
    filePath: config.shutdownRequestPath,
    shutdown,
    onError: (error) => server.log?.error?.(
      { error, filePath: config.shutdownRequestPath },
      "Shutdown request watcher failed",
    ),
    ...(options.shutdownWatcherOptions || {}),
  });
  server.addHook?.("onClose", async () => {
    removeSignalHandlers();
    removeShutdownWatcher();
  });

  let address;
  try {
    address = await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    try {
      await server.close();
    } catch (cleanupError) {
      server.log?.warn?.({ error: cleanupError }, "Listen failure cleanup was incomplete");
    }
    throw error;
  }
  server.log?.info?.({ address }, "Fantasy Football Oracle server ready");
  return { address, server, shutdown };
}

module.exports = {
  buildServer,
  isAllowedStaticPath,
  start,
};

if (require.main === module) {
  start().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
