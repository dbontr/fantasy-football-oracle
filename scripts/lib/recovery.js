"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RECOVERY_FORMAT_VERSION = "oracle-recovery-2026.1";
const ENCRYPTION_MAGIC = Buffer.from("ORACLEBK1", "ascii");

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: options.encoding === null ? null : "utf8",
    stdio: options.stdio || "pipe",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout
      || `process exited with status ${result.status}${result.signal ? ` (${result.signal})` : ""}`;
    const error = new Error(
      `${command} ${args.join(" ")} failed: ${String(detail).trim()}`,
    );
    error.code = "RECOVERY_COMMAND_FAILED";
    error.status = result.status;
    error.signal = result.signal || null;
    error.cause = result.error;
    throw error;
  }
  return result;
}

function commandExists(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function checksumEntries(directory, relativePaths) {
  const entries = [];
  for (const relative of [...new Set(relativePaths.map(normalizePath))].sort()) {
    const absolute = path.resolve(directory, relative);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size <= 0) {
      const error = new Error(`Recovery artifact is empty or not a file: ${relative}`);
      error.code = "RECOVERY_ARTIFACT_INVALID";
      throw error;
    }
    entries.push({
      path: relative,
      bytes: stat.size,
      sha256: await sha256File(absolute),
    });
  }
  return entries;
}

async function writeChecksums(directory, entries, fileName = "CHECKSUMS.sha256") {
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.path}`);
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function verifyChecksumEntries(directory, entries) {
  const results = [];
  for (const expected of entries || []) {
    try {
      const absolute = path.resolve(directory, expected.path);
      const stat = await fs.stat(absolute);
      const actualHash = await sha256File(absolute);
      const valid = stat.isFile() && stat.size === expected.bytes && actualHash === expected.sha256;
      results.push({ ...expected, actualBytes: stat.size, actualSha256: actualHash, valid });
    } catch (error) {
      results.push({ ...expected, actualBytes: null, actualSha256: null, valid: false, error: error.message });
    }
  }
  return {
    valid: results.length > 0 && results.every((row) => row.valid),
    results,
  };
}

async function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function encryptFile(inputPath, outputPath, passphrase) {
  if (!passphrase) throw new Error("A backup passphrase is required for encryption");
  const { pipeline } = require("node:stream/promises");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const header = Buffer.concat([ENCRYPTION_MAGIC, salt, iv]);
  await fs.writeFile(outputPath, header);
  await pipeline(
    fsSync.createReadStream(inputPath),
    cipher,
    fsSync.createWriteStream(outputPath, { flags: "a" }),
  );
  await fs.appendFile(outputPath, cipher.getAuthTag());
  return {
    algorithm: "aes-256-gcm",
    kdf: "scrypt-N32768-r8-p1",
    inputBytes: (await fs.stat(inputPath)).size,
    outputBytes: (await fs.stat(outputPath)).size,
  };
}

async function decryptFile(inputPath, outputPath, passphrase) {
  if (!passphrase) throw new Error("A backup passphrase is required for decryption");
  const { pipeline } = require("node:stream/promises");
  const handle = await fs.open(inputPath, "r");
  const headerLength = ENCRYPTION_MAGIC.length + 16 + 12;
  const header = Buffer.alloc(headerLength);
  const tag = Buffer.alloc(16);
  try {
    const stat = await handle.stat();
    if (stat.size <= headerLength + tag.length) throw new Error("Encrypted backup is truncated");
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, stat.size - tag.length);
    if (!header.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
      throw new Error("Encrypted backup magic is invalid");
    }
    const salt = header.subarray(ENCRYPTION_MAGIC.length, ENCRYPTION_MAGIC.length + 16);
    const iv = header.subarray(ENCRYPTION_MAGIC.length + 16);
    const key = await deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    await pipeline(
      fsSync.createReadStream(inputPath, { start: headerLength, end: stat.size - tag.length - 1 }),
      decipher,
      fsSync.createWriteStream(outputPath),
    );
  } finally {
    await handle.close();
  }
  return { outputBytes: (await fs.stat(outputPath)).size };
}

function createTarGzip(rootDir, outputPath, relativePaths) {
  if (!commandExists("tar")) {
    const error = new Error("The tar command is required to create recovery archives");
    error.code = "TAR_UNAVAILABLE";
    throw error;
  }
  const rows = [...new Set(relativePaths.map(normalizePath))].filter(Boolean);
  if (!rows.length) {
    const emptyDir = path.join(path.dirname(outputPath), `.empty-${process.pid}`);
    fsSync.mkdirSync(emptyDir, { recursive: true });
    run("tar", ["-czf", outputPath, "-C", emptyDir, "."]);
    fsSync.rmSync(emptyDir, { recursive: true, force: true });
    return;
  }
  run("tar", ["-czf", outputPath, "-C", rootDir, ...rows]);
}

function extractTarGzip(archivePath, destination) {
  if (!commandExists("tar")) throw new Error("The tar command is required to restore archives");
  fsSync.mkdirSync(destination, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", destination]);
}

function listTarGzip(archivePath) {
  if (!commandExists("tar")) throw new Error("The tar command is required to inspect archives");
  const result = run("tar", ["-tzf", archivePath]);
  return String(result.stdout || "").split(/\r?\n/).filter(Boolean);
}

async function copyPackage(sourceDirectory, targetRoot) {
  const target = path.resolve(targetRoot, path.basename(sourceDirectory));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(sourceDirectory, target, { recursive: true, force: false, errorOnExist: true });
  return target;
}

async function makeReadOnly(directory) {
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else await fs.chmod(full, 0o444).catch(() => {});
    }
  }
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

module.exports = {
  RECOVERY_FORMAT_VERSION,
  ENCRYPTION_MAGIC,
  normalizePath,
  run,
  commandExists,
  sha256File,
  checksumEntries,
  writeChecksums,
  verifyChecksumEntries,
  encryptFile,
  decryptFile,
  createTarGzip,
  extractTarGzip,
  listTarGzip,
  copyPackage,
  makeReadOnly,
  timestampId,
};
