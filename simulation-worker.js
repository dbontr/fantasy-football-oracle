"use strict";

importScripts("app-core.js");

const core = self.FantasyOracleCore;

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type !== "simulate-draft-window") return;
  const requestId = message.requestId;
  try {
    const result = core.simulatePickWindow(message.options || {});
    self.postMessage({ type: "draft-window-result", requestId, result });
  } catch (error) {
    self.postMessage({
      type: "draft-window-error",
      requestId,
      error: error?.message || String(error),
    });
  }
});
