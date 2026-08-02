"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { canonicalize, sha256 } = require("./lineage.js");
const { atomicWrite } = require("./event-store.js");

const SNAPSHOT_CATALOG_VERSION = "oracle-snapshots-2026.1";

function safeKind(value) {
  const normalized = String(value || "snapshot").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "snapshot";
}

class SnapshotCatalog {
  constructor(options = {}) {
    if (!options.directory) throw new TypeError("SnapshotCatalog requires directory");
    this.directory = path.resolve(options.directory);
    this.indexPath = path.join(this.directory, "index.json");
    this.clock = options.clock || (() => new Date());
    this.index = {
      version: SNAPSHOT_CATALOG_VERSION,
      snapshots: [],
    };
    this.initialized = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.index = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
    }
    if (this.index.version !== SNAPSHOT_CATALOG_VERSION || !Array.isArray(this.index.snapshots)) {
      const error = new Error("Snapshot catalog index is invalid");
      error.code = "SNAPSHOT_CATALOG_CORRUPT";
      throw error;
    }
    this.initialized = true;
    return this.status();
  }

  ensureInitialized() {
    if (!this.initialized) {
      const error = new Error("SnapshotCatalog is not initialized");
      error.code = "SNAPSHOT_CATALOG_NOT_READY";
      throw error;
    }
  }

  write(kind, payload, metadata = {}) {
    this.ensureInitialized();
    const operation = this.queue.then(async () => {
      const normalizedKind = safeKind(kind);
      const canonicalPayload = canonicalize(payload);
      const digest = sha256({ kind: normalizedKind, payload: canonicalPayload });
      const fileName = `${normalizedKind}-${digest}.json`;
      const filePath = path.join(this.directory, fileName);
      const createdAt = new Date(metadata.createdAt || this.clock()).toISOString();
      const document = {
        version: SNAPSHOT_CATALOG_VERSION,
        kind: normalizedKind,
        digest,
        createdAt,
        metadata: canonicalize(metadata.details || {}),
        payload: canonicalPayload,
      };
      try {
        await fs.access(filePath);
      } catch {
        await atomicWrite(filePath, `${JSON.stringify(document, null, 2)}\n`);
      }
      if (!this.index.snapshots.some((row) => row.digest === digest)) {
        this.index.snapshots.push({
          kind: normalizedKind,
          digest,
          fileName,
          createdAt,
          bytes: Buffer.byteLength(JSON.stringify(document)),
        });
        this.index.snapshots.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
      }
      return document;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async read(digest) {
    this.ensureInitialized();
    const row = this.index.snapshots.find((entry) => entry.digest === String(digest));
    if (!row) return null;
    const document = JSON.parse(await fs.readFile(path.join(this.directory, row.fileName), "utf8"));
    const actual = sha256({ kind: document.kind, payload: document.payload });
    if (actual !== document.digest || actual !== row.digest) {
      const error = new Error(`Snapshot checksum mismatch: ${row.fileName}`);
      error.code = "SNAPSHOT_CORRUPT";
      throw error;
    }
    return document;
  }

  list(options = {}) {
    this.ensureInitialized();
    const kind = options.kind ? safeKind(options.kind) : null;
    const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
    return this.index.snapshots
      .filter((row) => !kind || row.kind === kind)
      .slice(-limit)
      .reverse()
      .map((row) => ({ ...row }));
  }

  async verify() {
    this.ensureInitialized();
    const errors = [];
    let checked = 0;
    for (const row of this.index.snapshots) {
      try {
        await this.read(row.digest);
        checked += 1;
      } catch (error) {
        errors.push(error.message);
      }
    }
    return { valid: errors.length === 0, checked, errors };
  }

  async prune(options = {}) {
    this.ensureInitialized();
    const kind = options.kind ? safeKind(options.kind) : null;
    const keep = Math.max(0, Number(options.keep ?? 100));
    const candidates = this.index.snapshots
      .filter((row) => !kind || row.kind === kind)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const remove = new Set(candidates.slice(keep).map((row) => row.digest));
    if (!remove.size) return { removed: 0, remaining: this.index.snapshots.length };
    const deletedFiles = [];
    this.index.snapshots = this.index.snapshots.filter((row) => {
      if (!remove.has(row.digest)) return true;
      deletedFiles.push(row.fileName);
      return false;
    });
    const stillReferenced = new Set(this.index.snapshots.map((row) => row.fileName));
    for (const fileName of deletedFiles) {
      if (!stillReferenced.has(fileName)) {
        await fs.rm(path.join(this.directory, fileName), { force: true });
      }
    }
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`);
    return { removed: remove.size, remaining: this.index.snapshots.length };
  }

  status() {
    return {
      version: SNAPSHOT_CATALOG_VERSION,
      initialized: this.initialized,
      directory: this.directory,
      snapshots: this.index.snapshots.length,
      newestAt: this.index.snapshots.at(-1)?.createdAt || null,
      newestDigest: this.index.snapshots.at(-1)?.digest || null,
    };
  }
}

module.exports = {
  SNAPSHOT_CATALOG_VERSION,
  SnapshotCatalog,
  safeKind,
};
