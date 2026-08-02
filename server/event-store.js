"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { canonicalize, sha256 } = require("./lineage.js");

const EVENT_STORE_VERSION = "oracle-event-store-2026.1";
const GENESIS_HASH = "0".repeat(64);

function eventHash(event) {
  const { hash, ...base } = event;
  return sha256(base);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function verifyEventChain(events) {
  const errors = [];
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;
  for (const event of events) {
    if (event.version !== EVENT_STORE_VERSION) errors.push(`event ${expectedSequence}: version mismatch`);
    if (event.sequence !== expectedSequence) errors.push(`event ${expectedSequence}: sequence mismatch`);
    if (event.previousHash !== previousHash) errors.push(`event ${expectedSequence}: previous hash mismatch`);
    if (eventHash(event) !== event.hash) errors.push(`event ${expectedSequence}: hash mismatch`);
    previousHash = event.hash;
    expectedSequence += 1;
  }
  return {
    valid: errors.length === 0,
    errors,
    count: events.length,
    headHash: events.at(-1)?.hash || GENESIS_HASH,
  };
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filePath);
}
class EventStore {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError("EventStore requires filePath");
    this.filePath = path.resolve(options.filePath);
    this.lockPath = path.resolve(options.lockPath || `${this.filePath}.lock`);
    this.clock = options.clock || (() => new Date());
    this.events = [];
    this.initialized = false;
    this.queue = Promise.resolve();
    this.lastVerification = null;
    this.lockOwned = false;
    this.lockToken = null;
  }

  async acquireLock() {
    if (this.lockOwned) return;
    const owner = {
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.lockOwned = true;
        this.lockToken = owner.token;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let existing = null;
        try {
          existing = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
        } catch {}
        const staleLocalLock = existing?.hostname === os.hostname()
          && Number.isInteger(existing?.pid)
          && !processIsAlive(existing.pid);
        if (staleLocalLock && attempt === 0) {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        const lockError = new Error(
          `Event store is already in use${existing?.pid ? ` by PID ${existing.pid}` : ""}. `
          + "Stop the other Oracle instance or remove a verified stale lock.",
        );
        lockError.code = "EVENT_STORE_LOCKED";
        lockError.owner = existing;
        throw lockError;
      }
    }
  }

  async releaseLock() {
    if (!this.lockOwned) return;
    try {
      const existing = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
      if (existing.token === this.lockToken) await fs.rm(this.lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      this.lockOwned = false;
      this.lockToken = null;
    }
  }
  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.acquireLock();
    try {
      try {
        const text = await fs.readFile(this.filePath, "utf8");
        this.events = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
          try {
            return JSON.parse(line);
          } catch (error) {
            error.message = `Invalid event JSON on line ${index + 1}: ${error.message}`;
            throw error;
          }
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await atomicWrite(this.filePath, "");
        this.events = [];
      }
      this.lastVerification = verifyEventChain(this.events);
      if (!this.lastVerification.valid) {
        const error = new Error(
          `Event chain is corrupt: ${this.lastVerification.errors.join("; ")}. `
          + "Run npm run events:repair -- --dry-run before repairing it.",
        );
        error.code = "EVENT_CHAIN_CORRUPT";
        throw error;
      }
      this.initialized = true;
      return this.status();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }

  ensureInitialized() {
    if (!this.initialized) {
      const error = new Error("EventStore is not initialized");
      error.code = "EVENT_STORE_NOT_READY";
      throw error;
    }
  }
  append(type, payload, metadata = {}) {
    this.ensureInitialized();
    const operation = this.queue.then(async () => {
      const previous = this.events.at(-1);
      const base = {
        version: EVENT_STORE_VERSION,
        sequence: this.events.length + 1,
        id: String(metadata.id || `${type}:${this.events.length + 1}`),
        type: String(type),
        occurredAt: new Date(metadata.occurredAt || this.clock()).toISOString(),
        recordedAt: new Date(this.clock()).toISOString(),
        source: String(metadata.source || "oracle"),
        previousHash: previous?.hash || GENESIS_HASH,
        payload: canonicalize(payload ?? null),
        metadata: canonicalize(metadata.details || {}),
      };
      const event = { ...base, hash: sha256(base) };
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.events.push(event);
      this.lastVerification = verifyEventChain(this.events);
      return event;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  list(options = {}) {
    this.ensureInitialized();
    const afterSequence = Math.max(0, Number(options.afterSequence || 0));
    const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
    const type = options.type ? String(options.type) : null;
    return this.events
      .filter((event) => event.sequence > afterSequence && (!type || event.type === type))
      .slice(-limit)
      .map((event) => ({ ...event }));
  }
  getById(id) {
    this.ensureInitialized();
    const event = this.events.find((row) => row.id === String(id));
    return event ? { ...event } : null;
  }

  verify() {
    this.ensureInitialized();
    this.lastVerification = verifyEventChain(this.events);
    return { ...this.lastVerification };
  }

  async rewriteVerifiedCopy(targetPath) {
    this.ensureInitialized();
    const verification = this.verify();
    if (!verification.valid) {
      const error = new Error("Cannot export a corrupt event chain");
      error.code = "EVENT_CHAIN_CORRUPT";
      throw error;
    }
    const content = this.events.length
      ? `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
    await atomicWrite(path.resolve(targetPath), content);
    return { path: path.resolve(targetPath), ...verification };
  }

  async close() {
    await this.queue;
    this.initialized = false;
    await this.releaseLock();
  }

  status() {
    return {
      version: EVENT_STORE_VERSION,
      initialized: this.initialized,
      filePath: this.filePath,
      events: this.events.length,
      headHash: this.events.at(-1)?.hash || GENESIS_HASH,
      valid: this.lastVerification?.valid ?? null,
      errors: this.lastVerification?.errors || [],
      exclusiveLock: this.lockOwned,
    };
  }
}
module.exports = {
  EVENT_STORE_VERSION,
  GENESIS_HASH,
  EventStore,
  eventHash,
  verifyEventChain,
  atomicWrite,
  processIsAlive,
};
