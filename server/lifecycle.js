"use strict";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

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
        if (error?.code === "SHUTDOWN_TIMEOUT") forceExit(1);
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

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createShutdownController,
  installSignalHandlers,
  shutdownTimeoutError,
};
