"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { canonicalize, sha256 } = require("./lineage.js");

const FREE_SOURCE_CACHE_VERSION = "oracle-free-source-cache-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.trunc(finite(value, fallback))));
}

function iso(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("A finite timestamp is required");
  return new Date(milliseconds).toISOString();
}

function bufferDigest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function atomicBufferWrite(filePath, buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, buffer);
  await fs.rename(temporary, filePath);
}

async function atomicJsonWrite(filePath, value) {
  await atomicBufferWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function sourceDefinition(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) throw new TypeError("Free source definition requires an id");
  const origins = [...new Set((input.origins || []).map((value) => new URL(value).origin))];
  const redirectOrigins = [...new Set((input.redirectOrigins || []).map((value) => (
    new URL(value).origin
  )))];
  if (!origins.length) throw new TypeError(`Free source ${id} requires at least one origin`);
  return Object.freeze({
    id,
    origins,
    redirectOrigins,
    pathPrefixes: (input.pathPrefixes || ["/"]).map(String),
    attribution: String(input.attribution || id),
    license: String(input.license || "unspecified"),
    termsUrl: input.termsUrl ? String(input.termsUrl) : null,
    maxBytes: clampInteger(input.maxBytes, 20 * 1024 * 1024, 1024, 250 * 1024 * 1024),
    minFetchIntervalMs: clampInteger(input.minFetchIntervalMs, 60_000, 0, 30 * 24 * 60 * 60 * 1000),
    maxStaleMs: clampInteger(input.maxStaleMs, 7 * 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000),
  });
}

function validateSourceUrl(definition, value, options = {}) {
  const url = value instanceof URL ? value : new URL(String(value));
  const localHttp = options.allowInsecureLocalhost
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw Object.assign(new Error(`Free source ${definition.id} requires HTTPS`), {
      code: "FREE_SOURCE_URL_REJECTED",
    });
  }
  const initialOrigin = definition.origins.includes(url.origin);
  const redirectOrigin = options.allowRedirect === true
    && definition.redirectOrigins.includes(url.origin);
  if (!initialOrigin && !redirectOrigin) {
    throw Object.assign(new Error(`Origin ${url.origin} is not allowed for ${definition.id}`), {
      code: "FREE_SOURCE_URL_REJECTED",
    });
  }
  if (initialOrigin && !definition.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    throw Object.assign(new Error(`Path ${url.pathname} is not allowed for ${definition.id}`), {
      code: "FREE_SOURCE_URL_REJECTED",
    });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("Credentials are forbidden in free source URLs"), {
      code: "FREE_SOURCE_URL_REJECTED",
    });
  }
  return url;
}

