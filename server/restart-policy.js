"use strict";

function restartDelay(attempt, options = {}) {
  const baseMs = Math.max(1, Number(options.baseMs || 250));
  const maxMs = Math.max(baseMs, Number(options.maxMs || 30_000));
  const exponent = Math.max(0, Math.min(16, Number(attempt || 1) - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

module.exports = { restartDelay };
