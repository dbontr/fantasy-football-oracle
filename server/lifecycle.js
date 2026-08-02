"use strict";

const fs = require("node:fs/promises");

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_POLL_MS = 500;

function shutdownTimeoutError(timeoutMs) {
  const error = new Error(`Oracle shutdown exceeded ${timeoutMs}ms`);
  error.code = "SHUTDOWN_TIMEOUT";
  return error;
}

function createShutdownController(options = {}) {
  const {
    server,
    processRef = process,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    forceExit = (code) => processRef.exit(code),
  } = options;
  if (!server || typeof server.close !== "function") {
    throw new TypeError("A closable server is required");
  }

  let activeShutdown = null;
  return function shutdown(signal = "unknown") {
    if (activeShutdown) return activeShutdown;
    activeShutdown = (async () => {
      server.log?.info?.({ signal, timeoutMs }, "Shutting down Fantasy Football Oracle");
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(shutdownTimeoutError(timeoutMs)), timeoutMs);
        timer?.unref?.();
      });
      try {
        await Promise.race([Promise.resolve().then(() => server.close()), timeout]);
        processRef.exitCode = 0;
        return { closed: true, signal };
      } catch (error) {
        processRef.exitCode = 1;
        server.log?.error?.({ error, signal }, "Fantasy Football Oracle shutdown failed");
        forceExit(1);
        throw error;
      } finally {
        if (timer) clearTimer(timer);
      }
    })();
    return activeShutdown;
  };
}

function installSignalHandlers(options = {}) {
  const { shutdown, processRef = process } = options;
  if (typeof shutdown !== "function") {
    throw new TypeError("A shutdown function is required");
  }
  const handlers = new Map([
    ["SIGINT", () => void shutdown("SIGINT").catch(() => {})],
    ["SIGTERM", () => void shutdown("SIGTERM").catch(() => {})],
  ]);
  for (const [signal, handler] of handlers) processRef.once(signal, handler);
  return () => {
    for (const [signal, handler] of handlers) {
      processRef.removeListener?.(signal, handler);
    }
  };
}

function installShutdownFileWatcher(options = {}) {
  const {
    filePath,
    shutdown,
    fsRef = fs,
    intervalMs = DEFAULT_SHUTDOWN_POLL_MS,
    setIntervalRef = setInterval,
    clearIntervalRef = clearInterval,
    onError = () => {},
  } = options;
  if (!filePath) return () => {};
  if (typeof shutdown !== "function") {
    throw new TypeError("A shutdown function is required");
  }

  let stopped = false;
  let checking = false;
  const poll = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await fsRef.stat(filePath);
      await fsRef.rm(filePath, { force: true });
      await shutdown("shutdown-request");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      checking = false;
    }
  };
  const timer = setIntervalRef(() => {
    void poll().catch(onError);
  }, Math.max(100, Number(intervalMs || DEFAULT_SHUTDOWN_POLL_MS)));
  timer?.unref?.();
  return () => {
    stopped = true;
    clearIntervalRef(timer);
  };
}

module.exports = {
  DEFAULT_SHUTDOWN_POLL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createShutdownController,
  installShutdownFileWatcher,
  installSignalHandlers,
  shutdownTimeoutError,
};