async function readBoundedBody(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw Object.assign(new Error(`Response exceeds ${maximumBytes} bytes`), {
      code: "FREE_SOURCE_TOO_LARGE",
    });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw Object.assign(new Error(`Response exceeds ${maximumBytes} bytes`), {
        code: "FREE_SOURCE_TOO_LARGE",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

class FreeSourceCache {
  constructor(options = {}) {
    if (!options.rootDir) throw new TypeError("FreeSourceCache requires rootDir");
    this.rootDir = path.resolve(options.rootDir);
    this.clock = options.clock || Date.now;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.allowInsecureLocalhost = options.allowInsecureLocalhost === true;
    this.timeoutMs = clampInteger(options.timeoutMs, 20_000, 500, 120_000);
    this.failureThreshold = clampInteger(options.failureThreshold, 3, 1, 20);
    this.circuitOpenMs = clampInteger(options.circuitOpenMs, 5 * 60_000, 1000, 24 * 60 * 60 * 1000);
    this.sources = new Map();
    this.runtime = new Map();
    for (const definition of options.sources || []) this.register(definition);
  }

  register(input) {
    const definition = sourceDefinition(input);
    if (this.sources.has(definition.id)) {
      throw new RangeError(`Duplicate free source id ${definition.id}`);
    }
    this.sources.set(definition.id, definition);
    this.runtime.set(definition.id, {
      requests: 0,
      networkRequests: 0,
      cacheHits: 0,
      staleFallbacks: 0,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastSuccessAt: null,
      lastError: null,
    });
    return definition;
  }

  definition(sourceId) {
    const definition = this.sources.get(String(sourceId));
    if (!definition) {
      throw Object.assign(new Error(`Unknown free source ${sourceId}`), {
        code: "FREE_SOURCE_UNKNOWN",
      });
    }
    return definition;
  }

  cachePaths(sourceId, url) {
    const key = sha256({ sourceId: String(sourceId), url: String(url) });
    const directory = path.join(this.rootDir, String(sourceId), key.slice(0, 2), key);
    return {
      key,
      directory,
      payload: path.join(directory, "payload.bin"),
      metadata: path.join(directory, "metadata.json"),
    };
  }

  async cachedEntry(sourceId, url) {
    const paths = this.cachePaths(sourceId, url);
    const metadata = await readJson(paths.metadata);
    if (!metadata) return { paths, metadata: null, buffer: null };
    try {
      const buffer = await fs.readFile(paths.payload);
      if (buffer.length !== metadata.bytes || bufferDigest(buffer) !== metadata.digest) {
        throw Object.assign(new Error("Cached payload digest is invalid"), {
          code: "FREE_SOURCE_CACHE_CORRUPT",
        });
      }
      return { paths, metadata, buffer };
    } catch (error) {
      if (error.code === "ENOENT") return { paths, metadata: null, buffer: null };
      throw error;
    }
  }

  circuitState(sourceId, now) {
    const state = this.runtime.get(sourceId);
    const openUntil = state?.circuitOpenUntil ? Date.parse(state.circuitOpenUntil) : 0;
    return {
      state,
      open: Number.isFinite(openUntil) && openUntil > now,
      openUntil,
    };
  }

  cacheResult(definition, cached, options = {}) {
    const ageMs = Math.max(0, Number(this.clock()) - Date.parse(cached.metadata.fetchedAt));
    return {
      source: definition.id,
      buffer: cached.buffer,
      payloadPath: cached.paths.payload,
      metadata: {
        ...cached.metadata,
        ageMs,
        stale: ageMs > definition.maxStaleMs,
        cacheReason: options.reason || "cache",
      },
      fromCache: true,
      stale: ageMs > definition.maxStaleMs,
    };
  }

  async fetchBuffer(sourceId, value, options = {}) {
    const definition = this.definition(sourceId);
    const url = validateSourceUrl(definition, value, {
      allowInsecureLocalhost: this.allowInsecureLocalhost,
    });
    const state = this.runtime.get(definition.id);
    const now = Number(this.clock());
    state.requests += 1;
    const cached = await this.cachedEntry(definition.id, url.href);
    const cachedAgeMs = cached.metadata
      ? Math.max(0, now - Date.parse(cached.metadata.fetchedAt))
      : Number.POSITIVE_INFINITY;
    const maximumAgeMs = clampInteger(
      options.maximumAgeMs,
      definition.minFetchIntervalMs,
      0,
      365 * 24 * 60 * 60 * 1000,
    );
    if (!options.force && cached.buffer && cachedAgeMs <= maximumAgeMs) {
      state.cacheHits += 1;
      return this.cacheResult(definition, cached, { reason: "fresh" });
    }

    const circuit = this.circuitState(definition.id, now);
    if (circuit.open) {
      if (cached.buffer && cachedAgeMs <= definition.maxStaleMs) {
        state.cacheHits += 1;
        state.staleFallbacks += 1;
        return this.cacheResult(definition, cached, { reason: "circuit-open" });
      }
      throw Object.assign(new Error(`Free source ${definition.id} circuit is open`), {
        code: "FREE_SOURCE_CIRCUIT_OPEN",
        retryAt: new Date(circuit.openUntil).toISOString(),
      });
    }

    const headers = {
      accept: options.accept || "*/*",
      "user-agent": options.userAgent || "fantasy-football-oracle-free-intelligence/5.1",
      ...(options.headers || {}),
    };
    if (cached.metadata?.etag) headers["if-none-match"] = cached.metadata.etag;
    if (cached.metadata?.lastModified) headers["if-modified-since"] = cached.metadata.lastModified;

    try {
      state.networkRequests += 1;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(clampInteger(options.timeoutMs, this.timeoutMs, 500, 120_000)),
      });
      validateSourceUrl(definition, response.url || url.href, {
        allowInsecureLocalhost: this.allowInsecureLocalhost,
        allowRedirect: true,
      });
      if (response.status === 304 && cached.buffer) {
        const metadata = {
          ...cached.metadata,
          checkedAt: iso(now),
          responseStatus: 304,
        };
        await atomicJsonWrite(cached.paths.metadata, metadata);
        state.cacheHits += 1;
        state.consecutiveFailures = 0;
        state.circuitOpenUntil = null;
        state.lastSuccessAt = iso(now);
        state.lastError = null;
        return this.cacheResult(definition, { ...cached, metadata }, { reason: "not-modified" });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`Free source ${definition.id} returned HTTP ${response.status}`), {
          code: "FREE_SOURCE_HTTP_ERROR",
          statusCode: response.status,
        });
      }
      const buffer = await readBoundedBody(response, definition.maxBytes);
      const fetchedAt = iso(now);
      const metadata = {
        version: FREE_SOURCE_CACHE_VERSION,
        source: definition.id,
        requestUrl: url.href,
        finalUrl: response.url || url.href,
        fetchedAt,
        checkedAt: fetchedAt,
        responseStatus: response.status,
        contentType: response.headers.get("content-type") || null,
        etag: response.headers.get("etag") || null,
        lastModified: response.headers.get("last-modified") || null,
        bytes: buffer.length,
        digest: bufferDigest(buffer),
      };

      await atomicBufferWrite(cached.paths.payload, buffer);
      await atomicJsonWrite(cached.paths.metadata, metadata);
      state.consecutiveFailures = 0;
      state.circuitOpenUntil = null;
      state.lastSuccessAt = fetchedAt;
      state.lastError = null;
      return {
        source: definition.id,
        buffer,
        payloadPath: cached.paths.payload,
        metadata: { ...metadata, ageMs: 0, stale: false, cacheReason: "network" },
        fromCache: false,
        stale: false,
      };
    } catch (error) {
      state.consecutiveFailures += 1;
      state.lastError = {
        code: error.code || error.name || "FREE_SOURCE_ERROR",
        message: String(error.message || error),
        at: iso(now),
      };
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.circuitOpenUntil = iso(now + this.circuitOpenMs);
      }
      if (cached.buffer && cachedAgeMs <= definition.maxStaleMs) {
        state.cacheHits += 1;
        state.staleFallbacks += 1;
        return this.cacheResult(definition, cached, { reason: "stale-if-error" });
      }
      throw error;
    }
  }

  async fetchJson(sourceId, value, options = {}) {
    const result = await this.fetchBuffer(sourceId, value, {
      accept: "application/json",
      ...options,
    });
    try {
      return {
        ...result,
        data: JSON.parse(result.buffer.toString("utf8")),
      };
    } catch (error) {
      throw Object.assign(new Error(`Free source ${sourceId} returned invalid JSON`), {
        code: "FREE_SOURCE_INVALID_JSON",
        cause: error,
      });
    }
  }

  async fetchText(sourceId, value, options = {}) {
    const result = await this.fetchBuffer(sourceId, value, options);
    return { ...result, text: result.buffer.toString(options.encoding || "utf8") };
  }

  status() {
    return {
      version: FREE_SOURCE_CACHE_VERSION,
      sources: Object.fromEntries([...this.sources.entries()].map(([id, definition]) => {
        const state = this.runtime.get(id);
        return [id, {
          attribution: definition.attribution,
          license: definition.license,
          termsUrl: definition.termsUrl,
          origins: [...definition.origins],
          redirectOrigins: [...definition.redirectOrigins],
          limits: {
            maxBytes: definition.maxBytes,
            minFetchIntervalMs: definition.minFetchIntervalMs,
            maxStaleMs: definition.maxStaleMs,
          },
          requests: state.requests,
          networkRequests: state.networkRequests,
          cacheHits: state.cacheHits,
          staleFallbacks: state.staleFallbacks,
          consecutiveFailures: state.consecutiveFailures,
          circuitOpenUntil: state.circuitOpenUntil,
          lastSuccessAt: state.lastSuccessAt,
          lastError: state.lastError,
        }];
      })),
      digest: sha256(canonicalize([...this.sources.values()].map((definition) => ({
        id: definition.id,
        origins: definition.origins,
        redirectOrigins: definition.redirectOrigins,
        pathPrefixes: definition.pathPrefixes,
        license: definition.license,
        termsUrl: definition.termsUrl,
      })))),
    };
  }
}

module.exports = {
  FREE_SOURCE_CACHE_VERSION,
  FreeSourceCache,
  atomicBufferWrite,
  bufferDigest,
  readBoundedBody,
  sourceDefinition,
  validateSourceUrl,
};
