"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FreeSourceCache,
} = require("../server/free-source-cache.js");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-free-cache-"));
  const state = { calls: 0, fail: false, body: JSON.stringify({ value: 1 }) };
  const server = http.createServer((request, response) => {
    state.calls += 1;
    if (state.fail) {
      response.writeHead(503).end("unavailable");
      return;
    }
    if (request.headers["if-none-match"] === '"fixture-v1"') {
      response.writeHead(304, { etag: '"fixture-v1"' }).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(state.body),
      etag: '"fixture-v1"',
    }).end(state.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cache = new FreeSourceCache({
    rootDir: directory,
    allowInsecureLocalhost: true,
    failureThreshold: 2,
    circuitOpenMs: 60_000,
    sources: [{ id: "fixture", origins: [origin], maxBytes: 1024, maxStaleMs: 60_000 }],
  });
  return { cache, directory, origin, server, state };
}

async function cleanup(context) {
  await new Promise((resolve) => context.server.close(resolve));
  await fs.rm(context.directory, { recursive: true, force: true });
}

test("free source cache reuses fresh and conditionally unchanged payloads", async () => {
  const context = await fixture();
  try {
    const first = await context.cache.fetchJson("fixture", `${context.origin}/data`, {
      maximumAgeMs: 60_000,
    });
    const second = await context.cache.fetchJson("fixture", `${context.origin}/data`, {
      maximumAgeMs: 60_000,
    });
    assert.deepEqual(first.data, { value: 1 });
    assert.deepEqual(second.data, { value: 1 });
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.equal(context.state.calls, 1);

    const conditional = await context.cache.fetchJson("fixture", `${context.origin}/data`, {
      force: true,
    });
    assert.equal(conditional.fromCache, true);
    assert.equal(conditional.metadata.cacheReason, "not-modified");
    assert.equal(context.state.calls, 2);
  } finally {
    await cleanup(context);
  }
});

test("free source cache serves bounded stale data on provider failure", async () => {
  const context = await fixture();
  try {
    await context.cache.fetchJson("fixture", `${context.origin}/data`, { force: true });
    context.state.fail = true;
    const fallback = await context.cache.fetchJson("fixture", `${context.origin}/data`, {
      force: true,
    });
    assert.equal(fallback.fromCache, true);
    assert.equal(fallback.metadata.cacheReason, "stale-if-error");
    assert.deepEqual(fallback.data, { value: 1 });
    assert.equal(context.cache.status().sources.fixture.staleFallbacks, 1);
  } finally {
    await cleanup(context);
  }
});

test("free source cache rejects untrusted origins and oversized responses", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      () => context.cache.fetchJson("fixture", "https://example.com/data"),
      { code: "FREE_SOURCE_URL_REJECTED" },
    );
    context.state.body = JSON.stringify({ payload: "x".repeat(2000) });
    await assert.rejects(
      () => context.cache.fetchJson("fixture", `${context.origin}/large`, { force: true }),
      { code: "FREE_SOURCE_TOO_LARGE" },
    );
  } finally {
    await cleanup(context);
  }
});

test("free source cache detects tampered cached bytes", async () => {
  const context = await fixture();
  try {
    const result = await context.cache.fetchJson("fixture", `${context.origin}/data`, { force: true });
    const paths = context.cache.cachePaths("fixture", `${context.origin}/data`);
    await fs.writeFile(paths.payload, Buffer.from("tampered"));
    await assert.rejects(
      () => context.cache.fetchJson("fixture", `${context.origin}/data`, {
        maximumAgeMs: 60_000,
      }),
      { code: "FREE_SOURCE_CACHE_CORRUPT" },
    );
    assert.equal(result.metadata.digest.length, 64);
  } finally {
    await cleanup(context);
  }
});

test("free source cache opens a circuit after repeated uncached failures", async () => {
  const context = await fixture();
  try {
    context.state.fail = true;
    await assert.rejects(() => context.cache.fetchJson("fixture", `${context.origin}/missing-a`, { force: true }));
    await assert.rejects(() => context.cache.fetchJson("fixture", `${context.origin}/missing-b`, { force: true }));
    await assert.rejects(
      () => context.cache.fetchJson("fixture", `${context.origin}/missing-c`, { force: true }),
      { code: "FREE_SOURCE_CIRCUIT_OPEN" },
    );
    assert.ok(context.cache.status().sources.fixture.circuitOpenUntil);
  } finally {
    await cleanup(context);
  }
});
