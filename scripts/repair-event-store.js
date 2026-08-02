"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const config = require("../server/config.js");
const {
  EVENT_STORE_VERSION,
  GENESIS_HASH,
  eventHash,
  verifyEventChain,
} = require("../server/event-store.js");

function parseArguments(argv) {
  const options = {
    filePath: path.join(config.platformRuntimeDir, "platform-events.jsonl"),
    dryRun: false,
    allowEmpty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--file") options.filePath = path.resolve(argv[++index]);
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--allow-empty") options.allowEmpty = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}
function recoverBestEventChain(text) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((row) => row.line.trim());
  const parsed = [];
  const rejected = [];
  for (const row of rows) {
    let event;
    try {
      event = JSON.parse(row.line);
    } catch (error) {
      rejected.push({ lineNumber: row.lineNumber, reason: `invalid JSON: ${error.message}` });
      continue;
    }
    if (event.version !== EVENT_STORE_VERSION) {
      rejected.push({ lineNumber: row.lineNumber, reason: "version mismatch" });
      continue;
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      rejected.push({ lineNumber: row.lineNumber, reason: "invalid sequence" });
      continue;
    }
    if (eventHash(event) !== event.hash) {
      rejected.push({ lineNumber: row.lineNumber, reason: "hash mismatch" });
      continue;
    }
    parsed.push({ event, lineNumber: row.lineNumber });
  }
  const byHash = new Map();
  for (const row of parsed) {
    if (!byHash.has(row.event.hash)) byHash.set(row.event.hash, row);
  }
  const memo = new Map();
  const resolving = new Set();
  function resolve(row) {
    if (memo.has(row.event.hash)) return memo.get(row.event.hash);
    if (resolving.has(row.event.hash)) return null;
    resolving.add(row.event.hash);
    let state = null;
    if (row.event.sequence === 1 && row.event.previousHash === GENESIS_HASH) {
      state = { row, previous: null, length: 1 };
    } else {
      const previousRow = byHash.get(row.event.previousHash);
      const previous = previousRow ? resolve(previousRow) : null;
      if (previous && previous.row.event.sequence === row.event.sequence - 1) {
        state = { row, previous, length: previous.length + 1 };
      }
    }
    resolving.delete(row.event.hash);
    memo.set(row.event.hash, state);
    return state;
  }

  let best = null;
  for (const row of parsed) {
    const state = resolve(row);
    if (!state) continue;
    if (!best || state.length > best.length
      || (state.length === best.length && row.lineNumber > best.row.lineNumber)) {
      best = state;
    }
  }
  const chainRows = [];
  for (let cursor = best; cursor; cursor = cursor.previous) chainRows.push(cursor.row);
  chainRows.reverse();
  const selectedLines = new Set(chainRows.map((row) => row.lineNumber));
  for (const row of parsed) {
    if (!selectedLines.has(row.lineNumber)) {
      rejected.push({ lineNumber: row.lineNumber, reason: "not selected branch" });
    }
  }
  rejected.sort((left, right) => left.lineNumber - right.lineNumber);
  const chain = chainRows.map((row) => row.event);
  const verification = verifyEventChain(chain);
  return {
    totalLines: rows.length,
    recoveredEvents: chain.length,
    discardedEvents: rejected.length,
    discarded: rejected,
    chain,
    verification,
    alreadyValid: rejected.length === 0
      && chain.length === rows.length
      && verification.valid,
  };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function repairEventStore(options = {}) {
  const filePath = path.resolve(options.filePath);
  const lockPath = `${filePath}.lock`;
  if (await fileExists(lockPath)) {
    const error = new Error("Event store is locked by a running or unverified Oracle instance.");
    error.code = "EVENT_STORE_LOCKED";
    throw error;
  }
  const text = await fs.readFile(filePath, "utf8");
  const recovery = recoverBestEventChain(text);
  if (!recovery.verification.valid) {
    const error = new Error("No cryptographically valid event chain could be reconstructed.");
    error.code = "EVENT_CHAIN_UNRECOVERABLE";
    throw error;
  }
  if (recovery.recoveredEvents === 0 && recovery.totalLines > 0 && !options.allowEmpty) {
    const error = new Error("Repair would produce an empty ledger; pass --allow-empty only after review.");
    error.code = "EVENT_CHAIN_EMPTY_REPAIR";
    throw error;
  }
  const report = {
    filePath,
    dryRun: Boolean(options.dryRun),
    changed: !recovery.alreadyValid,
    totalLines: recovery.totalLines,
    recoveredEvents: recovery.recoveredEvents,
    discardedEvents: recovery.discardedEvents,
    headHash: recovery.verification.headHash,
    discarded: recovery.discarded,
  };
  if (recovery.alreadyValid || options.dryRun) return report;
  const stamp = safeTimestamp();
  const quarantinePath = `${filePath}.corrupt-${stamp}`;
  const reportPath = `${filePath}.repair-${stamp}.json`;
  const temporaryPath = `${filePath}.${process.pid}.repaired.tmp`;
  const content = recovery.chain.length
    ? `${recovery.chain.map((event) => JSON.stringify(event)).join("\n")}\n`
    : "";
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(filePath, quarantinePath);
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rename(quarantinePath, filePath).catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  const completed = {
    ...report,
    repairedAt: new Date().toISOString(),
    quarantinePath,
    reportPath,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
  return completed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await repairEventStore(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  recoverBestEventChain,
  repairEventStore,
};
