#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.root = argv[++index];
    else if (value === "--daily") options.daily = Number(argv[++index]);
    else if (value === "--weekly") options.weekly = Number(argv[++index]);
    else if (value === "--monthly") options.monthly = Number(argv[++index]);
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function isoWeekKey(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function backupRows(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!/^oracle-\d{8}T\d{6}Z-[a-f0-9]{12}(?:\.tar\.gz\.enc)?$/i.test(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    const stat = await fs.stat(fullPath);
    rows.push({
      name: entry.name,
      path: fullPath,
      directory: entry.isDirectory(),
      modifiedAt: stat.mtime,
      bytes: stat.size,
    });
  }
  return rows.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function selectRetention(rows, options = {}) {
  const daily = Math.max(1, Number(options.daily || 14));
  const weekly = Math.max(0, Number(options.weekly || 8));
  const monthly = Math.max(0, Number(options.monthly || 12));
  const keep = new Set();
  rows.slice(0, daily).forEach((row) => keep.add(row.path));

  const weeklySeen = new Set();
  for (const row of rows) {
    const key = isoWeekKey(row.modifiedAt);
    if (weeklySeen.has(key)) continue;
    weeklySeen.add(key);
    if (weeklySeen.size <= weekly) keep.add(row.path);
  }

  const monthlySeen = new Set();
  for (const row of rows) {
    const key = monthKey(row.modifiedAt);
    if (monthlySeen.has(key)) continue;
    monthlySeen.add(key);
    if (monthlySeen.size <= monthly) keep.add(row.path);
  }

  return {
    keep: rows.filter((row) => keep.has(row.path)),
    remove: rows.filter((row) => !keep.has(row.path)),
    policy: { daily, weekly, monthly },
  };
}

async function pruneBackups(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, "..", "..", "oracle-recovery"));
  await fs.mkdir(root, { recursive: true });
  const rows = await backupRows(root);
  const selection = selectRetention(rows, options);
  const removed = [];
  for (const row of selection.remove) {
    if (!options.dryRun) await fs.rm(row.path, { recursive: true, force: true });
    removed.push({ name: row.name, modifiedAt: row.modifiedAt.toISOString() });
  }
  return {
    root,
    dryRun: Boolean(options.dryRun),
    policy: selection.policy,
    total: rows.length,
    kept: selection.keep.length,
    removed,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/prune-backups.js [--root DIR] [--daily 14] [--weekly 8] [--monthly 12] [--dry-run]");
    return;
  }
  console.log(JSON.stringify(await pruneBackups(options), null, 2));
}

module.exports = { pruneBackups, selectRetention, backupRows, isoWeekKey, monthKey };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
